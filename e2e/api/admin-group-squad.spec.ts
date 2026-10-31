/**
 * SQUAD CHANGES TYPED IN THE ADMIN GROUP (2026-10-14), against a real
 * Postgres and the real route. The router is STUBBED (`engineOn`), and so
 * is the HQ squad reader (2026-10-29; every squad message since 2026-10-30),
 * which says what a message the router sent to the squad is: the whole
 * squad, a change, the teams or the organisers' own talk. No model is
 * called. Everything from the readings on is the shipped code: the
 * attendance engine, the writers, the fact gates, the pasted-list proposal
 * and its YES.
 *
 * The fixture club (E2E Test FC, weekly, first-come) has its upcoming
 * match at 4 of 5: Alex Admin, Colin Collector, Pat Player, Tom Third, and
 * Ben Bench on the bench. Alex is the OWNER.
 */
import { readFileSync } from "node:fs";
import { test, expect, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, changeReading, OTHER_READING, setHqSquadReaderStub, clearHqSquadReaderStub, squadReading } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000031@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");

let seq = 0;
async function say(
  request: APIRequestContext,
  text: string,
  senderPhone = ADMIN,
  messageId = `e2e-ags-${++seq}`,
  extra: Record<string, unknown> = {},
) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", botMentioned: true, groupId: HQ, messageId, text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)), ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function statusOf(db: TestDb, userId: string): Promise<string | null> {
  return (
    (await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, userId]))
      ?.status ?? null
  );
}

const groupJobs = (db: TestDb) =>
  db.all<{ id: string }>(`SELECT id FROM "BotJob" WHERE "orgId" = $1 AND kind <> 'dm'`, [ORG_ID]);
const analyzed = async (db: TestDb) => (await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AnalyzedMessage"`))?.n;

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
});

test.afterAll(() => {
  clearPipelineStubs();
  clearHqSquadReaderStub();
  resetDb();
});

// A PLAYER of the club changes who plays in HQ too since 2026-10-20
// (admin-group-attendance-anyone.spec.ts); someone not in the club does not.
test("'Tom out' from someone not in the club is ignored: no reply, no write", async ({ request, db }) => {
  engineOn({ "Tom out": { route: "other_att", reading: changeReading([["Tom Third", "out"]]) } });
  const out = await say(request, "Tom out", "447700900997", undefined, { botMentioned: false });
  expect(out).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
  expect(await statusOf(db, U.third)).toBe("CONFIRMED");
});

test("an admin's 'Tom out': applied through the engine, confirmed in the admin group, nothing posted to the players", async ({ request, db }) => {
  engineOn({ "Tom out": { route: "other_att", reading: changeReading([["Tom Third", "out"]]) } });
  const before = { jobs: (await groupJobs(db)).length, analyzed: await analyzed(db) };
  const out = await say(request, "Tom out", ADMIN, "e2e-ags-tom-out");
  // The Pi puts a ✅ on the admin's message (2026-10-16).
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Tom Third out. 3 of 5, 1 on the bench (Ben Bench).", react: "✅" });
  expect(await statusOf(db, U.third)).toBe("DROPPED");

  // Recorded as an admin's instruction from that message.
  const ev = await db.one<{ cause: string; actorKind: string; actorUserId: string; sourceRef: string }>(
    `SELECT cause, "actorKind", "actorUserId", "sourceRef" FROM "AttendanceEvent" WHERE "matchId" = $1 AND "userId" = $2 ORDER BY at DESC LIMIT 1`,
    [MATCH.upcoming, U.third],
  );
  expect(ev).toMatchObject({ cause: "admin-message", actorKind: "admin", actorUserId: U.admin, sourceRef: "admin-group:e2e-ags-tom-out" });

  // No post to the players' group and no analysis row from the admin group.
  expect((await groupJobs(db)).length).toBe(before.jobs);
  expect(await analyzed(db)).toBe(before.analyzed);

  // A Pi retry of the same message changes nothing and says nothing.
  expect(await say(request, "Tom out", ADMIN, "e2e-ags-tom-out")).toMatchObject({ ignored: "duplicate", replyText: null });
});

test("'put Ian in': in, with the new count", async ({ request, db }) => {
  engineOn({ "put Ian in": { route: "other_att", reading: changeReading([["Ian Innes", "in"]]) } });
  const out = await say(request, "put Ian in");
  expect(out).toMatchObject({ handled: true, replyText: "Done: Ian Innes in. 4 of 5, 1 on the bench (Ben Bench)." });
  expect(await statusOf(db, U.fresh)).toBe("CONFIRMED");
});

