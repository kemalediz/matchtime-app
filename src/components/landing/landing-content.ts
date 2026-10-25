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
 * THE PLAYER POOL (G0 part 2, with slice L2): its section is the first
 * spotlight and carries the "Join the MatchTime player pool" invitation,
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
import { LIVE_SPORTS, liveSports } from "@/lib/pool/sports";

// ── The sport the site is about (Kemal, 2026-10-25: football only, for now) ──
//
// The chips and the pool card are derived from `LIVE_SPORTS`
// (src/lib/pool/sports.ts). The lines below say "football" in plain words;
// when another sport is switched on there, reword them here (and only here:
// src/app/layout.tsx and the hero read them).

/** "A, B or C". */
function joinWords(words: readonly string[], last: "and" | "or"): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}

/** "Football 5, 7, 8, 9 or 11-a-side.": each live sport with its formats. */
function liveSportsLine(): string {
  const sports = liveSports().map((s) => (s.formats.length ? `${s.label.en} ${joinWords(s.formats.map(String), "or")}-a-side` : s.label.en));
  const other = LIVE_SPORTS.other ? ", and any other sport you play by booking a venue with mates" : "";
  return `${joinWords(sports, "and")}${other}. Pick the formats you play, and your level if you like.`;
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
    "MatchTime lives in your WhatsApp group and runs your weekly football: it tracks who's in, runs the bench, chases when you're short, balances teams on request, and collects ratings and Man of the Match votes.",
  ogDescription: `WhatsApp organiser for weekly ${liveFormatsPhrase()}: who's in, the bench, balanced teams, ratings and Man of the Match.`,
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

/** The home page's headline. */
export const HERO = {
  titleLead: "Run your weekly football",
  titleTail: "on autopilot.",
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

export const FEATURES: Card[] = [
  {
    key: "in-out",
    color: "green",
    icon: "message",
    title: "Tracks who's in",
    body: "Players say In or Out the way they always have. MatchTime ticks each one with ✅ and keeps the squad list. Say “maybe” and it checks back with you by DM a day before kickoff.",
  },
  {
    key: "bench",
    color: "purple",
    icon: "users",
    title: "Runs the bench",
    body: "When the squad is full, late Ins go on the bench 🪑. When someone drops, the bench is offered the spot in the group and by DM, and the first to claim it plays.",
  },
  {
    // Still short after the bench: partner-ask.ts (the automatic ask, slice S5).
    key: "chase",
    color: "rose",
    icon: "zap",
    title: "Chases when short, stops when full",
    body: "Short of players? MatchTime asks the group in its daily update, on match morning and in the last hours before kickoff. The moment you're full, it stops. Admins can also ask it to invite recent players by DM, or ask a partner club for a player.",
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

const PARTNER_CLUBS: Spotlight = {
  id: "partner-clubs",
  navLabel: "Partner clubs",
  navGroup: "clubs",
  tone: "dark",
  eyebrow: "Partner clubs",
  title: "A player short? Ask the club down the road.",
  // club-partnership-rules.ts (pairings), partner-ask.ts (the ask),
  // partner-guest.ts (a partner's player joins as a guest).
  lead: "Clubs that play near each other can become partner clubs and help fill each other's missing places. When your squad is still short, MatchTime asks a partner club's players' group for you, and one of their players comes to play your game. No ringing round other groups yourself.",
  stepsLabel: "How an ask works",
  steps: [
    {
      // club-discovery-rules.ts RADIUS_PRESETS_MILES and MAX_RADIUS_MILES;
      // club-partnership-rules.ts header: a request, accepted by an owner or admin.
      key: "find",
      title: "Find clubs near you",
      body: `Search for clubs that play up to ${MAX_RADIUS_MILES} miles from your venue and send them a request. Once one of their owners or admins accepts, you can ask them for players.`,
    },
    {
      // settings-info.ts partnerAskWhen ("When we ask", "Automatically at a time");
      // strings.en.ts xaskw_* (asked in an organiser's own words, slice S6);
      // partner-ask-round.ts (the number is for the whole round).
      key: "ask",
      title: "Ask when you're short",
      body: "Ask from the match page, or just tell MatchTime in your own words. You can also let it ask by itself on match day when a place is still open and nobody is on your bench. You say how many players you need, in total across the clubs you ask.",
    },
    {
      // settings-info.ts partnerApproval ("Ask our organisers each time",
      // "Post without asking"); strings.en.ts xask_post.
      key: "approve",
      title: "Their organisers say yes",
      body: "Each club decides whether its organisers check every ask first or let asks through straight away. Then MatchTime posts your ask in their players' group, with the day, time, venue and format.",
    },
    {
      // partner-guest.ts header (every answer is a DM; the asking club's own
      // rule decides who plays); strings.en.ts xask_filled_line, xask_thanks_dm.
      key: "answer",
      title: "A player answers privately",
      body: "Players reply to MatchTime by private message, so the partner's group stays quiet. Whoever answers joins your game as a guest for that match. Once the place is filled, MatchTime closes the ask and thanks everyone who offered.",
    },
  ],
  points: [
    {
      // partner-ask.ts sweepPartnerAsks: the ask closes when filled.
      key: "fill",
      icon: "users",
      color: "teal",
      title: "Fewer games played a player short",
      body: "The bench and your own group come first. When they can't fill a place, a club nearby often can.",
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
      { key: "numbers", text: "Phone numbers are never shared between clubs. The asking club sees a guest's name and club, never their number." },
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
  footnote: "Partner clubs are set up from your club's settings, and nothing is asked until both clubs agree.",
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
      title: "English or Turkish",
      body: "MatchTime writes in your club's language: in the group, in private messages and on the posters. In Turkish, players say VARIM and YOKUM.",
    },
  ],
};

// src/lib/pool/*: the /play sign-up (slice L2), its WhatsApp confirmation
// (pool/confirm.ts), the limits (pool/rules.ts POOL_CAPS, POOL_QUIET_HOURS,
// POOL_MIN_AGE) and the privacy rules (plan section 6). Offers themselves
// come with slice L5: the copy says "when it opens", never "today".
const PLAYER_POOL: Spotlight = {
  id: "player-pool",
  navLabel: "Player pool",
  navGroup: "players",
  tone: "light",
  eyebrow: "For players",
  title: "Looking for a game? Join the MatchTime player pool.",
  lead: "Tell MatchTime where and when you can play, and the formats you like. When a club near you is a player short at a time you can play, MatchTime can message you on WhatsApp with the game, and you decide.",
  // Followed by /play's own early or open note (`spotlightFor`).
  poolOpeningLine: true,
  cta: { label: "Join the MatchTime player pool", href: POOL_PLAY_PATH, pulse: true },
  stepsLabel: "How joining works",
  steps: [
    {
      // pool/profile-fields.ts: name, area, travel, days and hours, sports, level.
      key: "signup",
      title: "Fill in one page",
      body: "Your first name, your postcode area or the pitches you like, how far you'll travel, the days and hours you can play, and the formats you play. Level is optional.",
    },
    {
      // pool/confirm.ts: the person's own message carrying the code.
      key: "confirm",
      title: "Confirm on WhatsApp",
      body: "WhatsApp opens with a short message and a code. You send it, which confirms your number. We never ask for your number on the page and never message you first.",
    },
    {
      // pool/rules.ts POOL_QUIET_HOURS. The weekly cap (POOL_CAPS.perPlayerPerWeek)
      // still applies but is not on the site (Kemal, 2026-10-25); the /play
      // consent tickbox still states it.
      key: "offers",
      title: "Hear about games near you",
      body: `Once the pool opens near you, a club that needs a player can be offered you, never between ${POOL_QUIET_HOURS.from} and ${POOL_QUIET_HOURS.to}.`,
    },
  ],
  points: [
    {
      // pool/sports.ts LIVE_SPORTS: the live sports and their formats.
      key: "sports",
      icon: "gamepad",
      color: "teal",
      title: `${joinWords(liveSports().map((s) => s.label.en), "and")}, any format`,
      body: liveSportsLine(),
    },
    {
      // pool/manage.ts and pool/links.ts: the signed link in the reply.
      key: "control",
      icon: "shield-check",
      color: "blue",
      title: "You stay in control",
      body: "Your own link lets you pause, change your details, stop game messages or delete everything, at any time.",
    },
    {
      // pool/rules.ts POOL_MIN_AGE.
      key: "age",
      icon: "users",
      color: "amber",
      title: `${POOL_MIN_AGE} and over`,
      body: "You'll be playing with people you haven't met yet, so the pool is for adults only.",
    },
  ],
  note: {
    title: "Your details stay private",
    items: [
      // Plan section 6: numbers cross only when a player joins a group himself.
      { key: "number", text: "Clubs never get your phone number from MatchTime." },
      // Plan section 6: first name and last initial, only after a yes.
      { key: "name", text: "A club sees your first name and the first letter of your surname, and only once you say yes to its game." },
      // pool/rules.ts POSTCODE_DISTRICT_RE: the district only.
      { key: "area", text: "We keep your postcode area, never your full postcode." },
    ],
  },
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
export const LANDING_SPOTLIGHTS: Spotlight[] = [PLAYER_POOL, PARTNER_CLUBS, ADMIN_GROUP, YOUR_WAY];

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
      "Partner clubs nearby to fill a place when you're still short",
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
      "The odd extra game with a partner club nearby, if you want one",
    ],
  },
];

/** The home page's sports chips: each live sport's formats, from the
 *  catalogue (pool/sports.ts `LIVE_SPORTS`), never a typed list. */
export const SPORTS: string[] = liveSports().flatMap((s) => (s.formats.length ? s.formats.map((n) => `${s.label.en} ${n}-a-side`) : [s.label.en]));

// ─── The hero's invitation to players (Kemal, 2026-10-25) ──────────────

/**
 * Its own panel in the hero, under the organisers' buttons, so a player
 * sees the pool on the first screen. Every claim is the pool's own:
 * offers when a club near him is short at a time he can play
 * (pool/matching-rules.ts), on WhatsApp, his yes or no each time
 * (pool/reply.ts), no app (a web page and WhatsApp), stop any time
 * (pool/manage.ts, and the general "stop", pool/dm-optout.ts). The small
 * print is pool/rules.ts POOL_MIN_AGE. The weekly cap is not on the site
 * (Kemal, 2026-10-25), though it still applies.
 */
/** Who can join (pool/rules.ts). */
const POOL_LIMITS_LINE = `${POOL_MIN_AGE} and over.`;

export const HERO_POOL_INVITE = {
  eyebrow: "For players",
  title: "Get asked to play when a club near you is a player short.",
  body: "Tell MatchTime where and when you can play. When a game nearby needs a player, it messages you on WhatsApp and you decide. No app, and you can stop any time.",
  cta: { label: "Join the MatchTime player pool", href: poolJoinHref(POOL_SITE_SOURCES.hero), pulse: true } satisfies Cta,
  more: { label: "How it works for players", href: PLAYERS_PAGE_PATH } satisfies NavLink,
  smallPrint: `${POOL_LIMITS_LINE} Opening town by town.`,
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
