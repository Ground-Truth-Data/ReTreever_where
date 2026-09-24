// The only sanctioned way to mutate the Mapbox camera: one NaN corrupts the
// camera for every later call. Direct calls fail `vite build` (the noRawCamera
// guard); a line that genuinely cannot use a wrapper is annotated `// camera-allow-raw: <why>`.

// Structural, not `import { Map }`: two hoisted mapbox-gl copies make the
// nominal Map types incompatible across the boundary.
type CameraMap = {
    flyTo(opts: Record<string, unknown>): void;
    fitBounds(
        bounds: [[number, number], [number, number]],
        opts?: Record<string, unknown>,
    ): void;
    // fitBounds' zoom math without mutating; undefined on a 0×0 canvas.
    cameraForBounds?(
        bounds: [[number, number], [number, number]],
        opts?: Record<string, unknown>,
    ): { zoom?: number } | null | undefined;
    easeTo(opts: Record<string, unknown>): void;
    jumpTo(opts: Record<string, unknown>): void;
    stop(): void;
    getCenter(): { lng: number; lat: number };
    getZoom(): number;
};

import { type Coord, isCoord } from "./coord";

export { isCoord, toCoord, toCoordFromLngLat, toCoordFromArray, toCoordFromFeature } from "./coord";
export type { Coord };

export const isFiniteCoord = isCoord;

export function isFiniteLngLat(
    p: { lng: number; lat: number } | null | undefined,
): p is { lng: number; lat: number } {
    return !!p && Number.isFinite(p.lng) && Number.isFinite(p.lat);
}

type CoordInput = Coord | readonly [number, number] | [number, number];

function isFiniteNumber(n: unknown): n is number {
    return typeof n === "number" && Number.isFinite(n);
}

// Not isCoord: its geographic range check rejects valid pixel offsets like [0, -160].
function isFinitePixelPair(p: unknown): p is [number, number] {
    return (
        Array.isArray(p) &&
        p.length >= 2 &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1])
    );
}

// No animated transition can succeed from a NaN camera; jumpTo somewhere finite first.
function ensureCleanCamera(
    map: CameraMap,
    fallbackCenter?: CoordInput,
    fallbackZoom?: number,
): boolean {
    const c = map.getCenter();
    const z = map.getZoom();
    const cleanCenter = Number.isFinite(c.lng) && Number.isFinite(c.lat);
    const cleanZoom = Number.isFinite(z);
    if (cleanCenter && cleanZoom) return true;

    const target: Coord | null = fallbackCenter && isCoord(fallbackCenter)
        ? (fallbackCenter as Coord)
        : cleanCenter
        ? ([c.lng, c.lat] as unknown as Coord)
        : null;
    const targetZoom = isFiniteNumber(fallbackZoom)
        ? fallbackZoom
        : cleanZoom
        ? z
        : 2;

    if (!target) {
        reportRejection("ensureCleanCamera", "no fallback center available");
        return false;
    }
    map.jumpTo({ center: target, zoom: targetZoom });
    return true;
}

function reportRejection(method: string, reason: string): void {
    if (typeof console !== "undefined") {
        console.warn(`[safeMap] rejected ${method}: ${reason}`);
    }
}

export type SafeFlyToOptions = {
    center: CoordInput;
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    curve?: number;
    offset?: [number, number];
    padding?: { top?: number; bottom?: number; left?: number; right?: number };
    essential?: boolean;
};

export function safeFlyTo(map: CameraMap, opts: SafeFlyToOptions): void {
    if (!isFiniteCoord(opts.center)) {
        reportRejection("flyTo", "center is not finite");
        return;
    }
    if (opts.zoom !== undefined && !isFiniteNumber(opts.zoom)) {
        reportRejection("flyTo", "zoom is not finite");
        return;
    }
    if (opts.duration !== undefined && !isFiniteNumber(opts.duration)) {
        reportRejection("flyTo", "duration is not finite");
        return;
    }
    if (opts.offset && !isFinitePixelPair(opts.offset)) {
        reportRejection("flyTo", "offset has non-finite component");
        return;
    }
    if (!ensureCleanCamera(map, opts.center, opts.zoom)) return;

    map.stop();
    map.flyTo(opts);
}

