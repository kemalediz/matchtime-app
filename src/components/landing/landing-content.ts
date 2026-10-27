/**
 * THE LANDING PAGE'S CONTENT, as data (website update G0, part 1,
 * 2026-10-24). `landing-page.tsx` lays it out with the shared section
 * components in `landing-sections.tsx`; nothing here knows about markup,
 * icons or colours beyond a key.
 *
 * Every claim is shipped behaviour. The comment above each one names the
 * code that does it, so the copy can be checked against the product. The
 * numbers in the partner clubs section are read from the rules modules
 * that enforce them, so the page cannot drift from the product.
 *
 * Plain text only: straight apostrophes and real quote marks, no HTML
 * entities, no em or en dashes, no slashes as separators, "bench" and
 * never "waiting list", no real club or player names (the examples use
 * the fictional Riverside FC). `__tests__/landing-content.test.ts` and
 * `src/app/__tests__/public-copy.test.ts` hold these rules.
 *
 * ADDING A SECTION (for example the local player pool, slice L2): add one
 * `Spotlight` to `LANDING_SPOTLIGHTS` where it should appear, with a
 * `navLabel` if it belongs in the top menu. The page renders it with the
 * same component as the others, and the nav picks it up. Nothing else
 * changes.
 *
 * PAGE ORDER (round three, Kemal 2026-10-27): the hero, the attendance
 * cards (`ATTENDANCE_FEATURE_KEYS`: who's in, short of players, the bench),
 * the short-of-players story for clubs (`SHORT_OF_PLAYERS`: own group,
 * partner clubs, then the player pool), the players' pool pitch, then the
 * rest of the features and the other spotlights.
 *
 * THE PLAYER POOL (G0 part 2, with slice L2): its section follows the
 * short-of-players one and carries the "Join the MatchTime player pool" invitation,
 * a button to /play. Whether a sign-up goes on the early sign-up list is
 * the server's switch, so the line that says so is added by the page
 * (`spotlightFor`, `poolOpeningLine`), never baked into the lead.
 *
 * THE TWO AUDIENCES (Kemal, 2026-10-25): the menu has a "For clubs" and a
 * "For players" group (`LANDING_NAV_GROUPS`); the hero carries its own
 * invitation to players (`HERO_POOL_INVITE`); and `/players` is a page for
 * players only (`PLAYERS_PAGE`), built from the pool section's own steps,
 * points and privacy note, so both read one source.
 *
 * The landing page is English only today (the club's language is not
 * known to a signed-out visitor, and the page has never been translated).
 */
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "@/lib/club-partnership-rules";
import { MAX_RADIUS_MILES } from "@/lib/club-discovery-rules";
import { PLAYERS_PAGE_PATH, POOL_PLAY_PATH } from "@/lib/pool/paths";
import { POOL_CAPS, POOL_MIN_AGE, POOL_QUIET_HOURS } from "@/lib/pool/rules";
import { POOL_AFTER_PARTNERS_MINS } from "@/lib/pool/round-rules";
import { SPORT_LEVELS, levelLabel, liveSports } from "@/lib/pool/sports";
import { poolOfferEn } from "@/lib/i18n/pool-offer.en";

// ── The sport the site is about (Kemal, 2026-10-25: football only, for now) ──
//
// The chips and the pool card are derived from `LIVE_SPORTS`
// (src/lib/pool/sports.ts). The lines below say "football" in plain words;
// when another sport is switched on there, reword them here (and only here:
// src/app/layout.tsx and the hero read them).

/** The pool is asked this long after partner clubs (pool/round-rules.ts). */
const POOL_AFTER = POOL_AFTER_PARTNERS_MINS === 60 ? "an hour" : `${POOL_AFTER_PARTNERS_MINS} minutes`;
const POOL_AFTER_CAP = POOL_AFTER.charAt(0).toUpperCase() + POOL_AFTER.slice(1);

/** "A, B or C". */
function joinWords(words: readonly string[], last: "and" | "or"): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

/**
 * "5, 7, 8, 9 and 11-a-side football": every live sport with its formats,
 * from the catalogue, so the site never lists a subset of what the sign-up
 * offers (Kemal, 2026-10-25: "there are venues for 8 and 9 aside too").
 */
export function liveFormatsPhrase(last: "and" | "or" = "and"): string {
  return joinWords(
    liveSports().map((s) => {
      const name = s.label.en.toLowerCase();
      return s.formats.length ? `${formatsWords(s.formats, last)} ${name}` : name;
    }),
    "and",
  );
}

/** "5, 7, 8, 9 or 11-a-side". */
function formatsWords(formats: readonly number[], last: "and" | "or"): string {
  return `${joinWords(formats.map(String), last)}-a-side`;
}

/** Football's live formats, "5, 7, 8, 9 or 11-a-side" (the organiser guide). */
export function footballFormatsWords(last: "and" | "or" = "or"): string {
  return formatsWords(liveSports().find((s) => s.key === "football")?.formats ?? [], last);
}

/** One keyword per live format: "8-a-side football organiser". */
const FORMAT_KEYWORDS: string[] = liveSports().flatMap((s) => s.formats.map((n) => `${n}-a-side ${s.label.en.toLowerCase()} organiser`));

/** Search and link-preview text (src/app/layout.tsx). */
export const SITE_META = {
  title: "MatchTime: run your weekly football on autopilot",
  description:
    "MatchTime lives in your WhatsApp group and runs your weekly football: it tracks who's in, runs the bench, asks partner clubs and then the MatchTime player pool when you're short, balances teams on request, and collects ratings and Man of the Match votes.",
  ogDescription: `WhatsApp organiser for weekly ${liveFormatsPhrase()}: who's in, the bench, fair teams, and players from partner clubs and the pool when you're short.`,
  keywords: [
    "football team management",
    ...FORMAT_KEYWORDS,
    "whatsapp football bot",
    "football team balancer",
    "match attendance tracker",
    "pickup football",
    "man of the match voting",
    "whatsapp football organiser",
  ],
};

/**
 * The home page's hero (variant E, 2026-10-26): a pill, the headline, one
 * line, the two buttons, then the players' card and the feature deck
 * (`HERO_DECK`). The tick row ("No app for players") went in round three
 * (Kemal, 2026-10-27); the line hints at the short-of-players story. No
 * pricing here (Kemal: pricing belongs on the pricing page; the teaser
 * further down and /pricing carry it).
 */
export const HERO = {
  pill: "For weekly football groups",
  titleLead: "Your players WhatsApp.",
  titleTail: "MatchTime runs the game.",
  line: "Who's in, the bench, fair teams, and nearby players when you're short. All in your group chat.",
  primary: { label: "Start your group", href: "/signup" } satisfies NavLink,
  secondary: { label: "See how it works", href: "#how-it-works" } satisfies NavLink,
};
import { poolPageCopy } from "@/lib/pool/page-copy";

// ─── Types ─────────────────────────────────────────────────────────────

export type IconKey =
  | "message"
  | "users"
  | "zap"
  | "scale"
  | "trophy"
  | "chart"
  | "card"
  | "shield-check"
  | "link"
  | "clock"
  | "building"
  | "gamepad"
  | "trending"
  | "flame"
  | "list"
  | "crown"
  | "swords"
  | "medal"
  | "share"
  | "handshake"
  | "map-pin"
  | "clipboard"
  | "pencil"
  | "shuffle"
  | "calendar-x"
  | "image"
  | "hand"
  | "bell"
  | "repeat"
  | "calendar"
  | "megaphone"
  | "languages"
  | "user-plus";

export type ColorKey = "blue" | "green" | "amber" | "purple" | "teal" | "rose" | "violet";

/** A titled card: a feature, a point in a spotlight, a stat. */
export interface Card {
  key: string;
  icon: IconKey;
  color: ColorKey;
  title: string;
  body: string;
}

