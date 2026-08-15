import { useEffect, useRef, useState } from "react";
import { createMap, whenReady, syncPin, setLine } from "../lib/maplibre";
import { fetchRoute } from "../routing";

export default function MapPicker({ value, onChange, height = 340 }) {
  const [mode, setMode] = useState("pickup");
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});
  const modeRef = useRef(mode);
  const [preview, setPreview] = useState(null);

  const pickup = value?.pickup;
  const drop = value?.drop;

  function handlePick(m, lngLat) {
    const next = { ...(value || {}), [m]: { lat: lngLat.lat, lng: lngLat.lng } };
    onChange(next);
  }

  const pickRef = useRef(handlePick);
  pickRef.current = handlePick;

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = createMap(containerRef.current, { center: pickup || { lat: 6.5244, lng: 3.3792 }, zoom: 13 });
    mapRef.current = map;
    map.on("click", (e) => {
      pickRef.current(modeRef.current, e.lngLat);
    });
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => map.setCenter([p.coords.longitude, p.coords.latitude]),
        () => {}
      );
    }
    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!pickup || !drop) {
      setPreview(null);
      return;
    }
    let alive = true;
    fetchRoute(pickup, drop).then((r) => {
      if (alive && r) setPreview(r);
    });
    return () => {
      alive = false;
    };
  }, [pickup?.lat, pickup?.lng, drop?.lat, drop?.lng]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sync = () => {
      syncPin(map, markersRef, "pickup", pickup, { kind: "pickup" });
      syncPin(map, markersRef, "drop", drop, { kind: "drop" });
      setLine(map, "preview", preview?.coordinates || [], {
        color: "#34e07d",
        width: 4,
        dash: [7, 7],
        opacity: 0.8,
      });
    };
    whenReady(map, sync);
  }, [pickup, drop, preview]);

  const previewLabel =
    preview && preview.distanceKm > 0 ? `${preview.distanceKm.toFixed(1)} km · ≈${Math.max(1, Math.round(preview.durationSec / 60))} min` : null;

  return (
    <div>
      <div className="field">
        <label>Select points on the map</label>
        <div className="row">
          <button
            className={`btn ${mode === "pickup" ? "" : "secondary"}`}
            style={{ fontSize: 13, padding: "9px 16px" }}
            onClick={() => setMode("pickup")}
          >
            {pickup ? "1. Pickup set" : "1. Set pickup"}
          </button>
          <button
            className={`btn ${mode === "drop" ? "" : "secondary"}`}
            style={{ fontSize: 13, padding: "9px 16px" }}
            onClick={() => setMode("drop")}
          >
            {drop ? "2. Destination set" : "2. Set destination"}
          </button>
        </div>
      </div>
      <div className="map-box" style={{ height }}>
        <div ref={containerRef} className="map-full" />
        <button
          className="btn secondary"
          style={{ position: "absolute", top: 10, right: 10, zIndex: 1000, padding: "8px 14px", fontSize: 13 }}
          onClick={() => {
            if (navigator.geolocation) {
              navigator.geolocation.getCurrentPosition(
                (p) => mapRef.current?.flyTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 15 }),
                () => alert("Could not get your location.")
              );
            }
          }}
        >
          My location
        </button>
        {previewLabel && <div className="route-chip">{previewLabel}</div>}
        <div className="map-hint">
          {mode === "pickup" ? "Click the map to set the pickup point" : "Click the map to set the destination"}
        </div>
      </div>
    </div>
  );
}
