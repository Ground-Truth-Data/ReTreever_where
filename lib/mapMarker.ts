import type {
    FeatureCollection,
    GeoJsonProperties,
    Geometry,
} from "geojson";
import type * as mapboxgl from "mapbox-gl";
import { MAP_CONFIG } from "./MAP_CONFIG";
import { safeEase } from "./safeEase";
import { isCoord, toCoordFromArray } from "./coord";

const WAG_FPS = 24;
const WAG_FALLBACK_DURATION_MS = 2000;
const MAX_LOOP_MS = 8000;

let lastDroppedCount = 0;

// One NaN Point in a clustered source crashes mapbox mid-render with a stack that never names the feature.
function filterFiniteFeatures(
    fc: FeatureCollection<Geometry, GeoJsonProperties>,
): FeatureCollection<Geometry, GeoJsonProperties> {
    let dropped = 0;
    const safeFeatures = fc.features.filter((f) => {
        if (!f.geometry) return false;
        if (f.geometry.type !== "Point") return true;
        const ok = isCoord(f.geometry.coordinates);
        if (!ok) dropped++;
        return ok;
    });
    if (dropped > 0 && dropped !== lastDroppedCount) {
        lastDroppedCount = dropped;
        console.warn(
            `[mapMarker] dropped ${dropped} feature(s) with non-finite coordinates`,
        );
    }
    if (safeFeatures.length === fc.features.length) return fc;
    return { ...fc, features: safeFeatures };
}

/** False once the map is removed; post-await code must bail on it. */
export function isMapAlive(map: mapboxgl.Map | undefined | null): boolean {
    if (!map) return false;
    const internal = map as unknown as { _removed?: boolean; style?: unknown };
    return !internal._removed && internal.style != null;
}

export interface ClusteredPinsConfig {
    id: string;
    data: FeatureCollection<Geometry, GeoJsonProperties>;
    onPointClick?: (feature: mapboxgl.MapboxGeoJSONFeature) => void;
    clusterRadius?: number;
    markerUrl?: string;
}

function stopsExpression(
    input: unknown[],
    stops: readonly (readonly [number, string | number])[],
): mapboxgl.Expression {
    return [
        "interpolate",
        ["linear"],
        input,
        ...stops.flat(),
    ] as unknown as mapboxgl.Expression;
}

const pointCount = ["coalesce", ["get", "point_count"], 1];

function circleRadiusExpression(scale = 1): mapboxgl.Expression {
    return stopsExpression(
        pointCount,
        MAP_CONFIG.cluster.circleStops.map(
            (s) => [s.count, Math.round(s.radius * scale)] as const,
        ),
    );
}

function circleColorExpression(): mapboxgl.Expression {
    return stopsExpression(
        pointCount,
        MAP_CONFIG.cluster.circleStops.map((s) => [s.count, s.color] as const),
    );
}

function heatmapColorExpression(): mapboxgl.Expression {
    return stopsExpression(
        ["heatmap-density"],
        MAP_CONFIG.cluster.heatmap.ramp.map((s) => [s.stop, s.color] as const),
    );
}

async function rasterizeSvg(url: string, sizePx: number): Promise<ImageData> {
    const img = new Image(sizePx, sizePx);
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () =>
            reject(new Error(`Failed to load marker SVG: ${url}`));
        img.src = url;
    });
    return drawToImageData(img, sizePx);
}

function drawToImageData(img: HTMLImageElement, sizePx: number): ImageData {
    const canvas = document.createElement("canvas");
    canvas.width = sizePx;
    canvas.height = sizePx;
    // A read-back canvas: without the hint Chrome warns on every getImageData.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(img, 0, 0, sizePx, sizePx);
    return ctx.getImageData(0, 0, sizePx, sizePx);
}

