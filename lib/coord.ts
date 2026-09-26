// A branded, validated [lng, lat]: only the `toCoord*` factories can mint one.
// A NaN reaching Mapbox crashes deep in its render loop with a stack that
// names no caller, so validation happens where raw coords enter.

declare const CoordBrand: unique symbol;

export type Coord = readonly [number, number] & {
    readonly [CoordBrand]: true;
};

export function toCoord(lng: unknown, lat: unknown): Coord | null {
    if (typeof lng !== "number" || typeof lat !== "number") return null;
    if (!(Math.abs(lng) <= 180 && Math.abs(lat) <= 90)) return null;
    return [lng, lat] as unknown as Coord;
}

export function toCoordFromArray(a: unknown): Coord | null {
    return Array.isArray(a) ? toCoord(a[0], a[1]) : null;
}

/** A map feature's point, or its centroid — which may be a JSON string, since Mapbox serializes feature properties. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function featureCoord(f: any): Coord | null {
    let raw = f?.geometry?.coordinates ?? f?.centroid?.coordinates;
    if (!raw && typeof f?.centroid === "string") {
        try {
            raw = JSON.parse(f.centroid)?.coordinates;
            // codestyle-allow-swallow: a malformed centroid is just no coordinate
        } catch {}
    }
    return toCoordFromArray(raw);
}

export function isCoord(c: unknown): c is Coord {
    return toCoordFromArray(c) !== null;
}
