/**
 * Group-simulator scenario matrix — RECRUIT.
 *
 * The "DM recent players" blast must fire ONLY on an explicit shortage /
 * recruit request from an ADMIN, and only when the upcoming match has
 * open slots. Roster questions ("list the players") must never trigger
 * it, a full squad must DM nobody, and the blast is idempotent per match.
 *
 * REWRITTEN 2026-09-01. The trigger used to be `looksLikeRecruitRequest`,
 * a regex that claimed the whole message. It is gone; recruit is now an
 * extracted verdict FACT, so every case below carries an explicit
 * `recruitRequest` in its stub — that IS the classification under test,
 * and in stubbed mode we assert what the SERVER does with it. Whether the
 * real model sets the flag correctly is the live sweep's job.
 *
 * The behaviour these tests pin is otherwise unchanged: same action, same
 * copy, same admin gate, same idempotency. What is new is the last block:
 * a message that drops a player AND asks for a replacement must do both,
 * in that order, and speak exactly once.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, SimGroup } from "./group";

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
  const r = await grp.post("owner", "lads we need a few more players for tuesday", {
    verdict: { intent: "noise", recruitRequest: true, confidence: 0.95, reasoning: "stub: recruit ask, nothing else" },
  });
  expect(r.handledBy).toBe("fast-path");
  expect(r.intent).toBe("recruit_recent");
  expect(r.react).toBe("✅");
  expect(r.reply).toContain("DM'd 3 recent players");

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
  const r = await grp.post("owner", "still need more players lads", {
    verdict: { intent: "noise", recruitRequest: true, confidence: 0.95, reasoning: "stub: recruit ask again" },
  });
  expect(r.intent).toBe("recruit_recent");
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
    verdict: {
      intent: "question",
      reply: "Here's the squad so far: 2/8 confirmed.",
      react: null,
      confidence: 0.95,
      reasoning: "stub: roster answer",
    },
  });
  expect(r.intent).not.toBe("recruit_recent");
  expect(r.handledBy).toBe("llm");
  expect((await recruitDms(grp)).length).toBe(before);
});

test("a non-admin's recruit request DMs nobody and says nothing", async ({ request, db }) => {
  const grp = await group(request, db);
  const before = (await recruitDms(grp)).length;
  const r = await grp.post("pete", "get more players in for tuesday", {
    verdict: { intent: "noise", recruitRequest: true, confidence: 0.95, reasoning: "stub: non-admin recruit ask" },
  });
  // CHANGED 2026-09-01: the old path reacted 🔒. That react was only ever
  // reachable because the regex had already claimed the whole message —
  // the denial and the swallow were the same act. Now the flag is simply
  // ignored for a non-admin and the rest of the message flows through the
  // normal path, which for a bare ask is silence.
  expect(r.intent).not.toBe("recruit_recent");
  expect(r.reply).toBeNull();
  expect((await recruitDms(grp)).length).toBe(before);
});

test("full squad → recruit DMs nobody and says so", async ({ request, db }) => {
  const grp = await group(request, db);
  // Top the squad up to 8/8 directly (setup shortcut, not via the bot).
  for (const k of ["pete", "dan", "felix", "greg", "henry", "ivan"]) {
    await grp.setAttendance(k, "CONFIRMED");
  }
  expect((await grp.counts()).confirmed).toBe(8);

  const before = (await recruitDms(grp)).length;
  const r = await grp.post("alice", "anyone free? we need players", {
    verdict: { intent: "noise", recruitRequest: true, confidence: 0.95, reasoning: "stub: recruit ask at a full squad" },
  });
  expect(r.intent).toBe("recruit_recent");
  expect(r.reply).toContain("already full");
  expect((await recruitDms(grp)).length).toBe(before);
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
        // UNTAGGED, exactly as production was.
        body: BODY,
        verdict: {
          intent: "out",
          registerAttendance: null,
          registerFor: [{ name: "Jake Jolly", action: "OUT" }],
          recruitRequest: true,
          confidence: 0.95,
          reasoning: "stub: a third-party OUT and a recruit ask in one message",
        },
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
        verdict: {
          intent: "out",
          registerAttendance: null,
          registerFor: [{ name: "Ivan Ice", action: "OUT" }],
          recruitRequest: true,
          confidence: 0.95,
          reasoning: "stub: non-admin third-party OUT plus recruit ask",
        },
      },
    ]);
    expect(res.results).toHaveLength(1);
    expect((await grp.attendanceOf("ivan"))?.status).toBe("CONFIRMED");
    expect(res.results[0].reply).toBeNull();
    expect((await recruitDms(grp)).length).toBe(beforeDms);
  });
});
