/**
 * Group-simulator scenario matrix — Q&A + privacy.
 *
 * - "who's on the bench?" → the bench section is composed from the
 *   database (bench always shown, correctly).
 * - A `stats` question is answered from the club's completed-match
 *   record (2026-09-23), even in a batch that also carries a write: no
 *   write in the batch can change that record, and the write still lands.
 * - DM Q&A (scoped, no-leak): the context the model sees NEVER contains a
 *   raw phone number; the 📵 "no number on record" flags appear ONLY for
 *   admins (so "who's missing a number?" is admin-only in DMs). Asserted
 *   structurally via the test-only stub in dm-qa.ts, which returns the
 *   scoped context itself instead of calling Anthropic.
 * - Group → DM ("dm me …") answers privately with 📩.
 * - "my stats" fast-path DMs a personal magic link with 📊.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { selfIn } from "../helpers/stub";

/* ── PORTED 2026-09-06, §10 STEP 8 ────────────────────────────────────
 *
 * The first two cases fed a WRONG answer as a verdict and asserted the
 * server corrected it. There is no answer to feed: since §10 step 7 the
 * question route's reply is composed by `pipeline/compose.ts` from a
 * `SquadState` read out of the database, so the only thing a stub can
 * say is what the question was ABOUT (`topic`), and being right is not
 * optional any more — it is structural.
 *
 * The FIVE DM / fast-path cases below never touched the verdict seam at
 * all. They are the reason `MT_TEST_LLM_STUB_FILE` could not simply be
 * deleted with `analyzeBatch`: `dm-qa.ts` keys its own stub off that
 * variable being SET, never off the file's contents. The variable is now
 * called `MT_TEST_DM_QA_STUB` and does exactly that one job.
 */
const askBench = { route: "question", facts: { topic: "bench", personRef: null, statedCount: null } };

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

// Every sim phone starts with this — if these digits show up in any DM
// answer/context, a number leaked.
const PHONE_MARKER = "4477009";

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 14,
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
      { key: "pete", status: "CONFIRMED" },
      { key: "dan", status: "CONFIRMED" },
      { key: "gary", status: "CONFIRMED" }, // no phone on record
      { key: "larry", status: "CONFIRMED" }, // @lid, no phone on record
      { key: "greg", status: "BENCH" },
    ],
  })).attach(request);

test('"who\'s on the bench?" → answered from the DB, not from anyone\'s claim', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("alice", "@Match Time who's on the bench?", {
    // Interaction contract: a question is answer-y → requires a tag.
    tag: true,
    ...askBench,
  });
  // The COPY changed with the answerer. It used to be the batch-final
  // squad post's "*Bench (1):*" block, because the only way to correct a
  // wrong bench claim was to replace the whole reply with the squad
  // post. The `bench` topic has its own composed answer now
  // (`compose.ts`, "On the bench: …"), which is a narrower thing to say
  // and the right one for the question asked. What is asserted is the
  // same as before and is the point of the test: the answer is the
  // DATABASE's bench, named.
  expect(r.reply).toContain("Greg Gale");
  expect(r.reply, "and nobody who is not on the bench").not.toContain("Pete Power");
});

/* ── REPLACED 2026-09-06, §10 STEP 8. THE OLD CASE HAD NO SUBJECT. ────
 *
 * WAS: "leaderboard replies pass through verbatim — never collapsed or
 * canonicalised". It handed the route a finished leaderboard as
 * `verdict.reply` and asserted the squad-post collapse did not eat it.
 * Both halves are gone: nothing hands the route a reply any more, and
 * §10 step 4 replaced the collapse/canonicalise post-processors with
 * composition, so there is no machinery for a non-squad-state reply to
 * survive.
 *
 * WHAT REPLACES IT is the same worry answered by the shipped design:
 * `stats` is a `QuestionTopic` the answer engine does NOT own
 * (`answer-batch.ts`'s carve-outs), so a standings question in a batch
 * that also carries a write reaches nobody and MatchTime says nothing
 * about it — while the write still lands and still gets its own reply.
 * That is the honest successor: not "the leaderboard survives" but "the
 * batch does not invent one", and the write beside it is untouched.
 *
 * SUPERSEDED 2026-09-23. Every `stats` question is now a code-rendered
 * TABLE read from the club's completed-match record (`stats-answer.ts`,
 * `load-stats.ts`); a question naming no table is the appearances table,
 * which says the period it covers. A write in the same batch lands on
 * the UPCOMING match and cannot change that record, so the question is
 * owned and answered beside it. What this test still pins: the write
 * lands, and the answer is the stats table, never the squad list.
 */
test("a stats question in a writing batch is answered from the record, and the write beside it still lands", async ({ request, db }) => {
  const grp = await group(request, db);
  const batch = await grp.postBatch([
    { player: "felix", body: "in", route: "self_att", facts: selfIn() },
    {
      player: "owner",
      body: "@Match Time who's top of the standings?",
      tag: true, // question → requires a tag under the interaction contract
      route: "question",
      facts: { topic: "stats", personRef: null, statedCount: null },
    },
  ]);
  expect((await grp.attendanceOf("felix"))?.status).toBe("CONFIRMED");
  const reply = batch.results[1].reply ?? "";
  // The appearances table or its honest empty line, never the roster.
  expect(reply, "the stats question is answered").toMatch(/Most appearances|no completed matches/);
  expect(reply).not.toMatch(/Playing:/);
  expect(reply).not.toMatch(/[—–]/);
});

