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
} from "./world";

const COST_FILE = path.join(REPO_ROOT, ".e2e", "vets-sandbox-cost.jsonl");
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

    // The next scheduler poll seeds the regulars onto Monday's match.
    await schedulerPoll(pool, v, new Date());
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
  scenario("H. after a game: rating DMs the morning after to the confirmed players with phones; a rating through the real page (1 to 10, self refused); MoM picked on the link; the winner announced in the group", async ({ pool, db, page }) => {
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
    for (const hhmm of ["06:00", "07:00", "07:30", "08:00", "08:30", "09:00", "10:00", "11:00", "12:00"]) {
      const at = london(morning, hhmm);
      const { instructions } = await schedulerPoll(pool, v, at);
      for (const i of instructions.filter((x) => x.kind === "dm" && /rate|rating/i.test(`${x.key ?? ""} ${x.text ?? ""}`))) rateDms.push({ at: hhmm, to: i.phone ?? i.targetUser ?? "?", text: i.text ?? "" });
    }
    console.log(`[vets H] rating DMs: ${rateDms.length} at ${[...new Set(rateDms.map((d) => d.at))].join(", ")}\n  first: ${rateDms[0]?.text}`);
    expect(rateDms).toHaveLength(confirmedWithPhone);
    expect(Number(rateDms[0].at.slice(0, 2))).toBeGreaterThanOrEqual(8);
    const phones = new Set(rateDms.map((d) => d.to));
    for (const k of [...LIST_KEYS, "p12"]) expect(phones.has(v.phone(k)), k).toBe(true);

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
        posts.push(...instructions.filter((i) => (i.kind === "group-message" || i.kind === "group-poll") && /Man of the Match/i.test(i.text ?? "")).map((i) => ({ ...i, at: `${day} ${hhmm}` })));
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
});