function parseSmilDur(raw: string | null): number | null {
    if (!raw) return null;
    const t = raw.trim();
    const ms = t.endsWith("ms")
        ? Number.parseFloat(t)
        : t.endsWith("s")
          ? Number.parseFloat(t) * 1000
          : Number.NaN;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// LCM in FRAMES, not ms: the rig's 1.3333s and 2s are coprime in ms (a 44-minute loop) but meet at 96 frames.
function loopFrameCount(svg: SVGSVGElement, fps: number): number {
    const frameMs = 1000 / fps;
    const toFrames = (ms: number) => Math.max(1, Math.round(ms / frameMs));
    const counts = new Set<number>();
    for (const el of Array.from(
        svg.querySelectorAll("animateTransform, animateMotion, animate"),
    )) {
        if (el.getAttribute("repeatCount") !== "indefinite") continue;
        const ms = parseSmilDur(el.getAttribute("dur"));
        if (ms) counts.add(toFrames(ms));
    }
    if (counts.size === 0) return toFrames(WAG_FALLBACK_DURATION_MS);

    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    let lcm = 1;
    for (const c of counts) lcm = (lcm / gcd(lcm, c)) * c;
    const maxFrames = Math.round((MAX_LOOP_MS / 1000) * fps);
    return lcm > maxFrames ? Math.max(...counts) : lcm;
}

// The animated pose: animateMotion lives only in the CTM, not transform.animVal.
function animatedMatrix(root: SVGSVGElement, el: Element): DOMMatrix {
    const g = el as SVGGraphicsElement;
    const own = g.getCTM?.();
    const up = (g.parentNode as SVGGraphicsElement | null)?.getCTM?.();
    if (own && up) {
        try {
            return DOMMatrix.fromMatrix(up)
                .inverse()
                .multiply(DOMMatrix.fromMatrix(own));
        } catch {
            // codestyle-allow-swallow: non-invertible CTM; animVal below is the fallback
        }
    }
    const list = g.transform.animVal;
    let m = root.createSVGMatrix();
    for (let i = 0; i < list.numberOfItems; i++) {
        m = m.multiply(list.getItem(i).matrix);
    }
    return m as unknown as DOMMatrix;
}

/**
 * Bakes a SMIL-animated SVG into frames: mapbox icons are pixels, and an
 * `<img>` decode snapshots frame 0 forever.
 */
async function rasterizeSvgFrames(
    url: string,
    sizePx: number,
): Promise<{ frames: ImageData[]; frameMs: number }> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch marker SVG: ${url}`);
    const markup = await res.text();

    // Attached and laid out but off-screen: display:none or a detached node never starts the SMIL clock.
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
        `position:absolute;left:-10000px;top:0;width:${sizePx}px;` +
        `height:${sizePx}px;pointer-events:none;opacity:0;`;
    host.innerHTML = markup;
    document.body.appendChild(host);

    try {
        const svg = host.querySelector("svg");
        if (!svg) throw new Error(`No <svg> root in marker: ${url}`);
        svg.setAttribute("width", String(sizePx));
        svg.setAttribute("height", String(sizePx));

        // Chrome won't run animations parked in <defs> (the Lottie export does that); move each onto its target.
        const animatedTargets = new Set<Element>();
        for (const anim of Array.from(
            svg.querySelectorAll(
                "defs > animateTransform, defs > animateMotion, defs > animate",
            ),
        )) {
            const href =
                anim.getAttribute("xlink:href") ?? anim.getAttribute("href");
            if (!href?.startsWith("#")) continue;
            const target = svg.querySelector(href);
            if (!target) continue;
            anim.removeAttribute("xlink:href");
            anim.removeAttribute("href");
            target.appendChild(anim);
            animatedTargets.add(target);
        }

        svg.pauseAnimations?.();
        const frameMs = 1000 / WAG_FPS;
        const frameCount = Math.max(2, loopFrameCount(svg, WAG_FPS));
        const durationS = (frameCount * frameMs) / 1000;

        const frames: ImageData[] = [];
        for (let i = 0; i < frameCount; i++) {
            svg.setCurrentTime?.((i / frameCount) * durationS);

            // Serializing the live node exports baseVal, not the current pose; bake each pose onto a clone.
            const clone = svg.cloneNode(true) as SVGSVGElement;
            const liveEls = Array.from(svg.querySelectorAll("*"));
            const cloneEls = Array.from(clone.querySelectorAll("*"));
            liveEls.forEach((el, idx) => {
                if (!animatedTargets.has(el)) return;
                const m = animatedMatrix(svg, el);
                cloneEls[idx]?.setAttribute(
                    "transform",
                    `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`,
                );
            });
            for (const n of Array.from(
                clone.querySelectorAll(
                    "animateTransform, animateMotion, animate",
                ),
            )) {
                n.remove();
            }

            const blobUrl = URL.createObjectURL(
                new Blob([new XMLSerializer().serializeToString(clone)], {
                    type: "image/svg+xml",
                }),
            );
            try {
                const img = new Image(sizePx, sizePx);
                await new Promise<void>((resolve, reject) => {
                    img.onload = () => resolve();
                    img.onerror = () =>
                        reject(new Error(`Frame ${i} failed to decode: ${url}`));
                    img.src = blobUrl;
                });
                frames.push(drawToImageData(img, sizePx));
            } finally {
                URL.revokeObjectURL(blobUrl);
            }
        }
        return { frames, frameMs };
    } finally {
        host.remove();
    }
}

// One rAF loop per icon id, phase-locked to paint; every dog shares the icon.
function startIconAnimation(
    map: mapboxgl.Map,
    iconId: string,
    frames: ImageData[],
    frameMs: number,
): void {
    const mapRecord = map as unknown as Record<string, unknown>;
    const timerKey = `__iconAnimTimer:${iconId}`;
    if (mapRecord[timerKey]) return;

    const loopMs = frameMs * frames.length;
    let startedAt: number | null = null;
    let lastFrame = -1;
    let raf = 0;

    const tick = (now: number): void => {
        if (!isMapAlive(map)) {
            cancelAnimationFrame(raf);
            delete mapRecord[timerKey];
            return;
        }
        // A style swap drops the sprite atlas for a few frames; that is transient, not terminal.
        if (!map.hasImage(iconId)) {
            raf = requestAnimationFrame(tick);
            return;
        }
        startedAt ??= now;
        const frame = Math.min(
            frames.length - 1,
            Math.floor(((now - startedAt) % loopMs) / frameMs),
        );
        if (frame !== lastFrame) {
            lastFrame = frame;
            map.updateImage(iconId, frames[frame]);
            // updateImage never schedules a render; on an idle map the pose would never upload.
            map.triggerRepaint();
        }
        raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    mapRecord[timerKey] = true;
}

async function addDogLayer(
    map: mapboxgl.Map,
    sourceId: string,
    markerUrl: string,
    onPointClick?: (feature: mapboxgl.MapboxGeoJSONFeature) => void,
): Promise<void> {
    const iconId = `${sourceId}-dog`;
    const layerId = `${sourceId}-dogs`;
    const mapRecord = map as unknown as Record<string, unknown>;

    if (!map.hasImage(iconId)) {
        const sizePx = MAP_CONFIG.marker.iconPixelSize;
        let frames: ImageData[];
        let frameMs = WAG_FALLBACK_DURATION_MS;
        try {
            ({ frames, frameMs } = await rasterizeSvgFrames(markerUrl, sizePx));
        } catch (err) {
            console.warn(
                "[map] animated marker bake failed, using a static icon:",
                err,
            );
            frames = [await rasterizeSvg(markerUrl, sizePx)];
        }
        if (!isMapAlive(map)) return;
        if (!map.hasImage(iconId)) {
            map.addImage(iconId, frames[0], { pixelRatio: 2 });
            if (frames.length > 1) {
                startIconAnimation(map, iconId, frames, frameMs);
            }
        }
    }

    if (!isMapAlive(map)) return;

    if (!map.getLayer(layerId)) {
        const base = MAP_CONFIG.marker.iconSize;
        map.addLayer({
            id: layerId,
            type: "symbol",
            source: sourceId,
            filter: ["!", ["has", "point_count"]],
            layout: {
                "icon-image": iconId,
                "icon-size": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    2,
                    base * 0.55,
                    8,
                    base * 0.85,
                    14,
                    base * 1.15,
                ],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
                "icon-anchor": "center",
            },
        });
    }

    const clickBoundKey = `__dogClickBound:${layerId}`;
    if (!mapRecord[clickBoundKey]) {
        mapRecord[clickBoundKey] = true;
        if (onPointClick) {
            map.on("click", layerId, (e) => {
                const feature = e.features?.[0];
                if (feature)
                    onPointClick(feature as mapboxgl.MapboxGeoJSONFeature);
            });
        }
        map.on("mouseenter", layerId, () => {
            map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layerId, () => {
            map.getCanvas().style.cursor = "";
        });
    }
}

/** Clustered pins, bottom to top: heatmap, cluster glow, cluster ring, wagging dogs. */
export function addClusteredPins(
    map: mapboxgl.Map,
    config: ClusteredPinsConfig,
): void {
    if (!isMapAlive(map)) return;

    const {
        id,
        data,
        onPointClick,
        clusterRadius = MAP_CONFIG.cluster.radius,
    } = config;
    const mapRecord = map as unknown as Record<string, unknown>;
    const safeData = filterFiniteFeatures(data);

    const existing = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
    if (existing) {
        existing.setData(safeData);
    } else {
        map.addSource(id, {
            type: "geojson",
            data: safeData,
            generateId: true,
            cluster: true,
            clusterMaxZoom: MAP_CONFIG.cluster.maxZoom,
            clusterRadius,
        });
    }

    const heatMinZoom = MAP_CONFIG.cluster.heatmap.minZoom;
    const heatMaxZoom = MAP_CONFIG.cluster.heatmap.maxZoom;

    const heatLayerId = `${id}-heat`;
    if (!map.getLayer(heatLayerId)) {
        map.addLayer({
            id: heatLayerId,
            type: "heatmap",
            source: id,
            minzoom: heatMinZoom,
            maxzoom: heatMaxZoom + 1,
            paint: {
                "heatmap-weight": [
                    "interpolate",
                    ["linear"],
                    pointCount,
                    1,
                    0.2,
                    50,
                    0.7,
                    200,
                    1,
                ] as unknown as mapboxgl.Expression,
                "heatmap-intensity": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    0,
                    0.6,
                    heatMaxZoom,
                    2.2,
                ],
                "heatmap-radius": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    0,
                    14,
                    heatMaxZoom,
                    38,
                ],
                "heatmap-color": heatmapColorExpression(),
                "heatmap-opacity": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    heatMaxZoom - 2,
                    0.9,
                    heatMaxZoom,
                    0,
                ],
            },
        });
    }

    const glowLayerId = `${id}-cluster-glow`;
    if (!map.getLayer(glowLayerId)) {
        map.addLayer({
            id: glowLayerId,
            type: "circle",
            source: id,
            filter: ["has", "point_count"],
            paint: {
                "circle-color": MAP_CONFIG.cluster.glow.color,
                "circle-radius": circleRadiusExpression(
                    MAP_CONFIG.cluster.glow.radiusScale,
                ),
                "circle-blur": MAP_CONFIG.cluster.glow.blur,
            },
        });
    }

    const clusterLayerId = `${id}-clusters`;
    if (!map.getLayer(clusterLayerId)) {
        map.addLayer({
            id: clusterLayerId,
            type: "circle",
            source: id,
            filter: ["has", "point_count"],
            paint: {
                "circle-color": circleColorExpression(),
                "circle-radius": circleRadiusExpression(),
                "circle-stroke-width": MAP_CONFIG.cluster.stroke.width,
                "circle-stroke-color": MAP_CONFIG.cluster.stroke.color,
                "circle-opacity": [
                    "interpolate",
                    ["linear"],
                    ["zoom"],
                    heatMaxZoom - 3,
                    0,
                    heatMaxZoom - 1,
                    1,
                ],
            },
        });
    }

    const markerUrl = config.markerUrl || MAP_CONFIG.markers.default;
    addDogLayer(map, id, markerUrl, onPointClick).catch((err) =>
        console.error("Failed to add dog layer:", err),
    );

    const boundClusterKey = `__clusteredPinsClusterClickBound:${id}`;
    if (!mapRecord[boundClusterKey]) {
        mapRecord[boundClusterKey] = true;
        map.on("click", clusterLayerId, (e) => {
            const features = map.queryRenderedFeatures(e.point, {
                layers: [clusterLayerId],
            });
            if (features.length === 0) return;
            const geometry = features[0].geometry;
            if (geometry.type !== "Point") return;
            const center = toCoordFromArray(geometry.coordinates);
            if (!center) return;
            const nextZoom = Math.min(
                map.getZoom() + 3,
                MAP_CONFIG.cluster.clickZoom,
            );
            safeEase(map, { center, zoom: nextZoom });
        });
        map.on("mouseenter", clusterLayerId, () => {
            map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", clusterLayerId, () => {
            map.getCanvas().style.cursor = "";
        });
    }
}
