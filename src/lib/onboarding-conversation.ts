/**
 * Phase 2 — autonomous in-group onboarding conversation.
 *
 * Trigger: a moderator types "@MatchTime setup" in a group with no
 * org. The bot then runs a setup Q&A IN THE GROUP (anyone can answer).
 *
 * Design (matches the codebase principle "LLM for understanding,
 * deterministic code for control"):
 *   - The STATE MACHINE lives here in code: which fields are still
 *     missing decides the next question; stage transitions + every DB
 *     write are deterministic.
 *   - The LLM does ONE job per turn: read the recent messages + what
 *     we already know, and return any field values it can extract
 *     (event details) or the feature selection. It never decides flow.
 *   - Falls open: if the LLM errors, we re-ask the next missing
 *     question with static copy. Never blocks the group.
 *
 * Lifecycle:
 *   collecting → (all event fields gathered) → provision Organisation
 *   → features → (group picks modules) → create Sport/Activity/Match,
 *   set Phase-1 flags, whatsappBotEnabled=true → completed (the group
 *   is now a normal monitored org).
 */
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { SPORT_PRESETS } from "./sport-presets";
import { FEATURE_META, type ToggleableKey } from "./org-features-meta";
import { londonWallClockToUtc, londonDateTimeToUtc } from "./london-time";

const MODEL = "claude-haiku-4-5";

type Session = {
  id: string;
  whatsappGroupId: string;
  orgId: string | null;
  stage: string;
  groupName: string | null;
  venue: string | null;
  dayOfWeek: number | null;
  kickoffTime: string | null;
  playersPerSide: number | null;
  recurrence: string | null;
  oneOffDate: string | null;
  selectedFeatures: string[];
  lastHandledWaId: string | null;
};

export interface OnboardingTurnInput {
  session: Session;
  /** Oldest-first batch of fresh group messages since last handled. */
  messages: Array<{ waMessageId: string; authorName: string | null; body: string }>;
  groupSubject?: string | null;
}

export interface OnboardingTurnResult {
  /** Group reply to post (null = stay silent this turn). */
  reply: string | null;
  /** True once setup is finished and the org is live. */
  completed: boolean;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function getAnthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key ? new Anthropic({ apiKey: key }) : null;
}

const EXTRACT_PROMPT = `You extract structured setup answers from a WhatsApp group that is configuring the MatchTime bot. You DO NOT drive the conversation — you only pull values the humans have already stated. Output JSON only.

Schema:
{
  "groupName": <string|null>,        // a name for the club/group if stated ("we're Thursday Ballers")
  "venue": <string|null>,            // where they play ("Goals Star City", "PowerLeague Shoreditch")
  "dayOfWeek": <0-6|null>,           // 0=Sunday .. 6=Saturday, the regular match day
  "kickoffTime": <"HH:MM"|null>,     // 24h London local, e.g. "21:30" (convert "9:30pm")
  "playersPerSide": <int|null>,      // 7 for 7-a-side, 5 for 5-a-side, 11 for 11-a-side
  "recurrence": <"weekly"|"oneoff"|null>,
  "oneOffDate": <"YYYY-MM-DD"|null>, // only if recurrence is oneoff and a date was given
  "featureSelection": <string[]|null>, // ONLY when they're answering the feature menu; canonical keys below
  "confidence": 0..1
}

Canonical feature keys (use EXACTLY these in featureSelection): attendance, bench, teamBalancing, momVoting, playerRating, reminders, statsQa, paymentTracking.
- "MoM" / "man of the match" → momVoting
- "ratings" / "player ratings" → playerRating
- "everything" / "all" → all eight keys
- "everything except payments" → all except paymentTracking
Only set featureSelection when the latest messages are clearly answering "which features?". Otherwise null.

Rules:
- Extract only what is EXPLICITLY stated across the messages. Unknown → null. Never guess a venue or time.
- Multiple messages may each contribute different fields; merge them.
- "tuesdays" → dayOfWeek 2. "every week" → recurrence "weekly". "just this once" / a single date → "oneoff".
- Be conservative: confidence < 0.5 if it's chit-chat with no concrete answer.`;

interface Extracted {
  groupName: string | null;
  venue: string | null;
  dayOfWeek: number | null;
  kickoffTime: string | null;
  playersPerSide: number | null;
  recurrence: string | null;
  oneOffDate: string | null;
  featureSelection: string[] | null;
  confidence: number;
}

async function extract(
  session: Session,
  messages: OnboardingTurnInput["messages"],
): Promise<Extracted | null> {
  const anthropic = getAnthropic();
  if (!anthropic) return null;
  const known = {
    groupName: session.groupName,
    venue: session.venue,
    dayOfWeek: session.dayOfWeek,
    kickoffTime: session.kickoffTime,
    playersPerSide: session.playersPerSide,
    recurrence: session.recurrence,
    oneOffDate: session.oneOffDate,
    stage: session.stage,
  };
  const convo = messages
    .map((m) => `${m.authorName ?? "?"}: ${m.body.slice(0, 400)}`)
    .join("\n");
  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: [{ type: "text", text: EXTRACT_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: `Already collected (do not re-ask, but you may overwrite if they correct it):\n${JSON.stringify(known)}\n\nNew messages:\n${convo}\n\nReturn the JSON.`,
        },
      ],
    });
    const block = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!block) return null;
    const json = block.text.slice(block.text.indexOf("{"), block.text.lastIndexOf("}") + 1);
    return JSON.parse(json) as Extracted;
  } catch (err) {
    console.error("[onboarding] extract failed:", err);
    return null;
  }
}

