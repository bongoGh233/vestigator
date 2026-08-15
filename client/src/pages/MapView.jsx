import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { socket } from "../socket";
import { api } from "../api";
import BookingsMap from "../components/BookingsMap";

export default function MapView() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/bookings")
      .then((data) => setBookings(data || []))
      .catch(() => {})
      .finally(() => setLoading(false));

    socket.on("booking:created", (b) => {
      setBookings((prev) => [b, ...prev]);
    });
    socket.on("booking:update", (b) => {
      setBookings((prev) => prev.map((x) => (x.id === b.id ? b : x)));
    });
    return () => {
      socket.off("booking:created");
      socket.off("booking:update");
    };
  }, []);

  const active = bookings.filter((b) => !["cancelled", "arrived"].includes(b.status));

  return (
    <div className="container" style={{ maxWidth: 1400 }}>
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>Map</h1>
        <Link className="btn secondary" to="/dashboard">
          Back to list
        </Link>
      </div>
      <p className="sub">Live location of everyone you're tracking, in real time.</p>

      {loading && <p className="muted">Loading…</p>}

      {!loading && active.length === 0 && (
        <div className="card empty">
          <h3>No active bookings</h3>
          <p>
            <Link to="/">Book a person to track</Link> to see their live location on the map.
          </p>
        </div>
      )}

      {!loading && active.length > 0 && (
        <>
          <BookingsMap bookings={active} height={600} />
          <div className="legend row" style={{ marginTop: 10 }}>
            <span><i className="dot pickup" />Pickup</span>
            <span><i className="dot drop" />Destination</span>
            <span><i className="dot live" />Live location</span>
            <span className="sub" style={{ margin: 0 }}>Tap a marker to open that booking.</span>
          </div>
        </>
      )}
    </div>
  );
}
