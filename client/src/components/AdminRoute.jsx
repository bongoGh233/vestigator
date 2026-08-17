import { Navigate } from "react-router-dom";
import { useAuth } from "../auth";

export default function AdminRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="container"><p className="sub">Loading…</p></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") {
    return (
      <div className="container" style={{ maxWidth: 620 }}>
        <div className="card empty">
          <h3>Admin access required</h3>
          <p>You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }
  return children;
}
