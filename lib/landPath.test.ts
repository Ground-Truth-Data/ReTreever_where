import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { landId, landIdFromDigest, landIdHex, landIdInput, landSegment, landSlug, landTitle, parseLandSegment, whereBase } from "./landPath";

describe("landId", () => {
	it("gives dev's two examples", async () => {
		expect(await landId("e-eg9mb36depj8z7l6", "Institutional Zone")).toBe("m3zj35cq");
		expect(await landId("c-23fcb78d-9acb-4d31-8d97-cfc786b4e52a", "The Montessori School of Tokyo - Forest Campus")).toBe("qbc2mxgs");
	});

	it("ignores case and outer spaces, as the land key does", async () => {
		expect(await landId("e-eg9mb36depj8z7l6", "  INSTITUTIONAL zone ")).toBe("m3zj35cq");
	});

	it("agrees with node's sha256, which the server uses", () => {
		const digest = createHash("sha256").update(landIdInput("e-eg9mb36depj8z7l6", "Institutional Zone")).digest();
		expect(landIdFromDigest(digest)).toBe("m3zj35cq");
	});

	it("hex is the digest's first five bytes", () => {
		const digest = createHash("sha256").update(landIdInput("e-eg9mb36depj8z7l6", "Institutional Zone")).digest();
		expect(landIdHex("m3zj35cq")).toBe(digest.subarray(0, 5).toString("hex"));
		expect(landIdHex("00000000")).toBe("0000000000");
	});
});

describe("landSlug", () => {
	it("drops accents and joins words with dashes", () => {
		expect(landSlug("Ildefonso Guzmán Herrera")).toBe("ildefonso-guzman-herrera");
		expect(landSlug("The Montessori School of Tokyo - Forest Campus")).toBe("the-montessori-school-of-tokyo-forest-campus");
	});

	it("turns any run of punctuation into one dash and trims the ends", () => {
		expect(landSlug("  «Plot #3» — (north) / 2024!! ")).toBe("plot-3-north-2024");
	});

	it("keeps letters NFKD leaves whole", () => {
		expect(landSlug("Großer Wald Øst")).toBe("grosser-wald-ost");
	});

	it("cuts at the last dash by 60 characters", () => {
		const slug = landSlug("Agroforestry with cacao and coffee for the sustainability of smallholder families");
		expect(slug).toBe("agroforestry-with-cacao-and-coffee-for-the-sustainability-of");
		expect(slug.length).toBeLessThanOrEqual(60);
		expect(landSlug(`${"a".repeat(60)} b`)).toBe("a".repeat(60));
		expect(landSlug("x".repeat(80))).toBe("x".repeat(60));
	});

	it("is `land` when nothing survives", () => {
		expect(landSlug("森林")).toBe("land");
		expect(landSlug(" — ")).toBe("land");
		expect(landSlug(null)).toBe("land");
	});
});

describe("parseLandSegment", () => {
	it("splits a segment into slug and id", () => {
		expect(parseLandSegment(landSegment("Institutional Zone", "m3zj35cq"))).toEqual({ slug: "institutional-zone", id: "m3zj35cq" });
	});

	it("reads the id as Crockford does", () => {
		expect(parseLandSegment("x-QBC2MXGS")?.id).toBe("qbc2mxgs");
		expect(parseLandSegment("x-ol2mxgsi")?.id).toBe("012mxgs1");
	});

	it("refuses views, bare ids and non-ids", () => {
		expect(parseLandSegment("orgs")).toBeNull();
		expect(parseLandSegment("projects")).toBeNull();
		expect(parseLandSegment("m3zj35cq")).toBeNull();
		expect(parseLandSegment("zone-m3zj35c")).toBeNull();
		expect(parseLandSegment("zone-m3zj35cu")).toBeNull();
	});
});

describe("whereBase", () => {
	it("strips a land or a view, keeping the language", () => {
		expect(whereBase("/where/institutional-zone-m3zj35cq")).toBe("/where");
		expect(whereBase("/es/where/institutional-zone-m3zj35cq")).toBe("/es/where");
		expect(whereBase("/pt-br/where/orgs")).toBe("/pt-br/where");
		expect(whereBase("/fr/where")).toBe("/fr/where");
	});
});

describe("landTitle", () => {
	it("names land and project, once when they match", () => {
		expect(landTitle("Institutional Zone", "Greater Kruger SDP Landscape")).toBe("Institutional Zone · Greater Kruger SDP Landscape");
		expect(landTitle("Forest Campus", " forest campus")).toBe("Forest Campus");
		expect(landTitle(null, "Project")).toBe("Project");
	});
});