/** Main turn handler. Pure-ish: it reads/writes the session + (on
 *  completion) provisions org/sport/activity/match, and returns the
 *  group reply to post. */
export async function handleOnboardingTurn(
  input: OnboardingTurnInput,
): Promise<OnboardingTurnResult> {
  const { session, messages } = input;
  if (messages.length === 0) return { reply: null, completed: false };

  const ex = await extract(session, messages);

  // ── Stage: collecting event details ──────────────────────────────
  if (session.stage === "collecting") {
    const data: Record<string, unknown> = {};
    if (ex && ex.confidence >= 0.5) {
      if (ex.groupName && !session.groupName) data.groupName = ex.groupName.slice(0, 80);
      if (ex.venue && !session.venue) data.venue = ex.venue.slice(0, 120);
      if (ex.dayOfWeek != null && session.dayOfWeek == null && ex.dayOfWeek >= 0 && ex.dayOfWeek <= 6)
        data.dayOfWeek = ex.dayOfWeek;
      if (ex.kickoffTime && !session.kickoffTime && /^\d{1,2}:\d{2}$/.test(ex.kickoffTime))
        data.kickoffTime = ex.kickoffTime;
      if (ex.playersPerSide && !session.playersPerSide && [5, 6, 7, 8, 11].includes(ex.playersPerSide))
        data.playersPerSide = ex.playersPerSide;
      if (ex.recurrence && !session.recurrence && ["weekly", "oneoff"].includes(ex.recurrence))
        data.recurrence = ex.recurrence;
      if (ex.oneOffDate && !session.oneOffDate && /^\d{4}-\d{2}-\d{2}$/.test(ex.oneOffDate))
        data.oneOffDate = ex.oneOffDate;
    }
    data.lastHandledWaId = messages[messages.length - 1].waMessageId;
    const merged = { ...session, ...data } as Session;
    await db.onboardingSession.update({ where: { id: session.id }, data });

    // Deterministic: ask for the first still-missing field.
    const ask = nextEventQuestion(merged);
    if (ask) return { reply: ask, completed: false };

    // All event fields gathered → provision the Organisation + Sport,
    // move to the feature menu.
    const reply = await provisionOrgAndAskFeatures(merged);
    return { reply, completed: false };
  }

  // ── Stage: feature menu ──────────────────────────────────────────
  if (session.stage === "features") {
    if (!ex || !ex.featureSelection || ex.featureSelection.length === 0) {
      // Couldn't read a selection — re-show the menu once.
      await db.onboardingSession.update({
        where: { id: session.id },
        data: { lastHandledWaId: messages[messages.length - 1].waMessageId },
      });
      return { reply: featureMenuText("I didn't catch which ones — reply with the features you want"), completed: false };
    }
    const valid = new Set<ToggleableKey>(FEATURE_META.map((f) => f.key));
    const chosen = [...new Set(ex.featureSelection)].filter((k): k is ToggleableKey =>
      valid.has(k as ToggleableKey),
    );
    if (chosen.length === 0) {
      return { reply: featureMenuText("Those didn't match anything — pick from this list"), completed: false };
    }
    const reply = await completeOnboarding(session, chosen);
    return { reply, completed: true };
  }

  return { reply: null, completed: false };
}

function nextEventQuestion(s: Session): string | null {
  if (!s.playersPerSide)
    return "👋 Let's get set up! First — how many players per side? (e.g. *7* for 7-a-side, *5* for 5-a-side)";
  if (s.dayOfWeek == null)
    return "Which *day of the week* do you usually play? (e.g. Thursday)";
  if (!s.kickoffTime)
    return "What *kickoff time*? (e.g. 9:30pm)";
  if (!s.venue) return "Where do you play — the *venue* name?";
  if (!s.recurrence)
    return "Is this a *weekly* fixture or a *one-off* match?";
  if (s.recurrence === "oneoff" && !s.oneOffDate)
    return "What *date* is the one-off match? (e.g. 2026-05-28)";
  return null;
}

function presetForSide(n: number) {
  return (
    SPORT_PRESETS.find((p) => p.key === `football-${n}aside`) ??
    SPORT_PRESETS.find((p) => p.playersPerTeam === n) ??
    SPORT_PRESETS.find((p) => p.key === "football-7aside")!
  );
}

function slugify(s: string): string {
  return (
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) ||
    `group-${Date.now().toString(36)}`
  );
}

