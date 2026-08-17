// Marketplace booking state machine.
//
// The database is the source of truth: every transition is a guarded
// conditional UPDATE (`... WHERE id = ? AND status IN (from_states)`), so
// concurrent actors (HTTP, Socket.IO, the expiration sweeper) can never
// overwrite a newer state. Callers check the affected row count and treat a
// zero-count result as a conflict rather than trusting a pre-read snapshot.
//
// Actors:
//   - provider  : an authenticated user whose Profile owns the booking
//   - customer  : the authenticated user who created the booking
//   - system    : server-side flows (expiration sweeper, token-verified
//                 tracking/person socket arrival) — still DB-guarded
import stmts from "./db.js";

export const REQUEST_TTL_MS = (Number(process.env.REQUEST_TTL_MIN) || 15) * 60 * 1000;

export const BOOKING_STATUSES = [
  "REQUESTED",
  "ACCEPTED",
  "REJECTED",
  "PROVIDER_EN_ROUTE",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
];

export const TERMINAL_STATES = new Set(["COMPLETED", "REJECTED", "CANCELLED", "EXPIRED"]);
// Legacy tracking statuses that ended a session (kept for profile-less bookings).
export const LEGACY_ENDED = new Set(["arrived", "cancelled"]);

const ACTION_TO_STATE = {
  accept: "ACCEPTED",
  reject: "REJECTED",
  start: "PROVIDER_EN_ROUTE",
  arrive: "ARRIVED",
  begin: "IN_PROGRESS",
  complete: "COMPLETED",
  cancel: "CANCELLED",
  expire: "EXPIRED",
};

// Which actor class may perform each action.
const ACTION_ACTOR = {
  accept: "provider",
  reject: "provider",
  start: "provider",
  arrive: "provider_or_system",
  begin: "provider",
  complete: "provider",
  cancel: "both",
  expire: "system",
};

const FROM_STATES = {
  accept: ["REQUESTED"],
  reject: ["REQUESTED"],
  start: ["ACCEPTED"],
  arrive: ["PROVIDER_EN_ROUTE"],
  begin: ["ARRIVED"],
  complete: ["IN_PROGRESS"],
  cancel: {
    customer: ["REQUESTED", "ACCEPTED", "PROVIDER_EN_ROUTE"],
    provider: ["ACCEPTED", "PROVIDER_EN_ROUTE"],
  },
  expire: ["REQUESTED"],
};

function conflict(booking, action, now = Date.now()) {
  const s = booking?.status;
  if (action === "accept" && booking?.expires_at != null && booking.expires_at < now) {
    return { ok: false, status: 409, error: "This booking request has expired." };
  }
  const messages = {
    COMPLETED: "Booking is already completed.",
    CANCELLED: "Booking is already cancelled.",
    REJECTED: "This booking request was rejected.",
    EXPIRED: "This booking request has expired.",
    REQUESTED:
      action === "cancel"
        ? "Pending requests are declined with reject, not cancelled."
        : action === "start"
          ? "The request must be accepted before the provider can start."
          : "Booking is still awaiting acceptance.",
    ACCEPTED: action === "accept" ? "This request has already been accepted." : "Booking has already been accepted.",
    PROVIDER_EN_ROUTE:
      action === "arrive" ? "Provider is already en route." : "The provider has not arrived yet.",
    ARRIVED: action === "begin" ? "Service has already begun." : "The provider has already arrived.",
    IN_PROGRESS:
      action === "cancel"
        ? "A service that is already in progress cannot be cancelled."
        : "Service is already in progress.",
  };
  return { ok: false, status: 409, error: messages[s] || "Booking state has changed; please refresh." };
}

