/**
 * Bot-forwarded IN/OUT endpoint.
 *
 * Auto-onboarding rule:
 *   On "IN" from an unknown phone, we don't drop — we auto-enrol them.
 *   WhatsApp group membership is the source of truth, so anyone who's
 *   able to type in the group is a legitimate player. We:
 *     1. Create the User (name from WhatsApp pushname if supplied, else
 *        null so admin can rename).
 *     2. Create a Membership as PLAYER for this org (or reactivate if
 *        there's a left-row lying around).
 *     3. Queue a BotJob admin DM announcing the new player.
 *     4. Register the attendance against the next upcoming match.
 *
 *   For "OUT" from an unknown phone: silent drop. There's nothing to
 *   cancel and no reason to onboard someone whose first action is to
 *   leave.
 *
 *   For "IN"/"OUT" from someone whose Membership has leftAt set: treat
 *   it the same as the unknown-phone case. If they're active in the
 *   group again they need a fresh auto-onboard (or a group_join event,
 *   which does the same thing).
 */
import { db } from "@/lib/db";
import { registerAttendance, cancelAttendance } from "@/lib/attendance";
import { findOrgAdminsWithPhone } from "@/lib/org";
import { NextResponse } from "next/server";

function verifyApiKey(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  return apiKey === process.env.WHATSAPP_API_KEY;
}

