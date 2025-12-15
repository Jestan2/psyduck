export const BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

async function j(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}

// Stats + masks
export const getStats = () => j(`${BASE}/psyduck/stats`);
export const getMasks = () => j(`${BASE}/psyduck/masks`);

// Old helper (keep if used elsewhere)
export const getNames = (limit = 12000, order = "recent") =>
  j(`${BASE}/psyduck/names?limit=${limit}&order=${order}`);

// Primary layout
export const getSlots = (limit = 12000, order = "oldest") =>
  j(`${BASE}/psyduck/slots?limit=${limit}&order=${order}`);

export const seedFakes = async (count = 1000) =>
  j(`${BASE}/psyduck/seed-fakes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });