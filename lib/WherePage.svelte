<script lang="ts">
import type { Feature } from "geojson";
import WhereMap from "./WhereMap.svelte";
import MapDrawControls from "@ground-truth/getcache-onlinemap/lib/mapDrawControls.svelte";
import { safeEase } from "./safeEase";
import { safeFitBounds } from "./safeMap";
import {
	formatTransparencyScore,
	type FavouriteLocation,
	type WhereRoutes,
} from "./whereTypes";

import goldBorderRaw from "./whereAssets/gold-border.svg?raw";
import buttonPanelRaw from "./whereAssets/button-panel.svg?raw";
import markerBoxRaw from "./whereAssets/marker-box.svg?raw";
import aroundWindowRaw from "./whereAssets/around-me-window.svg?raw";
import inputBarRaw from "./whereAssets/around-me-input-bar.svg?raw";
import favouritesBoxRaw from "./whereAssets/favourites-box.svg?raw";
import closeRaw from "./whereAssets/close-button.svg?raw";
import photoFrameRaw from "./whereAssets/around-me-photo-frame.svg?raw";

// Imported, never a leading-slash URL — a leading-slash path resolves against whatever host serves the page, not the bundle, so it only worked under one host's static/ folder.
import markerUrl from "./assets/pub-Rtvr/map-marker-tailWag-ReTreever.svg";
import toolLine from "./assets/pub-Rtvr/where/tool-line.webp";
import toolPolygon from "./assets/pub-Rtvr/where/tool-polygon.webp";
import toolTrash from "./assets/pub-Rtvr/where/tool-trash.webp";
import toolAroundMe from "./assets/pub-Rtvr/where/tool-around-me.webp";
import toolFavourites from "./assets/pub-Rtvr/where/tool-favourites.webp";
import aroundMePhoto from "./assets/pub-Rtvr/where/around-me-photo.webp";

// Page chrome for /retreeve/where: gold border, left tool panel (line/poly/trash/around-me/favourites), Around Me popup, selected-marker box. Map/draw engine stay in rapper; anything reaching outside the page arrives as a prop.
let {
	initialFeatures = [],
	onFeatureComplete,
	onFeaturesCleared,
	favourites = [],
	ontogglefavourite,
	routes = {},
	ensureMapboxGuards = async () => {},
	polygonsUrl,
}: {
	initialFeatures?: Feature[];
	/** Fired with each finished drawing; the route persists it. */
	onFeatureComplete?: (feature: Feature) => void;
	/** Fired when the trash tool wipes all drawings; the route clears storage. */
	onFeaturesCleared?: () => void;
	favourites?: FavouriteLocation[];
	/** Where the marker box links to — ReTreever passes AppRoutes; rapper passes nothing and the links simply don't render. */
	routes?: WhereRoutes;
	/** Passed straight through to WhereMap — see its prop docs. */
	ensureMapboxGuards?: () => Promise<void>;
	/** Passed straight through to WhereMap — see its prop docs. */
	polygonsUrl?: string;
	/** Fired by the ★ in the marker box; the route owns the stored list. */
	ontogglefavourite?: (loc: FavouriteLocation) => void;
} = $props();

/** Bundler can't rewrite the bitmap href inside a raw-injected SVG ({@html}), so the placeholder path is replaced manually — both href and legacy xlink:href. */
const photoFrameSvg = photoFrameRaw.replaceAll(
	"/pub-Rtvr/where/around-me-photo.webp",
	aroundMePhoto,
);

let map: import("mapbox-gl").Map | null = $state(null);
let selectedFeature: any = $state(null);
let drawIntent: "polygon" | "line" | null = $state(null);
let drawApi: MapDrawControls | undefined = $state();
/** Instance handle for WhereMap.resetView() — it owns the home camera. */
let mapApi: WhereMap | undefined = $state();
/** Set by WhereMap once the camera has zoomed/rotated away from home. */
let viewChanged = $state(false);

