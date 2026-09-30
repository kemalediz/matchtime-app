/**
 * Bot-forwarded "the bot itself was just ADDED to a group" event —
 * Phase 1 of autonomous onboarding ("adding the bot IS the
 * onboarding", MDs/autonomous-onboarding-design-2026-06-12.md §B.2).
 *
 * The Pi bot detects its own JID in a `group_join`'s recipientIds for
 * an unmonitored group and POSTs:
 *   { groupId, groupSubject?, addedByPhone?, participants?, enrichmentHistory? }
 *
 * SELF-JOIN (slice 6, 2026-09-29). While SELF_JOIN_ENABLED is on, the
 * add goes to the self-join linker (src/lib/group-add.ts) FIRST, before
 * the ONBOARDING_AUTOSTART gate below (decision 4 switches autostart off
 * once self-join is on), and nothing further down runs:
 *   - a group an approved club owns (Sutton FC): ignored, as today;
 *   - an add matching an organiser's connect request: the request is
 *     linked, the club goes PENDING, the organiser gets a one-line ack
 *     if they were the adder, and the owner gets ONE approval DM
 *     (queueOwnerDm, purpose owner-approval);
 *   - anything else: recorded as unsolicited (silent, left after 48h).
 * It never returns an intro. `silent: true` tells the Pi to treat the
 * group as silent at once, before its next /orgs refresh. The Pi's
 * reconnect sweep posts `discovered: true` for groups it found itself
 * in; with self-join off such a post is ignored outright.
 *
 * Server behaviour (idempotent), self-join off:
 *   0. HARD GATE: the ONBOARDING_AUTOSTART env flag must be on,
 *      otherwise this route is a no-op — nothing can fire in prod
 *      until the flag is deliberately flipped.
 *   1. A bot-enabled org already exists for the group → ignore (re-add
 *      of the bot to a LIVE group must never restart onboarding).
 *   1a. Slice 2a: the group is a club's linked admin group → ignore; an
 *      add by an owner or admin of an approved club → an admin group
 *      waiting for its code: silent, no session, no intro.
 *   1b. The group is SILENT (club not approved, or nobody asked for
 *      MatchTime there), or self-join is on → no intro, no session
 *      (self-join plan, section 4.3 layer 4).
 *   2. An active onboarding session exists → idempotent re-add: return
 *      the intro again only if we're still at `introduced` (the bot
 *      was likely kicked + re-added before anyone replied), else stay
 *      silent. A STALE session (older than ONBOARDING_SESSION_TTL_MS)
 *      is abandoned and a fresh one created (2026-09-17).
 *   3. Else create an OnboardingSession (source="group-add",
 *      stage="introduced") seeded with the group subject, the adder's
 *      phone, the participant snapshot and the LANGUAGE detected from
 *      the subject and the synced history, and return the intro text
 *      in that language for the bot to post.
 *
 * The conversation continues through the normal /api/whatsapp/analyze
 * path (handleOnboardingIfApplicable routes the active stages to the
 * onboarding state machine).
 *
 * Auth via WHATSAPP_API_KEY same as the rest of /api/whatsapp/*.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { buildBotAddedIntro } from "@/lib/onboarding-conversation";
import {
  ACTIVE_ONBOARDING_STAGES,
  isOnboardingAutostartEnabled,
  isOnboardingSessionStale,
} from "@/lib/onboarding-parse";
import { parseParticipantSnapshot } from "@/lib/participant-sync";
import { coerceHistoryMessages } from "@/lib/onboarding-enrichment-reconcile";
import { detectGroupLang } from "@/lib/i18n/detect";
import { inGroupSetupRefusal } from "@/lib/club-approval";
import { selfJoinEnabledForApiRequest } from "@/lib/self-join-flag";
import {
  handleSelfJoinGroupAdd,
  isSilentOutcome,
  markOwnerDmQueued,
  type GroupAddOutcome,
} from "@/lib/group-add";
import { queueOwnerDm } from "@/lib/owner-dm";
import { detectAdminGroupCandidate, recordAdminGroupCandidate } from "@/lib/admin-group-link";

/** The `ignored` word the Pi logs for each self-join outcome. */
const SELF_JOIN_IGNORED: Record<GroupAddOutcome["kind"], string> = {
  "live-org": "live-org",
  "club-group": "silent-group",
  "already-linked": "self-join-pending",
  linked: "self-join-pending",
  unsolicited: "unsolicited",
  "discovered-no-match": "discovered-no-match",
  "race-lost": "self-join-race-lost",
  "admin-group": "admin-group",
  "admin-group-candidate": "admin-group-awaiting-code",
};

