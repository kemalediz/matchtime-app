/**
 * The help copy: "@Match Time help" and "how do I turn on the pool?", in
 * every group and by DM (`buildHelpReply`), and the feature-aware "how to
 * use me" block (`buildHowToUseMe`).
 *
 * The legacy in-group setup that lived here ("@MatchTime set up", the
 * OnboardingSession Q&A) was deleted on 2026-10-30: it was unreachable
 * with self-join on. New clubs join through self-join (group-add.ts).
 */
import { appUrl } from "./app-url";
import { t } from "./i18n/t";
import { buildBadgeHelp } from "./badge-help";
import type { PlayersHelpTopic } from "./pipeline/types";
import type { HelpClubFacts } from "./help-club-facts";
import { SETTINGS_PATH, helpTopicSettingsPath } from "./help-links";
import { settingInfo, type SettingInfoKey } from "./settings-info";
import type { Lang } from "./i18n/lang";
import { organisersAnnounce } from "./list-announcer";

/**
 * The feature-aware "how to use me" usage block, printed by "@Match Time
 * help" (`buildHelpReply`). Teaches the shipped
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
  // Every member has a profile page (2026-11-02), so the link is always given.
  return t(lang).onbHowToUseMe({ ...features, profileUrl: appUrl("/profile") });
}

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

/** A help topic the bot can explain: the list the question extractor
 *  names (`HELP_FEATURES`), but the admin group's own two, which the
 *  callers map first (`playersHelpTopic`, admin-group-help.ts). */
export type HelpTopic = PlayersHelpTopic;

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
  /** The club plays as a monthly squad (`Organisation.squadMode =
   *  "monthly"`, 2026-11-03): the month's regulars are in every game and
   *  only a pay as you go player says IN. An organiser's "help
   *  availability" also says how a month starts from his list. A missing
   *  value reads as off. */
  monthly?: boolean;
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
    squadMode?: string | null;
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
    monthly: f.squadMode === "monthly",
    ...(club ? { pool: club.pool, partners: club.partners } : {}),
  };
}

