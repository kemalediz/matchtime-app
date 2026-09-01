/**
 * Does a reconstructed world actually BUILD?
 *
 *   npm run replay:extract     # once, read-only against production
 *   npm run test:replay
 *
 * Stubbed and free: no model is called, so every verdict is the sim's
 * silent default. That is deliberate — what this spec checks is not what
 * the analyzer decides but whether the worlds `e2e/replay/reconstruct.ts`
 * produces are constructible against the real schema and survive a real
 * POST to /api/whatsapp/analyze. A reconstruction that only type-checks
 * is worth nothing; the live sweep costs money and must not be the place
 * a missing column is discovered.
 *
 * Skips (does not fail) when no extract is present — the extract reads
 * production and is not something CI should do.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { testDb } from "../helpers/test-db";
import { CurrentAnalyzerPipeline } from "../corpus/current-analyzer-pipeline";
import { containsRawPhone } from "../corpus/grade";
import type { ReplayCase } from "../replay/types";

const CASES_FILE = path.join(process.cwd(), ".e2e", "replay", "cases.json");
/** Enough to exercise every shape (full squad, empty squad, outsider
 *  sender, multi-message batch) without turning a free spec into a slow
 *  one. Deterministic: the first N by batch instant. */
const SAMPLE = Number(process.env.MT_REPLAY_SMOKE ?? 12);

test.describe("history replay — reconstructed worlds are constructible", () => {
  test("every sampled world builds, and the squad it claims is the squad it has", async ({
    request,
  }) => {
    test.skip(
      !existsSync(CASES_FILE),
      `no ${CASES_FILE} — run \`npm run replay:extract\` (reads production, read-only)`,
    );
    test.setTimeout(120_000);

    const { cases } = JSON.parse(readFileSync(CASES_FILE, "utf8")) as { cases: ReplayCase[] };
    expect(cases.length, "the extract produced no replayable cases").toBeGreaterThan(0);

    const db = testDb();
    const pipeline = new CurrentAnalyzerPipeline();
    const sample = cases.slice(0, SAMPLE);

    for (const c of sample) {
      const o = await pipeline.run({ request, db }, c.case, "stub");

      // The world the reconstruction CLAIMS is the world the database
      // ended up with. If these drift, every downstream verdict is
      // being compared against a squad nobody ever had.
      const tally = (s: string) => o.attendanceBefore.filter((r) => r.status === s).length;
      expect(
        { confirmed: tally("CONFIRMED"), bench: tally("BENCH"), dropped: tally("DROPPED") },
        `world mismatch on ${c.key}`,
      ).toEqual(c.meta.squadBefore);

      // Privacy holds through the whole pipeline, not just the extract.
      for (const text of [...o.spoken, ...o.dms.map((d) => d.text)]) {
        expect(containsRawPhone(text), `raw phone in ${c.key}: ${text}`).toBe(false);
      }
    }
  });

  test("the extract itself carries no phone number and no WhatsApp JID", async () => {
    test.skip(!existsSync(CASES_FILE), "no extract present");
    const blob = readFileSync(CASES_FILE, "utf8");
    expect(blob).not.toContain("@g.us");
    expect(blob).not.toContain("@lid");
    expect(blob).not.toContain("@c.us");
    expect(blob).not.toMatch(/\b0\d{9,10}\b/);
    expect(blob).not.toMatch(/\+44\d{9,10}\b/);
  });
});
