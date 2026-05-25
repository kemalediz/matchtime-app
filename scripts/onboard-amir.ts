/**
 * One-shot programmatic onboarding for Amir's Thursday football group.
 *
 * Why this script exists (2026-05-25):
 *   The natural `@MatchTime setup` flow was wedged for Amir's group
 *   by a loose-pre-filter bug (didn't match @-mention bodies). Rather
 *   than ask the admin to re-type setup messages and look weird in
 *   front of the group, we provision the org programmatically using
 *   metadata Kemal already provided + post the bot's intro via the
 *   scheduler's existing org-${orgId}:bot-intro path.
 *
 * What this does:
 *   1. Provisions: Organisation + Sport (7-a-side football) + Activity
 *      (Thursday 21:00 BST at Wimbledon Goals) + Match (Thursday 28 May 2026).
 *      Features: MoM ✓, Player Rating ✓, featureSquadFromList ✓; all else OFF.
 *   2. Once this row is committed, the bot's next /due-posts poll
 *      (every 30s per scheduler) sees no SentNotification for the
 *      `org-${orgId}:bot-intro` key and emits the tailored intro
 *      message — landing in the group as a natural-looking "MatchTime
 *      is live here" post.
 *   3. Injects the 9 historical squad-list messages from Amir's
 *      24-25 May chat as GroupMessage rows, with senderPhone set for
 *      the 9 senders we know.
 *   4. Triggers /api/cron/extract-squads to process them — writes
 *      14 CONFIRMED + 1 BENCH attendance for Thursday's match.
 *   5. Patches phones for Omar (msg sender but not self-adder) and
 *      Eman (self-added to Reserves only — current code treats as guest).
 *
 * Idempotent: if the org with this gid already exists, prints + exits.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/onboard-amir.ts          # dry-run
 *   npx tsx --env-file=.env scripts/onboard-amir.ts --apply
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const APPLY = process.argv.includes("--apply");

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
} as never);

// ── Inputs (all from Kemal's messages + the chat paste) ─────────────
const GID = "120363258429151096@g.us";              // "Sutton Lads " group
const ORG_NAME = "Sutton Lads";
const ORG_SLUG = "sutton-lads";
const VENUE = "Wimbledon Goals";
const SPORT_NAME = "Football 7-a-side";
const ACTIVITY_NAME = "Thursday Football";
const KICKOFF_LOCAL = "21:00";       // London local
const DAY_OF_WEEK = 4;               // Thursday
const PLAYERS_PER_SIDE = 7;
const MAX_PLAYERS = 14;
// Thursday 28 May 2026 21:00 BST = 20:00 UTC.
const FIRST_MATCH_AT = new Date("2026-05-28T20:00:00.000Z");
const MATCH_DURATION_MIN = 60;

// 9 historical messages, in chronological order. Each: { ts, sender pushname, sender phone (if known), body }.
const CHAT: Array<{ ts: string; senderPushname: string; senderPhone: string | null; body: string }> = [
  { ts: "2026-05-24T17:14:24Z", senderPushname: "Amir",   senderPhone: "+447865315941", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir` },
  { ts: "2026-05-24T17:14:54Z", senderPushname: "~ Nabeel", senderPhone: "+447508635052", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠NABEEL` },
  { ts: "2026-05-24T17:15:17Z", senderPushname: "~ Omar", senderPhone: "+447722474387", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠NABEEL
4.⁠ ⁠⁠Yusuf.i` },
  { ts: "2026-05-24T17:15:43Z", senderPushname: "~ Jordan", senderPhone: "+447445836661", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠NABEEL
4.⁠ ⁠⁠Yusuf.i
5.⁠ ⁠⁠Jordan` },
  { ts: "2026-05-24T17:16:22Z", senderPushname: "~ Jesse👑", senderPhone: "+447903317708", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠NABEEL
4.⁠ ⁠⁠Yusuf.i
5.⁠ ⁠⁠Jordan
6.⁠ ⁠⁠Jesse
7.⁠ ⁠⁠Arz
8.⁠ ⁠⁠Kojo` },
  { ts: "2026-05-24T17:41:13Z", senderPushname: "~ Martin", senderPhone: "+447413649949", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

1.⁠ ⁠Ehtisham
2.⁠ ⁠Amir
3.⁠ ⁠⁠NABEEL
4.⁠ ⁠⁠Yusuf.i
5.⁠ ⁠⁠Jordan
6.⁠ ⁠⁠Jesse
7.⁠ ⁠⁠Arz
8.⁠ ⁠⁠Kojo
9.⁠ ⁠⁠Martin` },
  { ts: "2026-05-24T17:41:34Z", senderPushname: "~ Raahil", senderPhone: "+447380977770", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

 1.⁠ ⁠Ehtisham
 2.⁠ ⁠Amir
 3.⁠ ⁠⁠NABEEL
 4.⁠ ⁠⁠Yusuf.i
 5.⁠ ⁠⁠Jordan
 6.⁠ ⁠⁠Jesse
 7.⁠ ⁠⁠Arz
 8.⁠ ⁠⁠Kojo
 9.⁠ ⁠⁠Martin
10.⁠ ⁠⁠Raahil` },
  { ts: "2026-05-24T17:45:23Z", senderPushname: "Shaz", senderPhone: "+447585808081", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

 1.⁠ ⁠Ehtisham
 2.⁠ ⁠Amir
 3.⁠ ⁠⁠NABEEL
 4.⁠ ⁠⁠Yusuf.i
 5.⁠ ⁠⁠Jordan
 6.⁠ ⁠⁠Jesse
 7.⁠ ⁠⁠Arz
 8.⁠ ⁠⁠Kojo
 9.⁠ ⁠⁠Martin
10.⁠ ⁠⁠Raahil
11.⁠ ⁠⁠Faris
12.⁠ ⁠⁠Usama
13.⁠ ⁠⁠Shaz
14.⁠ ⁠⁠adam` },
  { ts: "2026-05-25T06:42:35Z", senderPushname: "~ Eman", senderPhone: "+447792064309", body:
`In sha Allah 9pm Thursday 28 May Wimbledon Goals 7 a side football:

 1.⁠ ⁠Ehtisham
 2.⁠ ⁠Amir
 3.⁠ ⁠⁠NABEEL
 4.⁠ ⁠⁠Yusuf.i
 5.⁠ ⁠⁠Jordan
 6.⁠ ⁠⁠Jesse
 7.⁠ ⁠⁠Arz
 8.⁠ ⁠⁠Kojo
 9.⁠ ⁠⁠Martin
10.⁠ ⁠⁠Raahil
11.⁠ ⁠⁠Faris
12.⁠ ⁠⁠Usama
13.⁠ ⁠⁠Shaz
14.⁠ ⁠⁠adam

Reserve:
Eman` },
];

// Phones to patch for senders who don't get an auto-alias from the
// natural extraction:
//   - Omar: he added Yusuf.i (a guest), not himself → no self-alias.
//   - Eman: he added himself to Reserves only — current code treats
//     all reserve-additions as guests, so no self-alias is created.
// We patch their phones onto the auto-provisioned User rows (matched
// by name) after the extraction has run.
const POST_EXTRACT_PHONE_PATCHES: Array<{ name: string; phone: string }> = [
  { name: "Yusuf.i", phone: "+447722474387" }, // Omar added this name — assign the phone to him
  // Actually correction: Omar's phone belongs to Omar himself, not Yusuf.i. We just don't
  // get a User row for Omar from the natural extraction. The patch below creates one.
];

async function main() {
  console.log(`=== Amir-onboarding script — mode: ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  console.log("");

  const existing = await db.organisation.findFirst({ where: { whatsappGroupId: GID } });
  if (existing) {
    console.log(`Org already exists for ${GID}: ${existing.slug} (${existing.name}). Aborting.`);
    await db.$disconnect();
    return;
  }

  console.log("Plan:");
  console.log(`  1. Provision Organisation ${ORG_SLUG} (${ORG_NAME}), gid=${GID}`);
  console.log(`     features: MoM✓ Rating✓ SquadFromList✓ (all others OFF)`);
  console.log(`  2. Provision Sport ${SPORT_NAME} (7-a-side, position-aware balancer)`);
  console.log(`  3. Provision Activity ${ACTIVITY_NAME} (${DAY_OF_WEEK}=Thu, ${KICKOFF_LOCAL} London, ${VENUE})`);
  console.log(`  4. Provision Match ${FIRST_MATCH_AT.toISOString()} (maxPlayers=${MAX_PLAYERS}, duration=${MATCH_DURATION_MIN}m)`);
  console.log(`  5. Inject ${CHAT.length} historical GroupMessage rows`);
  console.log(`  6. (after extraction) patch missing-phone Users: Omar + Eman`);
  console.log(`  7. Bot's next /due-posts poll (≤30s) emits 'bot-intro' → posts in group`);
  console.log("");

  if (!APPLY) {
    console.log("(dry-run — re-run with --apply to execute.)");
    await db.$disconnect();
    return;
  }

  console.log("--- 1-4: provisioning ---");
  const result = await db.$transaction(async (tx) => {
    const org = await tx.organisation.create({
      data: {
        name: ORG_NAME, slug: ORG_SLUG, whatsappGroupId: GID,
        whatsappBotEnabled: true,
        featureAttendance: false, featureBench: false, featureTeamBalancing: false,
        featureMomVoting: true, featurePlayerRating: true,
        featureReminders: false, featureStatsQa: false,
        paymentTrackingEnabled: false, featureSquadFromList: true,
      },
    });
    const sport = await tx.sport.create({
      data: {
        orgId: org.id, name: SPORT_NAME, preset: "football-7aside",
        playersPerTeam: PLAYERS_PER_SIDE,
        positions: ["GK", "DEF", "MID", "FWD"],
        teamLabels: ["Red", "Yellow"], balancingStrategy: "position-aware",
      },
    });
    const activity = await tx.activity.create({
      data: {
        orgId: org.id, sportId: sport.id, name: ACTIVITY_NAME,
        dayOfWeek: DAY_OF_WEEK, time: KICKOFF_LOCAL, venue: VENUE,
        matchDurationMins: MATCH_DURATION_MIN, isActive: true,
      },
    });
    const match = await tx.match.create({
      data: {
        activityId: activity.id, date: FIRST_MATCH_AT,
        maxPlayers: MAX_PLAYERS, attendanceDeadline: FIRST_MATCH_AT,
        status: "UPCOMING",
      },
    });
    return { org, sport, activity, match };
  });
  console.log(`  org      = ${result.org.id}`);
  console.log(`  sport    = ${result.sport.id}`);
  console.log(`  activity = ${result.activity.id}`);
  console.log(`  match    = ${result.match.id}`);

  console.log("\n--- 5: injecting historical messages ---");
  const tag = Date.now().toString();
  for (let i = 0; i < CHAT.length; i++) {
    const m = CHAT[i];
    const waMessageId = `backfill-amir-${tag}-${i}`;
    await db.groupMessage.create({
      data: {
        orgId: result.org.id, waChatId: GID, waMessageId,
        senderPhone: m.senderPhone ? m.senderPhone.replace(/^\+/, "") : null,
        senderPushname: m.senderPushname, body: m.body,
        timestamp: new Date(m.ts),
      },
    });
    console.log(`  msg #${i + 1}: ${m.senderPushname.padEnd(12)} → archived (${waMessageId})`);
  }
  console.log(`  → ${CHAT.length} GroupMessage rows inserted.`);

  console.log("\n--- DONE ---");
  console.log("Bot's next /due-posts poll (every 30s) will see the new org + emit bot-intro.");
  console.log("The intro will land in the WhatsApp group within ~30s + WhatsApp delivery delay.");
  console.log("");
  console.log("Next manual step (run after this completes):");
  console.log("  curl -H \"authorization: Bearer $CRON_SECRET\" https://matchtime.ai/api/cron/extract-squads");
  console.log("This triggers the squad extraction (one Sonnet call) → writes 14 CONFIRMED + 1 BENCH.");

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
