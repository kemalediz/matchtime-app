# Club-scoped ratings: one player, one rating per club

**Date:** 2026-09-18
**Status:** Design. No application code, no schema edit, no migration, no production write was made for this document. The production database was READ (organisation, membership, rating, user rows; counts and averages only) to measure what the change actually does to Sutton FC. Every code claim is cited `file:line` against `main` at `86cd195`.
**Decisions being designed to:** Kemal, 2026-09-18, five settled points restated in section 2. They are not re-argued here.

---

## 0. The short version

- **Ratings are global to a `User` today and this is already costing Sutton FC real accuracy.** Not hypothetically, not when the Turkish club joins. Today. 2,226 `Rating` rows exist across TWO orgs (Sutton Football Club 1,768, Sutton Lads 458), 23 users hold more than one active membership, and **9 of Sutton FC's 43 rated members have Sutton Lads scores inside the 60-rating window the balancer reads**. Amir's balancer rating is 6.424 when it should be 7.037: a 0.613 error that moves him **17 places up the draft order**, from 30th to 13th. Numbers and method in section 3.5.
- **The fix is a scope, not a new number.** A `Rating` already belongs to exactly one org through `matchId` to `Match.activityId` to `Activity.orgId`, and that chain is immutable. No new column on `Rating` is needed. The five reads that forgot to walk it are listed in section 3.
- **`User.seedRating` and `User.matchRating` move to `Membership`.** They are per-club opinions sitting on a global row. `Membership` already has `@@unique([userId, orgId])` (`prisma/schema.prisma:518`) and is the obvious home.
- **The blend's prior changes from a seed to the club's own mean.** `(sumPeer + seed * 3) / (peerCount + 3)` becomes `(sumPeer + prior * 3) / (peerCount + 3)` where `prior = thisClub'sSeed ?? thisClubsMeanRating ?? 5.0`. Nothing is imported from another club or from the overall. Behaviour at peerCount 0, 1, 2, 3 is tabulated in section 4.2.
- **PR #79 should be merged first, not rebased and not closed.** It deletes one of the three rival formulas and makes the Elo leaderboard-only, which turns "make the Elo per-club" from a team-selection change into a leaderboard change. Full answer, including one overstated claim in its own comments, in section 6.
- **Sutton's numbers move on the day slice 2 ships, for exactly 9 players, and for one reason only.** Section 9.3 names them, with the before and after. Every other movement in the table is a knock-on of those 9 passing people.

---

## 1. What a "rating" is in this codebase, before anything changes

Five distinct things all get called "the rating" in conversation. They are not the same object and the design has to say which one it means each time.

| Thing | Where it lives | Scale | Who writes it | Who reads it |
|---|---|---|---|---|
| **Peer rating** (one row) | `Rating.score` (`prisma/schema.prisma:1258-1271`) | integer 1 to 10 | a team-mate, through `submitRatings` (`src/app/actions/ratings.ts:93`) | everything below |
| **Seed rating** | `User.seedRating` (`prisma/schema.prisma:81`) | float 1 to 10 | admin (`src/app/actions/players.ts:171`), onboarding (`src/app/actions/onboarding.ts:274,286`), finish-setup (`src/app/actions/finish-setup.ts:86`), auto-provision default of 6 (`src/app/actions/players.ts:16,324,357,680,698`) | the blend, below |
| **Balancer rating** (derived, not stored) | `computePlayerRating` (`src/lib/player-rating.ts:25-46`) | float 1 to 10 | nobody, it is computed per call | team generation |
| **Season average** (derived) | `loadPlayerSeasonStats(...).avgRating` (`src/lib/player-stats.ts:135`) | float 1 to 10 | nobody | stats pages, DM Q&A |
| **Elo** | `User.matchRating` (`prisma/schema.prisma:82`) | integer, default 1000 | match completion (`src/lib/match-completion.ts:76`), score capture (`src/app/api/whatsapp/score/route.ts:114`), admin score entry (`src/app/actions/matches.ts:269`) | leaderboard, and today one balancer path |

Two of these five are already correctly club-scoped and must not be touched (section 3.3). Three are global and are the whole of this work.

---

## 2. The decisions this design is built on

Kemal, 2026-09-18. Restated so the rest of the document can be read against them, not to reopen them.

1. **Two ratings exist.** A **club rating**, computed only from ratings given inside that club. An **overall rating**, the **simple average of every one of the player's ratings**, every rating weighted equally regardless of which club it came from. Not weighted per club. Not club-equalised.
2. **Team generation, and anything a club acts on, uses the club rating only.** Never the overall.
3. **No cross-club carry-over into a new club.** A player joining a new club starts with no rating there. Their first ratings at that club are the starting point. Kemal: *"it shouldn't be affecting the new club, the seed may not be needed at all as [the new club's] rating is made after the first match and people will rate and that can be the seed rating for a start."*
4. **Visibility.** On a player's stats page: they see the **club ratings** of other players in the same club. They see their **own overall rating**. Nobody ever sees another player's overall rating. **Club admins do see club ratings.**
5. **`seedRating` and `matchRating` stop being global.** They are per-club concepts.

---

## 3. Current state, verified

Every site that reads or writes a rating, a seed or an Elo. Line numbers against `86cd195`.

### 3.1 GLOBAL and wrong: the sites this design must fix

