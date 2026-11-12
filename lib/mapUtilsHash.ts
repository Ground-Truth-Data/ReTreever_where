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

/** The decimals a coordinate needs at this zoom: about a screen pixel's worth, no finer. */
function placesAt(zoom: number): number {
    if (zoom <= 5) return 2;
    if (zoom <= 9) return 3;
    if (zoom <= 13) return 4;
    return 5;
}

/** "#zoom/lat/lng", each to the precision the zoom can show. */
export function formatMapHash(zoom: number, lat: number, lng: number): string {
    const places = placesAt(zoom);
    // Number() drops the zeros toFixed pads with, and -0 prints as 0.
    const n = (v: number, d: number) => String(Number(v.toFixed(d)) + 0);
    return `#${n(zoom, 1)}/${n(lat, places)}/${n(lng, places)}`;
}

export function setMapHash(map: mapboxgl.Map, write: HashWriter = writeWithHistory): void {
    const center = map.getCenter();
    const next = formatMapHash(map.getZoom(), center.lat, center.lng);
    if (typeof window === "undefined") return;
    if (window.location.hash === next) return;

    write(next);
}
