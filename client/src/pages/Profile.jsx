import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { fmtTime, DOW_NAMES, minToTimeInput, timeInputToMin } from "../utils";

const AVATAR_MAX = 250 * 1024;

const TIMEZONE_SUGGESTIONS = [
  "UTC", "Africa/Accra", "Africa/Lagos", "Africa/Nairobi", "Africa/Casablanca",
  "Africa/Johannesburg", "Africa/Cairo", "Europe/London", "Europe/Lisbon",
  "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Shanghai", "Australia/Sydney",
];

function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

const DAYS_EMPTY = () =>
  DOW_NAMES.map((label, dow) => ({ dow, label, enabled: false, windows: [], key: 0 }));

let windowKey = 1;

function AvailabilityEditor() {
  const [days, setDays] = useState(() => DAYS_EMPTY());
  const [tz, setTz] = useState(() => browserTimezone());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    try {
      const d = await api("/api/profile/availability");
      setTz(d.timezone || browserTimezone());
      const next = DAYS_EMPTY();
      for (const row of d.availability || []) {
        const day = next[row.dow];
        day.windows.push({
          start: minToTimeInput(row.startMin),
          end: minToTimeInput(row.endMin),
          key: row.id ?? windowKey++,
        });
        if (row.active) day.enabled = true;
      }
      setDays(next);
      setErr("");
    } catch (e) {
      setErr(e.message || "Could not load your availability.");
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addWindow(dow) {
    setDays((ds) => ds.map((d) => (d.dow === dow
      ? { ...d, windows: [...d.windows, { start: "09:00", end: "17:00", key: windowKey++ }] }
      : d)));
  }

  function removeWindow(dow, key) {
    setDays((ds) => ds.map((d) => (d.dow === dow
      ? { ...d, windows: d.windows.filter((w) => w.key !== key) }
      : d)));
  }

  function setWindow(dow, key, field, value) {
    setDays((ds) => ds.map((d) => (d.dow === dow
      ? { ...d, windows: d.windows.map((w) => (w.key === key ? { ...w, [field]: value } : w)) }
      : d)));
  }

  function setDayEnabled(dow, enabled) {
    setDays((ds) => ds.map((d) => (d.dow === dow ? { ...d, enabled } : d)));
  }

  function validate() {
    for (const day of days) {
      const mins = day.windows.map((w) => ({ w, start: timeInputToMin(w.start), end: timeInputToMin(w.end) }));
      for (const { w, start, end } of mins) {
        if (start == null || end == null) return `Enter valid start and end times for ${day.label}.`;
        if (end <= start) return `End must be after start on ${day.label}.`;
      }
      if (!day.enabled) continue;
      const active = mins.sort((a, b) => a.start - b.start);
      for (let i = 1; i < active.length; i++) {
        if (active[i].start < active[i - 1].end) {
          return `Windows on ${day.label} cannot overlap.`;
        }
      }
    }
    return "";
  }

  async function save(e) {
    e.preventDefault();
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }
    setErr("");
    setMsg("");
    setSaving(true);
    const availability = [];
    for (const day of days) {
      for (const w of day.windows) {
        availability.push({
          dow: day.dow,
          startMin: timeInputToMin(w.start),
          endMin: timeInputToMin(w.end),
          active: day.enabled,
        });
      }
    }
    try {
      await api("/api/profile/availability", {
        method: "PUT",
        body: { timezone: tz.trim() || null, availability },
      });
      setMsg("Availability saved.");
      setTimeout(() => setMsg(""), 2500);
    } catch (e2) {
      setErr(e2.message || "Could not save your availability.");
    } finally {
      setSaving(false);
    }
  }

  const anySet = days.some((d) => d.windows.length > 0);

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Weekly availability</h3>
      <p className="help" style={{ marginTop: 0 }}>
        The hours you take requests. Customers see “Available now” only while
        you're inside an active window. Leave everything empty to show no
        availability at all.
      </p>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form onSubmit={save}>
          <div className="field">
            <label htmlFor="avail-tz">Your timezone</label>
            <input
              id="avail-tz"
              className="input"
              list="avail-tz-list"
              maxLength={64}
              placeholder="e.g. Africa/Lagos"
              value={tz}
              onChange={(e) => setTz(e.target.value)}
            />
            <datalist id="avail-tz-list">
              {TIMEZONE_SUGGESTIONS.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>

          <div className="avail-days" style={{ marginTop: 6 }}>
            {days.map((day) => (
              <div key={day.dow} className={`avail-day${day.enabled ? "" : " off"}`}>
                <label className="avail-day-head">
                  <input
                    type="checkbox"
                    checked={day.enabled}
                    onChange={(e) => setDayEnabled(day.dow, e.target.checked)}
                  />
                  <b>{day.label}</b>
                </label>
                <div className="avail-windows">
                  {day.windows.map((w) => (
                    <div key={w.key} className="avail-window">
                      <input
                        className="input"
                        type="time"
                        value={w.start}
                        onChange={(e) => setWindow(day.dow, w.key, "start", e.target.value)}
                        disabled={!day.enabled}
                      />
                      <span>to</span>
                      <input
                        className="input"
                        type="time"
                        value={w.end}
                        onChange={(e) => setWindow(day.dow, w.key, "end", e.target.value)}
                        disabled={!day.enabled}
                      />
                      <button
                        type="button"
                        className="btn secondary danger"
                        style={{ padding: "8px 12px", fontSize: 13 }}
                        onClick={() => removeWindow(day.dow, w.key)}
                        disabled={!day.enabled}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ padding: "8px 14px", fontSize: 13 }}
                    onClick={() => addWindow(day.dow)}
                    disabled={!day.enabled}
                  >
                    + Add hours
                  </button>
                </div>
              </div>
            ))}
          </div>

          {err && <p className="help" style={{ color: "var(--danger)", margin: "10px 0 0" }}>{err}</p>}
          {msg && <p className="help" style={{ color: "var(--accent)", margin: "10px 0 0" }}>{msg}</p>}

          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" disabled={saving}>
              {saving ? "Saving…" : "Save availability"}
            </button>
            {anySet && (
              <span className="help" style={{ margin: "0 0 0 12px" }}>
                Overnight shifts: split into two rows (e.g. “Mon 10:00 pm – 12:00 am”
                and “Tue 12:00 am – 2:00 am”).
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

const ROLE_OPTIONS = [
  { value: "customer", label: "Customer" },
  { value: "provider", label: "Provider" },
  { value: "both", label: "Both" },
];

function RoleSwitcher() {
  const { user, updateUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function setRole(role) {
    if (busy || role === user.role) return;
    setErr("");
    setBusy(true);
    try {
      const d = await api("/api/role", { method: "POST", body: { role } });
      updateUser(d.user);
    } catch (err2) {
      setErr(err2.message || "Could not update your role.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Marketplace role</h3>
      <p className="help" style={{ marginTop: 0 }}>
        Customers request services. Providers list services and accept requests.
        Choose <b>Both</b> to do either.
      </p>
      <div className="segmented" role="group" aria-label="Marketplace role">
        {ROLE_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={user.role === o.value ? "active" : ""}
            disabled={busy}
            onClick={() => setRole(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {err && <p className="help" style={{ color: "var(--danger)", margin: "10px 0 0" }}>{err}</p>}
    </div>
  );
}

export default function ProfilePage() {
  const { user } = useAuth();
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

      <RoleSwitcher />

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

      {user.role === "provider" || user.role === "both" ? <AvailabilityEditor /> : null}

      {code && (
        <p className="help" style={{ marginTop: 16 }}>
          Current code expires {fmtTime(codeExpiresAt)} · tracking code settings can
          be changed with <span className="mono">TRACK_CODE_TTL_MIN</span> (default 10 min).
        </p>
      )}
    </div>
  );
}