test("chat the router does not route to attendance is ignored, no reply", async ({ request }) => {
  engineOn({ "Wasim played well last week": { route: "none" } });
  const out = await say(request, "Wasim played well last week");
  expect(out).toMatchObject({ handled: false, ignored: "no-open-pick", replyText: null });
  expect(out.react ?? null).toBeNull();
});

// FNF 2026-10-16: a tagged request the router called `unsure` was met with
// silence. Now the attendance engine reads it and, owning nothing, one line.
test("a tagged message the router calls unsure: one line, never silence, and no tick", async ({ request }) => {
  engineOn({ "@Match Time update the graphic please": { route: "unsure" } });
  const out = await say(request, "@Match Time update the graphic please");
  expect(out).toMatchObject({
    handled: true,
    outcome: "hq-not-understood",
    replyText: "I didn't catch what you'd like me to do.",
    react: null,
  });
});

// ── Organisers talking in HQ is not an instruction (2026-10-15) ───────
// Since 2026-10-30 the HQ squad reader (a model) says which messages are
// instructions; its reading is stubbed here, and the rest is the shipped
// code. Alex (the owner) is CONFIRMED.

test("an organiser who 'might have to pull out': read as talk, no write, no reply", async ({ request, db }) => {
  engineOn({ "might have to pull out this week": { route: "self_att", reading: OTHER_READING } });
  expect(await say(request, "might have to pull out this week", ADMIN, undefined, { botMentioned: false })).toMatchObject({ handled: false, replyText: null });
  expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
});

test("then an injury report, a plain 'won't be around', a stranger around again: talk, no write, no reply", async ({ request, db }) => {
  engineOn({
    "my knee is gone lads": { route: "self_att", reading: OTHER_READING },
    "won't be around on friday": { route: "self_att", reading: OTHER_READING },
    "Zed is around again": { route: "other_att", reading: OTHER_READING },
    "AH back": { route: "other_att", reading: OTHER_READING },
  });
  for (const text of ["my knee is gone lads", "won't be around on friday", "Zed is around again", "AH back"]) {
    expect(await say(request, text, ADMIN, undefined, { botMentioned: false }), text).toMatchObject({ handled: false, replyText: null });
  }
  expect(await statusOf(db, U.admin)).toBe("CONFIRMED");
  expect(await db.one(`SELECT id FROM "User" WHERE name = 'Zed'`)).toBeFalsy();
});

test("talk said to MatchTime that changes nothing: one line, never silence, no tick, nothing written", async ({ request, db }) => {
  engineOn({
    "@Match Time Zed is around again": { route: "other_att", reading: OTHER_READING },
    "@Match Time AH back": { route: "other_att", reading: OTHER_READING },
  });
  for (const text of ["@Match Time Zed is around again", "@Match Time AH back"]) {
    expect(await say(request, text), text).toMatchObject({ handled: true, outcome: "hq-not-understood", replyText: "I didn't catch what you'd like me to do.", react: null });
  }
  expect(await db.one(`SELECT id FROM "User" WHERE name = 'Zed'`)).toBeFalsy();
  expect(await db.one(`SELECT id FROM "User" WHERE name = 'AH'`)).toBeFalsy();
});

test("'@Match Time AH back' routed question (Haiku 4.5's route), topic other: the not-from-this-group line, as before", async ({ request }) => {
  engineOn({ "@Match Time AH back": { route: "question", facts: { topic: "other", personRef: "", statedCount: -1 } } });
  expect(await say(request, "@Match Time AH back")).toMatchObject({
    handled: true,
    outcome: "hq-not-here",
    replyText: "I can't do that from this group.",
  });
});

test("the incident: a reply to another organiser naming players for next week: silent, nothing written, no tick", async ({ request, db }) => {
  engineOn({ "Imti Rafi Zed back": { route: "other_att", reading: changeReading([[{ new: "Zed" }, "in"]]) } });
  const out = await say(request, "Imti Rafi Zed back", ADMIN, undefined, { quotedText: "We have the below out", quotedFromMatchTime: false, botMentioned: false });
  expect(out).toMatchObject({ handled: false, replyText: null });
  expect(out).not.toHaveProperty("react");
  expect(await db.one(`SELECT id FROM "User" WHERE name = 'Zed'`)).toBeFalsy();
});