/** A numbered step. */
export interface Step {
  key: string;
  title: string;
  body: string;
}

export interface ChatLine {
  from: "player" | "bot";
  text: string;
}

/**
 * One section of the page between the features grid and the player
 * stats: a heading, a lead, then optionally numbered steps, a set of
 * cards, a boxed list (privacy) and an example conversation.
 */
export interface Spotlight {
  /** The anchor (`#id`) and the section's DOM id. */
  id: string;
  /** Shown in the top menu when set, in the `navGroup` audience's group. */
  navLabel?: string;
  navGroup?: NavAudience;
  tone: "light" | "dark";
  eyebrow: string;
  title: string;
  lead: string;
  /** Numbered steps, with `stepsLabel` as the list's accessible name. */
  steps?: Step[];
  stepsLabel?: string;
  points: Card[];
  note?: { title: string; items: Array<{ key: string; text: string }> };
  chat?: { caption: string; lines: ChatLine[] };
  /** One closing line under the section, e.g. how to set it up. */
  footnote?: string;
  /** One highlighted benefit line under the lead (the pool section). */
  benefit?: string;
  /** A drawn WhatsApp chat beside the heading (the pool section's offer). */
  offerChat?: DeckChat;
  /** The pool section: its lead is followed by the line that says whether
   *  a sign-up goes on the early list (`spotlightFor`). */
  poolOpeningLine?: boolean;
  /** A button under the heading (the player pool's invitation, G0).
   *  `pulse`: the soft pulsing ring (globals.css `.pool-invite-pulse`). */
  cta?: Cta;
}

/** A button. `pulse`: the soft pulsing ring (globals.css `.pool-invite-pulse`),
 *  kept for the players' invitations only (the test pins the list). */
export interface Cta {
  label: string;
  href: string;
  pulse?: boolean;
}

// ─── Top menu ──────────────────────────────────────────────────────────

export interface NavLink {
  label: string;
  href: string;
}

export type NavAudience = "clubs" | "players";

/** The pricing page (2026-10-25): the price's one home (pricing-section.tsx). */
export const PRICING_PATH = "/pricing";

/** One audience's menu: its links, then its own button. */
export interface NavGroup {
  id: NavAudience;
  label: string;
  links: NavLink[];
  cta: NavLink;
}

/**
 * The campaign codes the website's own buttons send to /play (`?src=`,
 * read by `pool/profile-fields.ts` readSignupSource). A sign-up counts
 * under the code only while an active `PoolCampaign` with that code
 * exists (`pool/signup.ts` resolveSource; the owner makes one at
 * /admin/pool/campaigns); until then it counts as "web", as before.
 */
export const POOL_SITE_SOURCES = Object.freeze({
  hero: "site-hero",
  nav: "site-nav",
  players: "site-players",
});

const poolJoinHref = (code: string) => `${POOL_PLAY_PATH}?src=${code}`;

// ─── The features grid ("Why MatchTime") ───────────────────────────────

/** The first three features, shown straight after the hero as the
 *  attendance section (round three): who's in, short of players, the
 *  bench. The rest follow the player pool under `MORE_FEATURES_INTRO`. */
export const ATTENDANCE_FEATURE_KEYS = ["in-out", "chase", "bench"] as const;

export const MORE_FEATURES_INTRO = {
  eyebrow: "Every week",
  title: "Teams, ratings, payments and the rest.",
};

export const FEATURES_INTRO = {
  eyebrow: "Why MatchTime",
  title: "The boring admin, done for you.",
  lead: "Counting names, chasing late replies, filling the place when someone drops out. MatchTime does it in the group you already use, and stays quiet the rest of the time.",
};

export const FEATURES: Card[] = [
  {
    key: "in-out",
    color: "green",
    icon: "message",
    title: "Tracks who's in",
    body: "Players say In or Out the way they always have. MatchTime ticks each one with ✅ and keeps the squad list. Say “maybe” and it checks back with you by DM a day before kickoff.",
  },
  {
    // Short of players, second (Kemal, 2026-10-27): the chase (daily
    // update, match morning, last hours), then partner-ask.ts, then the
    // pool (pool/round-rules.ts, partners first). Told in full in the
    // short-of-players section below.
    key: "chase",
    color: "rose",
    icon: "zap",
    title: "Short of players? It asks around",
    body: "Someone drops out and nobody's on the bench? MatchTime asks your group in its updates and stops the moment you're full. Then it can ask your partner clubs, and after them nearby players from the MatchTime player pool.",
  },
  {
    key: "bench",
    color: "purple",
    icon: "users",
    title: "Runs the bench",
    body: "When the squad is full, late Ins go on the bench 🪑. When someone drops, the bench is offered the spot in the group and by DM, and the first to claim it plays.",
  },
  {
    key: "teams",
    color: "blue",
    icon: "scale",
    title: "Balanced teams when you ask",
    body: "Tag it with “@Match Time generate the teams” and it splits the confirmed squad using each player's rating and position. Admins can swap players or edit the teams from the dashboard.",
  },
  {
    key: "ratings",
    color: "amber",
    icon: "trophy",
    title: "Ratings and Man of the Match",
    body: "After the game every player gets a private link to rate the others from 1 to 10 and pick a Man of the Match. The winner is announced in the group once everyone has voted.",
  },
  {
    key: "stats-qa",
    color: "violet",
    icon: "chart",
    title: "Stats questions, answered in the group",
    body: "Ask “@Match Time top 5 rated players this season” or “who's played the most?” and the answer is posted right there for everyone to see.",
  },
  {
    key: "payments",
    color: "teal",
    icon: "card",
    title: "Payments, if you want them",
    body: "Switch on card or bank payments and each player gets a pay link after the game. MatchTime chases whoever hasn't paid, so you stop doing the money chase yourself.",
  },
  {
    key: "quiet",
    color: "green",
    icon: "shield-check",
    title: "Quiet during the banter",
    body: "MatchTime only speaks when it's tagged, or when someone says In or Out. The jokes and the arguments about last week's penalty are left alone. Tagged messages are answered straight away.",
  },
  {
    key: "replacements",
    color: "blue",
    icon: "link",
    title: "Replacements that just work",
    body: "“Sam is replacing Joe” and Sam takes Joe's place in the squad. If the teams are already out, Sam steps into Joe's team too.",
  },
  {
    key: "short-week",
    color: "rose",
    icon: "clock",
    title: "Short-week safety net",
    body: "Numbers low the day before? Admins get a DM offering a switch to a smaller format, or a cancellation if you're below the minimum. No phone-call chains.",
  },
  {
    key: "season",
    color: "amber",
    icon: "building",
    title: "Book the whole season",
    body: "Set up a season of weekly matches in one go, then cancel the holiday weeks in bulk. Game-day reminders tell the group to bring gloves, a ball and bibs.",
  },
  {
    key: "no-accounts",
    color: "teal",
    icon: "gamepad",
    title: "No accounts, no passwords",
    body: "Players never download an app or remember a password. Every link MatchTime sends signs them straight in, and they can reply “stop” to turn off the DMs they don't want.",
  },
];

// ─── Spotlight sections ────────────────────────────────────────────────

/**
 * SHORT OF PLAYERS (round three, Kemal 2026-10-27: "most clubs suffer from
 * missing players for matches and cancellations"). One story for clubs,
 * straight after the attendance cards: the pain, then who MatchTime asks,
 * in the order the code asks. The chase (daily update, match morning, last
 * hours) and the bench; then partner clubs (club-partnership-rules.ts,
 * partner-ask.ts, partner-guest.ts); then the pool (pool/round-rules.ts
 * POOL_AFTER_PARTNERS_MINS and wave1DueAt: an hour after a partner ask of
 * the same round, at once when none is open; pool/matching-rules.ts:
 * availability, travel distance, level only when the ask names levels);
 * then a yes (pool/accept.ts: the place while it is open, or the bench
 * where the organisers pick). It replaced the partner clubs section, whose
 * how-to became the points.
 */
