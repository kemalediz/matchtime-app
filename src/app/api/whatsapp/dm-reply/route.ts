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
  const { phone, body: text, waMessageId, authorName } = body as {
    phone?: string;
    body?: string;
    waMessageId?: string;
    authorName?: string;
  };
  if (!text || !waMessageId) {
    return NextResponse.json({ error: "body, waMessageId required" }, { status: 400 });
  }

  // Try phone first (most accurate). Falls through to pushname-based
  // resolution when phone is empty or doesn't match any User —
  // happens when WhatsApp's @lid privacy mode hides the sender's
  // real phone from the chat ID.
  let user: {
    id: string;
    name: string | null;
    memberships: { orgId: string }[];
  } | null = null;

  if (phone && phone.trim().length > 0) {
    const normalised = normalisePhone(phone);
    if (normalised) {
      user = await db.user.findUnique({
        where: { phoneNumber: normalised },
        select: { id: true, name: true, memberships: { select: { orgId: true } } },
      });
    }
  }

  if (!user && authorName && authorName.trim().length >= 2) {
    // Pushname-based fallback. Scope to users who currently have an
    // OPEN RosterSurveyDM so we're not guessing across the whole
    // user base. Match first-name fuzzy with relaxed prefix —
    // identical heuristic to the analyze-route resolver.
    const norm = (s: string) =>
      s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const pushFirst = norm(authorName).split(/\s+/).filter(Boolean)[0] ?? "";

    const candidates = await db.rosterSurveyDM.findMany({
      where: { survey: { status: "open" } },
      include: { user: { select: { id: true, name: true, memberships: { select: { orgId: true } } } } },
    });

    const equals = candidates.filter(
      (c) => c.user.name && norm(c.user.name) === norm(authorName),
    );
    let pick = equals.length === 1 ? equals[0] : null;
    if (!pick) {
      const byFirst = candidates.filter((c) => {
        if (!c.user.name) return false;
        const dbFirst = norm(c.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
        return (
          dbFirst === pushFirst ||
          (dbFirst.length >= 3 && pushFirst.length >= 2 && dbFirst.startsWith(pushFirst)) ||
          (pushFirst.length >= 3 && dbFirst.length >= 2 && pushFirst.startsWith(dbFirst))
        );
      });
      if (byFirst.length === 1) pick = byFirst[0];
    }
    if (pick) {
      user = pick.user;
    }
  }

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
  // Resolve a phone for the outbound confirmation/clarification DM.
  // Prefer the User's stored phoneNumber (canonical) over whatever
  // came in on the request — the request may have been an @lid DM
  // with no phone at all. If the user has no phone on file we just
  // can't DM them back; we still save the response and return.
  const userPhone = await db.user.findUnique({
    where: { id: user.id },
    select: { phoneNumber: true },
  });
  const phoneNoPlus = userPhone?.phoneNumber?.replace(/^\+/, "") ?? null;

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
    if (phoneNoPlus) {
      await db.botJob.create({
        data: {
          orgId: dm.survey.org.id,
          kind: "dm",
          phone: phoneNoPlus,
          text: clarification,
        },
      });
    } else {
      console.warn(
        `[dm-reply] no phone on file for user ${user.id}; clarification not sent`,
      );
    }
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
    confirmation = `Got it ${firstName}, marked you as maybe 👍 — just say *IN* in the group whenever you want to play that week, no need to confirm in advance.`;
  } else {
    // "out"
    confirmation = `No worries ${firstName}, noted you're stepping back. The admins will tidy up the roster at the end of the week. If you change your mind before then, just message back here 🙏`;
  }
  if (phoneNoPlus) {
    await db.botJob.create({
      data: {
        orgId: dm.survey.org.id,
        kind: "dm",
        phone: phoneNoPlus,
        text: confirmation,
      },
    });
  } else {
    console.warn(
      `[dm-reply] no phone on file for user ${user.id}; confirmation not sent (response saved)`,
    );
  }

  return NextResponse.json({
    ok: true,
    action: "recorded",
    category: classification.category,
    confidence: classification.confidence,
  });
}