const LIST = ["Friday squad", "1. Alex Admin", "2. Colin Collector", "3. Ian Innes", "4. Zara Zest", "5. Naim Newman"].join("\n");
const LATE_LIST = ["1. Alex Admin", "2. Colin Collector", "3. Ian Innes", "4. Zara Zest", "5. Pat Player"].join("\n");
// What the HQ squad reader (a model) reads them as: the whole squad, Pat
// left off on purpose in the first, Naim in the second.
const READINGS = {
  [LIST]: squadReading(["Alex Admin", "Colin Collector", "Ian Innes", "Zara Zest", "Naim Newman"], { out: ["Pat Player"] }),
  [LATE_LIST]: squadReading(["Alex Admin", "Colin Collector", "Ian Innes", "Zara Zest", "Pat Player"], { out: ["Naim Newman"] }),
};

let pasteQuestion = "";

test("a pasted list: the exact changes and a YES question, nothing applied yet", async ({ request, db }) => {
  // The shared router reads every YES below (stubbed: what it would say).
  // A pasted list goes to the router first (2026-10-30), then the reader.
  engineOn({ YES: { route: "approve" }, yes: { route: "approve" }, [LIST]: { route: "other_att" }, [LATE_LIST]: { route: "other_att" } });
  setHqSquadReaderStub({ bodies: READINGS });
  const out = await say(request, LIST, ADMIN, "e2e-ags-paste");
  pasteQuestion = out.replyText;
  expect(out).toMatchObject({
    handled: true,
    outcome: "paste-proposed",
    replyText:
      "Adding: Zara Zest. Removing: Pat Player. Unknown names: Naim Newman (not a member yet, I'll add them as a new player). Reply YES to apply.",
  });
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
  expect(await statusOf(db, U.extra)).toBeNull();
});

test("a player's YES to a list an organiser pasted applies nothing: one line naming who can", async ({ request, db }) => {
  expect(await say(request, "YES", PLAYER)).toMatchObject({ handled: true, outcome: "hq-only-organisers", replyText: "Only Alex can change that.", react: null });
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
});

test("an admin's YES straight after a non-admin spoke: asked once which it is for, nothing applied", async ({ request, db }) => {
  // The non-admin's message above is conversation in between, so the
  // safe-YES rule (admin-group-confirm-rules.ts) asks rather than applies.
  const out = await say(request, "YES");
  expect(out).toMatchObject({ handled: true, outcome: "hq-confirm-asked", replyText: "Is that YES to the squad list pasted here?" });
  expect(await statusOf(db, U.player)).toBe("CONFIRMED");
});

test("an admin's YES as a WhatsApp reply to the list question applies it: out first, then in, new names added as players", async ({ request, db }) => {
  // A reply to MatchTime's question is clearly about it, whatever was said
  // since (the Pi forwards the quoted text and whose it was).
  await say(request, "who's got the bibs?", PLAYER, undefined, { botMentioned: false });
  const out = await say(request, "YES", ADMIN, undefined, { quotedText: pasteQuestion, quotedFromMatchTime: true });
  expect(out).toMatchObject({ handled: true, outcome: "paste-applied" });
  expect(out.replyText).toMatch(/^Done: Pat Player out, Zara Zest in, Naim Newman in\. 5 of 5(, \d on the bench \(.+\))?\.$/);
  expect(await statusOf(db, U.player)).toBe("DROPPED");
  expect(await statusOf(db, U.extra)).toBe("CONFIRMED");
  const naim = await db.one<{ id: string }>(
    `SELECT u.id FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND u.name = 'Naim Newman'`,
    [ORG_ID],
  );
  expect(naim).toBeTruthy();
  expect(await statusOf(db, naim!.id)).toBe("CONFIRMED");

  // A second YES, untagged, says nothing.
  expect(await say(request, "yes", ADMIN, undefined, { botMentioned: false })).toMatchObject({ handled: false, replyText: null });
});

test("the same list again: 'That matches the squad'", async ({ request }) => {
  expect(await say(request, LIST)).toMatchObject({
    handled: true,
    outcome: "paste-same",
    replyText: "That matches the squad, nothing to change.",
  });
});