const SHORT_OF_PLAYERS: Spotlight = {
  id: "short-of-players",
  navLabel: "Short of players",
  navGroup: "clubs",
  tone: "dark",
  eyebrow: "Dropouts and cancellations",
  title: "Short of players? MatchTime asks around.",
  lead: "Late dropouts are how weekly games get called off. When a place is still open, MatchTime asks your own group first, then your partner clubs, then nearby players from the MatchTime player pool. All on WhatsApp, and no ringing round other groups yourself.",
  stepsLabel: "Who MatchTime asks, in order",
  steps: [
    {
      // FEATURES chase; strings.en.ts bench_offer_group_post.
      key: "group",
      title: "Your own group first",
      body: "MatchTime asks the group in its daily update, on match morning and in the last hours before kickoff, and offers a dropped place to your bench. The moment you're full, it stops.",
    },
    {
      // partner-ask.ts; settings-info.ts partnerApproval; strings.en.ts
      // xask_post; partner-guest.ts (every answer is a DM).
      key: "partners",
      title: "Then your partner clubs",
      body: "MatchTime posts your ask in a partner club's players' group, with the day, time, venue and format. Each club decides whether its organisers check every ask first, and their players answer privately.",
    },
    {
      // pool/round-rules.ts wave1DueAt; pool/matching-rules.ts candidateExclusion.
      key: "pool",
      title: "Then the local player pool",
      body: `${POOL_AFTER_CAP} after your partner clubs, or straight away if you have none, nearby players from the MatchTime player pool get the offer by private message. They're matched on when they can play and how far they'll travel, and on level only when you ask for one.`,
    },
    {
      // partner-guest.ts; pool/accept.ts placed.kind "bench"; partner-ask.ts
      // sweepPartnerAsks (closes when filled); strings.en.ts xask_thanks_dm.
      key: "yes",
      title: "A yes takes the place",
      body: "If the place is still open, the player joins your game as a guest for that match, or goes on the bench where your organisers pick. Once you're full, MatchTime closes the ask and thanks everyone who offered.",
    },
  ],
  points: [
    {
      // club-discovery-rules.ts RADIUS_PRESETS_MILES and MAX_RADIUS_MILES;
      // club-partnership-rules.ts header: a request, accepted by an owner or admin.
      key: "find",
      icon: "map-pin",
      color: "amber",
      title: "Find partner clubs near you",
      body: `Search for clubs that play up to ${MAX_RADIUS_MILES} miles from your venue and send them a request. Once one of their owners or admins accepts, you can ask them for players.`,
    },
    {
      // settings-info.ts partnerAskWhen ("Automatically at a time") and
      // poolAutoAsk; strings.en.ts xaskw_* (own words); partner-ask-round.ts
      // (partner and pool guests count towards one number).
      key: "ask",
      icon: "zap",
      color: "rose",
      title: "Ask with a tap, or let it ask",
      body: "Ask from the match page, or just tell MatchTime in your own words. You can also let it ask by itself on match day when a place is still open and nobody is on your bench. You say how many players you need, for the whole round.",
    },
    {
      // partner-guest.ts: a guest membership; organiser-pick.ts and
      // registerAttendance decide whether he plays.
      key: "guest",
      icon: "user-plus",
      color: "blue",
      title: "Guests follow your rules",
      body: "A partner's player goes on your list the same way your own players do: first to say IN, or on the bench for your organisers to pick. Your organisers see where they stand at their own club, so they know who they're getting.",
    },
    {
      // club-partnership-rules.ts: one pairing per direction (D2).
      key: "both-ways",
      icon: "handshake",
      color: "amber",
      title: "Help goes both ways",
      body: "Each pairing works one way, so a club can ask you without you asking them, or you can both help each other. When a club near you is short, your players get the chance of an extra game.",
    },
  ],
  note: {
    title: "Privacy built in",
    items: [
      // strings.en.ts xask_post ("Your number is not shared");
      // settings-info.ts partnerClubs.together.
      // Pool: plan section 6 (first name and last initial, only after a yes).
      {
        key: "numbers",
        text: "Phone numbers are never shared between clubs, and MatchTime never gives you a pool player's number. You see a partner guest's name and club, and a pool player's first name and surname initial once they say yes.",
      },
      // strings.en.ts fc_confirm_sees.
      {
        key: "discovery",
        text: "When clubs find each other, they see a club's name, venue and town, how far away it is, its game days and kickoff times, and how many members it has. Never names or phone numbers.",
      },
      // settings-info.ts partnerClubs.together[1].
      { key: "consent", text: "Your players only join another club's game if they answer its ask themselves." },
      // partner-volunteer-rules.ts: an overlapping game of his own refuses.
      { key: "overlap", text: "A player already in their own club's game at the same time can't sign up for yours." },
      // club-partnership-rules.ts PARTNER_ASK_CUTOFF_DEFAULT_HOURS;
      // partner-ask-rules.ts PARTNER_ASKS_PER_DAY.
      {
        key: "limits",
        text: `No ask goes out later than ${PARTNER_ASK_CUTOFF_DEFAULT_HOURS} hours before kickoff unless you change it, and a partner club's group gets at most two asks a day.`,
      },
      // settings-info.ts partnerClubs.what[2]; strings.en.ts pr_block_confirm.
      { key: "control", text: "Either club can pause or end a pairing at any time, and a club can block another from asking it." },
    ],
  },
  chat: {
    caption: "An ask in a partner club's group, then the private reply",
    lines: [
      // strings.en.ts xask_post, with a fictional club.
      {
        from: "bot",
        text: "⚽ Riverside FC need 1 player: Tue 20 Oct, 20:00 at Riverside Sports Centre (7-a-side). Fancy a game? Tap here to tell MatchTime privately. MatchTime will confirm with you by private message. Your number is not shared with Riverside FC.",
      },
      { from: "player", text: "IN" },
      // strings.en.ts xask_vol_in.
      { from: "bot", text: "✅ Thanks Sam, you're in for Riverside FC: Tue 20 Oct, 20:00." },
    ],
  },
  // pool/rules.ts POOL_MIN_AGE; the pool opens town by town.
  footnote: `Partner clubs are set up from your club's settings, and nothing is asked of a partner club until both clubs agree. The player pool is opening town by town, for players ${POOL_MIN_AGE} and over.`,
};

