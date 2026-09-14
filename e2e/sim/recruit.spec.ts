/**
 * Group-simulator scenario matrix — RECRUIT.
 *
 * The "DM recent players" blast must fire ONLY on an explicit shortage /
 * recruit request from an ADMIN, and only when the upcoming match has
 * open slots. Roster questions ("list the players") must never trigger
 * it, a full squad must DM nobody, and the blast is idempotent per match.
 *
 * REWRITTEN 2026-09-01. The trigger used to be `looksLikeRecruitRequest`,
 * a regex that claimed the whole message. It is gone; recruit is an
 * extracted FACT, so every case below carries it explicitly — that IS the
 * classification under test, and in stubbed mode we assert what the
 * SERVER does with it. Whether the real model reports it correctly is the
 * live sweep's job.
 *
 * ── PORTED 2026-09-06, §10 STEP 8 ───────────────────────────────────
 *
 * `verdict.recruitRequest: true` became `AttendanceFacts.sideRequests:
 * ["recruit"]`, and the change is not a rename. The old flag sat BESIDE
 * an intent, so "Najib is out. We need one more player." had to choose
 * which of the two things it was; the 2026-09-01 incident at the bottom
 * of this file is what happened when the regex chose. `sideRequests` is a
 * LIST alongside the claims, so a message carries both by construction
 * and `route.ts` runs the blast in the batch-final pass, after the drop
 * has landed.
 *
 * The ADMIN GATE is unchanged and still lives in the same place:
 * `attendance-engine-batch.ts` sets `recruitRequest` only when
 * `senderIsAdmin`, so a non-admin's ask is ignored rather than refused —
 * exactly the 2026-09-01 behaviour this file already recorded.
 *
 * The bodies route `unsure` where they carry no attendance claim at all.
 * That is the honest route for "lads we need a few more players": it is
 * attendance-SHAPED, the router cannot settle it, and since step 8
 * `unsure` is an engine route, so the extractor is asked and the
 * `sideRequests` entry is what it finds. `admin_ops`'s own `recruit`
 * action is the OTHER recogniser and it requires an @Match Time tag;
 * every ask in this file is untagged, exactly as production was.
 *
 * The behaviour these tests pin is otherwise unchanged: same action, same
 * copy, same admin gate, same idempotency. The last block is the one that
 * matters most: a message that drops a player AND asks for a replacement
 * must do both, in that order, and speak exactly once.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";
import { facts, otherClaim } from "../helpers/stub";

/** A bare recruit ask: no claims, one side request. */
const RECRUIT = { route: "unsure", facts: facts([], { sideRequests: ["recruit"] }) };

/** A named third-party drop that ALSO asks for cover — the 2026-09-01
 *  shape, as one set of facts rather than two competing intents. */
const dropAndRecruit = (name: string) => ({
  route: "other_att",
  facts: facts([otherClaim(name, "out")], { sideRequests: ["recruit"] }),
});

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let g: SimGroup;
const group = async (request: APIRequestContext, db: TestDb) =>
  (g ??= await createGroup(request, db, {
    maxPlayers: 8,
    // Upcoming: only the two admins have responded.
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
    ],
    // Last week's match: pete/dan/felix played (have phones, no response
    // to the upcoming match yet) and gary played but has NO phone.
    completedMatch: {
      daysAgo: 7,
      confirmedKeys: ["owner", "alice", "pete", "dan", "felix", "gary"],
    },
  })).attach(request);

const recruitDms = (grp: SimGroup) =>
  grp.db.all<{ phone: string | null; text: string }>(
    `SELECT phone, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND text ILIKE '%reply *IN*%'`,
    [grp.orgId],
  );

