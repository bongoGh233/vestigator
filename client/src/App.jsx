import { Routes, Route, NavLink, Link, Navigate } from "react-router-dom";
import { useAuth } from "./auth";
import NotificationBell from "./components/NotificationBell";
import Home from "./pages/Home";
import Explore from "./pages/Explore";
import Bookings from "./pages/Bookings";
import RequestStatus from "./pages/RequestStatus";
import ProviderDashboard from "./pages/ProviderDashboard";
import Services from "./pages/Services";
import ProviderProfile from "./pages/ProviderProfile";
import Dashboard from "./pages/Dashboard";
import Track from "./pages/Track";
import Join from "./pages/Join";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Forgot from "./pages/Forgot";
import Reset from "./pages/Reset";
import Profile from "./pages/Profile";
import BookProfile from "./pages/BookProfile";
import ProviderRequest from "./pages/ProviderRequest";
import MapView from "./pages/MapView";
import AdminRoute from "./components/AdminRoute";
import AdminLayout from "./components/AdminLayout";
import AdminDashboard from "./pages/AdminDashboard";
import AdminUsers from "./pages/AdminUsers";
import AdminProviders from "./pages/AdminProviders";
import AdminBookings from "./pages/AdminBookings";
import AdminReviews from "./pages/AdminReviews";
import AdminReports from "./pages/AdminReports";
import AdminAudit from "./pages/AdminAudit";

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="container">
        <p className="sub">Loading…</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function canProvide(user) {
  return user && (user.role === "provider" || user.role === "both");
}

function ProviderRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="container">
        <p className="sub">Loading…</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!canProvide(user)) {
    return (
      <div className="container" style={{ maxWidth: 620 }}>
        <div className="card empty">
          <h3>Provider access required</h3>
          <p>
            This screen is for providers. Switch your account role to{" "}
            <b>Provider</b> or <b>Both</b> from{" "}
            <Link to="/profile">your profile</Link> to list services and accept
            booking requests.
          </p>
        </div>
      </div>
    );
  }
  return children;
}

function Topbar() {
  const { user, logout } = useAuth();
  const provide = canProvide(user);

  const nav = [
    { to: "/", label: "Book", end: true },
    { to: "/explore", label: "Explore" },
    { to: "/bookings", label: "My Bookings" },
    ...(provide
      ? [
          { to: "/services", label: "My Services" },
          { to: "/provider", label: "Provider" },
        ]
      : []),
    { to: "/dashboard", label: "Track" },
    { to: "/profile", label: "Profile" },
    ...(user?.role === "admin" ? [{ to: "/admin", label: "Admin" }] : []),
  ];

  return (
    <header className="topbar">
      <Link to={user ? "/" : "/login"} className="brand">
        <span className="dot" />
        Bookking
      </Link>
      {user ? (
        <>
          <nav>
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <NotificationBell />
            <span className="sub" style={{ margin: 0, whiteSpace: "nowrap" }}>{user.name}</span>
            <button className="btn secondary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={logout}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <nav style={{ marginLeft: "auto" }}>
          <NavLink to="/login">Sign in</NavLink>
          <NavLink to="/register" className="active">
            Sign up
          </NavLink>
        </nav>
      )}
    </header>
  );
}

export default function App() {
  return (
    <div className="app">
      <Topbar />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset" element={<Reset />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          }
        />
        <Route
          path="/explore"
          element={
            <ProtectedRoute>
              <Explore />
            </ProtectedRoute>
          }
        />
        <Route
          path="/bookings"
          element={
            <ProtectedRoute>
              <Bookings />
            </ProtectedRoute>
          }
        />
        <Route
          path="/requests/:bookingId"
          element={
            <ProtectedRoute>
              <RequestStatus />
            </ProtectedRoute>
          }
        />
        <Route
          path="/providers/:profileId"
          element={
            <ProtectedRoute>
              <ProviderProfile />
            </ProtectedRoute>
          }
        />
        <Route
          path="/provider"
          element={
            <ProviderRoute>
              <ProviderDashboard />
            </ProviderRoute>
          }
        />
        <Route
          path="/provider/requests/:bookingId"
          element={
            <ProviderRoute>
              <ProviderRequest />
            </ProviderRoute>
          }
        />
        <Route
          path="/services"
          element={
            <ProviderRoute>
              <Services />
            </ProviderRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <Profile />
            </ProtectedRoute>
          }
        />
        <Route
          path="/book/:profileId"
          element={
            <ProtectedRoute>
              <BookProfile />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/map"
          element={
            <ProtectedRoute>
              <MapView />
            </ProtectedRoute>
          }
        />
        <Route
          path="/track/:bookingId"
          element={
            <ProtectedRoute>
              <Track />
            </ProtectedRoute>
          }
        />
        <Route path="/join/:bookingId" element={<Join />} />
        <Route
          path="/admin"
          element={
            <AdminRoute>
              <AdminLayout />
            </AdminRoute>
          }
        >
          <Route index element={<AdminDashboard />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="providers" element={<AdminProviders />} />
          <Route path="bookings" element={<AdminBookings />} />
          <Route path="reviews" element={<AdminReviews />} />
          <Route path="reports" element={<AdminReports />} />
          <Route path="audit" element={<AdminAudit />} />
        </Route>
      </Routes>
    </div>
  );
}
