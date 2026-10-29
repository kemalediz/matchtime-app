/**
 * MONTHLY SQUAD SET-UP (2026-10-29, Vets MNF), ENGLISH: starting the
 * coming month from the group's own list, "4 only" regulars, and a season
 * break. House rules (`__tests__/month-setup-copy.test.ts`): no em or en
 * dash, no slash as a separator, "bench" never "waiting list".
 */
export const monthSetupEn = {
  /** To the organisers when MatchTime holds a month it would have opened. */
  held_notice: (p: { month: string; link: string; inGroup: boolean }): string =>
    [
      `📋 The list for ${p.month} is due to open, but this is MatchTime's first month with your group, so it has no list of its own to post.`,
      `Start ${p.month} from your group's list here: ${p.link}`,
      ...(p.inGroup ? ["Or paste the list in this group and I'll check the names with you first."] : []),
      "If your group has no list yet, open an empty one on that page and I'll post it.",
      `Until then I post nothing about ${p.month}.`,
    ].join("\n"),

  /** The day before the held month's first game, still not started. */
  held_nudge: (p: { month: string; link: string }): string =>
    `📋 Reminder: ${p.month} starts tomorrow and has not been started here yet, so I am posting nothing for it, this week's game included. Start it from your group's list, or open an empty list: ${p.link}`,

  // ── /admin/months: the coming month ──────────────────────────────────
  next_title: (p: { month: string }): string => `Start ${p.month} from your list`,
  next_body: (p: { month: string }): string =>
    `Paste the list your group is using for ${p.month}. MatchTime matches the names to your players for you to check, then starts the month with them. It does not post its own list straight after: it posts the list only when someone changes it.`,
  next_held: (p: { month: string }): string => `MatchTime is not posting a list for ${p.month} until you start it here.`,
  next_open_empty: (p: { month: string }): string => `Open an empty list for ${p.month}`,
  next_open_empty_hint: "MatchTime posts the list in your group and players sign up there.",
  next_opened: (p: { month: string }): string => `The list for ${p.month} is open`,
  next_posts_note: "Starting the month this way posts nothing straight away. MatchTime posts the list when someone changes it.",
  next_break: (p: { month: string }): string => `No games in ${p.month}: it is a season break month.`,

  // ── "4 only" ─────────────────────────────────────────────────────────
  col_games_committed: "Games",
  games_hint: 'Leave blank for every game. For a player who said "4 only", put 4.',
  games_all: "All",
  /** Beside a fewer-games regular's amount on the priced list. */
  games_note: (p: { games: number }): string => `${p.games} ${p.games === 1 ? "game" : "games"}`,
  games_of: (p: { games: number; of: number }): string => `${p.games} of ${p.of}`,
  games_save: "Save",
  games_saved: "Games saved",
  games_error: (p: { key: string }): string =>
    p.key === "more-than-the-month"
      ? "That is more games than the month has."
      : p.key === "bad-games"
        ? "Enter a whole number of games, or leave it blank for every game."
        : p.key === "locked"
          ? "This payment is confirmed. Ask an organiser to change the games."
          : p.key === "not-a-regular"
            ? "Only a regular of the month has a number of games."
            : p.key === "fewer-than-played"
              ? "They have already played more games than that this month."
            : "That did not save. Try again.",
  /** On a member's own page. */
  my_games_label: (p: { of: number }): string => `How many of the ${p.of} games are you playing?`,
  my_games_all: (p: { of: number }): string => `All ${p.of}`,

  // ── Season break ─────────────────────────────────────────────────────
  break_title: "Season break",
  break_body:
    "Tick the months your club plays no games. For those months no list opens, no games are made and nothing is posted. The month after starts as usual, with the regulars of the last month played.",
  break_save: "Save",
  break_saved: "Season break saved",
  break_error: (p: { key: string; month?: string }): string =>
    p.key === "month-exists"
      ? `${p.month ?? "That month"} has already started here, so it can't be a break month. Take its players off first.`
      : p.key === "bad-months"
        ? "Pick months from this month on, up to a year ahead."
        : "That did not save. Try again.",
  break_kept_games: (p: { count: number }): string =>
    p.count === 1
      ? "1 game in those months already has players on it. Cancel it on its match page if it is off."
      : `${p.count} games in those months already have players on them. Cancel them on their match pages if they are off.`,

  // ── The admin group door ─────────────────────────────────────────────
  hq_seed_proposal: (p: { month: string; count: number; names: string; unknown: string | null; link: string }): string =>
    [
      `📋 I read your list for ${p.month}: ${p.count} ${p.count === 1 ? "player" : "players"} (${p.names}).`,
      ...(p.unknown ? [`Not known to me yet: ${p.unknown}. Add them as players, or start without them.`] : []),
      `Reply YES to start ${p.month} with them. To check or change it first: ${p.link}`,
    ].join("\n"),
  hq_seed_applied: (p: { month: string; count: number }): string =>
    `✅ ${p.month} is started with ${p.count} ${p.count === 1 ? "player" : "players"}. I won't post my own list for it until someone changes it.`,
  hq_seed_failed: (p: { month: string; key: string }): string =>
    p.key === "already-started"
      ? `${p.month} has already started, so nothing was changed.`
      : `I couldn't start ${p.month} from that list. Please do it on the website, on the Months page.`,
};

export type MonthSetupStrings = { readonly [K in keyof typeof monthSetupEn]: (typeof monthSetupEn)[K] };