| # | Site | What it does | Why it is wrong |
|---|---|---|---|
| G1 | `src/lib/team-generation.ts:88-100` | `db.rating.findMany({ where: { playerId: a.userId }, orderBy: { createdAt: "desc" }, take: 60 })`, fed with `a.user.seedRating` into `computePlayerRating` | No org filter at all. This is THE balancer input on the live WhatsApp path. A Sutton Lads rating sets a Sutton FC team sheet. |
| G2 | `src/app/api/cron/generate-teams/route.ts:57-73` | same unfiltered `findMany`, then `ratings.length >= 3 ? mean : user.seedRating ?? 5.0` | No org filter, AND a third, older step-function formula. Scheduled live, `vercel.json` `"0 12 * * *"`. |
| G3 | `src/app/actions/teams.ts:11-34` | same unfiltered `findMany`, plus `user.matchRating / 200` blended in | No org filter, AND the only Elo-blended formula. **PR #79 deletes this whole function.** See section 6. |
| G4 | `src/app/page.tsx:115-126` | dashboard rating tile: same unfiltered `findMany` into `computePlayerRating` | The tile sits on a club-scoped dashboard and shows a number computed across every club the player is in. This is the one player-visible leak of another club's data. |
| G5 | `src/lib/match-history.ts:270-280` | Elo leaderboard: `db.user.findMany({ select: { matchRating } })` | The USER SET is org-scoped (`teamAssignment.match.activity.orgId`, `:267`) but the VALUE is `User.matchRating`, a global Elo. A Sutton Lads win moves a player up the Sutton FC leaderboard. |
| G6 | `src/app/actions/players.ts:160-174` `seedPlayerRating(userId, orgId, rating)` | writes `db.user.update({ data: { seedRating } })` | It already takes `orgId` and already checks `requireOrgAdmin` against it, then writes a global column. One club's admin overwrites another club's seed. |
| G7 | `src/app/actions/onboarding.ts:274,283-287` and `src/app/actions/finish-setup.ts:83-88` | write `User.seedRating` during onboarding | Same: org is in hand, write is global. |
| G8 | `src/app/actions/players.ts:16,324,357,680,698` | every auto-provision path sets `seedRating: DEFAULT_SEED_RATING` (= 6) | Explains the probe result "143 of 143 users have a seed set". Under decision 3 a brand-new membership must start with NO seed, so this default has to stop being written at membership creation. Section 4.3. |
| G9 | `src/lib/match-completion.ts:67-77`, `src/app/api/whatsapp/score/route.ts:66-115`, `src/app/actions/matches.ts:227-270` | Elo write sites: read `user.matchRating`, write `db.user.update({ data: { matchRating } })` | All three know the match and therefore the org, and all three write a global column. |
| G10 | `src/lib/merge-players-core.ts:60-73` | on merge, backfills `seedRating` and `matchRating` onto the keeper when the keeper is missing them | Once these are per-club, a single global backfill is meaningless. Needs to become per-membership. |
| G11 | `src/lib/player-stats.ts:653-723` `loadAllClubsOverview` | `overallAvg: mean(ratings.map(r => r.score))` at `:720`, over `orgId: { in: orgIds }` where `orgIds` are the user's **active** memberships (`leftAt: null`, `:655`) | Almost right. This IS the overall rating decision 1 asks for, and the per-club breakdown at `:701-714` IS the club rating in its raw form. The one divergence: a player who left a club loses those ratings from their overall. Section 5.2. |

### 3.2 GLOBAL but harmless: no action needed

- `src/app/actions/players.ts:494-495`: `db.rating.count({ where: { raterId } })` and `{ playerId }`, unfiltered. This is a merge heuristic weighing which of two duplicate `User` rows has more history. "More history anywhere" is the right question there; club scope would make it worse.
- `src/lib/wipe-org.ts:87` and `scripts/wipe-org.ts:97`: counted via `matchId: { in: matchIds }`, already scoped by construction.

### 3.3 ALREADY CLUB-SCOPED: do not double-fix these

Named explicitly because half a dozen of the surfaces a reader would expect to fix are already correct, and "fixing" them would be churn.

| Site | How it is scoped |
|---|---|
| `src/lib/player-stats.ts:135-163` `loadPlayerSeasonStats(orgId, userId)` | `where: { activity: { orgId } }` at `:163`. Every derived number on the stats page (`avgRating`, form, timeline, chemistry, rivalry) inherits it. |
| `src/lib/player-stats.ts:451-459` `loadRatingLeaderboard(orgId)` | `where: { activity: { orgId }, ... }` at `:459`. |
| `src/lib/player-stats.ts:540-575` `loadTeamOfSeason(orgId)` | `:554` and `:575`. |
| `src/app/admin/stats/page.tsx:16-28` | `ratingsReceived: { where: { match: { activity: { orgId } } } }` at `:21`. The admin leaderboard is already club-only. |
| `src/lib/rating-progress.ts:79-116` | keyed on one `matchId` found by `activity: { orgId }` at `:81`. |
| `src/lib/bot-scheduler.ts:1880-1884` and `:1947-1951` | rating-reminder DM and MoM-readiness, both `where: { matchId }`. |
| `src/app/matches/[matchId]/page.tsx:124`, `src/app/api/matches/[matchId]/route.ts:60` | match-scoped. |
| `src/lib/dm-qa.ts:134,147` | reads `loadPlayerSeasonStats(orgId, userId)`, so the "my stats" DM answer is already club-only. |
| `src/app/profile/[playerId]/page.tsx`, `src/app/api/players/[playerId]/route.ts:64`, `src/app/api/wrapped/[playerId]/route.tsx:95` | all read `loadPlayerSeasonStats(orgId, ...)`. |

**A consequence worth stating out loud:** a player's stats page already shows them a club-scoped `avgRating` tile (`src/app/profile/page.tsx:212`), while the dashboard on the very next screen shows a global blended number (G4). Those two tiles disagree today, for the 9 Sutton players in section 3.5, and nothing tells the player why.

### 3.4 `Rating` is already org-scoped by construction

`Rating.matchId` to `Match.activityId` (`prisma/schema.prisma:641-642`) to `Activity.orgId` (`:542-543`). A match cannot move between orgs: nothing in the codebase writes `Activity.orgId` after creation. So **a `Rating` row belongs to exactly one club for its whole life, and the club is derivable with a join.** This is why no `orgId` column on `Rating` is proposed in section 7.

### 3.5 What the global rating is doing to Sutton FC right now

Measured read-only against production on 2026-09-18. No writes. Method: for every active Sutton FC member, compute (a) today's number, `computePlayerRating(seed = User.seedRating, peers = the 60 most recent ratings from ANY club)`, exactly as `src/lib/team-generation.ts:88-100` does it, and (b) the same formula over Sutton FC ratings only.

```
ORGS WITH RATINGS
  Sutton Football Club   1,768 ratings   43 rated players
  Sutton Lads              458 ratings   26 rated players
  (2,226 rows total; 59 distinct rated players, so 10 players are rated in both)

club mean rating: Sutton FC 6.674   Sutton Lads 6.397
143 users, 143 with a seed set, 36 with a moved Elo
155 active memberships, 23 users holding more than one
```

The nine Sutton FC members whose balancer rating is wrong today:

