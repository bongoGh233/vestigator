import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";

export default function Reset() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <div className="container">
        <div className="join-hero">
          <h2>Invalid reset link</h2>
          <p className="sub">This link is missing its token. Request a new one.</p>
          <Link className="btn" to="/forgot">Request a reset</Link>
        </div>
      </div>
    );
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/reset/confirm", { method: "POST", body: { token, password } });
      window.location.href = "/";
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div className="join-hero" style={{ maxWidth: 400 }}>
        <span className="hero-badge">Vestigator · password reset</span>
        <h1 style={{ margin: 0 }}>Choose a new password</h1>
        <p className="sub">Your other sessions will be signed out for security.</p>

        <form className="card" style={{ width: "100%", textAlign: "left" }} onSubmit={submit}>
          <div className="field">
            <label>New password</label>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <span className="help" style={{ marginTop: 4 }}>At least 10 characters.</span>
          </div>
          <div className="field">
            <label>Confirm new password</label>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          {error && <p className="help" style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</p>}
          <button className="btn block" disabled={busy}>
            {busy ? "Resetting…" : "Set new password"}
          </button>
        </form>
      </div>
    </div>
  );
}
