import { db } from "@/lib/db";
import { NextResponse } from "next/server";

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

  // Phase 2: groups mid-onboarding (no bot-enabled org yet) must stay
  // monitored across a bot restart, otherwise an in-progress setup
  // stalls until the moderator re-triggers. Surface their group ids;
  // the bot adds them to the monitored set so onboarding answers keep
  // flowing through /analyze (which routes them to the onboarding
  // handler until the session completes).
  const onboarding = await db.onboardingSession.findMany({
    where: { stage: { in: ["collecting", "features"] } },
    select: { whatsappGroupId: true, groupName: true },
  });
  const known = new Set(orgs.map((o) => o.whatsappGroupId));
  const onboardingGroups = onboarding
    .map((s) => s.whatsappGroupId)
    .filter((g) => !known.has(g));

  return NextResponse.json({ orgs, onboardingGroups });
}
