/**
 * Group-simulator scenario matrix — Q&A + privacy.
 *
 * - "who's on the bench?" → the unified answer, shown the DATABASE's bench
 *   (2026-11-18: the composed bench answer was deleted with the other
 *   question categories).
 * - A stats question is answered in a batch that also carries a write,
 *   and the write still lands.
 * - DM Q&A (no-leak, the unified answer since 2026-11-18): the context the
 *   model sees NEVER contains a raw phone number; who has no number on
 *   record appears ONLY for admins. Asserted structurally via the test-only
 *   stub in dm-qa.ts, which returns the context itself instead of calling
 *   Anthropic.
 * - Group → DM ("dm me …") answers privately with 📩.
 * - "my stats" DMs a personal magic link and says so in the group (2026-09-23; it was a 📊 react).
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { readFileSync } from "node:fs";
import { selfIn } from "../helpers/stub";
import { E2E } from "../helpers/env";

/** The unified answer's turn for this body, as the stub was shown it. */
function unifiedTurn(body: string): string {
  return (
    readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string })
      .filter((c) => c.label === "unified-answer" && c.user.trimEnd().endsWith(body))
      .pop()?.user ?? ""
  );
}

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
const BENCH_ANSWER = "On the bench: Greg Gale.";
const askBench = { route: "question", facts: { kind: "other", personRef: "", feature: "none", badge: "none", answer: BENCH_ANSWER } };

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
  // The answer is the stubbed model's; what is asserted is what it was
  // SHOWN: the DATABASE's bench, by name, whatever anyone claimed.
  expect(r.reply).toBe(BENCH_ANSWER);
  const turn = unifiedTurn("@Match Time who's on the bench?");
  const bench = turn.slice(turn.indexOf("BENCH ("), turn.indexOf("TEAMS"));
  expect(bench).toContain("Greg Gale");
  expect(bench, "and nobody who is not on the bench").not.toContain("Pete Power");
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
      facts: { kind: "other", personRef: "", feature: "none", badge: "none", answer: "The full table is on the stats page." },
    },
  ]);
  expect((await grp.attendanceOf("felix"))?.status).toBe("CONFIRMED");
  const reply = batch.results[1].reply ?? "";
  // The unified answer, never the roster.
  expect(reply, "the stats question is answered").toBe("The full table is on the stats page.");
  expect(reply).not.toMatch(/Playing:/);
});

test('DM "what\'s X\'s number?" — context physically contains NO phone digits and no 📵 flags for a non-admin', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("pete", "what's Gary's phone number?");
  expect(r.json.handled).toBe("dm-qa");
  const answer = r.dms.find((d) => d.text.startsWith("[unified-dm-stub]"));
  expect(answer).toBeTruthy();
  expect(answer!.text).toMatch(/^SQUAD \(/m);
  // The no-leak guarantee, structurally: nothing to extract.
  expect(answer!.text).not.toContain(PHONE_MARKER);
  expect(answer!.text).not.toContain("NO PHONE NUMBER ON RECORD");
});

test('DM "who\'s missing a number?" — 📵 flags present for an ADMIN, still zero raw digits', async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.dm("alice", "who's missing a number on record?");
  expect(r.json.handled).toBe("dm-qa");
  const answer = r.dms.find((d) => d.text.startsWith("[unified-dm-stub]"));
  expect(answer).toBeTruthy();
  // Exactly the phone-less squad members are named, never a number.
  const line = answer!.text.split("\n").find((l) => l.startsWith("NO PHONE NUMBER ON RECORD")) ?? "";
  expect(line).toContain("Gary Guest");
  expect(line).toContain("Larry Lid");
  expect(line).not.toContain("Pete Power");
  expect(answer!.text).not.toContain(PHONE_MARKER);
});

// The group "dm me ..." regex fast path is deleted (2026-10-30, no string
// parsing): a tagged question is the router's `question` route.

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

