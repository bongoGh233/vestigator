import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import StatusPill from "../components/StatusPill";
import { fmtPrice, priceUnitLabel, fmtDateTime } from "../utils";

const POLL_MS = 15000;

const ACTIVE_ACTIONS = [
  { status: "ACCEPTED", action: "start", label: "Start" },
  { status: "PROVIDER_EN_ROUTE", action: "arrive", label: "Arrived" },
  { status: "ARRIVED", action: "begin", label: "Begin Service" },
  { status: "IN_PROGRESS", action: "complete", label: "Complete" },
];

function actionFor(status) {
  return ACTIVE_ACTIONS.find((a) => a.status === status);
}

function RequestCard({ b, onAction, busyId }) {
  const service = b.service;
  return (
    <div className="card job-card">
      <div className="job-top">
        <div className="meta" style={{ flex: 1, minWidth: 0 }}>
          <div className="name">
            {service?.title || "Service request"}
          </div>
          <div className="pmeta">
            Requested by <b>{b.customer?.name || "someone"}</b>
          </div>
        </div>
        <StatusPill status={b.status} />
      </div>

      {service?.description && (
        <p className="help" style={{ margin: "8px 0 0" }}>{service.description}</p>
      )}

      <div className="job-meta">
        <div className="stat">
          <div className="label">Service</div>
          <div className="value">{service?.title || "—"}</div>
        </div>
        <div className="stat">
          <div className="label">Price</div>
          <div className="value">
            {fmtPrice(b.priceAmount, b.priceCurrency)}
            {service?.priceUnit && <span className="job-unit"> · {priceUnitLabel(service.priceUnit)}</span>}
          </div>
        </div>
        <div className="stat">
          <div className="label">Pickup</div>
          <div className="value small">{b.pickup ? `${b.pickup.lat.toFixed(4)}, ${b.pickup.lng.toFixed(4)}` : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">Destination</div>
          <div className="value small">{b.destination ? `${b.destination.lat.toFixed(4)}, ${b.destination.lng.toFixed(4)}` : "—"}</div>
        </div>
      </div>

      {b.note && (
        <p className="help" style={{ margin: "10px 0 0" }}>
          <b>Note:</b> {b.note}
        </p>
      )}

      <div className="job-footer">
        <span className="pmeta">
          Requested {fmtDateTime(b.createdAt)}
          {b.expiresAt && (
            <>
              {" · expires "}
              {fmtDateTime(b.expiresAt)}
            </>
          )}
        </span>
        <div className="row" style={{ marginLeft: "auto" }}>
          <Link
            className="btn secondary"
            style={{ padding: "10px 18px", fontSize: 14 }}
            to={`/provider/requests/${b.id}`}
          >
            Details
          </Link>
          <button
            className="btn"
            style={{ padding: "10px 20px", fontSize: 14 }}
            disabled={busyId != null}
            onClick={() => onAction(b, "accept")}
          >
            {busyId === b.id ? "…" : "Accept"}
          </button>
          <button
            className="btn secondary"
            style={{ padding: "10px 20px", fontSize: 14 }}
            disabled={busyId != null}
            onClick={() => onAction(b, "reject")}
          >
            {busyId === b.id ? "…" : "Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActiveCard({ b, onAction, onCancel, busyId }) {
  const action = actionFor(b.status);
  const shareUrl = b.trackingLink || null;
  return (
    <div className="card job-card">
      <div className="job-top">
        <div className="meta" style={{ flex: 1, minWidth: 0 }}>
          <div className="name">{b.service?.title || b.personName}</div>
          <div className="pmeta">
            {b.customer?.name ? `For ${b.customer.name}` : "—"}
            {b.pickup ? ` · ${b.pickup.lat.toFixed(4)}, ${b.pickup.lng.toFixed(4)}` : ""}
          </div>
        </div>
        <StatusPill status={b.status} />
      </div>

      <div className="job-meta">
        <div className="stat">
          <div className="label">Price</div>
          <div className="value">
            {fmtPrice(b.priceAmount, b.priceCurrency)}
            {b.service?.priceUnit && <span className="job-unit"> · {priceUnitLabel(b.service.priceUnit)}</span>}
          </div>
        </div>
        <div className="stat">
          <div className="label">Destination</div>
          <div className="value small">{b.destination ? `${b.destination.lat.toFixed(4)}, ${b.destination.lng.toFixed(4)}` : "—"}</div>
        </div>
      </div>

      <div className="job-footer">
        <a className="btn secondary" style={{ padding: "10px 18px", fontSize: 14 }} href={shareUrl} target="_blank" rel="noreferrer">
          Share location
        </a>
        <Link
          className="btn secondary"
          style={{ padding: "10px 18px", fontSize: 14 }}
          to={`/provider/requests/${b.id}`}
        >
          Message
        </Link>
        <div className="row" style={{ marginLeft: "auto" }}>
          {action && (
            <button
              className="btn"
              style={{ padding: "10px 20px", fontSize: 14 }}
              disabled={busyId != null}
              onClick={() => onAction(b, action.action)}
            >
              {busyId === b.id ? "…" : action.label}
            </button>
          )}
          <button
            className="btn secondary"
            style={{ padding: "10px 20px", fontSize: 14 }}
            disabled={busyId != null}
            onClick={() => onCancel(b)}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryCard({ b }) {
  const paymentBadge = b.paymentStatus === "PAID" ? (
    <span className="chip payment-paid">Paid</span>
  ) : b.status === "COMPLETED" ? (
    <span className="chip payment-unpaid">Unpaid</span>
  ) : null;
  return (
    <div className="card job-card" style={{ opacity: 0.85 }}>
      <div className="job-top">
        <div className="meta" style={{ flex: 1, minWidth: 0 }}>
          <div className="name">{b.service?.title || b.personName}</div>
          <div className="pmeta">
            {b.customer?.name ? `For ${b.customer.name}` : ""}
            {b.completedAt ? ` · completed ${fmtDateTime(b.completedAt)}` : ` · ${fmtDateTime(b.createdAt)}`}
          </div>
        </div>
        <div className="row" style={{ gap: 6, alignItems: "center" }}>
          {paymentBadge}
          <StatusPill status={b.status} />
        </div>
      </div>
      <div className="job-meta">
        <div className="stat">
          <div className="label">Price</div>
          <div className="value">{fmtPrice(b.priceAmount, b.priceCurrency)}</div>
        </div>
        <div className="stat">
          <div className="label">Destination</div>
          <div className="value small">{b.destination ? `${b.destination.lat.toFixed(4)}, ${b.destination.lng.toFixed(4)}` : "—"}</div>
        </div>
        {b.paymentStatus === "PAID" && b.platformFee != null && (
          <div className="stat">
            <div className="label">Platform fee</div>
            <div className="value">{fmtPrice(b.platformFee, b.priceCurrency)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ProviderDashboard() {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [payModal, setPayModal] = useState(null);
  const [payMethod, setPayMethod] = useState("cash");
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState("");

  async function load(silent) {
    if (!silent) setError("");
    try {
      const data = await api("/api/provider/bookings");
      setBookings(data || []);
    } catch (err) {
      if (!silent) setError(err.message || "Could not load your requests.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => load(true), POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doAction(b, action) {
    if (busyId != null) return;
    setActionError("");
    setBusyId(b.id);
    try {
      await api(`/api/bookings/${b.id}/${action}`, { method: "POST" });
    } catch (err) {
      setActionError(err.message || "That action failed. Please refresh and try again.");
    } finally {
      setBusyId(null);
      load(true);
    }
  }

  async function doCancel(b) {
    if (busyId != null) return;
    if (!confirm("Cancel this booking?")) return;
    setActionError("");
    setBusyId(b.id);
    try {
      await api(`/api/bookings/${b.id}/cancel`, { method: "POST" });
    } catch (err) {
      setActionError(err.message || "Could not cancel this booking.");
    } finally {
      setBusyId(null);
      load(true);
    }
  }

  async function confirmPayment() {
    if (!payModal || payBusy) return;
    setPayError("");
    setPayBusy(true);
    try {
      await api(`/api/bookings/${payModal.id}/confirm-payment`, {
        method: "POST",
        body: { method: payMethod },
      });
      setPayModal(null);
      load(true);
    } catch (err) {
      setPayError(err.message || "Could not confirm payment.");
    } finally {
      setPayBusy(false);
    }
  }

  const requests = bookings.filter((b) => b.status === "REQUESTED");
  const expired = bookings.filter((b) => b.status === "EXPIRED");
  const active = bookings.filter((b) => actionFor(b.status));
  const done = bookings.filter((b) => b.status === "COMPLETED");
  const past = bookings.filter((b) => ["REJECTED", "CANCELLED"].includes(b.status));

  return (
    <div className="container">
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div>
          <h1 style={{ margin: 0 }}>Provider dashboard</h1>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            Service requests, live jobs and your job history.
          </p>
        </div>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 14 }}>
          <p className="help" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>
        </div>
      )}
      {actionError && (
        <div className="card" style={{ marginBottom: 14 }}>
          <p className="help" style={{ color: "var(--danger)", margin: 0 }}>{actionError}</p>
        </div>
      )}

      {loading && bookings.length === 0 && <p className="muted">Loading…</p>}

      {!loading && bookings.length === 0 && (
        <div className="card empty">
          <h3>No service requests yet</h3>
          <p>
            Customers who find your services will send requests here. List a
            service to get started.
          </p>
        </div>
      )}

      {bookings.length > 0 && (
        <>
          <h3 style={{ margin: "22px 0 10px" }}>Incoming requests</h3>
          {requests.length === 0 ? (
            <div className="card empty" style={{ padding: "28px 20px" }}>
              <h3>No service requests yet</h3>
              <p>New requests will appear here in real time.</p>
            </div>
          ) : (
            <div className="job-list">
              {requests.map((b) => (
                <RequestCard
                  key={b.id}
                  b={b}
                  busyId={busyId}
                  onAction={doAction}
                />
              ))}
            </div>
          )}

          {expired.length > 0 && (
            <div className="job-list" style={{ marginTop: 12 }}>
              {expired.map((b) => (
                <HistoryCard key={b.id} b={b} />
              ))}
            </div>
          )}

          <h3 style={{ margin: "26px 0 10px" }}>Active jobs</h3>
          {active.length === 0 ? (
            <div className="card empty" style={{ padding: "28px 20px" }}>
              <h3>No active jobs</h3>
              <p>Accept a request and the job will show up here.</p>
            </div>
          ) : (
            <div className="job-list">
              {active.map((b) => (
                <ActiveCard key={b.id} b={b} busyId={busyId} onAction={doAction} onCancel={doCancel} />
              ))}
            </div>
          )}

          {done.length > 0 && (
            <>
              <h3 style={{ margin: "26px 0 10px" }}>Completed jobs</h3>
              <div className="job-list">
                {done.map((b) => (
                  <div key={b.id} style={{ display: "flex", gap: 8, alignItems: "start" }}>
                    <div style={{ flex: 1 }}>
                      <HistoryCard b={b} />
                    </div>
                    {b.paymentStatus !== "PAID" && (
                      <button
                        className="btn"
                        style={{ padding: "10px 18px", fontSize: 14, marginTop: 4, whiteSpace: "nowrap" }}
                        onClick={() => { setPayModal(b); setPayMethod("cash"); setPayError(""); }}
                      >
                        Confirm Payment
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {past.length > 0 && (
            <>
              <h3 style={{ margin: "26px 0 10px" }}>Past</h3>
              <div className="job-list">
                {past.map((b) => (
                  <HistoryCard key={b.id} b={b} />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {payModal && (
        <div className="modal-overlay" onClick={() => !payBusy && setPayModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 6px" }}>Confirm payment received</h3>
            <p className="help" style={{ margin: "0 0 12px" }}>
              Confirm you received <b>{fmtPrice(payModal.priceAmount, payModal.priceCurrency)}</b> from {payModal.customer?.name || "the customer"} for <b>{payModal.service?.title || "the service"}</b>.
            </p>
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
              <p className="help" style={{ color: "var(--danger)", margin: "10px 0 0" }}>{payError}</p>
            )}
            <div className="modal-actions" style={{ marginTop: 14 }}>
              <button className="btn secondary" disabled={payBusy} onClick={() => setPayModal(null)}>
                Cancel
              </button>
              <button className="btn" disabled={payBusy} onClick={confirmPayment}>
                {payBusy ? "Confirming…" : "Confirm received"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