// Deliberately a const, not $state — its only writer (the fullscreen toggle) was removed; the {#if} stays so restoring a toggle is a one-line change.
const toolsVisible = true;
/** Closed on load — do not flip to `true`; it used to open itself on every visit and nag users for location permission. */
let aroundMeOpen = $state(false);
let favouritesOpen = $state(false);
let areaQuery = $state("");
let aroundMeStatus = $state("");

/** Last known browser fix — draws the blue dot and lets Around Me skip re-asking once set. */
let userLocation = $state<[number, number] | null>(null);

/** Do NOT cache a coordinate across reloads (a stale fix lies about location) — instead check permissions.query; if already granted, getCurrentPosition resolves silently with no prompt. */
$effect(() => {
	if (typeof navigator === "undefined" || !navigator.geolocation) return;
	if (!navigator.permissions?.query) return;
	let cancelled = false;
	navigator.permissions
		.query({ name: "geolocation" as PermissionName })
		.then((status) => {
			if (cancelled || status.state !== "granted") return;
			navigator.geolocation.getCurrentPosition(
				(pos) => {
					if (cancelled) return;
					userLocation = [pos.coords.longitude, pos.coords.latitude];
				},
				() => {
					/* Granted but no fix right now — the dot just stays off. */
				},
				{ enableHighAccuracy: false, timeout: 10000 },
			);
		})
		.catch(() => {
			/* Permissions API unavailable — fall back to asking on demand. */
		});
	return () => {
		cancelled = true;
	};
});

function pickDrawTool(mode: "line" | "polygon") {
	aroundMeOpen = false;
	favouritesOpen = false;
	drawApi?.setMode(mode);
}

function trashDrawings() {
	if (!window.confirm("Clear all shapes drawn on this map?")) return;
	drawApi?.clearAll();
	onFeaturesCleared?.();
}

/** Once location is granted, a second press flies to it instead of re-asking — the popup only appears while there's still something to ask. */
function toggleAroundMe() {
	favouritesOpen = false;
	aroundMeStatus = "";
	if (userLocation) {
		aroundMeOpen = false;
		flyToUser();
		return;
	}
	aroundMeOpen = !aroundMeOpen;
}

/** Centre on the stored fix. Only ever called once `userLocation` is set. */
function flyToUser() {
	if (!map || !userLocation) return;
	safeEase(map, { center: userLocation, zoom: 9, duration: 1600 });
}

function toggleFavouritesPanel() {
	aroundMeOpen = false;
	favouritesOpen = !favouritesOpen;
}

/** Back to the globe: WhereMap owns the camera reset, this just closes popups. Drawn shapes are deliberately NOT cleared here — that's the trash tool's job. */
function resetView() {
	aroundMeOpen = false;
	favouritesOpen = false;
	mapApi?.resetView();
}

function allowLocation() {
	if (!navigator.geolocation) {
		aroundMeStatus = "Location isn't available in this browser.";
		return;
	}
	aroundMeStatus = "Locating…";
	navigator.geolocation.getCurrentPosition(
		(pos) => {
			// Store BEFORE flying — this paints the blue dot and is the flag that stops the popup asking again.
			userLocation = [pos.coords.longitude, pos.coords.latitude];
			flyToUser();
			aroundMeOpen = false;
			aroundMeStatus = "";
		},
		() => {
			aroundMeStatus = "Location was denied — search by area instead.";
		},
		{ enableHighAccuracy: false, timeout: 10000 },
	);
}

