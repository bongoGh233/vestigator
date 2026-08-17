export function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtAgo(ts) {
  if (!ts) return "—";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function initials(name) {
  return (name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

export function statusLabel(s) {
  return s.replace("_", " ");
}

export function computeDistanceKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function computeEtaKm(distanceKm, speedKmh) {
  if (distanceKm == null || !speedKmh || speedKmh <= 0) return null;
  return distanceKm / speedKmh;
}

const PRICE_UNIT_LABELS = {
  flat: "Flat rate",
  per_hour: "Per hour",
  per_km: "Per km",
};

// Prices travel as integer minor units (e.g. 20000 = GHS 200.00).
export function fmtPrice(amountMinor, currency) {
  if (amountMinor == null) return null;
  const major = amountMinor / 100;
  const text = Number.isInteger(major)
    ? major.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : major.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${text}` : text;
}

export function priceUnitLabel(unit) {
  return PRICE_UNIT_LABELS[unit] || "Flat rate";
}

export function fmtDuration(min) {
  if (min == null || min <= 0) return null;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function fmtDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatMoneyInput(value) {
  const s = String(value ?? "").replace(",", ".");
  if (s === "" || s === ".") return s;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : "";
}

// ---- availability window helpers ----

export const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Minutes-since-midnight → "9:00 am".
export function fmtWindow(min) {
  if (!Number.isInteger(min)) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Minutes-since-midnight → "09:30" (for <input type="time">).
export function minToTimeInput(min) {
  if (!Number.isInteger(min) || min < 0 || min > 1440) return "";
  if (min === 1440) return "24:00";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// "09:30" (or "9:30", "9:30 pm" won't parse — inputs give 24h) → minutes.
export function timeInputToMin(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
