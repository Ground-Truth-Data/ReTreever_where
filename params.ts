import { defineParams } from "@sveltejs/kit/params";
import { parseLandSegment, WHERE_VIEWS, type WhereView } from "./lib/landPath.ts";

export const params = defineParams({
	whereView: (param) => ((WHERE_VIEWS as readonly string[]).includes(param) ? (param as WhereView) : undefined),
	// A land's segment, `<slug>-<8-char id>`; never a view.
	whereLand: (param) => (parseLandSegment(param) ? param : undefined),
});
