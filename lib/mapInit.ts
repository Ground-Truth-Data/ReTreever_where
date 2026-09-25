import mapboxgl from "mapbox-gl";
import {
    compactGlobeOptions,
    defaultOptions,
    fullMapOptions,
    MAP_CONFIG,
} from "./MAP_CONFIG";
import {
    CustomStyleControl,
    defaultStyleOptions,
    styleIdFromUrl,
} from "./mapControlBaseToggle";
import type { MapOptions } from "./mapTypes";
import { applyNaturalOverrides, NATURAL_FOG } from "./mapStyleNatural";
import { parseMapHash, setMapHash } from "./mapUtilsHash";
import { safeEase } from "./safeEase";
import { safeJumpTo } from "./safeMap";
import { installCoveringTilesGuard } from "./safeMarker";
import { isCoord } from "./coord";

const defaultSatStyle = MAP_CONFIG.styles.defaultSat;

// `true` so Sentry's replay can snapshot the canvas; `false` records maps blank.
const MAP_PRESERVE_DRAWING_BUFFER = true;

function startRotation(
    map: mapboxgl.Map,
    options: MapOptions,
    userInteractingRef: { current: boolean },
): void {
    const degreesPerSecond =
        options.rotationSpeed ?? MAP_CONFIG.globe.rotationSpeed;
    const maxSpinZoom = MAP_CONFIG.globe.maxSpinZoom;

    // rAF + jumpTo, not easeTo: on mapbox 3.x globe, easeTo recurses through
    // setLocationAtPoint → _updateZoomFromElevation and blows the stack.
    let raf = 0;
    let lastT = 0;
    let cameraRecovered = false;

    function step(t: number) {
        if (!map) return;
        const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
        lastT = t;

        // Covers gestures an event list misses (pinch's first touchend, wheel zoom).
        const userDrivingCamera =
            userInteractingRef.current ||
            map.isMoving() ||
            map.isZooming() ||
            map.isRotating();

        if (!userDrivingCamera && map.getZoom() < maxSpinZoom && dt > 0) {
            const center = map.getCenter();
            const centerOk =
                Number.isFinite(center.lng) && Number.isFinite(center.lat);

            if (centerOk) {
                cameraRecovered = false;
                center.lng -= degreesPerSecond * dt;
                safeJumpTo(map, {
                    center: [center.lng, center.lat],
                    zoom: map.getZoom(),
                });
            } else if (!cameraRecovered) {
                cameraRecovered = true;
                const fallback = options.initialCenter;
                safeJumpTo(map, {
                    center:
                        fallback &&
                        Number.isFinite(fallback[0]) &&
                        Number.isFinite(fallback[1])
                            ? fallback
                            : [0, 20],
                    zoom: Number.isFinite(options.initialZoom)
                        ? (options.initialZoom as number)
                        : 1.5,
                });
            }
        }
        raf = requestAnimationFrame(step);
    }

    raf = requestAnimationFrame(step);

    map.once("remove", () => {
        if (raf) cancelAnimationFrame(raf);
    });
}

