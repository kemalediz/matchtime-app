/**
 * THE VETS SANDBOX, END TO END (Kemal, 2026-11-03).
 *
 * Before MatchTime is unmuted for the Vets MNF group, every feature the
 * group was told about in the welcome is played here, in a sandboxed copy of
 * the club (`world.ts`), with messages modelled on the real chat: the
 * 3 Nov 09:00 to 09:22 stretch and Davide's "MNF November" list.
 *
 *   npm run test:sim:live:vets        # PAID, dev key only (about $0.02 a run)
 *
 * Scenario D runs the Pi's real batcher (`pi-batcher-driver.ts`), so it
 * needs whatsapp-bot's packages installed (`cd whatsapp-bot && npm ci`).
 *
 * Real routes, the real database (embedded, isolated), the real model on
 * ANTHROPIC_API_KEY_DEV for the router, the extractors and the readers;
 * nothing on the path under test is stubbed. Nothing is sent to WhatsApp:
 * "sent" means queued (BotJob) or returned for the Pi to post. Scenario A
 * makes no model call and also runs stubbed; every other scenario is live
 * only. Each scenario prints its own calls and cost (`[vets-cost]`), read
 * off the run's metering proxy.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatInTimeZone } from "date-fns-tz";
import { scenario, liveOnly, expect, LIVE } from "../pool/fixtures";
import { resetDb, signInAs } from "../../fixtures";
import { E2E, E2E_BASE_URL, REPO_ROOT } from "../../helpers/env";
import type { TestDb } from "../../helpers/test-db";
import {
  LIST_KEYS,
  LONDON,
  analyzed,
  armRouterCutOff,
  authorOf,
  lastMondayKickoff,
  london,
  londonDay,
  monthListText,
  readMeter,
  say,
  sayBatch,
  schedulerPoll,
  vetsClub,
  type Instruction,
  type MeterReading,
  type VetsClub,
} from "./world";

const COST_FILE = path.join(REPO_ROOT, ".e2e", "vets-sandbox-cost.jsonl");

/**
 * The week's list in the format Kemal approved on 2026-11-03: the title,
 * the month's squad by first name under real slot numbers, the "you're all
 * in" line, then pay as you go. No paid marks, no phone, nobody unnamed.
 */
function expectWeekListShape(text: string, kickoff: Date, squadSize: number, open: number): void {
  const lines = text.split("\n");
  expect(lines[0]).toBe(`📋 *Football 7-a-side, ${formatInTimeZone(kickoff, LONDON, "EEE d MMM 'at' HH:mm")}*`);
  expect(lines[2]).toBe(`*${formatInTimeZone(kickoff, LONDON, "MMMM")} squad:*`);
  const squad = lines.slice(3, 3 + squadSize);
  expect(squad, "the squad, one first name a line").toHaveLength(squadSize);
  for (const l of squad) expect(l).toMatch(/^\d{1,2}\. \p{L}+$/u);
  expect(lines[3 + squadSize]).toBe("");
  expect(lines[4 + squadSize]).toBe("You're all in, no need to say anything. Can't make it? Say *Out* and your place opens up.");
  expect(lines.at(-1)).toBe(`*Pay as you go:* ${open} ${open === 1 ? "place" : "places"} open, £8. Say *IN* to take ${open === 1 ? "it" : "one"}.`);
  expect(text).not.toMatch(/\((?:paid|PAYG)\)|unnamed|\+44|\d{10}/i);
  expect(text).not.toMatch(/[\u2013\u2014]/);
}
let before: MeterReading | null = null;

