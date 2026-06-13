/**
 * Bot calls this endpoint on startup with the WhatsApp group's full
 * participant list. Server upserts User + Membership rows for anyone
 * who's in the group but missing from MatchTime's DB.
 *
 * Closes the "lurker gap" — members who were in the group before the
 * bot was added (so group_join never fired) and haven't typed since
 * (so auto-provision via message-analyzer never fired).
 *
 * The upsert loop itself lives in src/lib/participant-sync.ts
 * (importParticipants) so onboarding completion can reuse it to import
 * the participant snapshot taken when the bot was added (Phase 1
 * autonomous onboarding, 2026-06-12). This route is the thin
 * org-lookup + auth wrapper.
 *
 * Auth via WHATSAPP_API_KEY same as the rest of /api/whatsapp/*.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  importParticipants,
  type SnapshotParticipant,
} from "@/lib/participant-sync";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    groupId?: string;
    participants?: SnapshotParticipant[];
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

  const result = await importParticipants(org.id, body.participants);

  return NextResponse.json({
    ok: true,
    org: org.name,
    ...result,
  });
}