test("explicit shortage from an admin → invite DMs to recent non-responders with phones", async ({ request, db }) => {
  const grp = await group(request, db);
  const r = await grp.post("owner", "lads we need a few more players for tuesday", RECRUIT);
  // ── TWO AUDIT LABELS CHANGED, MEASURED, AND NEITHER IS THE ACTION ──
  //
  // WAS: `handledBy: "fast-path"`, `intent: "recruit_recent"`. The
  // batch-final pass in `route.ts` only relabels a recruit result when it
  // finds `handledBy === "ignored"` or a `noise` / `unclear` intent — the
  // shape a PURE recruit ask had when the verdict "carried nothing".
  // Under the engine it carries something: `unsure` is an owned route, so
  // the message is `handledBy: "llm"` (the wire label every engine-owned
  // message reports) and `intentFor` reads the `recruit` side request as
  // `replacement_request`.
  //
  // The ACTION is unchanged and is what the rest of this test asserts:
  // three DMs, to the right people, with the right copy, and one honest
  // reply. `augmentAnalysis` still stamps `action: "recruit:3"` on the
  // row, so "was a blast sent, and to how many" is still one query. The
  // label change is recorded in the PR body rather than smuggled in here.
  expect(r.handledBy).toBe("llm");
  expect(r.intent).toBe("replacement_request");
  expect(r.react).toBe("✅");
  expect(r.reply).toContain("DM'd 3 recent players");
  const row = await grp.db.one<{ action: string }>(
    `SELECT action FROM "AnalyzedMessage" WHERE "orgId" = $1 AND body = $2`,
    [grp.orgId, "lads we need a few more players for tuesday"],
  );
  // "none+recruit:3" — the engine's own action for the message ("none",
  // no attendance write) with the blast appended by `augmentAnalysis`.
  expect(row?.action, "the audit row still names the blast and its size").toContain("recruit:3");

  const dms = await recruitDms(grp);
  expect(dms).toHaveLength(3);
  const phones = dms.map((d) => d.phone).sort();
  const expected = ["pete", "dan", "felix"].map((k) => grp.player(k).phone!.replace(/^\+/, "")).sort();
  expect(phones).toEqual(expected);
  for (const d of dms) {
    expect(d.text).toContain("putting the squad together");
    // The ASK leads (2026-08-31): reply IN, reply OUT.
    expect(d.text).toContain("reply *IN*");
    expect(d.text).toContain("Reply *OUT*");
    // …and it does NOT tell them to tap an emoji, because inbound
    // reaction forwarding is dead on the Pi. See
    // RECRUIT_DM_MENTION_REACTIONS in src/lib/recruit.ts.
    expect(d.text).not.toContain("👍");
    expect(d.text).not.toContain("👎");
    // The magic link survives, demoted to the trailing optional line.
    expect(d.text).toMatch(/https?:\/\//);
    expect(d.text.trim().split("\n").at(-1)).toContain("Prefer the app?");
  }
  // Idempotency breadcrumbs, one per invited player.
  for (const k of ["pete", "dan", "felix"]) {
    const key = `${grp.matchId}:recruit-dm:${grp.player(k).userId}`;
    expect(
      await grp.db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [key]),
    ).toBe(1);
  }
});

test("repeating the request never re-DMs the same players for the same match", async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await recruitDms(grp)).length;
  const r = await grp.post("owner", "still need more players lads", RECRUIT);
  // Branch 3: candidates existed but were ALL pinged on the earlier call —
  // honest "awaiting replies" copy, not the misleading "already responded".
  expect(r.reply).toContain("waiting on their replies");
  expect((await recruitDms(grp)).length).toBe(before);
});

test('"list the players" is a roster question — NEVER a recruit blast', async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await recruitDms(grp)).length;
  // Tagged: a roster question is answer-y → requires a tag under the
  // interaction contract. The point of this test (a roster question must
  // NOT be misrouted to a recruit blast) is preserved.
  const r = await grp.post("owner", "@Match Time can you list the players for tuesday?", {
    tag: true,
    route: "question",
    facts: { topic: "squad", personRef: null, statedCount: null },
  });
  expect(r.intent).not.toBe("recruit_recent");
  expect(r.handledBy).toBe("llm");
  expect((await recruitDms(grp)).length).toBe(before);
});

test("a non-admin's recruit request DMs nobody and says nothing", async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await recruitDms(grp)).length;
  const r = await grp.post("pete", "get more players in for tuesday", RECRUIT);
  // CHANGED 2026-09-01: the old path reacted 🔒. That react was only ever
  // reachable because the regex had already claimed the whole message —
  // the denial and the swallow were the same act. Now the flag is simply
  // ignored for a non-admin and the rest of the message flows through the
  // normal path, which for a bare ask is silence.
  expect(r.reply, "a non-admin's ask is ignored, not refused out loud").toBeNull();
  expect((await recruitDms(grp)).length).toBe(before);
});

