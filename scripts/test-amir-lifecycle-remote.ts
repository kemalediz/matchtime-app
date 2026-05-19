/**
 * AMIR DRESS-REHEARSAL — full lifecycle of the 2nd-group (MoM + player
 * ratings ONLY) request, end-to-end against DEPLOYED PROD, with a
 * throwaway synthetic WhatsApp group. Proves it works BEFORE the bot
 * ever joins Amir's real Thursday group. Self-wiping.
 *
 * Stages (each drives the SAME prod endpoints the Pi/cron call):
 *  1. Onboarding — "@MatchTime setup" → 7-turn in-group Q&A via
 *     POST /api/whatsapp/analyze. Assert the org provisions with
 *     EXACTLY momVoting + playerRating on, everything else off,
 *     whatsappBotEnabled=true, and a Sport/Activity/Match created.
 *  2. Zero-LLM skip — a normal chat message, an attendance message,
 *     and a teams message all return ignored="no-message-driven-
 *     features" (so the Sonnet bill for this group is ~£0 AND
 *     attendance/bench/teams stay silent).
 *  3. Auto-complete teamless match — a past, team-less match flips to
 *     COMPLETED via GET /api/cron/generate-teams (the fix that makes
 *     Amir's post-match flow reachable at all).
 *  4. Post-match feature gate — GET /api/whatsapp/due-posts for the
 *     completed match: the post-match flow IS reachable (ask-score
 *     fires) and NOTHING attendance / bench / teams / payment leaks.
 *
 * Note on MoM-poll / rating-DM emission: those are wall-clock gated
 * (rating DMs 08:00-09:00 the morning after; MoM announce +5d 15:00
 * London) so they can't be force-asserted at an arbitrary run time.
 * Stage 4 instead proves the machinery is wired + correctly
 * feature-gated; the time-gated copy is exercised by the unit suites.
 *
 * Env: MATCHTIME_API_URL (default https://matchtime.ai), WHATSAPP_API_KEY,
 *      CRON_SECRET, DATABASE_URL.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const API = process.env.MATCHTIME_API_URL || "https://matchtime.ai";
const KEY = process.env.WHATSAPP_API_KEY!;
const CRON = process.env.CRON_SECRET!;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } as any);

let pass = true;
const chk = (ok: boolean, m: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${m}`); if (!ok) pass = false; };
const step = (s: string) => console.log(`\n── ${s} ──`);

const analyze = (b: unknown) =>
  fetch(`${API}/api/whatsapp/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify(b),
  }).then((r) => r.json());

const duePosts = (gid: string) =>
  fetch(`${API}/api/whatsapp/due-posts?groupId=${encodeURIComponent(gid)}`, {
    headers: { "x-api-key": KEY },
  }).then((r) => r.json());

const runGenerateTeams = () =>
  fetch(`${API}/api/cron/generate-teams`, {
    headers: { authorization: `Bearer ${CRON}` },
  }).then((r) => r.json());

const batch = (gid: string, body: string) => ({
  groupId: gid,
  history: [],
  messages: [{
    waMessageId: `amir-${gid}-${Math.random().toString(36).slice(2)}`,
    body,
    authorPhone: "",
    authorName: "Amir",
    timestamp: new Date().toISOString(),
  }],
});

/** Drive one onboarding turn, return the bot's group reply (or null). */
async function turn(gid: string, body: string): Promise<string | null> {
  const r = await analyze(batch(gid, body));
  const reply = r?.results?.[0]?.reply ?? null;
  console.log(`  >> ${JSON.stringify(body)}`);
  console.log(`  << ${reply ? JSON.stringify(reply.slice(0, 90)) + "…" : "(silent)"}`);
  return reply;
}

async function wipe(orgId: string, gid: string) {
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
  await db.onboardingSession.deleteMany({ where: { whatsappGroupId: gid } });
  await db.user.deleteMany({ where: { email: { startsWith: `amir-rh-` } } });
  await db.organisation.delete({ where: { id: orgId } });
}

