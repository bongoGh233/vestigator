import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" />;

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate("/");
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div className="join-hero" style={{ maxWidth: 400 }}>
        <span className="hero-badge">Bookking · sign in</span>
        <h1 style={{ margin: 0 }}>Welcome back</h1>
        <p className="sub">Sign in to book and track people.</p>

        <form className="card" style={{ width: "100%", textAlign: "left" }} onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="help" style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</p>}
          <button className="btn block" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="help" style={{ marginTop: 14 }}>
          No account? <Link to="/register">Create one</Link>
          {" · "}
          <Link to="/forgot">Forgot password?</Link>
        </p>
      </div>
    </div>
  );
}
