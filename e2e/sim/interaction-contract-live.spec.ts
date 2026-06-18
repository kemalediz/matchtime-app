/**
 * INTERACTION CONTRACT — LIVE-LLM validation.
 *
 * Drives the REAL Anthropic model (no stubbed verdict) to confirm the
 * deterministic gate + strengthened SYSTEM_PROMPT hold together on the
 * classification-sensitive cases. Each case is run several times because
 * the model is non-deterministic; the gate must hold EVERY run.
 *
 * Opt-in: this whole describe block only runs when MT_SIM_LIVE_LLM=1.
 * Default suites SKIP it entirely.
 *
 * Run:
 *   set -a; source .env; set +a
 *   MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/interaction-contract-live.spec.ts
 *
 * NEVER weaken these assertions — tune the SYSTEM_PROMPT until reliable.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";
const RUNS = 4; // repeat each classification-sensitive case 4×

(LIVE ? test.describe : test.describe.skip)(
  "interaction contract LIVE (real Anthropic model)",
  () => {
    test.describe.configure({ mode: "serial" });
    test.beforeAll(resetDb);

    const mkGroup = (request: APIRequestContext, db: TestDb) =>
      createGroup(request, db, {
        maxPlayers: 14,
        attendance: [
          { key: "owner", status: "CONFIRMED" },
          { key: "alice", status: "CONFIRMED" },
          { key: "pete", status: "CONFIRMED" },
          { key: "dan", status: "CONFIRMED" },
          { key: "felix", status: "CONFIRMED" },
          { key: "greg", status: "CONFIRMED" },
        ],
      });

    test(`hypothetical "If I was in the team it won't be ruined" → NO attendance write (×${RUNS})`, async ({
      request,
      db,
    }) => {
      test.setTimeout(180_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const before = await grp.counts();
        const r = await grp.post("liam", "If I was in the team it won't be ruined");
        // eslint-disable-next-line no-console
        console.log(`[ic-live] hypothetical run ${i + 1}: intent=${r.intent} react=${r.react}`);
        expect(await grp.attendanceOf("liam"), `run ${i + 1}: liam must not be registered`).toBeNull();
        const after = await grp.counts();
        expect(after.confirmed, `run ${i + 1}`).toBe(before.confirmed);
        expect(after.bench, `run ${i + 1}`).toBe(before.bench);
      }
    });

    test(`untagged "what are the teams?" → SILENT, no reply (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(180_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("pete", "what are the teams?");
        // eslint-disable-next-line no-console
        console.log(`[ic-live] untagged-question run ${i + 1}: intent=${r.intent} reply=${JSON.stringify(r.reply)}`);
        expect(r.reply, `run ${i + 1}: must stay silent`).toBeNull();
        expect(r.groupPosts, `run ${i + 1}`).toEqual([]);
      }
    });

    test(`tagged "@Match Time what are the teams?" → ANSWERS (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(180_000);
      let answered = 0;
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("pete", "@Match Time what are the teams?", { tag: true });
        // eslint-disable-next-line no-console
        console.log(`[ic-live] tagged-question run ${i + 1}: intent=${r.intent} hasReply=${!!r.reply}`);
        if ((r.reply ?? "").trim().length > 0 || r.groupPosts.length > 0) answered++;
      }
      // The model must answer a tagged question every run.
      expect(answered, "tagged question must be answered every run").toBe(RUNS);
    });

    test(`bare "In" → registers the sender (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(180_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        const r = await grp.post("henry", "In");
        // eslint-disable-next-line no-console
        console.log(`[ic-live] bare-IN run ${i + 1}: intent=${r.intent} react=${r.react}`);
        const att = await grp.attendanceOf("henry");
        expect(att, `run ${i + 1}: henry must be registered`).not.toBeNull();
        expect(["CONFIRMED", "BENCH"]).toContain(att!.status);
      }
    });

    test(`bare "Out" → drops the sender (×${RUNS})`, async ({ request, db }) => {
      test.setTimeout(180_000);
      for (let i = 0; i < RUNS; i++) {
        const grp = (await mkGroup(request, db)).attach(request);
        // pete starts CONFIRMED; a bare OUT must drop him.
        const r = await grp.post("pete", "Out");
        // eslint-disable-next-line no-console
        console.log(`[ic-live] bare-OUT run ${i + 1}: intent=${r.intent} react=${r.react}`);
        const att = await grp.attendanceOf("pete");
        expect(att?.status, `run ${i + 1}: pete must be dropped`).toBe("DROPPED");
      }
    });
  },
);
