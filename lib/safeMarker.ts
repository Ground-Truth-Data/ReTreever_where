// Prototype patches that keep NaN out of Mapbox's non-camera paths; safeMap.ts covers the camera.

import type {
	Feature,
	FeatureCollection,
	GeoJsonProperties,
	Geometry,
} from "geojson";
import mapboxgl from "mapbox-gl";
import { isCoord } from "./coord";

const MARKER_INSTALLED = Symbol.for("retreever.safeMarker.installed");
const POPUP_INSTALLED = Symbol.for("retreever.safePopup.installed");
const SOURCE_INSTALLED = Symbol.for("retreever.safeSource.installed");
const ADDSOURCE_INSTALLED = Symbol.for("retreever.safeAddSource.installed");
const OPACITY_INSTALLED = Symbol.for("retreever.safeMarkerOpacity.installed");
const RENDER_INSTALLED = Symbol.for("retreever.safeRender.installed");
const COVERINGTILES_INSTALLED = Symbol.for(
	"retreever.safeCoveringTiles.installed",
);
const UNPROJECT_INSTALLED = Symbol.for("retreever.safeUnproject.installed");

type LngLatLike =
	| [number, number]
	| { lng: number; lat: number }
	| { lon: number; lat: number };

function lngLatIsFinite(p: unknown): boolean {
	if (Array.isArray(p)) {
		return p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
	}
	if (p && typeof p === "object") {
		const o = p as { lng?: unknown; lon?: unknown; lat?: unknown };
		const lng = o.lng ?? o.lon;
		return Number.isFinite(lng) && Number.isFinite(o.lat);
	}
	return false;
}

function patchSetLngLat(
	proto:
		| (Record<string, unknown> & {
				setLngLat?: (p: LngLatLike) => unknown;
		  })
		| undefined,
	installedKey: symbol,
	tag: string,
): void {
	if (!proto || typeof proto.setLngLat !== "function") return;
	if ((proto as Record<symbol, unknown>)[installedKey]) return;

	const original = proto.setLngLat;
	proto.setLngLat = function patched(this: unknown, p: LngLatLike) {
		if (!lngLatIsFinite(p)) {
			const err = new Error(`${tag}.setLngLat rejected non-finite coord`);
			console.error(`[${tag.toLowerCase()}NanGuard]`, p, err.stack);
			return this;
		}
		return (original as (p: LngLatLike) => unknown).call(this, p);
	} as typeof proto.setLngLat;

	(proto as Record<symbol, unknown>)[installedKey] = true;
}

export function installMarkerNanGuard(): void {
	patchSetLngLat(
		mapboxgl?.Marker?.prototype as unknown as Parameters<typeof patchSetLngLat>[0],
		MARKER_INSTALLED,
		"Marker",
	);
}

export function installPopupNanGuard(): void {
	patchSetLngLat(
		mapboxgl?.Popup?.prototype as unknown as Parameters<typeof patchSetLngLat>[0],
		POPUP_INSTALLED,
		"Popup",
	);
}

// Only Point geometries are checked; NaN lines/polygons would need a deeper walk.
function filterFiniteFeatures(
	data: FeatureCollection<Geometry, GeoJsonProperties> | Feature | unknown,
): typeof data {
	if (!data || typeof data !== "object") return data;
	const d = data as { type?: string; features?: unknown };
	if (d.type === "FeatureCollection" && Array.isArray(d.features)) {
		let dropped = 0;
		const safe = (d.features as Feature[]).filter((f) => {
			if (!f?.geometry) return false;
			if (f.geometry.type !== "Point") return true;
			const ok = isCoord(f.geometry.coordinates);
			if (!ok) dropped++;
			return ok;
		});
		if (dropped > 0) {
			console.error(
				`[sourceNanGuard] dropped ${dropped} non-finite Point feature(s)`,
				new Error("setData received non-finite coords").stack,
			);
		}
		if (safe.length === (d.features as Feature[]).length) return data;
		return { ...(data as object), features: safe } as typeof data;
	}
	if (d.type === "Feature") {
		const f = data as Feature;
		if (f.geometry?.type === "Point" && !isCoord(f.geometry.coordinates)) {
			console.error(
				"[sourceNanGuard] rejected non-finite Point feature",
				new Error("setData received non-finite coord").stack,
			);
			return { ...f, geometry: { ...f.geometry, coordinates: [0, 0] } };
		}
	}
	return data;
}