// Stable order for the bare-help topic list.
const HELP_TOPIC_ORDER: HelpTopic[] = [
  "availability",
  "friend",
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
  /** Answered by DM: "help teams" is typed without the tag. */
  dm?: boolean;
  /** Answered in the club's admin group (admin-group-help.ts), where some
   *  things are done by message that the players' copy says are not. */
  adminGroup?: boolean;
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

/** Is partner asking on: an active partnership, the one switch (Kemal,
 *  2026-11-08; `partner-ask-rules.ts` `canAsk`). */
function partnersOn(features: HelpFeatures): boolean {
  return (features.partners?.active ?? 0) > 0;
}

function topicIsOn(topic: HelpTopic, features: HelpFeatures): boolean {
  if (topic === "schedule" || topic === "badges" || topic === "settings") return true;
  // The friend link works only while attendance is on (`decideThirdPartyIn`).
  if (topic === "friend") return features.attendance === true;
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

/** The topics switched off for this club that an organiser can switch on
 *  now, in menu order (2026-11-10, Kemal: "why it never mentions not used
 *  features such as payments"). */
export function helpTopicsOff(features: HelpFeatures): HelpTopic[] {
  return HELP_TOPIC_ORDER.filter((tp) => switchableOff(tp, features));
}

/** Every topic this club can ask about: on, or off and switchable on. A
 *  pool the platform has closed is neither. */
export function helpTopicsAskable(features: HelpFeatures): HelpTopic[] {
  return HELP_TOPIC_ORDER.filter((tp) => topicIsOn(tp, features) || switchableOff(tp, features));
}

/** The menu line naming what is not switched on here, worded as available;
 *  "" when everything is on. */
export function helpNotOnLine(features: HelpFeatures, lang: Lang | string, dm = false): string {
  const s = t(lang);
  const off = helpTopicsOff(features);
  if (off.length === 0) return "";
  // Payments first as the example when it is off: it is what clubs ask for.
  const example = off.includes("payments") ? "payments" : off[0];
  return s.help_not_on({ labels: off.map((tp) => s.onbHelpTopicLabel({ topic: tp })), word: s.onbHelpTopicWord({ topic: example }), dm });
}

/**
 * The help reply, in every group and by DM. ONE builder, so no two places
 * can disagree (2026-09-30). Every topic answers three things in a few
 * lines, in the club's language (2026-10-28): what it does, whether it is
 * on for this club now, and (for an organiser) how to switch it, with a
 * link straight to its card on the settings page (help-links.ts).
 *
 *   - topic === null (bare help): the short menu (2026-11-10, Kemal: "why
 *     this long menu"): how to say In or Out, how to tag, the profile page,
 *     then one line teaching "help <topic>" with every topic word this club
 *     can ask about, off ones too. An organiser also gets the features not
 *     switched on yet, worded as available (`helpNotOnLine`), and a link
 *     to the settings page. The rest of the old how-to block is said by
 *     its topic (availability, friend, mom, ratings, reminders, payments).
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
      ...(ctx.adminGroup ? { adminGroup: true } : {}),
    });
  }
  if (topic === "settings") return s.onbHelpSettings({ audience: ctx.audience, url: topicUrl });
  if (topic === "partners") {
    return s.onbHelpPartners({
      audience: ctx.audience,
      active: features.partners?.active ?? 0,
      url: topicUrl,
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
    });
  }
  if (topic === "friend") {
    // The friend link (#488): its own topic since 2026-10-31. Organisers
    // mode and organiser picks change nothing about it; an organiser also
    // hears that his own add is direct (D1). It has no switch of its own:
    // with attendance off it works nowhere, so the answer says so and how
    // attendance is switched on, like any flag topic that is off.
    const body =
      s.onbHelpFriend({ fees: features.paymentCollection === true }) + adminTail(s.onbHelpFriendLinkOrganiser);
    if (topicIsOn(topic, features)) return body;
    const switchOn = s.onbHelpSwitchOn({
      topic: "availability",
      audience: ctx.audience,
      url: topicUrl,
      word: s.onbHelpTopicWord({ topic }),
      label: title("attendance"),
    });
    return `${s.onbHelpOffLead()}\n\n${body}\n\n${switchOn}`;
  }
  if (topic && isFlagTopic(topic)) {
    if (organisers && topic === "teams") {
      return s.onbHelpOrganisersExplainer({ topic, organiserPicks: picks }) + adminTail(s.onbHelpAdminSettings({ url: topicUrl }));
    }
    // A monthly squad (2026-11-03): the month's regulars are in every game,
    // so the weekly "say In or Out for the next game" is not how it works.
    const base =
      organisers && (topic === "availability" || topic === "reminders")
        ? s.onbHelpOrganisersExplainer({ topic, organiserPicks: picks })
        : topic === "availability" && features.monthly === true
          ? s.onbHelpAvailabilityMonthly
          : topic === "availability" && picks
            ? s.onbHelpAvailabilityOrganiserPicks
            : s.onbHelpExplainer({ topic });
    // The friend link (#488, 2026-10-31) is part of saying who plays: a
    // player's friend joins by his own link (friend-link/rules.ts); an
    // organiser's add stays direct (D1).
    const explainer =
      topic === "availability"
        ? `${base}\n${s.onbHelpFriendLink}${admin ? ` ${s.onbHelpFriendLinkOrganiser}` : ""}${admin && features.monthly ? `\n\n${s.onbHelpMonthListOrganiser}` : ""}` +
          // DM the people a message tagged (2026-11-09, named-invite.ts).
          (admin ? `\n${s.onbHelpDmTaggedOrganiser}` : "")
        : base;
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

  // Bare help: the short menu.
  const asks: Array<"squad" | "teams" | "stats"> = [];
  if (features.attendance && !organisers) asks.push("squad");
  if (features.teamBalancing && !organisers) asks.push("teams");
  if (features.statsQa) asks.push("stats");
  const menu = s.onbHelpMenu({
    attendance: features.attendance,
    organisers,
    asks,
    profileUrl: appUrl("/profile"),
    playerRating: features.playerRating,
    momVoting: features.momVoting,
    ...(ctx.dm ? { dm: true } : {}),
  });
  // An organiser also hears what is switched off, worded as available;
  // each explains how to switch it on when asked about (2026-10-28). A
  // player is not nagged with it (FNF, 2026-10-15): the topic list below
  // still names them.
  const offLine = admin ? helpNotOnLine(features, lang, ctx.dm === true) : "";
  const hqPointer = admin && organisers && ctx.adminGroupLinked === true ? s.onbHelpAdminOrganisers : "";
  const settingsLine = admin ? s.onbHelpAdminPage({ url: helpLink(ctx, "settings", null), signedIn: !!ctx.links?.settings }) : "";
  const words = helpTopicsAskable(features).map((tp) => s.onbHelpTopicWord({ topic: tp }));
  // The example is payments, not teams: in the players' group the router
  // reads "help teams" as a request for the teams (live probe, 2026-11-10).
  const more = s.help_more({ words, example: s.onbHelpTopicWord({ topic: "payments" }), ...(ctx.dm ? { dm: true } : {}) });
  return [menu, offLine, hqPointer, settingsLine, more].filter(Boolean).join("\n");
}
