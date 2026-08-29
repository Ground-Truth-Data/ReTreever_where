import type { Reroute } from "@sveltejs/kit";

// Universal hook — reached only when a parent points kit.files.hooks.universal here; a standalone child never runs it.
// ⚠️ Keep DEFAULT in step with this child's defaultPath in the registry — nav and the printed url read that record.
const SERVED: string[] = [];
const DEFAULT = "/where";

export const reroute: Reroute = ({ url }) => {
	const known = [DEFAULT, ...SERVED].some((p) => url.pathname === p);
	if (!known) return DEFAULT;
};
