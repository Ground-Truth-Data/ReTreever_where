// The font stack for every symbol layer, chosen from the LIVE map: no single
// `text-font` resolves on both the hosted style and the bundled offline glyphs,
// and Mapbox re-asks for a missing font range on every tile, forever.
// Never hardcode a `text-font` array in a layer definition.
//
// TODO: duplicated verbatim in getCache_OnlineMap/lib/draw/glyphStack.ts — collapse into shared OSEM code.
import type { Map as MapboxMap } from "mapbox-gl";

const OFFLINE_STACK = ["Noto Sans Regular"];
const ONLINE_STACK = ["DIN Pro Medium", "Arial Unicode MS Bold"];
const ONLINE_STACK_BOLD = ["DIN Pro Bold", "Arial Unicode MS Bold"];

// Match the path, not a leading slash: an absolute same-origin URL is still our glyphs.
const BUNDLED_PATH = "/mobileAssets/worldBase/glyphs/";

/** Unknown (style not loaded yet) reads as online: a wrong guess costs a fallback, not a crash. */
export function usesBundledGlyphs(map: MapboxMap): boolean {
	try {
		const glyphs = map.getStyle?.()?.glyphs;
		return typeof glyphs === "string" && glyphs.includes(BUNDLED_PATH);
	} catch {
		return false;
	}
}

export function glyphStack(map: MapboxMap, weight: "medium" | "bold" = "medium"): string[] {
	if (usesBundledGlyphs(map)) return OFFLINE_STACK;
	return weight === "bold" ? ONLINE_STACK_BOLD : ONLINE_STACK;
}
