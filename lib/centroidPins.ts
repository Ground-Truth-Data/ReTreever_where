import type { Feature, FeatureCollection, Point } from "geojson";
import type { Centroids } from "./whereTypes";

/** What a pin carries: enough to cluster, to zoom, and to be asked for by its number. */
export type PinProperties = {
    pin: number;
    isLargePolygon: boolean;
    isAbsoluteTooLarge: boolean;
};

export function pinsFromCentroids(
    c: Centroids | null | undefined,
): FeatureCollection<Point, PinProperties> {
    const features: Feature<Point, PinProperties>[] = [];
    if (!c) return { type: "FeatureCollection", features };
    const n = Math.min(c.large.length, c.lonlat.length >> 1);
    for (let i = 0; i < n; i++) {
        const lon = c.lonlat[2 * i];
        const lat = c.lonlat[2 * i + 1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: {
                pin: i,
                isLargePolygon: c.large[i] >= 1,
                isAbsoluteTooLarge: c.large[i] === 2,
            },
        });
    }
    return { type: "FeatureCollection", features };
}

// Positions are rounded to 5 places at build time; this absorbs the float noise of that rounding, no more.
const SAME_PLACE_DEG = 1.5e-5;

/** The number `c` gives the pin at `[lon, lat]`, or null: a pin's number changes between builds, its place does not. */
export function pinAt(c: Centroids, lon: number, lat: number): number | null {
    const n = Math.min(c.large.length, c.lonlat.length >> 1);
    let best: number | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
        const dLon = Math.abs(c.lonlat[2 * i] - lon);
        const dLat = Math.abs(c.lonlat[2 * i + 1] - lat);
        if (dLon > SAME_PLACE_DEG || dLat > SAME_PLACE_DEG) continue;
        if (dLon + dLat < bestD) {
            best = i;
            bestD = dLon + dLat;
        }
    }
    return best;
}
