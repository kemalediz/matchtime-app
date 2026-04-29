/**
 * Bot calls this endpoint on startup with the WhatsApp group's full
 * participant list. Server upserts User + Membership rows for anyone
 * who's in the group but missing from MatchTime's DB.
 *
 * Closes the "lurker gap" — members who were in the group before the
 * bot was added (so group_join never fired) and haven't typed since
 * (so auto-provision via message-analyzer never fired).
 *
 * Flow:
 *   1. Find Org by whatsappGroupId.
 *   2. For each participant:
 *      - If we have a phone → upsert User by phoneNumber (create
 *        with pushname as name if new), upsert active Membership.
 *      - If only @lid (privacy mode, no phone resolvable) → skip.
 *        The pushname-based resolver in the analyze + dm-reply
 *        routes will pick them up the moment they message.
 *   3. NEVER overwrite existing User.name / phoneNumber on re-sync —
 *      admin edits + earlier provisioning take priority.
 *
 * Auth via WHATSAPP_API_KEY same as the rest of /api/whatsapp/*.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";

interface InboundParticipant {
  phone?: string | null;
  lidId?: string | null;
  pushname?: string | null;
}

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    groupId?: string;
    participants?: InboundParticipant[];
  } | null;
  if (!body?.groupId || !Array.isArray(body.participants)) {
    return NextResponse.json(
      { error: "groupId and participants[] required" },
      { status: 400 },
    );
  }

  const org = await db.organisation.findFirst({
    where: { whatsappGroupId: body.groupId, whatsappBotEnabled: true },
    select: { id: true, name: true },
  });
  if (!org) {
    return NextResponse.json({ ok: true, ignored: "unknown-group" });
  }

  let added = 0;
  let alreadyKnown = 0;
  let skippedNoPhone = 0;
  let restoredMembership = 0;

  for (const p of body.participants) {
    // Bot strips the leading "+" from JID-derived phones (e.g.
    // "447989747424"); normalisePhone preserves no-+ input as-is,
    // so prepend before normalising — matches the analyze-route
    // pattern. Without this every WA-group participant came back
    // as a NEW User because "447xxx" never matched stored
    // "+447xxx" records.
    const rawWithPlus = p.phone
      ? p.phone.startsWith("+")
        ? p.phone
        : `+${p.phone}`
      : null;
    const phone = rawWithPlus ? normalisePhone(rawWithPlus) : null;
    if (!phone) {
      skippedNoPhone += 1;
      continue;
    }
    const pushname = p.pushname?.trim() || null;

    let user = await db.user.findUnique({
      where: { phoneNumber: phone },
      select: { id: true, name: true },
    });
    if (!user) {
      // New User — synthetic email keeps the unique index happy.
      const slug =
        (pushname ?? "player")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32) || "player";
      user = await db.user.create({
        data: {
          name: pushname,
          phoneNumber: phone,
          email: `wa-sync+${slug}-${Date.now().toString(36)}@matchtime.local`,
          isActive: true,
          onboarded: false,
        },
        select: { id: true, name: true },
      });
      added += 1;
    } else {
      alreadyKnown += 1;
    }

    // Upsert active Membership. If the user was previously soft-removed
    // (leftAt set) but is now visible in the WhatsApp group again,
    // restore them — same restoreMembership semantics the analyze
    // route uses for re-engaging members.
    //
    // Always stamp lastSeenInGroupAt — that's how DM-blast features
    // (roster check-in survey) scope to members currently in the
    // WhatsApp group rather than the whole DB roster.
    const now = new Date();
    const existing = await db.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
    });
    if (!existing) {
      await db.membership.create({
        data: {
          userId: user.id,
          orgId: org.id,
          role: "PLAYER",
          lastSeenInGroupAt: now,
        },
      });
    } else {
      await db.membership.update({
        where: { id: existing.id },
        data: {
          lastSeenInGroupAt: now,
          ...(existing.leftAt !== null ? { leftAt: null } : {}),
        },
      });
      if (existing.leftAt !== null) restoredMembership += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    org: org.name,
    added,
    alreadyKnown,
    skippedNoPhone,
    restoredMembership,
    total: body.participants.length,
  });
}
