// Rule: a child may not name a parent (ReTreever/rapper/vercel) as a location — reach one only via $parent/siblings/... or a prop.
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CHILD = fileURLToPath(new URL("..", import.meta.url));
const EXT = new Set([".svelte", ".ts", ".js", ".css", ".json"]);

// Tests are exempt by SHAPE (*.test.*), not by an explicit list — they never cross the build boundary a parent bundles.
const isTest = (name: string) => /\.test\.[^.]+$/.test(name);

function sources(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "assets") continue;
		if (e.name.startsWith(".")) continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) sources(full, out);
		else if (EXT.has(extname(e.name)) && !isTest(e.name)) out.push(full);
	}
	return out;
}

// A parent named as a PLACE: a path segment, an import, or a URL host — anchored on separators so it won't fire on this child's own folder name or on comment prose.
// Symbol.for(...) registry keys are brand strings, not locations, and are exempt by shape — a guard that cries wolf gets deleted.
const BRAND_STRING = /Symbol\.for\(/;

// ⚠️ Match both mid-path (`../ReTreever/…`) and terminal occurrences (`href="{GH}/rapper"`, a bare URL, `<span>retreever</span>`) — a trailing-delimiter-only regex missed every terminal case and let real offenders through.
const PARENT_AS_LOCATION =
	/(?:\.\.?\/|["'`({]\/?|\}\/|https?:\/\/[^"'`\s]*)(?:ReTreever|rapper|vercel)(?:[/.]|["'`)\s<]|$)/gi;

describe("the child names no parent", () => {
	it("no path, import or URL names ReTreever, rapper or vercel", () => {
		const offenders: string[] = [];

		for (const file of sources(CHILD)) {
			const text = readFileSync(file, "utf8");
			// Checked over two joined lines so a wrapped Symbol.for(...) is still recognised as a brand string.
			const lines = text.split("\n");
			// Block comments span lines, so comment-detection tracks state across lines rather than per-line (startsWith('*') alone misses plainly-indented continuation lines).
			let inBlockComment = false;
			for (const [i, line] of lines.entries()) {
				const stmt = `${lines[i - 1] ?? ""}\n${line}`;
				const t = line.trim();
				const wasInComment = inBlockComment;
				// Opens/closes counted per line so a one-line /* */ isn't treated as opening a block, and a closing line is still skipped up to the close.
				const opens = (line.match(/\/\*/g) ?? []).length;
				const closes = (line.match(/\*\//g) ?? []).length;
				if (opens > closes) inBlockComment = true;
				else if (closes > opens) inBlockComment = false;

				if (wasInComment || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
					continue; // documentation, not a dependency
				}
				if (BRAND_STRING.test(stmt)) continue;
				for (const m of line.matchAll(PARENT_AS_LOCATION)) {
					offenders.push(`${relative(CHILD, file)}:${i + 1}  ${m[0]}`);
				}
			}
		}

		expect(
			offenders,
			`These name a PARENT as a location:\n\n` +
				offenders.map((o) => `  ${o}`).join("\n") +
				`\n\nA child has two possible parents and must run under either, so ` +
				`naming one is a defect even when the path resolves — and side by ` +
				`side on one machine, it DOES resolve. It stops resolving the ` +
				`moment this folder is published on its own, which is the point ` +
				`of the folder.\n\n` +
				`Reach a parent through the alias ($parent/siblings/...), or take what you ` +
				`need as a prop. Never by name.`,
		).toEqual([]);
	});

	it("the check bites — a parent-named path is detected", () => {
		// Without this, a broken regex silently passes everything above.
		const ok = 'import x from "$parent/siblings/getCache_OnlineMap/lib/foo";';
		expect([...ok.matchAll(PARENT_AS_LOCATION)].length).toBe(0);

		// Both shapes (mid-path and terminal) are asserted by name — losing either re-opens the hole the regex used to miss.
		const bad = [
			'import x from "../ReTreever/src/lib/foo";', // mid-path
			'href="{GH}/rapper"', // terminal, in a string
			'"https://github.com/Ground-Truth-Data/rapper"', // terminal, full URL
		];
		for (const b of bad) {
			expect(
				[...b.matchAll(PARENT_AS_LOCATION)].length,
				`should have been flagged: ${b}`,
			).toBeGreaterThan(0);
		}
	});
});