async function main() {
  const tag = Date.now().toString(36);
  const gid = `amir-rh-${tag}@g.us`;
  let orgId: string | null = null;

  try {
    // ── 1. ONBOARDING ────────────────────────────────────────────────
    step("1. Onboarding — @MatchTime setup → in-group Q&A");
    const t1 = await turn(gid, "@MatchTime setup");
    chk(!!t1 && /I'm MatchTime|automatic organiser/i.test(t1 || ""), "first reply self-introduces MatchTime");
    chk(
      !!t1 && /attendance/i.test(t1!) && /man of the match/i.test(t1!) &&
        /bench/i.test(t1!) && /rating/i.test(t1!),
      "intro sells the core features (attendance / teams / bench / MoM / ratings)",
    );
    chk(!!t1 && /call your club|what should I call/i.test(t1 || ""), "intro then asks the first setup question (club name)");
    await turn(gid, "Amir FC");
    await turn(gid, "7 a side");
    await turn(gid, "Thursdays");
    await turn(gid, "9:30pm");
    await turn(gid, "Goals Star City");
    const tFeat = await turn(gid, "weekly");
    chk(!!tFeat && /feature/i.test(tFeat), "all event details gathered → feature menu shown");
    const tDone = await turn(gid, "Just Man of the Match and player ratings please");
    chk(!!tDone && /all set|running/i.test(tDone), "feature pick completes onboarding");

    const org = await db.organisation.findFirst({
      where: { whatsappGroupId: gid },
      include: { sports: true, activities: { include: { matches: true } } },
    });
    chk(!!org, "Organisation provisioned");
    if (!org) throw new Error("no org provisioned — abort");
    orgId = org.id;

    chk(org.whatsappBotEnabled === true, "bot enabled after completion");
    chk(org.featureMomVoting === true, "featureMomVoting = ON");
    chk(org.featurePlayerRating === true, "featurePlayerRating = ON");
    chk(
      org.featureAttendance === false && org.featureBench === false &&
      org.featureTeamBalancing === false && org.featureReminders === false &&
      org.featureStatsQa === false && org.paymentTrackingEnabled === false,
      "every other feature OFF (attendance/bench/teams/reminders/stats/payments)",
    );
    chk(org.sports.length === 1 && org.sports[0].playersPerTeam === 7, "Sport created (7-a-side)");
    chk(
      org.activities.length === 1 && org.activities[0].dayOfWeek === 4 &&
      org.activities[0].time === "21:30",
      "Activity created (Thursday 21:30)",
    );
    chk(
      org.activities[0]?.matches.length === 1 && org.activities[0].matches[0].status === "UPCOMING",
      "first (future) match created UPCOMING",
    );

    // ── 2. ZERO-LLM SKIP ─────────────────────────────────────────────
    step("2. Zero-LLM skip — chat / attendance / teams all ignored");
    for (const [label, text] of [
      ["normal chat", "haha good game last week lads 😂"],
      ["attendance", "I'm in for Thursday, count me in 👍"],
      ["teams request", "@MatchTime can you sort the teams and put me on bench"],
    ] as const) {
      const r = await analyze(batch(gid, text));
      chk(
        r?.ignored === "no-message-driven-features" && (r?.results?.length ?? 0) === 0,
        `${label}: skipped before LLM (ignored=${r?.ignored})`,
      );
    }

    // ── 3. AUTO-COMPLETE A TEAMLESS PAST MATCH ───────────────────────
    step("3. Auto-complete a past, team-less match via generate-teams cron");
    const activityId = org.activities[0].id;
    const sportId = org.sports[0].id;
    const past = new Date(Date.now() - 150 * 60 * 1000); // 2.5h ago (>kickoff+60+60)
    const pm = await db.match.create({
      data: {
        activityId, date: past, maxPlayers: 14,
        attendanceDeadline: past, status: "UPCOMING",
      },
    });
    // Two confirmed players — proves attendance data EXISTS yet still
    // produces zero attendance/bench output (pure feature gate).
    for (let i = 0; i < 2; i++) {
      const u = await db.user.create({
        data: {
          name: `RH P${i}`, email: `amir-rh-${tag}-${i}@matchtime.local`,
          phoneNumber: `+44777${tag.slice(-5)}${i}`,
        },
      });
      await db.attendance.create({ data: { matchId: pm.id, userId: u.id, status: "CONFIRMED", position: i + 1 } });
    }
    const cron = await runGenerateTeams();
    console.log(`  cron → ${JSON.stringify(cron)}`);
    const pmAfter = await db.match.findUnique({ where: { id: pm.id }, select: { status: true } });
    chk(pmAfter?.status === "COMPLETED", `teamless past match auto-completed (status=${pmAfter?.status})`);
    const teams = await db.teamAssignment.count({ where: { matchId: pm.id } });
    chk(teams === 0, `no teams generated for it (got ${teams}) — teamBalancing stays off`);

    // ── 4. POST-MATCH FEATURE GATE ───────────────────────────────────
    step("4. due-posts for the completed match — flow reachable, nothing leaks");
    const dp = await duePosts(gid);
    const instr: Array<{ kind: string; key: string }> = dp?.instructions ?? [];
    console.log(`  instructions: ${JSON.stringify(instr.map((i) => i.key))}`);
    const keyOf = (k: string) => (k.includes(":") ? k.slice(k.indexOf(":") + 1) : k);
    const segs = instr.map((i) => keyOf(i.key));

    chk(
      segs.some((s) => s.startsWith("ask-score")),
      "post-match flow REACHABLE — ask-score fires for the completed match",
    );
    chk(
      !segs.some((s) => s.startsWith("payment-")),
      "NO payment poll (paymentTracking off)",
    );
    chk(
      !segs.some((s) =>
        s.startsWith("announce-match") || s.startsWith("evening-update") ||
        s.startsWith("chase-") || s.startsWith("pre-kickoff") ||
        s.startsWith("cancel-nudge") || s.startsWith("switch-nudge") ||
        s.startsWith("football-gear-reminder"),
      ),
      "NO attendance-driven posts (attendance off)",
    );
    chk(
      !instr.some((i) => i.kind === "bench-prompt") && !segs.some((s) => s.startsWith("bench-prompt")),
      "NO bench prompts (bench off)",
    );
    chk(
      !instr.some((i) => /team/i.test(i.kind)),
      "NO team-assignment posts (teamBalancing off)",
    );
  } finally {
    if (orgId) {
      step("Cleanup");
      await wipe(orgId, gid);
      console.log("  synthetic org wiped");
    }
    await db.$disconnect();
  }

  console.log(`\n${pass ? "✅ ALL PASS — Amir's group is safe to onboard" : "❌ FAILURES — DO NOT onboard yet"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
