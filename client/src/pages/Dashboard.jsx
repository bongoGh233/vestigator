import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { socket } from "../socket";
import { api } from "../api";
import StatusPill from "../components/StatusPill";
import { fmtAgo, initials } from "../utils";

export default function Dashboard() {
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

  const LEGACY_ACTIVE = ["pending", "online", "in_transit"];
  const LEGACY_DONE = ["arrived", "cancelled"];
  const MKT_ACTIVE = ["REQUESTED", "ACCEPTED", "PROVIDER_EN_ROUTE", "ARRIVED", "IN_PROGRESS"];
  const MKT_DONE = ["COMPLETED", "REJECTED", "EXPIRED", "CANCELLED"];

  const active = bookings.filter((b) =>
    b.profileId ? MKT_ACTIVE.includes(b.status) : LEGACY_ACTIVE.includes(b.status)
  );
  const done = bookings.filter((b) =>
    b.profileId ? MKT_DONE.includes(b.status) : LEGACY_DONE.includes(b.status)
  );

  return (
    <div className="container">
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div>
          <h1 style={{ margin: 0 }}>Track bookings</h1>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            Every person you're tracking, in real time.
          </p>
        </div>
        <Link className="btn secondary" to="/map">
          View on map
        </Link>
      </div>

      {loading && <p className="muted">Loading…</p>}

      <h3 style={{ margin: "20px 0 10px" }}>Active</h3>
      <div className="booking-list">
        {active.length === 0 && (
          <div className="card empty">
            <h3>No active bookings</h3>
            <p>
              <Link to="/">Book a person to track</Link> to see their live location here.
                </p>
              </div>
            )}
            {active.map((b) => (
          <Link key={b.id} to={b.profileId ? `/requests/${b.id}` : `/track/${b.id}`} className="booking-item">
            <div className="avatar">{initials(b.service?.title || b.personName)}</div>
            <div className="meta">
              <div className="name">{b.service?.title || b.personName}</div>
              <div className="route">
                {b.pickup ? `${b.pickup.lat.toFixed(4)}, ${b.pickup.lng.toFixed(4)}` : "—"}
                {"  →  "}
                {b.destination ? `${b.destination.lat.toFixed(4)}, ${b.destination.lng.toFixed(4)}` : "—"}
              </div>
            </div>
            <div className="time">{fmtAgo(b.createdAt)}</div>
            <StatusPill status={b.status} />
          </Link>
        ))}
      </div>

      {done.length > 0 && (
        <>
          <h3 style={{ margin: "26px 0 10px" }}>Completed</h3>
          <div className="booking-list">
            {done.map((b) => (
              <Link key={b.id} to={b.profileId ? `/requests/${b.id}` : `/track/${b.id}`} className="booking-item" style={{ opacity: 0.6 }}>
                <div className="avatar">{initials(b.service?.title || b.personName)}</div>
                <div className="meta">
                  <div className="name">{b.service?.title || b.personName}</div>
                  <div className="route">
                    {b.pickup ? `${b.pickup.lat.toFixed(4)}, ${b.pickup.lng.toFixed(4)}` : "—"}
                    {"  →  "}
                    {b.destination ? `${b.destination.lat.toFixed(4)}, ${b.destination.lng.toFixed(4)}` : "—"}
                  </div>
                </div>
                <div className="time">{fmtAgo(b.createdAt)}</div>
                <StatusPill status={b.status} />
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
