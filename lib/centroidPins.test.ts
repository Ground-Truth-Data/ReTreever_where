import { describe, expect, it } from "vitest";
import { pinsFromCentroids } from "./centroidPins";

describe("pinsFromCentroids — the arrays become Points, nothing more", () => {
    it("pairs each id with its lon/lat and reads the size flag", () => {
        const fc = pinsFromCentroids({
            ids: ["a", "b", "c"],
            lonlat: [10, 20, 30.5, -40.25, 50, 60],
            large: [0, 1, 2],
        });

        expect(fc.features.map((f) => f.geometry.coordinates)).toEqual([
            [10, 20],
            [30.5, -40.25],
            [50, 60],
        ]);
        expect(fc.features.map((f) => f.properties)).toEqual([
            { polygonId: "a", isLargePolygon: false, isAbsoluteTooLarge: false },
            { polygonId: "b", isLargePolygon: true, isAbsoluteTooLarge: false },
            { polygonId: "c", isLargePolygon: true, isAbsoluteTooLarge: true },
        ]);
    });

    it("stops at the shortest array and drops a non-finite coordinate", () => {
        const fc = pinsFromCentroids({
            ids: ["a", "b", "c"],
            lonlat: [10, 20, Number.NaN, 5, 1, 2, 3, 4],
            large: [0, 0],
        });

        expect(fc.features.map((f) => f.properties.polygonId)).toEqual(["a"]);
    });

    it("no artifact, no pins", () => {
        expect(pinsFromCentroids(null).features).toEqual([]);
        expect(pinsFromCentroids(undefined).features).toEqual([]);
    });
});
