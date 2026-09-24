import type * as mapboxgl from "mapbox-gl";

/** "#zoom/lat/lng" → camera, or null. */
export function parseMapHash(
    hash: string,
): { zoom: number; center: [number, number] } | null {
    const trimmed = hash.replace(/^#/, "").trim();
    if (!trimmed) return null;

    const parts = trimmed.split("/");
    if (parts.length < 3) return null;

    const zoom = Number(parts[0]);
    const lat = Number(parts[1]);
    const lng = Number(parts[2]);
    if (
        !Number.isFinite(zoom) ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng)
    )
        return null;

    return { zoom, center: [lng, lat] };
}

/** A SvelteKit host passes `replaceState` from `$app/navigation`: a raw history write desyncs the router's history index. No framework import here keeps this file unit-testable. */
export type HashWriter = (url: string) => void;

const writeWithHistory: HashWriter = (url) => {
    history.replaceState(null, "", url);
};

export function setMapHash(map: mapboxgl.Map, write: HashWriter = writeWithHistory): void {
    const zoom = map.getZoom();
    const center = map.getCenter();

    const next = `#${zoom.toFixed(2)}/${center.lat.toFixed(5)}/${center.lng.toFixed(5)}`;
    if (typeof window === "undefined") return;
    if (window.location.hash === next) return;

    write(next);
}
