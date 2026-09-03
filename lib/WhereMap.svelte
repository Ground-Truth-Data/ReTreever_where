<script lang="ts">
import { onMount } from "svelte";
import { goto, replaceState } from "$app/navigation";
import { page } from "$app/stores";
import "mapbox-gl/dist/mapbox-gl.css";
import {
	fullMapOptions,
	initializeMap,
} from "$parent/siblings/getCache_OnlineMap/lib/mapInit";
import { defaultOptions } from "$parent/siblings/getCache_OnlineMap/lib/mapConfig";
import { safeEase } from "./safeEase";
import { safeJumpTo } from "./safeMap";
import {
	toCoordFromArray,
	type Coord,
} from "./coord";

// Map-engine wiring for /retreeve/where — rapper stays the engine (mapInit, safeEase, draw sources); this file is just the glue.
let {
	map = $bindable(null),
	selectedFeature = $bindable(null),
	viewChanged = $bindable(false),
	markerUrl = undefined,
	polygonsUrl,
	userLocation = null,
	ensureMapboxGuards = async () => {},
}: {
	map: import("mapbox-gl").Map | null;
	selectedFeature: any;
	/** True once the camera has left the home globe view — drives the reset button. */
	viewChanged?: boolean;
	markerUrl?: string;
	/** Full URL returning polygon GeoJSON — supplied by the CONSUMER. */
	polygonsUrl?: string;
	/** [lng, lat] of the visitor, once they've allowed location. Draws the dot. */
	userLocation?: [number, number] | null;
	/** Awaited before the map is built — must patch mapbox's prototypes before the first `new Map`. */
	ensureMapboxGuards?: () => Promise<void>;
} = $props();

let mapContainer: HTMLDivElement;
let splashVisible = $state(true);
// Deep-link target may resolve before or after the map — coordinate.
let pendingFeature: any = null;

const HOME_CENTER: [number, number] = fullMapOptions.initialCenter ?? [
	defaultOptions.initialCenter[0],
	defaultOptions.initialCenter[1],
];
const MOBILE_HOME_ZOOM = 3.5;
/** Settled in onMount — a phone boots closer in than the desktop globe. */
let homeZoom = fullMapOptions.initialZoom ?? defaultOptions.initialZoom;
// Rotation stops (and hash sync starts) at this zoom — see MAP_CONFIG.globe.
const SPIN_MAX_ZOOM = 4;

function flyToAndSelect(m: import("mapbox-gl").Map, feature: any) {
	selectedFeature = feature;
	// centroid may be a parsed object or a JSON string; toCoordFromArray guards against NaN/out-of-range values.
	let raw: unknown = null;
	if (feature?.geometry?.coordinates) {
		raw = feature.geometry.coordinates;
	} else if (feature?.centroid?.coordinates) {
		raw = feature.centroid.coordinates;
	} else if (typeof feature?.centroid === "string") {
		try {
			raw = JSON.parse(feature.centroid)?.coordinates ?? null;
			// codestyle-allow-swallow: malformed centroid string leaves raw null; the ease is skipped
		} catch {}
	}
	const coords: Coord | null = toCoordFromArray(raw);
	if (coords) {
		safeEase(m, { center: coords, zoom: 14, duration: 1200 });
	}
}

/** Ignores centre deliberately — home-zoom auto-rotation would make it read "changed" every frame; zoom/bearing/pitch are what actually mean the user navigated. */
function syncViewChanged() {
	const m = map;
	if (!m) return;
	viewChanged =
		m.getZoom() > homeZoom + 0.35 ||
		m.getBearing() !== 0 ||
		m.getPitch() !== 0;
}

// Resets to home globe, north up, nothing selected, no deep-link in URL.
export function resetView() {
	selectedFeature = null;
	pendingFeature = null;

	// Drop ?land=/?projectName= first — leaving them re-flies to the old polygon on refresh.
	const url = new URL($page.url);
	url.searchParams.delete("land");
	url.searchParams.delete("projectName");
	void goto(`${url.pathname}${url.search}`, {
		replaceState: true,
		noScroll: true,
	});

	const m = map;
	if (!m) return;

	// Bearing/pitch snap BEFORE the ease — a mid-ease jumpTo would fight safeEase's per-frame one.
	if (m.getBearing() !== 0 || m.getPitch() !== 0) {
		safeJumpTo(m, { bearing: 0, pitch: 0 });
	}
	safeEase(m, { center: HOME_CENTER, zoom: homeZoom, duration: 1600 });

	// Hash is only cleared once zoom drops below the spin threshold — clearing earlier gets rewritten by the ease's own moveends.
	const stripHash = () => {
		if (m.getZoom() >= SPIN_MAX_ZOOM) return;
		m.off("moveend", stripHash);
		if (window.location.hash) {
			// Through the router — a raw history.replaceState desyncs SvelteKit's history index.
			replaceState(window.location.pathname + window.location.search, {});
		}
	};
	m.on("moveend", stripHash);
}

