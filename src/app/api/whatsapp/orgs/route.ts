import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import {
  ACTIVE_ONBOARDING_STAGES,
  ONBOARDING_SESSION_TTL_MS,
} from "@/lib/onboarding-parse";
import {
  APPROVED_CLUB_WHERE,
  isLegacySetupTriggerEnabled,
  isSelfJoinEnabled,
  loadSilentGroupIds,
} from "@/lib/club-approval";
import { loadSelfJoinSweep } from "@/lib/group-add";
import { selfJoinEnabledForApiRequest } from "@/lib/self-join-flag";
import { loadAdminGroups } from "@/lib/admin-group-link";

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgs = await db.organisation.findMany({
    where: {
      // The CHECK constraint already forbids a bot-enabled club that is
      // not approved; this is the second lock on the same door.
      ...APPROVED_CLUB_WHERE,
      whatsappBotEnabled: true,
      whatsappGroupId: { not: null },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      whatsappGroupId: true,
    },
  });
  const known = new Set(orgs.map((o) => o.whatsappGroupId));

  // ── Silent groups (self-join slice 1, 2026-09-29) ─────────────────
  // Groups MatchTime is in but must never speak in or forward: a club
  // waiting for approval, rejected or suspended, or a group somebody
  // added MatchTime to with no connect code. The Pi drops their messages
  // and never lets the "@MatchTime setup" trigger monitor them. A live
  // club's group is never silent (belt and braces over the loader).
  const silentGroups = (await loadSilentGroupIds()).filter((g) => !known.has(g));
  const silent = new Set(silentGroups);

  // Groups mid-onboarding (no bot-enabled org yet) must stay monitored
  // across a bot restart, otherwise an in-progress setup stalls until
  // the moderator re-triggers. The Pi adds them to its monitored set and
  // flushes them immediately (a setup conversation cannot wait for the
  // 10-minute batch), and re-reads this list every few minutes, so a
  // group that completes setup becomes a live org without a restart.
  //
  // One shared stage list (2026-09-17): this used to spell the stages
  // out and omitted "admins", so a restart during the admins question
  // silently dropped the group. Stale sessions are excluded the same way
  // the analyze route ignores them.
  //
  // With self-join on, the in-group setup is retired (decision 4 of the
  // self-join plan): nothing is monitored for it.
  const selfJoin = isSelfJoinEnabled();
  const onboarding = selfJoin
    ? []
    : await db.onboardingSession.findMany({
        where: {
          stage: { in: [...ACTIVE_ONBOARDING_STAGES] },
          createdAt: { gt: new Date(Date.now() - ONBOARDING_SESSION_TTL_MS) },
        },
        select: { whatsappGroupId: true, groupName: true },
      });
  const onboardingGroups = [
    ...new Set(
      onboarding.map((s) => s.whatsappGroupId).filter((g) => !known.has(g) && !silent.has(g)),
    ),
  ];

  // ── Admin groups (slice 2a, 2026-09-30) ───────────────────────────
  // Each approved club's linked admin WhatsApp group. The Pi forwards a
  // message there to /api/whatsapp/admin-group at once (never into the
  // analysis history), forwards no joins or leaves, and posts only the
  // admin-group-message instructions. Never silent, never monitored as a
  // club group. An older Pi ignores the field.
  let adminGroups: Array<{ groupId: string; orgId: string }> = [];
  try {
    adminGroups = (await loadAdminGroups()).filter((a) => !known.has(a.groupId));
  } catch (err) {
    console.error("[orgs] admin groups query failed; none listed this time:", err);
  }

  const response: Record<string, unknown> = {
    orgs,
    onboardingGroups,
    silentGroups,
    adminGroups,
    // false tells the Pi to ignore "@MatchTime setup" in any group it is
    // not already monitoring. Absent (an older server) means true.
    legacySetupTrigger: isLegacySetupTriggerEnabled(),
  };

  // ── The reconnect sweep (self-join slice 6, plan 8) ────────────────
  // While an organiser's DM-verified request waits for its add, the Pi
  // looks, after a reconnect, for groups it is in that the server does not
  // know (an add it missed while offline) and posts each to bot-added with
  // `discovered: true`. `knownGroups` is every group the server already
  // knows, so the Pi reads none of them. null: nothing to look for. Absent
  // entirely while self-join is off, so the response is today's.
  if (selfJoinEnabledForApiRequest(request)) {
    let sweep: { knownGroups: string[] } | null = null;
    try {
      sweep = await loadSelfJoinSweep();
    } catch (err) {
      console.error("[orgs] self-join sweep query failed; no sweep this time:", err);
    }
    response.selfJoinSweep = sweep;
  }

  return NextResponse.json(response);
}