const ADMIN_GROUP: Spotlight = {
  id: "admin-group",
  navLabel: "Admin group",
  navGroup: "clubs",
  tone: "light",
  eyebrow: "For organisers",
  title: "An admin group for running the week.",
  // admin-channel.ts ("Admin WhatsApp group"); strings.en.ts hq_help;
  // settings-info.ts adminChannel ("MatchTime only acts on messages from
  // owners and admins there").
  lead: "Link your organisers' own WhatsApp group and MatchTime works there too. Admins just ask in their own words, and the messages only organisers should see arrive there instead of the players' chat. In that group MatchTime only acts on messages from your club's owners and admins.",
  points: [
    // strings.en.ts hq_help: "Paste the whole squad list"; admin-group-paste.ts.
    {
      key: "paste",
      icon: "clipboard",
      color: "blue",
      title: "Paste the squad list",
      body: "Paste the whole list and MatchTime shows you what would change. Reply YES and it's applied.",
    },
    // strings.en.ts hq_help; admin-group-squad-change.ts.
    {
      key: "squad",
      icon: "pencil",
      color: "green",
      title: "Change the squad in plain words",
      body: "“Put Bilal in”, “Sam can't make it”, “Tom to the bench”. No tag and no special commands.",
    },
    // settings-info.ts teamsReady; strings.en.ts hq_help (show, shuffle, swap, YES).
    {
      key: "teams",
      icon: "shuffle",
      color: "purple",
      title: "Check the teams first",
      body: "MatchTime can propose balanced teams on match day. Swap players or reshuffle them, then reply YES when they're final.",
    },
    // match-cancel.ts; strings.en.ts hq_help, hq_match_cancelled, hq_match_restored.
    {
      key: "cancel",
      icon: "calendar-x",
      color: "rose",
      title: "Call a match off, or back on",
      body: "Tag MatchTime to cancel the next match or put it back on, and it tells the players' group for you.",
    },
    // admin-group-graphics.ts; settings-info.ts posters.
    {
      key: "posters",
      icon: "image",
      color: "amber",
      title: "Posters and team sheets",
      body: "Ask for the list poster or the team sheet and it arrives as a picture, ready to forward to your players.",
    },
    // organiser-pick-rules.ts; settings-info.ts benchPickMode.
    {
      key: "pick",
      icon: "hand",
      color: "violet",
      title: "Pick who plays",
      body: "If your organisers choose who fills a place, the bench arrives here with positions and club ratings. Reply with a number or a name.",
    },
    // strings.en.ts xask_approval_notice (inGroup: "Reply YES to this message"), xaskw_*.
    {
      key: "partners",
      icon: "handshake",
      color: "teal",
      title: "Partner club asks",
      body: "Say YES to a partner club's ask for one of your players, or ask your partner clubs for a player in your own words.",
    },
    // fee-waiver.ts answerFeeFreeInHq; strings.en.ts hq_help (free line).
    {
      key: "fees",
      icon: "card",
      color: "green",
      title: "Let a player off the match fee",
      body: "For clubs that take match fees: tell MatchTime a player isn't paying this week, and no pay link or reminder goes to them.",
    },
    // settings-info.ts adminChannel.what[0].
    {
      key: "notices",
      icon: "bell",
      color: "blue",
      title: "Notices for organisers only",
      body: "New players to check, late drop-outs and who hasn't paid come to your organisers, not to the players' chat.",
    },
  ],
  chat: {
    caption: "In the admin group",
    lines: [
      { from: "player", text: "what can you do?" },
      // strings.en.ts hq_help, first lines.
      { from: "bot", text: "🛠️ MatchTime in your admin group. Just ask here in your own words. No need to tag me, except to cancel a match or put it back on." },
      { from: "player", text: "@Match Time cancel Friday" },
      // strings.en.ts hq_match_cancelled.
      { from: "bot", text: "Done: Friday 7-a-side, Fri 23 Oct at 20:00 is cancelled. I've told the players' group." },
    ],
  },
  // settings-info.ts adminGroupLink.
  footnote: "To link it, press Link admin group in your settings, add MatchTime to the group and send the code shown there.",
};

const YOUR_WAY: Spotlight = {
  id: "your-way",
  tone: "light",
  eyebrow: "Your group, your way",
  title: "Set it up the way your group already plays.",
  lead: "Every group runs its week a little differently. A few settings make MatchTime fit yours, and you can change them at any time.",
  points: [
    // rolling-squad-rules.ts; settings-info.ts rollingSquad.
    {
      key: "rolling",
      icon: "repeat",
      color: "green",
      title: "Rolling squad",
      body: "Played last week? You're in this week unless you say OUT. The squad carries over the morning after each match.",
    },
    // organiser-pick-rules.ts; settings-info.ts benchPickMode.
    {
      key: "pick",
      icon: "hand",
      color: "purple",
      title: "The organisers pick",
      body: "Rather choose who fills a place than go first come, first served? Late Ins go on the bench and your admins pick who plays.",
    },
    // list-announcer.ts; settings-info.ts listAnnouncer.
    {
      key: "announce",
      icon: "megaphone",
      color: "amber",
      title: "You announce the list",
      body: "MatchTime still keeps track of In and Out, but sends the squad and the teams to your organisers to post in their own words.",
    },
    // squad-month-rules.ts; settings-info.ts squadMode.
    {
      key: "monthly",
      icon: "calendar",
      color: "blue",
      title: "Monthly squads",
      body: "Regulars sign up and pay once for the whole month, and pay-as-you-go players fill the gaps.",
    },
    // lib/i18n/lang.ts LANGS; settings-info.ts language.
    {
      key: "language",
      icon: "languages",
      color: "teal",
      title: "Speaks your group's language",
      body: "MatchTime is multi-lingual. It writes in your club's language in the group, in private messages and on the posters, and players answer in their own words.",
    },
  ],
};

// ─── The pool's offer, drawn (round two, 2026-10-26) ───────────────────

/** WhatsApp emoji off: the site draws the words, never the emoji. */
const noEmoji = (text: string) => text.replace(/\p{Extended_Pictographic}\uFE0F?\s*/gu, "").trim();

/** The example game, with the fictional club and the site's date format. */
const OFFER_EXAMPLE = { club: "Riverside FC", day: "Tue 20 Oct, 20:00", venue: "Riverside Sports Centre", miles: "1.2", members: 18 };

/**
 * A pool offer and its yes, built from the REAL offer copy
 * (`pool-offer.en.ts`: offer_head, game_with_format, offer_when, distance,
 * style_casual, club_weekly, offer_cta, placed_in) in the order
 * `pool/offer-copy.ts` poolOfferLines puts them, emoji stripped. The fee line
 * and the footer are left out: no pricing next to the players' invitation.
 * Shown in the pool section and in the deck's "Still short?" card.
 */
export const POOL_OFFER_CHAT: DeckChat = {
  title: "MatchTime",
  subtitle: "Private message to a player in the pool",
  kind: "dm",
  lines: [
    {
      from: "bot",
      text: [
        noEmoji(poolOfferEn.offer_head({ club: OFFER_EXAMPLE.club, places: 1, game: poolOfferEn.game_with_format({ format: "7-a-side", sport: "Football" }) })),
        noEmoji(poolOfferEn.offer_when({ day: OFFER_EXAMPLE.day, mins: 60 })),
        `*${OFFER_EXAMPLE.venue}*. ${poolOfferEn.distance({ miles: OFFER_EXAMPLE.miles, one: false })}`,
        `${poolOfferEn.style_casual}. ${poolOfferEn.club_weekly({ members: OFFER_EXAMPLE.members })}`,
        poolOfferEn.offer_cta({ link: "" }).trim(),
      ].join("\n"),
      link: "Answer",
      time: "17:05",
    },
    { from: "self", text: "yes", time: "17:06" },
    { from: "bot", text: noEmoji(poolOfferEn.placed_in({ club: OFFER_EXAMPLE.club, day: OFFER_EXAMPLE.day, venue: OFFER_EXAMPLE.venue })), time: "17:06" },
  ],
};

