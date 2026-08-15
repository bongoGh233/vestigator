import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { fmtTime } from "../utils";

const AVATAR_MAX = 250 * 1024;

export default function ProfilePage() {
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState({ name: "", phone: "", city: "", bio: "", skills: "", listed: true });
  const [avatar, setAvatar] = useState(null);
  const [code, setCode] = useState(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    api("/api/profile")
      .then((p) => {
        setProfile(p);
        setCode(p.trackCode);
        setCodeExpiresAt(p.codeExpiresAt);
        setAvatar(p.avatar);
        setForm({
          name: p.name,
          phone: p.phone || "",
          city: p.city || "",
          bio: p.bio || "",
          skills: (p.skills || []).join(", "),
          listed: p.listed,
        });
      })
      .catch(() => {});
  }, []);

  function pickAvatar(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > AVATAR_MAX) {
      setErr("Image is too large (max 250 KB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatar(reader.result);
    reader.readAsDataURL(file);
  }

  async function save(e) {
    e.preventDefault();
    setErr("");
    setMsg("");
    setSaving(true);
    try {
      const p = await api("/api/profile", {
        method: "POST",
        body: { ...form, avatar },
      });
      setProfile(p);
      setCode(p.trackCode);
      setCodeExpiresAt(p.codeExpiresAt);
      setMsg("Profile saved.");
      setTimeout(() => setMsg(""), 2500);
    } catch (err2) {
      setErr(err2.message);
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    setErr("");
    try {
      const d = await api("/api/profile/rotate-code", { method: "POST", body: {} });
      setCode(d.trackCode);
      setCodeExpiresAt(d.codeExpiresAt);
    } catch (err2) {
      setErr(err2.message);
    }
  }

  function copyCode() {
    if (!code) return;
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  const expiresMin = codeExpiresAt ? Math.max(0, Math.round((codeExpiresAt - Date.now()) / 60000)) : null;

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <Link to="/" className="sub">← Back to home</Link>
      <h1 style={{ marginTop: 10 }}>Your trackable profile</h1>
      <p className="sub">
        Like a Bolt driver profile. People can book you from this, and your
        tracking code changes automatically.
      </p>

      <div className="card" style={{ marginBottom: 18 }}>
        <h3 style={{ fontSize: 15, marginBottom: 10 }}>Your tracking code</h3>
        {code ? (
          <>
            <div className="code-box">
              <div className="code">{code.slice(0, 4)}-{code.slice(4)}</div>
              <div className="hint">
                {expiresMin != null && expiresMin <= 1
                  ? "Rotates any moment now"
                  : `Changes automatically in about ${expiresMin} min`}
                {" · share it to be tracked"}
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn block" onClick={copyCode}>
                {copied ? "Copied!" : "Copy my code"}
              </button>
              <button className="btn secondary block" onClick={rotate}>
                Get a new code now
              </button>
            </div>
            <p className="help" style={{ marginBottom: 0 }}>
              Your code is single-use — the moment someone tracks you with it, a
              new one is generated automatically.
            </p>
          </>
        ) : (
          <p className="help" style={{ marginBottom: 0 }}>Create your profile below to get your code.</p>
        )}
      </div>

      <form className="card" onSubmit={save}>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="field">
            <label>Display name</label>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label>City / area</label>
            <input
              className="input"
              placeholder="e.g. Lagos"
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
            />
          </div>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="field">
            <label>Phone (optional)</label>
            <input
              className="input"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </div>
          <div className="field">
            <label>What can you do? (comma-separated)</label>
            <input
              className="input"
              placeholder="Escort, Errands, Delivery, Medic…"
              value={form.skills}
              onChange={(e) => setForm({ ...form, skills: e.target.value })}
            />
          </div>
        </div>

        <div className="field">
          <label>Bio</label>
          <textarea
            className="input"
            rows={3}
            maxLength={500}
            placeholder="Tell people a little about yourself…"
            value={form.bio}
            onChange={(e) => setForm({ ...form, bio: e.target.value })}
          />
        </div>

        <div className="field">
          <label>Photo (optional, max 250 KB)</label>
          <div className="avatar-edit">
            {avatar ? (
              <img src={avatar} alt="avatar" />
            ) : (
              <div className="profile-avatar">—</div>
            )}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={pickAvatar} />
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={form.listed}
            onChange={(e) => setForm({ ...form, listed: e.target.checked })}
          />
          <span>List me in the directory on the home page</span>
        </label>

        {err && <p className="help" style={{ color: "var(--danger)", marginBottom: 10 }}>{err}</p>}
        {msg && <p className="help" style={{ color: "var(--accent)", marginBottom: 10 }}>{msg}</p>}

        <button className="btn block" disabled={saving || !form.name.trim()}>
          {saving ? "Saving…" : profile ? "Save profile" : "Create profile"}
        </button>
      </form>

      {code && (
        <p className="help" style={{ marginTop: 16 }}>
          Current code expires {fmtTime(codeExpiresAt)} · tracking code settings can
          be changed with <span className="mono">TRACK_CODE_TTL_MIN</span> (default 10 min).
        </p>
      )}
    </div>
  );
}