/* ────────────────────────────────────────────────────────────────────
 * THE 2026-09-14 INCIDENT — a recruit ask into a FULL squad.
 *
 * Sutton FC, live, reported by the owner. Kemal posted, untagged:
 *
 *   "it would be great to have some benchers in case someone drops
 *    tomorrow? Anybody else interested"
 *
 * MatchTime replied:
 *
 *   "The squad for *Tuesday 7-a-side* is already full — no open spots to
 *    recruit for."
 *
 * Backwards. Benchers are wanted PRECISELY BECAUSE the squad is full,
 * and the reply talked the volunteers he was asking for out of
 * volunteering: the match kicked off at 14 of 14 with an empty bench.
 *
 * Nothing misfired upstream — the production row reads `by=attendance-
 * engine intent=replacement_request action=none+recruit:0`, so the ask
 * WAS read as a recruit side-request. `inviteRecentPlayers`' capacity
 * guard was bench-blind, and "squad full" meant "nothing to do".
 *
 * These two tests are the same world with one flag moved. The blast
 * still DMs nobody in BOTH: a group reply reaches the same people at
 * none of the risk (`recruit-lookback.ts` — the bot runs on an
 * unofficial WhatsApp client and a mass DM risks the account).
 * ──────────────────────────────────────────────────────────────────── */
test("full squad + bench ON → invites the group onto the bench, DMs nobody", async ({ request, db }) => {
  const grp = await group(request, db);
  // Top the squad up to 8/8 directly (setup shortcut, not via the bot).
  for (const k of ["pete", "dan", "felix", "greg", "henry", "ivan"]) {
    await grp.setAttendance(k, "CONFIRMED");
  }
  expect((await grp.counts()).confirmed).toBe(8);

  const before = (await recruitDms(grp)).length;
  const r = await grp.post("alice", "anyone free? we need players", RECRUIT);
  // The sentence from the incident, gone.
  expect(r.reply).not.toContain("already full");
  expect(r.reply).not.toContain("no open spots");
  // …replaced by what the system ACTUALLY does with a late IN: the
  // engine writes a BENCH row (capacity rule, `engine.ts:2326`), a drop
  // opens a BenchSlotOffer, and the first bencher to reply IN takes it.
  expect(r.reply).toContain("8 of 8");
  expect(r.reply?.toLowerCase()).toContain("bench");
  expect(r.reply).toContain("*IN*");
  expect((await recruitDms(grp)).length).toBe(before);
});

test("full squad + bench OFF → the old sentence, which for that org is true", async ({ request, db }) => {
  // A separate org: with `featureBench` off, `bot-scheduler.ts:772`
  // refuses to post a bench prompt, so promising one would be a lie.
  const nobench = await (
    await createGroup(request, db, {
      name: "No Bench United",
      maxPlayers: 8,
      features: { bench: false },
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "brian", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
        { key: "greg", status: "CONFIRMED" },
        { key: "henry", status: "CONFIRMED" },
      ],
      // liam + mike played last week and have not responded, so there is
      // a real pool: "DM'd nobody" is the guard's doing, not an empty set.
      completedMatch: { daysAgo: 7, confirmedKeys: ["owner", "liam", "mike"] },
    })
  ).attach(request);
  expect((await nobench.counts()).confirmed).toBe(8);

  const r = await nobench.post("alice", "anyone free? we need players", RECRUIT);
  expect(r.reply).toContain("already full");
  expect(r.reply).toContain("no open spots to recruit for");
  expect(await recruitDms(nobench)).toHaveLength(0);
});

