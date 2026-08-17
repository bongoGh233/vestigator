import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function AdminAudit() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const LIMIT = 30;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: LIMIT, offset: page * LIMIT });
    if (actionFilter) params.set("action", actionFilter);
    try {
      const d = await api(`/api/admin/audit?${params}`);
      setLogs(d.logs);
      setTotal(d.total);
    } catch {}
  }, [page, actionFilter]);

  useEffect(() => { load(); }, [load]);

  const fmt = (ts) => ts ? new Date(ts).toLocaleString() : "—";

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <h2>Audit Log</h2>
      <p className="sub" style={{ marginTop: 4 }}>Append-only record of all admin actions.</p>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <select className="input" value={actionFilter} onChange={(e) => { setActionFilter(e.target.value); setPage(0); }}>
          <option value="">All actions</option>
          {["user_status", "user_role", "provider_verified", "provider_listed", "provider_active", "review_hidden", "report_status"].map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <p className="sub" style={{ marginTop: 8 }}>{total} entries</p>

      <div style={{ marginTop: 12 }}>
        {logs.map((l) => (
          <div key={l.id} className="card" style={{ padding: "10px 16px", marginBottom: 4, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span className="sub" style={{ minWidth: 140, fontSize: 12 }}>{fmt(l.created_at)}</span>
              <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, background: "var(--panel-2)", fontWeight: 600 }}>{l.action}</span>
              <span className="sub">{l.target_type} #{l.target_id}</span>
              <span className="sub" style={{ marginLeft: "auto" }}>by {l.admin?.name || "—"}</span>
              {l.meta && <span className="sub" style={{ fontSize: 11 }}>{l.meta}</span>}
            </div>
          </div>
        ))}
        {logs.length === 0 && <p className="sub">No audit entries found.</p>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
        <button className="btn secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <span className="sub" style={{ lineHeight: "36px" }}>Page {page + 1} of {Math.max(1, Math.ceil(total / LIMIT))}</span>
        <button className="btn secondary" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}