| Player | Sutton ratings in window | Foreign ratings in window | Today | Club-only | Error | Draft rank today to club-only |
|---|---|---|---|---|---|---|
| Amir | 24 | 32 | 6.424 | 7.037 | **+0.613** | 30 to 13 |
| Ehtisham Ul Haq | 39 | 26 | 6.825 | 7.214 | +0.389 | 13 to 12 |
| Youssef | 9 | 20 | 7.156 | 7.500 | +0.344 | 11 to 7 |
| Faris | 11 | 24 | 6.500 | 6.286 | **-0.214** | 25 to 33 |
| Ersin Sevindik | 9 | 10 | 7.364 | 7.500 | +0.136 | 8 to 6 |
| Shaz | 23 | 23 | 5.898 | 6.038 | +0.140 | 39 to 38 |
| Omar Laher | 40 | 10 | 6.642 | 6.767 | +0.125 | 20 to 16 |
| Adam Khandaza | 48 | 32 | 6.460 | 6.549 | +0.089 | 26 to 24 |
| Usama | 10 | 12 | 6.760 | 6.692 | -0.068 | 16 to 18 |

Three things follow.

1. **The `take: 60` window is the amplifier.** Amir has 56 ratings in his window and 32 of them are from a club he no longer plays for. Ehtisham's window is truncated at 60 out of 65, so Sutton ratings are being *evicted* by Lads ratings.
2. **Sutton Lads is churned** (removed MatchTime after an incident, 2026-06-18) and its org is dormant. The contamination is from a dead club and will never self-correct.
3. **The other 34 members' numbers do not change at all.** Every visible rank shuffle in the full table is a knock-on of these 9 passing people.

---

## 4. The club rating

### 4.1 Derivation

```
clubRating(user, org) = clamp(1, 10,
    (sum(clubPeerRatings) + prior * PRIOR_WEIGHT) / (count(clubPeerRatings) + PRIOR_WEIGHT))

  clubPeerRatings = the N most recent Rating.score rows where
                      playerId = user AND match.activity.orgId = org
  prior           = Membership(user, org).seedRating
                    ?? clubMeanRating(org)
                    ?? 5.0
  PRIOR_WEIGHT    = 3   (unchanged)
  N               = 60  (unchanged)

clubMeanRating(org) = mean of Rating.score over every rating given in org
                      (null when the club has none)
```

Nothing on the right-hand side can be affected by another club. That is the property the whole design turns on, and section 10.1 is the test that pins it.

### 4.2 What replaces the seed when there is no seed, concretely

Decision 3 says a player joining a new club starts with nothing. Today `computePlayerRating` (`src/lib/player-rating.ts:31-37`) blends toward `args.seedRating ?? DEFAULT_SEED` with `DEFAULT_SEED = 5`. Two things are wrong with carrying that forward unchanged.

- A hardcoded 5.0 is not neutral. Sutton's own mean is **6.674**. An unseeded new player therefore enters the balancer 1.67 below every rated player at the club, which is not "unknown", it is "the worst player on the pitch". The snake draft takes that literally.
- 5.0 is not neutral in a *different* club either. Sutton Lads sat at 6.397. Clubs rate on their own scales and a fixed midpoint is a guess about all of them.

So the prior becomes the club's own centre of gravity, which requires no seed, no overall and no other club:

| peerCount | rating | in words |
|---|---|---|
| **0** | `prior` exactly | With a club seed: the seed, unchanged from today's behaviour. Without one: **the club's own mean rating**. At Sutton that is 6.674, so an unknown player is treated as an average member of THIS club. |
| **1** | `(p1 + 3 * prior) / 4` | own score 25%, prior 75% |
| **2** | `(p1 + p2 + 3 * prior) / 5` | own scores 40%, prior 60% |
| **3** | `(sum + 3 * prior) / 6` | 50 / 50, the crossover, identical to today |
| 9+ | | `source` flips to `"peer"`, as today (`src/lib/player-rating.ts:43`) |

At peerCount 1 and 2 the average of one or two scores is noisy, and shrinking it 75% and 60% toward the club mean is exactly the right amount of distrust. This is the same Bayesian shape the file already documents at `src/lib/player-rating.ts:1-20`; only the identity of the prior changes.

**A club with zero ratings anywhere** (the Turkish club on day one) has `clubMeanRating = null`, so every player gets `prior = 5.0`, so every player gets 5.0, so the balancer's rating term is constant and it falls through to position composition and its hill-climb. That is the honest answer to "we know nothing about anybody" and it is what the club would get from a coin toss, which is what they are doing by hand today. It is also self-correcting: after one match and one round of rating DMs, `clubMeanRating` becomes real and every subsequent sheet is informed.

**The proposed signature**, replacing `computePlayerRating`:

```ts
export function computeClubRating(args: {
  /** Membership.seedRating for THIS club. Null when unseeded. */
  clubSeedRating: number | null;
  /** Rating.score rows from THIS club only, newest first, capped at 60. */
  clubPeerRatings: number[];
  /** Mean of every rating given in THIS club. Null when the club has none. */
  clubMeanRating: number | null;
}): {
  rating: number;
  source: "peer" | "blended" | "seed" | "club-average";
  peerCount: number;
};
```

`source` gains one value, `"club-average"`, for peerCount 0 with no seed. The UI needs it to render the empty state in section 8.1 rather than presenting a club average as if it were the player's own number.

### 4.3 The default seed of 6 stops being written

`DEFAULT_SEED_RATING = 6` (`src/app/actions/players.ts:16`) is written on every auto-provision path (`:324, :357, :680, :698`). Under decision 3, a new membership must carry no rating. So:

- New `Membership` rows are created with `seedRating = null`.
- `Membership.matchRating` keeps its `@default(1000)`, because Elo's 1000 genuinely is "no information" and it is leaderboard-only after PR #79.
- The constant and its four call sites go. The club-mean prior is what replaces it, and it is better: a new Sutton player enters at 6.674 rather than a number somebody picked in March.

### 4.4 One aggregate per generation, not per player

`clubMeanRating(org)` is a single `db.rating.aggregate({ _avg: { score: true }, where: { match: { activity: { orgId } } } })`. Compute it **once** in `generateTeamsForMatch` and pass it to every player's `computeClubRating`. Doing it per player would be 14 identical aggregates per team sheet.

---

## 5. The overall rating

### 5.1 Definition

**The simple mean of every `Rating.score` where `playerId = user`. No weighting, no per-club normalisation, no seed prior.** A player with 1,000 ratings at club A and 3 at club B gets a number that is essentially club A's, and Kemal chose that knowingly.

No seed enters it. A seed is one admin's opinion inside one club, and there is no such thing as an overall admin.

### 5.2 It already exists, almost

`src/lib/player-stats.ts:720` is literally `overallAvg: mean(ratings.map((r) => r.score))`, and `:701-714` already produces the per-club breakdown. Two changes are needed.