export async function POST(request: Request) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { phoneNumber, action, groupId, displayName } = body as {
    phoneNumber: string;
    action: "IN" | "OUT";
    groupId?: string;
    displayName?: string;
  };

  if (!phoneNumber || !action) {
    return NextResponse.json(
      { error: "phoneNumber and action required" },
      { status: 400 },
    );
  }

  // Normalize phone number to E.164
  const normalized = phoneNumber.startsWith("+") ? phoneNumber : `+${phoneNumber}`;

  // Resolve org FIRST — we need it to decide whether to auto-onboard.
  // (Attendance has to be attributed to a specific org; the groupId is
  // the most reliable signal since one org ↔ one group.)
  let orgId: string | undefined;
  let orgName: string | undefined;
  if (groupId) {
    const org = await db.organisation.findFirst({
      where: { whatsappGroupId: groupId },
      select: { id: true, name: true },
    });
    if (org) {
      orgId = org.id;
      orgName = org.name;
    }
  }

  // Existing user lookup.
  let user = await db.user.findUnique({
    where: { phoneNumber: normalized },
    select: { id: true, name: true, email: true },
  });

  // Fall back to the user's first membership when we couldn't resolve
  // the org from the group — useful for legacy DM paths.
  if (!orgId && user) {
    const membership = await db.membership.findFirst({
      where: { userId: user.id, leftAt: null },
      orderBy: { createdAt: "asc" },
      include: { org: { select: { id: true, name: true } } },
    });
    if (membership) {
      orgId = membership.orgId;
      orgName = membership.org.name;
    }
  }

  if (!orgId) {
    return NextResponse.json({ error: "No organisation found" }, { status: 404 });
  }

  // OUT from someone we don't know — silent drop. Same for OUT from a
  // left member. No user record to cancel attendance against.
  if (action === "OUT") {
    if (!user) {
      return NextResponse.json({ ok: true, ignored: "unknown-player-out" });
    }
    const m = await db.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId } },
      select: { leftAt: true },
    });
    if (!m || m.leftAt !== null) {
      return NextResponse.json({ ok: true, ignored: "left-or-no-membership-out" });
    }
  }

  // ── Auto-onboard on IN ────────────────────────────────────────────────
  // Track whether the caller just got enrolled so we can DM admins.
  let autoEnrolled = false;
  let autoReactivated = false;

  if (action === "IN") {
    // 1. Create the user if we've never seen this phone.
    if (!user) {
      const trimmedName = displayName?.trim() || null;
      const placeholderEmail = `wa-${normalized.replace(/^\+/, "")}@placeholder.matchtime`;
      user = await db.user.create({
        data: {
          name: trimmedName,
          email: placeholderEmail,
          phoneNumber: normalized,
          onboarded: false,
          isActive: true,
        },
        select: { id: true, name: true, email: true },
      });
      autoEnrolled = true;
    } else if (!user.name && displayName?.trim()) {
      // Backfill name from WhatsApp pushname on existing placeholder
      // users that never got renamed.
      const trimmedName = displayName.trim();
      const updated = await db.user.update({
        where: { id: user.id },
        data: { name: trimmedName },
        select: { id: true, name: true, email: true },
      });
      user = updated;
    }

    // 2. Ensure Membership is active for this org.
    const existingMembership = await db.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId } },
      select: { id: true, leftAt: true },
    });
    if (!existingMembership) {
      await db.membership.create({
        data: { userId: user.id, orgId, role: "PLAYER" },
      });
      if (!autoEnrolled) autoEnrolled = true;
    } else if (existingMembership.leftAt) {
      await db.membership.update({
        where: { id: existingMembership.id },
        data: { leftAt: null },
      });
      autoReactivated = true;
    }
  }

  // At this point we know the user exists and has an active Membership
  // for `orgId` (unless this was an OUT for an already-known user, in
  // which case the earlier guard handled unknowns and left members).
  if (!user) {
    // Can't happen — but narrow types.
    return NextResponse.json({ error: "user-unresolved" }, { status: 500 });
  }

  // Find the next upcoming match for this org.
  const now = new Date();
  const nextMatch = await db.match.findFirst({
    where: {
      activity: { orgId },
      status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
      attendanceDeadline: { gt: now },
    },
    include: { activity: true },
    orderBy: { date: "asc" },
  });

  if (!nextMatch) {
    return NextResponse.json(
      {
        error: "no_match",
        message: "No upcoming match found or the deadline has passed.",
      },
      { status: 404 },
    );
  }

  // Fire admin DMs on state change — after we know the match exists so
  // we don't DM admins for someone typing "IN" with no match to join.
  if (autoEnrolled || autoReactivated) {
    const admins = await findOrgAdminsWithPhone(orgId);
    const displayFor = user.name?.trim() || normalized;
    const text = autoReactivated
      ? [
          `🔁 *${displayFor}* rejoined *${orgName}*'s WhatsApp group (said IN).`,
          ``,
          `Their membership has been re-activated automatically.`,
        ].join("\n")
      : [
          `🆕 New player on *${orgName}* — just said IN on WhatsApp.`,
          ``,
          `Name:  ${user.name ?? "(none yet — please set it)"}`,
          `Phone: ${normalized}`,
          ``,
          `I've enrolled them as a placeholder player. Set or update their name here:`,
          `/admin/players/phones`,
        ].join("\n");

    for (const admin of admins) {
      if (admin.id === user.id) continue;
      await db.botJob.create({
        data: {
          orgId,
          kind: "dm",
          phone: admin.phoneNumber.replace(/^\+/, ""),
          text,
        },
      });
    }
  }

  try {
    if (action === "IN") {
      const result = await registerAttendance(user.id, nextMatch.id, {
        // The bot's explicit IN/OUT endpoint — always the player acting
        // on their own place, never a third party.
        event: {
          cause: "self-attendance",
          actorKind: "player",
          actorUserId: user.id,
          sourceRef: "wa:attendance-endpoint",
        },
      });
      return NextResponse.json({
        success: true,
        player: user.name,
        match: nextMatch.activity.name,
        matchDate: nextMatch.date,
        status: result.status,
        slot: result.slot,
        confirmed: result.confirmedCount,
        max: result.maxPlayers,
        autoEnrolled,
        autoReactivated,
      });
    } else {
      await cancelAttendance(user.id, nextMatch.id, {
        cause: "self-attendance",
        actorKind: "player",
        actorUserId: user.id,
        sourceRef: "wa:attendance-endpoint",
      });
      const confirmedCount = await db.attendance.count({
        where: { matchId: nextMatch.id, status: "CONFIRMED" },
      });
      return NextResponse.json({
        success: true,
        player: user.name,
        match: nextMatch.activity.name,
        status: "DROPPED",
        confirmed: confirmedCount,
        max: nextMatch.maxPlayers,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
