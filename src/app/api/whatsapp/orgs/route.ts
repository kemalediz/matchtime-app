import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import {
  ACTIVE_ONBOARDING_STAGES,
  ONBOARDING_SESSION_TTL_MS,
} from "@/lib/onboarding-parse";

export async function GET(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgs = await db.organisation.findMany({
    where: {
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
  const onboarding = await db.onboardingSession.findMany({
    where: {
      stage: { in: [...ACTIVE_ONBOARDING_STAGES] },
      createdAt: { gt: new Date(Date.now() - ONBOARDING_SESSION_TTL_MS) },
    },
    select: { whatsappGroupId: true, groupName: true },
  });
  const known = new Set(orgs.map((o) => o.whatsappGroupId));
  const onboardingGroups = [
    ...new Set(onboarding.map((s) => s.whatsappGroupId).filter((g) => !known.has(g))),
  ];

  return NextResponse.json({ orgs, onboardingGroups });
}
