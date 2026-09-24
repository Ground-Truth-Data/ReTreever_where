// A branded, validated [lng, lat]: only the `toCoord*` factories can mint one.
// A NaN reaching Mapbox crashes deep in its render loop with a stack that
// names no caller, so validation happens where raw coords enter.

declare const CoordBrand: unique symbol;

export type Coord = readonly [number, number] & {
    readonly [CoordBrand]: true;
};

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

export function toCoordFromFeature(
    f: { geometry?: { coordinates?: unknown } } | null | undefined,
): Coord | null {
    if (!f) return null;
    return toCoordFromArray(f.geometry?.coordinates);
}

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
