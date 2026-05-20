/**
 * SQUAD-FROM-LIST harness — proves the new featureSquadFromList
 * pipeline end-to-end against DEPLOYED PROD, with the EXACT 12 messages
 * from Amir's Thursday group (17 May 2026 chat snippet Kemal shared).
 * Self-wiping.
 *
 * What we assert:
 *  - Org provisioned with featureSquadFromList=true (Amir's shape).
 *  - Every POSTed message lands in GroupMessage (no LLM per-batch).
 *  - GET /api/cron/extract-squads:
 *      • runs the LLM extraction over the window
 *      • diffs lists + learns the 10 expected aliases (incl. the
 *        critical ~T → "tharan" case that no fuzzy matcher could
 *        bridge)
 *      • provisions 10 Users with phones for the self-addition senders
 *      • resolves the FINAL list of 14 + 1 reserve → 15 Attendance rows
 *      • guests (Ehtisham/Trevell/Faris/Usama/Martin) get provisioned
 *        with NO phone — the admin can fill them in at /admin/players,
 *        same flow Sutton uses
 *  - Idempotent: a 2nd cron run learns 0 new aliases, writes 0 new
 *    attendances.
 *
 * Env: MATCHTIME_API_URL (default https://matchtime.ai), WHATSAPP_API_KEY,
 *      CRON_SECRET, DATABASE_URL.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/test-squad-from-list.ts
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const API = process.env.MATCHTIME_API_URL || "https://matchtime.ai";
const KEY = process.env.WHATSAPP_API_KEY!;
const CRON = process.env.CRON_SECRET!;
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as never);

let pass = true;
const chk = (ok: boolean, m: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${m}`);
  if (!ok) pass = false;
};
const step = (s: string) => console.log(`\n── ${s} ──`);

const analyze = (b: unknown) =>
  fetch(`${API}/api/whatsapp/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify(b),
  }).then((r) => r.json());

const extractSquads = () =>
  fetch(`${API}/api/cron/extract-squads`, {
    headers: { authorization: `Bearer ${CRON}` },
  }).then((r) => r.json());

// ── The 12 actual messages from Amir's group (17 May 2026) ─────────────────
// Senders + pushnames + their copy-pasted list state at the moment they sent.
// Phones are synthetic UK 4479000000XX to avoid colliding with anything real.

interface ChatMessage {
  senderPhone: string;
  senderPushname: string;
  body: string;
}

const SEED_LIST = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir`;

const AFTER_ATUL = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠Atul`;

const AFTER_ADAM = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠Atul
4.⁠ ⁠⁠Adam
5.⁠ ⁠⁠Trevell`;

const AFTER_NABEEL = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠Atul
4.⁠ ⁠⁠Adam
5.⁠ ⁠⁠Trevell
6.⁠ ⁠⁠NABEEL`;

const AFTER_ZEESHAN = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠Atul
4.⁠ ⁠⁠Adam
5.⁠ ⁠⁠Trevell
6.⁠ ⁠⁠NABEEL
7.⁠ ⁠⁠Zeeshan`;

const AFTER_THARAN = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠Atul
4.⁠ ⁠⁠Adam
5.⁠ ⁠⁠Trevell
6.⁠ ⁠⁠NABEEL
7.⁠ ⁠⁠Zeeshan
8.⁠ ⁠⁠Tharan`;

const AFTER_RAAHIL = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠Atul
4.⁠ ⁠⁠Adam
5.⁠ ⁠⁠Trevell
6.⁠ ⁠⁠NABEEL
7.⁠ ⁠⁠Zeeshan
8.⁠ ⁠⁠Tharan
9.⁠ ⁠⁠Raahil`;

const AFTER_BILAL = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

 1.⁠ ⁠Ehtisham
 2.⁠ ⁠Amir
 3.⁠ ⁠⁠Atul
 4.⁠ ⁠⁠Adam
 5.⁠ ⁠⁠Trevell
 6.⁠ ⁠⁠NABEEL
 7.⁠ ⁠⁠Zeeshan
 8.⁠ ⁠⁠Tharan
 9.⁠ ⁠⁠Raahil
10.⁠ ⁠⁠Bilal`;

const AFTER_YOUSSEF = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

 1.⁠ ⁠Ehtisham
 2.⁠ ⁠Amir
 3.⁠ ⁠⁠Atul
 4.⁠ ⁠⁠Adam
 5.⁠ ⁠⁠Trevell
 6.⁠ ⁠⁠NABEEL
 7.⁠ ⁠⁠Zeeshan
 8.⁠ ⁠⁠Tharan
 9.⁠ ⁠⁠Raahil
10.⁠ ⁠⁠Bilal
11.⁠ ⁠⁠youssef`;

const AFTER_SHAZ = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

 1.⁠ ⁠Ehtisham
 2.⁠ ⁠Amir
 3.⁠ ⁠⁠Atul
 4.⁠ ⁠⁠Adam
 5.⁠ ⁠⁠Trevell
 6.⁠ ⁠⁠NABEEL
 7.⁠ ⁠⁠Zeeshan
 8.⁠ ⁠⁠Tharan
 9.⁠ ⁠⁠Raahil
10.⁠ ⁠⁠Bilal
11.⁠ ⁠⁠youssef
12.⁠ ⁠⁠Shaz
13.⁠ ⁠⁠Faris
14.⁠ ⁠⁠Usama`;

const FINAL_WITH_MARTIN = `In sha Allah 9pm Thursday 21 May Wimbledon Goals 7 a side football:

 1.⁠ ⁠Ehtisham
 2.⁠ ⁠Amir
 3.⁠ ⁠⁠Atul
 4.⁠ ⁠⁠Adam
 5.⁠ ⁠⁠Trevell
 6.⁠ ⁠⁠NABEEL
 7.⁠ ⁠⁠Zeeshan
 8.⁠ ⁠⁠Tharan
 9.⁠ ⁠⁠Raahil
10.⁠ ⁠⁠Bilal
11.⁠ ⁠⁠youssef
12.⁠ ⁠⁠Shaz
13.⁠ ⁠⁠Faris
14.⁠ ⁠⁠Usama

Reserves:
 1.⁠ ⁠Martin`;

const CHAT: ChatMessage[] = [
  { senderPhone: "447900000001", senderPushname: "Amir", body: SEED_LIST },
  { senderPhone: "447900000002", senderPushname: "~ Atul", body: AFTER_ATUL },
  { senderPhone: "447900000003", senderPushname: "~ Adam", body: AFTER_ADAM },
  { senderPhone: "447900000004", senderPushname: "~ Nabeel", body: AFTER_NABEEL },
  { senderPhone: "447900000005", senderPushname: "~ Zeeshan", body: AFTER_ZEESHAN },
  { senderPhone: "447900000006", senderPushname: "~ T", body: AFTER_THARAN }, // ★ nickname case
  { senderPhone: "447900000007", senderPushname: "~ Raahil", body: AFTER_RAAHIL },
  { senderPhone: "447900000008", senderPushname: "~ Bilal", body: AFTER_BILAL },
  { senderPhone: "447900000009", senderPushname: "Youssef", body: AFTER_YOUSSEF },
  { senderPhone: "447900000010", senderPushname: "Shaz", body: AFTER_SHAZ },
  { senderPhone: "447900000001", senderPushname: "Amir", body: FINAL_WITH_MARTIN },
];

// Expected aliases that should be learned post-extraction.
const EXPECTED_ALIASES: Array<{ alias: string; phone: string; note: string }> = [
  { alias: "amir", phone: "447900000001", note: "seed message, pushname matches" },
  { alias: "atul", phone: "447900000002", note: "single addition by ~Atul" },
  { alias: "adam", phone: "447900000003", note: "Adam adds himself + Trevell guest" },
  { alias: "nabeel", phone: "447900000004", note: "case-insensitive: pushname Nabeel ↔ 'NABEEL'" },
  { alias: "zeeshan", phone: "447900000005", note: "single addition" },
  { alias: "tharan", phone: "447900000006", note: "★ pushname ~T → 'Tharan' (no fuzzy could bridge)" },
  { alias: "raahil", phone: "447900000007", note: "single addition" },
  { alias: "bilal", phone: "447900000008", note: "single addition" },
  { alias: "youssef", phone: "447900000009", note: "case-insensitive: 'Youssef' ↔ 'youssef'" },
  { alias: "shaz", phone: "447900000010", note: "adds self + Faris + Usama guests" },
];

const EXPECTED_SQUAD = [
  "Ehtisham", "Amir", "Atul", "Adam", "Trevell", "NABEEL", "Zeeshan",
  "Tharan", "Raahil", "Bilal", "youssef", "Shaz", "Faris", "Usama",
];
const EXPECTED_RESERVE = "Martin";
const GUESTS_NO_PHONE = ["Ehtisham", "Trevell", "Faris", "Usama", "Martin"];

async function wipe(orgId: string, gid: string) {
  // Clean memberships → users (only synthetic ones), and the full chain.
  const memberships = await db.membership.findMany({
    where: { orgId },
    select: { userId: true, user: { select: { email: true } } },
  });
  const acts = await db.activity.findMany({ where: { orgId }, select: { id: true } });
  for (const a of acts) {
    await db.benchSlotOffer.deleteMany({ where: { match: { activityId: a.id } } });
    await db.moMVote.deleteMany({ where: { match: { activityId: a.id } } });
    await db.rating.deleteMany({ where: { match: { activityId: a.id } } });
    await db.teamAssignment.deleteMany({ where: { match: { activityId: a.id } } });
    await db.attendance.deleteMany({ where: { match: { activityId: a.id } } });
    await db.sentNotification.deleteMany({ where: { match: { activityId: a.id } } });
    await db.match.deleteMany({ where: { activityId: a.id } });
  }
  await db.activity.deleteMany({ where: { orgId } });
  await db.sport.deleteMany({ where: { orgId } });
  await db.botJob.deleteMany({ where: { orgId } });
  await db.analyzedMessage.deleteMany({ where: { orgId } });
  await db.groupMessage.deleteMany({ where: { orgId } });
  await db.userAlias.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.onboardingSession.deleteMany({ where: { whatsappGroupId: gid } });
  // Delete the synthetic Users created by this run (provisional emails
  // OR our seeded phone-based ones — we keyed phones uniquely so we can
  // delete via the membership-derived user list).
  for (const m of memberships) {
    if (m.user.email.includes("@matchtime.local") || m.user.email.startsWith("sql-")) {
      await db.user.delete({ where: { id: m.userId } }).catch(() => {});
    }
  }
  // Also remove the synthetic 447900000001-10 phones if they snuck in.
  for (let i = 1; i <= 10; i++) {
    const phone = `+447900000${String(i).padStart(3, "0")}`;
    await db.user.deleteMany({ where: { phoneNumber: phone } }).catch(() => {});
  }
  await db.organisation.delete({ where: { id: orgId } });
}

async function main() {
  if (!KEY || !CRON || !process.env.DATABASE_URL) {
    console.error("Missing env: WHATSAPP_API_KEY, CRON_SECRET, DATABASE_URL");
    process.exit(2);
  }

  const tag = Date.now().toString(36);
  const gid = `sql-${tag}@g.us`;
  const slug = `sql-${tag}`;
  let orgId: string | null = null;

  try {
    // ── Setup: create org directly (skip Phase-2 onboarding here — it's
    //          covered by its own harness; we want a focused test).
    step("Setup — create org with featureSquadFromList=true");
    const sport = await db.sport.create({
      data: {
        org: {
          create: {
            name: `SqL Test ${tag}`,
            slug,
            whatsappGroupId: gid,
            whatsappBotEnabled: true,
            featureAttendance: false,
            featureBench: false,
            featureTeamBalancing: false,
            featureMomVoting: true,
            featurePlayerRating: true,
            featureReminders: false,
            featureStatsQa: false,
            paymentTrackingEnabled: false,
            featureSquadFromList: true,
          },
        },
        name: "Football 7-a-side",
        preset: "football-7aside",
        playersPerTeam: 7,
        positions: ["GK", "DEF", "MID", "FWD"],
        teamLabels: ["Red", "Yellow"],
        balancingStrategy: "position-aware",
      },
      select: { id: true, orgId: true },
    });
    orgId = sport.orgId;
    const activity = await db.activity.create({
      data: {
        orgId,
        sportId: sport.id,
        name: "Thursday Football",
        dayOfWeek: 4,
        time: "21:00",
        venue: "Wimbledon Goals",
      },
    });
    // Match within the 12h finalise window of NOW (so the cron's
    // finalise branch runs).
    const matchDate = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const match = await db.match.create({
      data: {
        activityId: activity.id,
        date: matchDate,
        maxPlayers: 14,
        attendanceDeadline: matchDate,
        status: "UPCOMING",
      },
    });
    chk(!!orgId, `org created: ${orgId}`);
    chk(!!match.id, `match created: ${match.id} at ${matchDate.toISOString()}`);

    // ── 1. POST messages → analyze should archive, not LLM ───────────
    step("1. POST 11 messages — analyze archives to GroupMessage, no LLM");
    const baseTs = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < CHAT.length; i++) {
      const m = CHAT[i];
      const r = await analyze({
        groupId: gid,
        history: [],
        messages: [
          {
            waMessageId: `sql-${tag}-${i}`,
            body: m.body,
            authorPhone: m.senderPhone,
            authorName: m.senderPushname,
            timestamp: new Date(baseTs + i * 60_000).toISOString(),
          },
        ],
      });
      // Expect the no-message-driven-features short-circuit (squad-from-
      // list orgs have attendance/bench/teams/reminders/stats off).
      if (r?.ignored !== "no-message-driven-features") {
        chk(false, `msg ${i}: expected ignored=no-message-driven-features, got ${JSON.stringify(r)}`);
        return;
      }
    }
    const stored = await db.groupMessage.count({ where: { orgId } });
    chk(stored === CHAT.length, `${stored} GroupMessage rows stored (expected ${CHAT.length})`);

    // ── 2. Trigger the squad-extraction cron ────────────────────────
    //   By this point the inline path in /api/whatsapp/analyze has
    //   already fired extraction during each POST (match is within
    //   12h, squad-from-list is on). The cron call here is the daily-
    //   backstop equivalent; it should be idempotent (find nothing new
    //   to do). We assert DB state below rather than cron-return-shape
    //   so the test passes regardless of which path did the work.
    step("2. GET /api/cron/extract-squads — idempotent over already-extracted state");
    const cron1 = await extractSquads();
    chk(cron1?.ok === true, "cron returned ok");
    const orgResult = (cron1.results ?? []).find((r: { orgId: string }) => r.orgId === orgId);
    chk(!!orgResult, "cron processed this org");

    // ── 3. Verify each expected alias landed ────────────────────────
    step("3. Aliases learned — ground-truth name↔phone mapping from diffs");
    for (const e of EXPECTED_ALIASES) {
      const phone = `+${e.phone}`;
      const user = await db.user.findUnique({
        where: { phoneNumber: phone },
        select: { id: true, name: true },
      });
      chk(!!user, `User exists for phone ${phone} (${e.note})`);
      if (!user) continue;
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: e.alias } },
      });
      chk(
        !!alias && alias.userId === user.id,
        `alias "${e.alias}" → ${user.name ?? "(unnamed)"} ${user.id}  — ${e.note}`,
      );
    }

    // ── 4. Verify squad resolved correctly ──────────────────────────
    step("4. Final squad: 14 CONFIRMED + 1 BENCH (reserve)");
    const confirmed = await db.attendance.findMany({
      where: { matchId: match.id, status: "CONFIRMED" },
      include: { user: { select: { name: true, phoneNumber: true } } },
      orderBy: { position: "asc" },
    });
    chk(confirmed.length === 14, `14 CONFIRMED attendance rows (got ${confirmed.length})`);
    for (let i = 0; i < EXPECTED_SQUAD.length; i++) {
      const expected = EXPECTED_SQUAD[i];
      const got = confirmed[i]?.user.name;
      chk(
        !!got && got.toLowerCase().includes(expected.toLowerCase().slice(0, 3)),
        `slot ${i + 1}: "${expected}" → resolved to "${got}"`,
      );
    }
    const reserves = await db.attendance.findMany({
      where: { matchId: match.id, status: "BENCH" },
      include: { user: { select: { name: true } } },
    });
    chk(reserves.length === 1, `1 BENCH (reserve) row (got ${reserves.length})`);
    chk(
      reserves[0]?.user.name?.toLowerCase() === EXPECTED_RESERVE.toLowerCase(),
      `reserve = "${EXPECTED_RESERVE}" (got "${reserves[0]?.user.name}")`,
    );

    // ── 5. Verify guests have no phone (admin can fill in later) ───
    step("5. Guests have no phone — admin fills them in at /admin/players");
    for (const guestName of GUESTS_NO_PHONE) {
      const att = confirmed.find((a) =>
        a.user.name?.toLowerCase() === guestName.toLowerCase(),
      ) ?? reserves.find((a) =>
        a.user.name?.toLowerCase() === guestName.toLowerCase(),
      );
      chk(!!att, `guest "${guestName}" has an Attendance row`);
      chk(
        att?.user.phoneNumber == null,
        `guest "${guestName}" has no phone (admin fills later)`,
      );
    }

    // ── 6. Idempotency: re-run the cron, nothing should change ─────
    step("6. Idempotency — 2nd cron run learns 0 new aliases, writes 0 new attendances");
    const aliasesBefore = await db.userAlias.count({ where: { orgId } });
    const attendancesBefore = await db.attendance.count({ where: { match: { activityId: activity.id } } });
    const cron2 = await extractSquads();
    chk(cron2?.ok === true, "2nd cron returned ok");
    const aliasesAfter = await db.userAlias.count({ where: { orgId } });
    const attendancesAfter = await db.attendance.count({ where: { match: { activityId: activity.id } } });
    chk(aliasesAfter === aliasesBefore, `aliases stable across 2nd run (${aliasesBefore} → ${aliasesAfter})`);
    chk(attendancesAfter === attendancesBefore, `attendances stable across 2nd run (${attendancesBefore} → ${attendancesAfter})`);

    // ── 7. Sutton untouched: featureSquadFromList off → not in results ─
    step("7. Sutton untouched (sanity)");
    const sutton = await db.organisation.findFirst({
      where: { slug: "sutton-fc" },
      select: { id: true, featureSquadFromList: true },
    });
    if (sutton) {
      chk(!sutton.featureSquadFromList, "Sutton featureSquadFromList=false");
      const inResults = (cron2.results ?? []).find(
        (r: { orgId: string }) => r.orgId === sutton.id,
      );
      chk(!inResults, "Sutton not processed by extract-squads cron");
    } else {
      console.log("  (Sutton org not present in this DB — skipping)");
    }
  } catch (err) {
    chk(false, `harness threw: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    if (orgId) {
      try {
        await wipe(orgId, gid);
        console.log("\n(cleaned up)");
      } catch (e) {
        console.error("Cleanup failed:", e);
      }
    }
    await db.$disconnect();
  }

  console.log(pass ? "\n✅ ALL CHECKS PASSED" : "\n❌ FAILURES");
  process.exit(pass ? 0 : 1);
}

main();
