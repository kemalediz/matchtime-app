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
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { db } from "./db";
import { sportForPlayersPerSide, type ClubSportSpec } from "./club-connect-rules";
import { FEATURE_META, OFFERED_FEATURE_META, isFeatureOffered, type ToggleableKey } from "./org-features-meta";
import { formatLondon, londonWallClockToUtc, londonDateTimeToUtc } from "./london-time";
import { normalisePhone } from "./phone";
import { appUrl } from "./app-url";
import { scheduleVenueResolve } from "./venue-location-schedule";
import { buildAdminLink } from "./admin-link";
import { runOnboardingEnrichment } from "./onboarding-enrichment";
import {
  coerceHistoryMessages,
  type HistoryMessage,
} from "./onboarding-enrichment-reconcile";
import {
  importParticipants,
  parseParticipantSnapshot,
} from "./participant-sync";
import {
  regexExtract,
  parseBundleReply,
  parseAdmins,
  extractWhenWhere,
  detailsStillMissing,
  detailsFollowUpQuestion,
  cleanVenue,
  type Extracted,
  type ParsedAdmin,
} from "./onboarding-parse";
import { findExistingOrgMember } from "./resolve-player";
import { t } from "./i18n/t";
import { buildBadgeHelp } from "./badge-help";
import type { HelpFeature } from "./pipeline/types";
import type { HelpClubFacts } from "./help-club-facts";
import { SETTINGS_PATH, helpTopicSettingsPath } from "./help-links";
import { settingInfo, type SettingInfoKey } from "./settings-info";
import { normaliseLang, type Lang } from "./i18n/lang";
import { detectGroupLang, langOfConsentReply } from "./i18n/detect";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "@/lib/pipeline/llm";
import { organisersAnnounce } from "./list-announcer";
import { HAIKU_SHORT_ANSWER_MAX_TOKENS } from "./models";
import { changeMemberRole } from "./role-change";

/** How the setup-answer reading is called: Haiku 5.5, adaptive thinking at
 *  medium effort, through the shared pipeline caller (2026-10-22). */
export const ONBOARDING_EXTRACT_CALL: ModelCall = HAIKU_CALL;

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
  /** Additional admins parsed at the `admins` stage; resolved into ADMIN
   *  Memberships at completion (the org doesn't exist yet at that stage).
   *  Stored as JSON (ParsedAdmin[]); coerced defensively on read. */
  pendingAdmins?: unknown;
  /** Chat history the Pi captured shortly after the bot was added, stored
   *  by /api/whatsapp/bot-added. Prisma Json — coerced to HistoryMessage[]
   *  on read. Used as the enrichment fallback at completion when the
   *  completing /analyze request omits its own enrichmentHistory. */
  capturedHistory?: unknown;
  /** The language this session speaks (2026-09-17): detected from the
   *  group subject and history at bot-added time, corrected by the
   *  consent reply, copied onto the Organisation at completion. */
  language?: string | null;
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
    /** @mention/@lid strings if the bot forwards them. Absent today —
     *  inbound messages don't carry mentions yet; threaded through for
     *  the `admins` stage's forward-compat parseAdmins(mentions). */
    mentions?: string[];
  }>;
  groupSubject?: string | null;
  /** Optional stored chat history for the onboarding ENRICHMENT pass
   *  (positions + seed ratings + schedule mining). Distinct from the
   *  LLM-context `history` the analyzer uses — this is the
   *  {author, authorPhone?, text, timestamp} shape consumed by
   *  runOnboardingEnrichment. When absent/empty, no enrichment runs and
   *  no enrichment DM is queued; default behaviour is unchanged. */
  history?: HistoryMessage[];
}

export interface OnboardingTurnResult {
  /** Group reply to post (null = stay silent this turn). */
  reply: string | null;
  /** True once setup is finished and the org is live. */
  completed: boolean;
}

/**
 * Self-introduction the bot leads with the very first time it speaks in
 * a brand-new group (the opening onboarding turn). It sells the core
 * features so players actually WANT it switched on, THEN slides into the
 * setup Q&A. Feature-agnostic on purpose — at this point no org/feature
 * choice exists yet; the post-setup `botIntroMessage` is the
 * feature-accurate one. Kept tight: long enough to be compelling, short
 * enough that nobody scrolls past it. In the session's language (the
 * words live in `i18n/strings.<lang>.ts`, `onb_legacy_intro`).
 */
export function buildLegacySetupIntro(lang: Lang | string = "en"): string {
  return t(lang).onb_legacy_intro;
}

/**
 * The language a LEGACY "@Match Time setup" session speaks, decided when
 * the trigger creates it (Phase 3c). A Turkish trigger word ("kurulum",
 * "kuralım") is the strongest signal there is; otherwise the batch that
 * carried the trigger is scored the way the group-add flow scores a new
 * group's history. English when nothing points elsewhere, which is what
 * every legacy session was before this.
 */
export function legacySetupLang(bodies: string[]): Lang {
  if (bodies.some((b) => /(?<!\p{L})(?:kurulum|kural[ıi]m)(?!\p{L})/iu.test(b ?? ""))) return "tr";
  return detectGroupLang({ subject: null, history: bodies }).lang;
}

function withIntro(question: string, lang: Lang | string): string {
  return `${buildLegacySetupIntro(lang)}\n\n${question}`;
}

/**
 * The feature-aware "how to use me" usage block, posted when setup
 * completes (and re-printed on "@Match Time help"). Teaches the shipped
 * interaction contract in short, scannable WhatsApp-friendly lines:
 *
 *   - In/Out marks your OWN availability, no tag needed (attendance orgs).
 *   - Not sure? Say "maybe" and MatchTime DMs you ~24h before for a firm
 *     yes/no.
 *   - Tag *@Match Time* to make it DO/TELL something — only the enabled
 *     capabilities are listed.
 *   - It stays quiet otherwise (banter is safe).
 *   - Feature extras (MoM / ratings / reminders / payments) appear ONLY
 *     when their flag is on.
 *
 * Every line is gated on the relevant feature flag so a group never sees
 * instructions for something they didn't switch on. No raw phone numbers.
 */
export function buildHowToUseMe(
  features: {
    attendance: boolean;
    teamBalancing: boolean;
    momVoting: boolean;
    playerRating: boolean;
    statsQa: boolean;
    reminders: boolean;
    bench: boolean;
    paymentTracking: boolean;
    /** Stripe fee collection; a missing value reads as off. */
    paymentCollection?: boolean;
    /** The organisers share the list and teams; a missing value reads as off. */
    organisersAnnounce?: boolean;
    /** The organiser's "Want to collect match fees?" pointer while payments
     *  are off; a missing value reads as on. */
    feesNudge?: boolean;
  },
  lang: Lang | string = "en",
): string {
  return t(lang).onbHowToUseMe(features);
}

/**
 * The `admins` stage question (group-add flow). The owner is already
 * captured at `introduced`; this asks for ADDITIONAL admins. Never
 * blocks the flow — any answer (including junk) advances to `details`.
 */