/* ────────────────────────────────────────────────────────────────────
 * THE 2026-09-01 INCIDENT — one message, a drop AND a recruit ask.
 *
 * Sutton FC, in front of the club. The owner posted:
 *
 *   "Najib is out. We need one more player.
 *
 *    Can someone pls come forward"
 *
 * `looksLikeRecruitRequest` matched the SECOND sentence and the fast path
 * peeled the message off the LLM batch, so the third-party OUT was never
 * analysed. Najib stayed in, the squad stayed 10/10, the recruit action
 * correctly found zero open spots, and MatchTime replied:
 *
 *   "The squad for *Tuesday 5-a-side* is already full — no open spots to
 *    recruit for."
 *
 * …one line after the owner said a player was out.
 *
 * A fresh group, because this needs a FULL 5-a-side squad and its own
 * recruit ledger (the shared group above has already been blasted).
 * ──────────────────────────────────────────────────────────────────── */
test.describe("multi-intent: a drop and a recruit ask in one message", () => {
  let inc: SimGroup;
  const incident = async (request: APIRequestContext, db: TestDb) =>
    (inc ??= await createGroup(request, db, {
      name: "Sutton 5-a-side",
      maxPlayers: 10, // 5-a-side
      attendance: [
        { key: "owner", status: "CONFIRMED" },
        { key: "alice", status: "CONFIRMED" },
        { key: "brian", status: "CONFIRMED" },
        { key: "pete", status: "CONFIRMED" },
        { key: "dan", status: "CONFIRMED" },
        { key: "felix", status: "CONFIRMED" },
        { key: "greg", status: "CONFIRMED" },
        { key: "henry", status: "CONFIRMED" },
        { key: "ivan", status: "CONFIRMED" },
        { key: "jake", status: "CONFIRMED" },
      ],
      // liam + mike played last week and have NOT responded to the
      // upcoming match, so there is a real pool to recruit from.
      completedMatch: { daysAgo: 7, confirmedKeys: ["owner", "pete", "liam", "mike"] },
    })).attach(request);

  const BODY = "Jake is out. We need one more player.\n\nCan someone pls come forward";

  test("drops the player, THEN recruits against the corrected squad, in ONE reply", async ({ request, db }) => {
    const grp = await incident(request, db);
    expect((await grp.counts()).confirmed).toBe(10); // full, as it was

    const res = await grp.postBatch([
      {
        player: "owner",
        // UNTAGGED, exactly as production was. `RECRUIT_COMMAND_IMPLIES_ADDRESSED`
        // (PR #33) is why an admin's recruit command clears the interaction
        // contract without a tag, and `engine.ts:317` is where that lives.
        body: BODY,
        ...dropAndRecruit("Jake Jolly"),
      },
    ]);

    // 1. The attendance half was NOT swallowed.
    expect((await grp.attendanceOf("jake"))?.status).toBe("DROPPED");
    // 2. The squad is 9/10, not the 10/10 the old path recruited against.
    expect((await grp.counts()).confirmed).toBe(9);
    // 3. The recruit ran, and it ran AFTER the drop: it found the open
    //    slot instead of reporting a full squad.
    const dms = await recruitDms(grp);
    expect(dms.length).toBeGreaterThan(0);

    // 4. EXACTLY ONE result and EXACTLY ONE reply for the one message.
    expect(res.results).toHaveLength(1);
    const r = res.results[0];
    expect(r.reply).not.toBeNull();
    expect(r.reply).toContain("DM'd");
    // The exact sentence from the incident must never appear again.
    expect(r.reply).not.toContain("already full");
    expect(r.reply).not.toContain("no open spots");
    // …and nothing was queued as a SECOND group message alongside it.
    expect(res.groupPosts).toHaveLength(0);
  });

  test("a non-admin cannot drop a third party by riding a recruit ask", async ({ request, db }) => {
    const grp = await incident(request, db);
    const beforeDms = (await recruitDms(grp)).length;
    // Same shape, but from a PLAYER. The recruit flag is ignored (not an
    // admin), so it must NOT address the bot either — the untagged
    // third-party OUT stays suppressed by the interaction contract.
    const res = await grp.postBatch([
      {
        player: "pete",
        body: "Ivan is out. We need one more player.",
        ...dropAndRecruit("Ivan Ice"),
      },
    ]);
    expect(res.results).toHaveLength(1);
    expect((await grp.attendanceOf("ivan"))?.status).toBe("CONFIRMED");
    expect(res.results[0].reply).toBeNull();
    expect((await recruitDms(grp)).length).toBe(beforeDms);
  });
});
