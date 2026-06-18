/**
 * SELF-REPLACE — LIVE-LLM scenario suite.
 *
 * Mirrors the section-G ("self-replace") scenario from attendance.spec.ts
 * but drives the REAL Anthropic model instead of the deterministic stub.
 * Opt-in: this whole describe block only runs when MT_SIM_LIVE_LLM=1.
 * When the flag is OFF (the default for `npm run test:sim` /
 * `npm run test:e2e`), the entire file is SKIPPED — so it never breaks the
 * stubbed suite (where inferVerdict() returns undefined for these complex
 * sentences and the bot would otherwise stay silent and fail the asserts).
 *
 * In live mode the harness IGNORES any `verdict` option (group.ts postBatch
 * skips setLlmStub and ignores canned verdicts), so we pass NO verdict —
 * the model produces the verdict from the natural-language body.
 *
 * Three cases, each in its own fresh group, serial:
 *   1. self-replace (non-admin "replace me with Aydın") → direct swap, no 👍
 *   2. admin-directed ("move Aydın … to replace Ehtisham") → direct promote
 *   3. NEGATIVE — unrelated non-admin nominates someone else → Aydın stays bench
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

// Copied verbatim from attendance.spec.ts section G.
const PROMOTE_ROSTER = [
  { key: "owner", name: "Oscar Owner", role: "OWNER" as const },
  { key: "alice", name: "Alice Admin", role: "ADMIN" as const },
  { key: "pete", name: "Pete Power" },
  { key: "dan", name: "Dan Drummer" },
  { key: "ehtisham", name: "Ehtisham Ekin" },
  { key: "aydin", name: "Aydın Arslan" },
  { key: "salman", name: "Salman Saric" },
];

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

(LIVE ? test.describe : test.describe.skip)(
  "self-replace LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    // ── CASE 1 — self-replace, non-admin ────────────────────────────────
    test('CASE 1 — non-admin "replace me with Aydın" → direct swap, no 👍, squad full', async ({
      request,
      db,
    }) => {
      test.setTimeout(120_000); // real Anthropic call can take 10–60s

      const grp = (
        await createGroup(request, db, {
          maxPlayers: 5,
          players: PROMOTE_ROSTER,
          attendance: [
            { key: "owner", status: "CONFIRMED" },
            { key: "alice", status: "CONFIRMED" },
            { key: "pete", status: "CONFIRMED" },
            { key: "dan", status: "CONFIRMED" },
            { key: "ehtisham", status: "CONFIRMED" }, // squad full at 5/5
            { key: "aydin", status: "BENCH" },
            { key: "salman", status: "BENCH" },
          ],
        })
      ).attach(request);

      // No verdict — the live model infers the swap from the message.
      // Tagged: the message promotes another player (directed op) → the
      // interaction contract requires an @Match Time tag.
      const r = await grp.post(
        "ehtisham",
        "@Match Time can't make it — replace me with Aydın from the bench",
        { tag: true },
      );

      expect(await grp.dropped()).toContain("Ehtisham Ekin");
      expect(await grp.confirmed()).not.toContain("Ehtisham Ekin");
      expect((await grp.attendanceOf("aydin"))?.status).toBe("CONFIRMED");
      expect(await grp.confirmed()).toContain("Aydın Arslan");
      expect((await grp.counts()).confirmed).toBe(grp.maxPlayers);
      expect((await grp.attendanceOf("salman"))?.status).toBe("BENCH");
      expect(await grp.openOffers()).toHaveLength(0);

      const finalText = [r.reply ?? "", ...r.groupPosts, ...r.dms.map((d) => d.text)].join("\n");
      expect(finalText).not.toMatch(/👍/);
      expect(finalText).not.toMatch(/react .* to confirm/i);
      expect(finalText).not.toMatch(/asking the bench/i);
      expect(finalText).not.toMatch(/until .*confirm/i);
      expect(finalText).not.toMatch(/step up/i);
      expect(finalText).toMatch(/Aydın|5\/5/);
    });

    // ── CASE 2 — admin-directed ─────────────────────────────────────────
    test('CASE 2 — admin "move Aydın from bench to replace Ehtisham" → direct promote, squad full', async ({
      request,
      db,
    }) => {
      test.setTimeout(120_000);

      const grp = (
        await createGroup(request, db, {
          maxPlayers: 5,
          players: PROMOTE_ROSTER,
          attendance: [
            { key: "owner", status: "CONFIRMED" },
            { key: "alice", status: "CONFIRMED" },
            { key: "pete", status: "CONFIRMED" },
            { key: "dan", status: "CONFIRMED" },
            { key: "ehtisham", status: "CONFIRMED" }, // squad full at 5/5
            { key: "aydin", status: "BENCH" },
            { key: "salman", status: "BENCH" },
          ],
        })
      ).attach(request);

      const r = await grp.post("alice", "@Match Time move Aydın from bench to squad to replace Ehtisham", { tag: true });

      expect(await grp.dropped()).toContain("Ehtisham Ekin");
      expect(await grp.confirmed()).not.toContain("Ehtisham Ekin");
      expect((await grp.attendanceOf("aydin"))?.status).toBe("CONFIRMED");
      expect(await grp.confirmed()).toContain("Aydın Arslan");
      expect((await grp.counts()).confirmed).toBe(grp.maxPlayers);
      expect((await grp.attendanceOf("salman"))?.status).toBe("BENCH");
      expect(await grp.openOffers()).toHaveLength(0);

      const finalText = [r.reply ?? "", ...r.groupPosts, ...r.dms.map((d) => d.text)].join("\n");
      expect(finalText).not.toMatch(/asking the bench/i);
      expect(finalText).not.toMatch(/until .*confirm/i);
      expect(finalText).toMatch(/Aydın|5\/5/);
    });

    // ── CASE 3 — NEGATIVE: unrelated non-admin nominates someone else ────
    test('CASE 3 — unrelated non-admin "replace Ehtisham with Aydın" → Aydın stays BENCH', async ({
      request,
      db,
    }) => {
      test.setTimeout(120_000);

      const BILAL_ROSTER = [...PROMOTE_ROSTER, { key: "bilal", name: "Bilal Bright" }];
      const grp = (
        await createGroup(request, db, {
          maxPlayers: 5,
          players: BILAL_ROSTER,
          attendance: [
            { key: "owner", status: "CONFIRMED" },
            { key: "alice", status: "CONFIRMED" },
            { key: "pete", status: "CONFIRMED" },
            { key: "ehtisham", status: "CONFIRMED" }, // 4/5 — one slot genuinely free
            { key: "aydin", status: "BENCH" },
          ],
        })
      ).attach(request);

      // bilal is a plain PLAYER and is NOT Ehtisham — he can't pick the
      // replacement. The IN must NOT promote despite the free slot.
      // Tagged so the message reaches the promote-AUTHORISATION gate (the
      // gate under test); without the tag the interaction contract would
      // suppress it for a different reason.
      await grp.post("bilal", "@Match Time replace Ehtisham with Aydın from the bench", { tag: true });

      expect((await grp.attendanceOf("aydin"))?.status).toBe("BENCH");
      expect(await grp.bench()).toContain("Aydın Arslan");
      expect(await grp.confirmed()).not.toContain("Aydın Arslan");
    });
  },
);