export const ADMIN_QUESTION = t("en").onbAdminQuestion();

/** The reply to a consent answer (group-add flow): a short lead, then
 *  the admins question, in the session's language. The English bytes
 *  are pinned by copy-golden. */
export function buildConsentAck(adminCaptured: boolean, lang: Lang | string = "en"): string {
  const s = t(lang);
  return s.onbConsentAck({ adminCaptured, adminQuestion: s.onbAdminQuestion() });
}

/** The reply to the admins answer (group-add flow): an optional
 *  "got it" lead, then the combined when-and-where question. */
export function buildAdminsAck(added: number, lang: Lang | string = "en"): string {
  return t(lang).onbAdminsAck({
    added,
    detailsQuestion: detailsFollowUpQuestion(["day", "time", "venue"], lang),
  });
}

/**
 * Intro posted the moment the bot is ADDED to a group (the group-add
 * flow). Rewritten 2026-09-17: one line on what MatchTime is and the one
 * question it needs answered first. The 1,300-character feature pitch
 * that stood here is gone; the detail lives in `@Match Time help` and
 * in the "How to use me" block that completion posts. It is a SINGLE
 * string because `introText` is consumed by the Pi as one message.
 *
 * The consent keyword (YES / EVET) is load-bearing: the `introduced`
 * stage parser (parseBundleReply) reads it. The opt-out line keeps the
 * falls-open promise.
 */
export function buildBotAddedIntro(lang: Lang | string): string {
  return t(lang).onbIntro();
}

/** The English intro, for the golden and the legacy imports. */
export const BOT_ADDED_INTRO = buildBotAddedIntro("en");

// ── Help ("@Match Time help", "how do I turn on the pool?") ─────────────
//
// WHICH TOPIC is never read here (2026-10-28). The shared pipeline reads it
// in all three places: the router sends a help question to `question` (or
// HQ's `help`), and the question extractor's `how_it_works` names the
// topic (`QuestionFacts.feature`, `HELP_FEATURES`). The players' group
// (answer-batch.ts), the admin group (admin-group-question.ts) and DMs
// (dm-help.ts) then call `buildHelpReply` below with that topic. The regex
// topic reader that stood here (`parseHelpTopic`, `HELP_TOPIC_ALIASES`,
// `readHelpRequest`) is deleted: "how do I turn on the player pool?" has no
// keyword for a pattern to find, and people never type the phrase you
// expect (Kemal's rule, 2026-10-16).

/** A help topic the bot can explain. The same list the question extractor
 *  names (`HELP_FEATURES`). */
export type HelpTopic = HelpFeature;

/** The org-feature flag each flag-gated topic is behind. */
const HELP_TOPIC_FEATURE = {
  ratings: "playerRating",
  teams: "teamBalancing",
  mom: "momVoting",
  availability: "attendance",
  reminders: "reminders",
  payments: "paymentTracking",
} as const satisfies Record<string, keyof HelpFeatures>;
type FlagTopic = keyof typeof HELP_TOPIC_FEATURE;
const isFlagTopic = (tp: HelpTopic): tp is FlagTopic => tp in HELP_TOPIC_FEATURE;

/** The settings card each flag-gated topic is switched with
 *  (settings-info.ts), whose title the help quotes in the club's language. */
const HELP_TOPIC_SETTING: Record<FlagTopic, SettingInfoKey> = {
  availability: "attendance",
  teams: "teamBalancing",
  mom: "momVoting",
  ratings: "playerRating",
  reminders: "reminders",
  payments: "paymentCollection",
};

export type HelpFeatures = {
  attendance: boolean;
  teamBalancing: boolean;
  momVoting: boolean;
  playerRating: boolean;
  statsQa: boolean;
  reminders: boolean;
  bench: boolean;
  paymentTracking: boolean;
  /** Stripe fee collection. Optional: most callers only know the tracking
   *  flag, and a missing value reads as off. */
  paymentCollection?: boolean;
  /** The club's organisers share the list and the teams
   *  (`Organisation.listAnnouncer = "organisers"`, 2026-10-15). MatchTime
   *  then posts neither in the players' group, so the help offers neither.
   *  A missing value reads as off. */
  organisersAnnounce?: boolean;
  /** The organisers pick who fills an open place
   *  (`Organisation.benchPickMode = "organiser"`): no bench offer on a
   *  drop. A missing value reads as off. */
  organiserPicks?: boolean;
  /** The player pool (2026-10-28, help-club-facts.ts): the platform switch
   *  and the club's own flag. Missing: closed. */
  pool?: HelpClubFacts["pool"];
  /** Partner clubs (2026-10-28, help-club-facts.ts). Missing: none. */
  partners?: HelpClubFacts["partners"];
};

/** The help builder's view of a club's live flags. One mapping, so every
 *  place answers from the same facts. `club` adds the pool and partner
 *  clubs (`loadHelpClubFacts`); without it both read as off. */
export function helpFeaturesFrom(
  f: {
    attendance: boolean;
    teamBalancing: boolean;
    momVoting: boolean;
    playerRating: boolean;
    statsQa: boolean;
    reminders: boolean;
    bench: boolean;
    paymentTracking: boolean;
    paymentCollection: boolean;
    listAnnouncer?: string | null;
    benchPickMode?: string | null;
  },
  club?: HelpClubFacts,
): HelpFeatures {
  return {
    attendance: f.attendance,
    teamBalancing: f.teamBalancing,
    momVoting: f.momVoting,
    playerRating: f.playerRating,
    statsQa: f.statsQa,
    reminders: f.reminders,
    bench: f.bench,
    paymentTracking: f.paymentTracking,
    paymentCollection: f.paymentCollection,
    organisersAnnounce: organisersAnnounce(f),
    organiserPicks: f.benchPickMode === "organiser",
    ...(club ? { pool: club.pool, partners: club.partners } : {}),
  };
}

// Stable order for the bare-help topic list.
const HELP_TOPIC_ORDER: HelpTopic[] = [
  "availability",
  "teams",
  "mom",
  "ratings",
  "badges",
  "reminders",
  "payments",
  "partners",
  "pool",
  "schedule",
  "settings",
];

/** Who a help answer is for (2026-09-30; 2026-10-28). A group reply is
 *  public, so it never carries a signed-in link. "group": the players'
 *  group, asked by a player (mixed readers: what affects players, plus a
 *  pointer for the admins when something is off). "admin": an organiser,
 *  in their DM (signed-in links), in the admin group or in the players'
 *  group (public links): how to switch each thing. "player": a player's
 *  DM, only what affects them. */
export type HelpAudience = "group" | "admin" | "player";

/** The admin pages a help answer can point at. "topic" is the asked
 *  topic's own settings card (help-links.ts). */
export type HelpAdminPage = "settings" | "topic" | "activities" | "blockBookings" | "bulk" | "matches";

