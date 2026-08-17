import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { socket } from "../socket";
import { api } from "../api";
import StatusPill from "../components/StatusPill";
import { fmtPrice, fmtDateTime } from "../utils";

const REQUESTS = new Set(["REQUESTED"]);
const ACTIVE = new Set(["ACCEPTED", "PROVIDER_EN_ROUTE", "ARRIVED", "IN_PROGRESS"]);
const DONE = new Set(["COMPLETED"]);
const PAST = new Set(["REJECTED", "EXPIRED", "CANCELLED"]);

function rowLink(b) {
  return b.profileId ? `/requests/${b.id}` : `/track/${b.id}`;
}

function rowTitle(b) {
  return b.service?.title || b.personName;
}

function rowSub(b) {
  const who = b.provider?.name || b.personName;
  const price = b.priceAmount != null ? ` · ${fmtPrice(b.priceAmount, b.priceCurrency)}` : "";
  return `${who}${price}`;
}

function BookingRow({ b, unread }) {
  return (
    <Link key={b.id} to={rowLink(b)} className="booking-item">
      <div className="avatar">
        {b.service?.title?.slice(0, 1)?.toUpperCase() || b.personName?.[0]?.toUpperCase() || "?"}
      </div>
      <div className="meta">
        <div className="name">{rowTitle(b)}</div>
        <div className="route">{rowSub(b)}</div>
      </div>
      <div className="time">{fmtDateTime(b.createdAt)}</div>
      {unread > 0 && <span className="unread-badge">{unread}</span>}
      <StatusPill status={b.status} />
    </Link>
  );
}

function Section({ title, rows, unread }) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3 style={{ margin: "22px 0 10px" }}>{title}</h3>
      <div className="booking-list">
        {rows.map((b) => (
          <BookingRow key={b.id} b={b} unread={unread?.[b.id] || 0} />
        ))}
      </div>
    </>
  );
}

export default function Bookings() {
  const [bookings, setBookings] = useState([]);
  const [unread, setUnread] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/bookings")
      .then((data) => {
        setBookings(data || []);
        return api("/api/messages/unread");
      })
      .then((u) => setUnread(u || {}))
      .catch((err) => setError(err.message || "Could not load bookings."))
      .finally(() => setLoading(false));

    socket.on("booking:created", (b) => {
      setBookings((prev) => [b, ...prev]);
    });
    socket.on("booking:update", (b) => {
      setBookings((prev) => prev.map((x) => (x.id === b.id ? b : x)));
    });
    socket.on("booking:cancelled", (b) => {
      setBookings((prev) => prev.map((x) => (x.id === b.id ? b : x)));
    });
    socket.on("message:new", ({ bookingId }) => {
      setUnread((prev) => ({ ...prev, [bookingId]: (prev[bookingId] || 0) + 1 }));
    });
    return () => {
      socket.off("booking:created");
      socket.off("booking:update");
      socket.off("booking:cancelled");
      socket.off("message:new");
    };
  }, []);

  const requests = bookings.filter((b) => REQUESTS.has(b.status));
  const active = bookings.filter((b) => ACTIVE.has(b.status));
  const done = bookings.filter((b) => DONE.has(b.status));
  const past = bookings.filter((b) => PAST.has(b.status));

  return (
    <div className="container">
      <h1>My bookings</h1>
      <p className="sub">Every service request and tracking session you've made.</p>

      {error && (
        <div className="card" style={{ marginBottom: 14 }}>
          <p className="help" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>
        </div>
      )}

      {loading && <p className="muted">Loading…</p>}

      {!loading && bookings.length === 0 && (
        <div className="card empty">
          <h3>You don't have any bookings yet</h3>
          <p>
            Find a provider offering the service you need and send a request.
          </p>
          <Link className="btn" to="/explore">Explore providers</Link>
        </div>
      )}

      {!loading && bookings.length > 0 && (
        <>
          <Section title="Waiting for a provider" rows={requests} unread={unread} />
          <Section title="Active" rows={active} unread={unread} />
          <Section title="Completed" rows={done} unread={unread} />
          <Section title="Past" rows={past} unread={unread} />
        </>
      )}
    </div>
  );
}
