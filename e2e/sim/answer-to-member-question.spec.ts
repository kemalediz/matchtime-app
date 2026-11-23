/**
 * AN ANSWER TO A MEMBER'S "ARE YOU IN?" SIGNS THE SENDER IN
 * (Vets MNF, Monday 2026-11-23, production).
 *
 * The real conversation, replayed verbatim through the real analyze route,
 * same senders, same words, same order and the same flushes as production
 * stored them (AnalyzedMessage rows, read-only):
 *
 *   16:29 Kemal   cmwthdyzc001a08l5w29vtm2o  "@Shane are you IN? If so, ..."
 *   16:59 Steff   cmwtigcc8000208jwvrdv8onu  "@Shane !!!!!"
 *   17:09 Shane   cmwtitb9o000108l5ylgz46v6  "So 7v7 if I’m in ?"
 *   17:39 Kemal   cmwtk8mqk002007jvlsovy13b  "yes"         (stored 17:49, one flush with the next)
 *   17:49 Kemal   cmwtk8msr002107jvwnvv9omp  "so are you in? :)"
 *   18:29 Shane   cmwtlo7hw002e07l3mfc7ok4r  "Yeah and you and your lad come then it’s 8v8 👌"
 *
 * Shane had said "Out" at 14:39. His last line answers Kemal's question, so
 * it is his own IN, untagged. Production read no claim and he stayed out
 * until Kemal tagged MatchTime at 18:40.
 *
 *   stubbed (free):  npx tsx e2e/run.ts sim/answer-to-member-question.spec.ts
 *   live (dev key):  MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/answer-to-member-question.spec.ts
 *
 * Stubbed, it proves the wiring: the question Shane answers is in the
 * extractor's RECENT CHAT, and a sender IN on the `offer` route production
 * chose signs him in. Live, every line goes through the real router and
 * extractor, and the run prints its calls and cost.
 */
import { readFileSync } from "node:fs";
import { test, expect, resetDb } from "../fixtures";
import { createGroup, type SimGroup } from "./group";
import { clearExtractorStub, clearRouterStub, selfIn } from "../helpers/stub";
import { E2E } from "../helpers/env";
import type { TestDb } from "../helpers/test-db";

const LIVE = process.env.MT_SIM_LIVE_LLM === "1";

/** The words exactly as production stored them. */
const KEMAL_1629 =
  "@Shane are you IN? If so, I will ask MT to generate the teams.\n\n \nThere is a small chance I may come depending on my arrival to Sutton. If I come, I will come with David, my son. For the time being, consider me as OUT";
const STEFF_1659 = "@Shane !!!!!";
const SHANE_1709 = "So 7v7 if I’m in ?";
const KEMAL_1749a = "yes";
const KEMAL_1749b = "so are you in? :)";
const SHANE_1829 = "Yeah and you and your lad come then it’s 8v8 👌";

/** Who is who: the sim's players under the real people's roster names. */
const WHO = { kemal: { key: "owner", name: "Kemal" }, steff: { key: "dan", name: "Steff" }, shane: { key: "pete", name: "Shane" } } as const;
type Who = keyof typeof WHO;

/** Twelve of fourteen confirmed is not needed for the reading; Kemal and Shane are out, as they were. */
const SQUAD = [
  ...["alice", "dan", "felix", "greg", "henry", "ivan"].map((key) => ({ key, status: "CONFIRMED" as const })),
  { key: "owner", status: "DROPPED" as const },
  { key: "pete", status: "DROPPED" as const },
];

async function nameThem(g: SimGroup, db: TestDb) {
  for (const w of Object.values(WHO)) await db.run(`UPDATE "User" SET name = $2 WHERE id = $1`, [g.player(w.key).userId, w.name]);
}

function line(g: SimGroup, who: Who, body: string, stub?: { route: string; facts?: Record<string, unknown> }) {
  const p = g.player(WHO[who].key);
  return {
    body,
    author: { name: WHO[who].name, phone: (p.phone ?? "").replace(/^\+/, "") },
    ...(LIVE || !stub ? {} : stub),
  };
}

/** The afternoon, flush by flush, as production received it. */
async function replay(g: SimGroup) {
  const none = { route: "none" };
  await g.postBatch([line(g, "kemal", KEMAL_1629, none)]);
  await g.postBatch([line(g, "steff", STEFF_1659, none)]);
  await g.postBatch([line(g, "shane", SHANE_1709, { route: "offer" })]);
  await g.postBatch([line(g, "kemal", KEMAL_1749a, none), line(g, "kemal", KEMAL_1749b, none)]);
  return g.postBatch([line(g, "shane", SHANE_1829, { route: "offer", facts: selfIn() })]);
}

function extractorCalls(): Array<{ label: string; user: string }> {
  try {
    return readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string });
  } catch {
    return [];
  }
}

const usage = (db: TestDb, orgId: string) =>
  db.one<{ calls: number; cost: number }>(
    `SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum("costUsd"), 0)::float AS cost FROM "OrgAiUsage" WHERE "orgId" = $1`,
    [orgId],
  );

(LIVE ? test.describe.skip : test.describe)("Vets 2026-11-23, Shane answers 'so are you in?' (stubbed)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.beforeEach(() => clearExtractorStub());
  test.afterEach(() => {
    clearRouterStub();
    clearExtractorStub();
  });

  test("the question reaches the extractor, and his IN on the offer route signs him in, untagged", async ({ request, db }) => {
    const g = await createGroup(request, db, { maxPlayers: 14, attendance: SQUAD });
    await nameThem(g, db);
    const res = await replay(g);
    expect((await g.attendanceOf(WHO.shane.key))?.status).toBe("CONFIRMED");
    expect(res.results[0].reply ?? null).toBeNull();

    const call = extractorCalls().find((c) => c.user.trimEnd().endsWith(SHANE_1829));
    expect(call, "the attendance extractor read his answer").toBeTruthy();
    const recent = call!.user.slice(call!.user.indexOf("RECENT CHAT"), call!.user.indexOf("THE MESSAGE"));
    expect(recent).toContain("Kemal: so are you in? :)");
    expect(recent).toContain("Kemal: @Shane are you IN?");
    expect(recent).toContain(`Shane: ${SHANE_1709}`);
  });
});

(LIVE ? test.describe : test.describe.skip)("Vets 2026-11-23, Shane answers 'so are you in?', LIVE (real model, real route)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(resetDb);
  test.afterAll(() => resetDb());

  test("the real conversation, verbatim: Shane is IN after his last line, no tag; Kemal stays out", async ({ request, db }) => {
    test.setTimeout(240_000);
    const g = await createGroup(request, db, { maxPlayers: 14, attendance: SQUAD });
    await nameThem(g, db);
    const before = await usage(db, g.orgId);
    const res = await replay(g);
    const after = await usage(db, g.orgId);
    const r = res.results[0];
    console.log(`[live] Shane 18:29: ${JSON.stringify({ react: r.react, reply: r.reply, handledBy: r.handledBy, intent: r.intent })}`);
    console.log(`[live] conversation model calls: ${(after?.calls ?? 0) - (before?.calls ?? 0)}, cost: $${((after?.cost ?? 0) - (before?.cost ?? 0)).toFixed(5)}`);
    expect((await g.attendanceOf(WHO.shane.key))?.status, "Shane IN after his last line").toBe("CONFIRMED");
    expect((await g.attendanceOf(WHO.kemal.key))?.status, "Kemal's 'consider me as OUT' stands").toBe("DROPPED");
  });
});