const HELP_ADMIN_PAGE_PATH: Record<Exclude<HelpAdminPage, "topic">, string> = {
  settings: SETTINGS_PATH,
  activities: "/admin/activities",
  blockBookings: "/admin/block-bookings",
  bulk: "/admin/matches/bulk",
  matches: "/matches",
};

/** The path of an admin page, for this topic. */
export function helpAdminPagePath(page: HelpAdminPage, topic: HelpTopic | null): string {
  return page === "topic" ? helpTopicSettingsPath(topic) : HELP_ADMIN_PAGE_PATH[page];
}

export interface HelpContext {
  audience: HelpAudience;
  /** The URL for each admin page this answer names: the admin's own
   *  signed-in link in their DM. A missing page falls back to its public
   *  URL, which is what every group gets. */
  links?: Partial<Record<HelpAdminPage, string>>;
  /** "help badges <name>": the badge the question named (its label). */
  badgeQuery?: string;
  /** The club has an admin group linked (`Organisation.adminGroupId`), so
   *  an organiser's DM can point at the "help" there. */
  adminGroupLinked?: boolean;
}

/** The admin pages a given answer links to, so a DM caller mints only the
 *  signed-in links it will actually send. */
export function helpPagesNeeded(topic: HelpTopic | null, audience: HelpAudience): HelpAdminPage[] {
  if (audience === "player" || topic === "badges") return [];
  if (topic === "schedule") return ["activities", "blockBookings", "bulk", "matches"];
  if (audience === "group" && topic === null) return [];
  return topic === null ? ["settings"] : ["topic"];
}

function helpLink(ctx: HelpContext, page: HelpAdminPage, topic: HelpTopic | null): string {
  return ctx.links?.[page] ?? appUrl(helpAdminPagePath(page, topic));
}

/** Is the pool open for the club: THE ONE RULE, as help-club-facts.ts
 *  applied it (`poolOpenForClub`). */
function poolOn(features: HelpFeatures): boolean {
  return features.pool?.open === true;
}

/** Is partner asking on: an active partnership and an ask setting other
 *  than off (`partner-ask-rules.ts` `canAsk`). */
function partnersOn(features: HelpFeatures): boolean {
  return (features.partners?.active ?? 0) > 0 && (features.partners?.askWhen ?? "off") !== "off";
}

function topicIsOn(topic: HelpTopic, features: HelpFeatures): boolean {
  if (topic === "schedule" || topic === "badges" || topic === "settings") return true;
  if (topic === "pool") return poolOn(features);
  if (topic === "partners") return partnersOn(features);
  // Payments are on when the club collects match fees. Payment tracking
  // (the old payment poll) is hidden for now (2026-10-16): a club that
  // still has only that flag is shown how fee collection works and how to
  // switch it on, which is true of it, rather than an explainer of a
  // setting nobody can find.
  if (topic === "payments") return features.paymentCollection === true;
  return features[HELP_TOPIC_FEATURE[topic]] === true;
}

/** Can an organiser switch this topic on from the settings page now? The
 *  pool cannot while the platform switch is off (its card is hidden). */
function switchableOff(topic: HelpTopic, features: HelpFeatures): boolean {
  if (topicIsOn(topic, features)) return false;
  if (topic === "pool") return features.pool?.platformOpen === true;
  return true;
}

/**
 * The help reply, in every group and by DM. ONE builder, so no two places
 * can disagree (2026-09-30). Every topic answers three things in a few
 * lines, in the club's language (2026-10-28): what it does, whether it is
 * on for this club now, and (for an organiser) how to switch it, with a
 * link straight to its card on the settings page (help-links.ts).
 *
 *   - topic === null (bare help): the topics that apply to this club, then
 *     the feature-aware buildHowToUseMe block. An organiser also gets the
 *     topics that are switched off (each explains how to switch it on) and
 *     a link to the settings page.
 *   - a flag topic ON: its explainer and "it's on"; an organiser gets where
 *     to switch it off.
 *   - a flag topic OFF: that it is off, how it works, how to switch it on,
 *     worded for the audience.
 *   - partners, pool, settings: their own three-part answer
 *     (`onbHelpPartners`, `onbHelpPool`, `onbHelpSettings`).
 *
 * ORGANISERS MODE (2026-10-15, `features.organisersAnnounce`): the club's
 * organisers share the list and the teams, so nothing here offers a squad
 * post, a team sheet or team building in the players' group. "help teams"
 * says the organisers share them, whatever the team flag; availability and
 * reminders say where the list goes; the schedule's format switch says its
 * line-up goes to them; an organiser's DM points at the "help" in their
 * admin group. `features.organiserPicks` replaces the bench nudge in "help
 * availability".
 */
export function buildHelpReply(
  topic: HelpTopic | null,
  features: HelpFeatures,
  lang: Lang | string = "en",
  ctx: HelpContext = { audience: "group" },
): string {
  const s = t(lang);
  const admin = ctx.audience === "admin";
  const adminTail = (line: string) => (admin ? `\n\n${line}` : "");
  const organisers = features.organisersAnnounce === true;
  const picks = features.organiserPicks === true;
  const topicUrl = helpLink(ctx, "topic", topic);
  const title = (key: SettingInfoKey) => settingInfo(lang, key).title;

  if (topic === "badges") return buildBadgeHelp(ctx.badgeQuery, lang, { dm: ctx.audience !== "group" });
  if (topic === "schedule") {
    return s.onbHelpSchedule({
      audience: ctx.audience,
      activities: helpLink(ctx, "activities", topic),
      blockBookings: helpLink(ctx, "blockBookings", topic),
      bulk: helpLink(ctx, "bulk", topic),
      matches: helpLink(ctx, "matches", topic),
      ...(organisers ? { organisers: true } : {}),
    });
  }
  if (topic === "settings") return s.onbHelpSettings({ audience: ctx.audience, url: topicUrl });
  if (topic === "partners") {
    return s.onbHelpPartners({
      audience: ctx.audience,
      active: features.partners?.active ?? 0,
      askWhen: features.partners?.askWhen ?? "off",
      url: topicUrl,
      askLabel: title("partnerAskWhen"),
    });
  }
  if (topic === "pool") {
    return s.onbHelpPool({
      audience: ctx.audience,
      platformOpen: features.pool?.platformOpen === true,
      clubFlag: features.pool?.clubFlag === true,
      open: poolOn(features),
      url: topicUrl,
      poolLabel: title("playerPool"),
      autoLabel: title("poolAutoAsk"),
    });
  }
  if (topic && isFlagTopic(topic)) {
    if (organisers && topic === "teams") {
      return s.onbHelpOrganisersExplainer({ topic, organiserPicks: picks }) + adminTail(s.onbHelpAdminSettings({ url: topicUrl }));
    }
    const explainer =
      organisers && (topic === "availability" || topic === "reminders")
        ? s.onbHelpOrganisersExplainer({ topic, organiserPicks: picks })
        : topic === "availability" && picks
          ? s.onbHelpAvailabilityOrganiserPicks
          : s.onbHelpExplainer({ topic });
    if (topicIsOn(topic, features)) {
      return `${explainer}\n\n${s.onbHelpOnStatus({ audience: ctx.audience, url: topicUrl })}`;
    }
    const body = topic === "payments" ? s.onbHelpPaymentsOff() : explainer;
    const switchOn = s.onbHelpSwitchOn({
      topic,
      audience: ctx.audience,
      url: topicUrl,
      word: s.onbHelpTopicWord({ topic }),
      label: title(HELP_TOPIC_SETTING[topic]),
    });
    return `${s.onbHelpOffLead()}\n\n${body}\n\n${switchOn}`;
  }

  // Bare help: the topics that apply here, then the how-to block.
  const enabled = HELP_TOPIC_ORDER.filter((tp) => topicIsOn(tp, features));
  const topicLines = enabled.map((tp) =>
    s.onbHelpTopicLine({ word: s.onbHelpTopicWord({ topic: tp }), label: s.onbHelpTopicLabel({ topic: tp }) }),
  );
  const head = s.onbHelpHead();
  const list = topicLines.length > 0 ? `\n${topicLines.join("\n")}` : "";
  // An organiser also hears what is switched off, each of which explains
  // how to switch it on when asked about (2026-10-28).
  const off = HELP_TOPIC_ORDER.filter((tp) => switchableOff(tp, features)).map((tp) => s.onbHelpTopicLabel({ topic: tp }));
  const offLine = off.length > 0 ? adminTail(s.onbHelpOffTopics({ labels: off })) : "";
  const hqPointer = organisers && ctx.adminGroupLinked === true ? adminTail(s.onbHelpAdminOrganisers) : "";
  // The "Want to collect match fees?" pointer is for an organiser; in the
  // players' group every player saw it (FNF, 2026-10-15), so only an
  // organiser keeps it (a player's DM stays identical to the group's).
  const howTo = buildHowToUseMe(admin ? features : { ...features, feesNudge: false }, lang);
  return `${head}${list}\n\n${howTo}` + offLine + hqPointer + adminTail(s.onbHelpAdminPage({ url: helpLink(ctx, "settings", null), signedIn: !!ctx.links?.settings }));
}

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

