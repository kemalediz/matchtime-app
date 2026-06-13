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
 * Lifecycle (legacy "@MatchTime setup" flow):
 *   collecting → (all event fields gathered) → provision Organisation
 *   → features → (group picks modules) → create Sport/Activity/Match,
 *   set Phase-1 flags, whatsappBotEnabled=true → completed (the group
 *   is now a normal monitored org).
 *
 * Lifecycle (Phase 1 autonomous group-add flow, 2026-06-12 design —
 * gated behind ONBOARDING_AUTOSTART at the /bot-added entry point):
 *   introduced → (YES / EVERYTHING / named-features consent reply;
 *   replier becomes the captured admin) → details → (one combined
 *   "when & where do you play?" answer; weekly + 7-a-side defaults)
 *   → provision org → completed, which ALSO: creates an OWNER
 *   Membership for the captured admin, imports the participant
 *   snapshot into the roster, and DMs the admin a magic link into
 *   /admin.
 */
import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { SPORT_PRESETS } from "./sport-presets";
import { FEATURE_META, type ToggleableKey } from "./org-features-meta";
import { londonWallClockToUtc, londonDateTimeToUtc } from "./london-time";
import { normalisePhone } from "./phone";
import { signMagicLinkToken, MAGIC_LINK_TTL } from "./magic-link";
import { buildShortMagicLinkUrl } from "./short-link";
import {
  importParticipants,
  parseParticipantSnapshot,
} from "./participant-sync";
import {
  regexExtract,
  parseBundleReply,
  extractWhenWhere,
  detailsStillMissing,
  detailsFollowUpQuestion,
  type Extracted,
} from "./onboarding-parse";

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
  // Phase 1 group-add columns (additive; null on legacy sessions).
  source?: string | null;
  groupSubject?: string | null;
  addedByPhone?: string | null;
  adminUserId?: string | null;
  participants?: unknown;
};

export interface OnboardingTurnInput {
  session: Session;
  /** Oldest-first batch of fresh group messages since last handled.
   *  `authorPhone` is the sender's phone as the bot forwards it
   *  (digits, no "+"; empty string for @lid privacy senders). */
  messages: Array<{
    waMessageId: string;
    authorName: string | null;
    body: string;
    authorPhone?: string | null;
  }>;
  groupSubject?: string | null;
}

