/**
 * "WHAT CAN YOU DO?" IN A CLUB'S ADMIN GROUP (2026-10-15; asked in any
 * words since 2026-10-16).
 *
 * An owner or admin of a live club asks what MatchTime does in the admin
 * group (HQ), in their own words ("help", "what can you do?", "neler
 * yapabiliyorsun?"). The shared router reads it as its `help` route
 * (`admin-group-understand.ts`) and this module writes the answer.
 *
 * A LIST OF TOPICS, FULL TOPICS ONE STEP AWAY (2026-11-10, Kemal: "why
 * this long menu when we say @mt help", then "only one liner explanation
 * for each and if they wanna learn more they would just drill down further
 * by saying @Match Time help xxx"). The answer (`buildHqHelp`) is how to
 * tag, how to drill down, the club's topics one line each (those switched
 * off here say so), and "anything else". "@Match Time help <topic>"
 * (squad, teams, players, game, settings, graphics, payments; the question
 * extractor's `feature`, never a word list) gives that topic's full lines
 * (`buildHqTopicLines`), then how that part works for the organisers
 * (`hqHelpTopicReply`). Every line of the old long menu is in exactly one
 * topic (help-short-menus.test.ts).
 *
 * WHAT EACH LINE OF THE ANSWER IS DONE BY:
 *
 *   squad list pasted, YES       admin-group-paste.ts (structured: the
 *                                pasted list is read deterministically)
 *   squad changes in any words   router other_att/self_att, then the
 *                                attendance engine (admin-group-squad-change.ts)
 *   show / reshuffle / swap / move the teams
 *                                router balancer, the teams extractor, then
 *                                team-proposal.ts handleTeamCommand
 *   YES to the teams             router approve, the safe-YES rule
 *                                (admin-group-confirm-rules.ts), answerTeamsYes
 *   poster / team sheet          router poster / team_sheet, then
 *                                admin-group-graphics.ts answerGraphicRequest
 *   ask the group for a player   router ask_group, then
 *                                admin-group-ask-group.ts askPlayersGroup
 *   pick: numbers, names, ALL, NONE
 *                                organiser-pick.ts handlePickReply (structured)
 *   PAID ALL / PAID 1 3 / PAID NONE
 *                                month-payment.ts handleCollectorPaidReply
 *                                (structured)
 *   "Bilal is free this week"    router admin_ops, the admin extractor's
 *                                fee_waiver, then fee-waiver.ts
 *                                answerFeeFreeInHq (a club taking fees)
 *   "ask the player pool for 2"  router ask_group, the admin extractor's
 *                                `playersFrom` "pool", then
 *                                admin-group-pool.ts (decision log L10.1).
 *                                Listed only while the pool is open for the
 *                                club (2026-10-28, Kemal; the log's L3.6
 *                                "no help-menu line" is superseded, row H.1)
 *   quiet hours on, off, times   router admin_ops, the admin extractor's
 *                                quiet_hours, then quiet-hours-words.ts and
 *                                quiet-hours-save.ts (#483; every club, a
 *                                new one starts with them off, #486)
 *   a game's day or time         router admin_ops, the admin extractor's
 *                                move_game (shown the games to come), then
 *                                game-move-words.ts and the one kickoff
 *                                mover, activity-kickoff-move.ts (2026-11-10)
 *   how any part works           router help or question, the question
 *                                extractor's how_it_works with its topic,
 *                                then buildHelpReply for the organisers
 *
 * Which lines a club gets follows the same gates admin-group.ts applies:
 * the squad and team lines for a live weekly club, the graphics for a live
 * club, the pick line for organiser pick, PAID for a monthly club.
 */
import { paymentMessagesOn } from "./payment-messages";
import { t } from "./i18n/t";
import { poolOffersOpenForClub } from "./pool/flags";
import { organisersAnnounce } from "./list-announcer";
import { effectiveTeamsReadyTime } from "./team-proposal-rules";
import { helpFeaturesFrom, helpTopicsAskable, helpTopicsOff, type HelpFeatures, type HelpTopic } from "./onboarding-conversation";
import type { HelpFeature, HelpRequest } from "./pipeline/types";
import type { OrgFeatures } from "./org-features";
import type { HelpClubFacts } from "./help-club-facts";