/** Defensively coerce the JSON `pendingAdmins` column back into a
 *  ParsedAdmin[]. Tolerates null / non-array / malformed entries. */
function coercePendingAdmins(raw: unknown): ParsedAdmin[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedAdmin[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : null;
    const phone = typeof o.phone === "string" && o.phone.trim() ? o.phone.trim() : null;
    const mention =
      typeof o.mention === "string" && o.mention.trim() ? o.mention.trim() : null;
    if (!name && !phone && !mention) continue;
    out.push({ name, phone, mention });
  }
  return out;
}

/**
 * THE SETUP-ANSWER READING'S PROMPT. REWRITTEN AS A WHOLE 2026-10-22.
 *
 * One task (pull out what people stated, never guess), every output field
 * defined once with when it is null, the feature words once, examples
 * grouped by what they teach with English and Turkish side by side. The
 * context now does work the rules used to: the user turn gives today's
 * date (a relative one-off date had nothing to be worked out from, and
 * the paid check showed both "this Saturday" cases returning null) and
 * says, from the stage, what MatchTime is asking, so "only answer the
 * feature menu when it is asked" is a fact rather than a guess.
 * Output contract unchanged: the same nine keys, null for unknown.
 * Size: 2,516 characters before, 3,478 after (count_tokens on
 * claude-haiku-5-5: 1,100 before, 1,462 after), above Haiku 5.5's 512-token
 * cacheable minimum, so the shared marker still caches it. Longer, not
 * shorter: the day numbers and the feature words are now each listed
 * once in full instead of by a few samples, and clarity wins.
 * Paid check: scripts/live-check-onboarding-extract.ts (28 cases, each
 * once): main's prompt 26/28 (both relative one-off dates null), this
 * one 28/28.
 */
export const EXTRACT_PROMPT = `You read the newest messages in a WhatsApp group that is setting up MatchTime, a WhatsApp assistant for a regular amateur game, and pull out the setup answers people have stated. You do not run the conversation and you never guess: a field the messages do not state is null.

WHAT YOU ARE SHOWN
- Today: today's date in London.
- MatchTime is asking: the question the group is answering now.
- Collected so far: what earlier answers gave, under the same field names as your answer. A collected value stays as it is: give it again only when a new message corrects it ("actually Fridays", "pardon, cuma olsun").
- New messages, oldest first, as "author: text". Several messages may each answer a different field; combine them. They may be in English or Turkish.

WHAT YOU ANSWER
One JSON object with exactly these keys, each null when the messages do not state it:
- groupName: the club or group's name, when someone gives one.
- venue: where they play, as written, without a Turkish case ending ("Sim Arena'da" is "Sim Arena").
- dayOfWeek: the regular match day as a number: 0 Sunday, 1 Monday, 2 Tuesday, 3 Wednesday, 4 Thursday, 5 Friday, 6 Saturday.
- kickoffTime: the kickoff in 24 hour London time, "HH:MM".
- playersPerSide: the number of players in each team.
- recurrence: "weekly" for a game played every week, "oneoff" for a single game.
- oneOffDate: the date of a oneoff game, "YYYY-MM-DD", worked out from today's date when it is relative ("this Saturday"); null for a weekly game.
- featureSelection: only when MatchTime is asking which features the group wants and a message answers it: a list of these keys, spelled exactly so: attendance, bench, teamBalancing, momVoting, playerRating, reminders, statsQa, paymentTracking. Null at any other question.
- confidence: from 0 to 1, how sure you are of what you returned; below 0.5 when the messages are chat with no concrete answer.

FEATURE WORDS, ENGLISH / TURKISH
- everything, all / hepsi, her şey: all eight keys
- everything except payments / ödeme hariç hepsi: all but paymentTracking
- attendance / katılım, yoklama, kadro: attendance
- bench / yedek: bench
- teams / takım, takımlar: teamBalancing
- MoM, man of the match / maçın adamı: momVoting
- ratings, player ratings / puan, puanlama, oyuncu puanları: playerRating
- reminders / hatırlatma: reminders
- stats / istatistik: statsQa
- payments / ödeme: paymentTracking

EXAMPLES, ENGLISH / TURKISH
When and where in one answer:
  "thursdays 8:30pm at PowerLeague Shoreditch, 6 a side" / "perşembe akşam 8 buçukta Yıldız Halı Saha'da, 6'ya 6": dayOfWeek 4, kickoffTime "20:30", venue "PowerLeague Shoreditch" / "Yıldız Halı Saha", playersPerSide 6
  "Fridays, kick off 21:00" / "cumaları saat 21:00": dayOfWeek 5, kickoffTime "21:00", venue null
A name:
  "we're the Sunday Strikers" / "biz Salı Aslanlarıyız": groupName "Sunday Strikers" / "Salı Aslanları"
How often:
  "every week" / "her hafta": recurrence "weekly"
  "a one-off, Saturday the 31st" / "tek seferlik, 31'i cumartesi", on Thursday 22 October 2026: recurrence "oneoff", oneOffDate "2026-10-31"
A correction, with Tuesday collected:
  "no wait, Mondays" / "pardon, pazartesi olsun": dayOfWeek 1
A feature pick, while MatchTime is asking which features:
  "MoM and the reminders" / "maçın adamı ve hatırlatma": featureSelection ["momVoting", "reminders"]
Chat that answers nothing:
  "lol classic" / "kolay gelsin": every field null, confidence below 0.5

Answer with the JSON object only.`;

