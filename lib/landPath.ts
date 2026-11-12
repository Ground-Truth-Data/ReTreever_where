import { WHERE_VIEWS } from "../params/whereView";

/**
 * A land's address on the map, `<slug>-<id>`. The id alone resolves; the slug is for people, and a
 * wrong one is redirected, never trusted.
 *
 * The id is the first 40 bits of sha256(projectKey, the land's name) in Crockford base 32: the parts its
 * land key is built from, so a re-key keeps it, and a hash, so it can't be counted through.
 */

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
export const LAND_ID_LENGTH = 8;
const SLUG_MAX = 60;

// Every Crockford character plus the look-alikes it reads as 1 and 0; only `u` is never one.
const SEGMENT_RE = /^(.*)-([0-9a-tv-z]{8})$/i;

// Postgres's btrim strips spaces only, and the server's SQL fallback must hash the same bytes.
const trimSpaces = (s: string) => s.replace(/^ +| +$/g, "");

/** The bytes the id hashes: project key, NUL, the land's name trimmed and lower-cased. */
export function landIdInput(projectKey: string, landName: string): Uint8Array {
	return new TextEncoder().encode(`${projectKey}\0${trimSpaces(landName).toLowerCase()}`);
}

/** The id from a sha256 digest: its first five bytes, five bits a character. */
export function landIdFromDigest(digest: Uint8Array): string {
	let bits = 0n;
	for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(digest[i]);
	let id = "";
	for (let shift = 35n; shift >= 0n; shift -= 5n) id += CROCKFORD[Number((bits >> shift) & 31n)];
	return id;
}

/** The five bytes an id stands for, as hex: what the first five bytes of its digest must be. */
export function landIdHex(id: string): string {
	let bits = 0n;
	for (const c of id) bits = (bits << 5n) | BigInt(CROCKFORD.indexOf(c));
	return bits.toString(16).padStart(10, "0");
}

export async function landId(projectKey: string, landName: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", landIdInput(projectKey, landName) as BufferSource);
	return landIdFromDigest(new Uint8Array(digest));
}

// Letters NFKD leaves whole, so a name keeps its sound instead of losing a letter to a dash.
const FOLD: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", ł: "l", þ: "th", ı: "i" };

/** The land's name as a path word: plain lowercase ASCII, dashes between, cut at a dash by 60 characters. */
export function landSlug(name: string | null | undefined): string {
	let slug = (name ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[ßæœøđðłþı]/g, (c) => FOLD[c])
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length > SLUG_MAX) {
		const cut = slug.lastIndexOf("-", SLUG_MAX);
		slug = slug.slice(0, cut > 0 ? cut : SLUG_MAX);
	}
	return slug || "land";
}

export const landSegment = (name: string | null | undefined, id: string) => `${landSlug(name)}-${id}`;

/**
 * `<slug>-<id>` → its parts, or null. The id is read as Crockford reads it, so a link typed from print
 * (`QBC2MXGS`, `o` for 0, `l` for 1) still lands; the redirect then shows it as written here.
 */
export function parseLandSegment(segment: string): { slug: string; id: string } | null {
	if ((WHERE_VIEWS as readonly string[]).includes(segment)) return null;
	const m = SEGMENT_RE.exec(segment);
	if (!m) return null;
	const id = m[2].toLowerCase().replace(/[il]/g, "1").replace(/o/g, "0");
	return { slug: m[1], id };
}

/** The map's own path under a land or a view (`/es/where/orgs` → `/es/where`), language prefix kept. */
export function whereBase(pathname: string): string {
	const i = pathname.lastIndexOf("/");
	const last = pathname.slice(i + 1);
	return (WHERE_VIEWS as readonly string[]).includes(last) || parseLandSegment(last) ? pathname.slice(0, i) : pathname;
}

/** "Land · Project", or the one name when the land is named for its project. */
export function landTitle(landName: string | null | undefined, projectName: string | null | undefined): string {
	const land = landName?.trim() || "";
	const project = projectName?.trim() || "";
	if (!land || !project || land.toLowerCase() === project.toLowerCase()) return land || project;
	return `${land} · ${project}`;
}