export interface OnboardingTurnResult {
  /** Group reply to post (null = stay silent this turn). */
  reply: string | null;
  /** True once setup is finished and the org is live. */
  completed: boolean;
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Self-introduction the bot leads with the very first time it speaks in
 * a brand-new group (the opening onboarding turn). It sells the core
 * features so players actually WANT it switched on, THEN slides into the
 * setup Q&A. Feature-agnostic on purpose — at this point no org/feature
 * choice exists yet; the post-setup `botIntroMessage` is the
 * feature-accurate one. Kept tight: long enough to be compelling, short
 * enough that nobody scrolls past it.
 */
const INTRO =
  `👋 *Hey, I'm MatchTime* — the automatic organiser for your football group. ` +
  `I take the weekly admin off your hands so you can just turn up and play.\n\n` +
  `Here's what I do:\n` +
  `⚽ *Attendance* — players just say "in" or "out" right here; I keep the squad list live and chase the stragglers\n` +
  `⚖️ *Fair teams* — auto-balanced sides every week from real player ratings\n` +
  `🪑 *Smart bench* — squad full? I offer the spot to the whole bench, first to claim it plays. Nobody's ever dropped for being asleep\n` +
  `🏆 *Man of the Match & ratings* — a quick post-match vote and a one-tap rating link, no app to install\n` +
  `⏰ *Reminders & stats* — "@MatchTime remind me Thursday", or ask me "who got MoM last week?"\n\n` +
  `No spreadsheets, no chasing, no admin headaches. ⚡\n\n` +
  `Let's get you set up — takes about a minute:`;

function withIntro(question: string): string {
  return `${INTRO}\n\n${question}`;
}

/**
 * Intro posted the moment the bot is ADDED to a group (Phase 1
 * group-add flow — design §B.3). Skimmable, non-native-friendly; one
 * question that doubles as consent + feature selection + admin capture.
 * The recommended bundle ("YES") is the first option so it's the path
 * of least resistance; payments are explicitly optional; the opt-out
 * line keeps the falls-open promise.
 */
export const BOT_ADDED_INTRO =
  `👋 Hey! I'm *MatchTime* — I run the boring parts of your game so nobody has to.\n\n` +
  `Here's what I can do:\n` +
  `⚽ *Squad list* — say "in" or "out" here; I keep the list and chase when we're short\n` +
  `⚖️ *Fair teams* — balanced sides from real player ratings, posted before kickoff\n` +
  `🪑 *Bench* — someone drops? I offer the spot; first to claim it plays\n` +
  `🏆 *Man of the Match + ratings* — quick vote and a one-tap rating link after each game. No app to install\n` +
  `💳 *Payments* — I track who's paid, or collect match fees by link _(optional)_\n` +
  `⏰ *Reminders & stats* — "remind me Thursday", "who won MoM last week?"\n\n` +
  `*Want me running here?* Whoever runs this group, just reply:\n` +
  `• *YES* — switches on the usual setup (squad list, fair teams, bench, MoM, ratings, reminders)\n` +
  `• *EVERYTHING* — the lot, including payment tracking\n` +
  `• or name just the parts you want — e.g. _"just MoM and ratings"_\n\n` +
  `Not interested? Ignore me and I'll stay quiet. 🤐`;

/**
 * Find-or-create a User for a bot-forwarded phone (digits, usually no
 * "+"). Same placeholder-email pattern as the group-join route, so the
 * admin can fill name/email in later. Returns null when the phone
 * can't be normalised (@lid senders forward an empty phone).
 */
async function ensureUserForPhone(rawPhone: string): Promise<string | null> {
  const withPlus = rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`;
  const phone = normalisePhone(withPlus);
  if (!phone) return null;
  const existing = await db.user.findUnique({
    where: { phoneNumber: phone },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const created = await db.user.create({
      data: {
        name: null,
        email: `wa-${phone.replace(/^\+/, "")}@placeholder.matchtime`,
        phoneNumber: phone,
        onboarded: false,
        isActive: true,
      },
      select: { id: true },
    });
    return created.id;
  } catch {
    // Unique race (phone or placeholder email already taken) — re-read.
    const again = await db.user.findUnique({
      where: { phoneNumber: phone },
      select: { id: true },
    });
    return again?.id ?? null;
  }
}

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

async function extract(
  session: Session,
  messages: OnboardingTurnInput["messages"],
): Promise<Extracted | null> {
  const anthropic = getAnthropic();
  // Deterministic fallback when the LLM is unavailable (no key /
  // outage / error) so onboarding still progresses instead of looping
  // the first question forever. Event answers are formulaic enough to
  // regex; venue is handled by the "sole missing field" heuristic in
  // the collecting branch.
  if (!anthropic) return regexExtract(messages);
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
    if (!block) return regexExtract(messages);
    const json = block.text.slice(block.text.indexOf("{"), block.text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as Extracted;
    // Backfill anything the LLM left null with a regex pass — makes
    // extraction stickier (covers LLM misses on terse answers) and
    // means a partial LLM failure still advances the flow.
    const rx = regexExtract(messages);
    return {
      groupName: parsed.groupName ?? rx.groupName,
      venue: parsed.venue ?? rx.venue,
      dayOfWeek: parsed.dayOfWeek ?? rx.dayOfWeek,
      kickoffTime: parsed.kickoffTime ?? rx.kickoffTime,
      playersPerSide: parsed.playersPerSide ?? rx.playersPerSide,
      recurrence: parsed.recurrence ?? rx.recurrence,
      oneOffDate: parsed.oneOffDate ?? rx.oneOffDate,
      featureSelection: parsed.featureSelection ?? rx.featureSelection,
      confidence: Math.max(parsed.confidence ?? 0, rx.confidence),
    };
  } catch (err) {
    console.error("[onboarding] extract failed:", err);
    return regexExtract(messages);
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

  // Opening turn = the bot has never spoken in this group yet (session
  // freshly created by the "@MatchTime setup" trigger; nothing handled,
  // nothing collected). On this turn ONLY we lead with the self-intro
  // so the group hears what MatchTime is before any question.
  const isOpening =
    session.stage === "collecting" &&
    session.lastHandledWaId == null &&
    !session.groupName;

  const lastWaId = messages[messages.length - 1].waMessageId;

  // ── Stage: introduced (group-add flow) ───────────────────────────
  // The bot has posted its add-time intro and is waiting for a
  // consent/bundle reply. Pure-deterministic parsing (no LLM): a
  // standalone YES / EVERYTHING / named-features message advances to
  // `details`; anything else is ordinary group chat and the bot stays
  // SILENT (falls open — the group is never spammed).
  if (session.stage === "introduced") {
    let consent: { features: ToggleableKey[]; authorPhone: string | null } | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const bundle = parseBundleReply(messages[i].body);
      if (bundle) {
        consent = {
          features: bundle.features,
          authorPhone: messages[i].authorPhone?.trim() || null,
        };
        break;
      }
    }
    if (!consent) {
      await db.onboardingSession.update({
        where: { id: session.id },
        data: { lastHandledWaId: lastWaId },
      });
      return { reply: null, completed: false };
    }

    // Admin capture: the consent replier's phone, falling back to
    // whoever added the bot. @lid replier with no resolvable phone and
    // no adder phone → park admin assignment (completion still works;
    // the dashboard /claim flow picks it up later).
    let adminUserId = session.adminUserId ?? null;
    if (!adminUserId) {
      const adminPhone = consent.authorPhone || session.addedByPhone || null;
      if (adminPhone) adminUserId = await ensureUserForPhone(adminPhone);
    }

    await db.onboardingSession.update({
      where: { id: session.id },
      data: {
        stage: "details",
        selectedFeatures: consent.features,
        // Group subject = club name: never ask what we already know.
        groupName:
          session.groupName ?? session.groupSubject?.slice(0, 80) ?? null,
        adminUserId,
        lastHandledWaId: lastWaId,
      },
    });

    const lead = adminUserId
      ? "Done — you're the admin 🎽"
      : "Done ✅";
    return {
      reply: `${lead} ${detailsFollowUpQuestion(["day", "time", "venue"])}`,
      completed: false,
    };
  }

  const ex = await extract(session, messages);

  // ── Stage: details (group-add flow) ──────────────────────────────
  // One combined "when & where do you play?" answer. Multi-field
  // extraction (deterministic first, LLM backfill); only day/time/
  // venue are mandatory — recurrence defaults to weekly and format to
  // 7-a-side at completion. Venue is FREE TEXT (no geocoding, Phase 1).
  if (session.stage === "details") {
    const joined = messages.map((m) => m.body).join("  ");
    const ww = extractWhenWhere(joined);

    const data: Record<string, unknown> = {};
    if (
      session.dayOfWeek == null &&
      (ww.dayOfWeek ?? ex?.dayOfWeek) != null
    ) {
      const d = (ww.dayOfWeek ?? ex?.dayOfWeek)!;
      if (d >= 0 && d <= 6) data.dayOfWeek = d;
    }
    {
      const t = ww.kickoffTime ?? ex?.kickoffTime ?? null;
      if (!session.kickoffTime && t && /^\d{1,2}:\d{2}$/.test(t))
        data.kickoffTime = t;
    }
    {
      const v = ww.venue ?? ex?.venue ?? null;
      if (!session.venue && v) data.venue = v.slice(0, 120);
    }
    {
      const p = ww.playersPerSide ?? ex?.playersPerSide ?? null;
      if (!session.playersPerSide && p && p >= 4 && p <= 16)
        data.playersPerSide = p;
    }
    {
      const r = ww.recurrence ?? ex?.recurrence ?? null;
      if (!session.recurrence && r && ["weekly", "oneoff"].includes(r))
        data.recurrence = r;
    }
    {
      const o = ww.oneOffDate ?? ex?.oneOffDate ?? null;
      if (!session.oneOffDate && o && /^\d{4}-\d{2}-\d{2}$/.test(o))
        data.oneOffDate = o;
    }

    // "Currently-asked field" heuristic (mirrors the collecting stage):
    // once day+time are known and ONLY the venue is missing, a short
    // free-text reply with no structured fields IS the venue.
    const merged0 = { ...session, ...data } as Session;
    const lastBody = messages[messages.length - 1].body.trim();
    if (
      !merged0.venue &&
      merged0.dayOfWeek != null &&
      merged0.kickoffTime &&
      Object.keys(data).length === 0 &&
      lastBody.length >= 2 &&
      lastBody.length <= 80 &&
      !/^\d+$/.test(lastBody)
    ) {
      data.venue = lastBody.slice(0, 120);
    }

    data.lastHandledWaId = lastWaId;
    let merged = { ...session, ...data } as Session;
    await db.onboardingSession.update({ where: { id: session.id }, data });

    const missing = detailsStillMissing(merged);
    if (missing.length > 0) {
      // Re-ask only for the gaps — but stay silent when this batch
      // contributed nothing at all (ordinary chat between answers).
      const contributed = Object.keys(data).some((k) => k !== "lastHandledWaId");
      if (!contributed && missing.length === 3) {
        return { reply: null, completed: false };
      }
      return { reply: detailsFollowUpQuestion(missing), completed: false };
    }

    // Defaults policy: weekly + 7-a-side unless stated otherwise.
    const defaults: Record<string, unknown> = {};
    if (!merged.recurrence) defaults.recurrence = "weekly";
    if (!merged.playersPerSide) defaults.playersPerSide = 7;
    if (Object.keys(defaults).length > 0) {
      await db.onboardingSession.update({ where: { id: session.id }, data: defaults });
      merged = { ...merged, ...defaults } as Session;
    }

    // Provision the Organisation + Sport, then run the full completion
    // (features, Activity, first Match, OWNER membership, roster
    // import, admin magic-link DM).
    const orgId = await provisionOrg(merged);
    merged = { ...merged, orgId };
    const valid = new Set<ToggleableKey>(FEATURE_META.map((f) => f.key));
    const chosen = [...new Set(merged.selectedFeatures)].filter(
      (k): k is ToggleableKey => valid.has(k as ToggleableKey),
    );
    const reply = await completeOnboarding(merged, chosen);
    return { reply, completed: true };
  }

  // ── Stage: collecting event details ──────────────────────────────
  if (session.stage === "collecting") {
    const data: Record<string, unknown> = {};
    // No global confidence gate — each field has its own format
    // validator, and a present concrete value IS the signal (the old
    // `confidence >= 0.5` gate dropped terse answers → Q1 loop).
    //
    // Structured fields only auto-fill an UNSET field. Overwriting an
    // already-set field requires an explicit correction cue in the
    // message — otherwise a day word that incidentally appears in a
    // later answer (venue "Tuesday Sports Centre", a one-off date
    // "Saturday the 5th") would silently clobber the real value.
    // "actually make it 7 a side" still works (has a cue).
    const correctionCue =
      /\b(actually|instead|change it|change that|make it|no wait|correction|rather|scrap that|i meant|sorry i meant)\b/i.test(
        messages.map((m) => m.body).join(" "),
      );
    const canSet = (cur: unknown) => cur == null || correctionCue;
    if (ex) {
      if (ex.groupName && !session.groupName && ex.confidence >= 0.5)
        data.groupName = ex.groupName.slice(0, 80);
      if (ex.venue && !session.venue) data.venue = ex.venue.slice(0, 120);
      if (
        ex.dayOfWeek != null && ex.dayOfWeek >= 0 && ex.dayOfWeek <= 6 &&
        canSet(session.dayOfWeek)
      )
        data.dayOfWeek = ex.dayOfWeek;
      if (
        ex.kickoffTime && /^\d{1,2}:\d{2}$/.test(ex.kickoffTime) &&
        canSet(session.kickoffTime)
      )
        data.kickoffTime = ex.kickoffTime;
      if (
        ex.playersPerSide && ex.playersPerSide >= 4 && ex.playersPerSide <= 16 &&
        canSet(session.playersPerSide)
      )
        data.playersPerSide = ex.playersPerSide;
      if (
        ex.recurrence && ["weekly", "oneoff"].includes(ex.recurrence) &&
        canSet(session.recurrence)
      )
        data.recurrence = ex.recurrence;
      if (
        ex.oneOffDate && /^\d{4}-\d{2}-\d{2}$/.test(ex.oneOffDate) &&
        canSet(session.oneOffDate)
      )
        data.oneOffDate = ex.oneOffDate;
    }

    // Venue "currently-asked field" heuristic: nextEventQuestion asks
    // venue 4th (after players/day/time, BEFORE recurrence), so once
    // those three are known and venue is still blank the next answer
    // to "where do you play?" IS the venue — take it verbatim (covers
    // a bare "PowerLeague Shoreditch", and works with no LLM). Guard
    // must mirror the question ORDER, not require later fields.
    const structuredKeysThisTurn = Object.keys(data).filter(
      (k) => k !== "lastHandledWaId",
    );
    const lastBody = messages[messages.length - 1].body.trim();
    const looksLikeTrigger = /match\s*time|set\s*up|setup|get\s*started|onboard/i.test(
      lastBody,
    );

    // groupName "currently-asked field" capture. groupName is Q1, so
    // when it's still unset the bot is literally asking "what should I
    // call your club?" — the reply IS the name. Do it
    // deterministically (not LLM-dependent): the LLM is unreliable on
    // bare names like
    // "Test FC Two" with no "we're …" lead-in, and a missed Q1 shifts
    // the whole conversation. Safe because at Q1 nothing else is set,
    // and we exclude the trigger message + any turn that parsed a
    // structured field. A stray chitchat answer here is recoverable
    // (admin renames) — far better than a re-ask loop.
    if (
      !session.groupName &&
      !data.groupName &&
      !looksLikeTrigger &&
      structuredKeysThisTurn.length === 0 &&
      lastBody.length >= 2 &&
      lastBody.length <= 60
    ) {
      data.groupName = lastBody.slice(0, 80);
    }

    // Venue "currently-asked field" heuristic: nextEventQuestion asks
    // venue after players/day/time and BEFORE recurrence, so once
    // those are known (in a PRIOR turn) and venue is still blank, a
    // short free-text answer IS the venue.
    if (
      !session.venue &&
      !data.venue &&
      session.groupName &&
      session.playersPerSide &&
      session.dayOfWeek != null &&
      session.kickoffTime &&
      structuredKeysThisTurn.length === 0 &&
      !looksLikeTrigger
    ) {
      if (lastBody.length >= 2 && lastBody.length <= 80 && !/^\d+$/.test(lastBody)) {
        data.venue = lastBody.slice(0, 120);
      }
    }

    data.lastHandledWaId = messages[messages.length - 1].waMessageId;
    const merged = { ...session, ...data } as Session;
    await db.onboardingSession.update({ where: { id: session.id }, data });

    // Deterministic: ask for the first still-missing field.
    const ask = nextEventQuestion(merged);
    if (ask) return { reply: isOpening ? withIntro(ask) : ask, completed: false };

    // All event fields gathered → provision the Organisation + Sport,
    // move to the feature menu.
    const reply = await provisionOrgAndAskFeatures(merged);
    return { reply: isOpening ? withIntro(reply) : reply, completed: false };
  }

  // ── Stage: feature menu ──────────────────────────────────────────
  if (session.stage === "features") {
    // Deterministic-FIRST selection. The menu reply is an explicit
    // pick ("options 4 and 5", "everything", "MoM and ratings") which
    // the regex maps with high precision (numbers → menu order,
    // keywords → features, "everything [except payments]"). The LLM
    // is only the fallback for vague phrasing — and crucially we must
    // NOT let a wrong-but-non-null LLM selection override the regex
    // (the `?? ` bug that failed numbered_feature_pick).
    const rxSel = regexExtract(messages).featureSelection ?? [];
    const llmSel = ex?.featureSelection ?? [];
    const rawSel = rxSel.length > 0 ? rxSel : llmSel;
    const valid = new Set<ToggleableKey>(FEATURE_META.map((f) => f.key));
    const chosen = [...new Set(rawSel)].filter((k): k is ToggleableKey =>
      valid.has(k as ToggleableKey),
    );
    if (chosen.length === 0) {
      // Genuinely couldn't read a pick — re-show the menu (not silent;
      // a distinct user message each time so it's a real re-prompt,
      // not a loop).
      await db.onboardingSession.update({
        where: { id: session.id },
        data: { lastHandledWaId: messages[messages.length - 1].waMessageId },
      });
      return {
        reply: featureMenuText(
          "I didn't catch which ones — reply with the features you want",
        ),
        completed: false,
      };
    }
    // Admin capture for the legacy flow too (design: "admin = whoever
    // gave the feature/consent reply"). Best-effort — the feature pick
    // is almost always the batch's last message; take the most recent
    // sender with a resolvable phone. Falls back to no admin exactly
    // like before, so this can only ADD an OWNER, never break a flow.
    let adminUserId: string | null = session.adminUserId ?? null;
    if (!adminUserId) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const p = messages[i].authorPhone?.trim();
        if (p) {
          adminUserId = await ensureUserForPhone(p);
          if (adminUserId) break;
        }
      }
    }
    const reply = await completeOnboarding(session, chosen, adminUserId);
    return { reply, completed: true };
  }

  return { reply: null, completed: false };
}

function nextEventQuestion(s: Session): string | null {
  if (!s.groupName)
    return "👋 Let's get MatchTime set up for this group! First — what should I call your club/group? (e.g. *Thursday Ballers*)";
  if (!s.playersPerSide)
    return `Great, *${s.groupName}* it is. How many players per side? (e.g. *7* for 7-a-side, *5* for 5-a-side)`;
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

/** Create the Organisation + Sport for a gathered session and stamp
 *  `orgId` on the session. Shared by the legacy flow (which then asks
 *  the feature menu) and the group-add flow (which already has the
 *  feature selection and completes immediately). */
async function provisionOrg(s: Session): Promise<string> {
  // Name: stated group name → else WhatsApp subject → else fallback.
  const name = (s.groupName || s.groupSubject || "New Club").trim();
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
      // Stay OFF until completion so the bot doesn't start acting
      // mid-setup.
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
    data: { orgId: org.id },
  });
  return org.id;
}

async function provisionOrgAndAskFeatures(s: Session): Promise<string> {
  await provisionOrg(s);
  await db.onboardingSession.update({
    where: { id: s.id },
    data: { stage: "features" },
  });
  const name = (s.groupName || "New Club").trim();
  const preset = presetForSide(s.playersPerSide ?? 7);
  return featureMenuText(
    `Nice — *${name}* is set up for *${preset.playersPerTeam}-a-side* on *${DOW[s.dayOfWeek ?? 0]}s ${s.kickoffTime}* at *${s.venue}*.\n\nLast step: which features do you want? Here's everything I can do`,
  );
}