// User-location dot: three Mapbox circle layers (halo/ring/core), not a DOM marker, so it doesn't drift during the ease.
const USER_DOT_SOURCE = "rt-user-location";

function pointFeature(coords: [number, number]) {
	return {
		type: "FeatureCollection" as const,
		features: [
			{
				type: "Feature" as const,
				properties: {},
				geometry: { type: "Point" as const, coordinates: coords },
			},
		],
	};
}

$effect(() => {
	const m = map;
	const loc = userLocation;
	if (!m || !loc) return;

	// Style must be loaded before addSource/addLayer, and a style swap wipes both — redraw on `styledata` too.
	function draw() {
		if (!m || !loc) return;
		// Plain JSON only across the Mapbox boundary — a $state proxy corrupts the GL worker transfer.
		const data = pointFeature([loc[0], loc[1]]);
		const existing = m.getSource(USER_DOT_SOURCE) as
			| import("mapbox-gl").GeoJSONSource
			| undefined;
		if (existing) {
			existing.setData(data);
			return;
		}
		m.addSource(USER_DOT_SOURCE, { type: "geojson", data });
		m.addLayer({
			id: `${USER_DOT_SOURCE}-halo`,
			type: "circle",
			source: USER_DOT_SOURCE,
			paint: {
				"circle-radius": 18,
				"circle-color": "#1a73e8",
				"circle-opacity": 0.18,
				"circle-blur": 0.35,
			},
		});
		m.addLayer({
			id: `${USER_DOT_SOURCE}-ring`,
			type: "circle",
			source: USER_DOT_SOURCE,
			paint: {
				"circle-radius": 9,
				"circle-color": "#ffffff",
			},
		});
		m.addLayer({
			id: `${USER_DOT_SOURCE}-core`,
			type: "circle",
			source: USER_DOT_SOURCE,
			paint: {
				"circle-radius": 6.5,
				"circle-color": "#1a73e8",
			},
		});
	}

	if (m.isStyleLoaded()) draw();
	else m.once("style.load", draw);
	m.on("styledata", draw);
	return () => {
		m.off("styledata", draw);
	};
});

// Blocks trackpad-pinch page zoom (ctrlKey wheel + Safari gesture events) — without this, pinching zooms the whole page instead of the map.
function blockBrowserZoom() {
	const blockWheel = (e: WheelEvent) => {
		if (e.ctrlKey) e.preventDefault();
	};
	const blockGesture = (e: Event) => e.preventDefault();
	const opts = { capture: true, passive: false } as AddEventListenerOptions;
	document.addEventListener("wheel", blockWheel, opts);
	document.addEventListener("gesturestart", blockGesture, opts);
	document.addEventListener("gesturechange", blockGesture, opts);
	document.addEventListener("gestureend", blockGesture, opts);
	return () => {
		document.removeEventListener("wheel", blockWheel, { capture: true });
		document.removeEventListener("gesturestart", blockGesture, {
			capture: true,
		});
		document.removeEventListener("gesturechange", blockGesture, {
			capture: true,
		});
		document.removeEventListener("gestureend", blockGesture, {
			capture: true,
		});
	};
}

