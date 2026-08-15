import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { createMap, whenReady, syncPin, pruneMarkers, setLine, removeLine, fitToPoints } from "../lib/maplibre";

export default function BookingsMap({ bookings, height = 520 }) {
  const navigate = useNavigate();
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});
  const linesRef = useRef([]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = createMap(containerRef.current, { center: { lat: 6.5244, lng: 3.3792 }, zoom: 6 });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = {};
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sync = () => {
      const points = [];
      const keep = [];
      const keepLines = [];
      bookings.forEach((b) => {
        const open = () => navigate(`/track/${b.id}`);
        if (b.pickup) {
          points.push(b.pickup);
          syncPin(map, markersRef, `${b.id}-pickup`, b.pickup, {
            kind: "pickup",
            name: `${b.personName} — pickup`,
            onClick: open,
          });
          keep.push(`${b.id}-pickup`);
          setLine(map, `${b.id}-planned`, b.destination ? [b.pickup, b.destination] : [], {
            color: "#8a8f98",
            width: 2,
            dash: [6, 6],
            opacity: 0.6,
          });
          keepLines.push(`${b.id}-planned`);
        }
        if (b.destination) {
          points.push(b.destination);
          syncPin(map, markersRef, `${b.id}-drop`, b.destination, {
            kind: "drop",
            name: `${b.personName} — destination`,
            onClick: open,
          });
          keep.push(`${b.id}-drop`);
        }
        if (b.location) {
          points.push(b.location);
          syncPin(map, markersRef, `${b.id}-live`, b.location, {
            kind: "live",
            name: b.personName,
            tooltip: "permanent",
            onClick: open,
          });
          keep.push(`${b.id}-live`);
          setLine(map, `${b.id}-last`, b.destination ? [b.location, b.destination] : [], {
            color: "#34e07d",
            width: 3,
            opacity: 0.7,
          });
          keepLines.push(`${b.id}-last`);
        }
      });
      pruneMarkers(map, markersRef, keep);
      for (const id of linesRef.current) {
        if (!keepLines.includes(id)) removeLine(map, id);
      }
      linesRef.current = keepLines;
      fitToPoints(map, points, { padding: 40, maxZoom: 15 });
    };
    whenReady(map, sync);
  }, [bookings, navigate]);

  return (
    <div className="map-box" style={{ height }}>
      <div ref={containerRef} className="map-full" />
    </div>
  );
}
