import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

export default function Forgot() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const d = await api("/api/auth/reset/request", { method: "POST", body: { email } });
      setSent(true);
      if (d.devLink) setDevLink(d.devLink);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <div className="join-hero" style={{ maxWidth: 400 }}>
        <span className="hero-badge">Bookking · password reset</span>
        <h1 style={{ margin: 0 }}>Forgot your password?</h1>
        <p className="sub">Enter your email and we'll send you a reset link. It expires in 30 minutes.</p>

        {!sent ? (
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
            {error && <p className="help" style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</p>}
            <button className="btn block" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        ) : (
          <div className="card" style={{ width: "100%", textAlign: "left" }}>
            <p className="help" style={{ marginTop: 0 }}>
              If an account exists for that email, a reset link is on its way.
              Check your inbox (and spam folder).
            </p>
            {devLink && (
              <p className="help" style={{ marginBottom: 0 }}>
                <b>No email service configured (dev mode)</b> — your reset link is:
                <br />
                <a href={devLink} className="mono">{devLink}</a>
              </p>
            )}
          </div>
        )}

        <p className="help" style={{ marginTop: 14 }}>
          Remembered it? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