onMount(() => {
	let disposed = false;
	let mapCleanup: (() => void) | undefined;
	const cleanupZoomBlock = blockBrowserZoom();

	void (async () => {
		// Guards must patch mapbox's prototypes before the map is built.
		await ensureMapboxGuards();
		if (disposed) return;

		// Deliberately same-origin/relative — an absolute PUBLIC_API_URL host breaks on retreever.localhost (see ac3225dc); safe only because /where is dt-web-only, never Capacitor.
		const landParam = $page.url.searchParams.get("land");
		const projectNameParam = $page.url.searchParams.get("projectName");
		const hasTarget = !!(landParam || projectNameParam);

		fullMapOptions.autoRotate = !hasTarget;
		// Live "z3.4" in the bottom-right corner — debug aid.
		fullMapOptions.showZoomReadout = true;
		// Attribution bottom-LEFT; mapbox wordmark bottom-RIGHT, joining the zoom readout in the gold border's corner cutout.
		fullMapOptions.creditsSplit = true;
		// Scale bar stays bottom-LEFT (mapbox default) with the wordmark; the right corner holds only the zoom readout.

		const isMobile = window.innerWidth < 768;
		if (isMobile) homeZoom = MOBILE_HOME_ZOOM;

		const handleFeatureSelect = (feature: any) => {
			selectedFeature = feature;
			if (feature?.landKey) {
				// Current pathname, so /where/orgs stays /where/orgs — a hard-coded `/where` dropped the view segment on every marker tap.
				const base = $page.url.pathname;
				goto(`${base}?land=${encodeURIComponent(feature.landKey)}`, {
					replaceState: true,
					noScroll: true,
				});
			}
		};

		mapCleanup = initializeMap(mapContainer, {
			...fullMapOptions,
			// The page draws its own zoom buttons and style switcher in the gold border's slot art; only the scale bar is Mapbox's.
			showNavigation: false,
			showStyleControl: false,
			showScale: true,
			enableHash: true,
			// Through the router, not raw history — see mapUtilsHash.
			writeHash: (url) => replaceState(url, {}),
			...(isMobile && {
				showDrawTools: false,
				initialZoom: MOBILE_HOME_ZOOM,
			}),
			polygonsUrl,
			...(markerUrl && { markerUrl }),
			onFeatureSelect: handleFeatureSelect,
			onMapReady: (m) => {
				map = m;
				m.once("idle", () => {
					splashVisible = false;
				});
				setTimeout(() => {
					splashVisible = false;
				}, 3000);
				// moveend fires every frame during rAF spin/safeEase; syncViewChanged only writes a boolean, so this is cheap.
				m.on("moveend", syncViewChanged);
				syncViewChanged();
				if (pendingFeature) {
					flyToAndSelect(m, pendingFeature);
					pendingFeature = null;
				}
			},
		});

		// Fetch the deep-link target in parallel with map load.
		if (hasTarget && polygonsUrl) {
			(async () => {
				try {
					const response = await fetch(
						`${polygonsUrl}${polygonsUrl.includes("?") ? "&" : "?"}mode=centroids`,
					);
					if (!response.ok) return;
					const data = await response.json();
					let targetFeature: any = null;
					if (landParam) {
						const match = data.features?.find(
							(f: any) =>
								f.properties?.landKey === landParam || f.id === landParam,
						);
						targetFeature = match?.properties ?? null;
					} else if (projectNameParam) {
						const match = data.features?.find(
							(f: any) => f.properties?.projectName === projectNameParam,
						);
						targetFeature = match?.properties ?? null;
					}
					if (!targetFeature) return;
					if (map) {
						flyToAndSelect(map, targetFeature);
					} else {
						pendingFeature = targetFeature;
					}
				} catch (error) {
					console.error("Error pre-loading feature:", error);
				}
			})();
		}
	})();

	return () => {
		disposed = true;
		mapCleanup?.();
		cleanupZoomBlock();
		map = null;
	};
});
</script>

<div bind:this={mapContainer} class="where-mapbox"></div>

