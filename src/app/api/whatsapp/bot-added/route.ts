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
 *   - a re-add by the organiser, within 24 hours of MatchTime being
 *     removed from that same group while the club waited, with no new
 *     code (2026-10-11): the same request is linked again, exactly as
 *     above (same answer to the Pi, one ack, one owner DM for the relink);
 *   - a WhatsApp community's parent group or announcements group
 *     (2026-10-15): never linked, never recorded, never left, nobody told;
 *   - the organiser's own add of a group while their request is linked to
 *     ANOTHER group on weak evidence (2026-10-15): the request is moved
 *     here, and the owner gets the approval DM or one correction;
 *   - anything else: recorded as unsolicited (silent, left after 48h).
 * A body with `lateHistory: true` is not an add: a shared-history bundle
 * read after the add post, stored on the request linked to the group
 * (`lateHistoryStep` below).
 * The add may carry the group's description (`groupDescription`,
 * 2026-10-12). Numbers are masked out of it before it is stored on the
 * linked request, beside the chat (src/lib/group-description.ts); it is
 * never logged and never sent on. With self-join off it is ignored.
 * It never returns an intro. `silent: true` tells the Pi to treat the
 * group as silent at once, before its next /orgs refresh. The Pi's
 * reconnect sweep posts `discovered: true` for groups it found itself
 * in; with self-join off such a post is ignored outright.
 *
 * Server behaviour, self-join off:
 *   0. HARD GATE: the ONBOARDING_AUTOSTART env flag must be on,
 *      otherwise this route is a no-op.
 *   1. A bot-enabled org already exists for the group: ignore.
 *   1a. Slice 2a: the group is a club's linked admin group: ignore; an
 *      add by an owner or admin of an approved club: an admin group
 *      waiting for its code, silent.
 *   1b. Anything else: ignored, no intro. The legacy in-group setup
 *      (OnboardingSession, intro, Q&A) was deleted on 2026-10-30.
 *
 * Club fee billing, slice B5 (2026-10-01): before anything above, a
 * real self-add (never the sweep's `discovered`) of the group of a club
 * PAUSED BECAUSE MATCHTIME WAS REMOVED runs `handleBillingReAdd`
 * (lib/club-billing-removal.ts): back to the free period, or serving again
 * when its subscription still pays (the cancel at period end undone), or
 * still paused waiting for a card or a payment. With BILLING_ENABLED off,
 * and for every other club, it does nothing. It never changes this
 * route's answer, and a failure in it never breaks the add.
 *
 * Auth via WHATSAPP_API_KEY same as the rest of /api/whatsapp/*.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isOnboardingAutostartEnabled } from "@/lib/onboarding-parse";
import { parseParticipantSnapshot } from "@/lib/participant-sync";
import { isSilentGroup } from "@/lib/club-approval";
import { selfJoinEnabledForApiRequest } from "@/lib/self-join-flag";
import {
  attachLateGroupHistory,
  handleSelfJoinGroupAdd,
  isSilentOutcome,
  queueOwnerDmForLink,
  type GroupAddOutcome,
} from "@/lib/group-add";
import { detectAdminGroupCandidate, recordAdminGroupCandidate } from "@/lib/admin-group-link";
import { billingEnabledForApiRequest } from "@/lib/billing-flag";
import { handleBillingReAdd } from "@/lib/club-billing-removal";
import { handleSetupReAdd } from "@/lib/club-setup-removal";
import { scheduleSetupAfterApproval } from "@/lib/club-setup-schedule";
import { ingestGroupDescription } from "@/lib/group-description";

/** Slice B5: MatchTime added back to a club paused because it was removed.
 *  Reads a CLONE of the body, so the route below still reads it. Never throws. */
async function billingReAddStep(request: Request): Promise<void> {
  try {
    const peek = (await request.clone().json().catch(() => null)) as { groupId?: unknown; discovered?: unknown } | null;
    const groupId = typeof peek?.groupId === "string" && peek.groupId.endsWith("@g.us") ? peek.groupId : null;
    if (!groupId || peek?.discovered === true) return;
    const r = await handleBillingReAdd(groupId, { flagOn: billingEnabledForApiRequest(request) });
    if (r.kind !== "not-removed") console.log(`[bot-added] ${groupId}: club fee re-add ${JSON.stringify(r)}`);
  } catch (err) {
    console.error("[bot-added] club fee re-add step failed (the add carries on):", err);
  }
}

/**
 * Removal slice (2026-10-12): MatchTime added back to the group of a club
 * that is approved, still setting up, and was REMOVED from it. When the
 * adder is a current member of that club the removal is cleared, so GO
 * works again and a setup DM that never went becomes due; it is then run
 * AT ONCE, after the response, exactly as after an approval
 * (`scheduleSetupAfterApproval`), with the 15-minute sweep as the
 * backstop. Whatever the self-join switch says, like the billing step
 * above, because such a club's group takes a different branch below in
 * each case ("live-org" with self-join on, the silence rail with it off)
 * and neither writes anything. It never changes this route's answer, says
 * nothing in the group, and never throws.
 *
 * `discovered` (the reconnect sweep found MatchTime in the group) clears
 * it too, with no adder: the group is already that club's. THE PI DOES
 * NOT SEND THAT FOR SUCH A GROUP TODAY: its sweep skips every group the
 * server lists as known or silent, and a setting-up club's group is both.
 * The server half is here so that a Pi which does report it is believed.
 */
async function setupReAddStep(request: Request): Promise<void> {
  try {
    const peek = (await request.clone().json().catch(() => null)) as {
      groupId?: unknown;
      discovered?: unknown;
      addedByPhone?: unknown;
      addedByLid?: unknown;
    } | null;
    const groupId = typeof peek?.groupId === "string" && peek.groupId.endsWith("@g.us") ? peek.groupId : null;
    if (!groupId) return;
    const r = await handleSetupReAdd({
      groupId,
      addedByPhone: peek?.addedByPhone,
      addedByLid: peek?.addedByLid,
      discovered: peek?.discovered === true,
    });
    if (r.kind !== "not-removed") console.log(`[bot-added] ${groupId}: setting-up club re-add ${r.kind} (${r.orgId})`);
    // Back in its group: its setup DM (if it never went) without waiting
    // for the sweep. Scheduled, never awaited: the Pi is waiting for this
    // response. The run sends nothing for a club whose DM already went.
    if (r.kind === "cleared") scheduleSetupAfterApproval(r.orgId, request);
  } catch (err) {
    console.error(`[bot-added] setting-up re-add step failed (the add carries on): ${(err as Error)?.name ?? "error"}`);
  }
}

/**
 * A LATE HISTORY BUNDLE (2026-10-15). WhatsApp shares a group's recent chat
 * with a member who has just joined, as a bundle the Pi downloads. It can
 * land after the Pi's add post has gone without it (the FNF main chat's
 * did). The Pi then posts `{ groupId, lateHistory: true, enrichmentHistory }`
 * on its own. It is stored on the request linked to that group, as a re-add
 * would store it (`attachLateGroupHistory`), and is NOT an add: no
 * matching, no billing or setting-up step, nothing recorded, nobody told,
 * nothing about the group's silence changes. Null for an ordinary add.
 */
async function lateHistoryStep(request: Request): Promise<NextResponse | null> {
  const peek = (await request.clone().json().catch(() => null)) as {
    groupId?: unknown;
    lateHistory?: unknown;
    enrichmentHistory?: unknown;
  } | null;
  if (peek?.lateHistory !== true) return null;
  const groupId = typeof peek.groupId === "string" && peek.groupId.endsWith("@g.us") ? peek.groupId : null;
  if (!groupId) return NextResponse.json({ error: "groupId required" }, { status: 400 });
  const stored = selfJoinEnabledForApiRequest(request)
    ? await attachLateGroupHistory(groupId, peek.enrichmentHistory)
    : "self-join-off";
  console.log(`[bot-added] ${groupId}: late history bundle: ${stored}`);
  return NextResponse.json({ ok: true, ignored: "late-history", lateHistory: stored, introText: null });
}

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
  "held-not-postable": "not-postable",
  "community-group": "community-group",
};

