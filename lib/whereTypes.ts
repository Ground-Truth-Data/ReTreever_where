/** The pins as the host serves them: pin `i` sits at `lonlat[2i], lonlat[2i+1]`; `large[i]` is 0 small, 1 large, 2 past the render cap. Its polygon key is `CentroidIds.ids[i]` of the same `build`. */
export type Centroids = { build: string; lonlat: number[]; large: number[] };

/** The pins' polygon keys, three times the pins' bytes, fetched beside them and read on the first click. `build` equals `Centroids.build` only when both came from one set of rows. */
export type CentroidIds = { build: string; ids: string[] };

/** Coords captured at favourite time so the map can fly back without refetching centroids. */
export type FavouriteLocation = {
	landKey: string;
	landName: string;
	lng: number;
	lat: number;
};

/** The host fills these in; a standalone child has nowhere to go. */
export type WhereRoutes = {
	what?: string;
	whatProject?: (key: string) => string;
	whoOrg?: (key: string) => string;
};

/** 0–100 → "73.3%". Non-numeric → an em dash, never "NaN%". */
export function formatTransparencyScore(score: unknown): string {
	const n = Number(score);
	return Number.isFinite(n) ? `${n.toFixed(1)}%` : "—";
}
