# Stats page improvements

Three things Kemal flagged while looking at his own stats during the
recovery work. All in `src/lib/player-stats.ts` and the stats page.

## `a31c96f` — "Across all your clubs" overview (cross-club)

### Kemal's question
*"There are players that play in multiple orgs such as myself, Kemal,
Amir and some others. Will their ratings and MoM recorded in this match
be accumulated into their profile? Is the player stats per org or for
all orgs together?"*

### The answer (and the gap)

**Identity is already unified.** A player is one `User` keyed by their
unique phone number, with a separate `Membership` per club. Ratings +
MoM accumulate under that one userId. So a multi-club player like
Kemal already has all his data in one place.

**Display was per-club.** Every query in `loadPlayerSeasonStats`,
`loadRatingLeaderboard`, `loadTeamOfSeason` filters by
`activity: { orgId }`. So the stats page only ever showed one club.

The gap is **showing combined totals**, but not blindly merging
rankings (different clubs rate on different scales, leaderboard +
TOTS + rivalries only mean anything within a squad).

### The build

New `loadAllClubsOverview(userId)` returns:
- `clubCount`, `totalGames`, `totalMom`, `overallAvg`
- Per-club breakdown: name, games, momCount, avgRating

Rendered as a card at the top of `/profile/stats`, **only when
`clubCount > 1`**. Includes an `InfoButton` explaining the
indicative-vs-precise nuance:
> Each club rates on its own scale, so the blended average is
> indicative — the per-club breakdown is the precise picture. The
> leaderboard, Team of the Season and rivalries below stay specific to
> {orgName}.

For Kemal: 3 clubs (incl. the test payments org), 9 games, blended 7.49.

## `f18d62f` — MoM = wins, not votes

### The bug
Kemal: *"'Across All your clubs' section shows me as MoM 9 times :)
this is wrong!"*

### Cause
`loadAllClubsOverview` was counting raw `MoMVote` rows
(`db.moMVote.findMany({ where: { playerId: userId, ... } })`). So if
Kemal received 9 votes across (say) 3 matches, the dashboard said "9
MoM". The per-club page does it right via `momWinners()` — the player
who won the vote, with ties co-winning, matching the bot's
announcement.

### Fix
Pull each match's full vote set, run `momWinners()`, count matches the
user won:

```js
db.match.findMany({
  where: matchScope,
  select: { activity: { select: { orgId: true } }, momVotes: { select: { playerId: true } } },
}),
// ...
for (const m of matchesWithVotes) {
  if (momWinners(m.momVotes).has(userId)) {
    byOrg.get(m.activity.orgId)!.mom++;
    totalMom++;
  }
}
```

Verified live: Kemal **9 → 1**.

## Same commit — attendance % since joining

### The bug
Kemal: *"David joined the Sutton FC club only last week and since then
only 1 match happened but system shows his attendance as 14%."*

### Cause
`attendanceRate = Math.round((gamesPlayed / totalOrgMatches) * 100)`
where `totalOrgMatches = all completed matches in the org since launch`.
David: 1 game / 7 total = 14%, even though he was only eligible for 1
of them.

### Fix
Compute a denominator scoped to **when the player joined**:

```js
const membership = await db.membership.findUnique({
  where: { userId_orgId: { userId, orgId } },
  select: { createdAt: true },
});
const joinDate = membership?.createdAt ?? null;
// ...
const effectiveStart =
  joinDate && earliestPlayed
    ? earliestPlayed < joinDate ? earliestPlayed : joinDate
    : (joinDate ?? earliestPlayed);
const eligibleMatches = effectiveStart
  ? matches.filter((m) => m.date >= effectiveStart).length
  : totalOrgMatches;
const attendanceRate =
  eligibleMatches > 0 ? Math.round((gamesPlayed / eligibleMatches) * 100) : 0;
```

The `earliestPlayed` fallback handles **retroactive squad fixes** —
if an admin adds a player to a match from before their join date (which
this session's recovery did), that match still counts.

Also rebased the **Iron Man badge** on `eligibleMatches`:
> Iron Man — Played every match since joining (min 3 eligible)

Verified live: David **14% → 100%** (1/1).

## `54e5a4d` — Leaderboard shows everyone, marks 1-game players

### The bug
Kemal: *"in squad leaderboard for sutton lads, why don't we see every
player who played?"* (only 9 of 14 visible). *"Not just sutton lads,
any new org."*

### Cause
`loadRatingLeaderboard` defaulted to `minGames: 2`. Sutton Lads has 2
total matches — anyone rated in only one was held back. For young orgs,
this hides most of the squad.

### Decision (Kemal picked from AskUserQuestion)
Option 1: **Show everyone, mark 1-gamers** (recommended). Most
inclusive; ranking caveat made visible via tag.

### Fix
- Added `provisional: boolean` to `LeaderboardRow` (true when
  `games < 2`).
- Stats page now calls `loadRatingLeaderboard(orgId, { minGames: 1,
  limit: 20 })`.
- Render: each provisional row gets a small amber **"1 game"** tag.
- Updated the `InfoButton` text to explain the tag.
- **Team of the Season keeps minGames: 2** — a one-game wonder
  shouldn't make the best XI.

Verified: Sutton Lads leaderboard went 9 → 20 rows. Youssef 8.1
[1 game] sits at the top with the tag making the caveat clear, while
established multi-game players sit clean.

## Net effect

Multi-club players see their full picture (Kemal). Recent joiners
aren't punished by a launch-date denominator (David). Young orgs aren't
half-empty leaderboards (every new org going forward). Each fix took
maybe 10-30 LOC and unblocks a real friction.
