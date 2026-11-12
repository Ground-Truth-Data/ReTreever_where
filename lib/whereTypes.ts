/** The pins as the host serves them: pin `i` sits at `lonlat[2i], lonlat[2i+1]`; `large[i]` is 0 small, 1 large, 2 past the render cap. A click asks the host for `<build>/<i>`: no key list reaches the browser. */
export type Centroids = { build: string; lonlat: number[]; large: number[] };

/** The small polygons as static vector tiles of `build`: `tiles` ends `/{z}/{x}/{y}.pbf`, one layer `polygons`, each feature carrying only `pin`, its number in that build. */
export type PolygonTiles = {
	build: string;
	tiles: string;
	minzoom: number;
	maxzoom: number;
	/** Maps a tile request's URL to the one to fetch; a URL these tiles don't own comes back unchanged. */
	tileUrl: (url: string) => string;
};

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