export function initializeMap(
    container: HTMLDivElement,
    options: MapOptions = {},
): () => void {
    const opts = { ...defaultOptions, ...options };
    const mapboxAccessToken = import.meta.env.VITE_MAPBOX_TOKEN;
    const maxSpinZoom = MAP_CONFIG.globe.maxSpinZoom;

    if (opts.enableHash && typeof window !== "undefined") {
        const parsed = parseMapHash(window.location.hash);
        if (parsed) {
            opts.initialZoom = parsed.zoom;
            opts.initialCenter = parsed.center;
        }
    }

    if (!mapboxAccessToken) {
        const name = "VITE_MAPBOX_TOKEN";
        const msg =
            `${name} is not set, so no map can be created.\n` +
            `Copy .env.example to .env and paste in a token, then restart the dev server.\n` +
            `(Mounted inside ReTreever or rapper, it goes in that tier's .env instead.)\n` +
            `Free tokens: https://account.mapbox.com/access-tokens/`;
        console.error(msg);

        const note = document.createElement("div");
        note.style.cssText =
            "padding:1rem;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;" +
            "white-space:pre-wrap;color:#b3261e;background:#fff4f2;border:1px solid #f0c9c2;" +
            "border-radius:6px;margin:1rem;max-width:52ch";
        note.textContent = msg;
        container.appendChild(note);

        return () => {
            note.remove();
        };
    }

    mapboxgl.accessToken = mapboxAccessToken;

    const userInteractingRef = { current: false };

    // The transform must be born finite: mapbox's mousemove handler throws on a NaN camera.
    const safeCenter: [number, number] = isCoord(opts.initialCenter)
        ? ([opts.initialCenter[0], opts.initialCenter[1]] as [number, number])
        : ([
              defaultOptions.initialCenter[0],
              defaultOptions.initialCenter[1],
          ] as [number, number]);
    const safeZoom: number = Number.isFinite(opts.initialZoom)
        ? (opts.initialZoom as number)
        : (defaultOptions.initialZoom as number);
    if (
        safeCenter[0] !== opts.initialCenter?.[0] ||
        safeCenter[1] !== opts.initialCenter?.[1] ||
        safeZoom !== opts.initialZoom
    ) {
        console.warn("[mapInit] degenerate initial camera — using defaults", {
            got: { center: opts.initialCenter, zoom: opts.initialZoom },
            using: { center: safeCenter, zoom: safeZoom },
        });
    }

    const map = new mapboxgl.Map({
        container,
        style: opts.style || defaultSatStyle,
        ...(opts.transformRequest
            ? { transformRequest: opts.transformRequest }
            : {}),
        hash: false,
        // Credit controls can't be moved after construction; re-added by hand below.
        ...(opts.creditsSplit
            ? {
                  logoPosition: "bottom-right" as const,
                  attributionControl: false,
              }
            : {}),
        center: safeCenter,
        zoom: safeZoom,
        projection: opts.globeProjection ? "globe" : "mercator",
        interactive: true,
        pitch: 0,
        bearing: 0,
        preserveDrawingBuffer: MAP_PRESERVE_DRAWING_BUFFER,
    });

    installCoveringTilesGuard(map);

    if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__rtMap = map;
    }

    opts.onMapCreated?.(map);

    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    // iOS WebKit reclaims the GL context under memory pressure; `webglcontextrestored` needs preventDefault() on loss.
    const glCanvas = map.getCanvas();
    const onContextLost = (e: Event) => {
        e.preventDefault();
        console.warn("[mapInit] WebGL context lost — awaiting restore");
    };
    const onContextRestored = () => {
        console.warn("[mapInit] WebGL context restored — repainting map");
        map.resize();
        map.triggerRepaint();
    };
    glCanvas.addEventListener("webglcontextlost", onContextLost, false);
    glCanvas.addEventListener("webglcontextrestored", onContextRestored, false);

    // A resize while the container is momentarily 0×0 (popover, iOS keyboard) leaves a NaN camera that never self-repairs.
    let lastGoodCenter: [number, number] = safeCenter;
    let lastGoodZoom = safeZoom;
    let unhealthySince: number | null = null;
    map.on("moveend", () => {
        const c = map.getCenter();
        if (Number.isFinite(c.lng) && Number.isFinite(c.lat)) {
            lastGoodCenter = [c.lng, c.lat];
            const z = map.getZoom();
            if (Number.isFinite(z)) lastGoodZoom = z;
        }
    });
    const healthWatchdog = window.setInterval(() => {
        let cameraBad = false;
        try {
            const c = map.getCenter();
            const z = map.getZoom();
            cameraBad =
                !Number.isFinite(c.lng) ||
                !Number.isFinite(c.lat) ||
                !Number.isFinite(z);
        } catch {
            cameraBad = true;
        }
        const canvasEl = map.getCanvas();
        const cont = map.getContainer();
        const canvasDead =
            cont.clientWidth > 0 &&
            cont.clientHeight > 0 &&
            (canvasEl.clientWidth === 0 || canvasEl.clientHeight === 0);
        if (cameraBad) {
            if (unhealthySince === null) {
                console.warn(
                    "[mapInit] camera transform degenerate — restoring last good view",
                );
            }
            safeJumpTo(map, { center: lastGoodCenter, zoom: lastGoodZoom });
        }
        if (cameraBad || canvasDead) {
            unhealthySince ??= Date.now();
            map.resize();
            map.triggerRepaint();
        } else if (unhealthySince !== null) {
            console.warn(
                `[mapInit] map healthy again after ${Math.round((Date.now() - unhealthySince) / 1000)}s`,
            );
            unhealthySince = null;
        }
    }, 400);

    // On globe projection any DEM source makes animated easeTo recurse and blow the stack.
    map.on("style.load", () => {
        map.setTerrain(null);
    });

    if (opts.enableHash) {
        map.on("moveend", () => {
            if (map.getZoom() < maxSpinZoom) return;
            setMapHash(map, opts.writeHash);
        });
    }

    if (!opts.scrollZoom) {
        map.scrollZoom.disable();
    } else {
        map.scrollZoom.setWheelZoomRate(1 / 60);
        map.scrollZoom.setZoomRate(1 / 35);
    }

    if (opts.autoRotate) {
        // map.stop() freezes the globe synchronously — the rAF step alone would slide one more frame and miss the click.
        map.on("mousedown", () => {
            userInteractingRef.current = true;
            map.stop();
            opts.onUserInteractionStart?.();
        });
        map.on("mouseup", () => {
            userInteractingRef.current = false;
            opts.onUserInteractionEnd?.();
        });

        // The first touchend arrives while the second finger is still pinching.
        map.on("touchstart", () => {
            userInteractingRef.current = true;
            map.stop();
            opts.onUserInteractionStart?.();
        });
        map.on("touchend", (e) => {
            if ((e.originalEvent?.touches?.length ?? 0) > 0) return;
            userInteractingRef.current = false;
            opts.onUserInteractionEnd?.();
        });
        // A cancelled touch fires no touchend; without this the globe never spins again.
        map.on("touchcancel", () => {
            userInteractingRef.current = false;
            opts.onUserInteractionEnd?.();
        });

        map.on("dragstart", () => {
            userInteractingRef.current = true;
            opts.onUserInteractionStart?.();
        });
        map.on("dragend", () => {
            userInteractingRef.current = false;
            opts.onUserInteractionEnd?.();
        });
    }

    if (opts.globeProjection || opts.hideLabels) {
        map.on("style.load", () => {
            if (opts.globeProjection) {
                if (opts.transparentBackground) {
                    map.setFog({
                        color: "white",
                        "high-color": "white",
                        "horizon-blend": 0.015,
                        "space-color": "white",
                        "star-intensity": 0.4,
                    });
                } else {
                    const name = map.getStyle()?.name?.toLowerCase() ?? "";
                    const isDark = name.includes("dark");
                    map.setFog(
                        isDark
                            ? NATURAL_FOG
                            : {
                                  color: "rgba(186, 210, 235, 0.35)",
                                  "high-color": "rgba(36, 92, 223, 0.18)",
                                  "horizon-blend": 0.015,
                                  "space-color": "rgb(11, 11, 25)",
                                  "star-intensity": 0.4,
                              },
                    );

                    if (isDark) {
                        applyNaturalOverrides(map);
                    }
                }
            }

            if (opts.hideLabels) {
                const layers = map.getStyle()?.layers || [];
                const whitelist = opts.labelWhitelist ?? [];
                for (const layer of layers) {
                    if (layer.type !== "symbol") continue;
                    const isWhitelisted =
                        whitelist.length > 0 &&
                        whitelist.some((prefix) => layer.id.startsWith(prefix));
                    if (isWhitelisted) continue;
                    try {
                        const hasText =
                            map.getLayoutProperty(layer.id, "text-field") !=
                            null;
                        if (hasText)
                            map.setLayoutProperty(
                                layer.id,
                                "visibility",
                                "none",
                            );
                    } catch {
                        // codestyle-allow-swallow: hiding a label layer is cosmetic; a style not yet loaded / missing layer id just leaves it visible
                    }
                }
            }
        });
    }

    // Mapbox's terms require the attribution visible; `compact: false` keeps it a line, not an (i) button.
    if (opts.creditsSplit) {
        map.addControl(
            new mapboxgl.AttributionControl({ compact: false }),
            "bottom-left",
        );
    }

    if (opts.showNavigation && !opts.mobileControls) {
        const nc = new mapboxgl.NavigationControl();
        map.addControl(nc, "top-left");
    }

    if ((opts.showScale ?? opts.showNavigation) && !opts.mobileControls) {
        const scaleControl = new mapboxgl.ScaleControl({
            maxWidth: 160,
            unit: "metric",
        });
        map.addControl(
            scaleControl,
            opts.cornerControlsBottomRight ? "bottom-right" : "bottom-left",
        );
    }

    if (opts.showZoomReadout) {
        const readout = document.createElement("div");
        readout.className = "mapboxgl-ctrl rt-zoom-readout";
        readout.setAttribute("aria-hidden", "true");

        const paint = () => {
            readout.textContent = `z${map.getZoom().toFixed(1)}`;
        };
        paint();
        map.on("zoom", paint);
        map.on("move", paint);

        map.addControl(
            {
                onAdd: () => readout,
                onRemove: () => {
                    map.off("zoom", paint);
                    map.off("move", paint);
                    readout.remove();
                },
            },
            "bottom-right",
        );
    }

    if (opts.showStyleControl) {
        const initialStyleId = styleIdFromUrl(
            opts.style ?? defaultSatStyle,
            defaultStyleOptions,
        );
        const stylePosition = opts.mobileControls ? "top-right" : "top-left";
        map.addControl(
            new CustomStyleControl(defaultStyleOptions, initialStyleId),
            stylePosition,
        );
    }

    // Elastic zoom: hard limits sit `overshoot` past the soft ones and zoomend eases back.
    const { softMin, softMax, overshoot, easeMs } = MAP_CONFIG.zoom;
    map.setMinZoom(softMin - overshoot);
    map.setMaxZoom(softMax + overshoot);
    map.on("zoomend", () => {
        const z = map.getZoom();
        if (z > softMax) safeEase(map, { zoom: softMax, duration: easeMs });
        else if (z < softMin) safeEase(map, { zoom: softMin, duration: easeMs });
    });

    map.on("load", async () => {
        map.resize();
        if (opts.autoRotate) startRotation(map, opts, userInteractingRef);
        opts.onMapReady?.(map);
    });

    return () => {
        window.clearInterval(healthWatchdog);
        glCanvas.removeEventListener("webglcontextlost", onContextLost);
        glCanvas.removeEventListener("webglcontextrestored", onContextRestored);
        map.remove();
    };
}

export { fullMapOptions, compactGlobeOptions };
export type { MapOptions, PolygonConfig } from "./mapTypes";
