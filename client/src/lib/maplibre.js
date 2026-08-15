import { Map, Marker, Popup, NavigationControl, config } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

config.WORKER_URL = maplibreWorkerUrl;

export const MAP_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";

export function createMap(container, { center, zoom = 13 } = {}) {
  const map = new Map({
    container,
    style: MAP_STYLE,
    center: center ? [center.lng, center.lat] : [3.3792, 6.5244],
    zoom,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.addControl(
    new NavigationControl({ showCompass: false, visualizePitch: false }),
    "top-left"
  );
  return map;
}

export function removeLine(map, id) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

export function whenReady(map, fn) {
  let done = false;
  let timer = null;
  const run = () => {
    if (done) return;
    let ready = false;
    try {
      const style = map.style;
      ready = Boolean(style) && (style._loaded || map.isStyleLoaded() || map.loaded());
    } catch {
      ready = false;
    }
    if (ready) {
      done = true;
      if (timer) clearTimeout(timer);
      fn();
      return;
    }
    if (map._removed) return;
    timer = setTimeout(run, 60);
  };
  map.once("load", run);
  map.once("style.load", run);
  run();
}

function lineFeature(coords) {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: (coords || []).map((p) => [p.lng, p.lat]),
    },
  };
}

export function setLine(map, id, coords, paint) {
  if (!map.getSource(id)) {
    const layerPaint = {
      "line-color": paint.color,
      "line-width": paint.width,
    };
    if (paint.opacity != null) layerPaint["line-opacity"] = paint.opacity;
    if (paint.dash) layerPaint["line-dasharray"] = paint.dash;
    map.addSource(id, { type: "geojson", data: lineFeature(coords) });
    map.addLayer({ id, type: "line", source: id, paint: layerPaint });
  } else {
    map.getSource(id).setData(lineFeature(coords));
  }
}

function pointFeature(lat, lng) {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [lng, lat] },
  };
}

function metersToPixels(meters, lat, zoom) {
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  return meters / metersPerPixel;
}

export function setAccuracyCircle(map, id, { lat, lng, accuracy, color = "#34e07d" }) {
  const radius = Math.max(metersToPixels(accuracy || 15, lat, map.getZoom()), 6);
  if (!map.getSource(id)) {
    map.addSource(id, { type: "geojson", data: pointFeature(lat, lng) });
    map.addLayer({
      id,
      type: "circle",
      source: id,
      paint: {
        "circle-radius": radius,
        "circle-color": color,
        "circle-opacity": 0.2,
        "circle-stroke-width": 1,
        "circle-stroke-color": color,
        "circle-stroke-opacity": 1,
      },
    });
  } else {
    map.getSource(id).setData(pointFeature(lat, lng));
    map.setPaintProperty(id, "circle-radius", radius);
  }
}

export function addPin(map, { lat, lng, kind, name, tooltip, onClick }) {
  const el = document.createElement("div");
  el.className = "vest-pin " + kind;
  el.innerHTML = '<div class="pin"><div class="pin-inner"></div></div>';
  if (onClick) {
    el.style.cursor = "pointer";
    el.addEventListener("click", onClick);
  }
  const marker = new Marker({ element: el, anchor: "bottom" })
    .setLngLat([lng, lat])
    .addTo(map);
  if (name) {
    const popup = new Popup({
      className: "vest-popup",
      closeButton: false,
      closeOnClick: false,
      anchor: "top",
      offset: 4,
      maxWidth: "none",
    }).setText(name);
    marker.setPopup(popup);
    if (tooltip === "permanent") {
      marker.togglePopup();
    } else {
      el.addEventListener("mouseenter", () => marker.togglePopup());
      el.addEventListener("mouseleave", () => marker.togglePopup());
    }
  }
  return marker;
}

export function fitToPoints(map, points, { padding = 40, maxZoom = 15 } = {}) {
  if (!points || points.length === 0) return;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  if (minLng === maxLng && minLat === maxLat) {
    map.easeTo({ center: [minLng, minLat], zoom: Math.min(maxZoom, Math.max(map.getZoom(), 10)) });
    return;
  }
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    { padding, maxZoom }
  );
}

export function syncPin(map, registry, key, point, opts) {
  const existing = registry.current[key];
  if (
    existing &&
    existing.point &&
    point &&
    existing.point.lat === point.lat &&
    existing.point.lng === point.lng
  ) {
    return;
  }
  if (existing) {
    existing.marker.remove();
    delete registry.current[key];
  }
  if (!point) return;
  const marker = addPin(map, { ...point, ...opts });
  registry.current[key] = { marker, point };
}

export function pruneMarkers(map, registry, keepKeys) {
  for (const key of Object.keys(registry.current)) {
    if (!keepKeys.includes(key)) {
      registry.current[key].marker.remove();
      delete registry.current[key];
    }
  }
}
