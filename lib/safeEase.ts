import type * as mapboxgl from "mapbox-gl";
import type { Coord } from "./coord";

// ⚠️ mapbox-gl 3.x globe projection recursion (setLocationAtPoint → set center → _updateZoomFromElevation) makes animated easeTo/flyTo blow the stack — this interpolates via rAF+jumpTo on globe, falls back to easeTo on mercator.

export type SafeEaseOptions = {
    center?: Coord | [number, number] | mapboxgl.LngLatLike;
    zoom?: number;
    duration?: number;
};

const activeRaf = new WeakMap<mapboxgl.Map, number>();

function isGlobe(map: mapboxgl.Map): boolean {
    try {
        return map.getProjection()?.name === "globe";
    } catch {
        return false;
    }
}

function toLngLat(c: SafeEaseOptions["center"]): [number, number] | null {
    if (!c) return null;
    if (Array.isArray(c)) return [c[0], c[1]];
    const anyC = c as { lng?: number; lon?: number; lat?: number };
    if (typeof anyC.lat === "number") {
        const lng = anyC.lng ?? anyC.lon;
        if (typeof lng === "number") return [lng, anyC.lat];
    }
    return null;
}

// Shortest signed delta on the longitude axis (handles antimeridian wrap).
function shortestLngDelta(from: number, to: number): number {
    let d = ((to - from + 540) % 360) - 180;
    // Handle exact 180 case deterministically (eastward).
    if (d === -180) d = 180;
    return d;
}

// Cubic ease-out — feels close to mapbox default.
function easeOutCubic(t: number): number {
    return 1 - (1 - t) ** 3;
}

export function safeEase(
    map: mapboxgl.Map,
    opts: SafeEaseOptions,
): void {
    // ⚠️ Never let a non-finite zoom/center reach the Mapbox camera — it corrupts the transform and renders blank white; validate up front and bail loudly.
    if (opts.zoom !== undefined && !Number.isFinite(opts.zoom)) {
        console.warn("[safeEase] rejected: zoom is not finite");
        return;
    }
    if (opts.center !== undefined) {
        const ll = toLngLat(opts.center);
        if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) {
            console.warn("[safeEase] rejected: center is not finite");
            return;
        }
    }

    const duration = Number.isFinite(opts.duration)
        ? Math.max(0, opts.duration as number)
        : 600;

    if (!isGlobe(map)) {
        map.easeTo({
            ...(opts.center && { center: opts.center as mapboxgl.LngLatLike }),
            ...(typeof opts.zoom === "number" && { zoom: opts.zoom }),
            duration,
        });
        return;
    }

    const prev = activeRaf.get(map);
    if (prev) {
        cancelAnimationFrame(prev);
        activeRaf.delete(map);
    }

    const startCenter = map.getCenter();
    const startLng = startCenter.lng;
    const startLat = startCenter.lat;
    const startZoom = map.getZoom();

    // If the current camera is already non-finite, bail rather than interpolate from it — the watchdog in mapInit.ts restores a finite camera.
    if (
        !Number.isFinite(startLng) ||
        !Number.isFinite(startLat) ||
        !Number.isFinite(startZoom)
    ) {
        console.warn("[safeEase] current camera non-finite — skipping ease");
        return;
    }

    const target = toLngLat(opts.center);
    const dLng = target ? shortestLngDelta(startLng, target[0]) : 0;
    const dLat = target ? target[1] - startLat : 0;
    const targetZoom = typeof opts.zoom === "number" ? opts.zoom : startZoom;
    const dZoom = targetZoom - startZoom;

    if (duration === 0) {
        map.jumpTo({
            center: target ? [startLng + dLng, startLat + dLat] : undefined,
            zoom: targetZoom,
        });
        return;
    }

    const t0 = performance.now();

    function step(now: number) {
        const raw = Math.min(1, (now - t0) / duration);
        const k = easeOutCubic(raw);
        const lng = startLng + dLng * k;
        const lat = startLat + dLat * k;
        const zoom = startZoom + dZoom * k;
        map.jumpTo({
            ...(target && { center: [lng, lat] as [number, number] }),
            zoom,
        });
        if (raw < 1) {
            const id = requestAnimationFrame(step);
            activeRaf.set(map, id);
        } else {
            activeRaf.delete(map);
            // jumpTo already fires moveend/zoomend; don't double-fire.
        }
    }

    const id = requestAnimationFrame(step);
    activeRaf.set(map, id);
}
