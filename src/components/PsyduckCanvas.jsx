// src/components/PsyduckCanvas.jsx
import { useEffect, useRef, useState } from "react";
import { BASE, getSlots, getStats, getMasks } from "../lib/api";

/* ----------------------------- small helpers ------------------------------ */

// Fetch → ImageBitmap (CORS safe)
async function loadBitmap(url) {
  const abs = url.startsWith("http") ? url : `${BASE}${url}`;
  const res = await fetch(abs, { mode: "cors" });
  if (!res.ok) throw new Error(`Failed to fetch ${abs}: ${res.status}`);
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

// White-on-black bitmap → alpha mask canvas (white => opaque)
function bitmapToAlphaMaskCanvas(bitmap, outW, outH, dpr = 1, threshold = 0) {
  const cw = Math.round(outW * dpr);
  const ch = Math.round(outH * dpr);
  const src = document.createElement("canvas");
  src.width = cw;
  src.height = ch;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(bitmap, 0, 0, cw, ch);

  const img = sctx.getImageData(0, 0, cw, ch);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
    const a = lum <= threshold ? 0 : lum; // black → 0 alpha, white → 255
    d[i] = 0;
    d[i + 1] = 0;
    d[i + 2] = 0;
    d[i + 3] = a;
  }
  sctx.putImageData(img, 0, 0);
  return src;
}

// Slightly “expand” an alpha mask by drawing it with small offsets (cheap dilation)
function dilateAlphaMask1x(maskCanvas, radius = 1) {
  if (!maskCanvas || radius <= 0) return maskCanvas;
  const out = document.createElement("canvas");
  out.width = maskCanvas.width;
  out.height = maskCanvas.height;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = true;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      octx.drawImage(maskCanvas, dx, dy);
    }
  }
  return out;
}

// Fill a solid color inside an alpha mask (1×)
function drawMaskFill1x(ctx, alphaMaskCanvas, rgb = [0, 0, 0], alpha = 1) {
  if (!alphaMaskCanvas || alpha <= 0) return;
  const [r, g, b] = rgb;
  const off = document.createElement("canvas");
  off.width = alphaMaskCanvas.width;
  off.height = alphaMaskCanvas.height;
  const octx = off.getContext("2d");
  octx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
  octx.fillRect(0, 0, off.width, off.height);
  octx.globalCompositeOperation = "destination-in";
  octx.drawImage(alphaMaskCanvas, 0, 0);
  ctx.drawImage(off, 0, 0);
}

/* --------------------- SABER-style fractal energy (outline) ---------------- */

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Deterministic hash → [0,1]
function hash2i(x, y, seed = 1337) {
  let n = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 4294967295;
}

// Value noise (bilinear) → [0,1]
function valueNoise2D(x, y, seed = 1337) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const u = smoothstep(xf);
  const v = smoothstep(yf);

  const a = hash2i(xi, yi, seed);
  const b = hash2i(xi + 1, yi, seed);
  const c = hash2i(xi, yi + 1, seed);
  const d = hash2i(xi + 1, yi + 1, seed);

  const ab = lerp(a, b, u);
  const cd = lerp(c, d, u);
  return lerp(ab, cd, v);
}

// Fractal Brownian Motion (fbm) → [0,1]
function fbm2D(x, y, octaves = 4, seed = 1337) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

function ensureNoiseState(ref, res) {
  const cur = ref.current;
  if (cur && cur.res === res && cur.canvas && cur.ctx && cur.img && cur.data) return cur;

  const canvas = document.createElement("canvas");
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.createImageData(res, res);
  const data = img.data;

  const next = { canvas, ctx, img, data, res };
  ref.current = next;
  return next;
}

function ensureEnergyCanvas(ref, w, h) {
  const cur = ref.current;
  if (cur && cur.canvas && cur.ctx && cur.img && cur.data && cur.w === w && cur.h === h) return cur;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.createImageData(w, h);
  const data = img.data;

  const next = { canvas, ctx, img, data, w, h };
  ref.current = next;
  return next;
}

function sampleOutlineAlphaNearest(outData, outW, outH, x, y) {
  const xi = x < 0 ? 0 : x > outW - 1 ? outW - 1 : x | 0;
  const yi = y < 0 ? 0 : y > outH - 1 ? outH - 1 : y | 0;
  return outData[(yi * outW + xi) * 4 + 3];
}

// Bilinear sample our noise field (stored in RGBA):
// R,G = displacement in [-1,1], B = spark, A = filament intensity
function sampleSaberField(noiseData, res, u, v) {
  const x = u * (res - 1);
  const y = v * (res - 1);

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(res - 1, x0 + 1);
  const y1 = Math.min(res - 1, y0 + 1);

  const tx = x - x0;
  const ty = y - y0;

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  const i00 = (y0 * res + x0) * 4;
  const i10 = (y0 * res + x1) * 4;
  const i01 = (y1 * res + x0) * 4;
  const i11 = (y1 * res + x1) * 4;

  const r =
    (noiseData[i00] * w00 +
      noiseData[i10] * w10 +
      noiseData[i01] * w01 +
      noiseData[i11] * w11) /
    255;

  const g =
    (noiseData[i00 + 1] * w00 +
      noiseData[i10 + 1] * w10 +
      noiseData[i01 + 1] * w01 +
      noiseData[i11 + 1] * w11) /
    255;

  const b =
    (noiseData[i00 + 2] * w00 +
      noiseData[i10 + 2] * w10 +
      noiseData[i01 + 2] * w01 +
      noiseData[i11 + 2] * w11) /
    255;

  const a =
    (noiseData[i00 + 3] * w00 +
      noiseData[i10 + 3] * w10 +
      noiseData[i01 + 3] * w01 +
      noiseData[i11 + 3] * w11) /
    255;

  return {
    dx: r * 2 - 1,
    dy: g * 2 - 1,
    spark: b,
    fil: a,
  };
}