test("YES more than 30 minutes after the list: not applied, and it says so", async ({ request, db }) => {
  const proposed = await say(request, LATE_LIST);
  expect(proposed.outcome).toBe("paste-proposed");
  // A UTC instant, as Prisma stores it (the column has no time zone).
  await db.run(`UPDATE "AdminSquadProposal" SET "expiresAt" = $2 WHERE "orgId" = $1 AND "resolvedAt" IS NULL`, [
    ORG_ID,
    new Date(Date.now() - 60_000).toISOString(),
  ]);
  engineOn({ YES: { route: "approve" } });
  expect(await say(request, "YES")).toMatchObject({
    handled: true,
    outcome: "paste-expired",
    replyText: "That list is more than 30 minutes old, so I haven't applied it. Paste it again if it still stands.",
  });
  expect(await statusOf(db, U.player)).toBe("DROPPED");
});

test("a Turkish club gets Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  engineOn({ "Zara çıktı": { route: "other_att", reading: changeReading([["Zara Zest", "out"]]) } });
  const out = await say(request, "Zara çıktı");
  expect(out.replyText).toMatch(/^Tamam: Zara Zest çıktı\. \d\/5(, yedekte \d kişi \(.+\))?\.$/);
  await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
});

test("a monthly club: no squad change from the admin group, and it says so in one line", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'monthly' WHERE id = $1`, [ORG_ID]);
  // An earlier test here said the line already; it is not repeated within
  // hours (2026-10-22), which admin-group-cancel.spec.ts covers.
  await db.run(`DELETE FROM "AdminGroupMessage" WHERE "waMessageId" LIKE 'mt:said:not-here:%'`);
  engineOn({ "Colin out": { route: "other_att", reading: changeReading([["Colin Collector", "out"]]) } });
  expect(await say(request, "Colin out")).toMatchObject({
    handled: true,
    outcome: "hq-not-here",
    replyText: "I can't do that from this group.",
  });
  expect(await statusOf(db, U.collector)).toBe("CONFIRMED");
  await db.run(`UPDATE "Organisation" SET "squadMode" = 'weekly' WHERE id = $1`, [ORG_ID]);
});

// FNF HQ 2026-10-17 09:01: an organiser's list of names with a bare IN or
// OUT. Since 2026-10-30 no code reads it: the router routes it and the HQ
// squad reader reads it (both stubbed here), one line or many.
test("names on their own lines and a bare OUT: the reader's change, each one out, a tick", async ({ request, db }) => {
  const text = "Ian \nNaim Newman\n\nOut";
  engineOn({ [text]: { route: "other_att", reading: changeReading([["Ian Innes", "out"], ["Naim Newman", "out"]]) } });
  const out = await say(request, text);
  expect(out).toMatchObject({ handled: true, outcome: "squad-changed", react: "✅" });
  expect(out.replyText).toMatch(/^Done: .*Ian Innes out.*Naim Newman out.*\d of 5(, \d on the bench \(.+\))?\.$/);
  expect(await statusOf(db, U.fresh)).toBe("DROPPED");
});

test("the same on one line, IN: each one back", async ({ request, db }) => {
  const text = "Pat, Tom and Zara in";
  engineOn({ [text]: { route: "other_att", reading: changeReading([["Pat Player", "in"], ["Tom Third", "in"], ["Zara Zest", "in"]]) } });
  const out = await say(request, text);
  expect(out).toMatchObject({ handled: true, react: "✅" });
  expect(out.replyText).toMatch(/^Done: /);
  for (const id of [U.player, U.third, U.extra]) expect(["CONFIRMED", "BENCH"]).toContain(await statusOf(db, id));
});

// FNF HQ 2026-10-18 18:16. An organiser wrote "Akram out" in HQ; MatchTime
// said "Done: Akram out. 17 of 18." with Uncle Najib on the bench, in a
// club whose organisers pick who comes off it. The count now says the
// bench, and the reply says how to bring someone in, by the same squad
// change path ("put X in") that read the OUT.
test.describe("organiser pick: a place opens with someone on the bench", () => {
  test.beforeAll(async ({ db }) => {
    resetDb();
    await db.run(
      `UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "benchPickMode" = 'organiser' WHERE id = $1`,
      [ORG_ID, HQ],
    );
    // The fixture match is 4 of 5 with Ben Bench waiting; make it full, so
    // an OUT opens a place as Akram's did.
    await db.run(`UPDATE "Match" SET "maxPlayers" = 4 WHERE id = $1`, [MATCH.upcoming]);
  });

  test("'Tom out': the reply names the bench and the command that brings Ben in; nothing filled by itself", async ({ request, db }) => {
    engineOn({ "Tom out": { route: "other_att", reading: changeReading([["Tom Third", "out"]]) } });
    const out = await say(request, "Tom out");
    expect(out).toMatchObject({
      handled: true,
      outcome: "squad-changed",
      replyText:
        'Done: Tom Third out. 3 of 4, 1 on the bench (Ben Bench). A place is free. Just tell me who should come in from the bench, in your own words (for example Ben Bench).',
    });
    expect(await statusOf(db, U.third)).toBe("DROPPED");
    // Organiser pick: MatchTime does not fill the place itself.
    expect(await statusOf(db, U.bench)).toBe("BENCH");
    const offers = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "BenchSlotOffer" WHERE "matchId" = $1`, [MATCH.upcoming]);
    expect(offers?.n).toBe("0");
  });

  test("the command it gave works: 'put Ben Bench in' brings him in, and the count is full again", async ({ request, db }) => {
    engineOn({ "put Ben Bench in": { route: "other_att", reading: changeReading([["Ben Bench", "in"]]) } });
    const out = await say(request, "put Ben Bench in");
    expect(out).toMatchObject({ handled: true, outcome: "squad-changed", replyText: "Done: Ben Bench in. 4 of 4." });
    expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
  });

  test("Turkish club: the same in Turkish, with yedek", async ({ request, db }) => {
    await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
    await db.run(`UPDATE "Attendance" SET status = 'BENCH' WHERE "matchId" = $1 AND "userId" = $2`, [MATCH.upcoming, U.third]);
    engineOn({ "Pat çıktı": { route: "other_att", reading: changeReading([["Pat Player", "out"]]) } });
    const out = await say(request, "Pat çıktı");
    expect(out.replyText).toBe(
      'Tamam: Pat Player çıktı. 3/4, yedekte 1 kişi (Tom Third). Bir yer boş. Yedekten kimin gireceğini kendi cümlelerinizle yazmanız yeterli (örneğin Tom Third).',
    );
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  });
});

