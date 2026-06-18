/**
 * Bot-forwarded "the bot itself was just ADDED to a group" event —
 * Phase 1 of autonomous onboarding ("adding the bot IS the
 * onboarding", MDs/autonomous-onboarding-design-2026-06-12.md §B.2).
 *
 * The Pi bot detects its own JID in a `group_join`'s recipientIds for
 * an unmonitored group and POSTs:
 *   { groupId, groupSubject?, addedByPhone?, participants? }
 *
 * Server behaviour (idempotent):
 *   0. HARD GATE: the ONBOARDING_AUTOSTART env flag must be on,
 *      otherwise this route is a no-op — nothing can fire in prod
 *      until the flag is deliberately flipped.
 *   1. A bot-enabled org already exists for the group → ignore (re-add
 *      of the bot to a LIVE group must never restart onboarding).
 *   2. An active onboarding session exists → idempotent re-add: return
 *      the intro again only if we're still at `introduced` (the bot
 *      was likely kicked + re-added before anyone replied), else stay
 *      silent.
 *   3. Else create an OnboardingSession (source="group-add",
 *      stage="introduced") seeded with the group subject, the adder's
 *      phone and the participant snapshot, and return the intro text
 *      for the bot to post.
 *
 * The conversation continues through the normal /api/whatsapp/analyze
 * path (handleOnboardingIfApplicable routes `introduced`/`details`
 * stages to the onboarding state machine).
 *
 * Auth via WHATSAPP_API_KEY same as the rest of /api/whatsapp/*.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { BOT_ADDED_INTRO } from "@/lib/onboarding-conversation";
import { isOnboardingAutostartEnabled } from "@/lib/onboarding-parse";
import { parseParticipantSnapshot } from "@/lib/participant-sync";

const ACTIVE_STAGES = ["introduced", "details", "collecting", "features"];

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isOnboardingAutostartEnabled()) {
    return NextResponse.json({
      ok: true,
      ignored: "autostart-disabled",
      introText: null,
    });
  }

  const body = (await request.json().catch(() => null)) as {
    groupId?: string;
    groupSubject?: string | null;
    addedByPhone?: string | null;
    participants?: unknown;
    // Forward-compat: bot-added only CREATES the session (it never
    // completes onboarding), so enrichment history isn't used here —
    // accepted and ignored so a caller that sends it doesn't error.
    // There's no schema column for it; the enrichment pass runs later
    // from /api/whatsapp/analyze on the completing turn.
    enrichmentHistory?: unknown;
  } | null;
  if (!body?.groupId) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }
  const groupId = body.groupId;

  // 1. Live-org short-circuit — a group that already has a bot-enabled
  //    org must NEVER re-enter onboarding (e.g. the bot was kicked and
  //    re-added to Sutton FC's group).
  const liveOrg = await db.organisation.findFirst({
    where: { whatsappGroupId: groupId, whatsappBotEnabled: true },
    select: { id: true },
  });
  if (liveOrg) {
    return NextResponse.json({
      ok: true,
      ignored: "live-org",
      orgId: liveOrg.id,
      introText: null,
    });
  }

  // 2. Idempotent re-add while a session is in flight.
  const active = await db.onboardingSession.findFirst({
    where: { whatsappGroupId: groupId, stage: { in: ACTIVE_STAGES } },
    orderBy: { createdAt: "desc" },
    select: { id: true, stage: true },
  });
  if (active) {
    return NextResponse.json({
      ok: true,
      existing: true,
      stage: active.stage,
      // Still waiting on consent → safe (and useful) to re-post the
      // intro; mid-flow → stay silent, the Q&A continues via analyze.
      introText: active.stage === "introduced" ? BOT_ADDED_INTRO : null,
    });
  }

  // 3. Fresh session.
  const subject = body.groupSubject?.trim() || null;
  const adderPhone = body.addedByPhone
    ? normalisePhone(
        body.addedByPhone.startsWith("+")
          ? body.addedByPhone
          : `+${body.addedByPhone}`,
      )
    : null;
  const snapshot = parseParticipantSnapshot(body.participants);

  const session = await db.onboardingSession.create({
    data: {
      whatsappGroupId: groupId,
      stage: "introduced",
      source: "group-add",
      groupSubject: subject,
      groupName: subject ? subject.slice(0, 80) : null,
      addedByPhone: adderPhone,
      participants:
        snapshot.length > 0
          ? (snapshot.map((p) => ({ ...p })) as Array<Record<string, string | null>>)
          : undefined,
    },
    select: { id: true },
  });

  return NextResponse.json({
    ok: true,
    sessionId: session.id,
    introText: BOT_ADDED_INTRO,
  });
}