// Build a moving “turbulence field” (Saber-ish):
// R,G = displacement vector, A = filament intensity, B = sparks
function renderSaberFields(noiseState, tSec, opts = {}) {
  const { res, ctx, img, data } = noiseState;

  const seed = opts.seed ?? 7331;

  const dispScale = opts.dispScale ?? 2.15; // low freq warp
  const filScale = opts.filScale ?? 7.6; // high freq strands
  const octDisp = opts.octDisp ?? 3;
  const octFil = opts.octFil ?? 4;

  const flowX = tSec * (opts.flowX ?? 0.28);
  const flowY = tSec * (opts.flowY ?? 0.22);

  // a tiny global flicker to keep it alive (slower)
  const flick = 0.9 + 0.1 * Math.sin(tSec * 3.2);

  let p = 0;
  for (let y = 0; y < res; y++) {
    const v = y / res;
    for (let x = 0; x < res; x++) {
      const u = x / res;

      // Displacement vector (two related fbms)
      const nx = fbm2D(u * dispScale + flowX, v * dispScale + flowY, octDisp, seed);
      const ny = fbm2D(
        u * dispScale + 37 + flowX * 0.92,
        v * dispScale + 91 + flowY * 1.08,
        octDisp,
        seed + 19
      );

      let dx = (nx - 0.5) * 2; // [-1,1]
      let dy = (ny - 0.5) * 2;

      // --- add a "curl" so the flow arches like saber energy ---
      const ang = (nx + ny - 1) * 1.65; // [-~1.65, ~1.65]
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const cdx = dx * ca - dy * sa;
      const cdy = dx * sa + dy * ca;
      dx = cdx * 1.15;
      dy = cdy * 1.15;

      // Filaments (ridged-ish)
      const n = fbm2D(
        u * filScale + flowX * 2.1,
        v * filScale - flowY * 2.4,
        octFil,
        seed + 77
      );
      const ridged = 1 - Math.abs(2 * n - 1);
      let fil = Math.pow(ridged, 3.25);

      // Sparks band
      const spark = Math.pow(clamp01((n - 0.62) * 3.4), 2.1);

      fil = clamp01((fil * 0.85 + spark * 0.55) * flick);

      // Pack into RGBA
      data[p++] = ((dx * 0.5 + 0.5) * 255) | 0;
      data[p++] = ((dy * 0.5 + 0.5) * 255) | 0;
      data[p++] = (spark * 255) | 0;
      data[p++] = (fil * 255) | 0;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// Turn outline alpha + turbulence field into a SABER energy mask (white core)
// NOTE: energy canvas may be smaller than outline; we scale sample coords.
function renderSaberEnergyMask(energyState, outlineObj, noiseState, tSec, opts = {}) {
  const { w, h, ctx, img, data } = energyState;

  const outData = outlineObj.data;
  const outW = outlineObj.w;
  const outH = outlineObj.h;

  const nData = noiseState.data;
  const nRes = noiseState.res;

  const amp = opts.amp ?? 3.6; // displacement strength in px (energy-space)
  const gain = opts.gain ?? 1.15; // overall intensity
  const cut = opts.cut ?? 0.16; // threshold to keep it “stringy”
  const sharpPow = opts.sharpPow ?? 1.9;

  // extra “electric crawl” along the stroke
  const crawl = 0.45 + 0.35 * Math.sin(tSec * 2.8);

  const invW = 1 / Math.max(1, w - 1);
  const invH = 1 / Math.max(1, h - 1);

  let p = 0;
  for (let y = 0; y < h; y++) {
    const v = y * invH;

    // mild directional wave so it feels like energy is running
    const wave = Math.sin((v * 14 + tSec * 3.0) * 1.0) * 0.55;

    for (let x = 0; x < w; x++) {
      const u = x * invW;

      const field = sampleSaberField(nData, nRes, u, v);

      // Displace the sampling point (this is the big “Saber” difference)
      const sx = x + field.dx * amp + wave;
      const sy = y + field.dy * amp;

      // Map energy-space coords to outline-space coords
      const ox = sx * (outW / w);
      const oy = sy * (outH / h);

      const oa = sampleOutlineAlphaNearest(outData, outW, outH, ox, oy);
      if (oa === 0) {
        data[p++] = 0;
        data[p++] = 0;
        data[p++] = 0;
        data[p++] = 0;
        continue;
      }

      const base = oa / 255;

      // Make strands sharp + “fractal”
      let strand = field.fil;
      strand = clamp01((strand - cut) * 1.35);
      strand = Math.pow(strand, sharpPow);

      const spark = Math.pow(field.spark, 1.25);

      // micro flicker (per-pixel, deterministic)
      const hf = 0.82 + 0.18 * Math.sin(tSec * 13.0 + (x + y) * 0.015 + crawl);

      const intensity = clamp01(strand * 0.95 + spark * 0.8);
      const a = clamp01(base * (0.14 + intensity) * gain * hf);

      // White core mask
      data[p++] = 255;
      data[p++] = 255;
      data[p++] = 255;
      data[p++] = (a * 255) | 0;
    }
  }

  ctx.putImageData(img, 0, 0);
}

/* ------------------------- search/highlight helpers ------------------------ */

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function stripEllipsis(s) {
  const t = String(s || "");
  return t.endsWith("…") ? t.slice(0, -1) : t;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ------------------------------ fast cache -------------------------------- */

const CACHE_KEY = "psyduck:lastPlan:v3";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
function readCachedPlan() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.cachedAt) return null;
    if (Date.now() - data.cachedAt > CACHE_TTL_MS) return null;
    return data.plan || null;
  } catch {
    return null;
  }
}
function writeCachedPlan(plan) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ cachedAt: Date.now(), plan }));
  } catch {}
}

/* -------------------------------- component -------------------------------- */

