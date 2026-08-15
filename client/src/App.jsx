import { Routes, Route, NavLink, Link, Navigate } from "react-router-dom";
import { useAuth } from "./auth";
import { initials } from "./utils";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Track from "./pages/Track";
import Join from "./pages/Join";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Forgot from "./pages/Forgot";
import Reset from "./pages/Reset";
import Profile from "./pages/Profile";
import BookProfile from "./pages/BookProfile";
import MapView from "./pages/MapView";

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

function Topbar() {
  const { user, logout } = useAuth();

  return (
    <header className="topbar">
      <Link to={user ? "/" : "/login"} className="brand">
        <span className="dot" />
        Vestigator
      </Link>
      {user ? (
        <>
          <nav>
            <NavLink to="/" end>
              Book
            </NavLink>
            <NavLink to="/dashboard">Track</NavLink>
            <NavLink to="/map">Map</NavLink>
            <NavLink to="/profile">My profile</NavLink>
          </nav>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
            <span className="sub" style={{ margin: 0 }}>{user.name}</span>
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
      </Routes>
    </div>
  );
}
