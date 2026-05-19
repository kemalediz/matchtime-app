/**
 * Phase 1 gating + Sutton regression — non-destructive.
 *
 *  A) Build a synthetic MoM+rating-ONLY org (bot enabled, attendance/
 *     bench/teamBalancing/reminders/stats OFF) with a short-squad
 *     UPCOMING match. Then:
 *       - POST /analyze "IN"            → must be SILENT (att off)
 *       - POST /analyze "generate teams"→ must be SILENT (teams off)
 *       - GET  /due-posts               → must contain NO announce/
 *         evening/chase/bench/teams instructions
 *     Then wipe it.
 *  B) Sutton: assert getOrgFeatures all-on (no behaviour change) and
 *     that no onboarding session shadows its group. Read-only.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { getOrgFeatures } from "../src/lib/org-features.ts";

const API = process.env.MATCHTIME_API_URL || "https://matchtime.ai";
const KEY = process.env.WHATSAPP_API_KEY!;
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

async function post(path: string, bodyObj: unknown) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify(bodyObj),
  });
  return r.json().catch(() => ({}));
}
async function get(path: string) {
  const r = await fetch(`${API}${path}`, { headers: { "x-api-key": KEY } });
  return r.json().catch(() => ({}));
}

async function main() {
  let pass = true;
  const note = (ok: boolean, msg: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
    if (!ok) pass = false;
  };

  // ── A) gated org ────────────────────────────────────────────────
  const gid = `gate-${Date.now().toString(36)}@g.us`;
  const org = await db.organisation.create({
    data: {
      name: `Gate Test ${Date.now()}`,
      slug: `gate-test-${Date.now().toString(36)}`,
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
      sports: {
        create: {
          name: "Football 7-a-side",
          preset: "football-7aside",
          playersPerTeam: 7,
          positions: ["GK", "DEF", "MID", "FWD"],
          teamLabels: ["Red", "Yellow"],
          mvpLabel: "Man of the Match",
          balancingStrategy: "position-aware",
        },
      },
    },
    include: { sports: true },
  });
  const activity = await db.activity.create({
    data: {
      orgId: org.id,
      sportId: org.sports[0].id,
      name: "Gate Test",
      dayOfWeek: 2,
      time: "21:00",
      venue: "Test Arena",
      isActive: true,
    },
  });
  const soon = new Date(Date.now() + 36 * 60 * 60 * 1000);
  await db.match.create({
    data: {
      activityId: activity.id,
      date: soon,
      maxPlayers: 14,
      attendanceDeadline: soon,
      status: "UPCOMING",
    },
  });

  const feats = await getOrgFeatures(org.id);
  note(
    !feats.attendance && !feats.teamBalancing && !feats.bench && feats.momVoting && feats.playerRating,
    `getOrgFeatures gated org: att=${feats.attendance} teams=${feats.teamBalancing} mom=${feats.momVoting} rate=${feats.playerRating}`,
  );

  const mkMsg = (body: string) => ({
    groupId: gid,
    history: [],
    messages: [
      { waMessageId: `gate-${gid}-${Math.random().toString(36).slice(2)}`, body, authorPhone: "", authorName: "Tester", timestamp: new Date().toISOString() },
    ],
  });

  const inRes = (await post("/api/whatsapp/analyze", mkMsg("IN"))) as {
    results?: Array<{ react: string | null; reply: string | null }>;
  };
  const inSilent =
    !inRes.results || inRes.results.every((r) => !r.react && !r.reply);
  note(inSilent, `"IN" silent when attendance OFF (got ${JSON.stringify(inRes.results ?? [])})`);

  const teamRes = (await post(
    "/api/whatsapp/analyze",
    mkMsg("@MatchTime generate the teams please"),
  )) as { results?: Array<{ react: string | null; reply: string | null }> };
  const teamSilent =
    !teamRes.results || teamRes.results.every((r) => !r.react && !r.reply);
  note(teamSilent, `"generate teams" silent when teamBalancing OFF`);

  const due = (await get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(gid)}`)) as {
    instructions?: Array<{ key?: string; kind?: string }>;
  };
  const keys = (due.instructions ?? []).map((i) => i.key ?? i.kind ?? "");
  const leaked = keys.filter((k) =>
    /announce-match|evening-update|chase-|pre-kickoff|cancel-nudge|switch-nudge|football-gear-reminder|bench-prompt/.test(k),
  );
  note(
    leaked.length === 0,
    `due-posts has no attendance/bench/teams instructions (keys=${JSON.stringify(keys)})`,
  );

  // teardown A
  await db.match.deleteMany({ where: { activityId: activity.id } });
  await db.activity.deleteMany({ where: { orgId: org.id } });
  await db.sport.deleteMany({ where: { orgId: org.id } });
  await db.onboardingSession.deleteMany({ where: { whatsappGroupId: gid } });
  await db.organisation.delete({ where: { id: org.id } });

  // ── B) Sutton regression (read-only) ────────────────────────────
  const sutton = await db.organisation.findFirst({
    where: { slug: { contains: "sutton", mode: "insensitive" } },
    select: { id: true, whatsappGroupId: true },
  });
  if (sutton) {
    const sf = await getOrgFeatures(sutton.id);
    note(
      sf.botEnabled && sf.attendance && sf.bench && sf.teamBalancing && sf.momVoting && sf.playerRating && sf.reminders && sf.statsQa,
      `Sutton all features ON (att=${sf.attendance} bench=${sf.bench} teams=${sf.teamBalancing} mom=${sf.momVoting} rate=${sf.playerRating} rem=${sf.reminders} stats=${sf.statsQa})`,
    );
    const shadow = await db.onboardingSession.count({
      where: { whatsappGroupId: sutton.whatsappGroupId ?? "", stage: { in: ["collecting", "features"] } },
    });
    note(shadow === 0, `no onboarding session shadows Sutton's group (found ${shadow})`);
  } else {
    note(false, "Sutton org not found");
  }

  console.log(`\n${pass ? "ALL PASS" : "FAILURES PRESENT"}`);
  await db.$disconnect();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