1. **Pool every rating, not only active memberships.** `:654-656` restricts `orgIds` to `leftAt: null` memberships, so a player who left a club silently loses those ratings from their overall. Decision 1 says "all of the player's ratings". Drop the membership join from the ratings query: `db.rating.findMany({ where: { playerId: userId } })`. Keep the membership join for the per-club BREAKDOWN, which should list clubs the player is currently in.
   *Consequence to accept deliberately:* a player who left Sutton Lads keeps those 458-pool ratings in their overall but no longer sees a Sutton Lads row in the breakdown, so the overall will not be reconstructible from the visible rows. Section 8.1 says this in the copy.
2. **Say which it is.** Today the tile is labelled "Avg rating" (`src/app/profile/stats/page.tsx:93`) inside a card headed "Across all your clubs", which is only rendered when `clubCount > 1` (`:62`). After this change it is a named, defined number and it needs its own label. Section 8.

### 5.3 Where the overall may and may not appear

**May:** the requesting player's own stats page, and the "my stats" DM answer when the asker is the subject.

**Must not, ever:** `loadAllClubsOverview` takes a bare `userId` with no viewer argument and no authorisation. It is called exactly once today, with the session user (`src/app/profile/stats/page.tsx:29`). The design's rule, to be enforced by a test rather than a comment (section 10.4): **`loadAllClubsOverview` is never called with an id that is not the viewer's own.** In particular it must not appear in `src/app/profile/[playerId]/page.tsx`, `src/app/api/players/[playerId]/route.ts`, `src/app/api/wrapped/[playerId]/route.tsx` or `src/lib/dm-qa.ts`'s context for anyone but the asker.

---

## 6. PR #79: merge it first

**Merge it, before slice 1. Do not rebase it into this work and do not close it.** Plainly, with reasons.

What it does (read from `gh pr diff 79`, 856 additions, 100 deletions, 10 files): deletes the private `getPlayerRating` in `src/app/actions/teams.ts:11-34` (G3 above), makes the admin dashboard's Generate button delegate to `generateTeamsForMatch`, documents `User.matchRating` as leaderboard-only in the schema and in `src/lib/elo.ts`, wraps `runRatingAdjuster` in a try/catch, and adds `scripts/compare-rating-formulas.ts` plus a 367-line entry-point test.

Why first.

1. **It deletes one of the three formulas outright.** That is one fewer site for slice 2 to club-scope. If it does not land first, slice 2 has to either club-scope a function that is about to be deleted, or leave a global Elo-blended path alive behind a dashboard button, and an admin pressing Generate would get a different sheet from the one the bot posts. Both are worse than a merge.
2. **It makes the Elo leaderboard-only, which de-risks slice 6.** With #79 in, moving `matchRating` to `Membership` touches a leaderboard and nothing else. Without it, that same move is a change to team selection on one path, on a live club, with real money on the fixture.
3. **The conflict surface is small and is mostly comments.** #79 touches `src/lib/player-rating.ts` header only (`:14-27`), and `src/lib/team-generation.ts` header plus the adjuster call (`:125-155`). This design rewrites `player-rating.ts`'s body and `team-generation.ts:88-100`. The overlap is a header block and an import line.
4. **Its measurement work is directly reusable.** `scripts/compare-rating-formulas.ts` already runs two rating vectors through the real balancer 401 times each and reports the modal sheet plus each vector's self-disagreement rate, because `balancePositionAware`'s hill-climb is random. Slice 2 needs exactly that instrument to make an honest "here is how Sutton's sheet moves" claim, and section 9.3 assumes it exists.

**One thing in #79 is overstated and should be corrected before it merges.** Its comments say, in four places, that `lib/team-generation.ts` is "since 2026-09-15 the only code in MatchTime that decides who is on which team" (`src/lib/team-generation.ts:2-4` in the diff, `src/lib/elo.ts`, `src/lib/player-rating.ts`, `src/lib/team-slot-swap.ts`). It is not. `src/app/api/cron/generate-teams/route.ts:57-92` still computes its own `avgRating` with the old step function and still writes `TeamAssignment` rows and flips `Match.status`, and `vercel.json` schedules it daily at `"0 12 * * *"`. The PR's file list does not include it. That is a **third** implementation, not a second, and #79 leaves it standing. Either fold the cron into #79 as one more commit, or merge #79 as is and take the cron in slice 3 of this plan, which is what section 9 assumes. What must not happen is #79 merging with comments that tell the next reader the cron does not exist.

For what it is worth on whether the cron fires at Sutton: `Activity.deadlineHours` defaults to 5 (`prisma/schema.prisma:553`), so a 21:30 Tuesday match has a 16:30 London deadline and the 12:00 UTC cron runs before it. The cron is unlikely to be the path that builds Sutton's sheet. "Unlikely" is not "cannot", it is live scheduled code, and it is still the wrong formula.

---

## 7. Schema change, exact

### 7.1 What changes

```prisma
model Membership {
  // ... existing fields unchanged ...

  /// ─── PER-CLUB RATING STATE (2026-09-18) ────────────────────────────
  /// Moved off User, where both of these were global. A player in two
  /// clubs had one seed and one Elo doing duty for both; see
  /// MDs/club-scoped-ratings-design-2026-09-18.md section 3.5 for what
  /// that was costing Sutton FC.

  /// This club's admin opinion of the player, 1 to 10. NULL means the
  /// club has no opinion yet, which is the correct state for a new
  /// member: the blend then shrinks toward the CLUB's own mean rating,
  /// never toward another club's number and never toward the overall.
  /// Do NOT default this. A default is a carried-over opinion.
  seedRating  Float?

  /// This club's Elo. Leaderboard only (see lib/elo.ts). 1000 is the
  /// genuine "no information" value for Elo, so unlike seedRating it
  /// keeps a default.
  matchRating Int @default(1000)
}
```

```prisma
model Rating {
  // ... unchanged ...

  @@unique([matchId, raterId, playerId])
  /// The club rating reads "this player's ratings, newest first, capped
  /// at 60", then filters by org through match -> activity. The unique
  /// above is left-prefixed on matchId and cannot serve that. 2026-09-18.
  @@index([playerId, createdAt])
}
```

```prisma
model User {
  /// @deprecated 2026-09-18: SUPERSEDED by Membership.seedRating.
  /// Kept, not dropped, so the column change and the code change ship in
  /// different PRs (same precedent as Membership.ratingDmOptOut,
  /// prisma/schema.prisma:485-494). Drop in slice 7, after the backfill
  /// is confirmed in prod and nothing reads it.
  seedRating  Float?
  /// @deprecated 2026-09-18: SUPERSEDED by Membership.matchRating.
  matchRating Int @default(1000)
}
```

