import { useState, useEffect } from "react";
import { api } from "../api";

const POLL_MS = 30_000;

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  const load = () => api("/api/admin/dashboard").then(setStats).catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);
  useEffect(() => { const id = setInterval(load, POLL_MS); return () => clearInterval(id); }, []);

  if (error) return <div className="container"><p className="sub" style={{ color: "var(--danger)" }}>{error}</p></div>;
  if (!stats) return <div className="container"><p className="sub">Loading…</p></div>;

  const cards = [
    { label: "Total Users", value: stats.totalUsers },
    { label: "Providers", value: stats.totalProviders },
    { label: "Bookings", value: stats.totalBookings },
    { label: "Bookings (30d)", value: stats.bookingsLast30d },
    { label: "Revenue", value: `GHS ${(stats.totalRevenue / 100).toFixed(2)}` },
    { label: "Platform Fees", value: `GHS ${(stats.totalPlatformFees / 100).toFixed(2)}` },
    { label: "Open Reports", value: stats.openReports, warn: stats.openReports > 0 },
    { label: "Audit Logs (30d)", value: stats.recentAuditCount },
  ];

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <h2>Admin Dashboard</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 14, marginTop: 16 }}>
        {cards.map((c) => (
          <div key={c.label} className="card" style={{ textAlign: "center", padding: "20px 14px" }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: c.warn ? "var(--warn)" : "var(--accent)" }}>{c.value}</div>
            <div className="sub" style={{ marginTop: 6 }}>{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
