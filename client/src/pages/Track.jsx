import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { socket } from "../socket";
import { api } from "../api";
import { fetchRoute } from "../routing";
import LiveMap from "../components/LiveMap";
import MapPicker from "../components/MapPicker";
import StatusPill from "../components/StatusPill";
import { fmtTime, computeDistanceKm, computeEtaKm } from "../utils";

const STALE_AFTER_MS = 90 * 1000;

export default function Track() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const [booking, setBooking] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [plannedRoute, setPlannedRoute] = useState(null);
  const [liveRoute, setLiveRoute] = useState(null);
  const [points, setPoints] = useState({});
  const [savingPoints, setSavingPoints] = useState(false);
  const joinedRef = useRef(false);
  const routeRef = useRef({ origin: null, at: 0 });

  const origin = window.location.origin;
  const trackingLink = `${origin}/join/${bookingId}?t=${booking?.shareToken || ""}`;

  useEffect(() => {
    setBooking(null);
    setNotFound(false);
    joinedRef.current = false;

    api(`/api/bookings/${bookingId}`)
      .then((data) => {
        setBooking(data);
        if (!joinedRef.current) {
          socket.emit("watch:join", { bookingId });
          joinedRef.current = true;
        }
      })
      .catch(() => {
        setNotFound(true);
      });

    const onUpdate = (b) => {
      if (b.id === bookingId) setBooking(b);
    };
    socket.on("booking:update", onUpdate);
    return () => {
      socket.off("booking:update", onUpdate);
      socket.emit("watch:leave", { bookingId });
    };
  }, [bookingId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!booking?.pickup || !booking?.destination) return;
    fetchRoute(booking.pickup, booking.destination).then(setPlannedRoute);
  }, [booking?.id]);

  useEffect(() => {
    if (!booking?.location || !booking?.destination) return;
    const from = { lat: booking.location.lat, lng: booking.location.lng };
    const prev = routeRef.current;
    const moved = prev.origin ? computeDistanceKm(prev.origin, from) : Infinity;
    const elapsed = Date.now() - prev.at;
    if (moved < 0.12 && elapsed < 30000) return;
    fetchRoute(from, booking.destination).then((r) => {
      routeRef.current = { origin: from, at: Date.now() };
      if (r) setLiveRoute(r);
    });
  }, [booking?.location?.lat, booking?.location?.lng]);

  if (notFound) {
    return (
      <div className="container">
        <div className="card empty">
          <h3>Booking not found</h3>
          <p>
            <Link to="/dashboard">Back to dashboard</Link>
          </p>
        </div>
      </div>
    );
  }

  if (!booking) {
    return <div className="container"><p className="sub">Loading booking…</p></div>;
  }

  const { personName, pickup, destination, location, path, status } = booking;
  const missingPoints = !pickup || !destination;
  const roadDistKm = liveRoute?.distanceKm ?? null;
  const distKm = roadDistKm ?? computeDistanceKm(location, destination);
  const etaH = computeEtaKm(distKm, location?.speed);
  const lastUpdateMs = location?.t || null;
  const staleMs = lastUpdateMs ? now - lastUpdateMs : null;
  const isStale = staleMs != null && staleMs > STALE_AFTER_MS;
  const isOffline = !booking.personOnline && ["online", "in_transit"].includes(status);
  let etaMin = null;
  if (liveRoute) {
    const profileSpeed = liveRoute.durationSec > 0 ? liveRoute.distanceKm / (liveRoute.durationSec / 3600) : 30;
    const liveSpeed = location?.speed;
    if (liveSpeed && liveSpeed >= 3 && profileSpeed > 0) {
      const ratio = profileSpeed / liveSpeed;
      const clamped = Math.max(0.35, Math.min(3.5, ratio));
      etaMin = Math.max(1, Math.round((liveRoute.durationSec / 60) * clamped));
    } else {
      etaMin = Math.max(1, Math.round(liveRoute.durationSec / 60));
    }
  } else if (etaH != null) {
    etaMin = Math.round(etaH * 60);
  } else if (plannedRoute && !location) {
    etaMin = Math.max(1, Math.round(plannedRoute.durationSec / 60));
  }
  const chip = liveRoute && etaMin != null ? `${distKm.toFixed(1)} km · ETA ${etaMin} min` : null;

  function copyLink() {
    navigator.clipboard?.writeText(trackingLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  async function savePoints() {
    if (savingPoints) return;
    if (!points.pickup || !points.drop) return;
    setSavingPoints(true);
    try {
      const updated = await api(`/api/bookings/${bookingId}/points`, {
        method: "POST",
        body: { pickup: points.pickup, destination: points.drop },
      });
      setBooking(updated);
      setPoints({});
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingPoints(false);
    }
  }

  function cancelBooking() {
    if (confirm("Cancel this booking?")) {
      socket.emit("booking:cancel", { bookingId });
      navigate("/dashboard");
    }
  }

  return (
    <div className="container" style={{ maxWidth: 1400 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{personName}</h1>
        <StatusPill status={status} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn secondary" onClick={() => setFollow((f) => !f)}>
            {follow ? "Following" : "Follow off"}
          </button>
          <button className="btn secondary" onClick={cancelBooking}>
            Cancel
          </button>
          <Link className="btn secondary" to="/dashboard">
            All bookings
          </Link>
        </div>
      </div>

      <div className="track-layout">
        <div className="map-panel">
          <LiveMap
            pickup={pickup}
            drop={destination}
            location={location}
            path={path}
            personName={personName}
            follow={follow}
            route={liveRoute}
            plannedRoute={plannedRoute}
            chip={chip}
          />
          {location && (
            <div className={`map-hint${isStale ? " stale" : ""}`} style={{ bottom: "auto", top: 12 }}>
              {isStale ? "Stale location" : `Updated ${fmtTime(location.t)}`}
            </div>
          )}
        </div>

        <div className="side-panel">
          <div className="card">
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Tracking link</h3>
            <div className="copy-row">
              <input className="input mono" readOnly value={trackingLink} />
              <button className="btn secondary" style={{ flex: "none" }} onClick={copyLink}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="help" style={{ margin: "10px 0 0" }}>
              Send this to the person. They open it on their phone and tap{" "}
              <b>Start sharing location</b>. That's it.
            </p>
          </div>

          {missingPoints && (
            <div className="card">
              <h3 style={{ fontSize: 15, marginBottom: 12 }}>Set pickup &amp; destination</h3>
              <p className="help" style={{ marginTop: 0 }}>
                The person will still appear live on the map once they're online.
                Add pickup and destination to get ETA and the driving route.
              </p>
              <MapPicker value={points} onChange={setPoints} height={260} />
              <button
                className="btn block"
                disabled={!points.pickup || !points.drop || savingPoints}
                style={{ marginTop: 14 }}
                onClick={savePoints}
              >
                {savingPoints ? "Saving…" : "Save pickup & destination"}
              </button>
            </div>
          )}

          <div className="card">
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Live status</h3>
            {(isOffline || isStale) && (
              <div className={`status-banner stale${isOffline ? " offline" : ""}`} style={{ marginBottom: 10 }}>
                {isOffline
                  ? `${personName} went offline`
                  : `No location update in ${Math.max(1, Math.round(staleMs / 60000))} min`}
              </div>
            )}
            <div className={`status-banner ${status}`}>
              {status === "arrived"
                ? "Arrived at destination"
                : status === "cancelled"
                  ? "Booking cancelled"
                  : isOffline
                    ? "Person is offline — location paused"
                    : location
                      ? "On the move — location live"
                      : "Connected — waiting for the person to share location"}
            </div>
            {etaMin != null && status !== "arrived" && (
              <div className="eta-hero">
                <div className="eta-value">
                  {etaMin < 1 ? "<1" : etaMin}
                  <span className="eta-unit">min</span>
                </div>
                <div className="eta-label">
                  to reach <b>their destination</b>
                </div>
              </div>
            )}
            <div className="stat-row" style={{ marginTop: 12 }}>
              <div className="stat">
                <div className="label">Distance left</div>
                <div className="value">{distKm != null ? `${distKm.toFixed(1)} km` : "—"}</div>
              </div>
              <div className="stat">
                <div className="label">Speed</div>
                <div className="value">{location?.speed ? `${Math.round(location.speed)} km/h` : "—"}</div>
              </div>
              <div className="stat">
                <div className="label">ETA</div>
                <div className="value">{etaMin != null ? `${etaMin} min` : "—"}</div>
              </div>
            </div>
          </div>

          {!missingPoints && (
            <div className="card">
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>Details</h3>
            <p className="help" style={{ margin: 0 }}>
              <b>Phone:</b> {booking.phone || "—"}
              <br />
              <b>Note:</b> {booking.note || "—"}
              <br />
              <b>Created:</b> {fmtTime(booking.createdAt)}
              <br />
              <b>Code:</b> <span className="mono">{booking.code}</span>
            </p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