### 7.2 No `orgId` column on `Rating`, and why

The alternative considered was denormalising `Rating.orgId` at write time so the club rating is a single index scan with no join. Rejected, for now, on read volume.

- **The whole table is 2,226 rows.** The busiest player has 140 ratings, the median 29. A player's club rating is "fetch this player's rows, newest first, filter by a joined org, take 60". With `@@index([playerId, createdAt])` that is an index scan over at most 140 rows plus a join to `Match` and `Activity` on primary keys.
- Team generation runs it **once per squad member per team sheet**: 14 rows at Sutton, once a week, plus regenerations. The dashboard tile runs it once per page load. Nothing here is hot.
- A denormalised `orgId` buys a marginally cheaper plan and costs a **drift invariant**: every future writer of a `Rating` row must set it correctly, including `e2e/helpers/seed.ts:195`, the merge path, and any operator script. Invariants that live in developers' heads are how this codebase got three rating formulas.

**The escape hatch, with its threshold stated so nobody has to re-derive it:** if a single player ever exceeds roughly 5,000 rating rows, or the table exceeds roughly 2 million, revisit. `Rating.orgId` is safe to denormalise at that point precisely because section 3.4's chain is immutable: a rating's org can never change, so the column can never go stale after it is written.

### 7.3 No stored aggregate for the club rating

Also considered and rejected: a materialised `Membership.clubRating` recomputed on write. It would have to be invalidated by every `Rating` upsert (`src/app/actions/ratings.ts:93`), every merge (`src/lib/merge-players-core.ts:213-232`), every match delete (`Rating` cascades from `Match`, `prisma/schema.prisma:1260`) and every org wipe (`src/lib/wipe-org.ts:87`). Four invalidation sites, each of which is a chance to serve a stale team sheet, for a query that costs nothing. The derived-at-read-time approach is also what every other number on the stats page already does.

### 7.4 How it is applied

This repo applies schema with **`prisma db push`, not migrations** (`MDs/skills.md:24,151`, `MDs/learnings.md:93`; the `prisma/migrations/` directory is out of sync and is not the source of truth). Two consequences that matter here.

- **Schema is applied to PROD BEFORE the code that uses it deploys** (`MDs/skills.md:294`: "Schema (`prisma db push`) is immediate; server CODE is not"). So each slice below is: push the column, confirm, then merge and deploy the code that reads it. A slice that needs a column and a read in the same PR is a slice that will 500 in the window between push and deploy.
- **`db push` will DROP a column removed from the schema.** This is exactly why `User.seedRating` and `User.matchRating` stay in the schema until slice 7, after the backfill has been confirmed live. Removing them in the same PR that adds the `Membership` ones would destroy the source data mid-backfill.

---

## 8. What each surface shows afterwards

### 8.1 Player stats page, `/profile/stats`

| Element | Today | After |
|---|---|---|
| "Avg rating" headline tile (`:122`) | `loadPlayerSeasonStats(orgId).avgRating`, already club-scoped | Unchanged number. Relabelled **club rating** so it is distinguishable from the overall. |
| Rating leaderboard (`loadRatingLeaderboard`) | club-scoped | Unchanged. This is other players' **club ratings**, which decision 4 permits. |
| Team of the Season | club-scoped | Unchanged. |
| "Across all your clubs" card, shown only when `clubCount > 1` (`:62`) | `overallAvg` labelled "Avg rating" | Labelled **your overall rating**, with the line that says it is theirs alone. Per-club rows keep showing each club's own average. |
| A player with no club ratings yet | shows a bare dash placeholder | Shows the empty state string in section 8.5, not a dash, and not the club average dressed up as theirs. |

### 8.2 Dashboard, `/`

The rating tile (`src/app/page.tsx:115-126`) becomes club-scoped: `computeClubRating` over this org's ratings and this membership's seed. **This is the only player-visible number that changes value**, and for the 9 players in section 3.5 it changes by up to 0.613. It stops disagreeing with the stats page tile.

### 8.3 Admin, `/admin/stats` and `/admin/players*`

- `/admin/stats` (`src/app/admin/stats/page.tsx`): already club-scoped, unchanged. **Admins see club ratings, and that is intended** (decision 4).
- `/admin/players` (`:623`) and `/admin/players/ratings`: the seed editor. Reads `Membership.seedRating` instead of `User.seedRating`, through `src/app/api/players/route.ts:84` which already iterates memberships (`m.user.seedRating` becomes `m.seedRating`). `seedPlayerRating` (`src/app/actions/players.ts:160`) already takes `orgId` and already authorises against it, so the change is the write target only. A hint line makes the scope visible (section 8.5).
- **No admin surface ever shows a player's overall rating.**

### 8.4 Team generation output and DMs

- The posted team sheet (`formatTeamsPost`, `src/lib/group-copy.ts:72`) prints names, not ratings. **No group-facing copy changes and no group post changes shape.**
- Rating-collection DMs (`dm_rating`, `dm_rating_reminder`, `src/lib/bot-scheduler.ts:1880-1930`) are match-scoped and unchanged.
- The "my stats" DM answer goes through `loadPlayerSeasonStats(orgId, userId)` (`src/lib/dm-qa.ts:134`) and is already club-only. The model's context labels are English by design (`src/lib/dm-qa.ts:422` and the header at `:190-200`), so no new translated string is needed there; the context gains one club-scope label so the model cannot claim a number is "across all your clubs".
- `buildHelpReply`'s ratings explainer is the one existing user-facing string that becomes **untrue** after this change, because it promises a rating built from "everyone's scores" without saying which club. Section 8.5.

### 8.5 User-facing strings, English and Turkish

Conventions followed: `src/lib/i18n/strings.tr.ts:38-70`. Function per entry, WhatsApp single-asterisk bold, "sen" in DMs and plural imperatives in group-facing text, no time-of-day greeting, no dashes, interpolated values placed where Turkish needs no suffix on them.

**Note on scope:** the web UI is not in the i18n table today (only `src/app/admin/settings/page.tsx` imports it). These keys are specified in the table because that is where they belong and because the stats page is a server component that already holds the membership and can therefore do `t(org.language)`. Wiring the page to the table is part of slice 6, not a prerequisite.

**NEW keys, additive to `copy.en.snap`. No existing English case is touched by any of these.**

`rating_club_label`
- EN: `Your rating at Sutton Football Club`
- TR: `Kulüp puanın: Sutton Football Club`