/** What the reading is told is already known: the session's fields and stage. */
export type KnownSetup = Pick<
  Session,
  "groupName" | "venue" | "dayOfWeek" | "kickoffTime" | "playersPerSide" | "recurrence" | "oneOffDate" | "stage"
>;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What MatchTime is asking at each stage the reading runs in. Only the
 *  feature menu is a feature question (`featureSelection` is read there
 *  and nowhere else). */
function askingAt(stage: string): string {
  if (stage === "features") return "which features the group wants (the feature menu)";
  if (stage === "details") return "when and where the group plays";
  return "the club's setup details (name, players a side, day, kickoff, venue, how often)";
}

/**
 * The user turn: the facts code already has (today's date, the question
 * being asked, what is collected), then the new messages. Each part is
 * labelled the way EXTRACT_PROMPT names it.
 */
export function buildExtractUserTurn(
  session: KnownSetup,
  messages: Array<{ authorName: string | null; body: string }>,
  now: Date = new Date(),
): string {
  const show = (v: unknown) => (v == null || v === "" ? "not yet" : String(v));
  const day =
    session.dayOfWeek == null ? "not yet" : `${session.dayOfWeek} (${WEEKDAY_NAMES[session.dayOfWeek] ?? "?"})`;
  const collected = [
    `- groupName: ${show(session.groupName)}`,
    `- venue: ${show(session.venue)}`,
    `- dayOfWeek: ${day}`,
    `- kickoffTime: ${show(session.kickoffTime)}`,
    `- playersPerSide: ${show(session.playersPerSide)}`,
    `- recurrence: ${show(session.recurrence)}`,
    `- oneOffDate: ${show(session.oneOffDate)}`,
  ];
  const convo = messages.map((m) => `${m.authorName ?? "?"}: ${m.body.slice(0, 400)}`);
  return [
    `Today: ${formatLondon(now, "EEEE d MMMM yyyy")}`,
    `MatchTime is asking: ${askingAt(session.stage)}`,
    `Collected so far:\n${collected.join("\n")}`,
    `New messages, oldest first:\n${convo.join("\n")}`,
  ].join("\n\n");
}

/**
 * THE SETUP-ANSWER READING: one Haiku call per onboarding turn, through
 * the shared caller (`pipeline/llm.ts`) since 2026-10-22. That caller
 * retries transport errors, books the club's daily budget under the same
 * label, carries the shared cache marker and throws on a truncated answer.
 *
 * Falls back to `regexExtract` whenever the model cannot help, so
 * onboarding still progresses instead of looping the first question: no
 * key (no call is made at all), a failed call, a truncated or unparseable
 * answer. A field the model left null is backfilled by the regex pass,
 * which covers misses on terse answers.
 */
export async function extractSetupAnswers(
  session: KnownSetup,
  messages: Array<{ authorName: string | null; body: string }>,
  deps?: { model?: PipelineModel; now?: Date },
): Promise<Extracted> {
  if (!deps?.model && !process.env.ANTHROPIC_API_KEY?.trim()) return regexExtract(messages);
  const model = deps?.model ?? anthropicModel();
  try {
    const resp = await model.complete({
      ...ONBOARDING_EXTRACT_CALL,
      system: EXTRACT_PROMPT,
      user: buildExtractUserTurn(session, messages, deps?.now ?? new Date()),
      maxTokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
      label: "onboarding-extract",
    });
    const parsed = extractJson(resp.text) as Partial<Extracted>;
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
  const { session, messages, history } = input;
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
  // The language this session speaks (set when it was created, from the
  // trigger or the group-add detection). Every legacy-flow reply uses it.
  const sessionLang = normaliseLang(session.language);

  // ── Stage: introduced (group-add flow) ───────────────────────────
  // The bot has posted its add-time intro and is waiting for a
  // consent/bundle reply. Pure-deterministic parsing (no LLM): a
  // standalone YES / EVERYTHING / named-features message advances to
  // `details`; anything else is ordinary group chat and the bot stays
  // SILENT (falls open — the group is never spammed).
  if (session.stage === "introduced") {
    let consent: { features: ToggleableKey[]; authorPhone: string | null; body: string } | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const bundle = parseBundleReply(messages[i].body);
      if (bundle) {
        consent = {
          features: bundle.features,
          authorPhone: messages[i].authorPhone?.trim() || null,
          body: messages[i].body,
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

    // The consent reply is the strongest language signal there is: an
    // "evet" to an English intro (the detector had nothing to go on)
    // flips the session to Turkish before the second question; a "yes"
    // flips it back. A reply that says nothing about language ("ok",
    // an emoji) keeps what was detected.
    const replyLang = langOfConsentReply(consent.body);
    const lang = replyLang ?? normaliseLang(session.language);

    await db.onboardingSession.update({
      where: { id: session.id },
      data: {
        stage: "admins",
        selectedFeatures: consent.features,
        // Group subject = club name: never ask what we already know.
        groupName:
          session.groupName ?? session.groupSubject?.slice(0, 80) ?? null,
        adminUserId,
        language: lang,
        lastHandledWaId: lastWaId,
      },
    });

    return {
      reply: buildConsentAck(!!adminUserId, lang),
      completed: false,
    };
  }

  // ── Stage: admins (group-add flow) ───────────────────────────────
  // The owner is captured; this asks "who else helps run this group?".
  // NEVER blocks the flow — whatever we parse is stashed on the session
  // (the Organisation doesn't exist yet, so Memberships can't be created
  // here) and we ALWAYS advance to `details`. "just me" / junk → []
  // pending admins; named/numbered admins → ParsedAdmin[] resolved into
  // ADMIN Memberships at completeOnboarding().
  if (session.stage === "admins") {
    const joined = messages.map((m) => m.body).join("  ");
    // Inbound messages don't carry mentions today; thread them through
    // for forward-compat (parseAdmins accepts an optional mentions arg).
    const mentions = messages.flatMap((m) => m.mentions ?? []);
    const parsed = parseAdmins(joined, mentions.length > 0 ? mentions : undefined);

    await db.onboardingSession.update({
      where: { id: session.id },
      data: {
        stage: "details",
        // Stash whatever we parsed (justMe / junk both stash []).
        pendingAdmins: parsed.admins.map((a) => ({ ...a })) as Array<
          Record<string, string | null>
        >,
        lastHandledWaId: lastWaId,
      },
    });

    return {
      reply: buildAdminsAck(parsed.admins.length, normaliseLang(session.language)),
      completed: false,
    };
  }

  const ex = await extractSetupAnswers(session, messages);

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
      if (!session.venue && v) data.venue = cleanVenue(v) ?? undefined;
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
      data.venue = cleanVenue(lastBody) ?? undefined;
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
      return {
        reply: detailsFollowUpQuestion(missing, normaliseLang(session.language)),
        completed: false,
      };
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
    const valid = new Set<ToggleableKey>(OFFERED_FEATURE_META.map((f) => f.key));
    const chosen = [...new Set(merged.selectedFeatures)].filter(
      (k): k is ToggleableKey => valid.has(k as ToggleableKey),
    );
    const reply = await completeOnboarding(merged, chosen, undefined, history);
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
      if (ex.venue && !session.venue) data.venue = cleanVenue(ex.venue) ?? undefined;
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
        data.venue = cleanVenue(lastBody) ?? undefined;
      }
    }

    data.lastHandledWaId = messages[messages.length - 1].waMessageId;
    const merged = { ...session, ...data } as Session;
    await db.onboardingSession.update({ where: { id: session.id }, data });

    // Deterministic: ask for the first still-missing field.
    const ask = nextEventQuestion(merged);
    if (ask) return { reply: isOpening ? withIntro(ask, sessionLang) : ask, completed: false };

    // All event fields gathered → provision the Organisation + Sport,
    // move to the feature menu.
    const reply = await provisionOrgAndAskFeatures(merged);
    return { reply: isOpening ? withIntro(reply, sessionLang) : reply, completed: false };
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
    const valid = new Set<ToggleableKey>(OFFERED_FEATURE_META.map((f) => f.key));
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
        reply: featureMenuText(legacyMenuRetryLead(sessionLang), sessionLang),
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
    const reply = await completeOnboarding(session, chosen, adminUserId, history);
    return { reply, completed: true };
  }

  return { reply: null, completed: false };
}