// src/lib/pool/*: the /play sign-up (slice L2), its WhatsApp confirmation
// (pool/confirm.ts), the offer (pool/offer-copy.ts, pool-offer.en.ts), the
// matching (pool/matching-rules.ts candidateExclusion), the limits
// (pool/rules.ts POOL_QUIET_HOURS, POOL_MIN_AGE) and the privacy rules (plan
// section 6). The copy says "once the pool opens in your town", never "today":
// it is opening town by town. Round two (2026-10-26) rewrote it for
// enthusiasm, facts only, and moved it straight under the hero.
const PLAYER_POOL: Spotlight = {
  id: "player-pool",
  navLabel: "Player pool",
  navGroup: "players",
  tone: "light",
  eyebrow: "New for players",
  title: "Get called up for local games.",
  lead: "Tell MatchTime your level, when you can play and how far you'll travel. When a club nearby needs one more, the game comes to you on WhatsApp.",
  // Followed by /play's own early or open note (`spotlightFor`).
  poolOpeningLine: true,
  benefit: "More games, new teammates, no hunting round group chats.",
  cta: { label: "Join the MatchTime player pool", href: POOL_PLAY_PATH, pulse: true },
  stepsLabel: "How a call-up works",
  steps: [
    {
      // pool/profile-fields.ts: name, area, travel, days and hours, sports,
      // level (optional, pool/sports.ts); pool/confirm.ts: the code he sends.
      key: "signup",
      title: "Tell us how you play",
      body: "Your level if you like, when you can play, how far you'll travel. Then confirm on WhatsApp.",
    },
    {
      // pool/matching-rules.ts candidateExclusion: format, level (only when
      // the ask names levels), distance, availability.
      key: "short",
      title: "A club near you is short",
      body: "Once the pool opens in your town, a nearby club short at a time that suits you can call you up.",
    },
    {
      // pool/offer-copy.ts poolOfferLines; pool/rules.ts POOL_QUIET_HOURS. The
      // weekly cap still applies but is not on the site (Kemal, 2026-10-25).
      key: "offer",
      title: "The offer lands on WhatsApp",
      body: `The club, day and time, how far and the kind of game. Never between ${POOL_QUIET_HOURS.from} and ${POOL_QUIET_HOURS.to}.`,
    },
    {
      // pool/accept.ts: a yes takes the place while it is open ("gone" when it
      // has gone), or goes on the bench where the club's organisers pick
      // (placed.kind "bench", pool-offer.en.ts placed_bench).
      key: "yes",
      title: "Say yes and you're in",
      body: "Reply yes or tap the link. If the place is still open, you're in, or on the bench where the organisers pick. Not this time? Just say no.",
    },
  ],
  points: [
    {
      // pool/sports.ts LIVE_SPORTS: the live sports and their formats.
      key: "sports",
      icon: "gamepad",
      color: "teal",
      title: `${joinWords(liveSports().map((s) => s.label.en), "and")}, any format`,
      body: `${joinWords(liveSports().map((s) => (s.formats.length ? `${s.label.en} ${formatsWords(s.formats, "or")}` : s.label.en)), "and")}. Pick the ones you play.`,
    },
    {
      // pool/sports.ts SPORT_LEVELS (optional, self-chosen);
      // pool/matching-rules.ts: matched only when the club's ask names levels.
      key: "level",
      icon: "trending",
      color: "purple",
      title: "Your level, your call",
      body: `Pick ${joinWords(SPORT_LEVELS.map((l) => levelLabel(l, "en")), "or")}, or leave it blank. A club looking for a certain level only asks players who match it.`,
    },
    {
      // pool/manage.ts and pool/links.ts: the signed link; pool/dm-optout.ts: STOP.
      key: "control",
      icon: "shield-check",
      color: "blue",
      title: "Stop any time",
      body: "Pause, change your details or stop from your own link, or send STOP.",
    },
    {
      // pool/rules.ts POOL_MIN_AGE.
      key: "age",
      icon: "users",
      color: "amber",
      title: `${POOL_MIN_AGE} and over`,
      body: "Adults only: you'll be playing with people you haven't met yet.",
    },
  ],
  note: {
    title: "Your details stay private",
    items: [
      // Plan section 6: numbers cross only when a player joins a group himself.
      { key: "number", text: "Clubs never get your number from MatchTime. It's only shared if you join a club's WhatsApp group yourself." },
      // Plan section 6: first name and last initial, only after a yes.
      { key: "name", text: "A club sees your first name and the first letter of your surname, and only once you say yes to its game." },
      // pool/rules.ts POSTCODE_DISTRICT_RE: the district only.
      { key: "area", text: "We keep your postcode district, never your full postcode." },
    ],
  },
  // Drawn as a WhatsApp chat beside the heading.
  offerChat: POOL_OFFER_CHAT,
  footnote: "The player pool is separate from your own club. If you already play with a club on MatchTime, nothing changes there.",
};

/**
 * The line after the pool's lead, from /play's own copy: the early sign-up
 * list ONLY while a sign-up goes on it (`signupGoesOnEarlyList`, read by
 * the page that renders this), otherwise what happens once you sign up.
 */
export function poolOpeningLine(earlyList: boolean): string {
  const c = poolPageCopy("en").signup;
  return earlyList ? c.earlyNote : c.openNote;
}

/** A spotlight as a page shows it: the pool section with its opening line. */
export function spotlightFor(s: Spotlight, earlyList: boolean): Spotlight {
  return s.poolOpeningLine ? { ...s, lead: `${s.lead} ${poolOpeningLine(earlyList)}` } : s;
}

/**
 * The spotlight sections, in page order. One entry per section; the menu
 * follows.
 */
export const LANDING_SPOTLIGHTS: Spotlight[] = [SHORT_OF_PLAYERS, PLAYER_POOL, ADMIN_GROUP, YOUR_WAY];

// ─── Ask MatchTime anything ────────────────────────────────────────────

export const ASK_CHAT: { caption: string; lines: ChatLine[] } = {
  caption: "In the players' group",
  lines: [
    { from: "player", text: "@Match Time when's the next match and am I in?" },
    { from: "bot", text: "Tuesday at 8pm, Riverside Sports Centre 🟢 You're confirmed. 12 of 14 in so far." },
    { from: "player", text: "@Match Time top 5 rated players this season" },
    { from: "bot", text: "1. Marcus 8.1  2. Danny 7.9  3. Alex 7.4  4. Ryan 7.4  5. Sam 7.4" },
    { from: "player", text: "@Match Time who's played the most?" },
    { from: "bot", text: "Danny, with 24 games this season. Marcus is next on 22 👀" },
  ],
};

// ─── Player stats cards ────────────────────────────────────────────────

export const PLAYER_STAT_CARDS: Card[] = [
  { key: "over-time", icon: "trending", color: "blue", title: "Ratings over time", body: "Your line against the squad average, with 👑 markers on your MoM games. Tap any point for the detail." },
  { key: "form", icon: "flame", color: "blue", title: "Form and momentum", body: "Hot, cold or steady over your last five games: the streak everyone wants to keep alive." },
  { key: "leaderboard", icon: "list", color: "blue", title: "Live leaderboard", body: "The whole squad ranked by rating, with ↑↓ arrows showing who climbed since last week's match." },
  { key: "tots", icon: "crown", color: "blue", title: "Team of the Season", body: "The best lineup by position, auto-picked from real ratings. Did you make the cut?" },
  { key: "chemistry", icon: "users", color: "blue", title: "Chemistry", body: "Who you win most with, and who brings out your best game." },
  { key: "rivalries", icon: "swords", color: "blue", title: "Rivalries", body: "Your nemesis, and the opponent you own. Settled by results, not banter." },
  { key: "badges", icon: "medal", color: "blue", title: "Badges", body: "Iron Man, MoM Machine, Masterclass and more to unlock as you play." },
  { key: "wrapped", icon: "share", color: "blue", title: "Season “Wrapped” card", body: "A season recap card players screenshot straight into the group." },
];

// ─── Who it's for ──────────────────────────────────────────────────────

export const PERSONAS: Array<{ role: string; bullets: string[] }> = [
  {
    role: "Organisers and captains",
    bullets: [
      "No more counting ‘IN’ messages or chasing late replies",
      "A bench that sorts itself out when someone drops",
      "Partner clubs nearby, then the MatchTime player pool, to fill a place when you're still short",
      "An admin group where organisers run the week in their own words",
      "Balanced teams when you ask, instead of arguing over picks",
      "Attendance, ratings and payments logged for you",
    ],
  },
  {
    role: "Players",
    bullets: [
      "Chat as normal: ‘IN’, ‘count me in’, ‘sorry not tonight’",
      "Balanced teams, no favouritism",
      "Your own stats page: rating over time, MoMs, wins, chemistry and badges",
      "A live leaderboard, Team of the Season and a season card to share",
      "Ask @Match Time about your matches, right in the group",
      "Extra games nearby, with a partner club or through the player pool, if you want them",
    ],
  },
];

