/**
 * HELP FOR A CLUB WHOSE ORGANISERS ANNOUNCE, END TO END (2026-10-15).
 *
 * The fixture club (E2E Test FC) switched to FNF's settings:
 * `listAnnouncer = 'organisers'`, `benchPickMode = 'organiser'`,
 * `benchPickFallback = 'leave-empty'`, and an admin group (HQ) linked.
 *
 *   1. the players' group: "@Match Time help teams" says the organisers
 *      share the teams; bare help offers neither the squad nor the teams;
 *   2. an organiser's DM bare help points at "help" in the admin group;
 *   3. HQ: an admin's "@Match Time help" gets the HQ command list. The
 *      router stub would read it as "Tom out" if it were ever asked: Tom
 *      stays in, so the help request never reached the squad path;
 *   4. back on the defaults, the group's bare help is what it always was.
 *
 * No model is called. Since 2026-10-28 the help topic is the question
 * extractor's (`how_it_works`), so the router and the extractor are
 * stubbed with what the model would say; the HQ stub is there to prove the
 * squad path is not reached.
 */
import { test, expect, postAnalyze, resetDb } from "../fixtures";
import { MATCH, ORG_ID, PHONE, NAME, U } from "../helpers/constants";
import { E2E } from "../helpers/env";
import { engineOn, clearPipelineStubs, helpOn, otherFacts } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const HQ = "120363777000000041@g.us";
const ADMIN = PHONE.admin.replace(/^\+/, "");
const PLAYER = PHONE.player.replace(/^\+/, "");

let n = 0;
const msgId = () => `e2e-help-oa-${Date.now()}-${++n}`;

/** What the model reads from each help message (stubbed). */
const HELP_READ = {
  "@Match Time help teams": { feature: "teams" },
  "@Match Time help": {},
  "@Match Time help availability": { feature: "availability" },
  "@Match Time yardım kadro": { feature: "availability" },
  help: {},
};

async function groupHelp(request: APIRequestContext, body: string): Promise<string> {
  helpOn(HELP_READ);
  const id = msgId();
  const res = await postAnalyze(request, [
    { waMessageId: id, body, authorPhone: PHONE.player, authorName: NAME.player, botMentioned: true },
  ]);
  const r = (res.results as Array<{ waMessageId: string; reply?: string; handledBy?: string }>).find((x) => x.waMessageId === id)!;
  expect(r.handledBy).toBe("llm");
  return r.reply ?? "";
}

async function hq(request: APIRequestContext, text: string, senderPhone = ADMIN) {
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: KEY,
    data: { channel: "admin-group", groupId: HQ, messageId: msgId(), text, senderPhone, timestamp: String(Math.floor(Date.now() / 1000)) },
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

test.beforeAll(async ({ db }) => {
  resetDb();
  await db.run(
    `UPDATE "Organisation" SET "listAnnouncer" = 'organisers', "benchPickMode" = 'organiser', "benchPickFallback" = 'leave-empty',
            "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`,
    [ORG_ID, HQ],
  );
});

test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

test("players' group: 'help teams' says the organisers share the teams, never that MatchTime posts them", async ({ request }) => {
  const reply = await groupHelp(request, "@Match Time help teams");
  expect(reply).toContain("The organisers sort out the teams and share them with the group themselves");
  expect(reply).not.toMatch(/generate the teams|I post the line-ups|show the teams/);
});

test("players' group: bare help offers neither the squad nor the teams, and says who shares them", async ({ request }) => {
  const reply = await groupHelp(request, "@Match Time help");
  expect(reply).toContain("📣 The organisers share the squad list and the teams.");
  expect(reply).not.toContain("make / show the teams");
  expect(reply).not.toContain("see who's in / how many we've got");
  expect(reply).not.toMatch(/[—–]/);
});

// The route's organisers-mode net (`organisersGroupReply`) read this answer's
// "*Squad & availability*" heading as squad state and replaced the whole
// help with "The organisers will post the list." Help is now let through.
test("players' group: 'help availability' says the organisers pick, not that MatchTime nudges the bench", async ({ request }) => {
  const reply = await groupHelp(request, "@Match Time help availability");
  expect(reply).toContain("⚽ *Squad & availability: how it works*");
  expect(reply).toContain("When a place opens, the organisers pick who plays.");
  expect(reply).not.toContain("nudge the bench");
});

test("players' group, Turkish: 'yardım kadro' gets the explainer, not 'Listeyi organizatörler paylaşacak.'", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    const reply = await groupHelp(request, "@Match Time yardım kadro");
    expect(reply).toContain("⚽ *Kadro ve katılım nasıl çalışır*");
    expect(reply).toContain("Bir yer açılınca kimin oynayacağını organizatörler seçer.");
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("an organiser's DM bare help points at 'help' in the admin group, and keeps the settings link", async ({ request, db }) => {
  helpOn(HELP_READ);
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: KEY,
    data: { phone: PHONE.admin, body: "help", waMessageId: msgId(), authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect(await res.json()).toMatchObject({ handled: "dm-help", audience: "admin" });
  const dm = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE kind = 'dm' AND phone = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [ADMIN],
  );
  expect(dm?.text).toContain("In your admin group, ask me what I can do there, in your own words (for example *what can you do?*).");
  expect(dm?.text).toMatch(/Your club's settings, signed in:\nhttps?:\/\/\S+\/r\/\S+$/);
});

test("HQ: an admin asking what MatchTime can do gets the list, and never reaches the squad path", async ({ request, db }) => {
  // The SHARED router reads it (stubbed: what it would say). The extractor
  // stub would read it as "Tom out" if the squad path were ever asked.
  engineOn({
    "@Match Time what can you do here?": { route: "help", facts: otherFacts("Tom", "out") },
    "yardım": { route: "help" },
  });
  const before = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AnalyzedMessage"`);
  const out = await hq(request, "@Match Time what can you do here?");
  expect(out).toMatchObject({ handled: true, outcome: "hq-help" });
  expect(out.replyText).toContain("🛠️ *MatchTime in your admin group*");
  expect(out.replyText).toContain("*Paste the whole squad list*");
  expect(out.replyText).toContain("shuffle them again");
  expect(out.replyText).toContain("send the poster");
  expect(out.replyText).toContain("pick who plays");
  expect(out.replyText).not.toContain("PAID ALL");
  expect(await statusOf(db, U.third)).toBe("CONFIRMED");
  expect((await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM "AnalyzedMessage"`))?.n).toBe(before?.n);
});

test("HQ: bare 'yardım' in a Turkish club answers in Turkish", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [ORG_ID]);
  try {
    const out = await hq(request, "yardım");
    expect(out).toMatchObject({ handled: true, outcome: "hq-help" });
    expect(out.replyText).toContain("*Yönetici grubunda MatchTime*");
  } finally {
    await db.run(`UPDATE "Organisation" SET language = 'en' WHERE id = $1`, [ORG_ID]);
  }
});

test("HQ: a non-admin's help is ignored as before, with no reply", async ({ request }) => {
  expect(await hq(request, "help", PLAYER)).toMatchObject({ handled: false, replyText: null });
  clearPipelineStubs();
});

test("back on the defaults, the group's bare help still offers the squad and the teams", async ({ request, db }) => {
  await db.run(`UPDATE "Organisation" SET "listAnnouncer" = 'matchtime', "benchPickMode" = 'first-come' WHERE id = $1`, [ORG_ID]);
  const reply = await groupHelp(request, "@Match Time help");
  expect(reply).toContain("make / show the teams");
  expect(reply).toContain("see who's in / how many we've got");
  expect(reply).not.toContain("📣");
});
