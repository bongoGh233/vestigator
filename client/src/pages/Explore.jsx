import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { fmtPrice, priceUnitLabel, fmtDuration } from "../utils";

const CATEGORY_SUGGESTIONS = [
  "Delivery",
  "Errand",
  "Escort",
  "Airport",
  "Shopping",
  "Cleaning",
  "Moving",
  "Handyman",
  "Medical",
  "Caregiver",
  "Other",
];

function ServiceCard({ s }) {
  return (
    <div className="service-card">
      <div className="service-card-top">
        <h3 className="service-title">{s.title}</h3>
        <span className="chip">{s.category}</span>
      </div>
      {s.description && <p className="help service-desc">{s.description}</p>}
      <div className="service-price">
        {fmtPrice(s.priceAmount, s.priceCurrency)}
        <span className="service-unit"> · {priceUnitLabel(s.priceUnit)}</span>
      </div>
      {fmtDuration(s.durationMin) && (
        <div className="service-meta">
          <span>⏱ {fmtDuration(s.durationMin)}</span>
        </div>
      )}
      <div className="service-provider">
        <span className="pname">{s.provider.name}</span>
        {s.provider.ratingCount > 0 && (
          <span className="service-rating">★ {s.provider.ratingAvg?.toFixed(1)} ({s.provider.ratingCount})</span>
        )}
      </div>
      <Link className="btn secondary block" to={`/providers/${s.provider.id}`} style={{ marginTop: 12 }}>
        View provider
      </Link>
    </div>
  );
}

export default function Explore() {
  const [services, setServices] = useState([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [area, setArea] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);

  async function run(filters) {
    setError("");
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const cat = (filters?.category ?? category).trim();
      const query = (filters?.q ?? q).trim();
      const areaVal = (filters?.area ?? area).trim();
      if (cat) params.set("category", cat);
      if (query) params.set("q", query);
      if (areaVal) params.set("area", areaVal);
      const data = await api(`/api/services${params.toString() ? `?${params}` : ""}`);
      setServices(data || []);
    } catch (err) {
      setError(err.message || "Could not load services.");
      setServices([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e) {
    e.preventDefault();
    setSearching(true);
    run().finally(() => setSearching(false));
  }

  return (
    <div className="container">
      <h1>Explore services</h1>
      <p className="sub">
        Find a service near you and request it directly from a provider.
      </p>

      <form className="card search-card" onSubmit={submit}>
        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="q">Search</label>
            <input
              id="q"
              className="input"
              placeholder="e.g. Airport pickup, grocery run…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="category">Category</label>
            <input
              id="category"
              className="input"
              list="category-suggestions"
              placeholder="Any"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="category-suggestions">
              {CATEGORY_SUGGESTIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="area">Area / city</label>
            <input
              id="area"
              className="input"
              placeholder="e.g. Accra"
              value={area}
              onChange={(e) => setArea(e.target.value)}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" disabled={loading || searching}>
            {searching ? "Searching…" : "Search"}
          </button>
          {(q || category || area) && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setQ("");
                setCategory("");
                setArea("");
                run({ q: "", category: "", area: "" });
              }}
            >
              Clear
            </button>
          )}
        </div>
        {error && <p className="help" style={{ color: "var(--danger)", margin: "10px 0 0" }}>{error}</p>}
      </form>

      <div className="section-title">
        <h2 style={{ margin: 0 }}>Services</h2>
        <span className="sub" style={{ margin: 0 }}>
          {loading ? "…" : `${services.length} found`}
        </span>
      </div>

      {loading ? (
        <p className="muted">Loading services…</p>
      ) : services.length === 0 ? (
        <div className="card empty">
          <h3>No services match that search</h3>
          <p>Try a different keyword, category or area — or clear the filters.</p>
        </div>
      ) : (
        <div className="service-grid">
          {services.map((s) => (
            <ServiceCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