async function searchArea(event: SubmitEvent) {
	event.preventDefault();
	const q = areaQuery.trim();
	if (!map || !q) return;
	aroundMeStatus = "Searching…";
	try {
		// Same token the map itself boots with (mapInit.ts).
		const token = import.meta.env.VITE_MAPBOX_TOKEN;
		// Checked explicitly rather than left to interpolate `undefined` — that built a silently-broken URL (401) whose catch message misleadingly reads as a network blip, not a missing token.
		if (!token) {
			aroundMeStatus =
				"VITE_MAPBOX_TOKEN is not set — add it to rapper/.env and restart.";
			return;
		}
		const url =
			`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
			`?types=region,district,place,country&limit=1&access_token=${token}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`geocoding ${res.status}`);
		const data = await res.json();
		const hit = data?.features?.[0];
		if (!hit) {
			aroundMeStatus = "No matching area found.";
			return;
		}
		if (Array.isArray(hit.bbox) && hit.bbox.length === 4) {
			safeFitBounds(map, [hit.bbox[0], hit.bbox[1]], [hit.bbox[2], hit.bbox[3]], {
				padding: 60,
				duration: 1400,
			});
		} else if (Array.isArray(hit.center)) {
			safeEase(map, { center: hit.center, zoom: 7, duration: 1400 });
		}
		aroundMeOpen = false;
		aroundMeStatus = "";
		areaQuery = "";
	} catch (err) {
		console.error("Area search failed:", err);
		aroundMeStatus = "Search failed — try again.";
	}
}

// centroid may be a parsed object or a JSON string (Mapbox serializes feature properties) — same tolerance as WhereMap's flyToAndSelect.
function featureLngLat(f: any): [number, number] | null {
	let raw: unknown = null;
	if (f?.geometry?.coordinates) raw = f.geometry.coordinates;
	else if (f?.centroid?.coordinates) raw = f.centroid.coordinates;
	else if (typeof f?.centroid === "string") {
		try {
			raw = JSON.parse(f.centroid)?.coordinates ?? null;
			// codestyle-allow-swallow: malformed centroid just disables favouriting for this feature
		} catch {}
	}
	if (!Array.isArray(raw) || raw.length < 2) return null;
	const [lng, lat] = raw as [unknown, unknown];
	if (typeof lng !== "number" || typeof lat !== "number") return null;
	if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
	return [lng, lat];
}

let selectedIsFavourite = $derived(
	!!selectedFeature?.landKey &&
		favourites.some((f) => f.landKey === selectedFeature.landKey),
);

function toggleSelectedFavourite() {
	if (!selectedFeature?.landKey) return;
	const coords = featureLngLat(selectedFeature);
	if (!coords) return;
	ontogglefavourite?.({
		landKey: selectedFeature.landKey,
		landName: selectedFeature.landName ?? "Unnamed land",
		lng: coords[0],
		lat: coords[1],
	});
}

function flyToFavourite(fav: FavouriteLocation) {
	if (!map) return;
	safeEase(map, { center: [fav.lng, fav.lat], zoom: 14, duration: 1400 });
	favouritesOpen = false;
}

function formatHectares(hectares: number): string {
	return Math.round(hectares).toLocaleString();
}

/** Where the marker panel's project links point — that project's results page; land rows use it too. Falls back to the search page when there's no projectKey. */
let detailsHref = $derived(
	selectedFeature?.projectKey && routes.whatProject
		? routes.whatProject(selectedFeature.projectKey)
		: (routes.what ?? null),
);

/** The organization's results page — null (not a fallback) when there's no organizationKey, since an org-labelled link to an unfiltered list is worse than no link. */
let orgHref = $derived(
	selectedFeature?.organizationKey && routes.whoOrg
		? routes.whoOrg(selectedFeature.organizationKey)
		: null,
);
</script>