// FNF HQ 2026-10-24 11:30-11:43 UTC. "Glazers in" added a brand-new,
// phoneless member and benched him; "Glazers OUT" a few minutes later did
// nothing and said nothing. The real attendance extractor read no claim in
// "Glazers OUT" (measured on the dev key), because nothing told it Glazers
// is a person in the club. It is now shown the club's members the message
// names, from the roster the engine already loads, a member created minutes
// earlier included. What HQ decided is kept on the message's row.
test.describe("a player added in HQ a minute ago is taken out by name", () => {
  test.beforeAll(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
  });

  const glazers = (db: TestDb) => db.one<{ id: string; phoneNumber: string | null }>(`SELECT id, "phoneNumber" FROM "User" WHERE name = 'Glazers'`);
  const callsFor = (body: string): string[] => {
    let raw = "";
    try {
      raw = readFileSync(`${E2E.HQ_SQUAD_READER_STUB_FILE}.calls`, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { user: string }).user)
      .filter((u) => u.trimEnd().endsWith(`\n${body}`));
  };

  test("'Glazers in': a new player, no phone, in the squad", async ({ request, db }) => {
    engineOn({ "Glazers in": { route: "other_att", reading: changeReading([[{ new: "Glazers" }, "in"]]) } });
    const out = await say(request, "Glazers in", ADMIN, "e2e-ags-glazers-in");
    expect(out).toMatchObject({ handled: true, outcome: "squad-changed" });
    const g = await glazers(db);
    expect(g?.phoneNumber ?? null).toBeNull();
    expect(["CONFIRMED", "BENCH"]).toContain(await statusOf(db, g!.id));
  });

  test("'Glazers OUT': the reader is shown Glazers as a member, he is out, and the decision is on the HQ row", async ({ request, db }) => {
    engineOn({ "Glazers OUT": { route: "other_att", reading: changeReading([["Glazers", "out"]]) } });
    const out = await say(request, "Glazers OUT", ADMIN, "e2e-ags-glazers-out");
    expect(out).toMatchObject({ handled: true, outcome: "squad-changed", react: "✅" });
    expect(out.replyText).toMatch(/^Done: Glazers out\./);
    const g = await glazers(db);
    expect(await statusOf(db, g!.id)).toBe("DROPPED");

    const seen = callsFor("Glazers OUT");
    expect(seen.length).toBeGreaterThan(0);
    // The HQ squad reader is shown the club's members, Glazers among them.
    expect(seen[0]).toMatch(/\n {2}p\d+: Glazers\n/);

    const row = await db.one<{ hqOutcome: string | null; pipelineTrace: { router?: { route: string }; hqSquadReader?: unknown } | null }>(
      `SELECT "hqOutcome", "pipelineTrace" FROM "AdminGroupMessage" WHERE "waMessageId" = $1`,
      ["e2e-ags-glazers-out"],
    );
    expect(row?.hqOutcome).toBe("squad-changed");
    expect(row?.pipelineTrace?.router?.route).toBe("other_att");
    // What the HQ squad reader read is kept beside the router's route (2026-10-30).
    expect(row?.pipelineTrace).toMatchObject({ hqSquadReader: { kind: "change", changes: [{ name: "Glazers", to: "out" }] } });
  });

  test("chat the router calls none: silent, and the row says so", async ({ request, db }) => {
    engineOn({ "who has the bibs?": { route: "none" } });
    expect(await say(request, "who has the bibs?", ADMIN, "e2e-ags-bibs")).toMatchObject({ handled: false, replyText: null });
    const row = await db.one<{ hqOutcome: string | null; pipelineTrace: { router?: { route: string } } | null }>(
      `SELECT "hqOutcome", "pipelineTrace" FROM "AdminGroupMessage" WHERE "waMessageId" = $1`,
      ["e2e-ags-bibs"],
    );
    expect(row).toMatchObject({ hqOutcome: "silent", pipelineTrace: { router: { route: "none" } } });
  });
});