/** Which HQ commands a club gets (`hqHelpGates`). */
export interface HqHelpGates {
  /** A live weekly club: the pasted list, one change, the team commands. */
  squad: boolean;
  /** A live club: the poster and the team sheet. */
  graphics: boolean;
  /** `benchPickMode = "organiser"`: the pick replies. */
  picks: boolean;
  /** A monthly club: the collector's PAID reply. */
  paid: boolean;
  /** A club that takes match fees: giving a free place (fee-waiver.ts). */
  free?: boolean;
  /** A weekly club the player pool is open for: asking it in words. */
  pool?: boolean;
}

/** The admin group's help topics (Kemal, 2026-11-10): the short menu's
 *  lines, each one the whole of its topic on "@Match Time help <topic>".
 *  Every line of the old long menu is in exactly one of them. */
export const HQ_HELP_TOPICS = ["squad", "teams", "players", "game", "settings", "graphics", "payments"] as const;
export type HqHelpTopic = (typeof HQ_HELP_TOPICS)[number];

/** The extractor's feature for each HQ topic: what "help <word>" is read
 *  as (`HELP_FEATURES`, the question extractor's `feature`). */
const HQ_TOPIC_FEATURE: Record<HqHelpTopic, HelpFeature> = {
  squad: "availability",
  teams: "teams",
  players: "find_players",
  game: "schedule",
  settings: "settings",
  graphics: "graphics",
  payments: "payments",
};

/** The players' help topic said after an HQ topic's own lines: how that
 *  part works and how to switch it (`buildHelpReply`). None for the two
 *  that exist only here. */
const HQ_TOPIC_EXPLAINER: Record<HqHelpTopic, HelpTopic | null> = {
  squad: "availability",
  teams: "teams",
  players: null,
  game: "schedule",
  settings: "settings",
  graphics: null,
  payments: "payments",
};

/** The HQ topic a help feature is answered with, or null when the
 *  players' explainer answers it alone (MoM, ratings, the pool, ...). */
export function hqTopicFor(f: HelpFeature): HqHelpTopic | null {
  return HQ_HELP_TOPICS.find((tp) => HQ_TOPIC_FEATURE[tp] === f) ?? null;
}

/** The players' topics an admin can also ask about here, listed after the
 *  HQ topics, each when on or switchable on. */
const HQ_MORE_TOPICS = ["payments", "partners", "pool", "mom", "ratings", "reminders"] as const satisfies readonly HelpTopic[];

/** One HQ topic's full lines for this club, under its heading; "" when the
 *  club has nothing in it. */
export function buildHqTopicLines(topic: HqHelpTopic, p: HqHelpGates & { lang: string | null | undefined }): string {
  return t(p.lang).hq_help_topic({ topic, squad: p.squad, graphics: p.graphics, picks: p.picks, paid: p.paid, free: p.free === true, pool: p.pool === true });
}

/**
 * The HQ menu (Kemal, 2026-11-10: "only one liner explanation for each"),
 * in the club's language: how to tag, how to drill down, one line per
 * topic, anything else. The HQ topics the club has something in, then the
 * players' topics it can ask about here. `features`: the club's help
 * features (`helpFeaturesFrom` with its pool and partner clubs), for the
 * topics it can ask about and "(off here)" on those switched off. Absent
 * (its settings could not be read): the HQ topics and payments, no marker.
 */
export function buildHqHelp(p: HqHelpGates & { lang: string | null | undefined; features?: HelpFeatures }): string {
  const hqTopics = HQ_HELP_TOPICS.filter((tp) => tp !== "payments" && buildHqTopicLines(tp, p) !== "");
  const askable: readonly HelpTopic[] = p.features ? helpTopicsAskable(p.features) : ["payments"];
  const off = new Set(p.features ? helpTopicsOff(p.features) : []);
  const more = HQ_MORE_TOPICS.filter((tp) => askable.includes(tp));
  return t(p.lang).hq_help_menu({
    squad: p.squad,
    topics: [...hqTopics.map((topic) => ({ topic })), ...more.map((topic) => (off.has(topic) ? { topic, off: true } : { topic }))],
  });
}