<div class="where-stage">
	<WhereMap
		bind:this={mapApi}
		bind:map
		bind:selectedFeature
		bind:viewChanged
		{markerUrl}
		{userLocation}
		{ensureMapboxGuards}
		{polygonsUrl}
	/>

	<!-- Draw engine: sources + in-progress popover only; the tool panel drives it via the exported instance API. -->
	<MapDrawControls
		bind:this={drawApi}
		{map}
		bind:drawIntent
		chrome="external"
		{onFeatureComplete}
		{initialFeatures}
	/>

	<!-- Gold page border -->
	<div class="gold-border" aria-hidden="true">
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html goldBorderRaw}
	</div>

	{#if toolsVisible}
		<div class="tool-panel">
			<div class="tool-panel-bg" aria-hidden="true">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html buttonPanelRaw}
			</div>
			<button
				type="button"
				class="tool-btn"
				class:tool-active={drawIntent === "line"}
				onclick={() => pickDrawTool("line")}
			>
				<img src={toolLine} alt="" />
				<span class="tool-tip">Draw a line</span>
			</button>
			<button
				type="button"
				class="tool-btn"
				class:tool-active={drawIntent === "polygon"}
				onclick={() => pickDrawTool("polygon")}
			>
				<img src={toolPolygon} alt="" />
				<span class="tool-tip">Draw a polygon</span>
			</button>
			<button type="button" class="tool-btn" onclick={trashDrawings}>
				<img src={toolTrash} alt="" />
				<span class="tool-tip">Clear drawn shapes</span>
			</button>
			<button
				type="button"
				class="tool-btn"
				class:tool-active={aroundMeOpen}
				onclick={toggleAroundMe}
			>
				<img src={toolAroundMe} alt="" />
				<span class="tool-tip">Around Me</span>
			</button>
			<button
				type="button"
				class="tool-btn"
				class:tool-active={favouritesOpen}
				onclick={toggleFavouritesPanel}
			>
				<img src={toolFavourites} alt="" />
				<span class="tool-tip">Favourited locations</span>
			</button>
		</div>

		<!-- Reset view sits below the tool panel, not inside it — the panel art is five fixed cutouts; a sixth button would fall off the slant. Only shows once there's something to undo. -->
		{#if viewChanged || selectedFeature}
			<button
				type="button"
				class="reset-btn"
				aria-label="Reset map view"
				onclick={resetView}
			>
				<span class="reset-glyph" aria-hidden="true">&#10226;</span>
				<span class="tool-tip">Reset map view</span>
			</button>
		{/if}

		{#if aroundMeOpen}
			<div class="around-me" role="dialog" aria-label="Around Me">
				<div class="around-window">
					<div class="around-window-bg" aria-hidden="true">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html aroundWindowRaw}
					</div>
					<button
						type="button"
						class="popup-close"
						aria-label="Close Around Me"
						onclick={() => (aroundMeOpen = false)}
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html closeRaw}
					</button>
					<div class="around-photo" aria-hidden="true">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html photoFrameSvg}
					</div>
					<p class="around-prompt">
						ReTreever's 'Around Me' function is most efficient with location
						services enabled.
					</p>
					<button type="button" class="allow-btn" onclick={allowLocation}>
						Allow
					</button>
					{#if aroundMeStatus}
						<p class="around-status" role="status">{aroundMeStatus}</p>
					{/if}
					<p class="around-secondary">Or narrow search by state/province:</p>
				</div>

				<form class="area-search" onsubmit={searchArea}>
					<div class="area-search-bg" aria-hidden="true">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html inputBarRaw}
					</div>
					<input
						type="text"
						bind:value={areaQuery}
						placeholder="State / province…"
						aria-label="Search by state or province"
					/>
					<button type="submit" class="area-go" aria-label="Search area">
						&#10142;
					</button>
				</form>
			</div>
		{/if}

		{#if favouritesOpen}
			<aside class="favourites-panel" aria-label="Favourited locations">
				<div class="favourites-bg" aria-hidden="true">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html favouritesBoxRaw}
				</div>
				<button
					type="button"
					class="popup-close"
					aria-label="Close favourites"
					onclick={() => (favouritesOpen = false)}
				>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html closeRaw}
				</button>
				<h2 class="favourites-title">Favourites</h2>
				{#if favourites.length === 0}
					<p class="favourites-empty">
						No favourites yet — select a marker and tap its ★.
					</p>
				{:else}
					<ul class="favourites-list">
						{#each favourites as fav (fav.landKey)}
							<li>
								<button type="button" onclick={() => flyToFavourite(fav)}>
									{fav.landName}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</aside>
		{/if}

		{#if selectedFeature}
			<aside class="marker-box" aria-label="Selected location details">
				<div class="marker-box-bg" aria-hidden="true">
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html markerBoxRaw}
				</div>
				<button
					type="button"
					class="popup-close marker-close"
					aria-label="Close details"
					onclick={() => (selectedFeature = null)}
				>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html closeRaw}
				</button>
				{#if selectedFeature.landKey}
					<button
						type="button"
						class="fav-star"
						class:fav-on={selectedIsFavourite}
						aria-label={selectedIsFavourite
							? "Remove from favourites"
							: "Add to favourites"}
						aria-pressed={selectedIsFavourite}
						onclick={toggleSelectedFavourite}
					>
						{selectedIsFavourite ? "★" : "☆"}
					</button>
				{/if}
				<h2 class="marker-title">
					{selectedFeature.landName ?? selectedFeature.projectName ?? "This land"}&rsquo;s
				</h2>
				<p class="marker-rating">
					Transparency Rating:
					<span class="marker-score">
						{selectedFeature.transparencyScore != null
								? formatTransparencyScore(selectedFeature.transparencyScore)
								: "—"}
					</span>
				</p>
				<dl class="marker-rows">
					{#if selectedFeature.landKey}
						<div class="marker-row">
							<dt>Land:</dt>
							<dd>
								<a href={detailsHref}>{selectedFeature.landKey}</a>
							</dd>
						</div>
					{/if}
					<div class="marker-row">
						<dt>Organization:</dt>
						<dd>
							{#if orgHref}
								<!-- Key present but name missing is rare and real — the key is at least an identifier, never an empty link. -->
								<a href={orgHref}>
									{selectedFeature.organizationName ?? selectedFeature.organizationKey}
								</a>
							{:else}
								{selectedFeature.organizationName ?? "None"}
							{/if}
						</dd>
					</div>
					{#if selectedFeature.projectName}
						<div class="marker-row">
							<dt>Project:</dt>
							<dd>
								<a href={detailsHref}>{selectedFeature.projectName}</a>
							</dd>
						</div>
					{/if}
					{#if selectedFeature.hectaresCalc}
						<div class="marker-row">
							<dt>Hectares:</dt>
							<dd>{formatHectares(Number(selectedFeature.hectaresCalc))}</dd>
						</div>
					{/if}
				</dl>
				<a class="marker-details-link" href={detailsHref}>
					View score details and all data
				</a>
			</aside>
		{/if}
	{/if}


</div>

<style>
	.where-stage {
		/* Container for `cqw` units — sized against this box (not viewport) so the cutout controls track it; `size` not `inline-size` since both axes matter. */
		container-type: size;
		container-name: where-stage;
		position: relative;
		height: calc(100vh - 5rem); /* navbar is h-20 (5rem) sticky */
		width: 100%;
		background: #000;
		overflow: hidden;
	}

	.gold-border {
		position: absolute;
		inset: 0;
		z-index: 10;
		pointer-events: none;
	}

	.gold-border :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}

	/* Designed chrome replaces Mapbox's default zoom/compass/style controls — the gold border's panel cutout is where they'd sit. */
	.where-stage :global(.mapboxgl-ctrl-top-left) {
		display: none;
	}

	/* Sized in stage percentages to track the gold border's left cutout (x 0.5%–10.4%, y 11.5%–68%); definite height matters since the five flex rows divide it evenly. */
	.tool-panel {
		position: absolute;
		left: 0.8%;
		top:7%;
		width: 8.8%;
		height: 48.5%;
		min-width: 54px;
		z-index: 20;
		display: flex;
		flex-direction: column;
		padding: 1.5% 0.6%;
		box-sizing: border-box;
	}

	.tool-panel-bg {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.tool-panel-bg :global(svg),
	.around-window-bg :global(svg),
	.area-search-bg :global(svg),
	.favourites-bg :global(svg),
	.marker-box-bg :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}

	.tool-btn {
		position: relative;
		flex: 1;
		/* Without this, icons' intrinsic size becomes the flex minimum and the column blows past the panel instead of splitting evenly. */
		min-height: 0;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		-webkit-tap-highlight-color: transparent;
	}

	.tool-btn img {
		height: 54%;
		width: auto;
		max-width: 68%;
		object-fit: contain;
		transition: filter 0.15s ease;
	}

	.tool-btn:hover img,
	.tool-btn:focus-visible img {
		filter: drop-shadow(0 0 5px rgba(250, 215, 2, 0.9));
	}

	.tool-active img {
		filter: drop-shadow(0 0 6px #fad702) drop-shadow(0 0 2px #fad702);
	}

	/* Hover-reveal icon descriptions (per the design annotation). */
	.tool-tip {
		position: absolute;
		left: calc(100% + 10px);
		top: 50%;
		transform: translateY(-50%);
		white-space: nowrap;
		background: rgba(23, 29, 49, 0.95);
		border: 1px solid #fad702;
		color: #fad702;
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		padding: 4px 9px;
		border-radius: 4px;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s ease;
	}

	.tool-btn:hover .tool-tip,
	.tool-btn:focus-visible .tool-tip,
	.reset-btn:hover .tool-tip,
	.reset-btn:focus-visible .tool-tip {
		opacity: 1;
	}

	/* Aligned to the tool panel's column, parked just below it (still inside the cutout, y ≤ 68%); round so it reads as a separate control, not a sixth slot. */
	.reset-btn {
		position: absolute;
		/* Centred on the tool panel's column (left 0.8% + half its 8.8%) so it tracks the panel at any width — a fixed circle would blow up on a wide monitor. */
		left: 5.2%;
		top: 59%;
		transform: translateX(-50%);
		width: clamp(38px, 3.2vw, 54px);
		aspect-ratio: 1;
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 2px solid #fad702;
		border-radius: 9999px;
		background: rgba(23, 29, 49, 0.82);
		color: #fad702;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		animation: resetFadeIn 0.2s ease-out;
		transition:
			background 0.15s ease,
			box-shadow 0.15s ease;
	}

	.reset-btn:hover,
	.reset-btn:focus-visible {
		background: rgba(250, 215, 2, 0.18);
		box-shadow: 0 0 8px rgba(250, 215, 2, 0.55);
	}

	.reset-glyph {
		font-size: clamp(1.15rem, 1.7vw, 1.6rem);
		line-height: 1;
		/* the ⟲ glyph sits high in its em box */
		transform: translateY(-1px);
	}

	@keyframes resetFadeIn {
		from {
			opacity: 0;
			/* keeps the centring translate — a bare scale() would drop it */
			transform: translateX(-50%) scale(0.85);
		}
	}

	.around-me {
		position: absolute;
		left: 50%;
		top: 4%;
		transform: translateX(-58%);
		width: clamp(280px, 24vw, 380px);
		z-index: 30;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.around-window {
		position: relative;
		width: 100%;
		aspect-ratio: 217.23656 / 287.29264;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 5% 9% 6%;
		box-sizing: border-box;
	}

	.around-window-bg {
		position: absolute;
		inset: 0;
		pointer-events: none;
		filter: drop-shadow(0 10px 28px rgba(0, 0, 0, 0.55));
	}

	/* Window bg is absolutely positioned, so content underneath needs position:relative or it paints below it. */
	.around-photo {
		position: relative;
		width: 92%;
		margin-top: 2%;
	}

	.around-photo :global(svg) {
		width: 100%;
		height: auto;
		display: block;
	}

	.around-prompt {
		position: relative;
		margin: 4% 0 0;
		color: #fff;
		font-family: var(--rt-font-web);
		font-weight: 500;
		font-size: clamp(0.82rem, 1.05vw, 1rem);
		line-height: 1.35;
		text-align: center;
	}

	.allow-btn {
		position: relative;
		margin-top: 5%;
		background: none;
		border: 2px solid #fad702;
		color: #f6cf00;
		font-family: var(--rt-font-web);
		font-weight: 500;
		font-size: clamp(1.05rem, 1.4vw, 1.35rem);
		padding: 0.3em 1.5em;
		cursor: pointer;
		/* subtle hand-cut trapezoid, per the Allow asset */
		transform: rotate(-0.6deg) skewX(-1.2deg);
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}

	.allow-btn:hover,
	.allow-btn:focus-visible {
		background: rgba(250, 215, 2, 0.15);
	}

	.around-secondary {
		position: relative;
		margin: 6% 0 0;
		color: #8b97c9;
		font-family: var(--rt-font-web);
		font-weight: 500;
		font-size: clamp(0.78rem, 1vw, 0.95rem);
		text-align: center;
	}

	.around-status {
		position: relative;
		margin: 3% 0 0;
		color: #fad702;
		font-size: 0.78rem;
		text-align: center;
	}

	.area-search {
		position: relative;
		width: 138%;
		max-width: 78vw;
		aspect-ratio: 344.55581 / 81.82171;
		/* overlaps the window's (empty) lower portion so the bar sits right
		   under the "narrow search" line, as in the layout reference */
		margin-top: -30%;
	}

	.area-search-bg {
		position: absolute;
		inset: 0;
		pointer-events: none;
		filter: drop-shadow(0 8px 22px rgba(0, 0, 0, 0.5));
	}

	.area-search input {
		position: absolute;
		left: 6%;
		top: 18%;
		width: 54%;
		height: 64%;
		background: transparent;
		border: none;
		outline: none;
		color: #fad702;
		font-family: var(--rt-font-web);
		font-size: clamp(0.95rem, 1.3vw, 1.25rem);
		letter-spacing: 0.02em;
	}

	.area-search input::placeholder {
		color: rgba(250, 215, 2, 0.45);
	}

	.area-go {
		position: absolute;
		right: 4%;
		top: 16%;
		width: 22%;
		height: 68%;
		background: none;
		border: none;
		color: #fad702;
		font-size: clamp(1.2rem, 1.8vw, 1.7rem);
		cursor: pointer;
		transition: transform 0.15s ease;
	}

	.area-go:hover,
	.area-go:focus-visible {
		transform: translateX(3px);
	}

	.popup-close {
		position: absolute;
		top: 5%;
		right: 4.5%;
		width: clamp(18px, 1.6vw, 26px);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		z-index: 2;
		transition: opacity 0.15s ease;
	}

	.popup-close:hover,
	.popup-close:focus-visible {
		opacity: 0.7;
	}

	.popup-close :global(svg) {
		width: 100%;
		height: auto;
		display: block;
	}

	.favourites-panel {
		position: absolute;
		right: clamp(8px, 1.4vw, 24px);
		top: 38%;
		width: clamp(180px, 15vw, 250px);
		aspect-ratio: 146.25918 / 248.40958;
		max-height: 56%;
		z-index: 25;
		display: flex;
		flex-direction: column;
		padding: 9% 7% 6%;
		box-sizing: border-box;
	}

	.favourites-bg {
		position: absolute;
		inset: 0;
		pointer-events: none;
		filter: drop-shadow(0 10px 28px rgba(0, 0, 0, 0.55));
	}

	.favourites-title {
		position: relative;
		margin: 0 0 6%;
		color: #fad702;
		font-family: var(--font-retreever, inherit);
		font-size: clamp(1rem, 1.3vw, 1.25rem);
		letter-spacing: 0.04em;
	}

	.favourites-empty {
		position: relative;
		margin: 0;
		color: #cfd6ee;
		font-size: 0.8rem;
		line-height: 1.4;
	}

	.favourites-list {
		position: relative;
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-y: auto;
	}

	.favourites-list li + li {
		margin-top: 6px;
	}

	.favourites-list button {
		background: none;
		border: none;
		padding: 2px 0;
		color: #fad702;
		font-size: 0.85rem;
		text-align: left;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
		word-break: break-word;
	}

	.favourites-list button:hover {
		color: #fff;
	}

	.marker-box {
		position: absolute;
		right: clamp(8px, 1.4vw, 24px);
		top: clamp(10px, 2.4vh, 26px);
		width: clamp(250px, 21vw, 340px);
		z-index: 25;
		padding: 4.5% 1.8% 2%;
		box-sizing: border-box;
	}

	.marker-box-bg {
		position: absolute;
		inset: 0;
		pointer-events: none;
		filter: drop-shadow(0 10px 28px rgba(0, 0, 0, 0.55));
	}

	.marker-box .popup-close.marker-close {
		top: auto;
		bottom: 5%;
		left: 5%;
		right: auto;
	}

	.fav-star {
		position: absolute;
		top: 4%;
		right: 5%;
		background: none;
		border: none;
		padding: 0;
		color: #8b97c9;
		font-size: clamp(1.1rem, 1.5vw, 1.4rem);
		line-height: 1;
		cursor: pointer;
		z-index: 2;
		transition: color 0.15s ease;
	}

	.fav-star:hover,
	.fav-star:focus-visible,
	.fav-star.fav-on {
		color: #fad702;
	}

	.marker-title {
		position: relative;
		margin: 0 8% 0 4%;
		color: #fad702;
		font-family: var(--font-retreever, inherit);
		font-size: clamp(0.95rem, 1.25vw, 1.2rem);
		line-height: 1.25;
		letter-spacing: 0.03em;
		word-break: break-word;
	}

	.marker-rating {
		position: relative;
		margin: 2% 4% 0;
		color: #fad702;
		font-family: var(--font-retreever, inherit);
		font-size: clamp(0.9rem, 1.15vw, 1.1rem);
	}

	.marker-score {
		font-size: clamp(1.5rem, 2.2vw, 2.1rem);
		margin-left: 0.25em;
	}

	.marker-rows {
		position: relative;
		margin: 4% 4% 0;
	}

	.marker-row {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.45rem;
		font-size: clamp(0.72rem, 0.9vw, 0.85rem);
	}

	.marker-row dt {
		color: #cfd6ee;
		min-width: 5.6rem;
		flex-shrink: 0;
	}

	.marker-row dd {
		margin: 0;
		color: #fff;
		word-break: break-all;
	}

	.marker-row a {
		color: #a7b4e8;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.marker-row a:hover {
		color: #fad702;
	}

	.marker-details-link {
		position: relative;
		display: block;
		margin: 3% 4% 6% auto;
		width: fit-content;
		color: #fad702;
		font-size: clamp(0.72rem, 0.9vw, 0.85rem);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.marker-details-link:hover {
		color: #fff;
	}

	@media (max-width: 767px) {
		.tool-panel {
			left: 4px;
			top: 12%;
			width: 54px;
			height: 46%;
		}

		.tool-tip {
			display: none;
		}

		.reset-btn {
			/* mobile panel is left 4px / 54px wide — centre on 31px */
			left: 31px;
			top: 60%;
			width: 44px;
		}

		.around-me {
			width: min(86vw, 340px);
			transform: translateX(-50%);
		}

		.area-search {
			width: 100%;
		 margin-top: -21%;

		}

		.marker-box {
			width: min(88vw, 340px);
			right: 6px;
		}

		.favourites-panel {
			width: min(60vw, 230px);
			top: auto;
			bottom: 12%;
		}
	}
</style>