export function installGeoJSONSourceNanGuard(): void {
	const Source = (
		mapboxgl as unknown as {
			GeoJSONSource?: { prototype?: Record<string, unknown> };
		}
	).GeoJSONSource;
	const proto = Source?.prototype as
		| (Record<string, unknown> & {
				setData?: (d: unknown) => unknown;
		  })
		| undefined;
	if (!proto || typeof proto.setData !== "function") return;
	if ((proto as Record<symbol, unknown>)[SOURCE_INSTALLED]) return;

	const original = proto.setData;
	proto.setData = function patched(this: unknown, data: unknown) {
		const safe = filterFiniteFeatures(data);
		return (original as (d: unknown) => unknown).call(this, safe);
	} as typeof proto.setData;

	(proto as Record<symbol, unknown>)[SOURCE_INSTALLED] = true;
}

export function installAddSourceNanGuard(): void {
	const proto = (
		mapboxgl as unknown as {
			Map?: { prototype?: Record<string, unknown> };
		}
	).Map?.prototype as
		| (Record<string, unknown> & {
				addSource?: (id: string, source: unknown) => unknown;
		  })
		| undefined;
	if (!proto || typeof proto.addSource !== "function") return;
	if ((proto as Record<symbol, unknown>)[ADDSOURCE_INSTALLED]) return;

	const original = proto.addSource;
	proto.addSource = function patched(
		this: unknown,
		id: string,
		source: unknown,
	) {
		const s = source as { type?: string; data?: unknown } | null;
		if (s && s.type === "geojson" && s.data && typeof s.data === "object") {
			const safe = filterFiniteFeatures(s.data);
			if (safe !== s.data) {
				return (
					original as (id: string, src: unknown) => unknown
				).call(this, id, { ...s, data: safe });
			}
		}
		return (original as (id: string, src: unknown) => unknown).call(
			this,
			id,
			source,
		);
	} as typeof proto.addSource;

	(proto as Record<symbol, unknown>)[ADDSOURCE_INSTALLED] = true;
}

// The per-frame occlusion fade throws on a momentarily degenerate transform; cosmetic, so a bad frame keeps the previous opacity.
let opacityGuardLogged = false;
export function installMarkerOpacityGuard(): void {
	const proto = mapboxgl?.Marker?.prototype as unknown as
		| (Record<string, unknown> & { _evaluateOpacity?: () => unknown })
		| undefined;
	if (!proto || typeof proto._evaluateOpacity !== "function") return;
	if ((proto as Record<symbol, unknown>)[OPACITY_INSTALLED]) return;

	const original = proto._evaluateOpacity;
	proto._evaluateOpacity = function patched(this: unknown) {
		try {
			return (original as () => unknown).call(this);
		} catch (err) {
			if (!opacityGuardLogged) {
				opacityGuardLogged = true;
				console.error(
					"[markerOpacityGuard] suppressed _evaluateOpacity throw " +
						"(degenerate camera transform); marker opacity fade " +
						"skipped this frame.",
					err,
				);
			}
			return undefined;
		}
	} as typeof proto._evaluateOpacity;

	(proto as Record<symbol, unknown>)[OPACITY_INSTALLED] = true;
}

// One try/catch under the whole frame rather than one per Mapbox throw site.
let renderGuardLogged = false;
export function installRenderGuard(): void {
	const proto = mapboxgl?.Map?.prototype as unknown as
		| (Record<string, unknown> & { _render?: (...a: unknown[]) => unknown })
		| undefined;
	if (!proto || typeof proto._render !== "function") return;
	if ((proto as Record<symbol, unknown>)[RENDER_INSTALLED]) return;

	const original = proto._render;
	proto._render = function patched(this: unknown, ...args: unknown[]) {
		try {
			return (original as (...a: unknown[]) => unknown).apply(this, args);
		} catch (err) {
			if (!renderGuardLogged) {
				renderGuardLogged = true;
				console.error(
					"[renderGuard] suppressed a throw inside Map._render " +
						"(degenerate camera transform for one frame); frame " +
						"skipped, rendering continues.",
					err,
				);
			}
			return undefined;
		}
	} as typeof proto._render;

	(proto as Record<symbol, unknown>)[RENDER_INSTALLED] = true;
}

