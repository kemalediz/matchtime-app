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

const DAY_WORDS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/** Deterministic, LLM-free extractor. Event answers are formulaic;
 *  this keeps onboarding progressing if Anthropic is unavailable and
 *  backfills LLM misses on terse replies. Venue is intentionally not
 *  guessed here — the collecting branch's "sole missing field"
 *  heuristic handles a bare "PowerLeague Shoreditch" answer. */
function regexExtract(
  messages: OnboardingTurnInput["messages"],
): Extracted {
  const text = messages.map((m) => m.body).join("  ").toLowerCase();
  const empty: Extracted = {
    groupName: null, venue: null, dayOfWeek: null, kickoffTime: null,
    playersPerSide: null, recurrence: null, oneOffDate: null,
    featureSelection: null, confidence: 0,
  };

  // players-per-side: "7 a side", "7-a-side", "7aside", "5s", "11 aside"
  let playersPerSide: number | null = null;
  const ps =
    text.match(/(\d{1,2})\s*[-\s]?\s*a[-\s]?side/) ||
    text.match(/\b(\d{1,2})\s*aside\b/) ||
    text.match(/\b(4|5|6|7|8|9|10|11)s\b/);
  if (ps) {
    const n = parseInt(ps[1], 10);
    if (n >= 4 && n <= 16) playersPerSide = n;
  }

  // day of week
  let dayOfWeek: number | null = null;
  for (const [w, d] of Object.entries(DAY_WORDS)) {
    if (new RegExp(`\\b${w}s?\\b`).test(text)) { dayOfWeek = d; break; }
  }

  // kickoff time: "8:30pm", "8 pm", "20:30", "21.30", "9pm"
  let kickoffTime: string | null = null;
  const tm =
    text.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/) ||
    text.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (tm) {
    let h = parseInt(tm[1], 10);
    const min = tm[2] && /^\d{2}$/.test(tm[2]) ? tm[2] : "00";
    const mer = (tm[3] || tm[2] || "").toString();
    if (/pm/.test(mer) && h < 12) h += 12;
    if (/am/.test(mer) && h === 12) h = 0;
    if (h >= 0 && h <= 23) kickoffTime = `${String(h).padStart(2, "0")}:${min}`;
  }

  // recurrence
  let recurrence: string | null = null;
  if (/\b(one[-\s]?off|just this once|one time|single (?:game|match)|this week only)\b/.test(text))
    recurrence = "oneoff";
  else if (/\b(weekly|every week|each week|recurring|every (?:mon|tue|wed|thu|fri|sat|sun))/.test(text))
    recurrence = "weekly";

  // one-off ISO date
  let oneOffDate: string | null = null;
  const dm = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (dm) oneOffDate = `${dm[1]}-${dm[2]}-${dm[3]}`;

  // feature selection (only meaningful at the features stage; caller
  // decides when to use it). Numbers map to FEATURE_META order.
  let featureSelection: string[] | null = null;
  if (/\b(everything|all of (?:it|them)|all features|the lot|all)\b/.test(text)) {
    featureSelection = FEATURE_META.map((f) => f.key);
    if (/\b(except|but not|apart from|without)\b[^.]*\bpay/.test(text))
      featureSelection = featureSelection.filter((k) => k !== "paymentTracking");
  } else {
    const picked = new Set<string>();
    if (/\b(mom|man of the match|motm)\b/.test(text)) picked.add("momVoting");
    if (/\b(rating|ratings|rate)\b/.test(text)) picked.add("playerRating");
    if (/\b(attendance|in\/out|squad)\b/.test(text)) picked.add("attendance");
    if (/\bbench\b/.test(text)) picked.add("bench");
    if (/\b(teams?|balanc)/.test(text)) picked.add("teamBalancing");
    if (/\b(reminder|remind)\b/.test(text)) picked.add("reminders");
    if (/\b(stats|history|leaderboard)\b/.test(text)) picked.add("statsQa");
    if (/\bpay(ment)?s?\b/.test(text)) picked.add("paymentTracking");
    // numbered picks: "4 and 5", "options 1, 4", "1 & 4"
    const nums = text.match(/\b([1-8])\b/g);
    if (nums) for (const n of nums) {
      const meta = FEATURE_META[parseInt(n, 10) - 1];
      if (meta) picked.add(meta.key);
    }
    if (picked.size > 0) featureSelection = [...picked];
  }

  const gotAny =
    playersPerSide != null || dayOfWeek != null || kickoffTime != null ||
    recurrence != null || oneOffDate != null ||
    (featureSelection != null && featureSelection.length > 0);

  return {
    ...empty,
    playersPerSide,
    dayOfWeek,
    kickoffTime,
    recurrence,
    oneOffDate,
    featureSelection,
    confidence: gotAny ? 0.7 : 0,
  };
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

  const ex = await extract(session, messages);

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
    const reply = await completeOnboarding(session, chosen);
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
    featureStatsQa: chosenSet.has("statsQa"),
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
