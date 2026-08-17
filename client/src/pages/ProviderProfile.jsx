import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { initials, fmtPrice, priceUnitLabel, fmtDuration, fmtDateTime, fmtWindow, DOW_NAMES } from "../utils";

export default function ProviderProfile() {
  const { profileId } = useParams();
  const [profile, setProfile] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [reviews, setReviews] = useState([]);
  const [reviewsError, setReviewsError] = useState("");

  useEffect(() => {
    let alive = true;
    setProfile(null);
    setNotFound(false);
    setReviews([]);
    setReviewsError("");
    api(`/api/profiles/${profileId}`)
      .then((p) => alive && setProfile(p))
      .catch(() => alive && setNotFound(true));
    api(`/api/profiles/${profileId}/reviews`)
      .then((r) => alive && setReviews(r.reviews || []))
      .catch((err) => alive && setReviewsError(err.message || "Could not load reviews."));
    return () => {
      alive = false;
    };
  }, [profileId]);

  if (notFound) {
    return (
      <div className="container">
        <div className="card empty">
          <h3>Provider not found</h3>
          <p>
            <Link to="/explore">Back to explore</Link>
          </p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <div className="container"><p className="sub">Loading…</p></div>;
  }

  const serviceArea = profile.serviceArea;
  const hasRating = profile.ratingCount > 0;

  return (
    <div className="container" style={{ maxWidth: 860 }}>
      <Link to="/explore" className="sub">← Back to explore</Link>

      <div className="card provider-hero" style={{ margin: "12px 0 18px" }}>
        <div className="profile-head">
          {profile.avatar ? (
            <img className="profile-avatar" src={profile.avatar} alt={profile.name} />
          ) : (
            <div className="profile-avatar">{initials(profile.name)}</div>
          )}
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0 }}>{profile.name}</h2>
            <div className="pmeta">
              {[profile.city, serviceArea?.city].filter(Boolean).join(" · ") ||
                (serviceArea?.radiusKm ? `Serves within ${serviceArea.radiusKm} km` : "No location set")}
            </div>
            <div className="provider-rating" aria-label={`Rating ${profile.rating} out of 5 from ${profile.ratingCount} reviews`}>
              {hasRating ? (
                <>
                  <span className="star" aria-hidden="true">★</span>
                  <b>{profile.rating?.toFixed(1)}</b>
                  <span className="sub" style={{ margin: 0 }}>({profile.ratingCount} review{profile.ratingCount === 1 ? "" : "s"})</span>
                </>
              ) : (
                <span className="sub" style={{ margin: 0 }}>No reviews yet</span>
              )}
            </div>
          </div>
        </div>
        {profile.bio && <p className="help" style={{ margin: "12px 0 0" }}>{profile.bio}</p>}
        {profile.skills.length > 0 && (
          <div className="chips" style={{ marginTop: 10 }}>
            {profile.skills.map((s) => (
              <span key={s} className="chip">{s}</span>
            ))}
          </div>
        )}
      </div>

      {profile.availability?.configured ? (
        <div className="card" style={{ margin: "0 0 18px" }}>
          <div className="row" style={{ alignItems: "center", gap: 10 }}>
            <span className={`avail-dot${profile.availability.availableNow ? " on" : ""}`} aria-hidden="true" />
            <b>{profile.availability.availableNow ? "Available now" : "Not available right now"}</b>
            {profile.availability.timezone && (
              <span className="sub" style={{ margin: "0 0 0 auto" }}>{profile.availability.timezone}</span>
            )}
          </div>
          <div style={{ marginTop: 10 }}>
            {Object.entries(
              (profile.availability.schedule || []).reduce((acc, w) => {
                if (!acc[w.dow]) acc[w.dow] = [];
                acc[w.dow].push(w);
                return acc;
              }, {})
            )
              .sort((a, b) => Number(a[0]) - Number(b[0]))
              .map(([dow, windows]) => (
                <div key={dow} className="avail-sched-row">
                  <b>{DOW_NAMES[dow]}</b>
                  <span>
                    {windows.map((w) => `${fmtWindow(w.startMin)} – ${fmtWindow(w.endMin)}`).join(", ")}
                  </span>
                </div>
              ))}
          </div>
        </div>
      ) : null}

      <div className="section-title">
        <h2 style={{ margin: 0 }}>Services</h2>
        <span className="sub" style={{ margin: 0 }}>{profile.services.length} available</span>
      </div>

      {profile.services.length === 0 ? (
        <div className="card empty">
          <h3>No active services yet</h3>
          <p>This provider hasn't listed any services right now.</p>
        </div>
      ) : (
        <div className="booking-list">
          {profile.services.map((s) => (
            <div key={s.id} className="service-row">
              <div className="meta" style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{s.title}</div>
                {s.description && <p className="help" style={{ margin: "4px 0 6px" }}>{s.description}</p>}
                <div className="chips" style={{ marginTop: 2 }}>
                  <span className="chip">{s.category}</span>
                  {fmtDuration(s.durationMin) && <span className="chip">{fmtDuration(s.durationMin)}</span>}
                </div>
              </div>
              <div style={{ textAlign: "right", flex: "none" }}>
                <div className="service-price">
                  {fmtPrice(s.priceAmount, s.priceCurrency)}
                </div>
                <div className="service-unit">{priceUnitLabel(s.priceUnit)}</div>
                <Link
                  className="btn"
                  style={{ marginTop: 10, padding: "10px 18px", fontSize: 14 }}
                  to={`/book/${profile.id}?service=${s.id}`}
                >
                  Request service
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section-title" style={{ marginTop: 26 }}>
        <h2 style={{ margin: 0 }}>Reviews</h2>
        <span className="sub" style={{ margin: 0 }}>
          {hasRating ? `${profile.ratingCount} total` : "No reviews yet"}
        </span>
      </div>

      {reviewsError ? (
        <div className="card empty">
          <p className="help" style={{ margin: 0, color: "var(--danger)" }}>{reviewsError}</p>
        </div>
      ) : reviews.length === 0 ? (
        <div className="card empty">
          <h3>No reviews yet</h3>
          <p>This provider hasn't received any reviews. Book a service and be the first to leave one.</p>
        </div>
      ) : (
        <div className="review-list">
          {reviews.map((r) => (
            <div key={r.id} className="review-card">
              <div className="review-head">
                <span className="review-stars" aria-label={`${r.rating} out of 5 stars`}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <span key={n} className={n <= r.rating ? "on" : ""} aria-hidden="true">★</span>
                  ))}
                </span>
                <span className="sub" style={{ margin: 0 }}>{r.reviewer?.name || "Customer"}</span>
                <span className="sub" style={{ margin: "0 0 0 auto" }}>{fmtDateTime(r.createdAt)}</span>
              </div>
              {r.comment && <p className="help" style={{ margin: "8px 0 0" }}>{r.comment}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