{#if splashVisible}
	<!-- Placeholder orbs so users don't stare at a dark globe while the map loads; fades out on first idle. -->
	<div class="map-splash" aria-hidden="true">
		<span class="orb orb-a"></span>
		<span class="orb orb-b"></span>
		<span class="orb orb-c"></span>
		<span class="orb orb-d"></span>
		<span class="orb orb-e"></span>
	</div>
{/if}

<style>
	/* CSS can only style the container a control already lives in — corner placement is fixed by Mapbox at construction (see `creditsSplit` in mapInit.ts), not by CSS padding. */

	/* Bottom-LEFT: attribution on top, scale bar under it, clear of the border's flat bottom edge. */
	:global(.mapboxgl-ctrl-bottom-left) {
		z-index: 2;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		padding: 0 0 26px 22px;
	}

	/* Bottom-right offsets are read off gold-border.svg's geometry (notch: y=91.8%, x=89.2%→91.1%), not judged by eye — percentages track the border as the stage resizes. */
	:global(.mapboxgl-ctrl-bottom-right) {
		display: flex;
		/* Column: readout above wordmark; both must stay right of the gold wall at ~89.1% of stage width — cqw sizing below maintains that at every size. */
		flex-direction: column;
		align-items: flex-end;
		justify-content: flex-end;
		gap: 5px;
		z-index: 2;
		padding: 0 0.9% 1.1% 0;
	}

	/* Sized in `cqw` (not px) against `.where-stage` — fixed px caused the readout to slide out under the gold line on windows narrower than ~1400px. */
	:global(.mapboxgl-ctrl-bottom-right .rt-zoom-readout) {
		padding: 3px max(4px, 0.35cqw);
		font-size: max(9px, 0.78cqw);
	}

	:global(.mapboxgl-ctrl-bottom-right .mapboxgl-ctrl-logo) {
		width: max(46px, 4.7cqw);
		height: max(13px, 1.25cqw);
		background-size: contain;
		padding: 3px max(4px, 0.35cqw);
	}

	/* Margins zeroed via chained selectors to outrank mapbox's same-specificity `.mapboxgl-ctrl { margin: 10px }` — flex `gap` owns spacing now. */
	:global(.mapboxgl-ctrl-bottom-right .mapboxgl-ctrl),
	:global(.mapboxgl-ctrl-bottom-left .mapboxgl-ctrl) {
		margin: 0;
	}

	/* Attribution styled to match the readout/scale — left plain it's white text that vanishes over bright satellite imagery. */
	:global(.mapboxgl-ctrl-bottom-left .mapboxgl-ctrl-attrib) {
		background-color: rgba(0, 0, 0, 0.72);
		border: 1px solid rgba(255, 255, 255, 0.55);
		border-radius: 5px;
		padding: 3px 8px;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
		font-size: 10px;
		line-height: 1.4;
	}

	:global(.mapboxgl-ctrl-bottom-left .mapboxgl-ctrl-attrib a) {
		color: rgba(255, 255, 255, 0.86);
	}

	/* `!important` required — Mapbox sets `style="display:none"` inline on the wordmark's wrapper div, and only `!important` outranks an inline style. */
	:global(.mapboxgl-ctrl-bottom-right .mapboxgl-ctrl:has(.mapboxgl-ctrl-logo)) {
		display: block !important;
	}

	/* Use `background-color`, not the `background` shorthand — shorthand resets `background-image` too and wipes the wordmark (it's a data-URI background-image with no text). */
	:global(.mapboxgl-ctrl-bottom-right .mapboxgl-ctrl-logo) {
		opacity: 1;
		box-sizing: content-box;
		background-color: rgba(0, 0, 0, 0.72);
		border: 1px solid rgba(255, 255, 255, 0.55);
		border-radius: 5px;
		padding: 4px 8px;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
	}

	/* Scale bar — same visual family as the rest. */
	:global(.mapboxgl-ctrl-bottom-left .mapboxgl-ctrl-scale) {
		background-color: rgba(0, 0, 0, 0.72);
		border: 1px solid rgba(255, 255, 255, 0.55);
		border-radius: 5px;
		color: #fff;
		font:
			600 11px/1.4 ui-monospace,
			SFMono-Regular,
			Menlo,
			monospace;
		padding: 3px 7px;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
	}

	/* Zoom readout is a debug aid — legibility beats subtlety; must read over both bright satellite and the dark globe. */
	:global(.rt-zoom-readout) {
		background: rgba(0, 0, 0, 0.72);
		color: #fff;
		font:
			700 13px/1 ui-monospace,
			SFMono-Regular,
			Menlo,
			monospace;
		letter-spacing: 0.02em;
		padding: 5px 9px;
		border: 1px solid rgba(255, 255, 255, 0.55);
		border-radius: 5px;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
		pointer-events: none;
		user-select: none;
	}

	/* Scale bar matches the readout's styling so the pair reads as one instrument set. */
	:global(.mapboxgl-ctrl-bottom-right .mapboxgl-ctrl-scale) {
		background: rgba(0, 0, 0, 0.72);
		border: 1px solid rgba(255, 255, 255, 0.55);
		border-radius: 5px;
		color: #fff;
		font:
			600 11px/1.4 ui-monospace,
			SFMono-Regular,
			Menlo,
			monospace;
		padding: 3px 7px;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
	}

	.where-mapbox {
		position: absolute;
		inset: 0;
	}

	.map-splash {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 5;
		animation: splashFadeOut 0.8s ease-out 2s forwards;
		/* Clip orbs to a circle approximating the globe at initial zoom */
		clip-path: circle(38% at 50% 50%);
	}

	.orb {
		position: absolute;
		display: block;
		border-radius: 9999px;
		background: radial-gradient(
			circle,
			rgba(255, 200, 0, 0.55) 0%,
			rgba(255, 200, 0, 0.25) 45%,
			rgba(255, 200, 0, 0) 70%
		);
		filter: blur(0.5px);
		transform: translate(-50%, -50%);
		animation: orbPulse 1.6s ease-in-out infinite;
	}

	.orb-a { top: 40%; left: 38%; width: 64px; height: 64px; animation-delay: 0s; }
	.orb-b { top: 50%; left: 52%; width: 96px; height: 96px; animation-delay: 0.25s; }
	.orb-c { top: 58%; left: 42%; width: 48px; height: 48px; animation-delay: 0.5s; }
	.orb-d { top: 38%; left: 58%; width: 72px; height: 72px; animation-delay: 0.15s; }
	.orb-e { top: 62%; left: 55%; width: 56px; height: 56px; animation-delay: 0.35s; }

	@keyframes orbPulse {
		0%, 100% { opacity: 0.45; transform: translate(-50%, -50%) scale(0.92); }
		50%      { opacity: 0.9;  transform: translate(-50%, -50%) scale(1.08); }
	}

	@keyframes splashFadeOut {
		to { opacity: 0; }
	}
</style>
