import { useEffect, useRef } from "react";
import { createMap, whenReady, syncPin, setLine, setAccuracyCircle } from "../lib/maplibre";

export default function LiveMap({ pickup, drop, location, path, personName, follow = true, route, plannedRoute, chip, defaultCenter = [6.5244, 3.3792] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});

  const livePos = location ? { lat: location.lat, lng: location.lng } : null;
  const center = livePos || (pickup && { lat: pickup.lat, lng: pickup.lng }) || { lat: defaultCenter[0], lng: defaultCenter[1] };

  useEffect(() => {
    if (!containerRef.current) return;
    const map = createMap(containerRef.current, { center, zoom: 15 });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sync = () => {
      setLine(map, "trail", path || [], { color: "#3a3a44", width: 3, opacity: 0.5 });
      setLine(map, "planned", plannedRoute?.coordinates || [], { color: "#8a8f98", width: 3, dash: [8, 8], opacity: 0.75 });
      setLine(map, "live-under", route?.coordinates || [], { color: "#101418", width: 10, opacity: 0.85 });
      setLine(map, "live", route?.coordinates || [], { color: "#34e07d", width: 6, opacity: 0.95 });
      syncPin(map, markersRef, "pickup", pickup, { kind: "pickup" });
      syncPin(map, markersRef, "drop", drop, { kind: "drop" });
      if (livePos) {
        setAccuracyCircle(map, "accuracy", { ...livePos, accuracy: location?.accuracy });
        syncPin(map, markersRef, "live", livePos, { kind: "live", name: personName || "Person", tooltip: "permanent" });
      } else {
        syncPin(map, markersRef, "live", null, {});
        if (map.getLayer("accuracy")) map.removeLayer("accuracy");
        if (map.getSource("accuracy")) map.removeSource("accuracy");
      }
    };
    whenReady(map, sync);
  }, [pickup, drop, path, route, plannedRoute, livePos?.lat, livePos?.lng, location?.accuracy, personName]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !follow || !livePos) return;
    map.flyTo({ center: [livePos.lng, livePos.lat], zoom: Math.max(map.getZoom(), 15), essential: true });
  }, [livePos?.lat, livePos?.lng, follow]);

  return (
    <>
      <div ref={containerRef} className="map-full" />
      {chip && <div className="route-chip">{chip}</div>}
    </>
  );
}
