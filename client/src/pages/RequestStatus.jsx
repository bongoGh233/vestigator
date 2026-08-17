import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { socket } from "../socket";
import { api } from "../api";
import LiveMap from "../components/LiveMap";
import ChatPanel from "../components/ChatPanel";
import StatusPill from "../components/StatusPill";
import { fmtPrice, priceUnitLabel, fmtDateTime } from "../utils";

const CANCELLABLE = new Set(["REQUESTED", "ACCEPTED", "PROVIDER_EN_ROUTE"]);

export default function RequestStatus() {
  const { bookingId } = useParams();
  const [booking, setBooking] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewDone, setReviewDone] = useState(false);
  const [reviewError, setReviewError] = useState("");

  useEffect(() => {
    setBooking(null);
    setNotFound(false);
    api(`/api/bookings/${bookingId}`)
      .then(setBooking)
      .catch(() => setNotFound(true));

    const onUpdate = (b) => {
      if (b.id === bookingId) setBooking(b);
    };
    const onCancelled = (b) => {
      if (b.id === bookingId) setBooking(b);
    };
    socket.on("booking:update", onUpdate);
    socket.on("booking:cancelled", onCancelled);
    return () => {
      socket.off("booking:update", onUpdate);
      socket.off("booking:cancelled", onCancelled);
    };
  }, [bookingId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  if (notFound) {
    return (
      <div className="container">
        <div className="card empty">
          <h3>Booking not found</h3>
          <p>
            <Link to="/bookings">Back to my bookings</Link>
          </p>
        </div>
      </div>
    );
  }

  if (!booking) {
    return <div className="container"><p className="sub">Loading…</p></div>;
  }

  const { status, service, provider, priceAmount, priceCurrency, pickup, destination, note, createdAt, expiresAt, paymentStatus } = booking;
  const providerName = provider?.name || "your provider";
  const canCancel = CANCELLABLE.has(status);
  const active = !["COMPLETED", "REJECTED", "EXPIRED", "CANCELLED"].includes(status);
  const isPaid = paymentStatus === "PAID";

  let headline;
  let detail;
  switch (status) {
    case "REQUESTED":
      headline = `Waiting for ${providerName.split(" ")[0]} to accept your request.`;
      detail = "They'll be notified right away — you'll see it here the moment they respond.";
      break;
    case "ACCEPTED":
      headline = "Your provider accepted the request.";
      detail = "You can track them live once they start moving.";
      break;
    case "PROVIDER_EN_ROUTE":
      headline = "Your provider is on the way.";
      detail = "Follow them live on the map until they arrive.";
      break;
    case "ARRIVED":
      headline = "Your provider has arrived.";
      detail = "The service is starting now.";
      break;
    case "IN_PROGRESS":
      headline = "Service in progress.";
      detail = "Your provider is with you — this will complete when they mark it done.";
      break;
    case "COMPLETED":
      headline = "Service completed.";
      detail = "Thanks for using Bookking.";
      break;
    case "REJECTED":
      headline = "Your request was declined.";
      detail = `${providerName.split(" ")[0]} couldn't take this one. Try another provider from Explore.`;
      break;
    case "EXPIRED":
      headline = "This request expired.";
      detail = "The provider didn't respond in time. Try sending it again.";
      break;
    case "CANCELLED":
      headline = "This booking was cancelled.";
      detail = "No charge applies. You can book again any time.";
      break;
    default:
      headline = "Booking update.";
      detail = "";
  }

  const expiresSec = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : null;

  const reviewed = !!(booking.reviewed || reviewDone);
  const canReview = status === "COMPLETED" && !!booking.profileId && !reviewed;

  async function cancel() {
    if (busy) return;
    if (!confirm("Cancel this booking request?")) return;
    setBusy(true);
    try {
      const b = await api(`/api/bookings/${bookingId}/cancel`, { method: "POST" });
      setBooking(b);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitReview() {
    if (submitting || rating === 0) return;
    setSubmitting(true);
    setReviewError("");
    try {
      await api(`/api/bookings/${bookingId}/review`, {
        method: "POST",
        body: { rating, comment },
      });
      setReviewDone(true);
    } catch (err) {
      setReviewError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <Link to="/bookings" className="sub">← Back to my bookings</Link>

      <div className="row" style={{ alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
        <h1 style={{ margin: 0 }}>Request status</h1>
        <StatusPill status={status} />
      </div>
      <p className="sub" style={{ marginTop: 8 }}>
        {headline} {detail}
      </p>

      <div className="status-actions">
        {active && (
          <Link className="btn" to={`/track/${booking.id}`}>
            Track provider
          </Link>
        )}
        {canCancel && (
          <button className="btn secondary" onClick={cancel} disabled={busy}>
            {busy ? "Cancelling…" : "Cancel request"}
          </button>
        )}
        {expiresSec != null && status === "REQUESTED" && (
          <span className="help" style={{ margin: 0 }}>
            {expiresSec <= 0
              ? "Expiring any moment now…"
              : `Expires in ${Math.floor(expiresSec / 60)}m ${expiresSec % 60}s`}
          </span>
        )}
      </div>

      {status === "COMPLETED" && booking.profileId && (
        reviewed ? (
          <div className="card review-done">
            <p className="help" style={{ margin: 0 }}>
              <span className="star" style={{ fontSize: 15 }} aria-hidden="true">★</span>{" "}
              Thanks — your review has been saved.
            </p>
          </div>
        ) : (
          <div className="card review-form">
            <h3 style={{ fontSize: 15, margin: "0 0 6px" }}>How was your service?</h3>
            <p className="help" style={{ margin: "0 0 10px" }}>
              Your feedback helps other customers choose {providerName.split(" ")[0]}.
            </p>
            <div className="star-input" role="radiogroup" aria-label="Rate this provider">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={rating === n}
                  aria-label={`${n} star${n === 1 ? "" : "s"}`}
                  className={n <= rating ? "on" : ""}
                  disabled={submitting}
                  onClick={() => setRating(n)}
                >
                  ★
                </button>
              ))}
              <span className="sub" style={{ marginLeft: 8 }}>
                {rating ? `${rating} / 5` : "Tap a star to rate"}
              </span>
            </div>
            <textarea
              value={comment}
              maxLength={500}
              rows={3}
              placeholder="What went well? (optional)"
              aria-label="Review comment (optional)"
              disabled={submitting}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="review-form-foot">
              <span className="sub">{comment.length}/500</span>
              <button
                className="btn"
                disabled={submitting || rating === 0}
                onClick={submitReview}
              >
                {submitting ? "Submitting…" : "Submit review"}
              </button>
            </div>
            {reviewError && (
              <p className="help" style={{ color: "var(--danger)", margin: "10px 0 0" }}>
                {reviewError}
              </p>
            )}
          </div>
        )
      )}

      <div className="status-layout" style={{ marginTop: 18 }}>
        <div className="map-panel" style={{ minHeight: 360, height: 420 }}>
          {pickup && destination ? (
            <LiveMap pickup={pickup} drop={destination} personName={providerName} />
          ) : (
            <div className="map-empty">No pickup or destination set.</div>
          )}
        </div>

        <div className="side-panel">
          {service && (
            <div className="card">
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>Service</h3>
              <p className="help" style={{ margin: 0 }}>
                <b>{service.title}</b>
                <br />
                <span className="chip" style={{ marginTop: 6 }}>{service.category}</span>
                <br />
                <span className="service-price" style={{ fontSize: 17 }}>
                  {fmtPrice(priceAmount, priceCurrency)}
                </span>{" "}
                · {priceUnitLabel(service.priceUnit)}
              </p>
            </div>
          )}

          <div className="card">
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>Details</h3>
            <p className="help" style={{ margin: 0 }}>
              <b>Provider:</b> {providerName}
              <br />
              {pickup && (
                <>
                  <b>Pickup:</b> {pickup.lat.toFixed(4)}, {pickup.lng.toFixed(4)}
                  <br />
                </>
              )}
              {destination && (
                <>
                  <b>Destination:</b> {destination.lat.toFixed(4)}, {destination.lng.toFixed(4)}
                  <br />
                </>
              )}
              <b>Note:</b> {note || "—"}
              <br />
              <b>Created:</b> {fmtDateTime(createdAt)}
              <br />
              {status === "COMPLETED" && (
                <>
                  <b>Payment:</b>{" "}
                  {isPaid ? (
                    <span className="chip payment-paid">Paid</span>
                  ) : (
                    <span className="chip payment-unpaid">Awaiting provider confirmation</span>
                  )}
                </>
              )}
            </p>
          </div>

          <ChatPanel
            bookingId={bookingId}
            bookingStatus={status}
            peerName={providerName}
          />
        </div>
      </div>
    </div>
  );
}
