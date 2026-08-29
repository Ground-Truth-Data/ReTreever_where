/** A spot the visitor starred; coords captured at favourite time so the map can fly back without refetching centroids. */
export type FavouriteLocation = {
	landKey: string;
	landName: string;
	lng: number;
	lat: number;
};

/** Where the marker box can send you; the host fills these in — a child running on rapper has nowhere to go, so every entry is optional. */
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