// coveringTiles runs outside _render, so the render guard misses it; patches the shared prototype off a live map instead.
let coveringTilesGuardLogged = false;
export function installCoveringTilesGuard(map: unknown): void {
	const tf = (map as { transform?: unknown } | null)?.transform;
	if (!tf || typeof tf !== "object") return;
	const proto = Object.getPrototypeOf(tf) as
		| (Record<string, unknown> & {
				coveringTiles?: (...a: unknown[]) => unknown;
		  })
		| null;
	if (!proto || typeof proto.coveringTiles !== "function") return;
	if ((proto as Record<symbol, unknown>)[COVERINGTILES_INSTALLED]) return;

	const original = proto.coveringTiles;
	proto.coveringTiles = function patched(this: unknown, ...args: unknown[]) {
		try {
			return (original as (...a: unknown[]) => unknown).apply(this, args);
		} catch (err) {
			// codestyle-allow-swallow: a degenerate-camera throw inside coveringTiles is suppressed + logged once; the next good tick recomputes tiles
			if (!coveringTilesGuardLogged) {
				coveringTilesGuardLogged = true;
				console.error(
					"[coveringTilesGuard] suppressed a throw inside " +
						"Transform.coveringTiles (non-invertible projection " +
						"matrix — degenerate camera transform). No tiles for " +
						"this source update; the next good tick recomputes.",
					err,
				);
			}
			return [];
		}
	} as typeof proto.coveringTiles;

	(proto as Record<symbol, unknown>)[COVERINGTILES_INSTALLED] = true;
}

// Mapbox's internal mousemove handler throws on a briefly degenerate transform; a (0,0) sentinel for one frame is harmless.
export function installUnprojectNanGuard(): void {
	const MapCtor = (
		mapboxgl as unknown as {
			Map?: { prototype?: Record<string, unknown> };
		}
	).Map;
	const proto = MapCtor?.prototype as
		| (Record<string, unknown> & {
				unproject?: (p: unknown) => unknown;
		  })
		| undefined;
	if (!proto || typeof proto.unproject !== "function") return;
	if ((proto as Record<symbol, unknown>)[UNPROJECT_INSTALLED]) return;

	const original = proto.unproject;
	let warnedOnce = false;
	const sentinel = () => new mapboxgl.LngLat(0, 0);
	proto.unproject = function patched(this: unknown, p: unknown) {
		try {
			const result = (original as (p: unknown) => mapboxgl.LngLat).call(
				this,
				p,
			);
			if (
				!result ||
				!Number.isFinite(result.lng) ||
				!Number.isFinite(result.lat)
			) {
				if (!warnedOnce) {
					console.warn(
						"[unprojectNanGuard] Map.unproject returned non-finite LngLat — substituting (0,0). Transient degenerate transform (likely canvas 0×0 during overlay reflow).",
					);
					warnedOnce = true;
				}
				return sentinel();
			}
			return result;
		} catch (err) {
			if (!warnedOnce) {
				console.warn(
					"[unprojectNanGuard] Map.unproject threw — substituting (0,0).",
					err,
				);
				warnedOnce = true;
			}
			return sentinel();
		}
	} as typeof proto.unproject;

	(proto as Record<symbol, unknown>)[UNPROJECT_INSTALLED] = true;
}

export function installMapboxNanGuards(): void {
	installMarkerNanGuard();
	installPopupNanGuard();
	installGeoJSONSourceNanGuard();
	installAddSourceNanGuard();
	installMarkerOpacityGuard();
	installRenderGuard();
	installUnprojectNanGuard();
}
