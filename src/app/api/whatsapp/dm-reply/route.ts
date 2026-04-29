/**
 * Bot forwards every incoming 1-1 DM here. The server figures out
 * what to do with it. Today: the only DM-reply behaviour that exists
 * is the roster check-in survey. Future expansions (DM-based score
 * entry, DM-based attendance, etc.) live alongside that.
 *
 * Flow for roster surveys:
 *   1. Resolve sender phone → User.
 *   2. Find any open RosterSurvey for any of the user's orgs that
 *      has a matching RosterSurveyDM row (i.e. they actually got
 *      DM'd a check-in question).
 *   3. Classify the reply via Claude (in / maybe / out / unclear).
 *   4. If clear → upsert RosterSurveyResponse + queue a confirmation
 *      DM via BotJob.
 *      If unclear → no response stored; queue a clarification DM
 *      that re-anchors the question on the survey.
 *   5. Return 200 either way (we always ACK so the bot doesn't
 *      retry).
 *
 * If no active survey applies, the DM is silently ignored.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { classifyRosterReply } from "@/lib/roster-survey-classifier";

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { phone, body: text, waMessageId } = body as {
    phone?: string;
    body?: string;
    waMessageId?: string;
  };
  if (!phone || !text || !waMessageId) {
    return NextResponse.json({ error: "phone, body, waMessageId required" }, { status: 400 });
  }

  const normalised = normalisePhone(phone);
  if (!normalised) {
    return NextResponse.json({ ok: true, ignored: "bad-phone" });
  }
  const user = await db.user.findUnique({
    where: { phoneNumber: normalised },
    select: { id: true, name: true, memberships: { select: { orgId: true } } },
  });
  if (!user) {
    return NextResponse.json({ ok: true, ignored: "unknown-sender" });
  }

  // Find an active RosterSurveyDM for this user. There SHOULD be at
  // most one open survey per (user, org) at a time. If multiple
  // exist, pick the most recent.
  const dm = await db.rosterSurveyDM.findFirst({
    where: {
      userId: user.id,
      survey: { status: "open" },
    },
    include: {
      survey: { include: { org: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!dm) {
    return NextResponse.json({ ok: true, ignored: "no-open-survey" });
  }

  const classification = await classifyRosterReply(text, {
    playerName: user.name,
    clubName: dm.survey.org.name,
  });

  const firstName = user.name?.split(/\s+/)[0] ?? "mate";
  const phoneNoPlus = normalised.replace(/^\+/, "");

  if (classification.category === "unclear") {
    // Don't save a response yet — re-ask politely with the original
    // context so they know what we're checking on.
    const clarification = [
      `Sorry ${firstName} — wasn't sure if that was a reply to the roster check-in for *${dm.survey.org.name}* (the Tuesday football WhatsApp group).`,
      ``,
      `Was your answer:`,
      `• yes / I'm in`,
      `• maybe / sometimes`,
      `• not for now / out`,
      ``,
      `Quick word back is enough 🙏`,
    ].join("\n");
    await db.botJob.create({
      data: {
        orgId: dm.survey.org.id,
        kind: "dm",
        phone: phoneNoPlus,
        text: clarification,
      },
    });
    return NextResponse.json({
      ok: true,
      action: "clarification-sent",
      classification,
    });
  }

  // Save (or upsert — latest reply wins, but admin overrides stick).
  // Don't overwrite a response the admin manually set.
  const existing = await db.rosterSurveyResponse.findUnique({
    where: { surveyId_userId: { surveyId: dm.surveyId, userId: user.id } },
  });
  if (existing?.adminOverride) {
    return NextResponse.json({
      ok: true,
      ignored: "admin-override-locked",
      classification,
    });
  }
  await db.rosterSurveyResponse.upsert({
    where: { surveyId_userId: { surveyId: dm.surveyId, userId: user.id } },
    create: {
      surveyId: dm.surveyId,
      userId: user.id,
      response: classification.category,
      rawReply: text,
    },
    update: {
      response: classification.category,
      rawReply: text,
      classifiedAt: new Date(),
    },
  });

  // Confirmation DM. Tone matches what we drafted with Kemal.
  let confirmation: string;
  if (classification.category === "in") {
    confirmation = `Got it ${firstName}, marked you as in 👍 — thanks!`;
  } else if (classification.category === "maybe") {
    confirmation = `Got it ${firstName}, marked you as maybe — we'll pencil you in case-by-case 👍`;
  } else {
    // "out"
    confirmation = `No worries ${firstName}, marked you as stepping back. Thanks for letting us know — we'll take you off the regulars list. If you ever change your mind, message any of the admins and they'll add you back in 🙏`;
  }
  await db.botJob.create({
    data: {
      orgId: dm.survey.org.id,
      kind: "dm",
      phone: phoneNoPlus,
      text: confirmation,
    },
  });

  return NextResponse.json({
    ok: true,
    action: "recorded",
    category: classification.category,
    confidence: classification.confidence,
  });
}
