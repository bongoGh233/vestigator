import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtPrice, priceUnitLabel, fmtDuration } from "../utils";

const CURRENCIES = [
  "GHS", "USD", "EUR", "GBP", "NGN", "KES", "ZAR", "TZS", "UGX", "XOF",
  "XAF", "CAD", "AUD", "JPY", "CNY", "INR",
];
const PRICE_UNITS = [
  { value: "flat", label: "Flat rate" },
  { value: "per_hour", label: "Per hour" },
  { value: "per_km", label: "Per km" },
];
const CATEGORY_SUGGESTIONS = [
  "Delivery", "Errand", "Escort", "Airport", "Shopping", "Cleaning",
  "Moving", "Handyman", "Medical", "Caregiver", "Other",
];

const EMPTY_FORM = {
  title: "",
  description: "",
  category: "",
  price: "",
  currency: "GHS",
  priceUnit: "flat",
  durationMin: "",
};

function toMajor(amountMinor) {
  return Number.isInteger(amountMinor) ? String(amountMinor / 100) : (amountMinor / 100).toFixed(2);
}

export default function Services() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState(null);

  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  async function load() {
    try {
      const data = await api("/api/provider/services");
      setServices(data || []);
    } catch (err) {
      setError(err.message || "Could not load your services.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEdit(s) {
    setEditing(s.id);
    setForm({
      title: s.title,
      description: s.description || "",
      category: s.category || "",
      price: toMajor(s.priceAmount),
      currency: s.priceCurrency,
      priceUnit: s.priceUnit,
      durationMin: s.durationMin != null ? String(s.durationMin) : "",
    });
    setFormError("");
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(false);
  }

  function validate() {
    if (!form.title.trim()) return "A service title is required.";
    const price = Number(form.price);
    if (form.price === "" || !Number.isFinite(price) || price < 0) {
      return "Enter a valid price of 0 or more.";
    }
    if (form.durationMin !== "") {
      const dur = Number(form.durationMin);
      if (!Number.isInteger(dur) || dur < 1) {
        return "Duration must be a whole number of minutes (or left empty).";
      }
    }
    return "";
  }

  async function submit(e) {
    e.preventDefault();
    const v = validate();
    if (v) {
      setFormError(v);
      return;
    }
    setFormError("");
    setSaving(true);
    const body = {
      title: form.title.trim(),
      description: form.description.trim(),
      category: form.category.trim(),
      priceAmount: Math.round(Number(form.price) * 100),
      priceCurrency: form.currency,
      priceUnit: form.priceUnit,
      durationMin: form.durationMin === "" ? null : Number(form.durationMin),
    };
    try {
      if (editing == null) {
        await api("/api/services", { method: "POST", body });
      } else {
        await api(`/api/services/${editing}`, { method: "PUT", body });
      }
      await load();
      setForm(EMPTY_FORM);
      setEditing(null);
      setShowForm(false);
    } catch (err) {
      setFormError(err.message || "Could not save the service.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(s) {
    if (busyId != null) return;
    setBusyId(s.id);
    setError("");
    try {
      await api(`/api/services/${s.id}`, { method: "PUT", body: { active: !s.active } });
      await load();
    } catch (err) {
      setError(err.message || "Could not update the service.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s) {
    if (busyId != null) return;
    if (!confirm(`Delete "${s.title}"?`)) return;
    setBusyId(s.id);
    setError("");
    try {
      await api(`/api/services/${s.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message || "Could not delete the service.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="container">
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div>
          <h1 style={{ margin: 0 }}>My services</h1>
          <p className="sub" style={{ margin: "4px 0 0" }}>
            What you offer, how much it costs, and whether customers can see it.
          </p>
        </div>
        {!editing && !showForm && (
          <button className="btn" onClick={startCreate}>Add service</button>
        )}
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 14 }}>
          <p className="help" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>
        </div>
      )}

      {showForm ? (
        <form className="card" onSubmit={submit} style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>
            {editing == null ? "New service" : "Edit service"}
          </h3>

          <div className="grid" style={{ gridTemplateColumns: "2fr 1fr" }}>
            <div className="field">
              <label htmlFor="svc-title">Title</label>
              <input
                id="svc-title"
                className="input"
                maxLength={80}
                placeholder="e.g. Airport Pickup"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="svc-category">Category</label>
              <input
                id="svc-category"
                className="input"
                list="svc-category-list"
                maxLength={60}
                placeholder="e.g. Airport"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              />
              <datalist id="svc-category-list">
                {CATEGORY_SUGGESTIONS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="field">
            <label htmlFor="svc-desc">Description</label>
            <textarea
              id="svc-desc"
              className="input"
              rows={3}
              maxLength={1000}
              placeholder="What exactly do you offer?"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div className="grid svc-form-grid">
            <div className="field">
              <label htmlFor="svc-price">Price</label>
              <input
                id="svc-price"
                className="input"
                inputMode="decimal"
                placeholder="e.g. 200"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="svc-currency">Currency</label>
              <select
                id="svc-currency"
                className="input"
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="svc-unit">Price per</label>
              <select
                id="svc-unit"
                className="input"
                value={form.priceUnit}
                onChange={(e) => setForm({ ...form, priceUnit: e.target.value })}
              >
                {PRICE_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="svc-duration">Duration (min, optional)</label>
              <input
                id="svc-duration"
                className="input"
                inputMode="numeric"
                placeholder="e.g. 60"
                value={form.durationMin}
                onChange={(e) => setForm({ ...form, durationMin: e.target.value })}
              />
            </div>
          </div>

          {formError && (
            <p className="help" style={{ color: "var(--danger)", marginBottom: 10 }}>{formError}</p>
          )}

          <div className="row">
            <button className="btn" disabled={saving}>
              {saving ? "Saving…" : editing == null ? "Create service" : "Save changes"}
            </button>
            {editing != null && (
              <button type="button" className="btn secondary" onClick={cancelEdit}>Cancel</button>
            )}
          </div>
        </form>
      ) : null}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : services.length === 0 ? (
        <div className="card empty">
          <h3>You haven't added any services yet</h3>
          <p>List what you offer so customers can find you and send requests.</p>
          <button className="btn" onClick={startCreate}>Add service</button>
        </div>
      ) : (
        <div className="booking-list">
          {services.map((s) => (
            <div key={s.id} className={`card job-card${s.active ? "" : " inactive"}`}>
              <div className="job-top">
                <div className="meta" style={{ flex: 1, minWidth: 0 }}>
                  <div className="name">
                    {s.title}
                    <span className="chip" style={{ marginLeft: 8 }}>{s.category || "other"}</span>
                  </div>
                  <div className="pmeta">
                    {fmtPrice(s.priceAmount, s.priceCurrency)} · {priceUnitLabel(s.priceUnit)}
                    {fmtDuration(s.durationMin) && ` · ${fmtDuration(s.durationMin)}`}
                  </div>
                </div>
                <StatusToggle active={s.active} busy={busyId === s.id} onToggle={() => toggleActive(s)} />
              </div>
              {s.description && <p className="help" style={{ margin: "8px 0 0" }}>{s.description}</p>}
              <div className="job-footer" style={{ marginTop: 12 }}>
                <span className="pmeta">
                  {s.active ? "Visible to customers" : "Hidden from customers"}
                </span>
                <div className="row" style={{ marginLeft: "auto" }}>
                  <button className="btn secondary" style={{ padding: "10px 18px", fontSize: 14 }} onClick={() => startEdit(s)}>
                    Edit
                  </button>
                  <button
                    className="btn secondary danger"
                    style={{ padding: "10px 18px", fontSize: 14 }}
                    disabled={busyId != null}
                    onClick={() => remove(s)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusToggle({ active, busy, onToggle }) {
  return (
    <button
      type="button"
      className={`btn ${active ? "secondary" : ""}`}
      style={{ padding: "8px 16px", fontSize: 13, flex: "none" }}
      disabled={busy}
      onClick={onToggle}
      aria-label={active ? "Deactivate service" : "Activate service"}
    >
      {busy ? "…" : active ? "Active" : "Inactive"}
    </button>
  );
}