/** The HQ menu for a club, read from its settings: its features and its
 *  pool and partner clubs. A failed read leaves out what it could not
 *  know (the topics beyond the HQ ones, the "(off here)"), never the menu. */
export async function hqHelpMenu(args: {
  orgId: string;
  lang: string | null | undefined;
  gates: HqHelpGates;
  features?: OrgFeatures;
  poolEnv?: Record<string, string | undefined>;
  club?: HelpClubFacts;
}): Promise<string> {
  try {
    const features = args.features ?? (await (await import("./org-features")).getOrgFeatures(args.orgId));
    const club = args.club ?? (await (await import("./help-club-facts")).loadHelpClubFacts(args.orgId, args.poolEnv ?? {}));
    return buildHqHelp({ lang: args.lang, ...args.gates, features: helpFeaturesFrom(features, club) });
  } catch (err) {
    console.error(`[admin-group] ${args.orgId}: help menu settings read failed:`, err);
    return buildHqHelp({ lang: args.lang, ...args.gates });
  }
}

/**
 * "@Match Time help <topic>" in the admin group: the topic's own lines
 * (`buildHqTopicLines`), then how that part works and how to switch it,
 * for the organisers (`clubHelpReply`), then the way back to the menu. A
 * topic only the players' help explains (MoM, the pool, ...) is that
 * explainer alone. An off feature still says how it works and how to
 * switch it on.
 */
export async function hqHelpTopicReply(args: {
  orgId: string;
  lang: string | null | undefined;
  gates: HqHelpGates;
  req: HelpRequest & { topic: HelpFeature };
  features: OrgFeatures;
  poolEnv?: Record<string, string | undefined>;
  club?: HelpClubFacts;
}): Promise<string> {
  const hq = hqTopicFor(args.req.topic);
  const own = hq ? buildHqTopicLines(hq, { lang: args.lang, ...args.gates }) : "";
  const explainerTopic = hq ? HQ_TOPIC_EXPLAINER[hq] : args.req.topic;
  const { clubHelpReply } = await import("./help-answer");
  const explainer = explainerTopic
    ? await clubHelpReply({
        orgId: args.orgId,
        req: { ...args.req, topic: explainerTopic },
        features: args.features,
        audience: "admin",
        poolEnv: async () => args.poolEnv ?? {},
        adminGroup: true,
        noBackLine: true,
        ...(args.club ? { club: args.club } : {}),
      })
    : "";
  return [own, explainer, t(args.lang).help_back({})].filter(Boolean).join("\n\n");
}

/**
 * Which HQ commands a club gets, the ONE place the help (`answerHqHelp`,
 * admin-group.ts, which asks only for a live club) and the introduction
 * below read them from, so the two never disagree: the squad and team
 * commands for a weekly club, the graphics for any club, the pick line for
 * organiser pick, PAID for a monthly club.
 */
export function hqHelpGates(
  org: {
    squadMode?: string | null;
    benchPickMode?: string | null;
    paymentCollectionEnabled?: boolean | null;
    paymentTrackingEnabled?: boolean | null;
    featurePlayerPool?: boolean | null;
  },
  /** The pool switch as the request resolved it (`pool/switch-env.ts`).
   *  Absent (the introduction): the pool line is left out. */
  poolEnv?: Record<string, string | undefined>,
): Required<HqHelpGates> {
  const monthly = org.squadMode === "monthly";
  return {
    squad: !monthly,
    graphics: true,
    picks: org.benchPickMode === "organiser",
    // The collector's PAID reply: a monthly club that tracks or collects
    // payments (2026-11-03: with both off nothing about payments is said).
    paid: monthly && paymentMessagesOn(org),
    // Free places (2026-10-16): only where the club takes match fees.
    free: org.paymentCollectionEnabled === true || org.paymentTrackingEnabled === true,
    // The pool (2026-10-28): asked in words from HQ by a weekly club only
    // (admin-group-pool.ts), and only while it is open for the club.
    pool: !monthly && !!poolEnv && poolOffersOpenForClub({ featurePlayerPool: org.featurePlayerPool === true }, poolEnv),
  };
}

