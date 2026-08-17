import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function AdminProviders() {
  const [providers, setProviders] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [verifiedFilter, setVerifiedFilter] = useState("");
  const [selected, setSelected] = useState(null);
  const [msg, setMsg] = useState(null);
  const LIMIT = 20;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: LIMIT, offset: page * LIMIT });
    if (search) params.set("search", search);
    if (verifiedFilter) params.set("verified", verifiedFilter);
    try {
      const d = await api(`/api/admin/providers?${params}`);
      setProviders(d.providers);
      setTotal(d.total);
    } catch (e) { setMsg(e.message); }
  }, [page, search, verifiedFilter]);

  useEffect(() => { load(); }, [load]);

  const toggleVerified = async (profileId, val) => {
    try {
      await api(`/api/admin/providers/${profileId}/verified`, { method: "PUT", body: { verified: val } });
      setMsg(val ? "Provider verified" : "Verification removed");
      load();
      if (selected) { const d = await api(`/api/admin/providers/${selected.id}`); setSelected(d); }
    } catch (e) { setMsg(e.message); }
  };

  const toggleListed = async (profileId, val) => {
    try {
      await api(`/api/admin/providers/${profileId}/listed`, { method: "PUT", body: { listed: val } });
      load();
      if (selected) { const d = await api(`/api/admin/providers/${selected.id}`); setSelected(d); }
    } catch (e) { setMsg(e.message); }
  };

  const toggleActive = async (profileId, val) => {
    try {
      await api(`/api/admin/providers/${profileId}/active`, { method: "PUT", body: { active: val } });
      load();
      if (selected) { const d = await api(`/api/admin/providers/${selected.id}`); setSelected(d); }
    } catch (e) { setMsg(e.message); }
  };

  const viewDetail = async (userId) => {
    try { setSelected(await api(`/api/admin/providers/${userId}`)); } catch (e) { setMsg(e.message); }
  };

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <h2>Provider Management</h2>
      {msg && <p className="sub" style={{ color: "var(--accent)" }}>{msg}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <input className="input" placeholder="Search…"
          value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          style={{ flex: 1, minWidth: 180 }} />
        <select className="input" value={verifiedFilter} onChange={(e) => { setVerifiedFilter(e.target.value); setPage(0); }}>
          <option value="">All</option>
          <option value="true">Verified</option>
          <option value="false">Not verified</option>
        </select>
      </div>

      <p className="sub" style={{ marginTop: 8 }}>{total} providers</p>

      <div style={{ marginTop: 12 }}>
        {providers.map((p) => {
          const prof = p.profiles?.[0];
          return (
            <div key={p.id} className="card" style={{ padding: "12px 16px", marginBottom: 8, cursor: "pointer" }}
              onClick={() => viewDetail(p.id)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <b>{prof?.name || p.name}</b> <span className="sub">({p.email})</span>
                  {prof?.verified && <span style={{ color: "var(--accent)", marginLeft: 8 }}>✓ Verified</span>}
                  {!prof?.is_active && <span style={{ color: "var(--danger)", marginLeft: 8 }}>Inactive</span>}
                  {prof?.listed === false && <span style={{ color: "var(--warn)", marginLeft: 8 }}>Unlisted</span>}
                </div>
                <div className="sub">
                  {prof?.rating_avg != null ? `★ ${(prof.rating_avg / 100).toFixed(1)} (${prof.rating_count})` : "No ratings"}
                  {prof?.city ? ` · ${prof.city}` : ""}
                </div>
              </div>
            </div>
          );
        })}
        {providers.length === 0 && <p className="sub">No providers found.</p>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
        <button className="btn secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <span className="sub" style={{ lineHeight: "36px" }}>Page {page + 1} of {Math.max(1, Math.ceil(total / LIMIT))}</span>
        <button className="btn secondary" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal-card" style={{ maxWidth: 650, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3>{selected.name}</h3>
            <p className="sub">{selected.email}</p>

            {selected.profiles?.map((prof) => (
              <div key={prof.id} style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <b>{prof.name}</b>
                  {prof.city && <span className="sub">· {prof.city}</span>}
                  {prof.verified && <span style={{ color: "var(--accent)" }}>✓ Verified</span>}
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  <button className={`btn ${prof.verified ? "danger" : "accent"}`}
                    style={{ padding: "4px 12px", fontSize: 12 }}
                    onClick={() => toggleVerified(prof.id, !prof.verified)}>
                    {prof.verified ? "Remove Verification" : "Verify"}
                  </button>
                  <button className={`btn ${prof.listed ? "secondary" : "accent"}`}
                    style={{ padding: "4px 12px", fontSize: 12 }}
                    onClick={() => toggleListed(prof.id, !prof.listed)}>
                    {prof.listed ? "Delist" : "Relist"}
                  </button>
                  <button className={`btn ${prof.is_active ? "secondary" : "accent"}`}
                    style={{ padding: "4px 12px", fontSize: 12 }}
                    onClick={() => toggleActive(prof.id, !prof.is_active)}>
                    {prof.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>

                {prof.services?.length > 0 && (
                  <div>
                    <b style={{ fontSize: 13 }}>Services:</b>
                    {prof.services.map((s) => (
                      <div key={s.id} className="sub" style={{ fontSize: 13 }}>
                        · {s.title} ({s.category}) — GHS {(s.price_amount / 100).toFixed(2)} {s.price_unit} {s.active ? "" : "[inactive]"}
                      </div>
                    ))}
                  </div>
                )}

                {prof.reviews?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <b style={{ fontSize: 13 }}>Reviews ({prof.reviews.length}):</b>
                    {prof.reviews.slice(0, 10).map((r) => (
                      <div key={r.id} className="sub" style={{ fontSize: 13 }}>
                        · {"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)} {r.comment ? `"${r.comment}"` : "(no comment)"} {r.hidden ? "[hidden]" : ""}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            <button className="btn secondary" style={{ marginTop: 16 }} onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