`rating_club_note`
- EN: `From this club's ratings only. Other clubs never count here.`
- TR: `Sadece bu kulüpte aldığın puanlardan. Başka kulüpler buraya karışmaz.`

`rating_overall_label`
- EN: `Your overall rating`
- TR: `Genel puanın`

`rating_overall_note`
- EN: `Every rating you have ever had, from every club, counted once each. Only you can see this.`
- TR: `Bugüne kadar aldığın bütün puanlar, hangi kulüpten olursa olsun, hepsi bir kez sayılır. Bunu sadece sen görüyorsun.`

`rating_club_empty`
- EN: `No ratings at this club yet. Your team-mates set this after your first game.`
- TR: `Bu kulüpte henüz puanın yok. İlk maçından sonra takım arkadaşların puan verecek.`

`rating_seed_club_hint` (admin seed editor)
- EN: `Seed ratings apply to this club only.`
- TR: `Başlangıç puanları sadece bu kulüp için geçerli.`

**CHANGED, one existing English case.** `### R142 buildHelpReply / ratings` in `src/lib/i18n/__tests__/__snapshots__/copy.en.snap:1396-1401`, source `src/lib/i18n/strings.en.ts:739-744`, Turkish `src/lib/i18n/strings.tr.ts:712-715`.

*Deliberate reason, for the PR that re-records the snapshot:* the third line currently promises "a form rating for each player" built from "everyone's scores", with no club boundary. After this change that sentence is false for any player in two clubs, and it is false in the direction that matters (it implies their other club's scores count). The replacement states the boundary. It also drops the em dash the current line carries, which is house style for new copy.

Third line only. Lines 1, 2 and 4 of the explainer are untouched.

- EN, new: `I combine everyone's scores into a form rating for each player at this club, updated after every game, and that is what I use to build *balanced teams*. Ratings stay inside the club: if you also play for another group, their scores never touch this one. So the more people rate, the fairer the teams.`
- TR, new: `Herkesin puanlarını birleştirip bu kulüpteki her oyuncu için maçtan maça güncellenen bir form puanı çıkarırım, *dengeli takımları* bununla kurarım. Puanlar kulübün içinde kalır: başka bir grupta da oynuyorsanız oradaki puanlarınız buraya karışmaz. Ne kadar çok kişi puan verirse takımlar o kadar adil olur.`

(Plural register on the Turkish, matching the surrounding lines `verirsiniz` at `:713` and `yazın` at `:715`. The DM-register strings above use "sen", matching `dm_rating` at `:753`.)

---

## 9. Backfill and migration

### 9.1 What actually has to change on day one

Less than it looks, because of one fact: **every existing `Rating` belongs to a Sutton match**, either Sutton Football Club or Sutton Lads, and there is no third club with ratings. So the backfill is not a reconciliation, it is a copy.

```
User.seedRating  -> Membership.seedRating   for every membership of that user
User.matchRating -> Membership.matchRating  for every membership of that user
```

Both are straight fan-outs of one global value onto each of the user's memberships. That is deliberately **not** an attempt to be clever: the global value is the only evidence that exists, splitting it would be inventing data, and copying it preserves today's behaviour exactly on the day the column lands.

Counts the backfill will touch, from the probe: **155 active membership rows**, of which 143 distinct users all have a seed set, and 36 users have a moved Elo.

The one asymmetry worth naming. For the 23 users with two memberships, the Elo copy gives both clubs the same starting Elo, which is a fiction in both. It is the least-wrong fiction available, it is leaderboard-only after PR #79, and it decays as each club's own results accumulate. The alternative, resetting everyone to 1000, would blank 36 users' leaderboard standing on a Tuesday for no gain.

### 9.2 The dry run

**No production write happens without a dry run first.** `scripts/backfill-membership-ratings.ts`, defaulting to dry, `--apply` to write, matching the repo's existing script convention.

Dry-run output, exactly:

```
MEMBERSHIP RATING BACKFILL (DRY RUN, no writes)

memberships                      155   (active and left both; left rows keep history)
  already have seedRating          0
  will receive seedRating        143
  source user has no seed          12
  already have matchRating       155   (column default 1000)
  will receive a moved Elo        36

users with more than one membership: 23
  of those, with a moved Elo:      N   <- these get the same Elo in both clubs

PER-ORG
  Sutton Football Club   NN memberships, NN seeds, NN Elos
  Sutton Lads            NN memberships, NN seeds, NN Elos
  Friday Night Football  NN ...
  FNF                    NN ...
  BenchTest mpl6m779     NN ...

SAMPLE (10 rows)
  user                 org                    seed  elo
  ...

NO ROWS WRITTEN. Re-run with --apply to write.
```

Then `--apply`, then the same script re-run dry as the verification: it must report `will receive seedRating 0`.

**Idempotent by construction:** it only writes where `Membership.seedRating IS NULL`, so a second `--apply` is a no-op and a partial failure is safe to resume.

**Rollback:** `User.seedRating` and `User.matchRating` are still populated and still in the schema until slice 7. Reverting the code reverts the behaviour with no data restore.

### 9.3 How Sutton's numbers move, and when

**Slice 1 (columns plus backfill): zero movement.** Nothing reads the new columns.

**Slice 2 (club-scoped balancer input): this is the day.** From section 3.5, on the current membership:

- **34 of 43 Sutton members: no change at all**, to three decimal places.
- **9 members change**, all nine because Sutton Lads ratings stop counting. Largest moves: **Amir 6.424 to 7.037** and **Ehtisham Ul Haq 6.825 to 7.214** up, **Faris 6.500 to 6.286** down. Full table in section 3.5.
- **The new prior changes nothing at Sutton**, because all 143 users have a seed today, so `seed ?? clubMean` always selects the seed. Verified directly: the club-only-with-seed column and the club-only-with-new-prior column are identical for all 43 rows. The club-mean prior only starts mattering for members created after slice 4 stops writing the default of 6, and for the Turkish club.
- **The team sheet:** a rating change is not a sheet change. `balancePositionAware` ends in a 1,000-iteration hill-climb seeded from `Math.random()`, and PR #79 measured 19 distinct sheets across 401 runs of one real squad. So the claim to make on the day, and the only one that is honest, is made with `scripts/compare-rating-formulas.ts` pointed at the actual squad: run both rating vectors N times, compare the MODAL partition, and report each vector's self-disagreement rate as the noise floor. **The deterministic half is the draft order**, and that is where Amir moving 30th to 13th shows up.

**This is not a silent change and must not be shipped as one.** Section 11 open question 1 asks Kemal whether the group is told. Whatever the answer, the club's two admins should know before the first sheet is generated on the new numbers.

**Slices 3 to 7: no further movement in team generation.** Slice 3 deletes the cron's rival formula, slice 5 moves the Elo (leaderboard only), slice 6 is copy and read-path, slice 7 drops dead columns.

---

## 10. Test plan, TDD

Red first, in this order, per slice. `vitest` for unit (`npm run test:unit`), `e2e/run.ts` for the flow tests, and the existing sim harness where a bot path is involved.

### 10.1 The load-bearing test, written before any of it

**`src/lib/__tests__/club-rating-isolation.test.ts`: a rating from club A cannot move club B's team sheet.**

Fixture: two orgs, one shared player P with memberships in both. P has ten 9s in club A and two 4s in club B. Build club B's sheet twice: once as fixtured, once with club A's ten 9s deleted.

```
RED   (today)  the two sheets differ, and P's rating differs by ~3.6
GREEN (after)  P's club B rating is identical in both runs, and so is the
               draft order, and so is the partition
```

The assertion is on the **draft order and the rating vector**, not on the final partition, because the hill-climb is random (PR #79's own test file stubs `Math.random` for exactly this reason and says so in its header). Use the `rating-only` strategy for the fixture, which has no hill-climb, plus the same `Math.random` stub as belt and braces.

A second case in the same file, the inverse: deleting club B's ratings must not change club A's sheet.

### 10.2 Slice 2, `computeClubRating`

`src/lib/__tests__/club-rating.test.ts`, all pure, no DB:

1. peerCount 0 with a club seed of 8 and club mean 6.674 returns exactly 8.0, `source: "seed"`.
2. peerCount 0 with NO club seed and club mean 6.674 returns exactly 6.674, `source: "club-average"`.
3. peerCount 0 with no seed and no club mean (empty club) returns 5.0.
4. peerCount 1 of [9] with prior 6 returns 6.75 (own 25%).
5. peerCount 2 of [9,9] with prior 6 returns 7.2 (own 40%).
6. peerCount 3 of [9,9,9] with prior 6 returns 7.5 (exactly 50/50, the crossover).
7. peerCount 9 flips `source` to `"peer"`.
8. Clamped to [1,10] for an out-of-band seed, as today.
9. **The function's signature makes the bug unrepresentable:** it takes `clubPeerRatings` and `clubMeanRating` and has no parameter that could carry another club's number. Assert by type, not by runtime.

Plus a regression test that the **old** behaviour is preserved where it should be: a single-club player with a seed gets the identical number from `computeClubRating` that `computePlayerRating` gave. That is 34 of Sutton's 43, and it is what "no unnecessary movement" means.

### 10.3 Slice 2, the query

`src/lib/__tests__/team-generation-club-scope.test.ts`: with `db.rating.findMany` mocked, assert the call carries `match: { activity: { orgId } }` and that `orgId` is the match's org. A test on the shape of the query, because the failure mode is a forgotten filter, not a wrong arithmetic.

### 10.4 Slice 6, visibility

`src/lib/__tests__/overall-rating-visibility.test.ts`:

1. `loadAllClubsOverview` pools ratings from a club the user has LEFT (`leftAt` set) into `overallAvg`, and does not list that club in the breakdown.
2. A static check over `src/app` that `loadAllClubsOverview` appears in exactly one file, `src/app/profile/stats/page.tsx`, and is called with the session user id. Grep-shaped, deliberately: the risk is a future page adding it under a `[playerId]` route, and no runtime test catches that.
3. `loadPlayerSeasonStats(orgB, userInBothClubs).avgRating` is unaffected by club A's ratings.

E2E (`e2e/`): sign in as player 1, open `/profile/[playerId]` for player 2, assert the page contains player 2's club rating and does **not** contain player 2's overall.

### 10.5 Copy

- `copy-golden.test.ts` re-recorded in its own commit, with the six new cases and exactly one changed case (`R142 buildHelpReply / ratings`), the reason in section 8.5 quoted in the PR body. Header case count is the only other line in the English diff.
- `strings.test.ts` already enforces the no-dash hygiene rule and full key coverage on the Turkish table; it must stay green with no `untranslated()` wrapper.
- `no-time-of-day-greeting.test.ts` covers the new keys automatically (it scans the directory).

### 10.6 Backfill

`scripts/__tests__/backfill-membership-ratings.test.ts` against the e2e database: seed two users, one with one membership and one with two, run the backfill's pure planning function, assert the plan, assert idempotency (running the plan twice produces an empty second plan).

### 10.7 Gates before each merge

`npx tsc --noEmit`, `npm run test:unit`, `npm run test:e2e`, `npm run build`. Slice 2 additionally needs the live-squad comparison from section 9.3 pasted into the PR body, because a unit test cannot tell Kemal how his actual Tuesday sheet moves.

---

## 11. Implementation slices

Each is independently shippable and independently revertible. Sutton FC is live with real money on the fixture and one real group.

| # | Slice | Schema push | What could break live |
|---|---|---|---|
| **0** | **Merge PR #79.** Correct its "only implementation" comments first (section 6). | none | The admin Generate button starts running the LLM rating adjuster and honouring pins. Its sheet changes to match the bot's, which is the point. Measured in the PR. |
| **1** | `Membership.seedRating` (nullable, no default) and `Membership.matchRating` (default 1000). `@@index([playerId, createdAt])` on `Rating`. Backfill script, dry run, apply. **Nothing reads the new columns.** | yes, before the code | Nothing. Additive columns, no reader. The index build on 2,226 rows is instant. |
| **2** | `computeClubRating` replaces `computePlayerRating`. `src/lib/team-generation.ts:88-100` reads club-scoped ratings and `Membership.seedRating`, and the club mean is computed once per generation. | none (uses slice 1's columns) | **Sutton's team sheet changes.** 9 of 43 members, section 9.3. Tell the two admins before the first generation. Revert is a one-file revert. |
| **3** | `src/app/api/cron/generate-teams/route.ts:57-92` deletes its formula and delegates to `generateTeamsForMatch`, leaving the cron as the auto-publish and auto-complete maintenance job its own header already claims it is. | none | The cron rarely builds a Sutton sheet (section 6), but if it fires it now produces the same sheet as the bot instead of a third one. That is strictly an improvement. Risk: the cron's loop has its own `getOrgFeatures` gate at `:45-49` which must be preserved. |
| **4** | Seed WRITES move to `Membership`: `seedPlayerRating` (`players.ts:160`), onboarding (`onboarding.ts:274,283`), finish-setup (`finish-setup.ts:86`), `src/app/api/players/route.ts:84`, the two admin pages. `DEFAULT_SEED_RATING` and its four call sites deleted (section 4.3). `merge-players-core.ts:60-73` backfills per membership. | none | An admin editing a seed writes to the right club. New auto-provisioned members arrive unseeded, so they enter the balancer at the club mean instead of 6. At Sutton that is 6.674, slightly generous rather than slightly harsh. Watch the merge path: it is transactional (`players.ts`) and must stay so. |
| **5** | Elo moves to `Membership`. Write sites `match-completion.ts:67-77`, `api/whatsapp/score/route.ts:66-115`, `actions/matches.ts:227-270`, all of which already know the match and so the org. Read site `match-history.ts:270-280`. | none | Leaderboard only, after slice 0. The Sutton Elo leaderboard is unchanged on day one (the backfill copied the value). It starts diverging from Sutton Lads' the first time a score is entered. |
| **6** | Read paths and copy. Dashboard tile (`page.tsx:115`) club-scoped. `loadAllClubsOverview` pools all ratings (section 5.2). New i18n keys, the one changed help string, the stats page reading them. Snapshot re-recorded in its own commit. | none | The dashboard tile changes value for the 9. The overall rating changes for anyone who has left a club. Pure UI and copy otherwise. |
| **7** | Drop `User.seedRating` and `User.matchRating`. | yes, and it is destructive | Only after a live confirmation that nothing reads them (`grep`, plus one week of slice 4 and 5 running). `db push` will drop the columns; there is no undo short of a database restore. |

**Ordering constraints that are not negotiable:** 0 before 2 (section 6). 1 before 2, 4 and 5, with the schema pushed before the code deploys (section 7.4). 4 and 5 before 7. 3 is independent of everything after 0 and can be taken whenever.

---

## 12. The three related bugs, and what this design does with each

Each claim from `MDs/league-team-fit-walcountians-2026-09-17.md:383` was re-verified against the code before being repeated here.

**1. The close-ratings cron is a no-op.** *Verified.* `src/app/api/cron/close-ratings/route.ts` is 14 lines: it checks `CRON_SECRET` and returns `{ ok: true }`. Its own comment at `:12-13` says so. It is scheduled daily at `"0 6 * * *"` in `vercel.json`. Rating windows are genuinely enforced per request (`src/app/actions/ratings.ts:22`) and there is a 5-day scheduler backstop (`src/lib/bot-scheduler.ts:1873-1874`), so nothing is broken.

**This design LEAVES it alone.** It is unrelated to scoping, and the honest fix is to delete the route and its `vercel.json` entry rather than invent work for it, which is a separate one-line PR and someone else's ticket. Worth noting only because a reader of this design will wonder whether a "close the ratings" job needs to become club-aware. It does not, because it does nothing.

**2. Three divergent rating formulas.** *Verified, and the doc's line numbers are right.* `src/lib/player-rating.ts:36` (the Bayesian blend, live bot path), `src/app/api/cron/generate-teams/route.ts:62-65` (the older step function), `src/app/actions/teams.ts:22-33` (the only Elo-blended one).

**This design ABSORBS it, but only with PR #79.** #79 deletes the third (`actions/teams.ts`); slice 3 deletes the second (the cron); slice 2 replaces the first with `computeClubRating`. After slice 3 there is one formula in one function with one caller path, which is what #79's comments already claim and what section 6 says must be made true before those comments merge.

**3. A schema comment claiming an admin toggle that does not exist.** *Verified.* `prisma/schema.prisma:1079-1085` says `paidAt` "can also be toggled from the admin match page". No such toggle exists. The only writers are `src/app/actions/payments.ts:327` (the collector's `/collect/[matchId]` page confirming a direct payment), `src/app/api/whatsapp/poll-vote/route.ts:128` (the payment poll), `src/lib/payment-flow.ts:140` (a reset to null), `src/lib/owner-deps.ts:166` (bulk "X paid for Y") and `src/lib/merge-players-core.ts:169` (merge carry-over). None is an admin match page.

**This design LEAVES it alone.** It is a payments comment, not a ratings one, and touching `prisma/schema.prisma` for an unrelated one-line comment inside a rating PR is exactly the kind of drive-by that makes a schema diff unreviewable. It belongs in whichever PR next touches the payment schema.

---

## 13. Open questions for Kemal

Genuine ones only. The five decisions in section 2 are not re-asked.

1. **On the day slice 2 ships, is the group told?** Nine Sutton players' ratings change, Amir's by 0.6, and the draft order changes visibly. Options: say nothing (the ratings are not posted, only the sheet is), tell the two admins privately, or one line in the group. My recommendation is telling the admins, because a player who has been watching his own dashboard tile will notice it move and the admins should not be surprised by the question.

2. **What is a club rating with only one or two ratings allowed to do?** The design shrinks it 75% and 60% toward the club mean, so a single 10 lands at 7.5 at Sutton rather than 10. That is the right call for the balancer. But the stats page shows a number too, and `loadRatingLeaderboard` already has a `provisional` flag it sets at `games < 2` (`src/lib/player-stats.ts:519`). Should a player with 1 or 2 club ratings see their raw average, the shrunk one, or be told it is provisional? I have designed the balancer and the display to use the same shrunk number, on the "one number per player per club" principle, but it is a display choice you may want the other way.

3. **Does a player who LEFT a club keep those ratings in their overall?** I have designed yes (section 5.2), reading "all of the player's ratings" literally, which means Sutton Lads scores stay in the overall of the ten players who have both. The alternative is that leaving a club retires its ratings from the overall. Yes is simpler and matches the wording; no is arguably what a player would expect.

4. **Is the Elo worth keeping per club, or worth retiring?** After PR #79 it drives one leaderboard section and nothing else, only 36 of 143 users have ever moved off 1000, and slice 5 exists purely to give it a per-club home. If the Elo leaderboard is not something the club looks at, deleting `matchRating` in slice 7 alongside the deprecated columns is less code than moving it. I have designed the move, not the deletion, because deleting a leaderboard people might be reading is your call and not mine.

5. **The Turkish club's first team sheet will be built from nothing** (section 4.2: every player at 5.0, so the balancer falls through to position composition and its hill-climb). That is correct and self-correcting after one match. Is it acceptable as a first impression, or do you want their admin offered the seed editor during onboarding so week one has some signal? The onboarding analyser already proposes seeds (`src/lib/onboarding-analyzer.ts:226-238`) and `finish-setup` already has a seed column in its UI, so the machinery exists; it is a question of whether we point them at it.