/** The home page's sports chips: each live sport's formats, from the
 *  catalogue (pool/sports.ts `LIVE_SPORTS`), never a typed list. */
export const SPORTS: string[] = liveSports().flatMap((s) => (s.formats.length ? s.formats.map((n) => `${s.label.en} ${n}-a-side`) : [s.label.en]));

// ─── The hero's invitation to players (Kemal, 2026-10-25) ──────────────

/**
 * The players' card in the hero (round two, 2026-10-26): a "New" badge,
 * the call-up, one line and a strong button, on the first screen at phone
 * and desktop width. Every claim is the pool's own: an offer when a club
 * near him is short at a time he can play (pool/matching-rules.ts), on
 * WhatsApp (pool/offer-copy.ts). The small print is pool/rules.ts
 * POOL_MIN_AGE, and it is opening town by town. No pricing, and the weekly
 * cap is not on the site (Kemal, 2026-10-25), though it still applies.
 */
/** Who can join (pool/rules.ts). */
const POOL_LIMITS_LINE = `${POOL_MIN_AGE} and over.`;

export const HERO_POOL_INVITE = {
  badge: "New",
  eyebrow: "For players",
  title: "Get called up for local games",
  body: "Join the MatchTime player pool. When a club near you is a player short at a time that suits you, you get the game on WhatsApp.",
  cta: { label: "Join the player pool", href: poolJoinHref(POOL_SITE_SOURCES.hero), pulse: true } satisfies Cta,
  smallPrint: `${POOL_LIMITS_LINE} Opening town by town.`,
};

// ─── The hero's feature deck (variant E, 2026-10-26) ───────────────────

/**
 * Eight cards in a sliding row under the hero's buttons. A card shows a
 * small drawing (`visual`: the words drawn on it), a title and one line;
 * opening it shows `details` and a larger drawing: a chat (`chat`), the
 * order MatchTime asks in (`steps`) or the settings it applies to
 * (`settings`). No pricing anywhere in the deck: the fee card is about an
 * organiser collecting his players' match fees.
 *
 * In chat text `*word*` is bold (WhatsApp style) and `\n` starts a new
 * paragraph. Quoted MatchTime messages are the real ones in
 * `src/lib/i18n/strings.en.ts` and `pool-offer.en.ts` (key named above
 * each), with a fictional club and the emoji left out. A `link` is drawn
 * as a link chip, never a real address.
 */
export type DeckKey = "att" | "short" | "bench" | "teams" | "ratings" | "stats" | "fees" | "admin" | "lang";

export interface DeckLine {
  /** player: someone in the group; bot: MatchTime; self: the reader. */
  from: "player" | "bot" | "self";
  name?: string;
  text: string;
  time: string;
  /** MatchTime's tick under the message. */
  tick?: boolean;
  /** Drawn after the text as a link chip. */
  link?: string;
  /** Drawn inside the message as team rows. */
  teams?: Array<{ name: string; players: string }>;
}

export interface DeckChat {
  /** The chat's name in its header, and what kind of chat it is. */
  title: string;
  subtitle: string;
  kind: "group" | "dm" | "admin";
  lines: DeckLine[];
}

export interface DeckCard {
  key: DeckKey;
  title: string;
  body: string;
  /** The words drawn on the card's small picture. */
  visual: string[];
  details: string[];
  chat?: DeckChat;
  /** Who is asked, in order (the "Still short?" card). `highlight`: the pool. */
  steps?: Array<{ title: string; sub: string; highlight?: boolean }>;
  /** Where the club's language applies (the language card). */
  settings?: { title: string; value: string; items: string[] };
  /** A drawing of a real page: the rating page (`RATE_SKETCH`) or the
   *  player's stats page (`STATS_SKETCH`), in hero-deck-sketches.tsx. */
  sketch?: "rate" | "stats";
}

// ─── The two page drawings in the deck (round three, 2026-10-27) ──────

/**
 * The rating page a player opens from his private link
 * (src/app/matches/[matchId]/rate/page.tsx): the title and prompt, one card
 * per teammate with his first position and a 1 to 10 score row (6 is the
 * page's starting score), the Man of the Match box (two columns of names,
 * the pick starred), "Submit ratings" and "See my season stats". The
 * reader is Leo rating three of the Thursday 7-a-side; his MoM pick is Kai,
 * the deck's winner. Fictional names.
 */
export const RATE_SKETCH = {
  title: "Rate players",
  prompt: "Tap a score for each player, then pick Man of the Match.",
  scores: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  players: [
    { name: "Kai", position: "FWD", score: 9 },
    { name: "Sam", position: "MID", score: 7 },
    { name: "Priya", position: "DEF", score: 6 },
  ],
  mom: "Man of the Match",
  momPick: "Kai",
  submit: "Submit ratings",
  seeStats: "See my season stats",
};

/**
 * A player's stats page (src/app/profile/stats/page.tsx, built by
 * src/lib/player-stats.ts), top to bottom as the page shows it: the
 * season heading, the club rating (strings.en.ts rating_club_label,
 * rating_club_tile), the four tiles (👑 under Man of the Match, as the page
 * shows it once he has one), Current form, Ratings over time (his line
 * against the squad's, his MoM games crowned, the chart's legend),
 * Chemistry, then Badges with the earned count. The badges are the catalogue (badge-rules.ts BADGES: key, emoji, name)
 * with player-stats.ts's own hints; unearned ones are drawn greyed, as on
 * the page. Kai's numbers are invented.
 */
export const STATS_SKETCH = {
  heading: "Kai's season",
  club: "Riverside FC",
  sub: "Riverside FC · since launch",
  clubRatingLabel: "Your rating at Riverside FC",
  clubRatingTile: "Club rating",
  tiles: [
    { big: "7.6", label: "Club rating", sub: "+9% vs squad", tone: "green" },
    { big: "3", label: "Man of the Match", sub: "👑", tone: "amber" },
    { big: "24", label: "Games played", sub: "89% attendance", tone: "blue" },
    { big: "14-3-7", label: "W-D-L", sub: "GD +21", tone: "slate" },
  ],
  form: { label: "Current form", value: "On fire", avg: "8.1", sub: "last 5 games" },
  timeline: {
    title: "Ratings over time",
    you: [6.8, 7.1, 7.0, 7.5, 7.4, 8.0, 8.3],
    squad: [6.9, 6.8, 7.0, 6.9, 7.0, 6.9, 7.0],
    // His three Man of the Match games (the tile's 3), crowned as
    // RatingTimeline's MyDot crowns isMoM points.
    mom: [false, false, false, true, false, true, true],
    legend: { you: "You", squad: "Squad avg", mom: "👑 Man of the Match" },
  },
  chemistry: { title: "Chemistry", row: "Best partnership", name: "Sam", detail: "71% win rate together · 14 games" },
  badgesTitle: "Badges",
  badges: [
    { key: "first-game", emoji: "👟", label: "On the board", hint: "Played your first game", earned: true },
    { key: "ten-games", emoji: "🔟", label: "Regular", hint: "Played 10+ games", earned: true },
    { key: "ironman", emoji: "🦾", label: "Iron Man", hint: "Played every match since joining", earned: false },
    { key: "first-mom", emoji: "🏆", label: "Man of the Match", hint: "Won MoM at least once", earned: true },
    { key: "mom-machine", emoji: "👑", label: "MoM Machine", hint: "Won MoM 3+ times", earned: true },
    { key: "masterclass", emoji: "🌟", label: "Masterclass", hint: "Averaged 9+ in a game", earned: false },
    { key: "reliable", emoji: "🧱", label: "Mr Reliable", hint: "Consistently strong ratings", earned: true },
    { key: "above-field", emoji: "📈", label: "Above the Curve", hint: "Season rating above the squad average", earned: true },
  ],
};


