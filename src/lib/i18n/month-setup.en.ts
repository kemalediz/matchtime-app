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
      ...(p.inGroup ? ["Or tag me and paste the list in this group and I'll check the names with you first."] : []),
      "If your group has no list yet, open an empty one on that page and I'll post it.",
      `Until then I post nothing about ${p.month}.`,
    ].join("\n"),

  /** The day before the held month's first game, still not started. */
  held_nudge: (p: { month: string; day: string; link: string }): string =>
    `📋 Reminder: ${p.month}'s first game is on ${p.day} and the month has not been started here yet, so I am posting nothing for it, that game included. Start it from your group's list, or open an empty list: ${p.link}`,

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

  // ── What a regular covers (2026-11-16) ───────────────────────────────
  /** "Add a player" once the month has started: what the new regular covers. */
  add_cover_label: "The month has started. They cover:",
  add_cover_whole: (p: { games: number }): string => `The whole month, already paid (${p.games} ${p.games === 1 ? "game" : "games"})`,
  add_cover_left: (p: { games: number }): string => `The games left (${p.games})`,
  add_cover_pick: "Choose the whole month or the games left first.",
  /** The coverage editor in the games column. */
  cover_label: "Covers",
  cover_opt: (p: { games: number; of: number; left: boolean; whole: boolean }): string =>
    p.whole ? `${p.games} of ${p.of}, the whole month` : p.left ? `${p.games} of ${p.of}, the fewest (played since joining, weeks off credited, and left)` : `${p.games} of ${p.of}`,
  cover_save: "Save",
  cover_saved: "Coverage saved",
  cover_error: (p: { key: string }): string =>
    p.key === "below-games-left"
      ? "That is fewer than they can cover: the games played since they joined, the weeks called off they were credited for, and the games left."
      : p.key === "more-than-the-month"
        ? "That is more games than the month has."
        : p.key === "below-credits"
          ? "They have more credits taken off this month than that. Take a credit back first."
          : p.key === "not-a-regular" || p.key === "not-a-member"
            ? "Only a regular of the month covers games."
            : p.key === "closed"
              ? "This month is closed."
              : "That did not save. Try again.",

  /** The organisers' group: "Whole month, or just the games left?", asked
   *  once when the words did not say (an add, or a change of coverage). */
  hq_cover_ask: (p: { name: string; month: string; left: number; whole: number }): string =>
    `📋 ${p.name} on the ${p.month} list: whole month, or just the games left? The whole month is ${p.whole} ${p.whole === 1 ? "game" : "games"}; ${p.left} ${p.left === 1 ? "is" : "are"} left. Tag me with your answer.`,
  /** From the row as stored. `of`: the month's playable games. */
  hq_cover_done: (p: { name: string; month: string; games: number; of: number; wholeMonth: boolean }): string =>
    p.wholeMonth
      ? `✅ ${p.name} covers the whole of ${p.month}: ${p.games} ${p.games === 1 ? "game" : "games"}.`
      : `✅ ${p.name} covers ${p.games} of the ${p.of} games of ${p.month}.`,
  hq_cover_same: (p: { name: string; month: string; games: number; of: number; wholeMonth: boolean }): string =>
    p.wholeMonth
      ? `${p.name} already covers the whole of ${p.month}, so nothing changed.`
      : `${p.name} already covers ${p.games} of the ${p.of} games of ${p.month}, so nothing changed. It can't be fewer than the games he has played since he joined, the weeks called off he was credited for, and the games left.`,
  hq_cover_failed: (p: { key: string; name: string; month: string }): string =>
    p.key === "below-credits"
      ? `${p.name} has more credits taken off ${p.month} than that, so I didn't change what ${p.name} covers. You can change it on the months page.`
      : p.key === "below-games-left"
        ? `${p.name} can't cover fewer than the games played since joining, the weeks called off he was credited for, and the games left, so I didn't change what ${p.name} covers.`
        : p.key === "not-a-regular" || p.key === "not-a-member"
          ? `${p.name} isn't a regular on the ${p.month} list, so I didn't change what ${p.name} covers.`
          : p.key === "closed"
            ? `${p.month} is closed, so I didn't change what ${p.name} covers.`
            : `I couldn't change what ${p.name} covers. You can do it on the months page.`,
  /** After a change: what the months page shows beside him (round 4, item 4). */
  hq_cover_balance: (p: { owes: boolean; amount: string }): string =>
    p.owes ? `He still shows ${p.amount} to pay.` : `He shows ${p.amount} to give back.`,
  /** The add's words named somebody else too (round 4, item 3): left alone. */
  hq_cover_others: (p: { names: string; first: string }): string =>
    `I didn't change what ${p.names} covers: tag me about that in a message of its own, for example "@Match Time ${p.first} covers the whole month".`,
  /** Two players asked about and the answer is not clear which. */
  /** `names`: "Ben or Zara" (`joinChoice`); `first`: one of them, for the example. */
  hq_cover_which: (p: { names: string; first: string }): string =>
    `Which player do you mean: ${p.names}? Reply to my question about them, or tag me with their name, for example "@Match Time ${p.first} covers the whole month".`,
  /** The player a question was about was merged into another since. */
  hq_cover_merged: "That player was merged into another one since I asked, so I changed nothing. Please add them again.",
  /** Every door with no coverage question (a re-posted list, the players'
   *  group, a DM, the "who is this?" answer): added for the games left. */
  /** `names`: "Tom, Zak"; `count`: how many; `first`: one of them, for the
   *  example; `group`: the club has an organisers' group to tag me in. */
  added_left_note: (p: { names: string; count: number; first: string; month: string; link: string; group: boolean }): string =>
    `${p.names} ${p.count === 1 ? "is" : "are"} on the ${p.month} list for the games left. If ${p.count === 1 ? "he" : "they"} paid for the whole month, set ${p.count === 1 ? "him" : "them"} to the whole month under Covers on the months page (${p.link})${p.group ? ` or tag me in your organisers' group, for example "@Match Time ${p.first} covers the whole month"` : ""}; the page then shows what's left to pay or confirm.`,
  /** Nobody on a live month's list the words could be. */
  hq_cover_who: (p: { name: string }): string =>
    p.name
      ? `I couldn't tell which regular on the month's list ${p.name} is, so I didn't change anything for ${p.name}.`
      : `Who do you mean? Tag me with their name, for example "@Match Time Dan covers the whole month".`,

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
      `Say *@Match Time YES* to start ${p.month} with them. To check or change it first: ${p.link}`,
    ].join("\n"),
  hq_seed_applied: (p: { month: string; count: number }): string =>
    `✅ ${p.month} is started with ${p.count} ${p.count === 1 ? "player" : "players"}. I won't post my own list for it until someone changes it.`,
  hq_seed_failed: (p: { month: string; key: string }): string =>
    p.key === "already-started"
      ? `${p.month} has already started, so nothing was changed.`
      : `I couldn't start ${p.month} from that list. Please do it on the website, on the Months page.`,
};

export type MonthSetupStrings = { readonly [K in keyof typeof monthSetupEn]: (typeof monthSetupEn)[K] };
