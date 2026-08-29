// Coord: a [lng, lat] tuple, branded and validated — build one only via toCoord/toCoordFromArray/etc.
// ⚠️ Never let NaN/Infinity/out-of-range values reach Mapbox — it crashes deep in projection math with an unhelpful stack; validate at the boundary.

declare const CoordBrand: unique symbol;

export type Coord = readonly [number, number] & {
    readonly [CoordBrand]: true;
};

// Geographic bounds — out-of-range values are usually swapped lng/lat or unconverted radians; Mapbox wraps weirdly or produces NaN.
const LNG_MIN = -180;
const LNG_MAX = 180;
const LAT_MIN = -90;
const LAT_MAX = 90;

function inRange(lng: number, lat: number): boolean {
    return lng >= LNG_MIN && lng <= LNG_MAX && lat >= LAT_MIN && lat <= LAT_MAX;
}

export function toCoord(lng: unknown, lat: unknown): Coord | null {
    if (typeof lng !== "number" || typeof lat !== "number") return null;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (!inRange(lng, lat)) return null;
    return [lng, lat] as unknown as Coord;
}

export function toCoordFromLngLat(
    p: { lng?: unknown; lat?: unknown } | null | undefined,
): Coord | null {
    if (!p) return null;
    return toCoord(p.lng, p.lat);
}

export function toCoordFromArray(a: unknown): Coord | null {
    if (!Array.isArray(a)) return null;
    return toCoord(a[0], a[1]);
}

// Common shape: GeoJSON Point feature, or anything with geometry.coordinates.
export function toCoordFromFeature(
    f: { geometry?: { coordinates?: unknown } } | null | undefined,
): Coord | null {
    if (!f) return null;
    return toCoordFromArray(f.geometry?.coordinates);
}

// Runtime predicate for values already believed valid but unproven to the type system (e.g. an any/unknown boundary) — prefer toCoord/toCoordFromArray for new code.
export function isCoord(c: unknown): c is Coord {
    if (!Array.isArray(c) || c.length < 2) return false;
    const [lng, lat] = c;
    return (
        typeof lng === "number" &&
        typeof lat === "number" &&
        Number.isFinite(lng) &&
        Number.isFinite(lat) &&
        inRange(lng, lat)
    );
}
