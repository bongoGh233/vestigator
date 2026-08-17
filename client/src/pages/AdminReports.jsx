import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

const STATUS_COLORS = { OPEN: "var(--warn)", REVIEWED: "var(--info)", RESOLVED: "var(--accent)", DISMISSED: "var(--muted)" };

export default function AdminReports() {
  const [reports, setReports] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [msg, setMsg] = useState(null);
  const LIMIT = 20;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: LIMIT, offset: page * LIMIT });
    if (statusFilter) params.set("status", statusFilter);
    try {
      const d = await api(`/api/admin/reports?${params}`);
      setReports(d.reports);
      setTotal(d.total);
    } catch (e) { setMsg(e.message); }
  }, [page, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const updateStatus = async (id, status) => {
    try {
      await api(`/api/admin/reports/${id}/status`, { method: "PUT", body: { status } });
      setMsg(`Report marked as ${status}`);
      load();
    } catch (e) { setMsg(e.message); }
  };

  const fmt = (ts) => ts ? new Date(ts).toLocaleDateString() : "—";

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <h2>Report Management</h2>
      {msg && <p className="sub" style={{ color: "var(--accent)" }}>{msg}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <select className="input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}>
          <option value="">All statuses</option>
          {["OPEN", "REVIEWED", "RESOLVED", "DISMISSED"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <p className="sub" style={{ marginTop: 8 }}>{total} reports</p>

      <div style={{ marginTop: 12 }}>
        {reports.map((r) => (
          <div key={r.id} className="card" style={{ padding: "14px 16px", marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, background: STATUS_COLORS[r.status] || "var(--panel-2)" }}>
                    {r.status}
                  </span>
                  <b>{r.target_type}</b>
                  <span className="sub">#{r.target_id}</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 14 }}>{r.reason}</div>
                <div className="sub" style={{ marginTop: 4, fontSize: 12 }}>
                  Reporter: {r.reporter?.name || "—"} · {fmt(r.created_at)}
                  {r.reviewer && ` · Reviewed by ${r.reviewer.name}`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {["REVIEWED", "RESOLVED", "DISMISSED"].map((s) => (
                  <button key={s} className="btn secondary" style={{ padding: "4px 8px", fontSize: 11 }}
                    disabled={r.status === s} onClick={() => updateStatus(r.id, s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
        {reports.length === 0 && <p className="sub">No reports found.</p>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
        <button className="btn secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <span className="sub" style={{ lineHeight: "36px" }}>Page {page + 1} of {Math.max(1, Math.ceil(total / LIMIT))}</span>
        <button className="btn secondary" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}