export const HERO_DECK = {
  title: "What MatchTime does",
  hintPhone: "Swipe the cards. Tap one to see how.",
  hintDesktop: "Click a card to see how it works.",
  seeHow: "See how",
  prevLabel: "Previous card",
  nextLabel: "Next card",
  dotsLabel: "Cards",
  dotLabel: (n: number) => `Show card ${n}`,
  closeLabel: "Close",
  detailsLabel: "Feature details",
  sectionLabel: "What MatchTime does",
  cards: [
    {
      // FEATURES in-out; strings.en.ts squad_complete, squad_complete_bench_invite, bench_promotion_how.
      key: "att",
      title: "Who's in, counted",
      body: "Players just say IN or OUT. MatchTime ticks each one and keeps count.",
      visual: ["IN", "count me in", "Squad 12 of 14"],
      details: [
        "Players say IN or OUT in their own words, right in the group.",
        "Each one gets a tick, and the squad list keeps itself.",
        "Say maybe, and it checks back by DM about a day before kickoff.",
        "Short? It asks the group, and stops the moment you're full.",
      ],
      chat: {
        title: "Thursday 7-a-side",
        subtitle: "Group chat",
        kind: "group",
        lines: [
          { from: "player", name: "Sam", text: "count me in", time: "09:02", tick: true },
          { from: "player", name: "Leo", text: "sorry not tonight", time: "09:05", tick: true },
          { from: "player", name: "Kai", text: "IN", time: "11:40", tick: true },
          {
            from: "bot",
            text: "*Squad complete (14/14)* for *Thursday 7-a-side* on Thu 22 Oct, 20:00\n*Bench is open.* Say *IN* and I'll put you on the bench. If someone drops out I tag the bench here and the first to reply *IN* takes the slot.",
            time: "11:40",
          },
        ],
      },
    },
    {
      // Spotlight short-of-players; pool/round-rules.ts POOL_AFTER_PARTNERS_MINS;
      // pool/matching-rules.ts; pool/accept.ts; settings-info.ts partnerAskWhen
      // and poolAutoAsk; PLAYER_POOL (opening town by town); the offer is
      // POOL_OFFER_CHAT (pool-offer.en.ts). Second in the deck (Kemal, 2026-10-27).
      key: "short",
      title: "Dropouts? It asks around",
      body: "Your group first, then partner clubs, then local players from the pool.",
      visual: ["Your group", "Partner clubs", "Player pool"],
      details: [
        "Someone drops out and nobody's on the bench? MatchTime asks your group first, and stops the moment you're full.",
        "Then partner clubs: their players answer privately and join as guests.",
        `Then nearby players from the MatchTime player pool get a WhatsApp offer: ${POOL_AFTER} later, or straight away if you have no partner clubs.`,
        "Pool players are matched on when they can play and how far they'll travel, and on level only when you ask for one.",
        "A yes takes the place if it's still open, or the bench where your organisers pick.",
        "Ask with one tap, or let MatchTime ask by itself on match day. The player pool is opening town by town.",
      ],
      steps: [
        { title: "1. Your group", sub: "The group and the bench" },
        { title: "2. Partner clubs", sub: "Asked in their group" },
        { title: "3. Player pool", sub: `${POOL_AFTER_CAP} later, nearby players`, highlight: true },
      ],
      chat: POOL_OFFER_CHAT,
    },
    {
      // strings.en.ts bench_offer_group_post, bench_claim_replacing.
      key: "bench",
      title: "The bench steps in",
      body: "Someone drops out? The bench is tagged, and the first to say IN plays.",
      visual: ["@Kai @Ben", "First to claim it plays"],
      details: [
        "Squad full? Late INs go on the bench.",
        "Someone drops out? The bench is tagged in the group and sent a DM.",
        "The first to claim it plays. No rush and no timeout.",
        "Teams already out? The new player takes the empty spot.",
      ],
      chat: {
        title: "Thursday 7-a-side",
        subtitle: "Group chat",
        kind: "group",
        lines: [
          { from: "player", name: "Joe", text: "Can't make it tonight lads, I'm out", time: "09:12", tick: true },
          {
            from: "bot",
            text: "A slot just opened for *Thursday 7-a-side* tonight. *First to claim it plays.*\n@Kai @Ben\nJust reply *IN* here to take it. No rush and no timeout.",
            time: "09:12",
          },
          { from: "player", name: "Kai", text: "IN", time: "09:20", tick: true },
          { from: "bot", text: "*Kai* is in, replacing *Joe*. Squad *14/14*", time: "09:20" },
        ],
      },
    },
    {
      // FEATURES teams; strings.en.ts teams_post_header, teams_post_footer.
      key: "teams",
      title: "Fair teams, on request",
      body: "Tag @Match Time and it splits the squad by rating and position.",
      visual: [],
      details: [
        "Ask in your own words: @Match Time generate the teams.",
        "It balances the confirmed squad on club rating and position.",
        "Want a change? Ask for a swap, and an admin confirms.",
        "Organisers can get the team sheet as a picture to forward.",
      ],
      chat: {
        title: "Thursday 7-a-side",
        subtitle: "Group chat",
        kind: "group",
        lines: [
          { from: "self", text: "@Match Time generate the teams", time: "17:00" },
          {
            from: "bot",
            text: "*Teams for tonight*: 20:00 at Riverside Sports Centre",
            teams: [
              { name: "Blues", players: "Kai, Sam, Dan +4" },
              { name: "Oranges", players: "Priya, Leo, Ben +4" },
            ],
            time: "17:00",
          },
          {
            from: "bot",
            text: "Objections? Tag me and say what to change, in your own words (for example @Match Time swap Sam with Alex), and an admin will confirm.",
            time: "17:00",
          },
        ],
      },
    },
    {
      // strings.en.ts rate_promo, mom_header, mom_winner, mom_trophy_line.
      key: "ratings",
      title: "Ratings and Man of the Match",
      body: "After the game, players rate each other and vote for the best.",
      visual: ["Man of the Match: Kai"],
      details: [
        "Every player gets a private link to rate the others from 1 to 10.",
        "They pick a Man of the Match, announced in the group once everyone has voted.",
        "Ratings help balance next week's teams, and fill each player's own stats page.",
      ],
      sketch: "rate",
      chat: {
        title: "Thursday 7-a-side",
        subtitle: "Group chat",
        kind: "group",
        lines: [
          {
            from: "bot",
            text: "Just DM'd every player from the *Thursday 7-a-side* on Thu 22 Oct a personal rating link. The more ratings we get, the better-balanced the teams get next week. Check your DMs from me",
            time: "22:10",
          },
          {
            from: "bot",
            text: "*Man of the Match: Thursday 7-a-side*\nCongrats *Kai* (6/12 votes)\nYour trophy awaits next match.",
            time: "Fri 18:30",
          },
        ],
      },
    },
    {
      // src/app/profile/stats/page.tsx (STATS_SKETCH); badge-rules.ts BADGES;
      // PLAYER_STAT_CARDS. Player-facing (Kemal, 2026-10-27: badges matter).
      key: "stats",
      title: "Track your progress",
      body: "Every player gets a stats page: ratings over time, form and badges.",
      visual: ["7.6", "On fire", "Badges 6 of 8"],
      details: [
        "Each player has their own stats page, opened from a link MatchTime sends. No app, no password.",
        "Club rating, Man of the Match awards, games played and their win, draw and loss record.",
        "Current form over the last 5 games, and ratings over time against the squad average.",
        "Chemistry and rivalries, the squad leaderboard and the Team of the Season.",
        "Badges to unlock as they play, from On the board to MoM Machine, and any badge earned can be shared as a picture.",
      ],
      sketch: "stats",
    },
    {
      // FEATURES payments; strings.en.ts dm_pay_link.
      key: "fees",
      title: "Match fees, collected",
      body: "Pay links after the game. Reminders for whoever hasn't paid.",
      visual: ["£6.00", "Card", "Bank"],
      details: [
        "Switch on card or bank payments, if you want them.",
        "After each game, everyone who played gets a DM with a pay link.",
        "MatchTime reminds whoever hasn't paid. No more money chase.",
      ],
      chat: {
        title: "MatchTime",
        subtitle: "Private message",
        kind: "dm",
        lines: [
          {
            from: "bot",
            text: "Kai, match fee for *Thursday 7-a-side* is *£6.00*.\nTap to pay (bank, card, Apple or Google Pay):",
            link: "Pay link",
            time: "22:05",
          },
          { from: "bot", text: "You can also pay for anyone you brought along.", time: "22:05" },
        ],
      },
    },
    {
      // ADMIN_GROUP spotlight; strings.en.ts hq_help, hq_match_cancelled.
      key: "admin",
      title: "Your organisers' own chat",
      body: "Run the week in plain words, away from the players' chat.",
      visual: ["put Bilal in", "show me the teams", "Organisers only"],
      details: [
        "Link your organisers' WhatsApp group, and MatchTime works there too.",
        "Paste the squad list, move players, check the teams before they go out.",
        "Tag it to cancel a match or put it back on, and it tells the players.",
        "Notices only organisers should see land there, not in the players' chat.",
      ],
      chat: {
        title: "Organisers",
        subtitle: "Admin group",
        kind: "admin",
        lines: [
          { from: "self", text: "what can you do?", time: "10:01" },
          {
            from: "bot",
            text: "*MatchTime in your admin group*\nJust ask here in your own words. No need to tag me, except to cancel a match or put it back on.",
            time: "10:01",
          },
          { from: "self", text: "@Match Time cancel Friday", time: "10:03" },
          { from: "bot", text: "Done: Friday 7-a-side, Fri 23 Oct at 20:00 is cancelled. I've told the players' group.", time: "10:03" },
        ],
      },
    },
    {
      // YOUR_WAY spotlight language point; lib/i18n/lang.ts LANGS. Multi-lingual, no language named.
      key: "lang",
      title: "Speaks your group's language",
      body: "Multi-lingual: MatchTime writes in your group's language.",
      visual: ["Aa", "Aa"],
      details: [
        "MatchTime is multi-lingual. Set your club's language once in settings.",
        "It then writes in it everywhere: the group, private messages and posters.",
        "Players keep replying in their own words, as they always have.",
      ],
      settings: {
        title: "Club settings",
        value: "Language: your group's",
        items: ["Group chat", "Private messages", "Posters and team sheets"],
      },
    },
  ] satisfies DeckCard[],
};