test('"my stats" → a "sending by DM" line + ONE personal magic-link DM, to the asker only', async ({ request, db }) => {
  const grp = await group(request, db);
  // Interaction contract: a stats request is answer-y → requires a tag.
  const r = await grp.post("pete", "@Match Time can I see my stats?", { tag: true, ...MY_STATS });
  expect(r.intent).toBe("stats_link");
  // 2026-09-23: a line addressed to the asker replaced the 📊 react.
  expect(r.react ?? null).toBeNull();
  expect(r.reply).toBe("📊 Pete, I'm sending your stats to you privately by DM.");
  expect(r.reply, "the link never goes to the group").not.toMatch(/https?:\/\//);
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
    facts: { kind: "other", personRef: "Pete", feature: "none", badge: "none" },
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

test("an @lid sender with no phone on record gets no DM, no react and no group line", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("larry", "@Match Time my stats", { tag: true, ...MY_STATS });
  expect(statsLinkDms(r.dms)).toEqual([]);
  expect(r.react ?? null).toBeNull();
  expect(r.reply ?? null).toBeNull();
});

/* ── "WHO WAS THE LAST MAN OF THE MATCH?" (Kemal, 2026-11-16) ───────────
 *
 * The unified answer is stubbed; what is asserted is what the shipped loader and context put
 * in front of the model, from a real Postgres:
 *   - a POSTED result is told exactly as announced (the stored record),
 *     though the votes changed after the post;
 *   - a FINAL result never posted (too old) is the winner only, no counts;
 *   - a vote still OPEN is said to be open, and nothing of it is told.
 */
const LAST_MOM_Q = "@Match Time who was the last man of the match?";
const LAST_MOM_A = "Pete Power, as announced.";

test('"who was the last Man of the Match?": as announced if posted, the winner only if final and never posted, nothing of an open vote', async ({ request, db }) => {
  const grp = await group(request, db);
  const id = (k: string) => grp.player(k).userId;
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const matchAt = async (mid: string, daysAgo: number) => {
    const date = new Date(now - daysAgo * DAY);
    await db.run(
      `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "redScore", "yellowScore", "updatedAt")
       VALUES ($1, $2, $3, 14, 'COMPLETED', $4, 3, 5, now())`,
      [mid, grp.activityId, date, new Date(date.getTime() - 5 * 60 * 60 * 1000)],
    );
  };
  const vote = (mid: string, voter: string, player: string) =>
    db.run(`INSERT INTO "MoMVote" (id, "matchId", "voterId", "playerId") VALUES ($1, $2, $3, $4)`, [`${mid}-${voter}`, mid, id(voter), id(player)]);

  // 12 days ago, never posted: final, the winner only. Everyone played it, so
  // all of them are in the ranked tables (three-month activity rule).
  await matchAt("sim-mom-old", 12);
  for (const [i, k] of ["alice", "pete", "dan", "greg", "owner"].entries()) {
    await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, 'sim-mom-old', $2, 'CONFIRMED', $3, now())`, [`sim-mom-old-att-${k}`, id(k), i + 1]);
  }
  await vote("sim-mom-old", "pete", "alice");
  await vote("sim-mom-old", "dan", "alice");
  await vote("sim-mom-old", "owner", "dan");
  // 6 days ago, posted with Pete 3 of 4; two votes moved to Dan after the post.
  await matchAt("sim-mom-posted", 6);
  for (const v of ["alice", "dan", "owner"]) await vote("sim-mom-posted", v, "pete");
  await vote("sim-mom-posted", "pete", "dan");
  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "matchId", "waMessageId") VALUES ('sim-mom-posted-sn', 'sim-mom-posted:mom-announcement', 'group-message', 'sim-mom-posted', 'wa-sim-mom-posted')`);
  await db.run(`INSERT INTO "MoMAnnouncement" ("matchId", result) VALUES ('sim-mom-posted', $1::jsonb)`, [
    JSON.stringify({ v: 1, kind: "vote", tally: [{ userId: id("pete"), name: grp.player("pete").name, votes: 3 }, { userId: id("dan"), name: grp.player("dan").name, votes: 1 }] }),
  ]);
  // Alice and the owner move their votes to Dan: re-counted, Dan would now have 3.
  await db.run(`UPDATE "MoMVote" SET "playerId" = $1 WHERE "matchId" = 'sim-mom-posted' AND "voterId" IN ($2, $3)`, [id("dan"), id("alice"), id("owner")]);
  // 8 days ago, posted BEFORE results were stored (no record), its vote
  // window closed: the votes are final, so Alice, the winner only.
  await matchAt("sim-mom-legacy", 8);
  await vote("sim-mom-legacy", "pete", "alice");
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "createdAt", "waMessageId") VALUES ('sim-mom-legacy-sn', 'sim-mom-legacy:mom-announcement', 'group-message', 'sim-mom-legacy', $1, 'wa-sim-mom-legacy')`,
    [new Date(now - 3 * DAY)],
  );
  // 10 days ago, posted with a stored record (the owner, 2 of 2), and its
  // vote rows since gone: it stays selectable and still credits the owner.
  await matchAt("sim-mom-norows", 10);
  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "matchId", "waMessageId") VALUES ('sim-mom-norows-sn', 'sim-mom-norows:mom-announcement', 'group-message', 'sim-mom-norows', 'wa-sim-mom-norows')`);
  await db.run(`INSERT INTO "MoMAnnouncement" ("matchId", result) VALUES ('sim-mom-norows', $1::jsonb)`, [
    JSON.stringify({ v: 1, kind: "vote", tally: [{ userId: id("owner"), name: grp.player("owner").name, votes: 2 }] }),
  ]);
  // 20 days ago, a historical (back-filled) award for Pete: decided, his.
  await matchAt("sim-mom-historical", 20);
  await db.run(`UPDATE "Match" SET "isHistorical" = true WHERE id = 'sim-mom-historical'`);
  await vote("sim-mom-historical", "dan", "pete");
  // 7 days ago, CLAIMED with a stored record (Alice 9 of 9) but the Pi
  // never confirmed the send (no waMessageId; round 6 of the review): not
  // "as announced", so no counts; its vote over, Alice by the winner only.
  await matchAt("sim-mom-unsent", 7);
  await vote("sim-mom-unsent", "dan", "alice");
  await db.run(`INSERT INTO "SentNotification" (id, key, kind, "matchId") VALUES ('sim-mom-unsent-sn', 'sim-mom-unsent:mom-announcement', 'group-message', 'sim-mom-unsent')`);
  await db.run(`INSERT INTO "MoMAnnouncement" ("matchId", result) VALUES ('sim-mom-unsent', $1::jsonb)`, [
    JSON.stringify({ v: 1, kind: "vote", tally: [{ userId: id("alice"), name: grp.player("alice").name, votes: 9 }], winners: [id("alice")] }),
  ]);
  // 3 days ago, posted before results were stored, its vote still OPEN:
  // nobody is named (Greg leads the votes now).
  await matchAt("sim-mom-legacy-open", 3);
  await vote("sim-mom-legacy-open", "pete", "greg");
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind, "matchId", "createdAt", "waMessageId") VALUES ('sim-mom-legacy-open-sn', 'sim-mom-legacy-open:mom-announcement', 'group-message', 'sim-mom-legacy-open', $1, 'wa-sim-mom-legacy-open')`,
    [new Date(now - 1 * DAY)],
  );
  // 1 day ago, still voting: Greg is ahead, and nobody may know it.
  await matchAt("sim-mom-open", 1);
  await vote("sim-mom-open", "pete", "greg");
  await vote("sim-mom-open", "dan", "greg");

  const r = await grp.post("alice", LAST_MOM_Q, {
    tag: true,
    route: "question",
    facts: { personRef: "", statedCount: -1, topic: "other", kind: "other", answer: LAST_MOM_A },
  });
  expect(r.reply).toBe(LAST_MOM_A);
  const user = unifiedTurn(LAST_MOM_Q);
  // The two Man of the Match blocks: match by match, then the last one.
  const from = user.indexOf("MAN OF THE MATCH, MATCH BY MATCH");
  const last = user.indexOf("LAST MAN OF THE MATCH", from);
  expect(from).toBeGreaterThan(-1);
  expect(last).toBeGreaterThan(from);
  const end = user.indexOf("\n\n", last);
  const block = user.slice(from, end === -1 ? undefined : end);
  // Posted: as announced, not the re-counted 3 for Dan.
  expect(block).toContain(`${grp.player("pete").name}, 3 of 4 votes`);
  expect(block).not.toContain(`${grp.player("dan").name}, 3`);
  // Claimed but never confirmed sent: no counts from its record, never "as announced".
  expect(block).not.toContain("9 of 9");
  // Final, never posted: the winner only.
  expect(block).toMatch(new RegExp(`: ${grp.player("alice").name} \\(the winner only, no vote counts\\)`));
  // Still voting: said to be open, nothing of it told.
  expect(block).toMatch(/is still open/);
  expect(block).not.toContain(grp.player("greg").name);
  // A posted match with no vote rows left is still told from its record.
  expect(block).toContain(`${grp.player("owner").name}, 2 of 2 votes`);
  // Posted with no stored record, vote still open: no name, the post has it.
  // (The LAST block is that match: the newest one that can be spoken of.)
  expect(block).toMatch(/the result was posted in the group on \w{3} \d{1,2} \w{3}; that post has it \(no name or votes here\)/);
  expect(block).toMatch(/LAST MAN OF THE MATCH[^]*the result was posted in the group on \w{3} \d{1,2} \w{3}, and that post has it/);

  // THE WINS TABLE (review of #608), through the same loader: the open vote
  // credits nobody (Greg would lead it), the posted match credits the
  // ANNOUNCED winner (Pete, not the re-counted Dan), the final matches their
  // final winner (Alice twice: the old match, and the legacy post now
  // closed), and the legacy post still open credits nobody.
  const winsAt = user.indexOf("MAN OF THE MATCH WINS");
  expect(winsAt).toBeGreaterThan(-1);
  const winsEnd = user.indexOf("\n\n", winsAt);
  const wins = user.slice(winsAt, winsEnd === -1 ? undefined : winsEnd);
  // (and the unsent claim, by its final winner).
  expect(wins).toContain(`${grp.player("alice").name}: 3`);
  // Pete: the posted match (as announced) and the historical award.
  expect(wins).toContain(`${grp.player("pete").name}: 2`);
  // The owner: the posted match whose vote rows are gone (from its record).
  expect(wins).toContain(`${grp.player("owner").name}: 1`);
  expect(wins).not.toContain(grp.player("greg").name);
  expect(wins).not.toContain(grp.player("dan").name);

  // THE PERIOD TABLES (round 2 of the review): "this week", "last month"
  // and the rest credit by the same decision, so an open vote's leader is
  // in none of them and the posted match credits Pete, not the re-count.
  const periodMom = user.split("\n").filter((l) => l.startsWith("- Man of the Match wins:"));
  expect(periodMom.length).toBeGreaterThan(0);
  for (const l of periodMom) {
    expect(l).not.toContain(grp.player("greg").name);
    expect(l).not.toContain(grp.player("dan").name);
  }
  expect(periodMom.some((l) => l.includes(`${grp.player("pete").name} `))).toBe(true);
});
