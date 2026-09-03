/**
 * §10 STEP 6 — THE SEATBELTS THIS STEP DELETES, AND THE PROOF.
 *
 *   "Delete the OUT net, the IN net, the bench-demote net, and both
 *    prose-parsing regexes."
 *
 * Four seatbelts were found dead in this codebase on 2026-08-31, all
 * silent, ALL WITH COMMENTS CLAIMING THEY WORKED. So a deletion is not
 * allowed to rest on an essay either. This file is the machine-checkable
 * half of the three redundancy proofs in `analyze/route.ts`:
 *
 *   1. STRUCTURAL — the engine short-circuit returns BEFORE all three
 *      nets, so no message `ATTENDANCE_ENGINE_ENABLED` owns can reach
 *      one. That is what "deleted on the engine path" means, and it is
 *      checked by position in the file rather than assumed.
 *   2. SEMANTIC — each net's only input is a field the extractor
 *      schemas do not contain, so the error it catches is
 *      unrepresentable rather than merely unlikely. (The schema half is
 *      asserted in `pipeline/__tests__/extractors.test.ts`; this file
 *      pins the mapping from net → missing field, so a schema that
 *      grew one of them back would fail HERE, where the claim was
 *      made.)
 *   3. CONDITIONAL — and therefore they are still physically present,
 *      because the flag ships default OFF and §10's revert for this
 *      step is "flag flips the three routes back". A revert that
 *      restored the analyzer without its guards is not a revert. The
 *      test below states that condition so a future reader cannot
 *      mistake "still here" for "nobody got round to it".
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ATTENDANCE_SCHEMA } from "../pipeline/extractors";
import { ENGINE_ROUTES } from "../pipeline/gate";
import { factsSchemaFor } from "../pipeline/extractors";

const ROUTE = fs.readFileSync(
  path.resolve(__dirname, "../../app/api/whatsapp/analyze/route.ts"),
  "utf8",
);

/** The `continue` that hands a message to the engine and returns before
 *  every verdict-reading branch in the loop. */
const ENGINE_SHORT_CIRCUIT = "const engineOutcome = engineBatch?.outcomes.get(msg.waMessageId);";

const NETS: Array<{ name: string; marker: string; input: string; incident: string }> = [
  {
    name: "the IN safety net",
    marker: "// ── IN intent safety net ──",
    input: "intent",
    incident: "Najib 2026-05-08 (f61a897)",
  },
  {
    name: "the OUT safety net (prose regex over `reasoning`)",
    marker: "// ── OUT intent safety net ──",
    input: "reasoning",
    incident: "Mojib/Habib 2026-05-26 (f35dfe6)",
  },
  {
    name: "the bench-demote net (prose regex over `reply`)",
    marker: "// ── BENCH-DEMOTE safety net",
    input: "reply",
    incident: "Salman Shelly 2026-06-11 (9afa357)",
  },
];

describe("all three nets are unreachable for a message the engine owns", () => {
  it("the analyze route still contains the engine short-circuit", () => {
    expect(ROUTE).toContain(ENGINE_SHORT_CIRCUIT);
  });

  it.each(NETS)("$name sits BELOW the short-circuit", ({ marker }) => {
    const shortCircuit = ROUTE.indexOf(ENGINE_SHORT_CIRCUIT);
    const net = ROUTE.indexOf(marker);
    expect(net, `${marker} is not in the route any more`).toBeGreaterThan(-1);
    expect(
      net,
      `${marker} is now ABOVE the engine short-circuit, so a message the engine\n` +
        `owns would reach it with an all-nulls placeholder verdict. That is not\n` +
        `merely untidy: the IN net would force registerAttendance:"IN" on a\n` +
        `message the engine may have decided is a third-party add, and the\n` +
        `bench-demote net would synthesise a BENCH from a reply the engine did\n` +
        `not write.\n`,
    ).toBeGreaterThan(shortCircuit);
  });

  it("the short-circuit ends in a `continue`, so nothing below it runs", () => {
    const start = ROUTE.indexOf(ENGINE_SHORT_CIRCUIT);
    const firstNet = Math.min(...NETS.map((n) => ROUTE.indexOf(n.marker)));
    const block = ROUTE.slice(start, firstNet);
    expect(block).toContain("continue;");
  });
});

describe("each net's input is unrepresentable in the engine's schemas", () => {
  it.each(NETS)("$name reads `$input`, which no owned route's schema has", ({ input }) => {
    for (const route of ENGINE_ROUTES) {
      const schema = JSON.stringify(factsSchemaFor(route));
      expect(schema, `${route}'s schema now contains "${input}"`).not.toContain(`"${input}"`);
    }
  });

  it("the attendance schema carries one polarity per claim, so no two fields can disagree", () => {
    // The IN and OUT nets both exist because `intent` and
    // `registerAttendance` are hallucinated separately and contradict
    // each other. One field cannot contradict itself.
    const claim = ATTENDANCE_SCHEMA.properties.claims as unknown as {
      items: { properties: Record<string, unknown>; required: string[] };
    };
    const polarityFields = Object.keys(claim.items.properties).filter((k) =>
      /polarity|intent|register|action/i.test(k),
    );
    expect(polarityFields).toEqual(["polarity"]);
  });

  it("a recruit ask is a SEPARATE field from the claim, so it cannot swallow the drop", () => {
    // The OUT net's whole incident is `replacement_request` carrying two
    // facts in one intent and losing one of them. Here the drop is a
    // claim and the ask is a side request; neither can consume the
    // other. (2026-09-01's incident was the mirror image on a fast path.)
    expect(Object.keys(ATTENDANCE_SCHEMA.properties)).toEqual(
      expect.arrayContaining(["claims", "sideRequests"]),
    );
    expect(ATTENDANCE_SCHEMA.required).toEqual(
      expect.arrayContaining(["claims", "sideRequests"]),
    );
  });
});

describe("they are KEPT, on purpose, and the route says why", () => {
  it("the flag ships default OFF, so the analyzer still decides by default", async () => {
    const { isAttendanceEngineEnabled } = await import("../pipeline/gate");
    expect(isAttendanceEngineEnabled({})).toBe(false);
  });

  it("the route records the deviation rather than leaving it to be inferred", () => {
    expect(ROUTE).toContain("THE THREE SEATBELTS THIS STEP DELETES");
    expect(ROUTE).toContain("WHY THEY ARE STILL PHYSICALLY HERE");
  });

  it.each(NETS)("$name still names the incident it was written for", ({ marker, incident }) => {
    const at = ROUTE.indexOf(marker);
    const window = ROUTE.slice(at, at + 3000);
    const date = incident.match(/\d{4}-\d{2}-\d{2}/)![0];
    expect(window, `${marker} lost its incident date`).toContain(date);
  });

  it("the OUT net's regexes are still pinned by their own tests", () => {
    // `out-safety-net.ts` is the file §9's table points at. It is alive
    // for the analyzer path and must stay tested while it is.
    const exists = fs.existsSync(
      path.resolve(__dirname, "..", "out-safety-net.ts"),
    );
    expect(exists).toBe(true);
    expect(
      fs.existsSync(path.resolve(__dirname, "out-safety-net.test.ts")),
    ).toBe(true);
  });
});