function nextEventQuestion(s: Session): string | null {
  return legacyEventQuestion(s, normaliseLang(s.language));
}

/** The legacy flow's seven setup questions, in order: the first field
 *  still missing decides which one is asked. Null when all are known. */
export function legacyEventQuestion(
  s: {
    groupName?: string | null;
    playersPerSide?: number | null;
    dayOfWeek?: number | null;
    kickoffTime?: string | null;
    venue?: string | null;
    recurrence?: string | null;
    oneOffDate?: string | null;
  },
  lang: Lang | string = "en",
): string | null {
  const q = (field: "name" | "side" | "day" | "time" | "venue" | "recurrence" | "date") =>
    t(lang).onb_legacy_question({ field, groupName: s.groupName ?? "" });
  if (!s.groupName) return q("name");
  if (!s.playersPerSide) return q("side");
  if (s.dayOfWeek == null) return q("day");
  if (!s.kickoffTime) return q("time");
  if (!s.venue) return q("venue");
  if (!s.recurrence) return q("recurrence");
  if (s.recurrence === "oneoff" && !s.oneOffDate) return q("date");
  return null;
}

/**
 * The sport the in-group setup creates for `n` players per side: the same
 * one self-join builds (`sportForPlayersPerSide`), so only a live sport
 * (`LIVE_SPORTS`) and, for a size with no live preset, plain football.
 * It used to take any preset of that size, so 6 a side became volleyball.
 */
export function presetForSide(n: number): ClubSportSpec {
  return sportForPlayersPerSide(n);
}

function slugify(s: string): string {
  return (
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) ||
    `group-${Date.now().toString(36)}`
  );
}

function featureMenuText(lead: string, lang: Lang | string = "en"): string {
  return buildLegacyFeatureMenu(lead, lang);
}

/** The legacy flow's numbered feature menu under a lead line. */
export function buildLegacyFeatureMenu(lead: string, lang: Lang | string = "en"): string {
  const s = t(lang);
  return s.onb_legacy_menu({
    lead,
    items: OFFERED_FEATURE_META.map((f) => ({
      label: s.onbFeatureLabel({ key: f.key, englishLabel: f.label }),
      blurb: s.onb_legacy_feature_blurb({ key: f.key, englishBlurb: f.blurb }),
    })),
  });
}

/** The lead when the feature pick could not be read. */
export function legacyMenuRetryLead(lang: Lang | string = "en"): string {
  return t(lang).onb_legacy_menu_retry_lead;
}

