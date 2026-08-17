import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function AdminReviews() {
  const [reviews, setReviews] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [hiddenFilter, setHiddenFilter] = useState("");
  const [msg, setMsg] = useState(null);
  const LIMIT = 20;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: LIMIT, offset: page * LIMIT });
    if (hiddenFilter) params.set("hidden", hiddenFilter);
    try {
      const d = await api(`/api/admin/reviews?${params}`);
      setReviews(d.reviews);
      setTotal(d.total);
    } catch (e) { setMsg(e.message); }
  }, [page, hiddenFilter]);

  useEffect(() => { load(); }, [load]);

  const toggleHide = async (id, hidden, reason) => {
    try {
      await api(`/api/admin/reviews/${id}/hidden`, { method: "PUT", body: { hidden, hiddenReason: reason || undefined } });
      setMsg(hidden ? "Review hidden" : "Review unhidden");
      load();
    } catch (e) { setMsg(e.message); }
  };

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <h2>Review Moderation</h2>
      {msg && <p className="sub" style={{ color: "var(--accent)" }}>{msg}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <select className="input" value={hiddenFilter} onChange={(e) => { setHiddenFilter(e.target.value); setPage(0); }}>
          <option value="">All reviews</option>
          <option value="false">Visible</option>
          <option value="true">Hidden</option>
        </select>
      </div>

      <p className="sub" style={{ marginTop: 8 }}>{total} reviews</p>

      <div style={{ marginTop: 12 }}>
        {reviews.map((r) => (
          <div key={r.id} className="card" style={{ padding: "12px 16px", marginBottom: 8, opacity: r.hidden ? 0.5 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div>
                  {"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}
                  {r.hidden && <span style={{ color: "var(--danger)", marginLeft: 8, fontSize: 12 }}>HIDDEN{r.hidden_reason ? `: ${r.hidden_reason}` : ""}</span>}
                </div>
                {r.comment && <div className="sub" style={{ marginTop: 4 }}>"{r.comment}"</div>}
                <div className="sub" style={{ marginTop: 4, fontSize: 12 }}>
                  by {r.user?.name || "—"} · Provider: {r.profile?.name || "—"} · Booking: {r.booking?.code || "—"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {r.hidden ? (
                  <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }}
                    onClick={() => toggleHide(r.id, false)}>Unhide</button>
                ) : (
                  <button className="btn danger" style={{ padding: "4px 10px", fontSize: 12 }}
                    onClick={() => {
                      const reason = prompt("Reason for hiding this review (optional):");
                      toggleHide(r.id, true, reason);
                    }}>Hide</button>
                )}
              </div>
            </div>
          </div>
        ))}
        {reviews.length === 0 && <p className="sub">No reviews found.</p>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
        <button className="btn secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <span className="sub" style={{ lineHeight: "36px" }}>Page {page + 1} of {Math.max(1, Math.ceil(total / LIMIT))}</span>
        <button className="btn secondary" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}