export default function PsyduckCanvas() {
  // CAP (progress bar target)
  const CAP = Number(import.meta.env.VITE_PSYDUCK_MAX_TILES || 3500);

  // NEW: YouTube channel link
  const YT_URL = "https://www.youtube.com/@Komala8";

  const [plan, setPlan] = useState(null); // current plan (preview or full)
  const [isPreview, setIsPreview] = useState(false);
  const [total, setTotal] = useState(0);

  const [maskBitmaps, setMaskBitmaps] = useState({
    silhouette: null,
    eyes: null,
    pupils: null,
    nostrils: null,
    hair: null,
    headband: null,
    beak: null,
    feet: null,
    outline: null,
  });

  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  // “Uber x Apple” animation states
  const [hasPainted, setHasPainted] = useState(false);
  const [hasFinal, setHasFinal] = useState(false);
  const didPaintRef = useRef(false);

  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const frameRef = useRef(null); // stable sizing frame
  const containerRef = useRef(null);

  const headerRef = useRef(null);
  const [portalW, setPortalW] = useState(null);

  // Search + highlight
  const [searchQuery, setSearchQuery] = useState("");
  const [hits, setHits] = useState([]);
  const [hitIndex, setHitIndex] = useState(0);
  const rafHighlightRef = useRef(0);

  // offscreen precomposed buffers (1× at plan width/height)
  const previewBufferRef = useRef(null); // IMPORTANT: holds *composited* preview
  const finalBufferRef = useRef(null);

  // rAF handles
  const rafPreviewRef = useRef(0);
  const rafFadeRef = useRef(0);

  const portalWRef = useRef(null);
  const lastViewportRef = useRef({
    dpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    planW: null,
    planH: null,
  });

  useEffect(() => {
    portalWRef.current = portalW;
  }, [portalW]);

  // ENERGY EFFECT refs (3.5k threshold)
  const rafEnergyRef = useRef(0);
  const energyNoiseRef = useRef(null);
  const energyCanvasRef = useRef(null);
  const energyOutlineMaskRef = useRef(null);

  useEffect(() => {
    const calc = () => {
      const dpr = window.devicePixelRatio || 1;

      const aw = Math.max(1, plan?.width || 512);
      const ah = Math.max(1, plan?.height || 512);

      const prev = lastViewportRef.current;
      const planChanged = prev.planW !== aw || prev.planH !== ah;

      // Ignore zoom-driven resizes (Chrome/Edge change devicePixelRatio on zoom)
      if (portalWRef.current != null && !planChanged && dpr !== prev.dpr) {
        prev.dpr = dpr;
        return;
      }

      prev.dpr = dpr;
      prev.planW = aw;
      prev.planH = ah;

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const headerH = headerRef.current?.getBoundingClientRect().height ?? 0;
      const aspect = aw / ah;

      const maxW = Math.min(vw * 0.94, 980);

      const padY = 80;
      const gap = 24;
      const availH = Math.max(260, vh - headerH - padY - gap);

      setPortalW(Math.min(maxW, availH * aspect));
    };

    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, [plan?.width, plan?.height]);

  // ------------------------------ instant paint ------------------------------
  useEffect(() => {
    const cached = readCachedPlan();
    if (cached) {
      setPlan(cached);
      setIsPreview(false);
      setTotal(cached.subscriberCount || 0);
      setLoading(false);
      // we’ll mark final once we actually paint
    }
  }, []);

  /* ------------------------ sizing & blitting (no loops) -------------------- */

  function blitBufferToVisible(buf) {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame || !buf) return;

    const rect = frame.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const needsResize =
      canvas.width !== Math.round(cssW * dpr) ||
      canvas.height !== Math.round(cssH * dpr);
    if (needsResize) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(buf, 0, 0, cssW, cssH);

    // first paint triggers “enter” animation
    if (!didPaintRef.current) {
      didPaintRef.current = true;
      setHasPainted(true);
    }
  }

  // window resize → just re-blit current buffer
  useEffect(() => {
    function onResize() {
      const buf = finalBufferRef.current || previewBufferRef.current;
      blitBufferToVisible(buf);
      // If overlay exists but no hits, keep it sized to frame (blank anyway)
      const overlay = overlayRef.current;
      const frame = frameRef.current;
      if (overlay && frame && (!hits.length || !plan)) {
        const rect = frame.getBoundingClientRect();
        const cssW = Math.max(1, Math.floor(rect.width));
        const cssH = Math.max(1, Math.floor(rect.height));
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        overlay.width = Math.round(cssW * dpr);
        overlay.height = Math.round(cssH * dpr);
        const octx = overlay.getContext("2d");
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.clearRect(0, 0, cssW, cssH);
      }
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [hits.length, plan]);

  // ---------------------------------------------------------------------------
  // Kick off network: stats + masks + (preview plan & full plan in parallel)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const statsPromise = getStats();
        const masksPromise = getMasks();

        const stats = await statsPromise;
        if (!alive) return;

        const totalSubs = Number(stats?.total || 0);
        setTotal(totalSubs);

        // CAP is 3500 max
        const FULL_LIMIT = Math.min(CAP, totalSubs || 0);
        const PREVIEW_LIMIT = Math.min(1800, FULL_LIMIT);

        const previewPromise = PREVIEW_LIMIT > 0 ? getSlots(PREVIEW_LIMIT, "oldest") : null;
        const fullPromise = FULL_LIMIT > PREVIEW_LIMIT ? getSlots(FULL_LIMIT, "oldest") : null;

        // Load silhouette asap (others in background)
        const masks = await masksPromise;
        if (!alive) return;

        const silBmp = masks?.masks?.silhouette ? await loadBitmap(masks.masks.silhouette) : null;
        if (!alive) return;
        setMaskBitmaps((prev) => ({ ...prev, silhouette: silBmp }));

        // defer other masks (non-blocking)
        (async () => {
          try {
            const toLoad = [];
            const mm = masks?.masks || {};
            if (mm.eyes) toLoad.push(loadBitmap(mm.eyes).then((b) => ["eyes", b]));
            if (mm.pupils) toLoad.push(loadBitmap(mm.pupils).then((b) => ["pupils", b]));
            if (mm.nostrils) toLoad.push(loadBitmap(mm.nostrils).then((b) => ["nostrils", b]));
            if (mm.hair) toLoad.push(loadBitmap(mm.hair).then((b) => ["hair", b]));
            if (mm.headband) toLoad.push(loadBitmap(mm.headband).then((b) => ["headband", b]));
            if (mm.beak) toLoad.push(loadBitmap(mm.beak).then((b) => ["beak", b]));
            if (mm.feet) toLoad.push(loadBitmap(mm.feet).then((b) => ["feet", b]));
            toLoad.push(loadBitmap("/static/outline-mask0.png").then((b) => ["outline", b]));

            const entries = (await Promise.allSettled(toLoad))
              .filter((p) => p.status === "fulfilled")
              .map((p) => p.value);

            if (!alive) return;
            setMaskBitmaps((prev) => {
              const next = { ...prev };
              for (const [k, v] of entries) next[k] = v;
              return next;
            });
          } catch (e) {
            console.warn(e);
          }
        })();

        // show preview asap
        if (previewPromise) {
          const previewPlan = await previewPromise;
          if (!alive) return;
          previewPlan.subscriberCount = totalSubs;
          previewPlan.isPreview = true;

          setPlan((p) => p ?? previewPlan);
          setIsPreview(true);
          setLoading(false);
        } else {
          setLoading(false);
        }

        // hydrate with full plan
        if (fullPromise) {
          const fullPlan = await fullPromise;
          if (!alive) return;
          fullPlan.subscriberCount = totalSubs;
          fullPlan.isPreview = false;
          setPlan(fullPlan);
          setIsPreview(false);
          writeCachedPlan(fullPlan);
        } else if (previewPromise) {
          // Small channels (FULL_LIMIT <= PREVIEW_LIMIT):
          // show preview first, then promote the same plan to "full" so FINAL color render runs
          await new Promise((r) => requestAnimationFrame(() => r()));
          if (!alive) return;

          setPlan((p) => {
            if (!p) return p;
            return { ...p, isPreview: false };
          });
          setIsPreview(false);
          setHasFinal(false); // final will flip true once the colored buffer is painted
        }
      } catch (e) {
        setErr(String(e));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [CAP]);

  /* ---------------------------- SEARCH: build hits -------------------------- */
  useEffect(() => {
    if (!plan?.items) {
      setHits([]);
      setHitIndex(0);
      return;
    }

    const q = norm(searchQuery);
    if (q.length < 2) {
      setHits([]);
      setHitIndex(0);
      return;
    }

    const found = [];
    for (const it of plan.items) {
      if (it.kind !== "text") continue;

      const full = norm(it.fullText || it.search || it.text);
      const disp = norm(it.text);
      const dispNoEll = norm(stripEllipsis(it.text));

      const ok =
        full.includes(q) ||
        disp.includes(q) ||
        (String(it.text || "").endsWith("…") && q.startsWith(dispNoEll));

      if (ok) found.push(it);
    }

    setHits(found);
    setHitIndex(0);
  }, [searchQuery, plan]);

  /* ----------------------------- PREVIEW STAGE ------------------------------ */
  useEffect(() => {
    cancelAnimationFrame(rafPreviewRef.current);

    if (!plan?.isPreview || !maskBitmaps.silhouette) {
      const buf = finalBufferRef.current || previewBufferRef.current;
      blitBufferToVisible(buf);
      return;
    }

    const { width: w, height: h } = plan;

    // 1) TEXT LAYER (1×) — internal only
    const textLayer = document.createElement("canvas");
    textLayer.width = w;
    textLayer.height = h;
    const tctx = textLayer.getContext("2d");
    tctx.textAlign = "center";
    tctx.textBaseline = "middle";
    tctx.imageSmoothingEnabled = true;

    // silhouette + outline alpha at 1×
    const silMask = bitmapToAlphaMaskCanvas(maskBitmaps.silhouette, w, h, 1);
    const outlineMask = maskBitmaps.outline
      ? bitmapToAlphaMaskCanvas(maskBitmaps.outline, w, h, 1, 12)
      : null;

    // items for preview draw
    const items = plan.items?.filter((it) => it.kind === "text") || [];
    const PREVIEW_DRAW_MAX = Math.min(2000, items.length);
    const BATCH = Math.max(120, Math.floor(PREVIEW_DRAW_MAX / 10));
    const fontFamily = "ui-sans-serif, system-ui, Inter, Segoe UI, Arial";
    const bodyColor = "#111";

    // 2) COMPOSITED PREVIEW (translucent silhouette + clipped text + outline)
    const comp = document.createElement("canvas");
    comp.width = w;
    comp.height = h;
    const cctx = comp.getContext("2d");

    let i = 0;
    function step() {
      let drawn = 0;
      while (i < PREVIEW_DRAW_MAX && drawn < BATCH) {
        const it = items[i++];
        const px = Math.max(7, Number(it.size) || 12);
        tctx.font = `${px}px ${fontFamily}`;
        tctx.fillStyle = bodyColor;
        tctx.fillText(it.text, it.x, it.y);
        drawn++;
      }

      // compose: translucent base clipped to silhouette (lets retro BG show through)
      cctx.clearRect(0, 0, w, h);
      {
        const base = document.createElement("canvas");
        base.width = w;
        base.height = h;
        const bctx = base.getContext("2d");
        bctx.fillStyle = "rgba(255,255,255,0.10)";
        bctx.fillRect(0, 0, w, h);
        bctx.globalCompositeOperation = "destination-in";
        bctx.drawImage(silMask, 0, 0);
        cctx.drawImage(base, 0, 0);
      }
      // text clipped to silhouette
      {
        const masked = document.createElement("canvas");
        masked.width = w;
        masked.height = h;
        const mctx = masked.getContext("2d");
        mctx.drawImage(textLayer, 0, 0);
        mctx.globalCompositeOperation = "destination-in";
        mctx.drawImage(silMask, 0, 0);
        cctx.drawImage(masked, 0, 0);
      }
      // outline overlay (slightly glowy)
      if (outlineMask) {
        cctx.save();
        cctx.shadowColor = "rgba(34,211,238,0.40)";
        cctx.shadowBlur = 12;
        drawMaskFill1x(cctx, outlineMask, [255, 255, 255], 0.95);
        cctx.restore();
      }

      // IMPORTANT: set preview buffer to the *composited* image
      previewBufferRef.current = comp;
      blitBufferToVisible(comp);

      if (i < PREVIEW_DRAW_MAX) {
        rafPreviewRef.current = requestAnimationFrame(step);
      }
    }

    step();
    return () => cancelAnimationFrame(rafPreviewRef.current);
  }, [
    plan?.isPreview,
    plan?.width,
    plan?.height,
    maskBitmaps.silhouette,
    maskBitmaps.outline,
    plan,
  ]);

  /* ------------------------------ FINAL STAGE ------------------------------- */
  useEffect(() => {
    // Only run when we have a full plan and all feature masks
    if (!plan || plan.isPreview) return;

    const headbandActive =
      plan?.unlockHeadbandTails !== undefined ? !!plan.unlockHeadbandTails : total >= 1500;

    const need = [
      "silhouette",
      "hair",
      ...(headbandActive ? ["headband"] : []),
      "beak",
      "feet",
      "eyes",
      "pupils",
      "nostrils",
    ];
    if (!need.every((k) => !!maskBitmaps[k])) return;

    cancelAnimationFrame(rafPreviewRef.current);
    cancelAnimationFrame(rafFadeRef.current);

    const { width: w, height: h, items } = plan;

    // Threshold (3.5k) → energy outline
    const energyActive = total >= CAP;

    // Build 1× alpha masks once
    const silMask = bitmapToAlphaMaskCanvas(maskBitmaps.silhouette, w, h, 1);
    const hairMask = bitmapToAlphaMaskCanvas(maskBitmaps.hair, w, h, 1);
    const headbandMask = headbandActive ? bitmapToAlphaMaskCanvas(maskBitmaps.headband, w, h, 1) : null;
    const beakMask = bitmapToAlphaMaskCanvas(maskBitmaps.beak, w, h, 1);
    const feetMask = bitmapToAlphaMaskCanvas(maskBitmaps.feet, w, h, 1);
    const eyesMaskRaw = bitmapToAlphaMaskCanvas(maskBitmaps.eyes, w, h, 1);
    const eyesMask = dilateAlphaMask1x(eyesMaskRaw, 1); // expand slightly to clean edges
    const eyesMaskTop = dilateAlphaMask1x(eyesMaskRaw, 2); // TOPCOAT to hide outline glow inside eyes
    const pupilsMask = bitmapToAlphaMaskCanvas(maskBitmaps.pupils, w, h, 1);
    const nostrilsMask = bitmapToAlphaMaskCanvas(maskBitmaps.nostrils, w, h, 1);
    const outlineMask = maskBitmaps.outline ? bitmapToAlphaMaskCanvas(maskBitmaps.outline, w, h, 1, 12) : null;

    // body mask = silhouette minus feature regions (except pupils/nostrils)
    function makeBodyMask() {
      const base = document.createElement("canvas");
      base.width = silMask.width;
      base.height = silMask.height;
      const bctx = base.getContext("2d");
      bctx.drawImage(silMask, 0, 0);

      // NOTE: use expanded eyes mask so body text never peeks around the edges
      for (const m of [
        hairMask,
        ...(headbandActive && headbandMask ? [headbandMask] : []),
        beakMask,
        feetMask,
        eyesMask,
      ]) {
        bctx.globalCompositeOperation = "destination-out";
        bctx.drawImage(m, 0, 0);
        bctx.globalCompositeOperation = "source-over";
      }
      return base;
    }
    const bodyMask = makeBodyMask();

    // layers @1×
    function makeLayer() {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const cctx = c.getContext("2d");
      cctx.textAlign = "center";
      cctx.textBaseline = "middle";
      cctx.imageSmoothingEnabled = true;
      return [c, cctx];
    }
    const L = {
      body: makeLayer(),
      hair: makeLayer(),
      headband: makeLayer(),
      beak: makeLayer(),
      feet: makeLayer(),
    };

    // quick "inside" tester from alpha mask
    function insideFactory(maskCanvas) {
      const aCtx = maskCanvas.getContext("2d");
      const { width, height } = maskCanvas;
      const data = aCtx.getImageData(0, 0, width, height).data;
      return (x, y) => {
        const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
        const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
        return data[(yi * width + xi) * 4 + 3] > 0;
      };
    }
    const inHair = insideFactory(hairMask);
    const inHeadband = headbandActive && headbandMask ? insideFactory(headbandMask) : null;
    const inBeak = insideFactory(beakMask);
    const inFeet = insideFactory(feetMask);

    // draw names to feature layers
    const fontFamily = "ui-sans-serif, system-ui, Inter, Segoe UI, Arial";
    for (const it of items) {
      if (it.kind !== "text") continue;
      const px = Math.max(7, Number(it.size) || 12);
      const text = it.text;
      let bucket = "body";
      if (inHair(it.x, it.y)) bucket = "hair";
      else if (headbandActive && inHeadband && inHeadband(it.x, it.y)) bucket = "headband";
      else if (inBeak(it.x, it.y)) bucket = "beak";
      else if (inFeet(it.x, it.y)) bucket = "feet";

      const [, bctx] = L[bucket];
      bctx.font = `${px}px ${fontFamily}`;
      bctx.fillStyle = it.color || "#000";
      bctx.fillText(text, it.x, it.y);
    }

    // compose final buffer @1×
    const final = document.createElement("canvas");
    final.width = w;
    final.height = h;
    const fctx = final.getContext("2d");

    // translucent silhouette background (lets retro BG show through)
    drawMaskFill1x(fctx, silMask, [255, 255, 255], 0.12);

    // --- NEW: per-name NEON GLOW (arcade bloom) ---
    // This gives each colored name its own deep glow against the darker bg.
    function makeMaskedLayerCanvas(layerCanvas, maskCanvas) {
      const masked = document.createElement("canvas");
      masked.width = layerCanvas.width;
      masked.height = layerCanvas.height;
      const mctx = masked.getContext("2d");
      mctx.drawImage(layerCanvas, 0, 0);
      mctx.globalCompositeOperation = "destination-in";
      mctx.drawImage(maskCanvas, 0, 0);
      return masked;
    }

    function drawLayerNeon(layerCanvas, maskCanvas, intensity = 1) {
      const masked = makeMaskedLayerCanvas(layerCanvas, maskCanvas);

      const outerBlur = Math.max(10, 24 * intensity);
      const midBlur = Math.max(6, 14 * intensity);
      const innerBlur = Math.max(3, 7 * intensity);

      // bloom stack (additive) — uses the tile colors already in the layer
      fctx.save();
      fctx.globalCompositeOperation = "lighter";

      fctx.globalAlpha = 0.22 * intensity;
      fctx.filter = `blur(${outerBlur}px)`;
      fctx.drawImage(masked, 0, 0);

      fctx.globalAlpha = 0.34 * intensity;
      fctx.filter = `blur(${midBlur}px)`;
      fctx.drawImage(masked, 0, 0);

      fctx.globalAlpha = 0.55 * intensity;
      fctx.filter = `blur(${innerBlur}px)`;
      fctx.drawImage(masked, 0, 0);

      // small core boost (no blur) to make it feel more "neon"
      fctx.globalAlpha = 0.12 * intensity;
      fctx.filter = "none";
      fctx.drawImage(masked, 0, 0);

      fctx.restore();

      // crisp pass
      fctx.save();
      fctx.globalCompositeOperation = "source-over";
      fctx.globalAlpha = 1;
      fctx.filter = "none";
      fctx.drawImage(masked, 0, 0);
      fctx.restore();
    }

    if (headbandActive && headbandMask) {
      // --- bandana/headband red glow emphasis (behind the text layer) ---
      fctx.save();
      fctx.shadowColor = "rgba(255, 70, 110, 0.60)";
      fctx.shadowBlur = 26;
      drawMaskFill1x(fctx, headbandMask, [255, 60, 90], 0.14);
      fctx.restore();
    }

    // Apply neon glow to each region layer (body/hair/beak/feet/headband)
    // (slightly stronger on body so the whole mosaic reads brighter)
    drawLayerNeon(L.body[0], bodyMask, 1.05);
    drawLayerNeon(L.beak[0], beakMask, 0.95);
    drawLayerNeon(L.feet[0], feetMask, 0.95);
    if (headbandActive && headbandMask) {
      drawLayerNeon(L.headband[0], headbandMask, 1.0);
    }
    drawLayerNeon(L.hair[0], hairMask, 0.95);

    // OUTLINE (static) — ONLY below 3.5k
    if (outlineMask && !energyActive) {
      fctx.save();
      fctx.shadowColor = "rgba(34,211,238,0.55)";
      fctx.shadowBlur = 18;
      drawMaskFill1x(fctx, outlineMask, [255, 255, 255], 0.95);
      fctx.restore();
    }

    // EYES TOPCOAT (AFTER outline): covers any cyan shadow bleeding into the whites
    drawMaskFill1x(fctx, eyesMaskTop, [255, 255, 255], 1);
    drawMaskFill1x(fctx, eyesMaskRaw, [255, 255, 255], 1);

    // pupils + nostrils (dark) — keep on top of the eye whites
    const detailsAlpha = Math.max(0, Math.min(1, total / 1000));
    drawMaskFill1x(fctx, pupilsMask, [17, 24, 39], detailsAlpha);
    drawMaskFill1x(fctx, nostrilsMask, [17, 24, 39], detailsAlpha);

    // Cache an outline mask + alpha data for the Saber energy loop (thicker + sampleable)
    if (outlineMask) {
      const thick = dilateAlphaMask1x(outlineMask, 2);
      const octx = thick.getContext("2d", { willReadFrequently: true });
      const odata = octx.getImageData(0, 0, thick.width, thick.height).data;
      energyOutlineMaskRef.current = { canvas: thick, data: odata, w: thick.width, h: thick.height };
    } else {
      energyOutlineMaskRef.current = null;
    }

    // save final buffer & crossfade
    const from = previewBufferRef.current || null;
    finalBufferRef.current = final;

    if (!from) {
      blitBufferToVisible(final);
      setHasFinal(true);
      return;
    }

    const start = performance.now();
    const DURATION = 380;
    let marked = false;

    function fade() {
      const canvas = canvasRef.current;
      const frame = frameRef.current;
      if (!canvas || !frame) return;

      const rect = frame.getBoundingClientRect();
      const cssW = Math.max(1, Math.floor(rect.width));
      const cssH = Math.max(1, Math.floor(rect.height));
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const needsResize =
        canvas.width !== Math.round(cssW * dpr) ||
        canvas.height !== Math.round(cssH * dpr);
      if (needsResize) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const t = Math.min(1, (performance.now() - start) / DURATION);
      ctx.globalAlpha = 1 - t * t; // ease
      ctx.drawImage(from, 0, 0, cssW, cssH);
      ctx.globalAlpha = t * t;
      ctx.drawImage(final, 0, 0, cssW, cssH);
      ctx.globalAlpha = 1;

      if (t < 1) {
        rafFadeRef.current = requestAnimationFrame(fade);
      } else if (!marked) {
        marked = true;
        setHasFinal(true);
      }
    }
    fade();

    return () => cancelAnimationFrame(rafFadeRef.current);
  }, [plan, maskBitmaps, total, CAP]);

  /* -------------------- ENERGY: SABER-style fractal energy @3.5k ------------- */
  useEffect(() => {
    cancelAnimationFrame(rafEnergyRef.current);

    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const energyActive = total >= CAP;
    const base = finalBufferRef.current || null;

    if (!hasFinal || !energyActive || !base || !plan) {
      const buf = finalBufferRef.current || previewBufferRef.current;
      blitBufferToVisible(buf);
      return;
    }

    const outlineObj = energyOutlineMaskRef.current;
    if (!outlineObj?.data) return;

    const { width: w, height: h } = plan;

    // Keep perf stable: render energy at ~520px max dimension, then upscale
    const maxDim = Math.max(w, h);
    const energyScale = Math.max(0.7, Math.min(1, 520 / maxDim));
    const eW = Math.max(1, Math.round(w * energyScale));
    const eH = Math.max(1, Math.round(h * energyScale));

    const energyState = ensureEnergyCanvas(energyCanvasRef, eW, eH);

    // Noise field resolution (smaller than energy for speed)
    const minDim = Math.max(1, Math.min(eW, eH));
    const noiseRes = Math.max(220, Math.min(380, Math.round(minDim * 0.75)));
    const noiseState = ensureNoiseState(energyNoiseRef, noiseRes);

    const drawFrame = (tNow) => {
      const canvas = canvasRef.current;
      const frame = frameRef.current;
      if (!canvas || !frame) return;

      const rect = frame.getBoundingClientRect();
      const cssW = Math.max(1, Math.floor(rect.width));
      const cssH = Math.max(1, Math.floor(rect.height));
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      const wantW = Math.round(cssW * dpr);
      const wantH = Math.round(cssH * dpr);
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
      }

      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // 1) Base render
      ctx.drawImage(base, 0, 0, cssW, cssH);

      const tSec = tNow / 1000;

      // 2) Build turbulence field + energy mask (this is the Saber-ish part)
      renderSaberFields(noiseState, tSec, {
        seed: 7331,
        dispScale: 2.05,
        filScale: 7.9,
        octDisp: 3,
        octFil: 4,
        flowX: 0.28,
        flowY: 0.22,
      });

      renderSaberEnergyMask(energyState, outlineObj, noiseState, tSec, {
        amp: 3.9 * energyScale, // displacement strength
        gain: 1.18,
        cut: 0.15,
        sharpPow: 1.95,
      });

      // 3) Saber glow stack: colored bloom + hot white core
      const pulse = 0.74 + 0.26 * Math.sin(tSec * 2.1);
      const jitterX = Math.sin(tSec * 4.2) * 0.35;
      const jitterY = Math.cos(tSec * 3.6) * 0.35;

      ctx.save();
      ctx.translate(jitterX, jitterY);
      ctx.globalCompositeOperation = "lighter";

      // Outer bloom (magenta-ish)
      ctx.globalAlpha = 0.55 * pulse;
      ctx.filter = "blur(34px)";
      ctx.shadowColor = "rgba(255,120,200,0.70)";
      ctx.shadowBlur = 52;
      ctx.drawImage(energyState.canvas, 0, 0, cssW, cssH);

      // Mid bloom (warm)
      ctx.globalAlpha = 0.7 * pulse;
      ctx.filter = "blur(18px)";
      ctx.shadowColor = "rgba(255,210,120,0.70)";
      ctx.shadowBlur = 34;
      ctx.drawImage(energyState.canvas, 0, 0, cssW, cssH);

      // Inner glow (cyan-ish)
      ctx.globalAlpha = 0.95 * pulse;
      ctx.filter = "blur(7px)";
      ctx.shadowColor = "rgba(34,211,238,0.85)";
      ctx.shadowBlur = 18;
      ctx.drawImage(energyState.canvas, 0, 0, cssW, cssH);

      // Hot core (white, sharp)
      ctx.globalAlpha = 1.0;
      ctx.shadowBlur = 0;
      ctx.shadowColor = "rgba(0,0,0,0)";
      ctx.filter = "contrast(260%) brightness(1.35)";
      ctx.drawImage(energyState.canvas, 0, 0, cssW, cssH);

      // Extra crisp pass
      ctx.globalAlpha = 0.9;
      ctx.filter = "contrast(300%) brightness(1.5)";
      ctx.drawImage(energyState.canvas, 0, 0, cssW, cssH);

      ctx.restore();
      ctx.filter = "none";
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;

      if (!didPaintRef.current) {
        didPaintRef.current = true;
        setHasPainted(true);
      }
    };

    if (prefersReduced) {
      drawFrame(performance.now());
      return () => cancelAnimationFrame(rafEnergyRef.current);
    }

    const tick = (now) => {
      drawFrame(now);
      rafEnergyRef.current = requestAnimationFrame(tick);
    };

    rafEnergyRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafEnergyRef.current);
  }, [hasFinal, total, CAP, plan]);

  /* --------------------- HIGHLIGHT: overlay animation loop ------------------ */
  useEffect(() => {
    cancelAnimationFrame(rafHighlightRef.current);

    const overlay = overlayRef.current;
    const frame = frameRef.current;
    if (!overlay || !frame) return;

    const ctxMeasure = document.createElement("canvas").getContext("2d");
    if (!ctxMeasure) return;

    const fontFamily = "ui-sans-serif, system-ui, Inter, Segoe UI, Arial";

    function resizeOverlayToFrame() {
      const rect = frame.getBoundingClientRect();
      const cssW = Math.max(1, Math.floor(rect.width));
      const cssH = Math.max(1, Math.floor(rect.height));
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      const wantW = Math.round(cssW * dpr);
      const wantH = Math.round(cssH * dpr);
      if (overlay.width !== wantW || overlay.height !== wantH) {
        overlay.width = wantW;
        overlay.height = wantH;
      }
      return { cssW, cssH, dpr };
    }

    function clear() {
      const { cssW, cssH, dpr } = resizeOverlayToFrame();
      const octx = overlay.getContext("2d");
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.clearRect(0, 0, cssW, cssH);
    }

    if (!hits.length || !plan) {
      clear();
      return;
    }

    const start = performance.now();

    function tick() {
      const { cssW, cssH, dpr } = resizeOverlayToFrame();
      const octx = overlay.getContext("2d");
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.clearRect(0, 0, cssW, cssH);

      const it = hits[Math.min(hitIndex, hits.length - 1)];
      const sx = cssW / Math.max(1, plan.width);
      const sy = cssH / Math.max(1, plan.height);

      const t = (performance.now() - start) / 1000;

      const px = Math.max(7, Number(it.size) || 12);
      const text = String(it.text || "");

      ctxMeasure.font = `${px}px ${fontFamily}`;
      const mw = ctxMeasure.measureText(text).width;
      const mh = px * 1.05;

      const x = (it.x || 0) * sx;
      const y = (it.y || 0) * sy;
      const w = mw * sx;
      const h = mh * sy;

      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
      const pad = 8 + pulse * 6;

      const rx = w / 2 + pad;
      const ry = h / 2 + pad;

      // 1) Spotlight dim (darken everything except a soft oval around the hit)
      octx.save();
      octx.fillStyle = "rgba(0,0,0,0.35)";
      octx.fillRect(0, 0, cssW, cssH);
      octx.globalCompositeOperation = "destination-out";
      octx.beginPath();
      octx.ellipse(x, y, rx * 1.55, ry * 1.9, 0, 0, Math.PI * 2);
      octx.fill();
      octx.restore();

      // 2) Glow rounded-rect around the name area
      octx.save();
      octx.globalCompositeOperation = "lighter";
      octx.shadowColor = "rgba(34,211,238,0.85)";
      octx.shadowBlur = 22;
      octx.strokeStyle = "rgba(255,120,200,0.85)";
      octx.lineWidth = 3;
      roundRectPath(octx, x - rx, y - ry, rx * 2, ry * 2, 12);
      octx.stroke();
      octx.restore();

      // 3) Ping ring
      const ping = (t % 1.25) / 1.25;
      octx.save();
      octx.globalCompositeOperation = "lighter";
      octx.strokeStyle = `rgba(34,211,238,${0.75 * (1 - ping)})`;
      octx.lineWidth = 2;
      octx.beginPath();
      octx.ellipse(x, y, rx * (1.2 + ping), ry * (1.2 + ping), 0, 0, Math.PI * 2);
      octx.stroke();
      octx.restore();

            /* ---------------- NEW: make the name readable + magnifier ---------------- */

      const fullLabel = String(it.fullText || it.text || "");
      const s = (sx + sy) * 0.5; // plan→CSS scale (should be ~uniform)

      // A) Re-draw the hit name in high-contrast (white) directly over the mosaic
      //    so you can actually read it where it is.
      const nameCssPx = Math.max(10, px * s);
      octx.save();
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.font = `700 ${nameCssPx}px ${fontFamily}`;
      octx.lineJoin = "round";

      // dark stroke first
      octx.shadowColor = "rgba(0,0,0,0.75)";
      octx.shadowBlur = 10;
      octx.strokeStyle = "rgba(0,0,0,0.88)";
      octx.lineWidth = Math.max(2, nameCssPx * 0.20);
      octx.strokeText(text, x, y);

      // white fill + subtle glow
      octx.shadowColor = "rgba(255,255,255,0.65)";
      octx.shadowBlur = 14;
      octx.fillStyle = `rgba(255,255,255,${0.92 + 0.08 * pulse})`;
      octx.fillText(text, x, y);
      octx.restore();

      // B) Magnifier card (zoomed crop) — samples from the *already rendered* canvas
      //    so we don’t re-render the mosaic at all.
      const srcCanvas = canvasRef.current; // visible canvas (includes energy if active)
      if (srcCanvas) {
        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

        const magW = Math.min(360, Math.max(240, cssW * 0.34));
        const magH = Math.min(240, Math.max(160, magW * 0.62));
        const margin = 14;

        let cardX = x + rx + 18;
        let cardY = y - ry - magH - 18;

        // flip sides if we’d go offscreen
        if (cardX + magW + margin > cssW) cardX = x - rx - 18 - magW;
        if (cardY < margin) cardY = y + ry + 18;

        cardX = clamp(cardX, margin, cssW - magW - margin);
        cardY = clamp(cardY, margin, cssH - magH - margin);

        // card background
        octx.save();
        octx.globalCompositeOperation = "source-over";
        octx.shadowColor = "rgba(34,211,238,0.35)";
        octx.shadowBlur = 24;
        octx.fillStyle = "rgba(0,0,0,0.55)";
        octx.strokeStyle = "rgba(255,255,255,0.12)";
        octx.lineWidth = 1;
        roundRectPath(octx, cardX, cardY, magW, magH, 16);
        octx.fill();
        octx.stroke();
        octx.restore();

        // title (full name)
        octx.save();
        octx.textAlign = "left";
        octx.textBaseline = "middle";
        octx.shadowColor = "rgba(0,0,0,0.75)";
        octx.shadowBlur = 10;
        octx.fillStyle = "rgba(255,255,255,0.92)";
        const titlePx = Math.max(12, Math.min(16, magW * 0.06));
        octx.font = `700 ${titlePx}px ${fontFamily}`;
        const titlePad = 12;
        const titleY = cardY + 18;
        // keep it from running super long visually
        const titleText = fullLabel.length > 42 ? fullLabel.slice(0, 41) + "…" : fullLabel;
        octx.fillText(titleText, cardX + titlePad, titleY);
        octx.restore();

        // magnified crop area
        const innerPad = 12;
        const headerH = 34;
        const thumbX = cardX + innerPad;
        const thumbY = cardY + headerH;
        const thumbW = magW - innerPad * 2;
        const thumbH = magH - headerH - innerPad;

        const zoom = 2.7;

        // crop in CSS-space around the hit
        const srcW = thumbW / zoom;
        const srcH = thumbH / zoom;
        let srcX = x - srcW / 2;
        let srcY = y - srcH / 2;
        srcX = clamp(srcX, 0, cssW - srcW);
        srcY = clamp(srcY, 0, cssH - srcH);

        // draw crop (note: src rect must be in *canvas pixel* units)
        octx.save();
        roundRectPath(octx, thumbX, thumbY, thumbW, thumbH, 14);
        octx.clip();
        octx.imageSmoothingEnabled = true;
        octx.filter = "contrast(135%) brightness(120%)";
        octx.drawImage(
          srcCanvas,
          srcX * dpr,
          srcY * dpr,
          srcW * dpr,
          srcH * dpr,
          thumbX,
          thumbY,
          thumbW,
          thumbH
        );
        octx.filter = "none";
        octx.restore();

        // border glow around the crop
        octx.save();
        octx.globalCompositeOperation = "lighter";
        octx.shadowColor = "rgba(255,120,200,0.55)";
        octx.shadowBlur = 18;
        octx.strokeStyle = "rgba(34,211,238,0.55)";
        octx.lineWidth = 2;
        roundRectPath(octx, thumbX, thumbY, thumbW, thumbH, 14);
        octx.stroke();
        octx.restore();

        // draw a box around the name *inside* the magnified view
        const bx = thumbX + (x - w / 2 - srcX) * zoom;
        const by = thumbY + (y - h / 2 - srcY) * zoom;
        const bw = w * zoom;
        const bh = h * zoom;

        octx.save();
        octx.globalCompositeOperation = "lighter";
        octx.strokeStyle = "rgba(255,255,255,0.92)";
        octx.lineWidth = 2;
        roundRectPath(octx, bx - 6, by - 6, bw + 12, bh + 12, 10);
        octx.stroke();
        octx.restore();

        // little zoom label
        octx.save();
        octx.textAlign = "right";
        octx.textBaseline = "alphabetic";
        octx.fillStyle = "rgba(255,255,255,0.55)";
        octx.font = `12px ${fontFamily}`;
        octx.fillText(`×${zoom.toFixed(1)}`, cardX + magW - 12, cardY + magH - 10);
        octx.restore();
      }

      rafHighlightRef.current = requestAnimationFrame(tick);
    }

    tick();
    return () => cancelAnimationFrame(rafHighlightRef.current);
  }, [hits, hitIndex, plan]);

  /* ----------------------------------- UI ----------------------------------- */

  if (err) {
    return (
      <div className="w-full min-h-[60vh] grid place-items-center p-6">
        <div className="text-red-400">{err}</div>
      </div>
    );
  }

  const requested = plan?.namesRequested ?? null;
  const placed = plan?.namesPlaced ?? null;

  const filled = Math.min(total, CAP);
  const progress01 = CAP > 0 ? Math.max(0, Math.min(1, filled / CAP)) : 0;

  const statusLabel = loading
    ? "Booting…"
    : hasFinal && !isPreview
    ? "Assembled"
    : isPreview
    ? "Assembling"
    : "Ready";

  const frameMotion = !hasPainted
    ? "opacity-0 scale-[0.985] translate-y-[6px] blur-sm"
    : "opacity-100 scale-100 translate-y-0 blur-0";

  const floatClass = !hasFinal ? "animate-[float_6.5s_ease-in-out_infinite]" : "";
  const showCaption = requested != null && placed != null;

  return (
    <div
      ref={containerRef}
      className="relative w-full min-h-[100svh] flex items-center justify-center px-4 py-10 text-white overflow-hidden"
      style={{
        background:
          "radial-gradient(1200px 700px at 50% 35%, rgba(255,255,255,0.06), rgba(0,0,0,0) 55%), linear-gradient(180deg, #050215 0%, #12062b 40%, #070214 100%)",
      }}
    >
      {/* STARFIELD */}
      <div
        className="pointer-events-none absolute inset-0 opacity-60 animate-[stars_18s_linear_infinite]"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(255,255,255,0.55) 1px, transparent 1px), radial-gradient(circle, rgba(255,255,255,0.35) 1px, transparent 1px)",
          backgroundSize: "120px 120px, 210px 210px",
          backgroundPosition: "0 0, 40px 60px",
        }}
      />

      {/* SOFT NEON CLOUDS */}
      <div
        className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 h-72 w-[54rem] rounded-full blur-3xl opacity-50 animate-[pulse_6s_ease-in-out_infinite]"
        style={{
          background: "radial-gradient(circle, rgba(255,120,200,0.45), transparent 70%)",
        }}
      />
      <div
        className="pointer-events-none absolute bottom-[-40px] right-[-40px] h-80 w-80 rounded-full blur-3xl opacity-40 animate-[pulse_7.5s_ease-in-out_infinite]"
        style={{
          background: "radial-gradient(circle, rgba(34,211,238,0.30), transparent 70%)",
        }}
      />

      <div className="w-full max-w-6xl">
        {/* HEADER */}
        <div ref={headerRef} className="mb-6 sm:mb-8 text-center">
          {/* NEW: YouTube button */}
          <div className="mb-3 flex items-center justify-center">
            <a
              href={YT_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Open YouTube channel"
              title="YouTube"
              className={[
                "group relative inline-flex items-center gap-2 rounded-full",
                "border border-white/10 bg-black/30 px-3 py-2",
                "backdrop-blur transition-all duration-300",
                "hover:border-white/20 hover:bg-black/40",
                "focus:outline-none focus:ring-2 focus:ring-white/30",
              ].join(" ")}
              style={{
                boxShadow:
                  "0 0 0 1px rgba(255,255,255,0.04), 0 18px 60px rgba(0,0,0,0.35)",
              }}
            >
              {/* halo */}
              <span
                className="pointer-events-none absolute -inset-1 rounded-full opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  background:
                    "conic-gradient(from 210deg, rgba(34,211,238,0.45), rgba(255,120,200,0.55), rgba(255,210,120,0.45), rgba(34,211,238,0.45))",
                }}
              />

              {/* icon capsule */}
              <span
                className="relative grid h-9 w-9 place-items-center rounded-full border border-white/10"
                style={{
                  background:
                    "radial-gradient(circle at 30% 30%, rgba(255,255,255,0.12), rgba(0,0,0,0) 55%), linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.18))",
                }}
              >
                <svg width="22" height="22" viewBox="0 0 28 20" aria-hidden="true">
                  <path
                    d="M27.3 3.1c-.3-1.2-1.3-2.1-2.6-2.4C22.4.1 14 .1 14 .1S5.6.1 3.3.7C2 1 1 1.9.7 3.1.1 5.4.1 10 .1 10s0 4.6.6 6.9c.3 1.2 1.3 2.1 2.6 2.4 2.3.6 10.7.6 10.7.6s8.4 0 10.7-.6c1.3-.3 2.3-1.2 2.6-2.4.6-2.3.6-6.9.6-6.9s0-4.6-.6-6.9Z"
                    fill="rgba(255,60,90,0.95)"
                  />
                  <path d="M11.2 14.3V5.7L19 10l-7.8 4.3Z" fill="white" />
                </svg>
              </span>

              <span className="relative hidden sm:block text-[13px] text-white/75 group-hover:text-white">
                YouTube
              </span>
              <span className="relative hidden sm:block text-[13px] text-white/35">•</span>
              <span className="relative hidden sm:block text-[13px] text-white/55 group-hover:text-white/80">
                @Komala8
              </span>
            </a>
          </div>

          <h1 className="mt-4 text-[30px] sm:text-[44px] font-semibold tracking-tight">
            <span
              className="text-transparent bg-clip-text"
              style={{
                backgroundImage:
                  "linear-gradient(90deg, rgba(34,211,238,1), rgba(255,120,200,1), rgba(255,210,120,1))",
              }}
            >
              Subscribe = Power
            </span>
          </h1>

          <p className="mt-2 text-[14px] sm:text-[16px] text-white/70">
            Every name becomes a tile, together they form Psyduck.
          </p>

          {/* SEARCH */}
          <div className="mt-4 mx-auto max-w-md">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-2 backdrop-blur">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Find your name…"
                className="w-full bg-transparent text-[14px] text-white outline-none placeholder:text-white/40"
              />
              {hits.length > 0 && (
                <div className="shrink-0 text-[12px] text-white/70">
                  {hitIndex + 1}/{hits.length}
                </div>
              )}
              <button
                type="button"
                onClick={() =>
                  setHitIndex((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0))
                }
                disabled={hits.length < 2}
                className="shrink-0 rounded-full px-2 py-1 text-white/80 hover:bg-white/10 disabled:opacity-30"
                title="Previous"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => setHitIndex((i) => (hits.length ? (i + 1) % hits.length : 0))}
                disabled={hits.length < 2}
                className="shrink-0 rounded-full px-2 py-1 text-white/80 hover:bg-white/10 disabled:opacity-30"
                title="Next"
              >
                ›
              </button>
            </div>

            {searchQuery.trim().length >= 2 && hits.length === 0 && (
              <div className="mt-2 text-center text-[12px] text-white/55">
                No match in the current render (try fewer characters, or your name may be
                truncated/not included).
              </div>
            )}
          </div>

          {/* PROGRESS BAR to CAP */}
          <div className="mt-4 mx-auto max-w-md">
            <div className="flex items-center justify-between text-[12px] text-white/60">
              <span>{filled.toLocaleString()} used</span>
              <span>cap {CAP.toLocaleString()}</span>
            </div>
            <div className="mt-2 h-2 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.round(progress01 * 100)}%`,
                  background:
                    "linear-gradient(90deg, rgba(34,211,238,0.9), rgba(255,120,200,0.9), rgba(255,210,120,0.9))",
                }}
              />
            </div>
          </div>
        </div>

        {/* PORTAL STAGE (retro scene behind the canvas) */}
        <div
          ref={frameRef}
          className={[
            "relative mx-auto rounded-[38px] overflow-hidden",
            "transition-all duration-700 ease-[cubic-bezier(0.2,0.9,0.2,1)]",
            frameMotion,
            floatClass,
          ].join(" ")}
          style={{
            width: portalW ? `${Math.floor(portalW)}px` : "min(94vw, 980px)",
            aspectRatio: `${Math.max(1, plan?.width || 512)} / ${Math.max(
              1,
              plan?.height || 512
            )}`,
          }}
        >
          {/* SCENE BACKDROP */}
          <div className="absolute inset-0">
            {/* gradient sky (moon/sun removed) */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(900px 520px at 50% 30%, rgba(255,120,200,0.16), rgba(0,0,0,0) 62%), linear-gradient(180deg, rgba(8,3,25,1) 0%, rgba(15,5,40,1) 55%, rgba(5,2,20,1) 100%)",
              }}
            />

            {/* horizon glow */}
            <div
              className="absolute left-0 right-0 top-[52%] h-32 opacity-60"
              style={{
                background:
                  "linear-gradient(180deg, rgba(34,211,238,0.0), rgba(34,211,238,0.18), rgba(255,120,200,0.0))",
                filter: "blur(10px)",
              }}
            />

            {/* retro grid floor */}
            <div
              className="absolute inset-x-0 bottom-[-28%] h-[72%] opacity-45 animate-[gridMove_3.6s_linear_infinite]"
              style={{
                transform: "perspective(900px) rotateX(68deg)",
                transformOrigin: "center top",
                backgroundImage:
                  "linear-gradient(rgba(255,120,200,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.35) 1px, transparent 1px)",
                backgroundSize: "64px 64px",
                backgroundPosition: "0 0, 0 0",
              }}
            />

            {/* drifting comets */}
            <div
              className="absolute -left-32 top-12 h-[2px] w-40 opacity-60 animate-[comet_4.8s_linear_infinite]"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent)",
              }}
            />
            <div
              className="absolute -left-40 top-28 h-[2px] w-56 opacity-40 animate-[comet_6.2s_linear_infinite]"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(34,211,238,0.8), transparent)",
              }}
            />

            {/* scanlines */}
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.10] animate-[scan_7s_linear_infinite]"
              style={{
                background:
                  "repeating-linear-gradient(to bottom, rgba(255,255,255,0.10) 0px, rgba(255,255,255,0.10) 1px, rgba(0,0,0,0) 3px, rgba(0,0,0,0) 6px)",
                mixBlendMode: "overlay",
              }}
            />

            {/* vignette */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(900px 520px at 50% 55%, rgba(0,0,0,0), rgba(0,0,0,0.35) 80%, rgba(0,0,0,0.55) 100%)",
              }}
            />
          </div>

          {/* halo behind the duck */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(360px 360px at 50% 52%, rgba(255,210,120,0.16), rgba(255,120,200,0.10), rgba(0,0,0,0) 70%)",
              filter: "blur(2px)",
            }}
          />

          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            style={{
              filter:
                "drop-shadow(0 28px 70px rgba(0,0,0,0.45)) drop-shadow(0 0 26px rgba(34,211,238,0.10))",
            }}
          />

          <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />

          {/* bottom pills */}
          {showCaption && (
            <div className="absolute left-4 right-4 bottom-4 flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[12px] text-white/85 backdrop-blur">
                <span className={isPreview ? "text-sky-300" : "text-emerald-300"}>
                  {isPreview ? "Preview" : "Final"}
                </span>
                <span className="text-white/30">•</span>
                <span>
                  {placed.toLocaleString()} / {requested.toLocaleString()} names
                </span>
              </div>

              <div className="hidden sm:inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[12px] text-white/85 backdrop-blur">
                <span className="text-white/60">subs</span>
                <span className="font-medium text-white">{total.toLocaleString()}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes stars {
          from { transform: translateY(0px); }
          to { transform: translateY(160px); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: .45; }
          50% { transform: scale(1.06); opacity: .60; }
        }
        @keyframes gridMove {
          from { background-position: 0 0, 0 0; }
          to   { background-position: 0 64px, 0 64px; }
        }
        @keyframes scan {
          from { transform: translateY(-12px); }
          to   { transform: translateY(12px); }
        }
        @keyframes comet {
          0%   { transform: translateX(-20vw); opacity: 0; }
          10%  { opacity: .7; }
          70%  { opacity: .5; }
          100% { transform: translateX(140vw); opacity: 0; }
        }
        @keyframes float {
          0% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
          100% { transform: translateY(0px); }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation: none !important; transition: none !important; }
        }
      `}</style>
    </div>
  );
}