// ─── The players' page (/players) ──────────────────────────────────────

export interface FaqItem {
  key: string;
  question: string;
  answer: string;
}

/** The questions a player asks before joining. One answer each. */
export const PLAYERS_FAQ: FaqItem[] = [
  {
    // privacy-policy.en.ts (what an offer shows); pool/offer-copy.ts feeLineOf.
    key: "cost",
    question: "What does a game cost?",
    answer: "Each club sets its own match fee. An offer shows you the club, the venue, the day, the time, the format and the cost before you say yes.",
  },
  {
    // pool/reply.ts (a no is an answer); pool/rules.ts POOL_CAPS.ignoredInARowPause.
    key: "say-no",
    question: "Do I have to say yes?",
    answer: `No. You decide each time. If you leave ${POOL_CAPS.ignoredInARowPause} offers in a row unanswered, MatchTime pauses your game messages until you say you want more.`,
  },
  {
    // pool/manage.ts (pause, change, stop, delete); pool/dm-optout.ts (STOP).
    key: "stop",
    question: "How do I stop?",
    answer: "Your own link, sent when you confirm on WhatsApp, lets you pause, change your details, stop game messages or delete everything. You can also send STOP to MatchTime on WhatsApp.",
  },
  {
    // pool/club-invitation.ts (slice L8): both sides say yes after a game.
    key: "join-club",
    question: "Can I join a club I played for?",
    answer: "Yes, if you both want it. After a game, MatchTime asks you and the club, and once you both say yes it sends you the link to the club's WhatsApp group.",
  },
  {
    key: "own-club",
    question: "I already play with a club on MatchTime.",
    answer: PLAYER_POOL.footnote!,
  },
];

/**
 * /players: the benefit and the big pulsing button first, then how it
 * works, the points, what is shared and the questions. The steps, points,
 * note, footnote and lead ARE the pool section's (same objects), and the
 * heading is the hero's invitation, so the page cannot drift from either.
 */
export const PLAYERS_PAGE = {
  metaTitle: "Find a game near you",
  metaDescription:
    "Join the MatchTime player pool: tell MatchTime where and when you can play, and get asked on WhatsApp when a club near you is a player short.",
  eyebrow: "MatchTime player pool",
  title: HERO_POOL_INVITE.title,
  lead: PLAYER_POOL.lead,
  cta: { label: "Join the MatchTime player pool", href: poolJoinHref(POOL_SITE_SOURCES.players), pulse: true } satisfies Cta,
  // The lead already says it is opening town by town.
  smallPrint: POOL_LIMITS_LINE,
  stepsTitle: "How it works",
  steps: PLAYER_POOL.steps!,
  pointsTitle: "Why players join",
  points: PLAYER_POOL.points,
  note: PLAYER_POOL.note!,
  privacyLink: "Read the privacy policy",
  faqTitle: "Questions",
  footnote: PLAYER_POOL.footnote!,
  closingTitle: "Ready for your next game?",
  closingCta: { label: "Join the MatchTime player pool", href: poolJoinHref(POOL_SITE_SOURCES.players) } satisfies Cta,
};

// ─── Top menu ──────────────────────────────────────────────────────────

/** A spotlight's menu link, in its audience's group. */
const spotlightLinks = (audience: NavAudience): NavLink[] =>
  LANDING_SPOTLIGHTS.filter((s) => s.navLabel && s.navGroup === audience).map((s) => ({ label: s.navLabel!, href: `/#${s.id}` }));

/**
 * The top menu, one group per audience (Kemal, 2026-10-25). Home-page
 * anchors are written `/#id` so the same menu works from /players; the
 * home page renders them as `#id`.
 */
export const LANDING_NAV_GROUPS: NavGroup[] = [
  {
    id: "clubs",
    label: "For clubs",
    links: [
      { label: "Features", href: "/#features" },
      ...spotlightLinks("clubs"),
      { label: "How it works", href: "/#how-it-works" },
      { label: "Pricing", href: PRICING_PATH },
      { label: "Organiser guide", href: "/help/admin" },
    ],
    cta: { label: "Start your group", href: "/signup" },
  },
  {
    id: "players",
    label: "For players",
    links: [
      { label: "Find a game near you", href: PLAYERS_PAGE_PATH },
      ...spotlightLinks("players"),
      { label: "Player stats", href: "/#player-stats" },
      { label: "Player guide", href: "/help/player" },
    ],
    cta: { label: "Find a game", href: poolJoinHref(POOL_SITE_SOURCES.nav) },
  },
];

/** Every link and button in the menu. */
export function allNavLinks(): NavLink[] {
  return LANDING_NAV_GROUPS.flatMap((g) => [...g.links, g.cta]);
}