test('DM "what\'s X\'s number?" — context physically contains NO phone digits and no 📵 flags for a non-admin', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("pete", "what's Gary's phone number?");
  expect(r.json.handled).toBe("dm-qa");
  const answer = r.dms.find((d) => d.text.startsWith("[scoped-qa-stub]"));
  expect(answer).toBeTruthy();
  expect(answer!.text).toContain("Confirmed players:");
  // The no-leak guarantee, structurally: nothing to extract.
  expect(answer!.text).not.toContain(PHONE_MARKER);
  expect(answer!.text).not.toContain("📵");
});

test('DM "who\'s missing a number?" — 📵 flags present for an ADMIN, still zero raw digits', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("alice", "who's missing a number on record?");
  expect(r.json.handled).toBe("dm-qa");
  const answer = r.dms.find((d) => d.text.startsWith("[scoped-qa-stub]"));
  expect(answer).toBeTruthy();
  // Exactly the phone-less squad members are flagged.
  expect(answer!.text).toMatch(/Gary Guest 📵 no number on record/);
  expect(answer!.text).toMatch(/Larry Lid 📵 no number on record/);
  expect(answer!.text).not.toMatch(/Pete Power 📵/);
  expect(answer!.text).not.toContain(PHONE_MARKER);
});

test('group "dm me …" → answered PRIVATELY via scoped Q&A, 📩 react, no group reply', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("dan", "@MatchTime dm me when's the next game?");
  expect(r.handledBy).toBe("fast-path");
  expect(r.react).toBe("📩");
  expect(r.reply).toBeNull();
  const danPhone = grp.player("dan").phone!.replace(/^\+/, "");
  const dm = r.dms.find((d) => d.phone === danPhone);
  expect(dm).toBeTruthy();
  expect(dm!.text).toContain("UPCOMING MATCH:");
  expect(dm!.text).not.toContain(PHONE_MARKER); // group→DM context is flag-free too
});

/* ── THE PERSONAL STATS LINK, READ BY THE MODEL (2026-09-17) ───────────
 *
 * This used to be the `STATS_REQUEST` regex fast path ("no LLM
 * involved"). It is `QuestionFacts.topic = "my_stats"` now: the router
 * and extractor are stubbed with what the live model returns for these
 * phrasings (`scripts/dryrun-pipeline.ts MYSTATS=1`), and everything
 * after that is the real code. The property that matters most is WHO
 * gets the DM: the asker, and nobody else, whatever the message names.
 */
const MY_STATS = { route: "question", facts: { topic: "my_stats", personRef: "", statedCount: -1 } };
/** The personal stats-link DM, in either language. */
const statsLinkDms = (dms: Array<{ phone: string | null; text: string }>) =>
  dms.filter((d) => /MatchTime (stats|istatistiklerin)/.test(d.text));
const phoneOf = (grp: SimGroup, key: string) => grp.player(key).phone!.replace(/^\+/, "");

test('"my stats" → 📊 react + ONE personal magic-link DM, to the asker only', async ({ request, db }) => {
  const grp = await group(request, db);
  // Interaction contract: a stats request is answer-y → requires a tag.
  const r = await grp.post("pete", "@Match Time can I see my stats?", { tag: true, ...MY_STATS });
  expect(r.intent).toBe("stats_link");
  expect(r.react).toBe("📊");
  expect(r.reply, "the link never goes to the group").toBeNull();
  const links = statsLinkDms(r.dms);
  // THE RECIPIENT: exactly one stats DM, and it is Pete's.
  expect(links.map((d) => d.phone)).toEqual([phoneOf(grp, "pete")]);
  expect(links[0].text).toMatch(/https?:\/\//);
  expect(links[0].text).toContain("Hey Pete");
  // …and its link signs in as Pete (the token's subject is the asker).
  const row = await db.one<{ action: string }>(
    `SELECT action FROM "AnalyzedMessage" WHERE body = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    ["@Match Time can I see my stats?"],
  );
  expect(row?.action).toBe("dm-stats-link");
});

test('"my stats" naming SOMEONE ELSE in the same breath still DMs only the asker', async ({ request, db }) => {
  // Even if the model called this `my_stats`, the fact names no
  // recipient: the DM goes to the sender of the message.
  const grp = await group(request, db);
  const r = await grp.post("dan", "@Match Time send my stats to Pete and Alice", { tag: true, ...MY_STATS });
  const links = statsLinkDms(r.dms);
  expect(links.map((d) => d.phone)).toEqual([phoneOf(grp, "dan")]);
  expect(links[0].text).toContain("Hey Dan");
});

test("someone else's stats is a group question: no stats DM to anybody", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("dan", "@Match Time what are Pete's stats", {
    tag: true,
    route: "question",
    facts: { topic: "stats", personRef: "Pete", statedCount: -1 },
  });
  expect(statsLinkDms(r.dms)).toEqual([]);
  expect(r.react).not.toBe("📊");
});

test('untagged "my stats" is ordinary chat: no DM, no react', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("pete", "my stats are terrible this season", MY_STATS);
  expect(statsLinkDms(r.dms)).toEqual([]);
  expect(r.react ?? null).toBeNull();
});

test("an @lid sender with no phone on record gets no DM and no 📊", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("larry", "@Match Time my stats", { tag: true, ...MY_STATS });
  expect(statsLinkDms(r.dms)).toEqual([]);
  expect(r.react ?? null).toBeNull();
});
