<script lang="ts">
/**
 * /where's draw engine — ReTreever's own, severed from the Get Cache map.
 *
 * It used to mount getCache_OnlineMap's MapDrawControls, a 73KB component with
 * 21 imports from $lib/mobile and $mobRoutes/db: the block palette, the plot
 * layer, the importer, the Quality-704 status dots, the TinyBase store. /where
 * needs none of that — it draws a shape and hands it back — and a child reaching
 * into a parent's private app is the coupling that made every Get Cache map bug
 * land here first.
 *
 * It also called `drawApi.clearAll()` and `drawApi.setMode()`, which that
 * component never exported. Both were optional-chained, so both were silent
 * no-ops and the Clear button did nothing. They are real here.
 *
 * The geometry itself is `./mapDraw`, which is ReTreever's copy of a module
 * that imports nothing from either parent.
 */
import type { Map as MapboxMap } from "mapbox-gl";
import type { Feature } from "geojson";
import {
	buildCompletedFC,
	buildDrawEdgesFC,
	buildDrawVerticesFC,
	buildProvisionalPolygonFC,
	clearInProgressSources,
	getAccentColor,
	setupDrawSourcesAndLayers,
	type DrawIntent,
	type Lnglat,
} from "./mapDraw";
import { newId } from "./newId";

let {
	map,
	drawIntent = $bindable(null),
	initialFeatures = [],
	onFeatureComplete,
}: {
	map?: MapboxMap;
	drawIntent?: DrawIntent;
	initialFeatures?: Feature[];
	onFeatureComplete?: (feature: Feature) => void;
} = $props();

let features = $state<Feature[]>([...initialFeatures]);
let vertices = $state<Lnglat[]>([]);

function setSource(id: string, data: ReturnType<typeof buildCompletedFC>) {
	if (!map) return;
	const src = map.getSource(id);
	if (src && "setData" in src) {
		(src as unknown as { setData: (d: typeof data) => void }).setData(data);
	}
}

/**
 * Seeding runs through onPainted, never after the call: on a style that is
 * still loading, setup defers its own work, and a push into sources that do
 * not exist yet is dropped with no later tick to correct it.
 */
$effect(() => {
	const m = map;
	if (!m) return;
	if (!m.getSource("completed-features")) {
		setupDrawSourcesAndLayers(m, getAccentColor(), true, () => {
			setSource("completed-features", buildCompletedFC(features));
		});
		return;
	}
	setSource("completed-features", buildCompletedFC(features));
});

$effect(() => {
	if (!map) return;
	setSource("draw-edges", buildDrawEdgesFC(vertices));
	setSource("draw-vertices", buildDrawVerticesFC(vertices));
	setSource("provisional-polygon", buildProvisionalPolygonFC(vertices));
});

function finish() {
	if (!map) return;
	// A polygon needs three corners, a line two; anything shorter is a stray
	// tap and is dropped rather than emitted as a degenerate geometry.
	const min = drawIntent === "polygon" ? 3 : 2;
	if (vertices.length >= min) {
		const feature: Feature =
			drawIntent === "polygon"
				? {
						type: "Feature",
						id: newId(),
						properties: {},
						geometry: {
							type: "Polygon",
							coordinates: [[...vertices, vertices[0]]],
						},
					}
				: {
						type: "Feature",
						id: newId(),
						properties: {},
						geometry: { type: "LineString", coordinates: [...vertices] },
					};
		features = [...features, feature];
		onFeatureComplete?.(feature);
	}
	vertices = [];
	clearInProgressSources(map);
	drawIntent = null;
}

$effect(() => {
	const m = map;
	if (!m) return;

	const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
		if (!drawIntent) return;
		vertices = [...vertices, [e.lngLat.lng, e.lngLat.lat]];
	};
	// Double-click ends the shape. Mapbox's own zoom-on-dblclick would fire at
	// the same point and yank the camera mid-draw, so it is off while a tool
	// is armed and restored when the shape closes.
	const onDblClick = () => {
		if (drawIntent) finish();
	};

	m.on("click", onClick);
	m.on("dblclick", onDblClick);
	return () => {
		m.off("click", onClick);
		m.off("dblclick", onDblClick);
	};
});

$effect(() => {
	const m = map;
	if (!m) return;
	if (drawIntent) m.doubleClickZoom.disable();
	else m.doubleClickZoom.enable();
});

export function setMode(mode: DrawIntent) {
	if (map && vertices.length) clearInProgressSources(map);
	vertices = [];
	drawIntent = mode;
}

export function clearAll() {
	features = [];
	vertices = [];
	if (map) clearInProgressSources(map);
	drawIntent = null;
	setSource("completed-features", buildCompletedFC([]));
}
</script>
