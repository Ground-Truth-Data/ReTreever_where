import { describe, expect, it } from "vitest";
import { pinsFromCentroids } from "./centroidPins";

describe("pinsFromCentroids — the arrays become Points, nothing more", () => {
    it("numbers each pin, pairs it with its lon/lat and reads the size flag", () => {
        const fc = pinsFromCentroids({
            build: "b1",
            lonlat: [10, 20, 30.5, -40.25, 50, 60],
            large: [0, 1, 2],
        });

        expect(fc.features.map((f) => f.geometry.coordinates)).toEqual([
            [10, 20],
            [30.5, -40.25],
            [50, 60],
        ]);
        expect(fc.features.map((f) => f.properties)).toEqual([
            { pin: 0, isLargePolygon: false, isAbsoluteTooLarge: false },
            { pin: 1, isLargePolygon: true, isAbsoluteTooLarge: false },
            { pin: 2, isLargePolygon: true, isAbsoluteTooLarge: true },
        ]);
    });

    it("stops at the shortest array, drops a non-finite coordinate and keeps the dropped pin's number free", () => {
        const fc = pinsFromCentroids({
            build: "b1",
            lonlat: [10, 20, Number.NaN, 5, 1, 2, 3, 4],
            large: [0, 0, 0],
        });

        expect(fc.features.map((f) => f.properties.pin)).toEqual([0, 2]);
    });

    it("no artifact, no pins", () => {
        expect(pinsFromCentroids(null).features).toEqual([]);
        expect(pinsFromCentroids(undefined).features).toEqual([]);
    });
});