async function selfJoinAdd(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const groupId = typeof body?.groupId === "string" && body.groupId ? body.groupId : null;
  if (!body || !groupId) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }
  const outcome = await handleSelfJoinGroupAdd({
    groupId,
    groupSubject: body.groupSubject,
    addedByPhone: body.addedByPhone,
    addedByLid: body.addedByLid,
    participants: body.participants,
    enrichmentHistory: body.enrichmentHistory,
    discovered: body.discovered,
  });
  if (outcome.kind === "linked") {
    // The ONE DM to the owner about this request. queueOwnerDm is also
    // once per (purpose, refId, phone), so a retry cannot DM twice.
    const dm = await queueOwnerDm(outcome.ownerDm.text, "owner-approval", outcome.ownerDm.refId);
    if (dm.queued > 0 || dm.skipped > 0) await markOwnerDmQueued(outcome.connectId);
  }
  console.log(`[bot-added] ${groupId}: self-join ${outcome.kind}`);
  return NextResponse.json({
    ok: true,
    ignored: SELF_JOIN_IGNORED[outcome.kind],
    selfJoin: outcome.kind,
    silent: isSilentOutcome(outcome),
    introText: null,
  });
}

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (selfJoinEnabledForApiRequest(request)) return selfJoinAdd(request);

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
    // Chat history the Pi captured shortly after the bot was added (it can
    // only reliably fetch WhatsApp history around join time). We PERSIST it
    // on the OnboardingSession (capturedHistory) so the enrichment pass,
    // which runs later at completion from /api/whatsapp/analyze, can fall
    // back to it when the completing request omits its own
    // enrichmentHistory. It is also the evidence for the language
    // detection below. Validated/coerced defensively.
    enrichmentHistory?: unknown;
    /** Self-join's reconnect sweep. Only a Pi told to sweep (by a server
     *  with self-join on) sends it; the in-group setup never starts from one. */
    discovered?: unknown;
    /** The adder's LID, bare digits, when it was LID-addressed. */
    addedByLid?: unknown;
  } | null;
  if (!body?.groupId) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }
  if (body.discovered === true) {
    return NextResponse.json({ ok: true, ignored: "discovered", introText: null });
  }
  const groupId = body.groupId;

  // Validate the Pi-captured chat history into HistoryMessage[] (blank
  // author/text rows dropped; chronological order is the Pi's job —
  // we never reorder). Empty → don't persist anything.
  // Cast through `unknown as object` (the repo's convention for typed
  // structs → Prisma Json — see onboarding-enrichment.ts): our struct
  // carries optional/null fields that don't line up with InputJsonValue,
  // but the shape is valid JSON.
  const captured = coerceHistoryMessages(body.enrichmentHistory);
  const capturedJson =
    captured.length > 0 ? (captured as unknown as object) : undefined;

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

  // 1a. THE ADMINS' HQ GROUP (slice 2a, 2026-09-30). ONBOARDING_AUTOSTART
  //     is on in production, so without this an organiser adding MatchTime
  //     to his admins' group would start the in-group setup there. An add
  //     by an owner or admin of an approved club (or to a group one of
  //     their admins is in, while that club has a link code open) waits
  //     silently for "@Match Time admin group CODE" instead: no session,
  //     no intro. A group that is already a club's admin group is left
  //     alone. Placed after the live-org check and before every setup path.
  const linkedAdminGroup = await db.organisation.findFirst({
    where: { adminGroupId: groupId },
    select: { id: true },
  });
  if (linkedAdminGroup) {
    return NextResponse.json({
      ok: true,
      ignored: "admin-group",
      adminGroup: { groupId, orgId: linkedAdminGroup.id },
      introText: null,
    });
  }
  const addedByLid = typeof body.addedByLid === "string" ? body.addedByLid : null;
  if (
    await detectAdminGroupCandidate({
      addedByPhone: body.addedByPhone,
      addedByLid,
      participants: body.participants,
      now: new Date(),
    })
  ) {
    const snapshotSize = parseParticipantSnapshot(body.participants).length;
    await recordAdminGroupCandidate({
      groupId,
      subject: body.groupSubject?.trim() || null,
      memberCount: snapshotSize || null,
      addedByPhone: typeof body.addedByPhone === "string" ? body.addedByPhone : null,
      addedByLid,
      now: new Date(),
    });
    return NextResponse.json({ ok: true, ignored: "admin-group-awaiting-code", silent: true, introText: null });
  }

  // 1b. SILENCE RAILS (self-join slice 1, 2026-09-29). A group whose club
  //     is waiting for approval, was rejected or suspended, or that nobody
  //     asked MatchTime into, never gets an intro and never starts a
  //     session. With self-join on, the in-group setup is retired
  //     altogether (decision 4); the self-join branch that links a pending
  //     club lands here in a later slice. Placed after the live-org check,
  //     so a live club is answered exactly as before.
  const refusal = await inGroupSetupRefusal(groupId);
  if (refusal) {
    console.log(`[bot-added] ${groupId}: no intro (${refusal})`);
    return NextResponse.json({ ok: true, ignored: refusal, introText: null });
  }

  // 2. Idempotent re-add while a session is in flight.
  const active = await db.onboardingSession.findFirst({
    where: { whatsappGroupId: groupId, stage: { in: [...ACTIVE_ONBOARDING_STAGES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, stage: true, capturedHistory: true, language: true, createdAt: true },
  });
  if (active && isOnboardingSessionStale(active)) {
    // Nobody answered for two weeks; this add starts over with what the
    // group looks like today (subject, roster, language).
    await db.onboardingSession.update({
      where: { id: active.id },
      data: { stage: "abandoned" },
    });
  } else if (active) {
    // Late-sync rescue: if this re-add finally carries history and the
    // session has none yet, store it. We never CLOBBER existing history —
    // a later re-add could fetch fewer/no messages than the first.
    if (capturedJson && active.capturedHistory == null) {
      await db.onboardingSession.update({
        where: { id: active.id },
        data: { capturedHistory: capturedJson },
      });
    }
    return NextResponse.json({
      ok: true,
      existing: true,
      stage: active.stage,
      language: active.language,
      // Still waiting on consent → safe (and useful) to re-post the
      // intro; mid-flow → stay silent, the Q&A continues via analyze.
      introText: active.stage === "introduced" ? buildBotAddedIntro(active.language) : null,
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

  // The language the group speaks, decided before the first word: from
  // the subject and whatever history WhatsApp had synced by the time
  // the Pi read it. English when there is nothing to go on; the consent
  // reply ("evet" / "yes") corrects it either way. See i18n/detect.ts.
  const detected = detectGroupLang({
    subject,
    history: captured.map((m) => m.text),
  });
  console.log(
    `[bot-added] ${groupId} language=${detected.lang} (${detected.reason}; ` +
      `subject=${subject ? JSON.stringify(subject) : "none"}, history=${captured.length} msgs)`,
  );

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
      capturedHistory: capturedJson,
      language: detected.lang,
    },
    select: { id: true },
  });

  return NextResponse.json({
    ok: true,
    sessionId: session.id,
    language: detected.lang,
    languageConfident: detected.confident,
    introText: buildBotAddedIntro(detected.lang),
  });
}