/** What the introduction reads: Organisation columns plus the weekdays of
 *  the club's active games. A missing feature column reads as its database
 *  default (on). */
export interface AdminGroupIntroClub {
  name: string;
  language: string | null;
  whatsappBotEnabled: boolean | null;
  squadMode?: string | null;
  benchPickMode?: string | null;
  listAnnouncer?: string | null;
  teamsReadyTime?: string | null;
  featureAttendance?: boolean | null;
  featureMomVoting?: boolean | null;
  featurePlayerRating?: boolean | null;
  /** The payment flags (2026-11-03): with both off the intro says nothing
   *  about payments (`payment-messages.ts`). */
  paymentTrackingEnabled?: boolean | null;
  paymentCollectionEnabled?: boolean | null;
  /** `Activity.dayOfWeek` of each active activity (0 = Sunday). */
  activityDays: number[];
}

/**
 * MATCHTIME'S INTRODUCTION IN A NEWLY LINKED ADMIN GROUP (2026-10-15).
 *
 * Replaces the bare "Linked as the admin group" line (FNF HQ, 2026-10-15:
 * another organiser asked "Whats this?"). Posted once per club and group
 * (`admin-group-intro.ts`). Every clause is true for THIS club:
 *
 *   the weekday           every active Activity on one `dayOfWeek`; else "games"
 *   not switched on       `whatsappBotEnabled` false (a club setting up):
 *                         the lines describe what happens once it is on
 *   IN and OUT            a weekly club with `featureAttendance` (the
 *                         attendance engine; a monthly club's list is
 *                         monthly-paste.ts's, so not claimed)
 *   balanced teams at T   team-proposal.ts `teamProposalJobs`: weekly only,
 *                         at `effectiveTeamsReadyTime` (10:00 when the
 *                         organisers announce and nothing is set, else off)
 *   poster, team sheet    admin-group-graphics.ts (the help's `graphics`
 *                         gate), and the team sheet on approval
 *   MoM, ratings          `featureMomVoting`, `featurePlayerRating`
 *                         (due-key-feature.ts `featureForDueKey`: mom-, rate-)
 *   list stays here       `listAnnouncer` "organisers" (list-announcer.ts;
 *                         bot-scheduler.ts `toOrganisers`), weekly + attendance
 *   list in main chat     `listAnnouncer` "matchtime", weekly + attendance;
 *                         with a teams time, YES posts the teams there
 *                         (team-proposal.ts `answerTeamsYes`)
 *   who plays             the help's `picks` gate (organiser-pick.ts)
 *   PAID                  the help's `paid` gate (month-payment.ts)
 *   notices here          linking sets `adminChannelMode` "admin-group"
 *                         (admin-channel.ts `sendAdminNotice`)
 *   rating notice         organisers mode relays the rate promo, behind
 *                         `featurePlayerRating` (bot-scheduler.ts
 *                         `relayToOrganisers`). Badges are NOT relayed: they
 *                         post in the players' group for every club
 *                         (2026-10-16), so the intro does not mention them
 *   help                  the router's `help` route, answered for a live club only
 */
export function buildAdminGroupIntro(club: AdminGroupIntroClub): string {
  const gates = hqHelpGates(club);
  const weekly = club.squadMode !== "monthly";
  const organisers = organisersAnnounce(club);
  const attendance = club.featureAttendance !== false;
  const ratings = club.featurePlayerRating !== false;
  const days = [...new Set(club.activityDays)];
  const time = effectiveTeamsReadyTime(club.teamsReadyTime, organisers);
  const teamsAt = weekly && time !== "off" ? time : null;
  const lists = weekly && attendance;
  return t(club.language).admin_group_intro({
    club: club.name,
    live: club.whatsappBotEnabled === true,
    dow: days.length === 1 ? days[0] : null,
    tracks: lists,
    teamsAt,
    graphics: gates.graphics,
    mom: club.featureMomVoting !== false,
    ratings,
    organisersShare: lists && organisers,
    mainChatList: lists && !organisers,
    teamsPosted: !organisers && teamsAt !== null,
    picks: gates.picks,
    paid: gates.paid,
    relayRatings: organisers && ratings,
  });
}
