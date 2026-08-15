import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api";
import MapPicker from "../components/MapPicker";
import { initials } from "../utils";

export default function BookProfile() {
  const { profileId } = useParams();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [points, setPoints] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/api/profiles/${profileId}`)
      .then(setProfile)
      .catch(() => setNotFound(true));
  }, [profileId]);

  if (notFound) {
    return (
      <div className="container">
        <div className="card empty">
          <h3>Profile not found</h3>
          <p><Link to="/">Back to home</Link></p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <div className="container"><p className="sub">Loading…</p></div>;
  }

  const ready = points.pickup && points.drop;

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const b = await api(`/api/profiles/${profile.id}/track`, {
        method: "POST",
        body: { pickup: points.pickup, destination: points.drop },
      });
      navigate(`/track/${b.id}`);
    } catch (err) {
      alert(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <Link to="/" className="sub">← Back to home</Link>
      <div className="card" style={{ margin: "12px 0 18px" }}>
        <div className="profile-head">
          {profile.avatar ? (
            <img className="profile-avatar" src={profile.avatar} alt={profile.name} />
          ) : (
            <div className="profile-avatar">{initials(profile.name)}</div>
          )}
          <div>
            <h2 style={{ margin: 0 }}>{profile.name}</h2>
            {profile.city && <span className="pmeta">{profile.city}</span>}
          </div>
        </div>
        {profile.bio && <p className="help" style={{ margin: "10px 0 0" }}>{profile.bio}</p>}
        {profile.skills.length > 0 && (
          <div className="chips" style={{ marginTop: 10 }}>
            {profile.skills.map((s) => (
              <span key={s} className="chip">{s}</span>
            ))}
          </div>
        )}
      </div>

      <form className="card" onSubmit={submit}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Set pickup &amp; destination</h3>
        <MapPicker value={points} onChange={setPoints} />
        <button className="btn block" disabled={!ready || busy} style={{ marginTop: 14 }}>
          {busy ? "Starting tracking…" : "Start tracking"}
        </button>
      </form>
    </div>
  );
}