// Each scenario builds its own club, so one failing does not stop the rest
// (the pool's `scenarios` runs them serially and skips the rest on a failure).
scenario.describe("the Vets sandbox", () => {
  scenario.beforeAll(() => resetDb());
  scenario.afterAll(() => resetDb());
  scenario.beforeEach(async () => {
    before = await readMeter();
  });
  scenario.afterEach(async ({}, testInfo) => {
    const after = await readMeter();
    const calls = after.calls - (before?.calls ?? 0);
    const cost = after.costUsd - (before?.costUsd ?? 0);
    const line = { scenario: testInfo.title, status: testInfo.status, calls, costUsd: Number(cost.toFixed(5)), live: LIVE };
    console.log(`[vets-cost] ${testInfo.title}: ${calls} model call(s), $${cost.toFixed(4)} (${testInfo.status})`);
    mkdirSync(path.dirname(COST_FILE), { recursive: true });
    appendFileSync(COST_FILE, `${JSON.stringify(line)}\n`);
  });

  // ── A ──────────────────────────────────────────────────────────────
  scenario("A. a monthly club with no month: no weekly 'Say IN to join', the monthly copy instead, and no chase posts", async ({ pool }) => {
    const v = await vetsClub(pool, "vets", { month: "none" });
    // The Pi polls every 30 s; here every 30 minutes, from this morning
    // 09:00 (the incident tick) to an hour after kickoff, claiming as the
    // Pi does so each post is handed out once.
    const all: Array<Instruction & { at: string }> = [];
    const start = london(londonDay(new Date()), "09:00");
    const end = new Date(v.kickoff.getTime() + 60 * 60_000);
    for (let t = start.getTime(); t <= end.getTime(); t += 30 * 60_000) {
      const { instructions } = await schedulerPoll(pool, v, new Date(t));
      for (const i of instructions) all.push({ ...i, at: new Date(t).toISOString() });
    }
    const group = all.filter((i) => i.kind === "group-message" || i.kind === "group-poll");
    console.log(`[vets A] ${all.length} instruction(s):\n${all.map((i) => `  ${i.at} ${i.kind} ${i.key ?? ""}: ${(i.text ?? "").slice(0, 160).replace(/\n/g, " | ")}`).join("\n")}`);

    expect(group.filter((i) => /Say \*IN\* to join/.test(i.text ?? "")), "the weekly ask").toEqual([]);
    const announce = group.filter((i) => /Paid for the month\? You're in every game/.test(i.text ?? ""));
    expect(announce, "the monthly announcement").toHaveLength(1);
    expect(announce[0].text).toContain("Pay as you go? Say *IN* to take an open place, and you pay for this game only.");
    expect(announce[0].text).toContain("Davide will post the month's list if it isn't up yet.");
    // No chase of any kind: no "need N more", no roster, no squad count.
    const chase = group.filter((i) => /chase|roster|squad|need|more players|places? (left|open)|\d+\/14/i.test(`${i.key ?? ""} ${i.text ?? ""}`) && !announce.includes(i));
    expect(chase, "chase posts").toEqual([]);
    // Nor the owner's day-before nudges: "Match in trouble: only 0
    // confirmed ... Cancel and refund the booking?" on the Sunday counted
    // whoever said IN, which before the month exists is nobody by design.
    const nudges = all.filter((i) => /cancel-nudge|switch-nudge/.test(i.key ?? "") || /Match in trouble|Low numbers/.test(i.text ?? ""));
    expect(nudges, "the owner's day-before nudges").toEqual([]);
  });

  // ── B ──────────────────────────────────────────────────────────────
  scenario("B. INs before the month exists write nothing and say nothing", async ({ pool, db }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "none" });
    // 3 Nov 09:01 to 09:03, one flush, then Davide's own IN and a tagged one.
    const first = await sayBatch(pool, v, [
      { key: "p11", body: "IN" },
      { key: "nabz", body: "IN" },
      { key: "craig", body: "In" },
    ]);
    const second = await sayBatch(pool, v, [
      { key: "davide", body: "In" },
      { key: "luca", body: "@Match Time I'm in", tag: true },
    ]);
    for (const r of [...first, ...second]) {
      expect(r, JSON.stringify(r)).toMatchObject({ react: null, reply: null });
      expect(r.intent).not.toBe("not_understood");
      expect(r.sent).toEqual([]);
    }
    expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1`, [v.matchId])).toBe(0);
    expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [v.orgId])).toBe(0);
    const rows = await db.all<{ reasoning: string }>(`SELECT reasoning FROM "AnalyzedMessage" WHERE "orgId" = $1`, [v.orgId]);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.reasoning.includes("no month for this game yet")), JSON.stringify(rows)).toBe(true);
  });

  // ── K ──────────────────────────────────────────────────────────────
  scenario("K. banter stays silent; a tagged help request gets the help menu", async ({ pool, db }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "running" });
    // The 3 Nov stretch's banter, and the night before's.
    const banter = await sayBatch(pool, v, [
      { key: "shane", body: "This some new age stuff this" },
      { key: "shane", body: "David Stark" },
      { key: "davide", body: "Thank kamal not me" },
      { key: "shane", body: "Capital N bro" },
      { key: "davide", body: "We moving with the times" },
      { key: "davide", body: "Sets up balanced teams and all based on player ratings" },
      { key: "p18", body: "Great game gents" },
      { key: "nabz", body: "😂😂" },
      { key: "davide", body: "Does anyone have a pump I have spare balls I'd like to bring" },
      { key: "dan", body: "I can bring a pump" },
    ]);
    for (const r of banter) {
      expect(r, JSON.stringify(r)).toMatchObject({ react: null, reply: null });
      expect(r.sent).toEqual([]);
    }
    expect(await db.count(`SELECT COUNT(*) FROM "BotJob" WHERE "orgId" = $1`, [v.orgId])).toBe(0);

    const help = await say(pool, v, "shane", "@Match Time help", { tag: true });
    expect(help.intent).toBe("help");
    expect(help.reply).toMatch(/MatchTime help/);
    expect(help.reply).toMatch(/help ratings/);
    expect(help.reply).toMatch(/help friend/);
    // Payments are off at this club: no payments topic in the menu.
    expect(help.reply).not.toMatch(/• \*@Match Time help payments\*/);
  });

  // ── C ──────────────────────────────────────────────────────────────
  scenario("C. Davide posts the month's list the day after its first game: recognised, a start-the-month DM, his YES starts it part-way, the regulars seeded on the next match", async ({ pool, db }) => {
    liveOnly();
    const now = new Date();
    const monthName = formatInTimeZone(now, LONDON, "MMMM");
    const firstMonday = (() => {
      for (let d = 1; d <= 7; d++) {
        const k = london(`${formatInTimeZone(now, LONDON, "yyyy-MM")}-0${d}`, "20:30");
        if (Number(formatInTimeZone(k, LONDON, "i")) === 1) return k;
      }
      throw new Error("no Monday");
    })();
    // The incident's own date: the month's first Monday played, games left.
    scenario.skip(now.getTime() < firstMonday.getTime() || formatInTimeZone(now, LONDON, "MM") !== formatInTimeZone(new Date(now.getTime() + 7 * 86_400_000), LONDON, "MM"), "needs a day after this month's first Monday with a Monday still to come");
    const v = await vetsClub(pool, "vets", { month: "none" });
    // The Pi's participant sweep at its start: the WhatsApp names it knows
    // (pushnames) go with each member, and a nameless member takes his
    // (2026-11-03). Craig, Ben, Andrew and Oumesh have none.
    const sweep = await pool.request.post("/api/whatsapp/sync-participants", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { groupId: v.club.group.groupId, participants: [...v.members.keys()].map((k) => ({ phone: v.phone(k), pushname: authorOf(v, k).name })) },
    });
    expect(sweep.status(), await sweep.text()).toBe(200);
    const stillNameless = ["craig", "ben", "andrew", "oumesh"];
    for (const k of ["nabz", "steff", "dan", "steve", "jon"]) {
      expect((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [v.userId(k)]))?.name, k).toBe(authorOf(v, k).name);
    }

    // 3 Nov 09:14: Davide's two messages, one flush.
    const [title, list] = await sayBatch(pool, v, [
      { key: "davide", body: "November monthly squad" },
      { key: "davide", body: monthListText(monthName) },
    ]);
    for (const r of [title, list]) expect(r, JSON.stringify(r)).toMatchObject({ react: null, reply: null });
    expect(list.intent).toBe("month_seed_list");
    const toGroup = [...title.sent, ...list.sent].filter((m) => m.channel !== "dm");
    expect(toGroup, "nothing in the group").toEqual([]);
    const dm = [...title.sent, ...list.sent].filter((m) => m.channel === "dm");
    const proposals = await db.all<{ waMessageId: string; createdAt: Date }>(`SELECT "waMessageId", "createdAt" FROM "AdminSquadProposal" WHERE "orgId" = $1`, [v.orgId]);
    const notes = await db.all<{ key: string }>(`SELECT key FROM "SentNotification" WHERE key LIKE $1`, [`org-${v.orgId}:month-seed-dm:%`]);
    console.log(`[vets C] title ${title.waMessageId} (${title.intent}), list ${list.waMessageId} (${list.intent}); proposals ${JSON.stringify(proposals)}; dm notes ${JSON.stringify(notes)}`);
    expect(dm.every((m) => m.to === "vets.davide")).toBe(true);
    expect.soft(dm, "ONE start-the-month DM").toHaveLength(1);
    console.log(`[vets C] the start-the-month DM:\n${dm[0].text}`);
    expect(dm[0].text).toContain(`I read the list you posted in the group for ${monthName}`);
    const proposal = await db.one<{
      monthStart: string;
      monthSeed: { gamesPlayed: number; rows: Array<{ userId: string | null; name?: string }>; unmatched?: Array<{ ref: string; name: string }>; nameless?: Array<{ n: number; userId: string }> };
    }>(
      `SELECT "monthStart", "monthSeed" FROM "AdminSquadProposal" WHERE "orgId" = $1 AND "resolvedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`,
      [v.orgId],
    );
    console.log(`[vets C] proposal: ${JSON.stringify(proposal)}`);
    expect(proposal?.monthStart).toBe(`${formatInTimeZone(now, LONDON, "yyyy-MM")}-01`);
    // The four with no WhatsApp name are the names it could not match, and
    // the DM numbers the nameless members, by phone, for him to say who is who.
    expect(proposal?.monthSeed.unmatched?.map((u) => u.name.toLowerCase()).sort()).toEqual([...stillNameless].sort());
    expect(dm[0].text).toContain("I couldn't match these names on your list to anyone");
    const numberOf = (k: string) => proposal?.monthSeed.nameless?.find((m) => m.userId === v.userId(k))?.n;
    for (const k of stillNameless) {
      expect(numberOf(k), k).toBeTruthy();
      expect(dm[0].text).toContain(`${numberOf(k)}. +44 ${v.phone(k).slice(2, 6)} ${v.phone(k).slice(6)}`);
    }

    // Who is who, in his own words, by DM: the reply reader (the model).
    const who = await v.club.member("davide").dm(`Craig is ${numberOf("craig")}, Ben ${numberOf("ben")}, Andrew is number ${numberOf("andrew")} and Oumesh ${numberOf("oumesh")}`);
    console.log(`[vets C] who is who: ${JSON.stringify(who.json)}\n${who.sent.map((m) => `  -> ${m.to}: ${m.text}`).join("\n")}`);
    expect(who.json).toMatchObject({ handled: "month-seed-changed" });
    for (const k of stillNameless) {
      const u = await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [v.userId(k)]);
      expect(u?.name?.toLowerCase(), k).toBe(k);
    }
    expect(who.sent.at(-1)?.text ?? "").toContain("13 players");

    // His answer, in his own words, by DM.
    const yes = await v.club.member("davide").dm("Yes go ahead mate");
    console.log(`[vets C] his YES: ${JSON.stringify(yes.json)}\n${yes.sent.map((m) => `  -> ${m.to}: ${m.text}`).join("\n")}`);
    expect(yes.json).toMatchObject({ handled: "month-seed-started" });
    const month = await db.one<{ status: string; played: number; scheduled: number; partWay: boolean; members: number }>(
      `SELECT status, "gamesPlayedBeforeStart" AS played, "gamesScheduled" AS scheduled, ("startedMidMonthAt" IS NOT NULL) AS "partWay",
              (SELECT COUNT(*)::int FROM "SquadMonthMember" mm WHERE mm."monthId" = sm.id AND mm."leftAt" IS NULL) AS members
         FROM "SquadMonth" sm WHERE "orgId" = $1`,
      [v.orgId],
    );
    console.log(`[vets C] month: ${JSON.stringify(month)}`);
    expect(month).toMatchObject({ status: "running", partWay: true });
    expect(month!.played).toBeGreaterThanOrEqual(1);
    expect(month!.played).toBeLessThan(month!.scheduled);

    // The next scheduler poll seeds the regulars onto Monday's match, and
    // posts the week's list: the squad first, by first name, no paid marks.
    const seedPoll = await schedulerPoll(pool, v, new Date());
    const weekPost = seedPoll.instructions.filter((i) => i.key?.startsWith(`${v.matchId}:month-list:`));
    console.log(`[vets C] the week's list:\n${weekPost[0]?.text}`);
    expect(weekPost, "the week's list, once").toHaveLength(1);
    expectWeekListShape(weekPost[0].text ?? "", v.kickoff, 13, 1);
    const seeded = await db.all<{ userId: string; name: string | null; status: string; position: number }>(
      `SELECT a."userId", u.name, a.status, a.position FROM "Attendance" a JOIN "User" u ON u.id = a."userId" WHERE a."matchId" = $1 ORDER BY a.position`,
      [v.matchId],
    );
    console.log(`[vets C] seeded on ${v.kickoff.toISOString()}: ${JSON.stringify(seeded)}`);
    expect(seeded.filter((r) => r.status === "CONFIRMED")).toHaveLength(month!.members);
    expect(month!.members).toBe(13);
    // The four named regulars are themselves, not new copies.
    for (const k of ["davide", "kerem", "shane", "cj"]) expect(seeded.map((r) => r.userId), k).toContain(v.userId(k));
  });

  // ── D ──────────────────────────────────────────────────────────────
  scenario("D. 22 messages arrive during a running flush; the Pi flushes again when it ends; a cut-off router answer is asked again in halves; the tagged question is answered", async ({ pool, db }) => {
    liveOnly();
    // The Pi's own code runs here, so it needs the Pi's packages.
    scenario.skip(!existsSync(path.join(REPO_ROOT, "whatsapp-bot", "node_modules")), "needs whatsapp-bot's packages (cd whatsapp-bot && npm ci)");
    const v = await vetsClub(pool, "vets", { month: "none" });
    const p = (key: string) => ({ phone: v.phone(key), pushname: authorOf(v, key).name });
    const monthName = formatInTimeZone(new Date(), LONDON, "MMMM");
    // 09:01 to 09:03: the tick's flush.
    const first = [
      { ...p("p11"), body: "IN" },
      { ...p("nabz"), body: "IN" },
      { ...p("craig"), body: "In" },
    ];
    // 09:10 to 09:14, the real 22, while that flush runs (Kemal is "Kerem" here).
    const during = [
      { ...p("shane"), body: "@Match Time what happens if 14 don’t confirm?", tagged: true },
      { ...p("kerem"), body: "guys, do you want to go ahead with saying IN or monthly squad?" },
      { ...p("davide"), body: "It will work\nWith what it has" },
      { ...p("davide"), body: "In" },
      { ...p("kerem"), body: "i can switch it to monthly squad as payments made upfront" },
      { ...p("shane"), body: "This some new age stuff this" },
      { ...p("shane"), body: "David Stark" },
      { ...p("davide"), body: "Thank kerem not me" },
      { ...p("shane"), body: "Capital N bro" },
      { ...p("p15"), body: "IN" },
      { ...p("kerem"), body: "IN is the style most of other groups use it, as they generally do polling" },
      { ...p("davide"), body: "We moving with the times" },
      { ...p("davide"), body: "IN" },
      { ...p("kerem"), body: "no need to say IN if we move it to monthly squad" },
      { ...p("davide"), body: "Sets up balanced teams and all based on player ratings" },
      { ...p("kerem"), body: "i can configure it, just tell me" },
      { ...p("kerem"), body: "ok you don't have to say IN. just wait for me pls to configure it" },
      { ...p("shane"), body: "<Media omitted>" },
      { ...p("kerem"), body: "@Davide Russo can you post the squad that made the payments upfront for November so it recognises?" },
      { ...p("kerem"), body: "the other PAYG players can say IN, or we can bring guests and say IN for them such as \"David Aksoy is IN\"" },
      { ...p("davide"), body: "November monthly squad" },
      { ...p("davide"), body: monthListText(monthName) },
    ];
    expect(during).toHaveLength(22);
    // Force the cut-off on the 22's router call, as the unit tests do: the
    // real answer comes back, marked as having run out of room.
    const armed = await armRouterCutOff(20);
    expect(armed).toBe(true);
    const m0 = await readMeter();

    const dir = path.join(REPO_ROOT, ".e2e", "vets-sandbox");
    mkdirSync(dir, { recursive: true });
    const inFile = path.join(dir, "pi-in.json");
    const outFile = path.join(dir, "pi-out.json");
    writeFileSync(inFile, JSON.stringify({ apiUrl: E2E_BASE_URL, apiKey: E2E.WHATSAPP_API_KEY, groupId: v.club.group.groupId, botPhone: "447700900999", first, during }));
    pool.note("the Pi: the tick flushes 3 INs; 22 messages arrive while it runs, a tag among them");
    const run = spawnSync("npx", ["tsx", "e2e/sim/vets/pi-batcher-driver.ts", inFile, outFile], { cwd: REPO_ROOT, encoding: "utf8", timeout: 300_000 });
    console.log(`[vets D] driver exit ${run.status}\n${(run.stdout ?? "").split("\n").filter((l) => /\[smart\]/.test(l)).join("\n")}\n${(run.stderr ?? "").slice(-3000)}`);
    expect(run.status).toBe(0);
    const out = JSON.parse(readFileSync(outFile, "utf8")) as {
      duringStartedWhileFirstRunning: boolean;
      flushesWhenAllBuffered: number;
      flushes: Array<{ bodies: string[]; results: Array<{ waMessageId: string; react: string | null; reply: string | null; intent: string | null; handledBy: string }> }>;
      sent: Array<{ kind: string; text?: string; emoji?: string }>;
      ids: { first: string[]; during: string[] };
    };
    const m1 = await readMeter();
    console.log(`[vets D] flushes: ${out.flushes.map((f) => f.bodies.length).join(" + ")}; sent: ${JSON.stringify(out.sent, null, 1)}`);
    console.log(`[vets D] meter: truncated ${m1.truncated - m0.truncated}, calls ${m1.calls - m0.calls}`);
    for (const s of out.sent) pool.note(`[the Pi sent] ${s.kind}${s.emoji ? ` ${s.emoji}` : ""}: ${s.text ?? ""}`);

    // The batcher: the 22 arrived during the running flush, and were flushed
    // together as soon as it ended (not at the next tick).
    expect(out.duringStartedWhileFirstRunning).toBe(true);
    expect(out.flushesWhenAllBuffered).toBe(1);
    expect(out.flushes.map((f) => f.bodies.length)).toEqual([3, 22]);
    // The router: the 22's answer was cut off and asked again in halves.
    expect(m1.truncated - m0.truncated).toBe(1);
    // The tagged question: answered, never the not-understood line.
    const q = out.flushes[1].results.find((r) => r.waMessageId === out.ids.during[0])!;
    console.log(`[vets D] the tagged question's result: ${JSON.stringify(q)}\n  as recorded: ${JSON.stringify(await analyzed(db, q.waMessageId))}`);
    const replies = out.sent.filter((s) => s.kind === "text").map((s) => s.text ?? "");
    expect(q.reply, JSON.stringify(q)).toBeTruthy();
    expect(q.intent).not.toBe("not_understood");
    expect(replies.join("\n")).not.toMatch(/didn't catch that|did not catch that|not sure what you mean/i);
    // Answered the monthly way: never the weekly "say In or Out for the
    // next game" explainer, never a count of whoever said IN.
    expect(q.reply).not.toContain("Just say *In* or *Out* in the group to mark yourself for the next game");
    expect(q.reply).not.toMatch(/We're \d+ of 14/);
    expect(q.reply).toContain("monthly squad");
    // And the INs before the month exists still write nothing.
    expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1`, [v.matchId])).toBe(0);
  });

  // ── E ──────────────────────────────────────────────────────────────
  scenario("E. a running month: a pay-as-you-go IN takes the open place, a regular's OUT frees one, a player's 'David Aksoy is IN' gets him the friend link, the organiser's puts the guest in", async ({ pool, db }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    // The poll after 08:00 the morning after the last game seeds the week.
    await schedulerPoll(pool, v, new Date());
    const confirmed = () =>
      db.all<{ userId: string; name: string | null; position: number }>(
        `SELECT a."userId", u.name, a.position FROM "Attendance" a JOIN "User" u ON u.id = a."userId" WHERE a."matchId" = $1 AND a.status = 'CONFIRMED' ORDER BY a.position`,
        [v.matchId],
      );
    expect(await confirmed()).toHaveLength(13);

    // A PAYG player (nameless, pushname "Mo") takes the one open place.
    const payg = await say(pool, v, "p12", "IN");
    console.log(`[vets E] PAYG IN: ${JSON.stringify({ react: payg.react, reply: payg.reply, intent: payg.intent, sent: payg.sent })}`);
    expect(payg.react).toBe("✅");
    const afterIn = await confirmed();
    expect(afterIn).toHaveLength(14);
    expect(afterIn.map((r) => r.userId)).toContain(v.userId("p12"));

    // A regular can't make it.
    const out = await say(pool, v, "steve", "Out this week lads sorry, work");
    console.log(`[vets E] regular OUT: ${JSON.stringify({ react: out.react, reply: out.reply, intent: out.intent, sent: out.sent })}`);
    const afterOut = await confirmed();
    expect(afterOut).toHaveLength(13);
    expect(afterOut.map((r) => r.userId)).not.toContain(v.userId("steve"));

    // Kerem (a regular, not an organiser) puts his son in, as the chat was
    // told. "David" is not Davide (the near miss no longer swallows a
    // different surname), so David Aksoy is a new person: from a player
    // that is the friend link by DM, and nobody is added (friend link D1).
    const viaPlayer = await say(pool, v, "kerem", "David Aksoy is IN");
    console.log(`[vets E] player's guest IN: ${JSON.stringify({ react: viaPlayer.react, reply: viaPlayer.reply, intent: viaPlayer.intent, handledBy: viaPlayer.handledBy, sent: viaPlayer.sent })}`);
    console.log(`[vets E] player's guest IN, as recorded: ${JSON.stringify(await analyzed(db, viaPlayer.waMessageId))}`);
    expect(viaPlayer.react).toBe("✉️");
    const dms = viaPlayer.sent.filter((m) => m.channel === "dm");
    expect(dms.map((m) => m.to)).toEqual(["vets.kerem"]);
    expect(dms[0].text).toMatch(/David Aksoy/);
    expect(await confirmed()).toHaveLength(13);

    // The organiser says the same: the guest goes straight on the list.
    const guest = await say(pool, v, "davide", "David Aksoy is IN");
    console.log(`[vets E] organiser's guest IN: ${JSON.stringify({ react: guest.react, reply: guest.reply, intent: guest.intent, handledBy: guest.handledBy, sent: guest.sent })}`);
    console.log(`[vets E] organiser's guest IN, as recorded: ${JSON.stringify(await analyzed(db, guest.waMessageId))}`);
    const afterGuest = await confirmed();
    console.log(`[vets E] confirmed after the guest: ${JSON.stringify(afterGuest.map((r) => [r.position, r.name]))}`);
    expect(afterGuest.some((r) => r.name === "David Aksoy"), "David Aksoy confirmed").toBe(true);
    expect(afterGuest.map((r) => r.userId)).toContain(v.userId("davide"));
    expect(afterGuest).toHaveLength(14);
  });

  // ── F ──────────────────────────────────────────────────────────────
  scenario("F. 'my friend Ali is coming': the friend link by DM", async ({ pool, db }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    await schedulerPoll(pool, v, new Date());
    const r = await say(pool, v, "cj", "my friend Ali is coming");
    console.log(`[vets F] ${JSON.stringify({ react: r.react, reply: r.reply, intent: r.intent, handledBy: r.handledBy, sent: r.sent })}`);
    expect(r.react).toBe("✉️");
    const dms = r.sent.filter((m) => m.channel === "dm");
    expect(dms.map((m) => m.to)).toEqual(["vets.cj"]);
    expect(dms[0].text).toMatch(/^Here's the link for Ali to join/);
    expect(dms[0].text).toMatch(/\/play\/f\/\S+/);
    expect(r.sent.filter((m) => m.channel === "group")).toEqual([]);
    expect(await db.one(`SELECT id FROM "User" WHERE name = 'Ali'`)).toBeNull();
  });

  // ── G ──────────────────────────────────────────────────────────────
  scenario("G. '@Match Time remind me Thursday': a DM at that time", async ({ pool, db }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    const r = await say(pool, v, "shane", "@Match Time remind me Thursday", { tag: true });
    console.log(`[vets G] ${JSON.stringify({ react: r.react, reply: r.reply, intent: r.intent, handledBy: r.handledBy, sent: r.sent.map((m) => ({ to: m.to, sendAfter: m.sendAfter, text: m.text })) })}`);
    const dms = r.sent.filter((m) => m.channel === "dm");
    expect(dms.map((m) => m.to)).toEqual(["vets.shane"]);
    const at = dms[0].sendAfter ? new Date(dms[0].sendAfter) : null;
    expect(at, "the DM is held until Thursday").not.toBeNull();
    // The coming Thursday, London.
    expect(formatInTimeZone(at!, LONDON, "EEEE")).toBe("Thursday");
    expect(at!.getTime()).toBeGreaterThan(Date.now());
    expect(at!.getTime() - Date.now()).toBeLessThan(7 * 86_400_000);
    expect(dms[0].text).toMatch(/Reminder, Shane/);
    // And an acknowledgement in the group.
    expect(r.reply ?? r.react, "acknowledged").toBeTruthy();
    void db;
  });

  // ── H ──────────────────────────────────────────────────────────────
  scenario("H. after a game: rating DMs the morning after to the confirmed players with phones, then the club's first rating post explaining why; a rating through the real page (1 to 10, self refused); MoM picked on the link; the winner announced in the group", async ({ pool, db, page }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: [...LIST_KEYS.slice(0, 13), "p12"] } });
    const played = v.playedMatchId!;
    // A guest with no number played too (Kerem's son): no rating DM for him.
    await db.run(`INSERT INTO "User" (id, name, email, onboarded, "isActive", "updatedAt") VALUES ($1, 'David Aksoy', $2, false, true, now())`, [`sim-vets-guest-${played}`, `sim-guest-${played}@e2e-test.invalid`]);
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'PLAYER')`, [`sim-vets-guest-mem-${played}`, `sim-vets-guest-${played}`, v.orgId]);
    await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, 'CONFIRMED', 15, now())`, [`sim-vets-guest-att-${played}`, played, `sim-vets-guest-${played}`]);
    const confirmedWithPhone = 14;

    // After the final whistle (21:30) to midnight: the welcome promises a
    // quick MoM vote in the group.
    const gameDay = londonDay(lastMondayKickoff());
    const whistle: Instruction[] = [];
    for (const hhmm of ["21:30", "21:45", "22:00", "22:30", "23:00", "23:30"]) whistle.push(...(await schedulerPoll(pool, v, london(gameDay, hhmm))).instructions);
    console.log(`[vets H] after the whistle: ${JSON.stringify(whistle.map((i) => [i.kind, i.key, (i.text ?? "").slice(0, 120)]))}`);
    // Recorded, not asserted: the scheduler has no MoM poll at all at HEAD
    // (only the payment poll, off for a running month), so the vote is on
    // the rating link, which is what the hello now says (scenario L).
    pool.note(`after the whistle, group polls: ${whistle.filter((i) => i.kind === "group-poll").length}`);

    // The morning after (the match was last Monday 20:30): polls from 06:00 to 12:00.
    const morning = londonDay(new Date(lastMondayKickoff().getTime() + 86_400_000));
    const rateDms: Array<{ at: string; to: string; text: string }> = [];
    const promos: Array<{ at: string; text: string }> = [];
    for (const hhmm of ["06:00", "07:00", "07:30", "08:00", "08:30", "09:00", "10:00", "11:00", "12:00"]) {
      const at = london(morning, hhmm);
      const { instructions } = await schedulerPoll(pool, v, at);
      for (const i of instructions.filter((x) => x.kind === "dm" && /rate|rating/i.test(`${x.key ?? ""} ${x.text ?? ""}`))) rateDms.push({ at: hhmm, to: i.phone ?? i.targetUser ?? "?", text: i.text ?? "" });
      for (const i of instructions.filter((x) => x.kind === "group-message" && /:rate-promo$/.test(x.key ?? ""))) promos.push({ at: hhmm, text: i.text ?? "" });
    }
    console.log(`[vets H] rating DMs: ${rateDms.length} at ${[...new Set(rateDms.map((d) => d.at))].join(", ")}\n  first: ${rateDms[0]?.text}`);
    expect(rateDms).toHaveLength(confirmedWithPhone);
    expect(Number(rateDms[0].at.slice(0, 2))).toBeGreaterThanOrEqual(8);
    const phones = new Set(rateDms.map((d) => d.to));
    for (const k of [...LIST_KEYS, "p12"]) expect(phones.has(v.phone(k)), k).toBe(true);

    // The group post after the DMs: the Vets have never had one, so it is
    // the FIRST one, which says what the ratings are for (Kemal,
    // 2026-11-03). Players vote MoM at the Vets, so the MoM sentence stays.
    // "The players", not "everyone": David Aksoy has no number, no DM.
    console.log(`[vets H] the group post after the DMs: ${JSON.stringify(promos)}`);
    expect(promos).toHaveLength(1);
    expect(promos[0].at > rateDms.at(-1)!.at, "after the last DM").toBe(true);
    const [{ name: activityName }] = await db.all<{ name: string }>(`SELECT a.name FROM "Match" m JOIN "Activity" a ON a.id = m."activityId" WHERE m.id = $1`, [played]);
    expect(promos[0].text).toBe(
      `🎯 I've just DM'd the players from the *${activityName}* on ${formatInTimeZone(lastMondayKickoff(), LONDON, "EEE d MMM")} a private link to rate the others out of 10.\n\n` +
        "*Why rate?* I use the ratings to pick two balanced teams, so the games stay close and nobody ends up on the losing side every week. " +
        "Your scores are private: nobody sees who rated what, and you can't rate yourself. The same link is where you pick Man of the Match.\n\n" +
        "It takes about a minute, and the more of you rate, the fairer the teams. Check your DMs from me 👇",
    );

    // Shane opens his link.
    const shaneDm = rateDms.find((d) => d.to === v.phone("shane"))!;
    const link = shaneDm.text.match(/https?:\/\/\S+/)?.[0];
    expect(link, shaneDm.text).toBeTruthy();
    await page.goto(new URL(link!).pathname + new URL(link!).search);
    await page.waitForURL(/\/matches\/.*\/rate/, { timeout: 60_000 });
    const main = page.getByRole("main");
    await expect(main.getByText("Rate players")).toBeVisible({ timeout: 60_000 });
    const cards = page.locator("div.bg-white.rounded-xl.border-slate-200");
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    const names = await cards.locator("span.font-semibold").allInnerTexts();
    console.log(`[vets H] the rate page lists ${names.length}: ${JSON.stringify(names)}`);
    expect(names, "himself not listed").not.toContain("Shane Walton");
    expect(names).toHaveLength(14);
    // Score every card, 1 to 10 across the page.
    const n = await cards.count();
    for (let i = 0; i < n; i++) await cards.nth(i).getByRole("button", { name: String((i % 10) + 1), exact: true }).click();
    // MoM: Davide.
    await page.getByTestId("mom-vote").getByRole("button", { name: /Davide Russo/ }).click();
    // The action itself must refuse a self-rating: add one to the real request.
    const selfId = v.userId("shane");
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && req.headers()["next-action"] && (req.postData() ?? "").includes('"ratings"')) {
        const body = JSON.parse(req.postData()!) as [string, { ratings: Array<{ playerId: string; score: number }> }];
        body[1].ratings.push({ playerId: selfId, score: 10 });
        return route.continue({ postData: JSON.stringify(body) });
      }
      return route.continue();
    });
    await page.getByRole("button", { name: /submit ratings/i }).click();
    await page.waitForURL("**/profile/stats", { timeout: 60_000 });
    const rows = await db.all<{ playerId: string; score: number }>(`SELECT "playerId", score FROM "Rating" WHERE "matchId" = $1 AND "raterId" = $2`, [played, selfId]);
    console.log(`[vets H] Shane's ratings: ${JSON.stringify(rows.map((r) => r.score))}`);
    expect(rows).toHaveLength(14);
    expect(rows.some((r) => r.playerId === selfId), "self-rating refused").toBe(false);
    expect(new Set(rows.map((r) => r.score))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    const mom = await db.all<{ playerId: string }>(`SELECT "playerId" FROM "MoMVote" WHERE "matchId" = $1`, [played]);
    expect(mom.map((m) => m.playerId)).toEqual([v.userId("davide")]);

    // The winner, in the group: the scheduler's MoM post. Polled each
    // day at 10:00, 15:30 and 20:00 until the next game, to see WHEN.
    const posts: Array<Instruction & { at: string }> = [];
    for (let d = 1; d <= 6; d++) {
      const day = londonDay(new Date(lastMondayKickoff().getTime() + d * 86_400_000));
      for (const hhmm of ["10:00", "15:30", "20:00"]) {
        const { instructions } = await schedulerPoll(pool, v, london(day, hhmm));
        posts.push(...instructions.filter((i) => (i.kind === "group-message" || i.kind === "group-poll") && !/:rate-promo$/.test(i.key ?? "") && /Man of the Match/i.test(i.text ?? "")).map((i) => ({ ...i, at: `${day} ${hhmm}` })));
      }
    }
    console.log(`[vets H] MoM posts: ${JSON.stringify(posts.map((p) => [p.at, p.kind, p.text]))}`);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain("Davide Russo");
  });

  // ── I ──────────────────────────────────────────────────────────────
  scenario("I. '@Match Time make the teams' on match day: two balanced sides from the ratings", async ({ pool, db }) => {
    liveOnly();
    // Match day: tonight. The server's clock is the real one, so the
    // sandbox's fixture is moved to today's weekday at 20:30 (the Vets'
    // own time); everything else is the Vets' shape.
    const tonight = london(londonDay(new Date()), "20:30");
    scenario.skip(tonight.getTime() - Date.now() < 30 * 60_000, "needs a run before 20:00 London");
    const ratings: Record<string, number> = { davide: 7, nabz: 8, steff: 6, craig: 5, dan: 9, ben: 4, kerem: 6, steve: 7, andrew: 5, jon: 8, shane: 6, cj: 7, oumesh: 3, p12: 6 };
    const v = await vetsClub(pool, "vets", { month: "running", kickoff: tonight, seedRatings: ratings });
    await schedulerPoll(pool, v, new Date());
    const seeded = await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId]);
    expect(seeded).toBe(13);
    const inn = await say(pool, v, "p12", "IN");
    expect(inn.react).toBe("✅");

    const r = await say(pool, v, "davide", "@Match Time make the teams", { tag: true });
    console.log(`[vets I] ${JSON.stringify({ react: r.react, intent: r.intent, handledBy: r.handledBy })}\n${r.reply}\n${r.sent.map((m) => `  -> ${m.to}: ${m.text}`).join("\n")}`);
    const sheet = await db.all<{ userId: string; team: string }>(`SELECT "userId", team FROM "TeamAssignment" WHERE "matchId" = $1`, [v.matchId]);
    expect(sheet).toHaveLength(14);
    const red = sheet.filter((s) => s.team === "RED");
    const yellow = sheet.filter((s) => s.team === "YELLOW");
    expect([red.length, yellow.length]).toEqual([7, 7]);
    const keyOf = (uid: string) => v.club.group.keyOf(uid);
    const sum = (xs: typeof sheet) => xs.reduce((a, s) => a + (ratings[keyOf(s.userId)] ?? 6), 0);
    console.log(`[vets I] RED ${sum(red)} (${red.map((s) => keyOf(s.userId)).join(", ")}) v YELLOW ${sum(yellow)} (${yellow.map((s) => keyOf(s.userId)).join(", ")})`);
    // 87 rating points between 14 players: balanced is within 3 of each other.
    expect(Math.abs(sum(red) - sum(yellow))).toBeLessThanOrEqual(3);
    // The sides are posted in the group.
    const posted = [r.reply ?? "", ...r.sent.filter((m) => m.channel === "group").map((m) => m.text)].join("\n");
    expect(posted).toMatch(/Red|RED/);
    expect(posted).toMatch(/Yellow|YELLOW/);
  });

  // ── J ──────────────────────────────────────────────────────────────
  scenario("J. '@Match Time my stats': answered", async ({ pool }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    const r = await say(pool, v, "shane", "@Match Time my stats", { tag: true });
    console.log(`[vets J] ${JSON.stringify({ react: r.react, reply: r.reply, intent: r.intent, handledBy: r.handledBy, sent: r.sent })}`);
    const dms = r.sent.filter((m) => m.channel === "dm");
    expect(r.react === "📊" || !!r.reply, "answered").toBe(true);
    expect(dms.map((m) => m.to)).toEqual(["vets.shane"]);
    expect(dms[0].text).toMatch(/https?:\/\/\S+/);
  });

  // ── L ──────────────────────────────────────────────────────────────
  // The group hello (#504, group-hello.ts): built from the club's own
  // settings at the go-live instant, every claim true for the Vets.
  scenario("L. Davide says GO: the hello the group gets at go-live is the true one for a monthly, players'-MoM, pool-off, partners-off club", async ({ pool, db }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "none" });
    // The club as it stood before its GO: approved, setting up, bot off,
    // connected by Davide, and no introduction claimed yet.
    await db.run(
      `UPDATE "Organisation" SET "setupStage" = 'setting-up', "whatsappBotEnabled" = false, "liveAt" = NULL, "liveBy" = NULL,
         "approvalStatus" = 'approved', "approvedAt" = now() - interval '4 hours' WHERE id = $1`,
      [v.orgId],
    );
    await db.run(`DELETE FROM "SentNotification" WHERE key = $1`, [`org-${v.orgId}:bot-intro`]);
    await db.run(
      `INSERT INTO "ClubConnect" (id, "orgId", "userId", phone, code, status, "expiresAt", "groupId", "groupSubject", "linkedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'VTSX', 'closed', now() + interval '1 hour', $5, 'Vets MNF Sandbox', now() - interval '5 hours', now())`,
      [`sim-vets-cc-${v.orgId}`, v.orgId, v.userId("davide"), v.phone("davide"), v.club.group.groupId],
    );

    // His GO, in his own words, by DM: the one DM reader (the model) reads it.
    const go = await v.club.member("davide").dm("GO");
    console.log(`[vets L] GO: ${JSON.stringify(go.json)}\n${go.sent.map((m) => `  -> ${m.channel} ${m.to}: ${m.text.slice(0, 200).replace(/\n/g, " | ")}`).join("\n")}`);
    expect(go.json).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: v.orgId });
    const org = await db.one<{ setupStage: string; whatsappBotEnabled: boolean; liveAt: Date | null }>(
      `SELECT "setupStage", "whatsappBotEnabled", "liveAt" FROM "Organisation" WHERE id = $1`,
      [v.orgId],
    );
    expect(org).toMatchObject({ setupStage: "live", whatsappBotEnabled: true });
    expect(org?.liveAt).toBeTruthy();

    // The real post the go-live path queued: ONE group job, the hello.
    const jobs = await db.all<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'group' AND "sentAt" IS NULL`, [v.orgId]);
    expect(jobs, "one group post at go-live").toHaveLength(1);
    const hello = jobs[0].text;
    console.log(`[vets L] the hello:\n${hello}`);
    expect(go.sent.filter((m) => m.channel === "group").map((m) => m.text)).toEqual([hello]);
    // The go-live claimed the scheduler's older intro, so the group hears one hello.
    expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`org-${v.orgId}:bot-intro`])).toBe(1);

    // The opening: the organiser and the club's one game day.
    expect(hello).toContain("👋 Hi everyone, I'm *MatchTime*. Davide has set me up to help run the Monday games.");
    // A monthly club: the monthly squad lines, never the weekly routine.
    expect(hello).toContain("📋 *Monthly squad:* regulars sign up and pay for the whole month, and are in every game of it. Can't make one? Say *Out*.");
    expect(hello).toContain("✅ *Not a regular?* When a place is open, say *In* to take it. You pay for that game only.");
    expect(hello).not.toContain("*Who's in:*");
    expect(hello).not.toContain("*Drop-out deadline:*");
    expect(hello).not.toContain("*Final list:*");
    expect(hello).not.toContain("*The bench:*");
    expect(hello).not.toContain("*Match fees:*");
    expect(hello).not.toContain("Already said In for the next game?");
    // The friend line, with the organiser's way of putting a guest in.
    expect(hello).toContain("👥 *Bringing a friend:* say a friend is coming and I'll DM you a link to send them. Organisers can just say the friend's name (for example *Sam Jones is in*) and I'll add them.");
    expect(hello).toContain("⏰ *Remind me:*");
    // Ratings, updated as they come in; teams on a tag on match day.
    expect(hello).toContain("⭐ *Ratings:* the morning after each game I DM everyone who played a private link to rate the others out of 10.");
    expect(hello).toContain("updated as the ratings come in.");
    expect(hello).toContain("⚖️ *Fair teams:* on match day tag me and ask, in your own words (for example *@Match Time make the teams*)");
    // Man of the Match: the players pick on the rating link; the winner in the group.
    expect(hello).toContain("🏆 *Man of the Match:* on the same private link, pick the standout player and I'll announce the winner in the group.");
    expect(hello).not.toMatch(/quick vote in the group/i);
    // The pool and partner clubs are off here: each line kept, marked optional.
    expect(hello).toContain("🤝 *More games (optional, Davide can switch this on):*");
    expect(hello).toContain("🌍 *Partner clubs (optional, Davide can switch this on):*");
    // The month's list is the organiser's, and the closer.
    expect(hello).toContain("Davide will post the month's list as usual.");
    expect(hello.trimEnd().endsWith("I don't reply to the banter, only to In, Out or a tag. Anything else, tag me: *@Match Time help*")).toBe(true);
    expect(hello).not.toMatch(/[\u2013\u2014]/);
  });

  // ── N ──────────────────────────────────────────────────────────────
  // The week's list (Kemal, 2026-11-03): posted the morning after the last
  // game for the next one, the squad first by first name with no paid
  // marks, and again only when the squad changes. No model call: also
  // runs stubbed.
  scenario("N. the week's list: the morning after the last game, the squad first by first name, no paid marks; again only when the squad changes", async ({ pool, db }) => {
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    // Their names, as the participant sweep and Davide's "who is who" gave
    // them in scenario C.
    const sweep = await pool.request.post("/api/whatsapp/sync-participants", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { groupId: v.club.group.groupId, participants: [...v.members.keys()].map((k) => ({ phone: v.phone(k), pushname: authorOf(v, k).name })) },
    });
    expect(sweep.status(), await sweep.text()).toBe(200);
    for (const k of ["craig", "ben", "andrew", "oumesh"]) {
      await db.run(`UPDATE "User" SET name = $2 WHERE id = $1`, [v.userId(k), k.charAt(0).toUpperCase() + k.slice(1)]);
    }
    const listOf = (out: { instructions: Instruction[] }) => out.instructions.filter((i) => i.key?.startsWith(`${v.matchId}:month-list:`));

    // The night of the last game: the regulars are not on the next one yet, nothing is posted.
    const lastKick = lastMondayKickoff(new Date());
    const night = await schedulerPoll(pool, v, new Date(lastKick.getTime() + 75 * 60_000), { claim: false });
    expect(listOf(night), "nothing the night of the game").toEqual([]);

    // From 08:00 the morning after (this club has quiet hours off): the list.
    const morning = london(londonDay(new Date(lastKick.getTime() + 24 * 3_600_000)), "08:00");
    const t0 = new Date(Math.max(Date.now(), morning.getTime()) + 60_000);
    const first = listOf(await schedulerPoll(pool, v, t0));
    console.log(`[vets N] the week's list at ${formatInTimeZone(t0, LONDON, "EEE d MMM HH:mm")}:\n${first[0]?.text}`);
    expect(first).toHaveLength(1);
    const text = first[0].text ?? "";
    expectWeekListShape(text, v.kickoff, 13, 1);
    const squad = text.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(squad).toEqual(["Davide", "Nabz", "Steff", "Craig", "Dan", "Ben", "Kerem", "Steve", "Andrew", "Jon", "Shane", "CJ", "Oumesh"].map((n, i) => `${i + 1}. ${n}`));

    // Nothing changed: not posted again.
    expect(listOf(await schedulerPoll(pool, v, new Date(t0.getTime() + 31 * 60_000)))).toEqual([]);

    // Steve can't make it (as an OUT would leave his row): the list again, once.
    await db.run(
      `WITH a AS (UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2 RETURNING "matchId", "userId", position)
       INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "fromStatus", "toStatus", "toPosition", cause, "actorKind")
       SELECT $4, "matchId", "userId", $3, 'CONFIRMED', 'DROPPED', position, 'test-fixture', 'system' FROM a`,
      [v.matchId, v.userId("steve"), v.orgId, `sim-vets-n-steve-out-${v.orgId}`],
    );
    const changed = listOf(await schedulerPoll(pool, v, new Date(t0.getTime() + 62 * 60_000)));
    console.log(`[vets N] after Steve's out:\n${changed[0]?.text}`);
    expect(changed).toHaveLength(1);
    expectWeekListShape(changed[0].text ?? "", v.kickoff, 12, 2);
    expect(changed[0].text).toContain("\n\n*Can't play:*\n1. Steve\n");
    expect(changed[0].text).not.toMatch(/^8\. /m);
    expect(listOf(await schedulerPoll(pool, v, new Date(t0.getTime() + 93 * 60_000)))).toEqual([]);
  });

  // ── M ──────────────────────────────────────────────────────────────
  // The carried seed (#503, carried-seed.ts via the db.ts hook): a player
  // rated at other MatchTime clubs joins with the games-weighted average
  // of his club ratings there; one rated nowhere stays unseeded (6 shown).
  scenario("M. a player rated at two other clubs joins through the participant sync: his seed is the games-weighted average there; a player rated nowhere stays unseeded and shows 6", async ({ pool, db, page }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "none" });
    const tag = v.orgId;
    const RATED = { id: `sim-vets-rated-${tag}`, name: "Rafa Rated", phone: "447700800501" };
    const NEW = { name: "Una Unrated", phone: "447700800502" };
    const RATER = `sim-vets-rater-${tag}`;
    await db.run(`INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1, $2, $3, $4, true, true, now())`, [
      RATED.id,
      RATED.name,
      `${RATED.id}@e2e-test.invalid`,
      `+${RATED.phone}`,
    ]);
    await db.run(`INSERT INTO "User" (id, name, email, onboarded, "isActive", "updatedAt") VALUES ($1, 'Rex Rater', $2, true, true, now())`, [RATER, `${RATER}@e2e-test.invalid`]);
    // Two other clubs: Wednesday rated him 8 in each of three games, Friday
    // 4 in one. Weighted by games: (8 x 3 + 4 x 1) / 4 = 7. A plain mean of
    // the two club ratings would be 6, so the weighting is what is proven.
    const day = 86_400_000;
    for (const [club, name, scores] of [
      [`sim-vets-wed-${tag}`, "Wednesday Wanderers Sandbox", [8, 8, 8]],
      [`sim-vets-fri-${tag}`, "Friday Five Sandbox", [4]],
    ] as const) {
      await db.run(
        `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "approvalStatus", "createdAt", "updatedAt") VALUES ($1, $2, $1, $3, 'approved', now(), now())`,
        [club, name, `${club}-invite`],
      );
      await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1, $2, $3, 'PLAYER')`, [`${club}-m`, RATED.id, club]);
      await db.run(
        `INSERT INTO "Sport" (id, "orgId", name, "playersPerTeam", positions, "teamLabels", "updatedAt") VALUES ($1, $2, 'Football', 5, '{}', '{}', now())`,
        [`${club}-sport`, club],
      );
      await db.run(
        `INSERT INTO "Activity" (id, "orgId", "sportId", name, "dayOfWeek", time, venue, "updatedAt") VALUES ($1, $2, $3, 'Weekly 5s', 3, '20:00', 'Pitch', now())`,
        [`${club}-act`, club, `${club}-sport`],
      );
      for (const [i, score] of scores.entries()) {
        const match = `${club}-match-${i}`;
        const date = new Date(Date.now() - (i + 2) * 7 * day);
        await db.run(
          `INSERT INTO "Match" (id, "activityId", date, "maxPlayers", status, "attendanceDeadline", "updatedAt") VALUES ($1, $2, $3, 10, 'COMPLETED', $3, now())`,
          [match, `${club}-act`, date],
        );
        await db.run(`INSERT INTO "Rating" (id, "matchId", "raterId", "playerId", score) VALUES ($1, $2, $3, $4, $5)`, [`${match}-r`, match, RATER, RATED.id, score]);
      }
    }

    // The Pi's participant sweep sees the two new members in the group.
    const sweep = await pool.request.post("/api/whatsapp/sync-participants", {
      headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
      data: { groupId: v.club.group.groupId, participants: [{ phone: RATED.phone, pushname: "Rafa" }, { phone: NEW.phone, pushname: NEW.name }] },
    });
    expect(sweep.status(), await sweep.text()).toBe(200);
    console.log(`[vets M] the sweep: ${await sweep.text()}`);
    const seedHere = (userId: string) =>
      db.one<{ seedRating: number | null }>(`SELECT "seedRating" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [userId, v.orgId]);
    const newUser = await db.one<{ id: string }>(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [`+${NEW.phone}`]);
    expect(newUser, "the unrated joiner was created").not.toBeNull();
    const rated = await seedHere(RATED.id);
    const unrated = await seedHere(newUser!.id);
    console.log(`[vets M] seeds here: ${RATED.name} ${rated?.seedRating}, ${NEW.name} ${unrated?.seedRating}`);
    expect(rated, "his membership here").not.toBeNull();
    expect(rated!.seedRating).toBe(7);
    expect(unrated, "her membership here").not.toBeNull();
    expect(unrated!.seedRating).toBeNull();
    // His rows at the other clubs are untouched.
    expect(await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "userId" = $1 AND "orgId" <> $2 AND "seedRating" IS NOT NULL`, [RATED.id, v.orgId])).toBe(0);

    // Davide's admin players page: the Seed box shows 7 and 6, and never
    // names the clubs the seed came from.
    await page.setViewportSize({ width: 1280, height: 900 });
    await signInAs(page, v.userId("davide"), "/admin/players");
    const row = page.getByTestId(`player-row-${RATED.id}`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.locator('input[type="number"]')).toHaveValue("7");
    await expect(page.getByTestId(`player-row-${newUser!.id}`).locator('input[type="number"]')).toHaveValue("6");
    await expect(page.getByText("Wednesday Wanderers Sandbox")).toHaveCount(0);
    await expect(page.getByText("Friday Five Sandbox")).toHaveCount(0);
  });

  // ── N: a new name on the month's list, re-posted in a running month ──
  // Kemal, 2026-11-03: Davide collects the money himself (payments off) and,
  // in a running month, re-posts the month's paid list with a new line
  // ("14. Tom (paid)") or tags MatchTime ("@Match Time add Tom to the
  // November list, he's paid"). Approved behaviour (`month-newcomers.ts`):
  // the person becomes a REGULAR of the month for the games left, as
  // /admin/months "Add a player, Regular" makes him one, "says paid" as
  // written, and is on the next match's squad; the group hears nothing but
  // a ✅. A name MatchTime does not know by name is a new player with no
  // phone (or, when it could be a member with no name yet, nobody is added),
  // and Davide gets ONE DM numbering the members with no name, by phone, to
  // say who it is ("Zak is 3"). A player's re-post or request adds nobody.
  scenario.describe("N. a running month's list re-posted with a new name", () => {
    /** The first names the month's list uses for the nameless regulars. */
    const LIST_FIRST_NAMES: Record<string, string> = {
      nabz: "Nabz",
      steff: "Steff",
      craig: "Craig",
      dan: "Dan",
      ben: "Ben",
      steve: "Steve",
      andrew: "Andrew",
      jon: "Jon",
      oumesh: "Oumesh",
    };
    /**
     * The running month, last Monday played, the 13 regulars seeded on the
     * next match. `named` (default): the regulars carry the names the month's
     * start gave them, as in production after scenario C's flow (the sweep
     * names a member from his WhatsApp name, Davide's "Craig is 3" names the
     * rest). Members NOT on the month (Luca, p11 to p20) stay nameless.
     */
    const runningWeek = async (pool: Parameters<typeof vetsClub>[0], db: TestDb, opts: { named?: boolean } = {}) => {
      // The month's games left must be in the same month as last Monday's.
      scenario.skip(formatInTimeZone(lastMondayKickoff(), LONDON, "MM") !== formatInTimeZone(new Date(), LONDON, "MM"), "needs a Monday already played this month");
      const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
      if (opts.named !== false) {
        for (const [k, name] of Object.entries(LIST_FIRST_NAMES)) await db.run(`UPDATE "User" SET name = $2 WHERE id = $1`, [v.userId(k), name]);
      }
      await schedulerPoll(pool, v, new Date());
      const n = await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId]);
      expect(n, "the 13 regulars seeded").toBe(13);
      return v;
    };
    /** The month's Mondays from the next kickoff on (the games left). */
    const gamesLeft = (kickoff: Date): number => {
      let n = 0;
      for (let t = kickoff.getTime(); formatInTimeZone(new Date(t), LONDON, "MM") === formatInTimeZone(kickoff, LONDON, "MM"); t += 7 * 86_400_000) n++;
      return n;
    };
    const monthNameOf = (v: { kickoff: Date }) => formatInTimeZone(v.kickoff, LONDON, "MMMM");
    const withLine = (text: string, line: string) => `${text}\n${line}`;
    /** Luca posted in the group last week under his WhatsApp name "Luca"
     *  (the row the analyze route writes for every post). */
    const lucaPostedAsLuca = (db: TestDb, v: Awaited<ReturnType<typeof vetsClub>>) =>
      db.run(
        `INSERT INTO "AnalyzedMessage" (id, "waMessageId", "orgId", "groupId", "authorUserId", "authorName", body, "handledBy", "createdAt")
         VALUES ($1, $1, $2, $3, $4, 'Luca', 'Evening lads', 'router', now() - interval '6 days')`,
        [`sim-vets-luca-${Date.now()}`, v.orgId, v.club.group.groupId, v.userId("luca")],
      );
    /** The open "who is this?" question MatchTime stored with its DM to Davide. */
    const openQuestion = async (db: TestDb, v: Awaited<ReturnType<typeof vetsClub>>) => {
      const row = await db.one<{ text: string }>(
        `SELECT text FROM "SentNotification" WHERE kind = 'month-newcomers-ask' AND "targetUser" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
        [v.userId("davide")],
      );
      return row ? (JSON.parse(row.text) as { dm: string; names: Array<{ ref: string; name: string; userId: string | null }>; nameless: Array<{ n: number; userId: string }> }) : null;
    };
    /** The month's row and the next match's place for one player. */
    const placeOf = async (db: TestDb, v: Awaited<ReturnType<typeof vetsClub>>, userId: string) => ({
      month: await db.one<{ kind: string; leftAt: Date | null; gamesCovered: number; gamesCommitted: number | null; paidClaimedAt: Date | null }>(
        `SELECT kind, "leftAt", "gamesCovered", "gamesCommitted", "paidClaimedAt" FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
        [v.monthId, userId],
      ),
      match: await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [v.matchId, userId]),
    });

    /** Everything the bot did with one paste, printed for the report. */
    const report = async (db: TestDb, tag: string, r: Awaited<ReturnType<typeof say>>) => {
      console.log(
        `[vets ${tag}] ${JSON.stringify({ react: r.react, reply: r.reply, intent: r.intent, handledBy: r.handledBy })}\n` +
          `  as recorded: ${JSON.stringify(await analyzed(db, r.waMessageId))}\n` +
          r.sent.map((m) => `  -> ${m.channel} ${m.to}: ${m.text}`).join("\n"),
      );
    };

    /** The INTENDED outcome for the player the paste adds: a regular for the games left, on the match, on the list the group sees. */
    const expectNewRegular = async (
      pool: Parameters<typeof vetsClub>[0],
      db: TestDb,
      v: Awaited<ReturnType<typeof vetsClub>>,
      tag: string,
      userId: string | null,
      listName: RegExp,
      pastedAt: Date,
    ) => {
      expect.soft(userId, "the player the paste names").toBeTruthy();
      const mm = userId
        ? await db.one<{ kind: string; leftAt: Date | null; gamesCovered: number; source: string | null }>(
            `SELECT kind, "leftAt", "gamesCovered", source FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
            [v.monthId, userId],
          )
        : null;
      const att = userId
        ? await db.one<{ status: string; position: number | null }>(`SELECT status, position FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [v.matchId, userId])
        : null;
      console.log(`[vets ${tag}] month row: ${JSON.stringify(mm)}; attendance: ${JSON.stringify(att)}`);
      expect.soft(mm?.kind, "a regular of the month").toBe("regular");
      expect.soft(mm?.leftAt ?? null, "still on the month").toBeNull();
      expect.soft(mm?.gamesCovered, "for the games left").toBe(gamesLeft(v.kickoff));
      expect.soft(att?.status, "on the next match's squad").toBe("CONFIRMED");
      // The week's list the group sees: MatchTime's next list post (past the
      // 30-minute floor) shows him, or his own paste was the list as it now is.
      const later = await schedulerPoll(pool, v, new Date(Date.now() + 35 * 60_000));
      const post = later.instructions.find((i) => i.kind === "group-message" && (i.key ?? "").includes(":month-list:"));
      const seen = await db.one<{ kind: string; createdAt: Date }>(
        `SELECT kind, "createdAt" FROM "SentNotification" WHERE "matchId" = $1 AND key LIKE $2 ORDER BY "createdAt" DESC LIMIT 1`,
        [v.matchId, `${v.matchId}:month-list:%`],
      );
      console.log(`[vets ${tag}] the week's list after: ${post ? `posted:\n${post.text}` : `not posted; newest list row ${JSON.stringify(seen)}`}`);
      if (post) expect.soft(post.text ?? "", "the list post shows him").toMatch(listName);
      else expect.soft(seen?.kind === "month-list-seen" && seen.createdAt.getTime() >= pastedAt.getTime(), "his paste counted as the list shown").toBe(true);
    };

    // N1 = variant a
    scenario("N1. Davide re-posts the list with '14. Tom (paid)', Tom a named club member not on the month: Tom becomes a regular and is on Monday's squad", async ({ pool, db }) => {
      // Before 2026-11-03 (traced): the week's reconcile made Tom notAdded
      // "not-in-month" and Davide was DMed "I added nobody". Now an
      // organiser's line for a named club member is a "join"
      // (monthly-week-rules.ts), applied by `joinMonthAsOrganiser`.
      liveOnly();
      const v = await runningWeek(pool, db);
      const at = new Date();
      const r = await say(pool, v, "davide", withLine(monthListText(monthNameOf(v)), "14. Tom (paid)"));
      await report(db, "N1", r);
      expect.soft(r.reply, "nothing said in the group").toBeNull();
      expect.soft(r.sent.filter((m) => m.channel !== "dm"), "nothing posted in the group").toEqual([]);
      expect.soft(r.react, "a ✅ on a paste that changed something").toBe("✅");
      await expectNewRegular(pool, db, v, "N1", v.userId("tom"), /\bTom\b/, at);
    });

    // N2 = variant b
    scenario("N2. '14. Luca (paid)', Luca a nameless member (imported by phone, no name yet) who posts as 'Luca': Davide is asked by DM who Luca is, and no second Luca is created", async ({ pool, db }) => {
      // Before 2026-11-03 (traced): the reader saw only NAMED members, so
      // "Luca" was a guest and a second "Luca" was created for one game.
      // Now the reader sees members with no name, with the facts that can
      // tie a name to one: Luca posted in the group last week as "Luca"
      // (his AnalyzedMessage row, written here as the route writes it). He
      // COULD be the one, so nobody is added and Davide is asked (N8 answers).
      liveOnly();
      const v = await runningWeek(pool, db);
      await lucaPostedAsLuca(db, v);
      const at = new Date();
      const r = await say(pool, v, "davide", withLine(monthListText(monthNameOf(v)), "14. Luca (paid)"));
      await report(db, "N2", r);
      expect.soft(r.reply, "nothing said in the group").toBeNull();
      expect.soft(r.sent.filter((m) => m.channel !== "dm"), "nothing posted in the group").toEqual([]);
      const lucas = await db.all<{ id: string }>(
        `SELECT u.id FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND lower(u.name) = 'luca'`,
        [v.orgId],
      );
      console.log(`[vets N2] users named Luca at the club: ${JSON.stringify(lucas)} (the nameless member is ${v.userId("luca")})`);
      expect.soft(lucas.filter((u) => u.id !== v.userId("luca")), "no second Luca created").toEqual([]);
      // Either he is matched (the member becomes the regular), or Davide is
      // asked who Luca is, by DM, with the nameless members by phone (as the
      // month-seed DM does, month-seed-match.ts).
      const asked = r.sent.some((m) => m.channel === "dm" && m.to === "vets.davide" && /Luca/.test(m.text) && /\+44 \d{4} \d{6}/.test(m.text));
      expect.soft(asked, "Davide asked who Luca is, with the members with no name by phone").toBe(true);
      void at;
    });

    // N3 = variant c
    scenario("N3. '14. Zak (paid)', Zak nobody at the club: Zak is added as a new named player and a regular of the month", async ({ pool, db }) => {
      // Before 2026-11-03 (traced): Zak was a one-game PAYG guest with no
      // month row. Now an organiser's line for nobody (nobody brings him) is
      // a "new" player of the month, and Davide is asked by DM whether Zak
      // is one of the members with no name (N7 answers it).
      liveOnly();
      const v = await runningWeek(pool, db);
      const at = new Date();
      const r = await say(pool, v, "davide", withLine(monthListText(monthNameOf(v)), "14. Zak (paid)"));
      await report(db, "N3", r);
      expect.soft(r.reply, "nothing said in the group").toBeNull();
      expect.soft(r.sent.filter((m) => m.channel !== "dm"), "nothing posted in the group").toEqual([]);
      const zaks = await db.all<{ id: string }>(
        `SELECT u.id FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND lower(u.name) = 'zak'`,
        [v.orgId],
      );
      console.log(`[vets N3] users named Zak at the club: ${JSON.stringify(zaks)}`);
      expect.soft(zaks, "one new player, Zak").toHaveLength(1);
      await expectNewRegular(pool, db, v, "N3", zaks[0]?.id ?? null, /\bZak\b/, at);
    });

    // N5 = variant e
    scenario("N5. Davide's re-post adds '14. Tom (paid)' and moves Steve under 'Paid but can't play': Steve is out this week (told by DM), Tom is a regular and in", async ({ pool, db }) => {
      // Steve's half is the design (plan 6.2, D4): DROPPED, his "moved you
      // to 'Paid but can't play' ... Reply *IN*" DM, a ✅. Tom's half is N1's.
      liveOnly();
      const v = await runningWeek(pool, db);
      const at = new Date();
      const base = monthListText(monthNameOf(v)).replace(/\n8\. [^\n]*Steve[^\n]*/, "");
      expect(base).not.toMatch(/Steve/);
      const r = await say(pool, v, "davide", `${base}\n14. Tom (paid)\n\nPaid but can't play\nSteve (paid)`);
      await report(db, "N5", r);
      expect.soft(r.reply, "nothing said in the group").toBeNull();
      expect.soft(r.sent.filter((m) => m.channel !== "dm"), "nothing posted in the group").toEqual([]);
      expect.soft(r.react, "a ✅ on a paste that changed something").toBe("✅");
      const steve = await db.one<{ status: string }>(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [v.matchId, v.userId("steve")]);
      console.log(`[vets N5] Steve: ${JSON.stringify(steve)}`);
      expect.soft(steve?.status, "Steve out this week").toBe("DROPPED");
      expect.soft(
        r.sent.some((m) => m.channel === "dm" && m.to === "vets.steve" && /Paid but can't play/.test(m.text)),
        "Steve told, with the undo",
      ).toBe(true);
      await expectNewRegular(pool, db, v, "N5", v.userId("tom"), /\bTom\b/, at);
    });

    // N4 = variant d
    scenario("N4. a regular (Shane), not the organiser, posts the same list with '14. Tom (paid)': nobody is added; Davide is told by DM, and so is Shane; nothing in the group", async ({ pool, db }) => {
      // The design (plan 6.2 D4 as narrowed in slice 5's review, and
      // "only the organiser changes the month"): a player adds only himself.
      liveOnly();
      const v = await runningWeek(pool, db);
      const r = await say(pool, v, "shane", withLine(monthListText(monthNameOf(v)), "14. Tom (paid)"));
      await report(db, "N4", r);
      expect.soft(r.reply, "nothing said in the group").toBeNull();
      expect.soft(r.sent.filter((m) => m.channel !== "dm"), "nothing posted in the group").toEqual([]);
      expect.soft(r.react, "no ✅: nothing changed").toBeNull();
      const mm = await db.one(`SELECT kind FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`, [v.monthId, v.userId("tom")]);
      expect.soft(mm, "Tom not on the month").toBeNull();
      const att = await db.one(`SELECT status FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [v.matchId, v.userId("tom")]);
      expect.soft(att, "Tom not on the match").toBeNull();
      expect.soft(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId]), "the squad unchanged").toBe(13);
      const dms = r.sent.filter((m) => m.channel === "dm");
      expect.soft(dms.some((m) => m.to === "vets.davide" && /Tom/.test(m.text)), "the organiser told").toBe(true);
      expect.soft(dms.some((m) => m.to === "vets.shane" && /Tom/.test(m.text)), "the sender told").toBe(true);
    });

    // N6: found by the first run of N1 to N5 (2026-11-03), on regulars with no name.
    scenario("N6. a running month whose regulars have no name yet: Davide re-posts the month's list unchanged, and nobody is created, nobody added, nothing said", async ({ pool, db }) => {
      // Before 2026-11-03 (traced): the reader saw only NAMED members, so
      // the nameless regulars came back as guests, a second "Nabz" was
      // created and Davide was DMed about the rest. Now each member with no
      // name is shown with his number on the November list, and the reader
      // ties "2. Nabz" to the member at 2: the unchanged list is restated.
      liveOnly();
      const v = await runningWeek(pool, db, { named: false });
      const r = await say(pool, v, "davide", monthListText(monthNameOf(v)));
      await report(db, "N6", r);
      expect.soft(r.reply, "nothing said in the group").toBeNull();
      expect.soft(r.sent, "nothing sent at all").toEqual([]);
      expect.soft(r.react, "no ✅: nothing changed").toBeNull();
      expect.soft(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId]), "the squad unchanged").toBe(13);
      const created = await db.all<{ name: string }>(
        `SELECT u.name FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND u.email LIKE 'provisional+%'`,
        [v.orgId],
      );
      expect.soft(created, "no player created").toEqual([]);
    });

    // N7: Davide answers N3's DM. The new Zak is folded into the member.
    scenario("N7. Davide answers the who-is-this DM 'Zak is <n>': the new Zak is folded into that member (his phone kept), who is the regular, on the squad and named Zak; one Zak left", async ({ pool, db }) => {
      liveOnly();
      const v = await runningWeek(pool, db);
      const r = await say(pool, v, "davide", withLine(monthListText(monthNameOf(v)), "14. Zak (paid)"));
      await report(db, "N7", r);
      const q = await openQuestion(db, v);
      console.log(`[vets N7] the question: ${JSON.stringify(q)}`);
      expect(q?.names.map((x) => x.name), "asked about Zak").toEqual(["Zak"]);
      const newZak = q!.names[0].userId!;
      const n = q!.nameless.find((x) => x.userId === v.userId("p11"))?.n;
      expect(n, "p11 numbered in the DM").toBeTruthy();
      expect(r.sent.at(-1)?.text ?? "", "the who-is-this DM is Davide's newest").toContain(`${n}. +44 ${v.phone("p11").slice(2, 6)} ${v.phone("p11").slice(6)}`);
      const who = await v.club.member("davide").dm(`Zak is ${n}`);
      console.log(`[vets N7] his answer: ${JSON.stringify(who.json)}\n${who.sent.map((m) => `  -> ${m.to}: ${m.text}`).join("\n")}`);
      expect(who.json).toMatchObject({ handled: "month-newcomers-matched", matched: 1 });
      const member = await db.one<{ name: string | null; phoneNumber: string | null; isActive: boolean }>(`SELECT name, "phoneNumber", "isActive" FROM "User" WHERE id = $1`, [v.userId("p11")]);
      const gone = await db.one<{ isActive: boolean; phoneNumber: string | null }>(`SELECT "isActive", "phoneNumber" FROM "User" WHERE id = $1`, [newZak]);
      expect.soft(member, "the member is Zak, phone kept").toMatchObject({ name: "Zak", isActive: true, phoneNumber: `+${v.phone("p11")}` });
      expect.soft(gone?.isActive, "the provisional Zak is folded away").toBe(false);
      const p = await placeOf(db, v, v.userId("p11"));
      expect.soft(p.month?.kind, "the member is the regular").toBe("regular");
      expect.soft(p.month?.paidClaimedAt, "says paid").toBeTruthy();
      expect.soft(p.match?.status, "on the next match").toBe("CONFIRMED");
      expect.soft((await placeOf(db, v, newZak)).month, "no month row left for the provisional Zak").toBeNull();
      const zaks = await db.count(
        `SELECT COUNT(*) FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND lower(u.name) = 'zak' AND u."isActive" AND m."leftAt" IS NULL`,
        [v.orgId],
      );
      expect.soft(zaks, "one Zak").toBe(1);
      expect.soft(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId]), "14 on the match, once each").toBe(14);
    });

    // N8: Davide answers N2's DM. Nobody was added for Luca: the member joins.
    scenario("N8. Davide answers the who-is-this DM 'Luca is <n>': that member joins as the regular, says paid, on the squad, named Luca; nobody created", async ({ pool, db }) => {
      liveOnly();
      const v = await runningWeek(pool, db);
      await lucaPostedAsLuca(db, v);
      const r = await say(pool, v, "davide", withLine(monthListText(monthNameOf(v)), "14. Luca (paid)"));
      await report(db, "N8", r);
      const q = await openQuestion(db, v);
      console.log(`[vets N8] the question: ${JSON.stringify(q)}`);
      expect(q?.names, "asked about Luca, nobody added").toEqual([expect.objectContaining({ name: "Luca", userId: null })]);
      const n = q!.nameless.find((x) => x.userId === v.userId("luca"))?.n;
      expect(n).toBeTruthy();
      const who = await v.club.member("davide").dm(`Luca is number ${n}`);
      console.log(`[vets N8] his answer: ${JSON.stringify(who.json)}\n${who.sent.map((m) => `  -> ${m.to}: ${m.text}`).join("\n")}`);
      expect(who.json).toMatchObject({ handled: "month-newcomers-matched", matched: 1 });
      const p = await placeOf(db, v, v.userId("luca"));
      expect.soft(p.month?.kind, "a regular").toBe("regular");
      expect.soft(p.month?.paidClaimedAt, "says paid").toBeTruthy();
      expect.soft(p.match?.status, "on the next match").toBe("CONFIRMED");
      expect.soft((await db.one<{ name: string | null }>(`SELECT name FROM "User" WHERE id = $1`, [v.userId("luca")]))?.name, "named Luca").toBe("Luca");
      expect.soft(await db.count(`SELECT COUNT(*) FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND u.email LIKE 'provisional+%'`, [v.orgId]), "nobody created").toBe(0);
    });

    // N9 to N12: the same by a tagged request, not a re-posted list.
    scenario("N9. Davide in the players' group: '@Match Time add Tom to the <month> list, he's paid': Tom is a regular for the games left, says paid, on the squad; a ✅ and nothing said", async ({ pool, db }) => {
      liveOnly();
      const v = await runningWeek(pool, db);
      const at = new Date();
      const r = await say(pool, v, "davide", `@Match Time add Tom to the ${monthNameOf(v)} list, he's paid`, { tag: true });
      await report(db, "N9", r);
      expect.soft(r.reply, "nothing said in the group").toBeNull();
      expect.soft(r.sent.filter((m) => m.channel !== "dm"), "nothing posted in the group").toEqual([]);
      expect.soft(r.react, "a ✅").toBe("✅");
      expect.soft((await placeOf(db, v, v.userId("tom"))).month?.paidClaimedAt, "says paid").toBeTruthy();
      await expectNewRegular(pool, db, v, "N9", v.userId("tom"), /\bTom\b/, at);
    });

    scenario("N10. Davide in the organisers' group (HQ): '@Match Time add Zak to the <month> list, 2 games': a new player Zak, a regular for 2 games; HQ is answered; the numbered members only by DM", async ({ pool, db }) => {
      liveOnly();
      scenario.skip(formatInTimeZone(lastMondayKickoff(), LONDON, "MM") !== formatInTimeZone(new Date(), LONDON, "MM"), "needs a Monday already played this month");
      const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS }, hq: true });
      for (const [k, name] of Object.entries(LIST_FIRST_NAMES)) await db.run(`UPDATE "User" SET name = $2 WHERE id = $1`, [v.userId(k), name]);
      await schedulerPoll(pool, v, new Date());
      const r = await v.club.hq.say("davide", `@Match Time add Zak to the ${monthNameOf(v)} list, 2 games`, { tag: true });
      console.log(`[vets N10] HQ: ${JSON.stringify(r.json)}\n${r.sent.map((m) => `  -> ${m.channel} ${m.to}: ${m.text}`).join("\n")}`);
      const hq = r.sent.filter((m) => m.channel === "hq");
      expect.soft(hq.map((m) => m.text).join("\n"), "HQ told Zak is on the list").toMatch(/Zak is on the .* list as a regular/);
      expect.soft(hq.map((m) => m.text).join("\n"), "no phone number in HQ").not.toMatch(/\+44/);
      expect.soft(r.sent.filter((m) => m.channel === "group"), "nothing in the players' group").toEqual([]);
      expect.soft(r.sent.some((m) => m.channel === "dm" && m.to === "vets.davide" && /\+44 \d{4} \d{6}/.test(m.text)), "the members with no name, by DM to Davide").toBe(true);
      const zak = await db.one<{ id: string }>(`SELECT u.id FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."orgId" = $1 AND lower(u.name) = 'zak'`, [v.orgId]);
      const p = zak ? await placeOf(db, v, zak.id) : { month: null, match: null };
      expect.soft(p.month?.kind, "a regular").toBe("regular");
      expect.soft(p.month?.gamesCommitted, "2 games").toBe(2);
      expect.soft(p.match?.status, "on the next match").toBe("CONFIRMED");
    });

    scenario("N11. Davide by DM: 'add Tom to the <month> list, he's paid': Tom is a regular, says paid, on the squad; the answer is his DM", async ({ pool, db }) => {
      liveOnly();
      const v = await runningWeek(pool, db);
      const r = await v.club.member("davide").dm(`add Tom to the ${monthNameOf(v)} list, he's paid`);
      console.log(`[vets N11] DM: ${JSON.stringify(r.json)}\n${r.sent.map((m) => `  -> ${m.channel} ${m.to}: ${m.text}`).join("\n")}`);
      expect.soft(r.json).toMatchObject({ handled: "month-add-done" });
      expect.soft(r.sent.filter((m) => m.channel !== "dm"), "nothing in any group").toEqual([]);
      expect.soft(r.sent.find((m) => m.to === "vets.davide")?.text ?? "", "his answer").toMatch(/Tom is on the .* list as a regular/);
      const p = await placeOf(db, v, v.userId("tom"));
      expect.soft(p.month?.kind, "a regular").toBe("regular");
      expect.soft(p.month?.paidClaimedAt, "says paid").toBeTruthy();
      expect.soft(p.match?.status, "on the next match").toBe("CONFIRMED");
    });

    scenario("N12. Shane (a player, not an organiser): '@Match Time add Tom to the <month> list, he's paid': nobody is added to the month or the week; Shane is told by DM; nothing in the group", async ({ pool, db }) => {
      liveOnly();
      const v = await runningWeek(pool, db);
      const r = await say(pool, v, "shane", `@Match Time add Tom to the ${monthNameOf(v)} list, he's paid`, { tag: true });
      await report(db, "N12", r);
      expect.soft(r.reply, "nothing said in the group").toBeNull();
      expect.soft(r.sent.filter((m) => m.channel !== "dm"), "nothing posted in the group").toEqual([]);
      const p = await placeOf(db, v, v.userId("tom"));
      expect.soft(p.month, "Tom not on the month").toBeNull();
      expect.soft(p.match, "Tom not on the match").toBeNull();
      expect.soft(r.sent.some((m) => m.channel === "dm" && m.to === "vets.shane" && /Only an organiser/.test(m.text)), "Shane told").toBe(true);
    });
  });

  // ── O ──────────────────────────────────────────────────────────────
  // The Vets play one down (6 v 7). With their minimum (12), 13 of 14 the
  // day before is no "Match in trouble"; 11 of 14 is. (2026-11-03)
  scenario("O. minimum players 12: 13 of 14 the day before, no 'Match in trouble' and no 'Low numbers'; 11 of 14, the owner is warned with the minimum", async ({ pool, db }) => {
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    await db.run(`UPDATE "Activity" SET "minPlayers" = 12 WHERE "orgId" = $1`, [v.orgId]);
    // The poll after 08:00 the morning after the last game seeds the week.
    await schedulerPoll(pool, v, new Date());
    const confirmed = () => db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId]);
    expect(await confirmed()).toBe(13);
    const dayBefore = londonDay(new Date(v.kickoff.getTime() - 24 * 3_600_000));
    const nudgesAt = async (time: string, claim: boolean) => {
      const { instructions, sent } = await schedulerPoll(pool, v, london(dayBefore, time), { claim });
      const all = [...instructions.map((i) => ({ key: i.key ?? "", text: i.text ?? "" })), ...sent.map((m) => ({ key: "", text: m.text }))];
      return all.filter((i) => /cancel-nudge|switch-nudge/.test(i.key) || /Match in trouble|Low numbers/.test(i.text));
    };
    expect(await nudgesAt("10:05", false), "13 of 14 at 10:00").toEqual([]);
    expect(await nudgesAt("18:05", false), "13 of 14 at 18:00").toEqual([]);

    // Two regulars can't make it: 11 of 14, below their minimum.
    for (const k of ["steve", "jon"]) {
      await db.run(
        `WITH a AS (UPDATE "Attendance" SET status = 'DROPPED' WHERE "matchId" = $1 AND "userId" = $2 RETURNING "matchId", "userId", position)
         INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "fromStatus", "toStatus", "toPosition", cause, "actorKind")
         SELECT $4, "matchId", "userId", $3, 'CONFIRMED', 'DROPPED', position, 'test-fixture', 'system' FROM a`,
        [v.matchId, v.userId(k), v.orgId, `sim-vets-o-${k}-out-${v.orgId}`],
      );
    }
    expect(await confirmed()).toBe(11);
    const warned = await nudgesAt("18:05", true);
    console.log(`[vets O] 11 of 14, minimum 12, Sunday 18:05:\n${warned.map((w) => `  ${w.key}: ${w.text}`).join("\n")}`);
    expect(warned.length, "the owner's 'Match in trouble'").toBeGreaterThan(0);
    expect(warned[0].text).toContain("only *11* confirmed for *Football 7-a-side* tomorrow, below the minimum to play (12)");
    expect(warned[0].text).not.toMatch(/[\u2013\u2014]/);
  });

  // ── P ──────────────────────────────────────────────────────────────
  // Payment tracking and collection off (the Vets): nothing about payments
  // is sent to anyone, all week, though the month is priced and five say
  // they have paid. Kemal: "no need to DM anybody about payment reminders".
  scenario("P. payments off: a priced month with five paid claims, polled every hour for a week, sends nothing about payments; a 'paid' DM is recorded and answered with nothing", async ({ pool, db }) => {
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    await db.run(
      `UPDATE "SquadMonth" SET "sharePerGamePence" = 750, "pricedAt" = now() - interval '1 day', "listOpenedAt" = now() - interval '2 days',
         "payByAt" = now() + interval '2 days' WHERE id = $1`,
      [v.monthId],
    );
    await db.run(`UPDATE "SquadMonthMember" SET "paidAt" = NULL, "amountDuePence" = 3000 WHERE "monthId" = $1`, [v.monthId]);
    await db.run(
      `UPDATE "SquadMonthMember" SET "paidClaimedAt" = now() - interval '3 hours', "paidClaimSource" = 'dm'
        WHERE "monthId" = $1 AND "userId" = ANY($2::text[])`,
      [v.monthId, ["nabz", "craig", "dan", "ben", "kerem"].map((k) => v.userId(k))],
    );
    const PAYMENT = /💷|say they.ve paid|PAID ALL|PAID NONE|pay by|still to pay|to pay|you say you have paid|set the price|unpaid|pay link|match fee|owe/i;
    const KEYS = /:mpy:|:payment-|:unpaid-|:fee-ask|:pay-chase/;
    const seen: Array<{ at: string; key: string; to: string; text: string }> = [];
    const start = Date.now();
    for (let h = 0; h <= 7 * 24; h++) {
      const now = new Date(start + h * 3_600_000);
      const { instructions, sent } = await schedulerPoll(pool, v, now);
      const at = formatInTimeZone(now, LONDON, "EEE d MMM HH:mm");
      for (const i of instructions) seen.push({ at, key: i.key ?? "", to: i.phone ?? i.kind, text: i.text ?? "" });
      for (const m of sent) seen.push({ at, key: "", to: m.to, text: m.text });
    }
    // The week's list says what an open place costs ("1 place open, £8"):
    // that is the game, not a payment message, and it stays.
    const payment = seen.filter((m) => KEYS.test(m.key) || (PAYMENT.test(m.text) && !/:month-list:|:announce-match/.test(m.key)));
    console.log(`[vets P] ${seen.length} message(s) in a week; about payments: ${payment.length}\n${payment.map((m) => `  ${m.at} ${m.key} to ${m.to}: ${m.text.slice(0, 160).replace(/\n/g, " | ")}`).join("\n")}`);
    expect(payment, "payment messages with tracking off").toEqual([]);
    // No digest was even recorded for the collector to answer.
    expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key LIKE $1`, [`org-${v.orgId}:mpy:%`])).toBe(0);

    if (LIVE) {
      // A regular DMs "paid": the claim is recorded, and nothing is sent back.
      const paid = await v.club.member("steff").dm("Paid mate, sent it to Davide this morning");
      console.log(`[vets P] steff's "paid" DM: ${JSON.stringify({ json: paid.json, sent: paid.sent })}`);
      expect(paid.sent.filter((m) => PAYMENT.test(m.text) || /paid|noted/i.test(m.text)), "a reply about the payment").toEqual([]);
      const claim = await db.all<{ paidClaimedAt: Date | null; paidAt: Date | null }>(
        `SELECT "paidClaimedAt", "paidAt" FROM "SquadMonthMember" WHERE "monthId" = $1 AND "userId" = $2`,
        [v.monthId, v.userId("steff")],
      );
      console.log(`[vets P] steff's row: ${JSON.stringify(claim)}`);
      expect(claim[0].paidAt).toBeNull();
    }
  });

  // ── Q ──────────────────────────────────────────────────────────────
  // Davide sets the minimum by tagging MatchTime (Kemal: every admin
  // feature by WhatsApp too), through the real router and admin extractor.
  scenario("Q. '@Match Time we can play with 12' from Davide sets the game's minimum; a player's is refused; 'back to full teams' undoes it", async ({ pool, db }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    const minOf = async () => ((await db.all<{ m: number | null }>(`SELECT "minPlayers" AS m FROM "Activity" WHERE "orgId" = $1`, [v.orgId]))[0]?.m ?? null);

    const set = await say(pool, v, "davide", "@Match Time we can play with 12", { tag: true });
    console.log(`[vets Q] Davide's minimum: ${JSON.stringify({ reply: set.reply, intent: set.intent, handledBy: set.handledBy })}`);
    expect(await minOf()).toBe(12);
    expect(set.reply).toContain("is played 6 or 7 a side now (12 to 14)");

    const player = await say(pool, v, "kerem", "@Match Time minimum 10 players", { tag: true });
    console.log(`[vets Q] a player's minimum: ${JSON.stringify({ reply: player.reply, intent: player.intent })}`);
    expect(await minOf()).toBe(12);

    const back = await say(pool, v, "davide", "@Match Time back to full teams please", { tag: true });
    console.log(`[vets Q] back to full teams: ${JSON.stringify({ reply: back.reply, intent: back.intent })}`);
    expect(await minOf()).toBeNull();
    expect(back.reply).toContain("7-a-side only again");
  });

  // ── R to U: 6, 7 or 8 a side (2026-11-03, Kemal) ──────────────────────
  const rangeOf = async (db: TestDb, orgId: string) =>
    (await db.all<{ min: number | null; max: number | null }>(`SELECT "minPlayers" AS min, "maxPlayers" AS max FROM "Activity" WHERE "orgId" = $1`, [orgId]))[0];
  const placesOf = async (db: TestDb, matchId: string) =>
    (await db.all<{ m: number }>(`SELECT "maxPlayers" AS m FROM "Match" WHERE id = $1`, [matchId]))[0]?.m;
  const statusOf = async (db: TestDb, v: VetsClub, key: string) =>
    (await db.all<{ s: string }>(`SELECT status AS s FROM "Attendance" WHERE "matchId" = $1 AND "userId" = $2`, [v.matchId, v.userId(key)]))[0]?.s ?? null;
  /** The running month seeded on Monday's match: 13 regulars in 14 places. */
  const seededWeek = async (pool: Parameters<typeof vetsClub>[0], db: TestDb, range: { min: number; max: number } | null) => {
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    if (range) await db.run(`UPDATE "Activity" SET "minPlayers" = $2, "maxPlayers" = $3 WHERE "orgId" = $1`, [v.orgId, range.min, range.max]);
    await schedulerPoll(pool, v, new Date());
    expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId])).toBe(13);
    return v;
  };

  scenario("R. '@Match Time we play 12 to 16' from Davide sets the range (6, 7 or 8 a side); an odd minimum is refused (even only); a player's is refused", async ({ pool, db }) => {
    liveOnly();
    const v = await vetsClub(pool, "vets", { month: "running", played: { keys: LIST_KEYS } });
    const set = await say(pool, v, "davide", "@Match Time we play 12 to 16", { tag: true });
    console.log(`[vets R] the range: ${JSON.stringify({ reply: set.reply, intent: set.intent })}`);
    expect(await rangeOf(db, v.orgId)).toEqual({ min: 12, max: 16 });
    expect(set.reply).toContain("6, 7 or 8 a side");
    expect(set.reply).not.toMatch(/[\u2013\u2014]/);

    const odd = await say(pool, v, "davide", "@Match Time minimum 13 players", { tag: true });
    console.log(`[vets R] odd: ${JSON.stringify({ reply: odd.reply, intent: odd.intent })}`);
    expect(odd.reply).toContain("even number");
    expect(await rangeOf(db, v.orgId)).toEqual({ min: 12, max: 16 });

    const player = await say(pool, v, "kerem", "@Match Time we can play up to 18", { tag: true });
    console.log(`[vets R] a player's: ${JSON.stringify({ reply: player.reply, intent: player.intent })}`);
    expect(await rangeOf(db, v.orgId)).toEqual({ min: 12, max: 16 });
  });

  scenario("S. the bench reaches 2: MatchTime suggests 8-a-side naming Davide; a player's yes does nothing; Davide's yes switches it, the bench moves in with DMs, the new list posts", async ({ pool, db }) => {
    liveOnly();
    const v = await seededWeek(pool, db, { min: 12, max: 16 });
    // The 14th place, then two more: the squad is full and two wait.
    expect((await say(pool, v, "p12", "IN")).react).toBe("✅");
    await say(pool, v, "p15", "IN");
    const noSuggestion = (await schedulerPoll(pool, v, new Date())).instructions.filter((i) => (i.key ?? "").includes(":format-up:"));
    expect(noSuggestion, "one on the bench: no suggestion yet").toEqual([]);
    await say(pool, v, "p18", "IN");
    expect(await statusOf(db, v, "p15")).toBe("BENCH");
    expect(await statusOf(db, v, "p18")).toBe("BENCH");
    const polled = await schedulerPoll(pool, v, new Date());
    const ups = polled.instructions.filter((i) => (i.key ?? "").includes(":format-up:"));
    console.log(`[vets S] the suggestion: ${JSON.stringify(ups)}`);
    expect(ups).toHaveLength(1);
    expect(ups[0].text).toMatch(/^We've got 16 for \w+, 2 on the bench\. Shall we go 8-a-side\? Davide, reply \*yes\* to this message and I'll switch it\.$/);
    // Once per size: the next poll says nothing.
    expect((await schedulerPoll(pool, v, new Date())).instructions.filter((i) => (i.key ?? "").includes(":format-up:"))).toEqual([]);
    const quote = { text: ups[0].text!, fromMatchTime: true };

    const playersYes = await say(pool, v, "kerem", "yes", { quote });
    console.log(`[vets S] a player's yes: ${JSON.stringify({ reply: playersYes.reply, intent: playersYes.intent, handledBy: playersYes.handledBy, sent: playersYes.sent })}`);
    expect(await placesOf(db, v.matchId)).toBe(14);
    expect(playersYes.sent.filter((m) => /8-a-side/.test(m.text))).toEqual([]);

    const yes = await say(pool, v, "davide", "yes", { quote });
    console.log(`[vets S] Davide's yes: ${JSON.stringify({ reply: yes.reply, intent: yes.intent, handledBy: yes.handledBy })}\n${yes.sent.map((m) => `  -> ${m.to}: ${m.text}`).join("\n")}`);
    console.log(`[vets S] as recorded: ${JSON.stringify(await analyzed(db, yes.waMessageId))}`);
    expect(await placesOf(db, v.matchId)).toBe(16);
    expect(await statusOf(db, v, "p15")).toBe("CONFIRMED");
    expect(await statusOf(db, v, "p18")).toBe("CONFIRMED");
    expect(yes.reply).toMatch(/is 8-a-side now, 16 places\. In from the bench: /);
    const dms = yes.sent.filter((m) => m.channel === "dm");
    expect(dms.map((m) => m.to).sort()).toEqual(["vets.p15", "vets.p18"]);
    for (const d of dms) expect(d.text).toMatch(/^We're going 8-a-side on \w+, you're in\. Can't make it after all\? Reply OUT\.$/);
    const list = yes.sent.filter((m) => m.channel === "group" && m.text.startsWith("📋"));
    expect(list, "the new week's list").toHaveLength(1);
    expect(list[0].text).toMatch(/\n16\. /);
    expect(list[0].text).not.toMatch(/[\u2013\u2014]/);
  });

  scenario("T. Davide switches down: '@Match Time 6 kişilik oynayalım' makes it 12; the pay as you go player is benched before any regular, each told by DM; 9 a side is refused", async ({ pool, db }) => {
    liveOnly();
    const v = await seededWeek(pool, db, { min: 12, max: 16 });
    expect((await say(pool, v, "p12", "IN")).react).toBe("✅");

    const nine = await say(pool, v, "davide", "@Match Time make it 9 a side", { tag: true });
    console.log(`[vets T] 9 a side: ${JSON.stringify({ reply: nine.reply, intent: nine.intent })}`);
    expect(nine.reply).toContain("6, 7 or 8 a side");
    expect(await placesOf(db, v.matchId)).toBe(14);

    const down = await say(pool, v, "davide", "@Match Time 6 kişilik oynayalım", { tag: true });
    console.log(`[vets T] down: ${JSON.stringify({ reply: down.reply, intent: down.intent, handledBy: down.handledBy })}\n${down.sent.map((m) => `  -> ${m.to}: ${m.text}`).join("\n")}`);
    expect(await placesOf(db, v.matchId)).toBe(12);
    expect(await statusOf(db, v, "p12"), "the pay as you go player goes first").toBe("BENCH");
    const benched = await db.all<{ userId: string }>(`SELECT "userId" FROM "Attendance" WHERE "matchId" = $1 AND status = 'BENCH'`, [v.matchId]);
    expect(benched).toHaveLength(2);
    expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId])).toBe(12);
    const dms = down.sent.filter((m) => m.channel === "dm");
    expect(dms).toHaveLength(2);
    for (const d of dms) expect(d.text).toMatch(/^We're going 6-a-side on \w+, so the squad is down to 12 and you're on the bench for now\.$/);
    // No suggestion to undo it, though two are on the bench now.
    expect((await schedulerPoll(pool, v, new Date())).instructions.filter((i) => (i.key ?? "").includes(":format-up:"))).toEqual([]);
  });

  scenario("U. teams for 13 with a minimum of 12: '@Match Time make the teams' makes 7 against 6, balanced by rating", async ({ pool, db }) => {
    liveOnly();
    const tonight = london(londonDay(new Date()), "20:30");
    scenario.skip(tonight.getTime() - Date.now() < 30 * 60_000, "needs a run before 20:00 London");
    const ratings: Record<string, number> = { davide: 7, nabz: 8, steff: 6, craig: 5, dan: 9, ben: 4, kerem: 6, steve: 7, andrew: 5, jon: 8, shane: 6, cj: 7, oumesh: 3 };
    const v = await vetsClub(pool, "vets", { month: "running", kickoff: tonight, seedRatings: ratings });
    await db.run(`UPDATE "Activity" SET "minPlayers" = 12, "maxPlayers" = 16 WHERE "orgId" = $1`, [v.orgId]);
    await schedulerPoll(pool, v, new Date());
    expect(await db.count(`SELECT COUNT(*) FROM "Attendance" WHERE "matchId" = $1 AND status = 'CONFIRMED'`, [v.matchId])).toBe(13);

    const r = await say(pool, v, "davide", "@Match Time make the teams", { tag: true });
    console.log(`[vets U] ${JSON.stringify({ react: r.react, intent: r.intent, handledBy: r.handledBy })}\n${r.reply}`);
    const sheet = await db.all<{ userId: string; team: string }>(`SELECT "userId", team FROM "TeamAssignment" WHERE "matchId" = $1`, [v.matchId]);
    expect(sheet).toHaveLength(13);
    const red = sheet.filter((s) => s.team === "RED");
    const yellow = sheet.filter((s) => s.team === "YELLOW");
    expect([red.length, yellow.length].sort()).toEqual([6, 7]);
    const keyOf = (uid: string) => v.club.group.keyOf(uid);
    const sum = (xs: typeof sheet) => xs.reduce((a, s) => a + (ratings[keyOf(s.userId)] ?? 6), 0);
    console.log(`[vets U] RED ${sum(red)} (${red.length}) v YELLOW ${sum(yellow)} (${yellow.length})`);
    expect(Math.abs(sum(red) - sum(yellow))).toBeLessThanOrEqual(3);
    expect(r.reply ?? "").not.toMatch(/not enough|aren't enough/i);
  });
});
