import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selected, setSelected] = useState(null);
  const [msg, setMsg] = useState(null);
  const LIMIT = 20;

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: LIMIT, offset: page * LIMIT });
    if (search) params.set("search", search);
    if (roleFilter) params.set("role", roleFilter);
    if (statusFilter) params.set("status", statusFilter);
    try {
      const d = await api(`/api/admin/users?${params}`);
      setUsers(d.users);
      setTotal(d.total);
    } catch (e) { setMsg(e.message); }
  }, [page, search, roleFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const suspend = async (userId, status) => {
    try {
      await api(`/api/admin/users/${userId}/status`, { method: "PUT", body: { status } });
      setMsg(`User ${status === "suspended" ? "suspended" : "unsuspended"}`);
      load();
      if (selected?.id === userId) setSelected({ ...selected, status });
    } catch (e) { setMsg(e.message); }
  };

  const changeRole = async (userId, role) => {
    try {
      await api(`/api/admin/users/${userId}/role`, { method: "PUT", body: { role } });
      setMsg("Role updated");
      load();
    } catch (e) { setMsg(e.message); }
  };

  const viewDetail = async (userId) => {
    try {
      const d = await api(`/api/admin/users/${userId}`);
      setSelected(d);
    } catch (e) { setMsg(e.message); }
  };

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <h2>User Management</h2>
      {msg && <p className="sub" style={{ color: "var(--accent)" }}>{msg}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <input
          className="input"
          placeholder="Search name or email…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          style={{ flex: 1, minWidth: 180 }}
        />
        <select className="input" value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(0); }}>
          <option value="">All roles</option>
          <option value="customer">Customer</option>
          <option value="provider">Provider</option>
          <option value="both">Both</option>
          <option value="admin">Admin</option>
        </select>
        <select className="input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      <p className="sub" style={{ marginTop: 8 }}>{total} users</p>

      <div style={{ marginTop: 12 }}>
        {users.map((u) => (
          <div key={u.id} className="card" style={{ padding: "12px 16px", marginBottom: 8, cursor: "pointer" }} onClick={() => viewDetail(u.id)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <b>{u.name}</b> <span className="sub">({u.email})</span>
                <span className="sub" style={{ marginLeft: 8 }}>{u.role}</span>
                {u.status === "suspended" && <span style={{ color: "var(--danger)", marginLeft: 8, fontWeight: 600 }}>SUSPENDED</span>}
              </div>
              <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                {u.status === "active" ? (
                  <button className="btn danger" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => suspend(u.id, "suspended")}>Suspend</button>
                ) : (
                  <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => suspend(u.id, "active")}>Unsuspend</button>
                )}
              </div>
            </div>
          </div>
        ))}
        {users.length === 0 && <p className="sub">No users found.</p>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
        <button className="btn secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</button>
        <span className="sub" style={{ lineHeight: "36px" }}>Page {page + 1} of {Math.max(1, Math.ceil(total / LIMIT))}</span>
        <button className="btn secondary" disabled={(page + 1) * LIMIT >= total} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal-card" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
            <h3>{selected.name}</h3>
            <p className="sub">{selected.email} · {selected.role} · {selected.status}</p>
            {selected.profiles?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <b>Profiles:</b>
                {selected.profiles.map((p) => (
                  <div key={p.id} className="sub">· {p.name} {p.verified ? "(verified)" : ""} {p.is_active ? "" : "(inactive)"}</div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <b>Recent Bookings:</b> {selected.bookings?.length || 0}
            </div>
            <div style={{ marginTop: 8 }}>
              <b>Reviews:</b> {selected.reviews?.length || 0}
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <label className="sub">Role:</label>
              <select className="input" value={selected.role} onChange={(e) => changeRole(selected.id, e.target.value)}>
                <option value="customer">Customer</option>
                <option value="provider">Provider</option>
                <option value="both">Both</option>
              </select>
            </div>
            <button className="btn secondary" style={{ marginTop: 16 }} onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
