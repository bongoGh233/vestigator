import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { initials } from "../utils";

function TrackByCode({ onFound }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const d = await api("/api/track-by-code", { method: "POST", body: { code } });
      onFound(d);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Track with a tracking code</h3>
      <p className="sub" style={{ marginBottom: 10 }}>
        Someone gave you their code? Enter it to start tracking them.
      </p>
      <div className="copy-row">
        <input
          className="input mono"
          style={{ textTransform: "uppercase", letterSpacing: 3 }}
          placeholder="e.g. K7RM-2PXD"
          maxLength={12}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="btn secondary" disabled={busy} style={{ flex: "none" }}>
          {busy ? "…" : "Track"}
        </button>
      </div>
      {error && <p className="help" style={{ color: "var(--danger)", margin: "8px 0 0" }}>{error}</p>}
    </form>
  );
}

function ProfileCard({ profile }) {
  const isOwn = profile.isOwn;
  return (
    <div className="profile-card">
      <div className="profile-head">
        {profile.avatar ? (
          <img className="profile-avatar" src={profile.avatar} alt={profile.name} />
        ) : (
          <div className="profile-avatar">{initials(profile.name)}</div>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="pname">
            {profile.name}
            {isOwn && <span className="chip" style={{ marginLeft: 8, verticalAlign: "middle" }}>You</span>}
          </div>
          <div className="pmeta">
            {[profile.city, profile.phone].filter(Boolean).join(" · ") || "No contact info"}
          </div>
        </div>
      </div>
      {profile.bio && <p className="help" style={{ margin: 0 }}>{profile.bio}</p>}
      {profile.skills.length > 0 && (
        <div className="chips">
          {profile.skills.map((s) => (
            <span key={s} className="chip">{s}</span>
          ))}
        </div>
      )}
      {isOwn ? (
        <Link className="btn secondary block" to="/profile" style={{ marginTop: "auto" }}>
          Edit my profile
        </Link>
      ) : (
        <Link className="btn block" to={`/book/${profile.id}`} style={{ marginTop: "auto" }}>
          Book {profile.name.split(" ")[0]}
        </Link>
      )}
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState([]);
  const [own, setOwn] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      api("/api/profiles").catch(() => []),
      api("/api/profile").catch(() => null),
    ])
      .then(([profs, ownProfile]) => {
        setProfiles(profs || []);
        setOwn(ownProfile);
      })
      .finally(() => setLoaded(true));
  }, []);

  function trackByCode(d) {
    navigate(`/track/${d.id}`);
  }

  return (
    <div className="container" style={{ maxWidth: 1080 }}>
      <h1>Book someone to track</h1>
      <p className="sub">
        Like Bolt, but for people. Pick a trackable profile below or enter their
        tracking code to follow them live on the map.
      </p>

      <div className="notice" style={{ marginBottom: 18 }}>
        <b>Need a service instead?</b> Airports, errands, delivery and more from
        local providers.{" "}
        <Link to="/explore">Explore services →</Link>
      </div>

      {loaded && !own && (
        <div className="notice" style={{ marginBottom: 18 }}>
          <b>Be trackable too.</b> Create your profile so people can book you, and
          you'll get a personal tracking code that changes automatically.{" "}
          <Link to="/profile">Set up your profile →</Link>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <TrackByCode onFound={trackByCode} />
        <div className="card">
          <h3 style={{ fontSize: 15, marginBottom: 4 }}>Can't find them listed?</h3>
          <p className="sub" style={{ marginBottom: 0 }}>
            Anyone can be tracked by their current code, even if they keep their
            profile private.
          </p>
        </div>
      </div>

      <div className="section-title">
        <h2 style={{ margin: 0 }}>People you can book</h2>
        <span className="sub" style={{ margin: 0 }}>{profiles.length} available</span>
      </div>

      {profiles.length === 0 ? (
        <div className="card empty">
          <h3>No one listed yet</h3>
          <p>Be the first — <Link to="/profile">create your profile</Link> so people can see you and book you.</p>
        </div>
      ) : (
        <div className="profile-grid">
          {profiles.map((p) => (
            <ProfileCard key={p.id} profile={p} />
          ))}
        </div>
      )}
    </div>
  );
}
