/**
 * §10 STEPS 6 AND 8 — THE SEATBELTS ARE ACTUALLY DELETED NOW.
 *
 *   step 6: "Delete the OUT net, the IN net, the bench-demote net, and
 *            both prose-parsing regexes."
 *
 * Step 6 could not do it. This file's previous version said why, and the
 * reasoning was right at the time:
 *
 *   "they are still physically present, because the flag ships default
 *    OFF and §10's revert for this step is 'flag flips the three routes
 *    back'. A revert that restored the analyzer without its guards is
 *    not a revert. The redundancy proof is real but CONDITIONAL, and the
 *    condition is exactly what this flag controls. They become deletable
 *    the day the flag defaults ON and the old attendance path is retired
 *    with step 7."
 *
 * That day is today. Step 8 deletes `analyzeBatch` and the 19,850-token
 * `SYSTEM_PROMPT`, so there is no analyzer to revert to and no flag
 * controlling the condition. The three nets are gone from
 * `analyze/route.ts`, along with `executeVerdict` and every other branch
 * whose input was a field on `AnalysisVerdict`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS FILE STILL EXISTS AFTER THE THING IT WATCHED IS GONE
 * ─────────────────────────────────────────────────────────────────────
 *
 * Four seatbelts were found dead in this codebase on 2026-08-31, all
 * silent, ALL WITH COMMENTS CLAIMING THEY WORKED. A deletion is not
 * allowed to rest on an essay, and neither is the claim that the error
 * class went with it. So the file inverts rather than retires:
 *
 *   1. GONE — the three markers are absent from the route. Checked, not
 *      asserted in prose, because "we meant to delete it" and "it is
 *      deleted" have been different things here before.
 *   2. STILL UNREPRESENTABLE — each net's only input (`intent`,
 *      `reasoning`, `reply`) is a field no owned route's extractor
 *      schema contains. THIS IS THE HALF THAT MATTERS MOST NOW. While
 *      the nets existed, a schema growing a `reasoning` field back would
 *      only have made a guard reachable. With them gone it would mean
 *      the model is being asked for prose again, with nothing watching
 *      it — so this assertion is the load-bearing one, and it is why the
 *      file was inverted instead of deleted.
 *   3. NOTHING SLIPPED BACK — `executeVerdict` and the verdict types are
 *      absent too, so a future change cannot quietly reintroduce the
 *      shape these guards were written for.
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
const ANALYZER = fs.readFileSync(
  path.resolve(__dirname, "../message-analyzer.ts"),
  "utf8",
);

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

describe("all three nets are gone from the analyze route", () => {
  it.each(NETS)("$name is deleted", ({ marker }) => {
    expect(
      ROUTE.indexOf(marker),
      `${marker} is still in the route. Step 8's whole claim is that these ` +
        `three are deleted rather than merely unreachable; a guard that reads ` +
        `a field the model no longer produces is dead code that reads as a ` +
        `safety net, which is the exact shape of the four found dead on ` +
        `2026-08-31.`,
    ).toBe(-1);
  });

  it("`executeVerdict` is gone, and with it every branch that read a verdict", () => {
    expect(ROUTE).not.toContain("async function executeVerdict");
    expect(ROUTE).not.toContain("await executeVerdict(");
  });

  it("nothing in the route reads a verdict field any more", () => {
    // The five fields §5's fifty-four guards were built around. A match
    // here means a guard came back, or a new one was written against a
    // shape that no longer exists.
    //
    // COMMENTS ARE STRIPPED FIRST, and that is not a convenience. The
    // route's headers name these fields repeatedly, on purpose — the
    // convention this repo holds hardest is that a deletion writes down
    // what it deleted and why the failure is now unrepresentable. A
    // scan that could not tell prose from code would force those essays
    // to be vaguer, which is the opposite of what it is for.
    const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const field of [
      "verdict.intent",
      "verdict.reasoning",
      "verdict.reply",
      "verdict.registerAttendance",
      "verdict.registerFor",
    ]) {
      expect(code, `the route reads ${field} again`).not.toContain(field);
    }
  });
});

describe("the mega-prompt itself is gone", () => {
  it("`SYSTEM_PROMPT` and `analyzeBatch` are not exported any more", () => {
    expect(ANALYZER).not.toContain("export const SYSTEM_PROMPT");
    expect(ANALYZER).not.toContain("export async function analyzeBatch");
  });

  it("`AnalysisVerdict` is not a type anybody can import", () => {
    expect(ANALYZER).not.toContain("export interface AnalysisVerdict");
    expect(ANALYZER).not.toContain("export type AnalysisIntent");
  });

  it("the scheduled-chase composer survives the deletion", () => {
    // The deletion's blast radius stopped here: `composeChaseText` is a
    // separate live feature on the scheduler. Its prompt was rewritten
    // on its own on 2026-10-20 (`chase-lead.ts`), and `enforceProximity`
    // moved to `proximity.ts` and is re-exported.
    expect(ANALYZER).toContain("export async function composeChaseText");
    expect(ANALYZER).toContain("export async function composeChaseFromMatch");
    expect(ANALYZER).toContain('export { enforceProximity } from "./proximity"');
    expect(ANALYZER).toContain("CHASE_LEAD_SYSTEM");
  });
});

describe("each net's input is unrepresentable in the engine's schemas", () => {
  // ── THE LOAD-BEARING HALF, NOW MORE THAN BEFORE ────────────────────
  //
  // While the nets existed, a schema growing `reasoning` back would have
  // made a dead guard live again. With the nets deleted it would mean
  // the model is being asked for free-text rationale with nothing at all
  // reading it — the "that is not an interface, it is a hope" shape,
  // reintroduced silently. This is the assertion that stops it.
  it.each(NETS)("$name read `$input`, which no owned route's schema has", ({ input }) => {
    for (const route of ENGINE_ROUTES) {
      const schema = JSON.stringify(factsSchemaFor(route));
      expect(schema, `${route}'s schema now contains "${input}"`).not.toContain(`"${input}"`);
    }
  });

  it("the attendance schema carries one polarity per claim, so no two fields can disagree", () => {
    // The IN and OUT nets both existed because `intent` and
    // `registerAttendance` were hallucinated separately and contradicted
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

describe("the incidents are not forgotten, they moved", () => {
  it.each(NETS)("$name's incident is a corpus case rather than a comment", ({ incident }) => {
    // §12's stated deliverable: "the incident archive stops being a
    // prompt and becomes a test suite". Each of the three dates below
    // has a replayable case; if one is removed, the incident it records
    // has genuinely stopped being covered by anything and that must
    // fail loudly rather than quietly.
    const corpus = fs.readFileSync(
      path.resolve(__dirname, "../../../e2e/corpus/incidents.jsonl"),
      "utf8",
    );
    const date = incident.match(/\d{4}-\d{2}-\d{2}/)![0];
    expect(corpus, `no corpus case cites ${date}`).toContain(date);
  });
});