async function selfJoinAdd(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const groupId = typeof body?.groupId === "string" && body.groupId ? body.groupId : null;
  if (!body || !groupId) {
    return NextResponse.json({ error: "groupId required" }, { status: 400 });
  }
  // THE GROUP DESCRIPTION (2026-10-12). Organisers keep bank details in
  // it, so it is masked HERE, before anything else sees it, and only the
  // masked text goes any further. `body.groupDescription` is not read
  // again, and nothing of it is logged but a length and a count.
  const description = ingestGroupDescription(body.discovered === true ? undefined : body.groupDescription);
  const outcome = await handleSelfJoinGroupAdd({
    groupId,
    groupSubject: body.groupSubject,
    addedByPhone: body.addedByPhone,
    addedByLid: body.addedByLid,
    participants: body.participants,
    enrichmentHistory: body.enrichmentHistory,
    groupDescription: description.text,
    discovered: body.discovered,
    postability: body.postability,
    community: body.community,
  });
  let ownerDm = "";
  if (outcome.kind === "linked") {
    // The ONE DM to the owner about this link. queueOwnerDm is also once
    // per (purpose, refId, phone), so a retry cannot DM twice. A relink
    // after a re-add brings its own refId (one per removal), so the owner
    // hears once that the club is waiting again. A request MOVED here by
    // the organiser's own add (2026-10-15) gets the approval DM, or the
    // correction when the owner was already asked about the other group.
    ownerDm = `, owner DM ${await queueOwnerDmForLink(groupId, outcome)}`;
  }
  const how =
    outcome.kind === "linked" && outcome.relinked
      ? " (relinked after re-add)"
      : outcome.kind === "linked" && outcome.upgradedFrom
        ? ` (moved here from ${outcome.upgradedFrom.groupId})`
        : outcome.kind === "community-group"
          ? ` (${outcome.role})`
          : "";
  console.log(`[bot-added] ${groupId}: self-join ${outcome.kind}${how}${ownerDm}, desc=${description.note}`);
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

  // A shared-history bundle the Pi read AFTER its add post (2026-10-15).
  // Not an add: none of the steps below run for it.
  const late = await lateHistoryStep(request);
  if (late) return late;

  await billingReAddStep(request);
  await setupReAddStep(request);

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
    /** Self-join's reconnect sweep. Only a Pi told to sweep (by a server
     *  with self-join on) sends it. */
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

  // 1. Live-org short-circuit: a group that already has a bot-enabled
  //    org is ignored (e.g. the bot was kicked and re-added to Sutton
  //    FC's group).
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

  // 1b. No club owns this group. The legacy in-group setup that used to
  //     start here (intro, OnboardingSession) was deleted on 2026-10-30:
  //     no intro, no session. A silent group keeps its word for the Pi log.
  const ignored = (await isSilentGroup(groupId)) ? "silent-group" : "no-club";
  console.log(`[bot-added] ${groupId}: no intro (${ignored})`);
  return NextResponse.json({ ok: true, ignored, introText: null });
}
