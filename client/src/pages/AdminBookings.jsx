import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function AdminBookings() {
  const [bookings, setBookings] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState(null);
  const [msg, setMsg] = useState(null);
  const LIMIT = 20;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: LIMIT, offset: page * LIMIT });
    if (statusFilter) params.set("status", statusFilter);
    try {
      const d = await api(`/api/admin/bookings?${params}`);
      setBookings(d.bookings);
      setTotal(d.total);
    } catch (e) { setMsg(e.message); }
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const viewDetail = async (id) => {
    try { setSelected(await api(`/api/admin/bookings/${id}`)); } catch (e) { setMsg(e.message); }
  };

  const fmt = (ts) => ts ? new Date(ts).toLocaleDateString() : "—";
  const money = (v) => v != null ? `GHS ${(v / 100).toFixed(2)}` : "—";

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <h2>Booking Management</h2>
      {msg && <p className="sub" style={{ color: "var(--accent)" }}>{msg}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <select className="input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}>
          <option value="">All statuses</option>
          {["REQUESTED", "ACCEPTED", "REJECTED", "PROVIDER_EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "EXPIRED"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <p className="sub" style={{ marginTop: 8 }}>{total} bookings</p>

      <div style={{ marginTop: 12 }}>
        {bookings.map((b) => (
          <div key={b.id} className="card" style={{ padding: "12px 16px", marginBottom: 8, cursor: "pointer" }}
            onClick={() => viewDetail(b.id)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <b>{b.code}</b> <span className="sub">· {b.person_name}</span>
                <span style={{ marginLeft: 8, padding: "2px 8px", borderRadius: 6, fontSize: 11,
                  background: b.status === "COMPLETED" ? "var(--accent-dark)" : b.status === "CANCELLED" ? "var(--danger)" : "var(--panel-2)" }}>
                  {b.status}
                </span>
              </div>
              <div className="sub" style={{ fontSize: 13 }}>
                {b.user?.name} → {b.profile?.name || "—"} · {fmt(b.created_at)}
              </div>
            </div>
          </div>
        ))}
        {bookings.length === 0 && <p className="sub">No bookings found.</p>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
        <button className="btn secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <span className="sub" style={{ lineHeight: "36px" }}>Page {page + 1} of {Math.max(1, Math.ceil(total / LIMIT))}</span>
        <button className="btn secondary" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal-card" style={{ maxWidth: 600, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3>Booking {selected.code}</h3>
            <div className="sub" style={{ marginTop: 4 }}>
              Status: <b>{selected.status}</b> · Created: {fmt(selected.created_at)}
            </div>
            <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 14 }}>
              <div><b>Customer:</b> {selected.user?.name} ({selected.user?.email})</div>
              <div><b>Provider:</b> {selected.profile?.name || "—"}</div>
              <div><b>Service:</b> {selected.service?.title || "—"}</div>
              <div><b>Price:</b> {money(selected.price_amount)}</div>
              <div><b>Payment:</b> {selected.payment_status || "UNPAID"}</div>
              <div><b>Method:</b> {selected.payment_method || "—"}</div>
              <div><b>Platform Fee:</b> {money(selected.platform_fee)}</div>
            </div>
            <button className="btn secondary" style={{ marginTop: 16 }} onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
