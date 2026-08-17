import { NavLink, Outlet } from "react-router-dom";

const links = [
  { to: "/admin", label: "Dashboard", end: true },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/providers", label: "Providers" },
  { to: "/admin/bookings", label: "Bookings" },
  { to: "/admin/reviews", label: "Reviews" },
  { to: "/admin/reports", label: "Reports" },
  { to: "/admin/audit", label: "Audit Log" },
];

export default function AdminLayout() {
  return (
    <div style={{ display: "flex", minHeight: "calc(100vh - 56px)" }}>
      <nav style={{
        width: 180, flexShrink: 0, padding: "16px 0", borderRight: "1px solid var(--line)",
        background: "var(--panel)", display: "flex", flexDirection: "column", gap: 2,
      }}>
        <div style={{ padding: "0 16px 12px", fontSize: 12, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>
          Admin Panel
        </div>
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            style={({ isActive }) => ({
              display: "block", padding: "8px 16px", fontSize: 14, color: isActive ? "var(--accent)" : "var(--text)",
              background: isActive ? "var(--panel-2)" : "transparent", textDecoration: "none",
              borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
            })}
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
      <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>
        <Outlet />
      </div>
    </div>
  );
}
