import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { socket } from "../socket";
import { computeDistanceKm } from "../utils";

export default function Join() {
  const { bookingId } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t") || "";
  const [booking, setBooking] = useState(null);
  const [name, setName] = useState("");
  const [sharing, setSharing] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState("");
  const [distLeft, setDistLeft] = useState(null);
  const watchIdRef = useRef(null);
  const sharingRef = useRef(false);
  const nameRef = useRef("");

  useEffect(() => {
    fetch(`/api/share/${bookingId}?t=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data && data.id) {
          setBooking(data);
          setName(data.personName || "");
        } else {
          setError("This tracking link is invalid or expired.");
        }
      })
      .catch(() => setError("Could not reach the tracking server."));
  }, [bookingId, token]);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  useEffect(() => {
    const onConnect = () => {
      setReconnecting(false);
      if (sharingRef.current) {
        socket.emit(
          "person:join",
          { bookingId, token, personName: nameRef.current.trim() || booking?.personName },
          (res) => {
            if (res?.error) {
              setError(res.error);
              stopSharing();
              return;
            }
            startWatch();
            setSharing(true);
          }
        );
      }
    };
    const onDisconnect = () => {
      if (sharingRef.current) setReconnecting(true);
    };
    const onArrived = () => {
      stopSharing();
      setArrived(true);
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("person:arrived", onArrived);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("person:arrived", onArrived);
    };
  }, [bookingId, token, booking]);

  useEffect(() => {
    return () => {
      if (watchIdRef.current != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      sharingRef.current = false;
    };
  }, []);

  function updateDist(lat, lng) {
    if (booking?.destination) {
      setDistLeft(computeDistanceKm({ lat, lng }, booking.destination));
    }
  }

  function startWatch() {
    if (watchIdRef.current != null) return;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const speed = pos.coords.speed && pos.coords.speed > 0 ? Math.round(pos.coords.speed * 3.6) : 0;
        socket.emit("location:update", {
          bookingId,
          token,
          lat: latitude,
          lng: longitude,
          accuracy,
          speed,
        });
        updateDist(latitude, longitude);
      },
      (err) => {
        setError(
          err.code === 1
            ? "Location permission was denied. Allow location access and try again."
            : "Could not get your location."
        );
        stopSharing();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  function startSharing() {
    setError("");
    if (!("geolocation" in navigator)) {
      setError("Your browser does not support location sharing.");
      return;
    }
    setArrived(false);
    sharingRef.current = true;
    if (socket.disconnected) socket.connect();
    socket.emit(
      "person:join",
      { bookingId, token, personName: name.trim() || booking?.personName },
      (res) => {
        if (res?.error) {
          setError(res.error);
          sharingRef.current = false;
          setSharing(false);
          return;
        }
        startWatch();
        setSharing(true);
      }
    );
  }

  function stopSharing() {
    sharingRef.current = false;
    if (watchIdRef.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    setSharing(false);
  }

  function markArrived() {
    stopSharing();
    setArrived(true);
    socket.emit("arrival:update", { bookingId, token });
  }

  if (error && !booking) {
    return (
      <div className="container">
        <div className="join-hero">
          <h2>Tracking link</h2>
          <p className="sub">{error}</p>
          <Link className="btn" to="/">Go to Vestigator</Link>
        </div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="container">
        <div className="join-hero">
          <p className="sub">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="join-hero">
        <span className="hero-badge">Vestigator tracking</span>

        {arrived ? (
          <>
            <div className="radar done">
              <div className="inner" />
            </div>
            <h2>You've arrived</h2>
            <p className="sub">
              <b>{booking.personName}</b> has been notified. Sharing has stopped.
            </p>
          </>
        ) : sharing ? (
          <>
            <div className="radar live">
              <div className="inner" />
            </div>
            <h2>Sharing your location</h2>
            <p className="sub">
              <b>{name || booking.personName}</b>, your position is being shared live.
              {booking.destination && distLeft != null && (
                <>
                  <br />
                  About <b>{distLeft.toFixed(1)} km</b> from your destination.
                </>
              )}
            </p>
            {reconnecting && (
              <div className="status-banner stale" style={{ maxWidth: 360 }}>
                Connection lost — reconnecting…
              </div>
            )}
            <div className="row">
              <button className="btn secondary" onClick={markArrived}>
                I've arrived
              </button>
              <button className="btn secondary" onClick={stopSharing}>
                Stop sharing
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="radar">
              <div className="inner" />
            </div>
            <h2>Hi{name ? `, ${name}` : ""}</h2>
            <p className="sub">
              <b>{booking.personName || "Someone"}</b> wants to know where you are.
              Tap below to share your live location until you reach your destination.
            </p>
            <input
              className="input"
              style={{ textAlign: "center", maxWidth: 260 }}
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn" onClick={startSharing} style={{ marginTop: 8 }}>
              Start sharing location
            </button>
            {error && <p className="help" style={{ color: "var(--danger)" }}>{error}</p>}
            <p className="help">
              You're only sharing while this page is open. You can stop any time.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