/** The lead above the menu once the club is provisioned. */
export function buildLegacyProvisionedLead(
  p: {
    groupName: string;
    playersPerTeam: number;
    dayOfWeek: number;
    kickoffTime: string | null;
    venue: string | null;
  },
  lang: Lang | string = "en",
): string {
  const s = t(lang);
  return s.onb_legacy_provisioned_lead({
    groupName: p.groupName,
    playersPerTeam: p.playersPerTeam,
    dayName: s.onbDayName({ dow: p.dayOfWeek }),
    kickoffTime: p.kickoffTime,
    venue: p.venue,
  });
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
      // The language the session spoke is the language the org speaks
      // from its first scheduled post (editable on /admin/settings).
      language: normaliseLang(s.language),
      // Stay OFF until completion so the bot doesn't start acting
      // mid-setup.
      whatsappBotEnabled: false,
      sports: {
        create: {
          name: preset.name,
          preset: preset.preset,
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
  const lang = normaliseLang(s.language);
  return featureMenuText(
    buildLegacyProvisionedLead(
      {
        groupName: name,
        playersPerTeam: preset.playersPerTeam,
        dayOfWeek: s.dayOfWeek ?? 0,
        kickoffTime: s.kickoffTime ?? null,
        venue: s.venue ?? null,
      },
      lang,
    ),
    lang,
  );
}

async function completeOnboarding(
  s: Session,
  chosen: ToggleableKey[],
  adminUserIdOverride?: string | null,
  history?: HistoryMessage[],
): Promise<string> {
  // A hidden switch (payment tracking, 2026-10-16) is never turned on,
  // claimed in the completion post or named in the admin DM.
  chosen = chosen.filter((k) => isFeatureOffered(k));
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
    // Hidden for now (2026-10-16): never switched on at setup.
    paymentTrackingEnabled: chosenSet.has("paymentTracking") && isFeatureOffered("paymentTracking"),
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
  // Venue location: looked up after the response, never part of the save.
  await scheduleVenueResolve(activity.id);

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

  const lang = normaliseLang(s.language);

  await db.$transaction([
    db.organisation.update({
      where: { id: orgId },
      data: { ...featureData, whatsappBotEnabled: true },
    }),
    db.onboardingSession.update({
      where: { id: s.id },
      data: { stage: "completed", selectedFeatures: chosen, adminUserId },
    }),
    // The completion post below IS this group's introduction: it carries
    // the "How to use me" block in the group's language. Without this
    // row the scheduler would post its own English `botIntroMessage`
    // into the group within a minute of going live (bot-scheduler.ts,
    // key `org-<id>:bot-intro`), a second long bot message right after
    // the first, in the wrong language for a Turkish group.
    db.sentNotification.upsert({
      where: { key: `org-${orgId}:bot-intro` },
      create: { key: `org-${orgId}:bot-intro`, kind: "bot-intro" },
      update: {},
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
          where: { orgId, role: "OWNER", leftAt: null, ...ORDINARY_MEMBER_WHERE },
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
          if (existing.leftAt) {
            await db.membership.update({ where: { id: existing.id }, data: { leftAt: null } });
          }
          if (existing.role === "PLAYER") {
            // Logged in RoleChange; never lowers an OWNER (role-change.ts).
            await changeMemberRole(db, {
              orgId,
              userId: adminUserId,
              to: role,
              actorUserId: adminUserId,
              source: "onboarding-owner",
              mayGrantOwner: role === "OWNER",
            });
          }
        }
      }
    } catch (err) {
      console.error("[onboarding] admin membership failed:", err);
    }
  }

  // ── ①b ADDITIONAL ADMIN memberships (group-add `admins` stage) ────
  // The owner is already handled above; these are the extra admins the
  // group named at the `admins` stage (stashed on s.pendingAdmins because
  // the org didn't exist yet then). Each one is resolved → ADMIN
  // Membership → magic-link DM, wrapped so one bad admin never breaks
  // completion. Never downgrades an existing OWNER/ADMIN.
  const pending = coercePendingAdmins(s.pendingAdmins);
  let adminsAdded = 0;
  if (pending.length > 0) {
    const processed = new Set<string>(adminUserId ? [adminUserId] : []);
    for (const pa of pending) {
      try {
        // Resolve to a userId: phone first (create-or-find), else name.
        let userId: string | null = null;
        if (pa.phone) {
          userId = await ensureUserForPhone(pa.phone);
        } else if (pa.name) {
          const hit = await findExistingOrgMember(orgId, { name: pa.name });
          userId = hit?.userId ?? null;
          if (!userId) {
            console.warn(
              `[onboarding] admin "${pa.name}" not found in org roster — skipping`,
            );
          }
        }
        if (!userId) continue; // mention-only / unresolvable → skip
        if (processed.has(userId)) continue; // owner or already-done dupe
        processed.add(userId);

        // Upsert as ADMIN — mirror the OWNER upsert logic; never downgrade.
        const existing = await db.membership.findUnique({
          where: { userId_orgId: { userId, orgId } },
          select: { id: true, role: true, leftAt: true },
        });
        let madeAdmin = false;
        if (!existing) {
          await db.membership.create({
            data: { userId, orgId, role: "ADMIN" },
          });
          madeAdmin = true;
        } else if (existing.role === "PLAYER" || existing.leftAt) {
          if (existing.leftAt) {
            await db.membership.update({ where: { id: existing.id }, data: { leftAt: null } });
          }
          if (existing.role === "PLAYER") {
            // Logged in RoleChange (role-change.ts).
            await changeMemberRole(db, {
              orgId,
              userId,
              to: "ADMIN",
              actorUserId: adminUserId ?? null,
              source: "onboarding-admin",
            });
          }
          madeAdmin = true;
        }
        // else already OWNER/ADMIN → leave as-is (don't downgrade).
        if (madeAdmin) adminsAdded++;

        // DM the new admin a magic link → /admin (only if we have a phone).
        const newAdmin = await db.user.findUnique({
          where: { id: userId },
          select: { phoneNumber: true },
        });
        if (madeAdmin && newAdmin?.phoneNumber) {
          // Names the club, so a co-admin who is in another club too
          // lands in this one (2026-09-30).
          const url = await buildAdminLink({ userId, orgId, nextPath: "/admin" });
          await db.botJob.create({
            data: {
              orgId,
              kind: "dm",
              phone: newAdmin.phoneNumber.replace(/^\+/, ""),
              text: buildCoAdminMagicLinkDm({ groupName: s.groupName ?? null, url }, lang),
            },
          });
        }
      } catch (err) {
        console.error("[onboarding] co-admin setup failed:", err);
      }
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
      // Every link names the club (2026-09-30): Kemal is in Sutton FC
      // and MT Test, and MT Test's setup link opened Sutton's admin page.
      const link = (nextPath: string) => buildAdminLink({ userId: adminUser.id, orgId, nextPath });
      const url = await link("/admin");
      // The seed editor, offered at setup as the club-scoped ratings
      // design decided. Only when teams are generated: nothing else reads
      // a seed.
      const seedUrl = chosenSet.has("teamBalancing") ? await link("/admin/players/ratings") : null;
      const blockBookingsUrl = await link("/admin/block-bookings");
      const matchesUrl = await link("/matches");
      const payments = chosenSet.has("paymentTracking");
      await db.botJob.create({
        data: {
          orgId,
          kind: "dm",
          phone: adminUser.phoneNumber.replace(/^\+/, ""),
          text: buildAdminMagicLinkDm(
            { groupName: s.groupName ?? null, url, payments, seedUrl, blockBookingsUrl, matchesUrl },
            lang,
          ),
        },
      });
      adminDmQueued = true;
    } catch (err) {
      console.error("[onboarding] admin magic-link DM failed:", err);
    }
  }

  // ── ④ Onboarding ENRICHMENT pass (fire-and-forget) ───────────────
  // Only when the turn carried stored chat history. Mines positions +
  // seed ratings + schedule from the group's past messages, stashes
  // proposals on the OnboardingSession (nothing applied to live
  // records), then DMs the admin a magic link into /finish-setup/<id>.
  //
  // Detached (no await): runOnboardingEnrichment calls the LLM and can
  // take 10-60s — blocking here would stall the WhatsApp turn and the
  // group reply. A plain detached promise is sufficient: the request
  // context stays alive long enough (and the sim test polls the DB
  // afterwards). We deliberately avoid `after()` here — completeOnboarding
  // is a lib function, not a route handler, so importing the route-only
  // `after` would be out of place; the detached promise is the simplest
  // mechanism that also runs reliably under the sim harness.
  // Prefer the request-provided history; else fall back to the chat
  // history the Pi captured at bot-added time (stored on the session as
  // capturedHistory). This is the core of PIECE 2: the Pi can only fetch
  // WhatsApp history around JOIN, but enrichment runs later at COMPLETION,
  // so the completing /analyze request usually has no history of its own.
  const enrichmentHistory =
    history && history.length > 0
      ? history
      : coerceHistoryMessages(s.capturedHistory);
  if (enrichmentHistory.length > 0) {
    void triggerEnrichmentAndDm({
      sessionId: s.id,
      history: enrichmentHistory,
      orgId,
      adminUserId,
      groupName: s.groupName ?? null,
      lang,
    }).catch((err) => console.error("[onboarding] enrichment+DM failed:", err));
  }

  const post: CompletionPostInput = {
    groupName: s.groupName ?? null,
    chosen,
    dayOfWeek: s.dayOfWeek ?? null,
    kickoffTime: s.kickoffTime ?? null,
    venue: s.venue ?? null,
    weekly,
  };

  // Group-add flow gets the design's completion copy (roster + admin
  // link callouts); the legacy setup-trigger copy is unchanged so the
  // existing QA suite keeps passing byte-identical.
  if (s.source === "group-add") {
    return buildGroupAddCompletionPost(
      {
        ...post,
        rosterCount,
        adminsAdded,
        adminDmQueued,
        adminName: adminUser?.name ?? null,
      },
      lang,
    );
  }

  return buildLegacyCompletionPost(post, lang);
}

// ── Completion posts and DMs, as pure builders ────────────────────────
// Extracted from completeOnboarding / triggerEnrichmentAndDm so the
// English bytes can be pinned by copy-golden.test.ts. The literals moved
// verbatim; nothing about the wording changed in the extraction.

export interface CompletionPostInput {
  groupName: string | null;
  /** The features the group switched on (valid ToggleableKeys). */
  chosen: ToggleableKey[];
  dayOfWeek: number | null;
  kickoffTime: string | null;
  venue: string | null;
  weekly: boolean;
}

/** The feature-aware "how to use me" block for a completion post.
 *  statsQa is always-on (see featureData in completeOnboarding). */
function howToUseMeFor(chosen: ToggleableKey[], lang: Lang | string = "en"): string {
  const chosenSet = new Set(chosen);
  return buildHowToUseMe(
    {
      attendance: chosenSet.has("attendance"),
      teamBalancing: chosenSet.has("teamBalancing"),
      momVoting: chosenSet.has("momVoting"),
      playerRating: chosenSet.has("playerRating"),
      statsQa: true,
      reminders: chosenSet.has("reminders"),
      bench: chosenSet.has("bench"),
      paymentTracking: chosenSet.has("paymentTracking"),
      paymentCollection: chosenSet.has("paymentCollection"),
    },
    lang,
  );
}

/** The "All set" post for the group-add flow (roster + admin-link
 *  callouts), in the group's language. */
export function buildGroupAddCompletionPost(
  p: CompletionPostInput & {
    rosterCount: number;
    adminsAdded: number;
    adminDmQueued: boolean;
    adminName: string | null;
  },
  lang: Lang | string = "en",
): string {
  const s = t(lang);
  const chosenSet = new Set(p.chosen);
  const onLabels = FEATURE_META.filter((f) => chosenSet.has(f.key)).map((f) =>
    s.onbFeatureLabel({ key: f.key, englishLabel: f.label }),
  );
  const post = s.onbCompletionPost({
    groupName: p.groupName,
    onLabels,
    dayName: s.onbDayName({ dow: p.dayOfWeek ?? 2 }),
    kickoffTime: p.kickoffTime,
    // Never "at on Sutton Goals" (2026-09-30), whatever was stored.
    venue: cleanVenue(p.venue) ?? p.venue,
    weekly: p.weekly,
    rosterCount: p.rosterCount,
    adminsAdded: p.adminsAdded,
    adminDmQueued: p.adminDmQueued,
    adminName: p.adminName,
    howToUseMe: howToUseMeFor(p.chosen, lang),
  });
  // D7 (2026-10-01): the Weekly routine features live on the settings
  // page, not in this conversation; one line says where.
  return `${post}\n\n${s.onb_weekly_routine_tip}`;
}

/** The "All set" post for the legacy "@MatchTime setup" flow. */
export function buildLegacyCompletionPost(p: CompletionPostInput, lang: Lang | string = "en"): string {
  const s = t(lang);
  const chosenSet = new Set(p.chosen);
  const post = s.onb_legacy_completion({
    onLabels: FEATURE_META.filter((f) => chosenSet.has(f.key)).map((f) =>
      s.onbFeatureLabel({ key: f.key, englishLabel: f.label }),
    ),
    dayName: s.onbDayName({ dow: p.dayOfWeek ?? 2 }),
    kickoffTime: p.kickoffTime,
    venue: cleanVenue(p.venue) ?? p.venue,
    weekly: p.weekly,
    howToUseMe: howToUseMeFor(p.chosen, lang),
  });
  return `${post}\n\n${s.onb_weekly_routine_tip}`;
}

/** The magic-link DM to the captured admin at completion. */
export function buildAdminMagicLinkDm(
  p: {
    groupName: string | null;
    url: string;
    payments: boolean;
    seedUrl?: string | null;
    blockBookingsUrl?: string | null;
    matchesUrl?: string | null;
  },
  lang: Lang | string = "en",
): string {
  return t(lang).onbAdminDm(p);
}

/** The magic-link DM to each additional admin named at the admins stage. */
export function buildCoAdminMagicLinkDm(
  p: { groupName: string | null; url: string },
  lang: Lang | string = "en",
): string {
  return t(lang).onbCoAdminDm(p);
}

/** The DM that points the admin at the enrichment review page. */
export function buildEnrichmentReviewDm(
  p: { messagesAnalyzed: number; groupName: string | null; playerCount: number; url: string },
  lang: Lang | string = "en",
): string {
  return t(lang).onbEnrichmentDm(p);
}

/**
 * Run the onboarding enrichment pass and, if it produced a result, DM the
 * admin a magic link into the /finish-setup review page. Fire-and-forget:
 * called WITHOUT await from completeOnboarding so the WhatsApp turn isn't
 * blocked on the LLM.
 *
 * PII-safe: the DM text never contains a phone number.
 */
async function triggerEnrichmentAndDm(args: {
  sessionId: string;
  history: HistoryMessage[];
  orgId: string;
  adminUserId: string | null;
  groupName: string | null;
  lang: Lang;
}): Promise<void> {
  const summary = await runOnboardingEnrichment({
    sessionId: args.sessionId,
    history: args.history,
  });
  // No-op result (empty history) → nothing to review, skip the DM.
  if (summary.status !== "ready") return;

  if (!args.adminUserId) {
    console.warn("[onboarding] enrichment ready but no adminUserId — skipping DM");
    return;
  }
  const admin = await db.user.findUnique({
    where: { id: args.adminUserId },
    select: { phoneNumber: true },
  });
  if (!admin?.phoneNumber) {
    console.warn("[onboarding] enrichment ready but admin has no phone — skipping DM");
    return;
  }

  const url = await buildAdminLink({
    userId: args.adminUserId,
    orgId: args.orgId,
    nextPath: `/finish-setup/${args.sessionId}`,
  });
  const text = buildEnrichmentReviewDm(
    {
      messagesAnalyzed: summary.messagesAnalyzed,
      groupName: args.groupName,
      playerCount: summary.playerCount,
      url,
    },
    args.lang,
  );

  await db.botJob.create({
    data: {
      orgId: args.orgId,
      kind: "dm",
      phone: admin.phoneNumber.replace(/^\+/, ""),
      text,
    },
  });
}
