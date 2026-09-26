// Prototype patch keeping a degenerate transform out of Mapbox's tile cover (safeMap.ts covers the camera).

const COVERINGTILES_INSTALLED = Symbol.for(
	"retreever.safeCoveringTiles.installed",
);

// Patches the shared prototype off a live map: Transform is not exported.
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
			// codestyle-allow-swallow: suppressed + logged once; the next good tick recomputes
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