export type SafeFitBoundsOptions = {
    padding?:
        | number
        | { top?: number; bottom?: number; left?: number; right?: number };
    duration?: number;
    maxZoom?: number;
    essential?: boolean;
    bearing?: number;
    pitch?: number;
};

export function safeFitBounds(
    map: CameraMap,
    sw: CoordInput,
    ne: CoordInput,
    opts: SafeFitBoundsOptions = {},
): void {
    if (!isCoord(sw) || !isCoord(ne)) {
        reportRejection("fitBounds", "corner is not finite");
        return;
    }
    // Mapbox's fit math produces NaN on zero-area bounds.
    const sameLng = sw[0] === ne[0];
    const sameLat = sw[1] === ne[1];
    if (sameLng && sameLat) {
        safeFlyTo(map, {
            center: sw as Coord,
            zoom: opts.maxZoom ?? 16,
            duration: opts.duration ?? 1200,
            essential: opts.essential,
        });
        return;
    }
    if (opts.duration !== undefined && !isFiniteNumber(opts.duration)) {
        reportRejection("fitBounds", "duration is not finite");
        return;
    }
    // Padding that exceeds the viewport makes the derived zoom NaN, and NaN
    // survives Mapbox's min/max clamp.
    if (map.cameraForBounds) {
        const cam = map.cameraForBounds(
            [
                sw as unknown as [number, number],
                ne as unknown as [number, number],
            ],
            opts as Record<string, unknown>,
        );
        if (!cam || !Number.isFinite(cam.zoom)) {
            reportRejection(
                "fitBounds",
                "computed zoom is non-finite (padding exceeds viewport, degenerate bounds, or unsized canvas)",
            );
            return;
        }
    }
    if (!ensureCleanCamera(map, sw)) return;

    map.stop();
    map.fitBounds(
        [
            sw as unknown as [number, number],
            ne as unknown as [number, number],
        ],
        opts as Record<string, unknown>,
    );
}

export type SafeJumpToOptions = {
    center?: CoordInput;
    zoom?: number;
    bearing?: number;
    pitch?: number;
};

export function safeJumpTo(map: CameraMap, opts: SafeJumpToOptions): void {
    if (opts.center !== undefined && !isFiniteCoord(opts.center)) {
        reportRejection("jumpTo", "center is not finite");
        return;
    }
    if (opts.zoom !== undefined && !isFiniteNumber(opts.zoom)) {
        reportRejection("jumpTo", "zoom is not finite");
        return;
    }
    map.jumpTo(opts);
}

export type SafeEaseToOptions = {
    center?: CoordInput;
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
    padding?: { top?: number; bottom?: number; left?: number; right?: number };
    essential?: boolean;
};

export function safeEaseTo(map: CameraMap, opts: SafeEaseToOptions): void {
    if (opts.center !== undefined && !isFiniteCoord(opts.center)) {
        reportRejection("easeTo", "center is not finite");
        return;
    }
    if (opts.zoom !== undefined && !isFiniteNumber(opts.zoom)) {
        reportRejection("easeTo", "zoom is not finite");
        return;
    }
    if (opts.duration !== undefined && !isFiniteNumber(opts.duration)) {
        reportRejection("easeTo", "duration is not finite");
        return;
    }
    if (!ensureCleanCamera(map, opts.center, opts.zoom)) return;

    map.stop();
    map.easeTo(opts);
}

// getBounds() throws on a momentarily degenerate transform; null means skip this frame.
export function safeGetBounds<T>(map: {
    getZoom(): number;
    getBounds(): T;
}): T | null {
    if (!isFiniteNumber(map.getZoom())) {
        reportRejection("getBounds", "camera zoom is not finite");
        return null;
    }
    try {
        return map.getBounds();
    } catch (e) {
        reportRejection("getBounds", String(e));
        return null;
    }
}