// Perform one guarded lifecycle transition. Returns { ok, status, error, booking }.
// `booking` is only present (and fully fresh) when the transition succeeded.
export async function transitionBooking({ actorKind, userId, profileId, bookingId, action, now = Date.now() }) {
  const toState = ACTION_TO_STATE[action];
  if (!toState) return { ok: false, status: 400, error: "Unknown booking action." };
  const required = ACTION_ACTOR[action];

  const b = await stmts.findBookingById(bookingId);
  if (!b) return { ok: false, status: 404, error: "Booking not found." };

  let fromStates;
  let requireProfileId;
  let requireUserId;
  let requireNotExpired = false;

  if (action === "cancel") {
    if (actorKind === "provider") {
      if (profileId == null || b.profile_id !== profileId) {
        return { ok: false, status: 403, error: "This booking is not assigned to your profile." };
      }
      fromStates = FROM_STATES.cancel.provider;
      requireProfileId = profileId;
    } else {
      if (b.user_id !== userId) return { ok: false, status: 404, error: "Booking not found." };
      fromStates = FROM_STATES.cancel.customer;
      requireUserId = userId;
    }
  } else if (required === "system") {
    // expire — no user session involved
    fromStates = FROM_STATES[action];
  } else if (action === "arrive") {
    // provider_or_system — the share-token person (the travelling provider)
    // can trigger the server-side arrival transition without a user session.
    if (actorKind === "provider") {
      if (profileId == null) return { ok: false, status: 403, error: "Provider authorization required." };
      if (b.profile_id !== profileId) {
        return { ok: false, status: 403, error: "This booking is not assigned to your profile." };
      }
      fromStates = FROM_STATES[action];
      requireProfileId = profileId;
    } else if (actorKind === "system") {
      fromStates = FROM_STATES[action];
    } else {
      return { ok: false, status: 403, error: "Provider authorization required." };
    }
  } else if (required === "provider") {
    if (profileId == null) return { ok: false, status: 403, error: "Provider authorization required." };
    if (b.profile_id !== profileId) {
      return { ok: false, status: 403, error: "This booking is not assigned to your profile." };
    }
    fromStates = FROM_STATES[action];
    requireProfileId = profileId;
    if (action === "accept") requireNotExpired = true;
  } else {
    fromStates = FROM_STATES[action];
    requireUserId = userId;
  }

  if (!fromStates.includes(b.status)) return conflict(b, action, now);

  const data = {};
  if (action === "accept") data.accepted_at = now;
  if (action === "begin") data.started_at = now;
  if (action === "complete") data.completed_at = now;

  const count = await stmts.transitionBooking({
    id: bookingId,
    fromStatuses: fromStates,
    toStatus: toState,
    data,
    requireProfileId,
    requireUserId,
    requireNotExpired,
    now,
  });

  if (count !== 1) {
    const fresh = await stmts.findBookingById(bookingId);
    return conflict(fresh, action, now);
  }

  const updated = await stmts.findBookingById(bookingId);
  return { ok: true, status: 200, booking: updated };
}

// Cancel by the authenticated actor. The customer may cancel their own booking;
// a provider may cancel a booking assigned to their Profile. Legacy (profile-less)
// bookings keep their historical behavior: the owner may cancel at any time.
export async function cancelBookingForActor(userId, bookingId, { now = Date.now() } = {}) {
  const b = await stmts.findBookingById(bookingId);
  if (!b) return { ok: false, status: 404, error: "Booking not found." };

  if (!b.profile_id) {
    if (b.user_id !== userId) return { ok: false, status: 404, error: "Booking not found." };
    await stmts.setBookingStatus(bookingId, "cancelled");
    const updated = await stmts.findBookingById(bookingId);
    return { ok: true, status: 200, booking: updated };
  }

  if (b.user_id === userId) {
    return transitionBooking({ actorKind: "customer", userId, bookingId, action: "cancel", now });
  }

  const profile = await stmts.findProfileByUser(userId);
  if (b.profile_id != null && profile && b.profile_id === profile.id) {
    return transitionBooking({ actorKind: "provider", userId, profileId: profile.id, bookingId, action: "cancel", now });
  }

  return { ok: false, status: 404, error: "Booking not found." };
}
