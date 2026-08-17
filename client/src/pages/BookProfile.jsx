import { useEffect, useState } from "react";
import { useParams, useNavigate, Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import MapPicker from "../components/MapPicker";
import { initials, fmtPrice, priceUnitLabel, fmtDuration } from "../utils";

export default function BookProfile() {
  const { profileId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [profile, setProfile] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [serviceId, setServiceId] = useState(null);
  const [points, setPoints] = useState({});
  const [note, setNote] = useState("");
  const [personName, setPersonName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/profiles/${profileId}`)
      .then((p) => {
        setProfile(p);
        setPersonName(p.name);
        const req = Number(searchParams.get("service"));
        if (req && p.services.some((s) => s.id === req)) {
          setServiceId(req);
        }
      })
      .catch(() => setNotFound(true));
  }, [profileId, searchParams]);

  if (notFound) {
    return (
      <div className="container">
        <div className="card empty">
          <h3>Profile not found</h3>
          <p><Link to="/explore">Back to explore</Link></p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <div className="container"><p className="sub">Loading…</p></div>;
  }

  const services = profile.services || [];
  const selected = services.find((s) => s.id === serviceId) || null;
  const marketplace = selected != null;
  const ready = points.pickup && points.drop;
  const unavailable = profile.availability?.configured && !profile.availability?.availableNow;

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setError("");
    setBusy(true);
    try {
      if (marketplace) {
        const b = await api("/api/bookings", {
          method: "POST",
          body: {
            personName,
            note,
            pickup: points.pickup,
            destination: points.drop,
            profileId: profile.id,
            serviceId: selected.id,
          },
        });
        navigate(`/requests/${b.id}`);
      } else {
        const b = await api(`/api/profiles/${profile.id}/track`, {
          method: "POST",
          body: { pickup: points.pickup, destination: points.drop },
        });
        navigate(`/track/${b.id}`);
      }
    } catch (err) {
      setError(err.message || "Could not send your request.");
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 760 }}>
      <Link to={`/providers/${profile.id}`} className="sub">← Back to provider</Link>
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
      </div>

      <form className="card" onSubmit={submit}>
        {unavailable && (
          <p className="help" style={{ marginTop: 0, color: "var(--danger)" }}>
            {profile.name.split(" ")[0]} isn't available right now. Requests are
            accepted only during their listed availability hours.
          </p>
        )}
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>Choose a service</h3>
        {services.length === 0 ? (
          <p className="help" style={{ marginTop: 0 }}>
            This provider hasn't listed any services yet, so your request will
            be a plain live-tracking booking instead.
          </p>
        ) : (
          <div className="service-options">
            {services.map((s) => {
              const active = s.id === serviceId;
              return (
                <label
                  key={s.id}
                  className={`service-option${active ? " selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="service"
                    checked={active}
                    onChange={() => setServiceId(s.id)}
                  />
                  <span className="meta" style={{ flex: 1, minWidth: 0 }}>
                    <span className="name">{s.title}</span>
                    {s.description && (
                      <span className="help" style={{ display: "block", margin: "2px 0 4px" }}>
                        {s.description}
                      </span>
                    )}
                    <span className="chips">
                      <span className="chip">{s.category}</span>
                      {fmtDuration(s.durationMin) && <span className="chip">{fmtDuration(s.durationMin)}</span>}
                    </span>
                  </span>
                  <span style={{ textAlign: "right", flex: "none" }}>
                    <span className="service-price">{fmtPrice(s.priceAmount, s.priceCurrency)}</span>
                    <span className="service-unit" style={{ display: "block" }}>{priceUnitLabel(s.priceUnit)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {selected && (
          <p className="help" style={{ margin: "8px 0 0", color: "var(--accent)" }}>
            <b>{fmtPrice(selected.priceAmount, selected.priceCurrency)} · {priceUnitLabel(selected.priceUnit)}</b>
            {" "}— the final price is set by the provider.
          </p>
        )}

        <div className="grid book-form-grid" style={{ marginTop: 16 }}>
          <div className="field">
            <label htmlFor="personName">Provider name (shown on the tracking link)</label>
            <input
              id="personName"
              className="input"
              value={personName}
              onChange={(e) => setPersonName(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="note">Note for the provider (optional)</label>
            <input
              id="note"
              className="input"
              placeholder="e.g. 2 bags, apartment 3B…"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <h3 style={{ fontSize: 15, margin: "4px 0 12px" }}>Pickup &amp; destination</h3>
        <MapPicker value={points} onChange={setPoints} />

        {error && <p className="help" style={{ color: "var(--danger)", margin: "10px 0 0" }}>{error}</p>}

        <button className="btn block" disabled={!ready || busy || unavailable} style={{ marginTop: 14 }}>
          {busy
            ? "Sending…"
            : marketplace
              ? `Request ${selected.title}`
              : "Start tracking"}
        </button>
        {marketplace && (
          <p className="help" style={{ margin: "10px 0 0" }}>
            Your request goes to {profile.name.split(" ")[0]}, who can accept or
            decline it. Tracking starts only after they accept and tap{" "}
            <b>Start</b>.
          </p>
        )}
      </form>
    </div>
  );
}
