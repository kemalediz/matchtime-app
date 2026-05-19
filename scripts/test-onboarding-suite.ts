/**
 * Onboarding QA suite — drives many scenarios through the DEPLOYED
 * /api/whatsapp/analyze, asserts the resulting org/activity/feature
 * flags, prints PASS/FAIL, and wipes each synthetic org. Run:
 *   node --env-file=.env --import tsx scripts/test-onboarding-suite.ts
 *   node --env-file=.env --import tsx scripts/test-onboarding-suite.ts happy_basic   # one scenario
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const API = process.env.MATCHTIME_API_URL || "https://matchtime.ai";
const KEY = process.env.WHATSAPP_API_KEY!;
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as any);

interface Scenario {
  name: string;
  messages: string[];
  expect?: {
    playersPerSide?: number;
    dayOfWeek?: number;
    time?: string;
    venueIncludes?: string;
    activeWeekly?: boolean;
    features?: Partial<Record<string, boolean>>;
  };
  /** A substring expected somewhere in the bot's replies (for
   *  behaviour tests that don't necessarily complete). */
  expectReplyContains?: string;
  /** True if the scenario is expected NOT to create an org. */
  expectNoOrg?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: "happy_basic",
    messages: [
      "@MatchTime setup",
      "we're Test FC One",
      "7 a side",
      "thursdays",
      "8:30pm",
      "PowerLeague Shoreditch",
      "every week",
      "just Man of the Match and player ratings please",
    ],
    expect: {
      playersPerSide: 7,
      dayOfWeek: 4,
      time: "20:30",
      venueIncludes: "Shoreditch",
      activeWeekly: true,
      features: {
        featureMomVoting: true,
        featurePlayerRating: true,
        featureAttendance: false,
        featureBench: false,
        featureTeamBalancing: false,
        featureReminders: false,
        featureStatsQa: false,
        paymentTrackingEnabled: false,
      },
    },
  },
  {
    name: "everything",
    messages: [
      "@MatchTime setup",
      "Test FC Two",
      "5 a side",
      "mondays",
      "7pm",
      "Goals Chingford",
      "weekly",
      "give us everything",
    ],
    expect: {
      playersPerSide: 5,
      dayOfWeek: 1,
      time: "19:00",
      features: {
        featureAttendance: true,
        featureBench: true,
        featureTeamBalancing: true,
        featureMomVoting: true,
        featurePlayerRating: true,
        featureReminders: true,
        featureStatsQa: true,
        paymentTrackingEnabled: true,
      },
    },
  },
  {
    name: "except_payments",
    messages: [
      "@MatchTime setup",
      "Test FC Three",
      "7 a side",
      "saturdays",
      "10am",
      "Hackney Marshes",
      "every week",
      "everything except payments",
    ],
    expect: {
      dayOfWeek: 6,
      time: "10:00",
      features: { featureAttendance: true, featureMomVoting: true, paymentTrackingEnabled: false },
    },
  },
  {
    name: "multifield_one_message",
    messages: [
      "@MatchTime setup",
      "We're Test FC Four, we play 7 a side on Wednesdays at 9pm at Powerleague Tooting, every week",
      "MoM and ratings only",
    ],
    expect: {
      playersPerSide: 7,
      dayOfWeek: 3,
      time: "21:00",
      venueIncludes: "Tooting",
      features: { featureMomVoting: true, featurePlayerRating: true, featureAttendance: false },
    },
  },
  {
    name: "mid_flow_correction",
    messages: [
      "@MatchTime setup",
      "Test FC Five",
      "5 a side",
      "actually make it 7 a side",
      "tuesdays",
      "8pm",
      "Goals Star City",
      "weekly",
      "all features",
    ],
    expect: { playersPerSide: 7, dayOfWeek: 2, time: "20:00", features: { featureAttendance: true } },
  },
  {
    name: "chitchat_between",
    messages: [
      "@MatchTime setup",
      "Test FC Six",
      "lol who added this bot",
      "7 a side",
      "haha ok",
      "fridays",
      "6:30pm",
      "Wembley powerleague",
      "weekly",
      "just MoM please",
    ],
    expect: {
      dayOfWeek: 5,
      time: "18:30",
      features: { featureMomVoting: true, featurePlayerRating: false },
    },
  },
  {
    name: "numbered_feature_pick",
    messages: [
      "@MatchTime setup",
      "Test FC Seven",
      "7 a side",
      "sundays",
      "11am",
      "Hackney Marshes pitch 3",
      "weekly",
      "options 4 and 5",
    ],
    expect: { features: { featureMomVoting: true, featurePlayerRating: true, featureAttendance: false } },
  },
];

