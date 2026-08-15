const cache = new Map();

export async function fetchRoute(from, to) {
  if (!from || !to) return null;
  const f = `${from.lat.toFixed(4)},${from.lng.toFixed(4)}`;
  const t = `${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
  const key = `${f}->${t}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const res = await fetch(`/api/route?from=${f}&to=${t}`);
    if (!res.ok) return null;
    const data = await res.json();
    cache.set(key, data);
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return data;
  } catch {
    return null;
  }
}