async function completeOnboarding(
  s: Session,
  chosen: ToggleableKey[],
  adminUserIdOverride?: string | null,
): Promise<string> {
  const orgId = s.orgId!;
  const adminUserId = adminUserIdOverride ?? s.adminUserId ?? null;
  const sport = await db.sport.findFirst({ where: { orgId }, select: { id: true, playersPerTeam: true } });
  if (!sport) throw new Error("onboarding: sport missing at completion");

  const chosenSet = new Set(chosen);
  // Map selection → the Phase-1 columns. Anything not chosen = off.
  //
  // `featureSquadFromList` is derived, not menu-picked: it's ON when
  // the group wants MoM or ratings but NOT attendance — they don't
  // tell the bot in/out, so the bot reads the squad off whatever
  // numbered list they paste. (Amir's Thursday group, 2026-05-20.)
  // Sutton has attendance on, so this stays OFF for them.
  const needsAttendance = chosenSet.has("attendance");
  const needsPostMatchPersonalisation =
    chosenSet.has("momVoting") || chosenSet.has("playerRating");
  const featureData = {
    featureAttendance: needsAttendance,
    featureBench: chosenSet.has("bench"),
    featureTeamBalancing: chosenSet.has("teamBalancing"),
    featureMomVoting: chosenSet.has("momVoting"),
    featurePlayerRating: chosenSet.has("playerRating"),
    featureReminders: chosenSet.has("reminders"),
    // featureStatsQa is unconditionally on (Kemal 2026-05-29: "always
    // keep them flipped on"). Historical leaderboard answers — who's
    // most consistent, MoM history, score recall — are useful for every
    // org regardless of which other features they chose, and the
    // Recent History block only renders when there ARE completed
    // matches, so an early-launch org with no history sees nothing.
    featureStatsQa: true,
    paymentTrackingEnabled: chosenSet.has("paymentTracking"),
    featureSquadFromList: !needsAttendance && needsPostMatchPersonalisation,
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
      data: { stage: "completed", selectedFeatures: chosen, adminUserId },
    }),
  ]);

  // ── ① OWNER membership for the captured admin ────────────────────
  // The core fix from the 2026-06-12 design: chat onboarding used to
  // create ZERO Membership rows, leaving the org ownerless (no /admin
  // access, every admin-DM feature silently dead).
  let adminUser: { id: string; name: string | null; phoneNumber: string | null } | null = null;
  if (adminUserId) {
    try {
      adminUser = await db.user.findUnique({
        where: { id: adminUserId },
        select: { id: true, name: true, phoneNumber: true },
      });
      if (adminUser) {
        const existingOwner = await db.membership.findFirst({
          where: { orgId, role: "OWNER", leftAt: null },
          select: { userId: true },
        });
        const role =
          existingOwner && existingOwner.userId !== adminUserId ? "ADMIN" : "OWNER";
        const existing = await db.membership.findUnique({
          where: { userId_orgId: { userId: adminUserId, orgId } },
          select: { id: true, role: true, leftAt: true },
        });
        if (!existing) {
          await db.membership.create({
            data: { userId: adminUserId, orgId, role },
          });
        } else if (existing.role === "PLAYER" || existing.leftAt) {
          await db.membership.update({
            where: { id: existing.id },
            data: {
              leftAt: null,
              ...(existing.role === "PLAYER" ? { role } : {}),
            },
          });
        }
      }
    } catch (err) {
      console.error("[onboarding] admin membership failed:", err);
    }
  }

  // ── ② Roster auto-import from the add-time participant snapshot ──
  // The admin never types a player in by hand. Shared loop with the
  // startup sync route (src/lib/participant-sync.ts).
  let rosterCount = 0;
  const snapshot = parseParticipantSnapshot(s.participants);
  if (snapshot.length > 0) {
    try {
      const imported = await importParticipants(orgId, snapshot);
      rosterCount = imported.added + imported.alreadyKnown + imported.restoredMembership;
    } catch (err) {
      console.error("[onboarding] roster import failed:", err);
    }
  }

  // ── ③ Magic-link DM to the admin → /admin ────────────────────────
  let adminDmQueued = false;
  if (adminUser?.phoneNumber) {
    try {
      const token = signMagicLinkToken({
        userId: adminUser.id,
        purpose: "sign-in",
        nextPath: "/admin",
        ttlSeconds: MAGIC_LINK_TTL.actionNudge,
      });
      const url = await buildShortMagicLinkUrl(token);
      const payments = chosenSet.has("paymentTracking");
      await db.botJob.create({
        data: {
          orgId,
          kind: "dm",
          phone: adminUser.phoneNumber.replace(/^\+/, ""),
          text:
            `👋 You're the admin of *${s.groupName || "your club"}* on MatchTime.\n\n` +
            `Here's your private link to the admin page — player names, ratings` +
            `${payments ? ", payments" : ""} and settings live there:\n${url}` +
            (payments
              ? `\n\nWant me to *collect* the money too? Connect a bank from your admin page — takes 2 minutes.`
              : ``),
        },
      });
      adminDmQueued = true;
    } catch (err) {
      console.error("[onboarding] admin magic-link DM failed:", err);
    }
  }

  const onLabels = FEATURE_META.filter((f) => chosenSet.has(f.key)).map((f) => f.label);

  // Group-add flow gets the design's completion copy (roster + admin
  // link callouts); the legacy setup-trigger copy is unchanged so the
  // existing QA suite keeps passing byte-identical.
  if (s.source === "group-add") {
    const adminName = adminUser?.name?.trim();
    const adminLine = adminDmQueued
      ? `${adminName || "Admin"}, I've sent you a private link to your admin page — player names, ratings and payments live there. `
      : `Whoever runs this group can claim the admin page any time at matchtime.ai. `;
    return (
      `✅ *All set!* I'm live for *${s.groupName || "this group"}* with: *${onLabels.join(", ")}*.\n\n` +
      `📅 First match: *${DOW[s.dayOfWeek ?? 2]} ${s.kickoffTime}* at *${s.venue}*` +
      `${weekly ? ", every week" : ""}.\n` +
      (rosterCount > 0
        ? `👥 I've added the *${rosterCount} ${rosterCount === 1 ? "person" : "people"}* in this group to the squad — no need to type anyone in.\n\n`
        : `\n`) +
      `${adminLine}Everyone else: just chat normally, say *"in"* when you're playing, and I'll handle the rest. ⚽`
    );
  }

  return (
    `✅ *All set!* I'm now running for this group with: *${onLabels.join(", ")}*.\n\n` +
    `First match: *${DOW[s.dayOfWeek ?? 2]} ${s.kickoffTime}* at *${s.venue}*` +
    `${weekly ? " (every week)" : ""}.\n\n` +
    `That's it — I'll take it from here. Anyone can just chat normally; I'll handle the rest. ⚽`
  );
}