// FNF HQ 2026-10-24 12:48-12:52 UTC. Abdul-Hafeez has the alias "AH", set
// in the admin portal. "AH\nRafi\nShehryar\nRaihan\nHamzah\n\nIN" brought
// the other four off the bench and left him there; "AH out" did nothing and
// said nothing. The engine's resolver now reads the club's aliases, and the
// extractor is told who an alias in the message is.
test.describe("an alias set in the admin portal names the player in HQ", () => {
  test.beforeAll(async ({ db }) => {
    resetDb();
    await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [ORG_ID, HQ]);
    await db.run(`INSERT INTO "UserAlias" (id, "userId", "orgId", alias, source) VALUES ('e2e-ags-alias-bb', $1, $2, 'bb', 'manual')`, [U.bench, ORG_ID]);
  });

  const callsFor = (body: string): string[] => {
    let raw = "";
    try {
      raw = readFileSync(`${E2E.HQ_SQUAD_READER_STUB_FILE}.calls`, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { user: string }).user)
      .filter((u) => u.trimEnd().endsWith(`\n${body}`));
  };

  test("a name list with the alias and IN: Ben Bench comes off the bench, as himself", async ({ request, db }) => {
    const text = "BB\nPat\n\nIN";
    engineOn({ [text]: { route: "other_att", reading: changeReading([["Ben Bench", "in"], ["Pat Player", "in"]]) } });
    const out = await say(request, text, ADMIN, "e2e-ags-alias-list");
    expect(out).toMatchObject({ handled: true, outcome: "squad-changed", react: "✅" });
    expect(out.replyText).toMatch(/^Done: Ben Bench in\. 5 of 5\.$/);
    expect(await statusOf(db, U.bench)).toBe("CONFIRMED");
    // No new player called "BB".
    expect(await db.one(`SELECT id FROM "User" WHERE name = 'BB'`)).toBeNull();
  });

  test("'BB out': the reader is shown BB as Ben Bench's alias, and he is out", async ({ request, db }) => {
    engineOn({ "BB out": { route: "other_att", reading: changeReading([["Ben Bench", "out"]]) } });
    const out = await say(request, "BB out", ADMIN, "e2e-ags-alias-out");
    expect(out).toMatchObject({ handled: true, outcome: "squad-changed", react: "✅" });
    expect(out.replyText).toMatch(/^Done: Ben Bench out\./);
    expect(await statusOf(db, U.bench)).toBe("DROPPED");
    const seen = callsFor("BB out");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain("Ben Bench (also: bb)");
  });
});