function featureMenuText(lead: string): string {
  const lines = FEATURE_META.map((f, i) => `${i + 1}. *${f.label}* — ${f.blurb}`);
  return (
    `${lead}:\n\n${lines.join("\n")}\n\n` +
    `Reply with the ones you want — e.g. "Man of the Match and player ratings", ` +
    `"everything", or "all except payments".`
  );
}

async function provisionOrgAndAskFeatures(s: Session): Promise<string> {
  // Name: stated group name → else WhatsApp subject → else fallback.
  const name = (s.groupName || "New Club").trim();
  let slug = slugify(name);
  // Ensure slug uniqueness.
  for (let i = 0; i < 5; i++) {
    const clash = await db.organisation.findUnique({ where: { slug }, select: { id: true } });
    if (!clash) break;
    slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 5)}`;
  }
  const preset = presetForSide(s.playersPerSide ?? 7);

  const org = await db.organisation.create({
    data: {
      name,
      slug,
      whatsappGroupId: s.whatsappGroupId,
      // Stay OFF until the group picks features; flipped on at
      // completion so the bot doesn't start acting mid-setup.
      whatsappBotEnabled: false,
      sports: {
        create: {
          name: preset.name,
          preset: preset.key,
          playersPerTeam: preset.playersPerTeam,
          positions: [...preset.positions],
          teamLabels: [...preset.teamLabels],
          mvpLabel: preset.mvpLabel,
          balancingStrategy: preset.balancingStrategy,
          positionComposition: preset.positionComposition
            ? (preset.positionComposition as Record<string, number>)
            : undefined,
        },
      },
    },
  });
  await db.onboardingSession.update({
    where: { id: s.id },
    data: { orgId: org.id, stage: "features" },
  });
  return featureMenuText(
    `Nice — *${name}* is set up for *${preset.playersPerTeam}-a-side* on *${DOW[s.dayOfWeek ?? 0]}s ${s.kickoffTime}* at *${s.venue}*.\n\nLast step: which features do you want? Here's everything I can do`,
  );
}

async function completeOnboarding(
  s: Session,
  chosen: ToggleableKey[],
): Promise<string> {
  const orgId = s.orgId!;
  const sport = await db.sport.findFirst({ where: { orgId }, select: { id: true, playersPerTeam: true } });
  if (!sport) throw new Error("onboarding: sport missing at completion");

  const chosenSet = new Set(chosen);
  // Map selection → the Phase-1 columns. Anything not chosen = off.
  const featureData = {
    featureAttendance: chosenSet.has("attendance"),
    featureBench: chosenSet.has("bench"),
    featureTeamBalancing: chosenSet.has("teamBalancing"),
    featureMomVoting: chosenSet.has("momVoting"),
    featurePlayerRating: chosenSet.has("playerRating"),
    featureReminders: chosenSet.has("reminders"),
    featureStatsQa: chosenSet.has("statsQa"),
    paymentTrackingEnabled: chosenSet.has("paymentTracking"),
  };

  // Activity. Weekly fixtures stay isActive so the generate-matches
  // cron rolls a fresh match each week; one-offs are isActive=false
  // with a single explicit Match.
  const weekly = s.recurrence !== "oneoff";
  const activity = await db.activity.create({
    data: {
      orgId,
      sportId: sport.id,
      name: s.groupName || "Match",
      dayOfWeek: s.dayOfWeek ?? 2,
      time: s.kickoffTime ?? "21:00",
      venue: s.venue ?? "TBD",
      isActive: weekly,
    },
  });

  // First match: next occurrence of dayOfWeek (weekly) or the given
  // one-off date, at kickoffTime London.
  const time = s.kickoffTime ?? "21:00";
  let matchDate: Date;
  if (!weekly && s.oneOffDate) {
    matchDate = londonDateTimeToUtc(s.oneOffDate, time);
  } else {
    const now = new Date();
    const target = s.dayOfWeek ?? 2;
    const d = new Date(now);
    const delta = (target - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + delta);
    matchDate = londonWallClockToUtc(d, time);
  }
  const maxPlayers = sport.playersPerTeam * 2;
  await db.match.create({
    data: {
      activityId: activity.id,
      date: matchDate,
      maxPlayers,
      attendanceDeadline: matchDate,
      status: "UPCOMING",
    },
  });

  await db.$transaction([
    db.organisation.update({
      where: { id: orgId },
      data: { ...featureData, whatsappBotEnabled: true },
    }),
    db.onboardingSession.update({
      where: { id: s.id },
      data: { stage: "completed", selectedFeatures: chosen },
    }),
  ]);

  const onLabels = FEATURE_META.filter((f) => chosenSet.has(f.key)).map((f) => f.label);
  return (
    `✅ *All set!* I'm now running for this group with: *${onLabels.join(", ")}*.\n\n` +
    `First match: *${DOW[s.dayOfWeek ?? 2]} ${s.kickoffTime}* at *${s.venue}*` +
    `${weekly ? " (every week)" : ""}.\n\n` +
    `That's it — I'll take it from here. Anyone can just chat normally; I'll handle the rest. ⚽`
  );
}
