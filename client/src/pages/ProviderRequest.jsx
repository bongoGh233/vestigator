import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api";
import ChatPanel from "../components/ChatPanel";
import StatusPill from "../components/StatusPill";
import { fmtPrice, priceUnitLabel, fmtDateTime } from "../utils";

const ACTIONS = [
  { status: "ACCEPTED", action: "start", label: "Start" },
  { status: "PROVIDER_EN_ROUTE", action: "arrive", label: "Arrived" },
  { status: "ARRIVED", action: "begin", label: "Begin Service" },
  { status: "IN_PROGRESS", action: "complete", label: "Complete" },
];

function actionFor(status) {
  return ACTIONS.find((a) => a.status === status);
}

export default function ProviderRequest() {
  const { bookingId } = useParams();
  const [booking, setBooking] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [payModal, setPayModal] = useState(false);
  const [payMethod, setPayMethod] = useState("cash");
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState("");

  useEffect(() => {
    setBooking(null);
    setNotFound(false);
    api(`/api/provider/bookings/${bookingId}`)
      .then(setBooking)
      .catch(() => setNotFound(true));
  }, [bookingId]);

  if (notFound) {
    return (
      <div className="container">
        <div className="card empty">
          <h3>Booking not found</h3>
          <p><Link to="/provider">Back to dashboard</Link></p>
        </div>
      </div>
    );
  }

  if (!booking) {
    return <div className="container"><p className="sub">Loading…</p></div>;
  }

  const { status, service, customer, priceAmount, priceCurrency, pickup, destination, note, createdAt, paymentStatus } = booking;
  const customerName = customer?.name || "Customer";
  const active = !["COMPLETED", "REJECTED", "EXPIRED", "CANCELLED"].includes(status);
  const action = active ? actionFor(status) : null;
  const isPaid = paymentStatus === "PAID";

  async function doAction(a) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const b = await api(`/api/bookings/${bookingId}/${a}`, { method: "POST" });
      setBooking(b);
    } catch (err) {
      setError(err.message || "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmPayment() {
    if (payBusy) return;
    setPayError("");
    setPayBusy(true);
    try {
      const b = await api(`/api/bookings/${bookingId}/confirm-payment`, {
        method: "POST",
        body: { method: payMethod },
      });
      setBooking(b);
      setPayModal(false);
    } catch (err) {
      setPayError(err.message || "Could not confirm payment.");
    } finally {
      setPayBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 900 }}>
      <Link to="/provider" className="sub">← Back to dashboard</Link>

      <div className="row" style={{ alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
        <h1 style={{ margin: 0 }}>Booking details</h1>
        <StatusPill status={status} />
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 14 }}>
          <p className="help" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>
        </div>
      )}

      <div className="status-layout" style={{ marginTop: 18 }}>
        <div style={{ flex: "0 0 340px", display: "flex", flexDirection: "column", gap: 14 }}>
          {service && (
            <div className="card">
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>Service</h3>
              <p className="help" style={{ margin: 0 }}>
                <b>{service.title}</b><br />
                <span className="chip" style={{ marginTop: 6 }}>{service.category}</span><br />
                <span className="service-price" style={{ fontSize: 17 }}>
                  {fmtPrice(priceAmount, priceCurrency)}
                </span> · {priceUnitLabel(service.priceUnit)}
              </p>
            </div>
          )}

          <div className="card">
            <h3 style={{ fontSize: 15, marginBottom: 8 }}>Details</h3>
            <p className="help" style={{ margin: 0 }}>
              <b>Customer:</b> {customerName}<br />
              {pickup && (
                <><b>Pickup:</b> {pickup.lat.toFixed(4)}, {pickup.lng.toFixed(4)}<br /></>
              )}
              {destination && (
                <><b>Destination:</b> {destination.lat.toFixed(4)}, {destination.lng.toFixed(4)}<br /></>
              )}
              <b>Note:</b> {note || "—"}<br />
              <b>Created:</b> {fmtDateTime(createdAt)}<br />
              <b>Payment:</b>{" "}
              {isPaid ? (
                <span className="chip payment-paid">Paid</span>
              ) : (
                <span className="chip payment-unpaid">Unpaid</span>
              )}
            </p>
          </div>

          {status === "COMPLETED" && !isPaid && (
            <div className="card">
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>Payment</h3>
              <p className="help" style={{ margin: "0 0 10px" }}>
                Confirm that you received <b>{fmtPrice(priceAmount, priceCurrency)}</b> from {customerName}.
              </p>
              {!payModal ? (
                <button className="btn block" onClick={() => { setPayModal(true); setPayMethod("cash"); setPayError(""); }}>
                  Confirm Payment
                </button>
              ) : (
                <div className="payment-confirm-inline">
                  <label className="help" style={{ display: "block", marginBottom: 6 }}>Payment method</label>
                  <div className="payment-methods">
                    {["cash", "momo", "bank_transfer", "other"].map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={`payment-method-btn${payMethod === m ? " selected" : ""}`}
                        disabled={payBusy}
                        onClick={() => setPayMethod(m)}
                      >
                        {m === "cash" ? "Cash" : m === "momo" ? "Mobile Money" : m === "bank_transfer" ? "Bank Transfer" : "Other"}
                      </button>
                    ))}
                  </div>
                  {payError && (
                    <p className="help" style={{ color: "var(--danger)", margin: "8px 0 0" }}>{payError}</p>
                  )}
                  <div className="row" style={{ marginTop: 10, gap: 8 }}>
                    <button className="btn secondary" disabled={payBusy} onClick={() => setPayModal(false)}>
                      Cancel
                    </button>
                    <button className="btn" disabled={payBusy} onClick={confirmPayment}>
                      {payBusy ? "Confirming…" : "Confirm received"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {active && action && (
            <div className="card">
              <button
                className="btn block"
                disabled={busy}
                onClick={() => doAction(action.action)}
              >
                {busy ? "…" : action.label}
              </button>
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <ChatPanel
            bookingId={bookingId}
            bookingStatus={status}
            peerName={customerName}
          />
        </div>
      </div>
    </div>
  );
}
