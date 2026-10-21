import type { Feature, FeatureCollection, Point } from "geojson";
import type { Centroids } from "./whereTypes";

/** What a pin carries: enough to cluster, to zoom, and to ask `?id=` for the rest. */
export type PinProperties = {
    polygonId: string;
    isLargePolygon: boolean;
    isAbsoluteTooLarge: boolean;
};

export function pinsFromCentroids(
    c: Centroids | null | undefined,
): FeatureCollection<Point, PinProperties> {
    const features: Feature<Point, PinProperties>[] = [];
    if (!c) return { type: "FeatureCollection", features };
    const n = Math.min(c.ids.length, c.large.length, c.lonlat.length >> 1);
    for (let i = 0; i < n; i++) {
        const lon = c.lonlat[2 * i];
        const lat = c.lonlat[2 * i + 1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties: {
                polygonId: c.ids[i],
                isLargePolygon: c.large[i] >= 1,
                isAbsoluteTooLarge: c.large[i] === 2,
            },
        });
    }
    return { type: "FeatureCollection", features };
}