async function runScenario(s: Scenario): Promise<boolean> {
  const groupId = `qa-${s.name}-${Date.now().toString(36)}@g.us`;
  let seq = 0;
  const replies: string[] = [];
  for (const body of s.messages) {
    const res = await fetch(`${API}/api/whatsapp/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({
        groupId,
        history: [],
        messages: [
          {
            waMessageId: `qa-${groupId}-${seq++}`,
            body,
            authorPhone: "",
            authorName: "QA",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      results?: Array<{ reply: string | null }>;
    };
    const r = j.results?.find((x) => x.reply)?.reply ?? null;
    if (r) replies.push(r);
    await new Promise((x) => setTimeout(x, 700));
  }

  let pass = true;
  const notes: string[] = [];

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId },
    include: { activities: { include: { matches: true } } },
  });

  if (s.expectNoOrg) {
    if (org) { pass = false; notes.push("expected NO org but one was created"); }
  } else if (s.expect) {
    if (!org) {
      pass = false;
      notes.push("no org created; last reply: " + (replies[replies.length - 1] ?? "(none)"));
    } else {
      const e = s.expect;
      const act = org.activities[0];
      if (e.playersPerSide != null) {
        const sport = await db.sport.findFirst({ where: { orgId: org.id } });
        if (sport?.playersPerTeam !== e.playersPerSide)
          (pass = false), notes.push(`playersPerSide ${sport?.playersPerTeam} ≠ ${e.playersPerSide}`);
      }
      if (e.dayOfWeek != null && act?.dayOfWeek !== e.dayOfWeek)
        (pass = false), notes.push(`dayOfWeek ${act?.dayOfWeek} ≠ ${e.dayOfWeek}`);
      if (e.time && act?.time !== e.time)
        (pass = false), notes.push(`time ${act?.time} ≠ ${e.time}`);
      if (e.venueIncludes && !(act?.venue ?? "").toLowerCase().includes(e.venueIncludes.toLowerCase()))
        (pass = false), notes.push(`venue "${act?.venue}" !includes "${e.venueIncludes}"`);
      if (e.activeWeekly != null && act?.isActive !== e.activeWeekly)
        (pass = false), notes.push(`activeWeekly ${act?.isActive} ≠ ${e.activeWeekly}`);
      if (act && act.matches.length === 0)
        (pass = false), notes.push("no first match created");
      for (const [k, v] of Object.entries(e.features ?? {})) {
        if ((org as Record<string, unknown>)[k] !== v)
          (pass = false), notes.push(`${k}=${(org as Record<string, unknown>)[k]} ≠ ${v}`);
      }
    }
  }
  if (s.expectReplyContains && !replies.some((r) => r.includes(s.expectReplyContains!)))
    (pass = false), notes.push(`no reply contained "${s.expectReplyContains}"`);

  // Teardown.
  if (org) {
    for (const a of org.activities) await db.match.deleteMany({ where: { activityId: a.id } });
    await db.activity.deleteMany({ where: { orgId: org.id } });
    await db.sport.deleteMany({ where: { orgId: org.id } });
    await db.membership.deleteMany({ where: { orgId: org.id } });
    await db.organisation.delete({ where: { id: org.id } });
  }
  await db.onboardingSession.deleteMany({ where: { whatsappGroupId: groupId } });

  console.log(`${pass ? "PASS" : "FAIL"}  ${s.name}${notes.length ? "  — " + notes.join("; ") : ""}`);
  return pass;
}

async function main() {
  const only = process.argv[2];
  const list = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
  let passed = 0;
  for (const s of list) {
    try {
      if (await runScenario(s)) passed++;
    } catch (e) {
      console.log(`FAIL  ${s.name}  — threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${passed}/${list.length} passed`);
  await db.$disconnect();
  process.exit(passed === list.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
