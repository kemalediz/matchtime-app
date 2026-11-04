# One summary of the club: design and migration plan ("step 2")

**4 November 2026. Design only: no product code changes in this branch.** Slice A0 was
built on `refactor/club-summary-a0` the same day; where the build differs from this plan,
section 3.7 says how and why, and the sections it touches point there.

Every claim below was read in the code on `origin/main` at `321559be`. Citations are
`file:line` against that commit. Nothing was run against a model and nothing was spent
($0, no Anthropic key used).

---

## 1. The decision, up front

**What Kemal approved.** Keep the router and the narrow extractors exactly as they are
("the model reads, the code decides"). Add one function that answers "what is this club
right now" as one typed value, and make every decision, scheduled post, DM, reminder and
reader take its facts from it, instead of each working them out itself.

**Why, in one paragraph.** Today the club's facts are not read in one place. Lines that
mention the club columns this plan covers appear in well over a hundred files (section
2.1), and the derived facts (is the month started, is the squad short, which match is
next, are payments on) are each computed several ways. The recent incidents all came from
two of those ways disagreeing: the Vets got the weekly "Say IN to join" post because the
announce gate only knew a month in sign-up (`84e4bddd`, #501); payment DMs went out with
both payment flags off because the monthly money flow read neither flag (`cfc6be5e`,
#515); the list reader refused "MNF November" because the seed door only knew the coming
month (`5b468a73`, #502); and "short" is three different tests inside one file today
(section 2.3, D1). Each was fixed where it hit. The fixes are correct, but each one added
another local definition, so the next disagreement is already waiting in a sibling job
(section 2.3 lists fifteen that exist today).

**What the summary is.** A plain list of facts about one club at one instant, built by
one loader, with every fact derived by one pure function. Kemal's own example, for the Vets,
reads: monthly squad, November running, 13 regulars, 13 paid; pay as you go places
at £8; payments not tracked and not collected, Davide collects; 7-a-side, 14 places,
playable with 12 to 16; next match Monday 9 November, 13 in, 1 place open, not below the
minimum; aliases (Smiler is Nabz).

**What it is not.** It is not a decision engine and not a home for special cases. It
holds no field such as `sendSayIn` or `skipChase`. A consumer still decides ("a monthly
club with no month gets no chase"), but it decides from a named fact everyone else reads
too (`match.month.phase === "none"`), instead of re-deriving the phase from its own query.
A guard test keeps it that way (section 3.6).

**How it ships.** Fourteen small PRs in three phases (section 4):

- **Phase A, re-source (5 PRs).** Consumers read the summary instead of their own queries,
  with every value byte-identical. No behaviour change, no model input change, so the
  club-scenario replays stay free and the transcripts must come out identical.
- **Phase B, align (7 PRs).** One disagreement per PR, each turning two definitions into
  one. These change behaviour on purpose (each names the club shape whose transcript will
  change and why). Five of them need a product decision from Kemal first (K1 to K5).
  None changes a prompt. B3 and B5 change what a DM classifier is shown (the data, not the
  wording), and B1 does too if K1 moves "At risk"; those count as LLM changes. B1, B2 and
  B7 change posts that a later CONTEXT quotes, so their clubs need a re-record (4.4).
- **Phase C, readers (2 PRs, optional).** Only where a reader's CONTEXT should say a fact
  it does not say today. These are LLM changes under the repo rules: old against new
  side by side, paid tests on `ANTHROPIC_API_KEY_DEV`, cassettes re-recorded.

---

## 2. Inventory: who works out club facts today

### 2.1 How it was counted

Four read-only passes, one per consumer family (scheduler, analysis path and readers, DM
and HQ handlers and composers, web), each listing every line that reads a raw column or
runs its own query to work out one of eleven facts, instead of receiving it:

| # | fact | columns and helpers |
|---|---|---|
| F1 | weekly or monthly, and the month's state | `Organisation.squadMode`, `SquadMonth.status`, `loadRunningMonths`, `loadLiveMonths`, `monthNotStartedFor`, `seedableMonths` |
| F2 | payments on or off, who collects | `paymentTrackingEnabled`, `paymentCollectionEnabled`, `stripeChargesEnabled`, `payMethod*`, `paymentHolderId` |
| F3 | feature switches | `featureAttendance`, `featureBench`, ... through `getOrgFeatures` |
| F4 | places, fewest and most players, "short" | `Match.maxPlayers`, `Activity.minPlayers`, `Activity.maxPlayers`, `playersPerTeam * 2`, `min-players.ts` |
| F5 | the fee | `Match.feePerPlayer`, `Activity.feePerPlayer`, `feeSplitTotal`, `paygPricePence` |
| F6 | the bench | `BENCH` rows, `benchPickMode`, `benchPickFallback` |
| F7 | aliases and the order of the roster | `UserAlias`, `withAliases` |
| F8 | the open or next match | `selectRegistrationMatch`, `isNextUpcomingForPosting`, ad hoc `findFirst` |
| F9 | language | `Organisation.language`, `normaliseLang` |
| F10 | mute and lifecycle | `whatsappBotEnabled`, `dormantAt`, `approvalStatus`, `setupStage`, billing pause |
| F11 | HQ and routine settings | `adminGroupId`, `adminChannelMode`, `listAnnouncer`, `momChosenBy`, `teamsReadyTime`, quiet hours, deadlines |

A rough mechanical count first (lines mentioning the column outside tests, comments
included, so an upper bound): `squadMode` 173 lines in 59 files, `paymentHolderId` 115 in
37, `adminGroupId` 86 in 27, `feePerPlayer` 79 in 29, `minPlayers` 62 in 17,
`whatsappBotEnabled` 62 in 42, `paymentCollectionEnabled` 58 in 28,
`paymentTrackingEnabled` 55 in 27, `listAnnouncer` 54 in 30, `paygPricePence` 41 in 10.
There are **260 `organisation.find*` calls in 131 non-test files**, and 35 calls of
`getOrgFeatures` outside its own file. The club's aliases are read with their own
`userAlias.findMany` in 22 places.

One analyze request alone can read the club row five times
(`analyze/route.ts:489`, `:541`, `:3307`, and again inside `loadSquadState` at
`pipeline/load-state.ts:44` and `:75`) and picks the registration match twice with two
different queries (section 2.3, D7).

### 2.2 By consumer

The counts are decision sites (a line that works a fact out), assembled from grep hits and
reads, so they are approximate, and a few sites are counted by two passes. In all: **about
650 places work out one of these facts themselves**, plus about 400 language reads. Language (F9) is counted separately because nearly every
read goes through `t()` or `normaliseLang`, which already agree.

| consumer family | sites, F1 to F8, F10, F11 | language reads | own club-row selects |
|---|---|---|---|
| A. Scheduler: `bot-scheduler.ts`, `due-posts`, crons, and the sweeps they call | about 250 (about 90 in `bot-scheduler.ts` and `due-posts` alone) | 60 or more | `bot-scheduler.ts:564`, plus `getOrgFeatures` at `:963` and the org include on every match at `:1278` |
| B. Analysis path: `analyze/route.ts`, `pipeline/*`, and the readers that build model CONTEXT | about 115 | about 8 | `analyze/route.ts:489` (five columns), `getOrgFeatures` at `:541` and `:3307`, and `loadSquadState` (`load-state.ts:44`, `:75`) run by five batch owners per players' group batch (`attendance-engine-batch.ts:570`, `answer-batch.ts:911`, `team-ops-engine-batch.ts:440`, `admin-ops-engine-batch.ts:438`, `score-engine-batch.ts:291`); `admin-group.ts:163-180` for HQ |
| C. DM and HQ handlers, webhooks, composers | about 105 | about 20 | three full copies: `HELLO_ORG_SELECT` (`group-hello.ts:265`), `INTRO_SELECT` (`admin-group-intro.ts:41`), `admin-group.ts:165`; smaller ones in `club-setup-dm.ts:240`, `my-payments.ts:34`, `dm-help.ts:115`, `direct-payment.ts:50`, `fee-waiver.ts:77`, and four in `dm-reply/route.ts` (`:389`, `:727`, `:933`, `:1679`) |
| D. Web pages, server actions, web API routes | about 190 | about 300 (all through `t()`) | `api/org/settings/route.ts:76-156` assembles the whole picture by hand; every page selects its own |

**A. Scheduler.** One poll (`computeDuePosts`, `bot-scheduler.ts:541`) loads the club row,
then the switches again, then each match with its club included, so one poll holds three
copies of `paymentTrackingEnabled` (`features.paymentTracking` from `:963`,
`activity.org.paymentTrackingEnabled` from the include at `:1280`, and the row from
`:564`). Monthly state is built by hand per match at `:1055-1085` from three sources
(running and recently closed months, months in sign-up, and "held" months, which are a
`SentNotification` key prefix, not a row). The jobs gate on these facts:

| job | gates on | gap found |
|---|---|---|
| announce (`:1600-1760`) | F1 (`monthly`, `noMonthYet`), F3, F8 with the cancelled-day hold, F11 | none since #501 |
| 17:00 post, players' branch (`:1942`) | F1 `monthly \|\| noMonthYet`, F2, F4 by places | |
| 17:00 post, organisers' branch (`:1836`) | F1 `monthly` only | D2a |
| weekly deadlines D1, D3 (`:2117`) | F1 `!monthly && !noMonthYet` | the admin summary in `deadline-summary.ts:67-69` has no F1 check (D2b) |
| monthly list (`:2221`) | F1 `monthly.seeded`, F8 without the hold | D7 |
| recruit chase DM (`:2376`) | F4 by places, F3 by key | no F1 check (D2c) |
| bench offers (`:2530-2670`) | F6, F1 seeded | only the `bench-prompt` kind is gated on `features.bench` (`:1167`); offer DMs and pay as you go pool DMs are not (D8) |
| 10:00 "Low numbers" (`:2775`) | F4 by minimum (`lowNumbersBelow`) | D1 |
| 18:00 "Match in trouble" (`:2822`) | F4 by minimum over the sport family (`findMinimumToPlay`) | D1 |
| chases A, B, pre-kickoff (`:2863`, `:2942`) | F1 `noMonthYet` only, F4 by places | D1, D2c |
| payment poll (`:3049`) | F1 `!monthly`, F2 by key | `noMonthYet` not checked (D2c) |
| unpaid group reminder (`:3095`) | F1 `!monthly`, F2 raw tracking | `noMonthYet` not checked (D2c) |
| fee ask, pay chase (`:3150`, `:3235`) | F2 raw collection, F5 `Match.feePerPlayer` only | D9 |
| single exit filter (`:1164-1172`) | F3 by key prefix, F2 `paymentMessagesOn` by key prefix | keys with no known prefix always pass |

**B. Analysis path.** The pipeline itself is the most disciplined consumer: the engine and
`compose.ts` decide from one `SquadState` value. But that value has no squad mode, no
minimum, no payment collection flag and no fee (`load-state.ts:349-359`,
`pipeline/types.ts:1124-1145`), so anything monthly or money-shaped is decided outside
it, in the route, by raw `org.squadMode === "monthly"` tests (`analyze/route.ts:1341`,
`:1551`, `:1934`, `:2091`, `:3624`). About 25 model call sites exist (every SDK call goes
through `pipeline/llm.ts:449`, plus six raw `messages.create` calls); 11 of them render at
least one club fact into their CONTEXT:

| model call | CONTEXT builder | club facts it is shown |
|---|---|---|
| router `pipeline/router.ts:1016` | `renderRouterTurn` `:744` | none of the eleven (HQ: the WAITING lines and the HQ log) |
| extractor `pipeline/extractors.ts:1632` | inline `:1519-1568` | aliases (CLUB MEMBERS NAMED, cut at 8 or 30 in roster order), and MatchTime's last post and the recent chat, which carry whatever MatchTime said |
| monthly reader `monthly-reader.ts:188` | `monthly-reader-prompt.ts:235` | squad mode, the months and their state, places, the pay as you go price, the bench, members and aliases, language, paid marks |
| HQ squad reader `hq-squad-reader.ts:216` | `hq-squad-reader-prompt.ts:221` | the next game, its places, members, playing and bench |
| organiser pick reader `organiser-pick-reader.ts:114` | `organiser-pick-reader-prompt.ts:130` | the list, the squad, other members, language |
| call-off reader `calloff-reader.ts:176` | `:100` | the next game |
| month seed reply `month-seed-reply.ts:216` | `:103` | members and aliases |
| chase composer `message-analyzer.ts:357` | `chase-lead.ts:122` | the match, places, places open, bench, "At risk" |
| DM questions `dm-qa.ts:441` | `formatScopedContext` `:310` | the next match, places, bench, the fee, the payment state |
| DM intent `dm-intent.ts:428` | `:383` | the person's clubs and whether each is setting up |
| payment claim `payment-claim-classifier.ts:178` | `PaymentClaimContext` | what is owed, the collector |
| fee confirm `fee-confirm.ts:281` | `FeeReplyContext` | the pending amount, the match |
| setup learning `setup-learning/run.ts:385` | `setup-learning/rules.ts:164` | the first active game, its format |

Each of these builds its facts itself, so the same fact reaches different models in
different words and from different queries (D6, D13, D14 below). For the A/B harness this
matters twice over: these are exactly the strings whose hash keys the cassettes.

**C. DM and HQ handlers, composers.** The engines behind HQ (`admin-ops-engine-batch.ts:438`,
`team-ops-engine-batch.ts:440`, `score-engine-batch.ts:291`, `admin-group-score.ts:111`)
are already the cleanest consumers: they read `loadSquadState`. Everything else reads its
own columns. The DM side picks "which match" five ways (`dm-reply/route.ts:1278-1285`,
`dm-qa.ts:181`, `dm-registration-target.ts:67-93`, `attendance/route.ts:174-178`,
`status/route.ts:23-27`), "which club for this DM" four ways (D10), and three composers
compute places open by hand (`group-copy.ts:53`, `scheduler-copy.ts:469`,
`squad-count-line.ts:55`). The group hello (`group-hello.ts:265-384`) and the HQ intro
(`admin-group-help.ts:177-198`) each map the whole club row to a description of the club,
separately, and they do not agree (D11). The Pi (`whatsapp-bot/src`) derives no club fact:
it relays the server's group sets (`handlers.ts:21-77`) and checks only its cached admin
group set (`scheduler.ts:450`).

**D. Web.** No page uses `getOrgFeatures`, `selectRegistrationMatch` or
`paymentMessagesOn`: only one server action calls `getOrgFeatures`
(`actions/players.ts:1166`), and `paymentMessagesOn` is imported by no file under
`src/app` or `src/components`. Each page selects the columns it needs and decides itself.
The next match is picked three ways (`app/page.tsx:90-98`, `matches/page.tsx:39`,
`matches/[matchId]/page.tsx:253-262`), "low" has a fourth meaning (the dashboard colour
at `app/page.tsx:188`), the fee two ways (`pay/[matchId]/page.tsx:133` match fee only, the
activities page edits the game's fee), and "payments on" three ways (D3, D4).

### 2.3 Where two places disagree today

This is the evidence for the refactor. **Verified** means I read both sides myself.
**Reported** means an inventory pass read it and I did not re-read every line; the
slice that touches it must confirm it with a failing test before changing anything.
Some differences below may be deliberate; where the code says so, that is noted. A
deliberate difference is still worth one name each, so nobody mistakes one for the other.

**D1. "Short" means three things, "places open" is computed in at least nine places.**
Verified.
- In `bot-scheduler.ts` alone: the 10:00 "Low numbers" offer fires below
  `lowNumbersBelow({ minPlayers, maxPlayers: Math.min(maxPlayers, playersPerTeam * 2) })`
  (`:2775`); the 18:00 "Match in trouble" fires below `findMinimumToPlay`, the lowest
  minimum over every game of the sport family (`:2822-2828`); the match-day chases fire on
  `confirmed.length < maxPlayers` (`:2863`), and the 17:00 post and recruit chase on
  `need = maxPlayers - confirmed` (`:1390`, `:2376`).
- In the composers and the players' group: `compose.ts:273`, `:365`, `:705`, `:908`;
  `group-copy.ts:53`; `scheduler-copy.ts:469`; `squad-count-line.ts:55`;
  `guest-name-ask.ts:105`; `recruit.ts:313`, all by places.
- On the web, a third "low": the dashboard colours a match blue at 75% of its places
  (`app/page.tsx:188`).
- Into a model: the chase composer is told "N places open" and "At risk", both from
  places (`chase-lead.ts:130-131`, `chase-risk.ts:65-77`).
- Effect for the Vets (14 places, minimum 12): at 13 confirmed the day before, the nudge
  says fine and the chase says one short. The concurrent scheduler PR addresses the
  scheduler's "short" (section 6).

**D2. The weekly flow still reaches a monthly club through doors the fixes did not cover.**
- a. Verified. The 17:00 post's organisers' branch skips only a running month
  (`bot-scheduler.ts:1836`: `else if (monthly)`), while the players' branch also skips a
  monthly club with no month (`:1942`: `else if (monthly || noMonthYet)`). The comment on
  the organisers' branch says "2-monthly: nothing, as below", so this is drift, not
  design.
- b. Verified. The admin "deadline summary" (`deadline-summary.ts:67-69`) checks the
  deadline, the lifecycle and attendance, never the squad mode; the scheduler's own
  deadline posts skip monthly clubs (`bot-scheduler.ts:2117`) for the reason its comment
  gives (two differently shaped lists).
- c. Verified. The payment poll (`:3049`) and the unpaid group reminder (`:3095`) test
  `!monthly` and not `noMonthYet`, so a monthly club with no month is treated as weekly
  there. (With payments off, the outer filter at `:1170` stops them anyway; with payments
  on, it would not.) Reported, not verified: the recruit chase DM (`:2376-2380`) reads no
  squad mode at all.
- d. Verified. "Squad complete" (`squad-announce.ts:75-78`) is held back only when
  `loadMonthlyWeek` returns a running month, so a monthly club with no month yet gets the
  weekly roster the scheduler holds back with `noMonthYet`.
- e. Verified. The players' group pipeline has no squad mode at all. The route swaps a
  composed weekly squad post for the month's list by **comparing the text**
  (`analyze/route.ts:3624-3637`: `if (text === weeklyPost) text = monthlyList.text`), and
  only when `currentWeekListPost` returns one.

**D3. Payments: one outer rule in the bot, several others elsewhere.** Verified.
- The rule: payments are on when tracking or collection is on
  (`payment-messages.ts:35-36`).
- The HQ "credit a payment" command needs tracking alone (`pipeline/engine.ts:2637`), and
  `SquadState.features` carries tracking only (`load-state.ts:351`), so the engine cannot
  apply the outer rule even if it wanted to.
- The payment answer has its own per-match rule:
  `paymentTracking || (paymentCollection && paymentLinksReleasedAt !== null)`
  (`payment-answer.ts:145`).
- The help's payments topic is on only with collection
  (`onboarding-conversation.ts:263`), and the settings page says "Payments: off" whenever
  collection is off (`settings-summaries.ts:98`), with the tracking switch hidden
  (`org-features-meta.ts:69`).
- The web never reads the rule: no file under `src/app` or `src/components` imports
  `paymentMessagesOn`. The member's month page offers "I've paid" with both flags off
  (`month/page.tsx:154`, `canClaim` reads only the amount); `/pay` and `/collect` read
  neither flag.
- A model is asked before the gate: the monthly paid claim is classified
  (`month-payment.ts:576-580`) and only then gated (`:595`).

**D4. "Can this club take a card" is spelled four ways.** Verified.
`isPaymentCollectionLive` (`payments-live-announce.ts:42-44`: collection, a connected
account and charges enabled); the group hello repeats it inline instead of importing it
(`group-hello.ts:351`); the pay methods helper offers a card on `stripeChargesEnabled`
alone (`payments.ts:48-50`); the pay action refuses without the connected account
(`actions/payments.ts:203`).

**D5. "Has this month started" has five definitions.** Verified.
- The scheduler: running and recently closed months (`loadSchedulerMonths`), months in
  sign-up (`loadLiveMonths`: open, priced or running, this and next London month), and
  "held" months, which are `SentNotification` keys (`bot-scheduler.ts:975-1085`); a match
  is a month's when `monthForMatch` finds a month of the same fixture by **venue and
  weekday** (`monthly-week.ts:231-244`, `match-slot.ts:55-62`).
- The players' group's IN hold: any `SquadMonth` row in any status for the match's month,
  by **activity id** (`month-not-started.ts:13-24`).
- The seed door: any `SquadMonth` of the club (no activity filter) for this or next month,
  and only when the club has exactly one active game (`month-seed-hq.ts:74-88`).
- The monthly reader recomputes "started" inline (`monthly-reader.ts:91`) instead of
  calling `monthStarted` (`month-signup-rules.ts:671`), and its MONTHS block only ever
  sees open, priced or running months of this and next month (`month-signup.ts:341-358`).
- `loadMonthlyWeek` sees running months only (`monthly-week.ts:292-322`).
- The #502 incident ("MNF November" drafted against December) was this disagreement at
  the seed door.

**D6. One monthly reader prompt states two capacities.** Verified. The MONTHS block says
`maxRegulars: playersPerTeam * 2` (`month-signup.ts:279`); the week block says the
match's own places (`monthly-week.ts:304`, `:1194`). After a match is switched to 8 a side
(#517) the model is told 14 and 16 about the same game.

**D7. "The next match" is chosen at least twelve ways.** Verified unless marked.
- The registration selector (`selectRegistrationMatch`) is fed six different candidate
  queries: `load-state.ts:46-71` (30 days, every status, the request clock),
  `analyze/route.ts:4570-4583` (every live match, no date floor, the wall clock),
  `dm-registration-target.ts:67-93` (wall clock), `admin-group-paste.ts:76-80`,
  `team-proposal.ts:190-200`, `match-graphics.ts:70-77`. So one analyze request picks its
  match twice, by two queries (`answer-batch.ts:973-979` exists to cope when they
  disagree).
- Others skip the selector: `dm-qa.ts:181` (live statuses, no date floor, a stuck past
  match is described to the model as "UPCOMING MATCH"); `attendance/route.ts:174-178`
  (adds `attendanceDeadline > now`, which the selector's header says is not a gate);
  `message-analyzer.ts:255-262` (the same deadline test when no match id is passed);
  `app/page.tsx:90-96` (an instant, not a day); `matches/page.tsx:39` (no status filter, so
  a cancelled future match is listed as upcoming); reported: `dm-reply/route.ts:1278-1285`
  (no in-flight block), `status/route.ts:23-27`, `recruit.ts:278`, `seed-nudge.ts:96`.
- The day itself: the selector uses UTC midnight (`registration-match-select.ts:44-48`),
  the posting rule the London day (`next-upcoming-match.ts:107-115`).
- The posting rule's cancelled-day hold is applied to the announcement and the 17:00 post
  (`bot-scheduler.ts:1607`, `:1799`) but not to the deadline posts or the month's list
  (`:2138`, `:2254`). The comment at `:1318-1319` says the hold is read only by those two,
  so this one is deliberate; it is listed because the plan makes it a named choice (K5).

**D8. A switch honoured in the players' group is ignored on another door.**
- Verified. The web IN button shows on any upcoming match (`matches/[matchId]/page.tsx:488`),
  whatever `featureAttendance` says; the rating link (`:274`) reads no `featurePlayerRating`.
- Reported, engine side verified. DM questions are answered with stats off; the group
  refuses (`pipeline/engine.ts:1851`).
- Verified. Only the `bench-prompt` kind is filtered on `features.bench`
  (`bot-scheduler.ts:1167`); offer DMs and pay as you go pool DMs have keys
  `featureForDueKey` does not classify, so they pass.

**D9. The fee is five things.** Verified unless marked.
- The DM answer tells the model `match.feePerPlayer ?? activity.feePerPlayer`
  (`dm-qa.ts:228`), as does `loadClubSnapshot`.
- The pay page says "No fee set yet" when the match has none (`pay/[matchId]/page.tsx:133`)
  and the direct pay path refuses (`direct-payment.ts:68`). The game's fee is deliberately
  never copied onto a match (`generate-upcoming-matches.ts:23`).
- Reported: a guest or pool ask uses match fee, then the pay as you go price, then the
  game's fee unless split (`monthly-week-asks-rules.ts:85-89`); month close uses match fee
  else the pay as you go price (`month-close.ts:1243`).

**D10. "Is this club served" is tested six ways.** Reported, two verified.
`whatsappBotEnabled` plus billing quiet (`analyze/route.ts:490`, `due-posts/route.ts:258`);
`whatsappBotEnabled` alone (`bot-scheduler.ts:564`, group join, leave and bot-added
routes); `servingClubWhere` (verified `picture-reading-db.ts:30`); `isClubOperational`
(verified `monthly-week.ts:1065-1067`); that plus `isClubSettingUp`
(`month-signup.ts:668`); and for a DM, which of a person's clubs counts:
`IN_LIVE_STAGE_CLUB_WHERE` (`dm-qa.ts:134`, `dm-registration-target.ts:54`) or
`APPROVED_CLUB_WHERE` (`dm-help.ts:115`, `dm-reader.ts:49`). The web "Generate match"
action creates a match with none of the cron's checks (verified
`actions/activities.ts:195`; the cron's are at `generate-upcoming-matches.ts:57-136`).

**D11. The group hello and the HQ intro describe the same club differently.** Verified.
Ratings: the hello says on only when ratings are on and attendance or squad from list is
(`group-hello.ts:177`); the intro says on whenever the rating switch is not false
(`admin-group-help.ts:181`). Weekly lists: the hello needs attendance, no squad from
list, weekly and not rolling (`group-hello.ts:153`); the intro needs weekly and
attendance (`admin-group-help.ts:185`). Three full club-row mappers exist for describing
a club (`HELLO_ORG_SELECT`, `INTRO_SELECT`, `admin-group.ts:165`).

**D12. "Smaller formats" has three rules.** Verified. The players' group answer uses
active games of any sport with fewer total places (`load-state.ts:206-215`); the 10:00
nudge offers the smallest of the same family, active or not (`bot-scheduler.ts:191-210`);
the chase composer's switch line takes every game of the family, active or not, largest
first (`message-analyzer.ts:280-292`). None reads the minimum.

**D13. The order names reach a model in depends on the database.** Verified.
`loadSquadState` reads memberships with no `orderBy` (`load-state.ts:82-88`), and
`membersNamedIn` stops at 8 or 30 names in that order, so which members appear in CLUB
MEMBERS NAMED can change after an unrelated UPDATE. The HQ squad reader has no order
either (`hq-squad-reader.ts:60-61`); the monthly reader orders by `createdAt`
(`monthly-reader.ts:57-60`); `withAliases` and the alias reads have none. For the
cassettes this is a source of misses that no code change caused. The concurrent HQ PR
works on part of this (section 6).

**D14. The same reader gets a different picture in HQ.** Verified. In the players' group
the monthly reader gets the next match and the chat history (`analyze/route.ts:1367`); in
HQ it gets `matchId: null` and `history: []` (`admin-group-understand.ts:1237-1240`), so
it never sees the week's list there.

**D15. Quiet hours: one sender ignores the club's.** Verified. `adminGroupPost`, used for
the final score ask, tests `isAdminGroupPostHour(args.now)` with the default window
(`admin-channel.ts:333`) where its siblings pass `ch.quietHours` (`:290`, `:365`, `:412`).

---

## 3. The summary

### 3.1 Where it lives

`src/lib/club-summary/`, four files, each with one job:

| file | job | imports Prisma? |
|---|---|---|
| `types.ts` | the `ClubSummary` type, nothing else | no (client components, `compose.ts` and the Playwright worker can import it) |
| `derive.ts` | one pure function per derived fact (`monthPhaseFor`, `matchNumbers`, `paymentFacts`, `feeFacts`, `pickNextMatch`, `sortRoster`), each the single definition | no |
| `load.ts` | `loadClubSummary(orgId, now, { members })`: the only I/O, a fixed set of reads, then the derive functions (as built: no `client` argument, see 3.7) | yes |
| `scope.ts` | `summaryScope(now, loader)`: memoises one summary per club for one request or one scheduler poll | no (takes the loader as an argument) |

The existing pure rule modules stay where they are and become the derive functions'
building blocks: `min-players.ts`, `flex-format-rules.ts`, `payment-messages.ts`,
`registration-match-select.ts`, `next-upcoming-match.ts`, `squad-month-rules.ts`,
`list-announcer.ts`, `team-proposal-rules.ts` (`effectiveTeamsReadyTime`). The summary
does not copy their logic; it calls them once and stores the answer.

`OrgFeatures` (`org-features.ts:33`) stays as the type of the switches, built by the same
`fromRow` (`org-features.ts:131`), so `getOrgFeatures` and `summary.features` can never
differ. `getOrgFeatures` remains for code that only needs a switch and has no summary in
hand; it is not deleted in this plan.

### 3.2 The shape

```ts
// src/lib/club-summary/types.ts
import type { OrgFeatures } from "../org-features";
import type { Lang } from "../i18n/lang";
import type { QuietHours } from "../message-hours";
import type { ApprovalStatus } from "../club-approval-state";

export interface ClubSummary {
  orgId: string;
  name: string;
  /** The instant it describes, ISO. Every derived fact is "as of" this. */
  asOf: string;
  language: Lang;

  lifecycle: {
    /** whatsappBotEnabled: the mute switch. */
    botOn: boolean;
    dormant: boolean;                 // dormantAt set
    approval: ApprovalStatus;      // club-approval-state.ts:14
    setupStage: string;               // "live" | the setup stages, as stored
    billingPaused: boolean;           // isBillingPaused, as the scheduler reads it
    /** isClubOperational: the one "is this club served" rule (D10). */
    operational: boolean;
    settingUp: boolean;               // isClubSettingUp
  };

  groups: {
    playersGroupId: string | null;
    hq: { groupId: string | null; channelMode: string; channelUserId: string | null };
  };

  /** The switches, exactly as getOrgFeatures returns them (same fromRow). */
  features: OrgFeatures;

  routine: {
    listAnnouncer: "matchtime" | "organisers";
    momChosenBy: "players" | "organisers";
    benchPickMode: "first-come" | "organiser";
    benchPickFallback: "bench-offer" | "leave-empty";
    teamsReady: string;               // "HH:MM" or "off", effectiveTeamsReadyTime
    quietHours: QuietHours;
    dropOutDeadline: { day: number; time: string } | null;
    listPublish: { day: number; time: string } | null;
    seasonBreakMonths: string[];      // "YYYY-MM-01"
  };

  payments: {
    tracking: boolean;                // paymentTrackingEnabled: the poll, unpaid lists
    collection: boolean;              // paymentCollectionEnabled: fee asks, pay links
    stripeReady: boolean;             // connected account and charges enabled
    /** paymentMessagesOn: the outer gate for ANY payment message. */
    messagesOn: boolean;
    collector: { userId: string; name: string | null } | null;
    methods: { payByBank: boolean; card: boolean; direct: boolean };
    instructions: string | null;      // paymentInstructions
  };

  squad: {
    mode: "weekly" | "monthly";
    rolling: boolean;
    /** Monthly only: what one pay as you go place costs, whatever the payment flags. */
    paygPricePence: number | null;
    creditRule: "any-miss" | "filled-only" | "none";
  };

  /** The club's active weekly games (Activity rows with isActive). */
  games: GameFacts[];

  /**
   * The club's matches the consumers look at: every live match, plus the
   * played and cancelled ones inside the scheduler's windows (the set
   * getMatchesForScheduler reads today, bot-scheduler.ts:1248). Oldest first.
   */
  matches: MatchFacts[];
  /** THE registration match: where an IN lands (selectRegistrationMatch). */
  nextMatchId: string | null;
  /** The last match that has ended (load-state.ts:157-201's rule). */
  lastPlayedMatchId: string | null;

  members: {
    /** Ordinary members, one stable order (D11): by display name, then userId. */
    roster: MemberFacts[];
    adminUserIds: string[];
  };
}

export interface GameFacts {
  activityId: string;
  name: string;
  dayOfWeek: number;
  time: string;                       // "HH:MM" London
  venue: string;
  sport: { name: string; family: string; playersPerTeam: number };
  /** The format's places, playersPerTeam * 2. */
  formatPlaces: number;
  /** formatMinimum: the organiser's minimum, else two full sides. */
  fewestToPlay: number;
  /** Activity.maxPlayers, else formatPlaces (flex-format-rules.ts). */
  mostPlayers: number;
  /** minimumToPlay over the same family: the lowest any of its formats plays with. */
  fewestAnyFormat: number;
  /** Smaller formats of the same family, totals, largest first (one rule, D12). */
  smallerFormats: Array<{ activityId: string; sportName: string; totalPlayers: number }>;
  fee: { perPlayer: number | null; splitTotal: boolean };
}

export type MonthPhase = "none" | "held" | "signup" | "priced" | "running" | "closed";

export interface MatchFacts {
  id: string;
  activityId: string;
  kickoffAt: string;                  // ISO
  status: "UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED" | "COMPLETED" | "CANCELLED";
  isHistorical: boolean;
  /** Match.maxPlayers: this match's places (format-resize can change it). */
  places: number;
  fewestToPlay: number;               // from its game
  confirmed: number;
  bench: number;
  /** max(0, places - confirmed). "Places open", never "short". */
  placesOpen: number;
  /** confirmed < fewestToPlay. The only meaning of "short" (D1). */
  belowMinimum: boolean;
  teamsMade: boolean;                 // TeamAssignment rows exist
  fee: { matchFee: number | null; feePendingConfirm: boolean };
  /** The live posting rule (isNextUpcomingForPosting with the cancelled-day hold). */
  nextForPosting: boolean;
  /** Monthly clubs only, else null. One phase per match (D2). */
  month: null | {
    phase: MonthPhase;
    monthId: string | null;
    monthStart: string;               // "YYYY-MM-01"
    /** The month's regulars have been put on this match (rollingSeededAt rule). */
    seeded: boolean;
    regulars: number;
    paid: { confirmed: number; claimed: number };
    startedPartWay: boolean;
  };
}

export interface MemberFacts {
  userId: string;
  name: string;                       // User.name, what the resolver matches on
  displayName: string;                // loadPlayerNames' printed line
  aliases: string[];                  // sorted
  isAdmin: boolean;
  hasPhone: boolean;
}
```

Every field is a fact a person could check on the admin screens. Two rules keep it that
way: no field may be a function, and no field may name an action (`should*`, `skip*`,
`send*`, `allow*`). Section 3.6 makes both a test.

**As built (A0), the shape above changed in eight places**, each because Phase A must not
pick a winner between today's disagreeing rules, or because the code said otherwise.
Section 3.7 lists them; `src/lib/club-summary/types.ts` is the authority.

### 3.3 How it is built, and what it costs

`loadClubSummary` makes a fixed set of reads, in parallel where they do not depend on each
other:

| read | what for | today's equivalent |
|---|---|---|
| 1. `organisation.findUnique` with one select (the `org-features` select plus the payment, routine, HQ and lifecycle columns, and the collector's name through `paymentHolderId`) | lifecycle, groups, features, routine, payments, squad | done 2 to 4 times per request today |
| 2. `activity.findMany({ orgId })` with sport | games, smaller formats, fewest any format | done separately by `load-state.ts:206`, `bot-scheduler.ts:191` and `:220`, `message-analyzer.ts:281` |
| 3. `match.findMany` over the scheduler's window, with attendance counts by status and the team assignment count | matches, nextMatchId, lastPlayedMatchId | `getMatchesForScheduler`, `findRegistrationMatch`, `load-state.ts:45` and `:157`, five other registration-match queries |
| 4. monthly clubs only: `squadMonth.findMany` for this and next London month, with member paid counts, and the "held" `SentNotification` keys | each match's `month` | `loadSchedulerMonths`, `loadLiveMonths`, the held read at `bot-scheduler.ts:1009-1025`, `monthNotStartedFor` |
| 5. `membership.findMany` plus `loadPlayerNames` plus one `userAlias.findMany` | members | `load-state.ts:82-108` and 22 other alias reads |

(As built, read 1 cannot carry the switches or the collector's name: see 3.7, items 1
and 2. The count is 5 to 8.)

**Five to seven indexed queries per summary**, independent of how many consumers then
read it. For comparison, one analyze batch today runs `loadSquadState` (about 16 to 20
queries, of which the club row, the match choice, the activities and the roster are the
same reads) plus four separate club-row reads in the route. One scheduler poll today reads
the club row, the matches, the months and the held keys itself. So the summary is not a
new cost on the hot paths: it replaces reads they already make. Read 5 is the only heavy
one and the scheduler does not need names for most jobs, so `loadClubSummary` takes
`{ members: false }` and the scheduler asks for members only when a job that names
people is due (the same lazy shape as `getAdminChannel` at `bot-scheduler.ts:576`).

The match window is bounded the way today's queries are: live matches of any date (a
small set, the cron completes finished ones), completed ones from the scheduler's
lookback, cancelled ones from the last 24 hours (`CANCELLED_HOLD_LOOKBACK_MS`,
`bot-scheduler.ts:1246`).

### 3.4 Caching: one request, one poll, never longer

`summaryScope(now)` is created at the top of each entry point and passed down:

- `analyze/route.ts`: one scope per batch.
- `due-posts/route.ts` and `computeDuePosts`: one scope per poll, so every job in one poll
  sees the same club (today a poll can see the club row from `:564` and `getOrgFeatures`
  from `:963`, read at different moments).
- `dm-reply`, `admin-group`, `reaction`, `poll-vote`, `score`, `teams`: one per request.
- Server pages: one per render, passed as a prop; server actions build their own.

There is **no module-level cache**. Vercel reuses a warm module across requests and the
Pi polls every 30 seconds; a cache that outlived one request would serve yesterday's
squad. The scope is a `Map<orgId, Promise<ClubSummary>>` and nothing else.

**After a write, the summary is stale and says so.** A request that writes attendance and
then needs the new count must call `scope.refresh(orgId)` or read the rows it just wrote,
as the engine already does (the engine decides on `SquadState` rows, not on counts). The
counts in `MatchFacts` are for gates that run before writes (the scheduler, the readers'
CONTEXT, the "is it short" checks). Section 5.1 lists this as the main risk.

### 3.5 How consumers get it

- **Pure functions take the slice they need**, never the whole summary, so their tests
  stay small: `decidePaymentSnapshot(summary.payments, ...)`,
  `canTakeFreePlace({ ..., pickMode: summary.routine.benchPickMode })`.
- **`loadSquadState` takes the summary as an argument** and stops reading the club row,
  the activities, the roster and the registration match itself. `SquadState.features`
  becomes a projection of `summary.features` and `summary.payments`, keeping its current
  field names so the engine and `compose.ts` do not change.
- **`loadClubSnapshot` (`load-state.ts:580`) is deleted** in favour of the summary: the
  collector, the fee and "Teams ready" are already there.
- **Each reader's CONTEXT builder takes values from the summary** but renders them in its
  own words, unchanged (Phase A). A shared rendering is Phase C and only where a reader
  needs a fact it lacks.

### 3.6 Keeping it a list of facts

Three guard tests, in the style of `__tests__/payment-messages-guard.test.ts`:

1. **Shape guard** (`club-summary/__tests__/shape-guard.test.ts`): walks `types.ts` and
   fails on a function-valued field or a field named `should*`, `skip*`, `send*`,
   `allow*`, `can*`. A new special case has to live in its consumer.
2. **Source guard, a ratchet** (`club-summary/__tests__/source-guard.test.ts`): lists every
   file that still reads `squadMode`, `paymentTrackingEnabled`, `paymentCollectionEnabled`,
   `paymentHolderId`, `minPlayers`, `paygPricePence` or `listAnnouncer` from a query of
   its own, and fails when a file NOT on the list starts to. Each Phase A slice deletes
   its files from the list. Writers (settings saves, `startMonth`) are exempt by name.
3. **One derive per fact**: `monthPhaseFor`, `matchNumbers` and `pickNextMatch` are the
   only places that compute what they compute; a grep test fails on a second
   `confirmed.length < maxPlayers` or a second `squadMonth.findFirst` outside writers.
   (As built: a ratchet too, since 15 files compute places, 7 look a month row up and 7
   feed the registration selector today; see 3.7, item 9.)

### 3.7 As built in slice A0, and where it differs from this plan

Built on `refactor/club-summary-a0` (PR against `refactor/club-summary`), on top of
`origin/main` `19c75141` (#519 and #520 included). No consumer reads it yet. $0: no model,
no key.

**The reads (pinned by `__tests__/load.test.ts` per club shape):**

| shape | reads |
|---|---|
| weekly, no collector, no members (FNF as the scheduler would load it) | 5 |
| weekly with a collector (Sutton) | 6 |
| monthly with a collector (the Vets) | 8 |
| `{ members: true }` | plus 1 roster read, `loadPlayerNames`' own 3 to 5, and `withAliases`' 1 |

The five always made: the Organisation row, `getOrgFeatures`, every Activity with its
sport, the scheduler's match window, the last-played candidates. Then the collector's name
when one is set, and for a monthly club the SquadMonth rows and the held keys.

**Where it differs, and why:**

1. **The switches are a read of their own.** `fromRow` and the select in `org-features.ts`
   are private, and A0 changes no file outside `src/lib/club-summary/`. So `features` is
   `getOrgFeatures(orgId)` itself, in parallel with the club row: identical by
   construction, one read more. Exporting the two (A1 or A2) folds it into read 1.
2. **The collector's name is a read of its own.** `paymentHolderId` has no relation to
   `User`, so it cannot ride on read 1; it is `loadClubSnapshot`'s `user.findUnique`, only
   when a collector is set.
3. **"Short" is #519's, not `belowMinimum`.** #519 settled the scheduler's "short" in
   `squad-short.ts` (below the minimum, else two full sides of the format, never above
   the places). `MatchFacts` has `placesOpen`, `shortBelow` and `short` from it, plus
   `fewestAnyFormat` for the 18:00 "Match in trouble" test. All three of D1's meanings are
   readable; none is new.
4. **No `smallerFormats` field (D12).** Today's three rules disagree on active-only versus
   all games and on order, and A0 must not pick one. `games` holds every Activity, active
   and inactive, with `active` and `sport.family`, so each rule can be re-expressed from it.
   B1 adds the one rule.
5. **The month is split into two levels.** `squad.months` holds the club's SquadMonth rows
   (regulars, paid, start, status), and each match's `month` holds only how that match
   relates to them. Per match there are seven facts, not the plan's phase alone, because
   today's consumers read different things (D5):
   - `phase`: the row of the match's FIXTURE (venue and weekday) by its status (open is
     "signup"), else "held" for a held key, else "none";
   - `listOpened`, `held`, `beforeStart` (a game before a part-way start), `seeded`;
   - `rowForOwnActivity`: `monthNotStartedFor`'s key (any row for the match's own
     activity), which differs from the fixture's after a format switch.
6. **The plan's A1 mapping was wrong about "priced".** The scheduler treats a month as in
   sign-up only when it is "open" AND its list has opened (`signupListPosts` filters
   `m.open && m.listOpenedAt`); a priced month, or an open one before its list opens, gives
   `noMonthYet`, unless a held key exists. The exact mapping, from the facts, is written
   out and tested in `__tests__/derive.test.ts` ("today's scheduler mapping"); A1 moves it
   into the scheduler. The text of A1 below is corrected.
7. **Roster order is #520's, not "display name, then id".** Section 6 asked C2 to adopt
   whatever the HQ PR chose; #520 chose membership `createdAt`, then id. The summary uses
   that. Aliases are sorted.
8. **Smaller differences.** `lifecycle` carries the predicates (`approved`, `settingUp`,
   `billingPaused`, `operational`, `dormant`, `botOn`), not the stored `approvalStatus`,
   `setupStage` or `billingStatus`: the existing source guards for those three columns
   (`club-approval-source-guard`, `club-setup-source-guard`, `club-billing-source-guard`)
   keep every reader on the predicates, and the summary obeys them (the stage is selected
   through `SETUP_STAGE_SELECT`);
   `teamsReady` is `effectiveTeamsReadyTime`; `collectionLive` (D4's
   `isPaymentCollectionLive`) is computed in `load.ts` because its module imports the
   database client; the fee is `matchFee`, `pendingConfirm` and `linksReleased` on the
   match and `perPlayer`, `splitTotal` on the game, with no combined fee (D9 is B5's);
   `nextForPosting` is `{ withHold, withoutHold }` (D7, K5); `month.regulars` counts the
   month's rows not marked left, and does not check the WhatsApp group (that needs the
   membership read `RunningMonth.left` makes); `lastPlayedMatchId` is its own read, because
   `loadSquadState`'s rule has no date floor and includes historical matches.
9. **The "one derive" guard is a ratchet**, like the source guard: today's count per file
   is pinned and may only fall. A guard that failed on a second occurrence would fail on
   day one.
10. **Two minor disagreements the plan did not list.** `formatMinimum` (min-players.ts) does
    not clamp the minimum to the places and `playerRange` (flex-format-rules.ts) does; they
    differ only for a minimum above the places, which the range rules refuse to save. Both
    are on `GameFacts` (`fewestToPlay`, `range.min`). And the loader's windows mirror two
    scheduler constants (`POST_MATCH_LOOKBACK_DAYS`, the unexported
    `CANCELLED_HOLD_LOOKBACK_MS`) and one of `monthly-week.ts`; `__tests__/load-windows.test.ts`
    reads both files and fails if they drift. A1 should export them and import them here.
11. **No Playwright spec of its own kind.** Playwright's worker cannot load the Prisma 7
    client, so the "API spec" is `e2e/api/club-summary.spec.ts`, which runs
    `e2e/helpers/club-summary-lib-tests.ts` under tsx against the embedded Postgres, as
    `format-resize.spec.ts` does. The five club shapes are built as fixtures in
    `__tests__/fixtures.ts`: the scenario harness lives on `sandbox/club-scenarios`, not on
    main. (The plan's own-language club is replaced by a muted club with its own minimum.)

### 3.8 As built in slice A1 (the scheduler reads the summary)

Built on `refactor/club-summary-a1` (PR against `refactor/club-summary`), with the club
scenario harness merged in from `sandbox/club-scenarios`. No value changes: the scheduler's
characterisation (`src/lib/__tests__/scheduler-club-summary-characterisation.test.ts`, eight
club shapes at 26 instants, written first and green on the old code) and the five club replays
come out identical. $0: no model, no key.

**What moved onto the summary.**
- `due-posts/route.ts` reads the club ONCE per poll, after the organiser pick and partner
  sweeps, with the club's row found by its group in the same query (`CLUB_ORG_SELECT`, so the
  summary does not read it again). The drop-out deadline summary (`deadline-summary.ts`), the
  unpaid list (`unpaid-list.ts`), the month sweeps' "is this club monthly" and
  `computeDuePosts` all read it. The month sweeps write months, matches and attendance, so
  after them a monthly club's summary is read again, keeping the rows no sweep writes (the row,
  the switches, the collector, the games, the last match played): 3 reads (plan 3.4).
- `computeDuePosts`: the club row (`:564`), `getOrgFeatures` (both reads), the bot intro's
  active-game count, the held-month read and its activity read, `paygPricePence`, the
  setting-up, billing, admin group, Teams ready and announcer facts for the first-teams and seed
  notices, and the 18:00 "Match in trouble" minimum (`findMinimumToPlay`, now
  `GameFacts.fewestAnyFormat`). The month shape per match is `schedulerMonthShape`
  (`scheduler-month-shape.ts`): A0's "today's scheduler mapping", plus the two windows the old
  reads had (a closed month counts for 14 days after its close; a month in sign-up only this
  London month or the next). The week's member list still comes from the running months'
  rows: it is content, not a club fact.
- `teamProposalJobs` (`team-proposal.ts:746`) takes the summary; its match-day read takes the
  games from it (one read fewer for an HQ club).
- The windows have one definition: `scheduler-windows.ts` (`MOM_ANNOUNCE_MAX_AGE_DAYS`,
  `POST_MATCH_LOOKBACK_DAYS`, `CANCELLED_HOLD_LOOKBACK_MS`, `CLOSED_MONTH_GATE_DAYS`, and the
  match window's `where`), read by the scheduler, `monthly-week.ts` and the loader.
- The summary gained one fact: `lifecycle.approvedAt` (the bot intro's self-join check).

**Left, and why.** `findSmallerSameSportActivity` (the 10:00 switch offer) keeps its own read:
it breaks a tie between two smaller formats by the database's row order, which the summary's
games (oldest first) cannot reproduce, and D12 is B1's. The per-match `activity.org` include
and every count, roster and team read stay: they are the content of the posts, and A1 changes
no model input. The month sweeps keep their own read of the club's row (they are not in A1).

**Cases the old code left to row order.** Two month rows of one fixture and one London month
(the month list keeps one per fixture), and a month in sign-up with no game left on its
calendar: the summary's rank decides where the old `find` took the first row. Neither occurs in
a club MatchTime runs.

### 3.9 As built in slice A2 (the analyze route and `loadSquadState` read the summary)

Built on `refactor/club-summary-a2` (PR against `refactor/club-summary`). No value changes: the
analyze path's characterisation (`src/lib/__tests__/analyze-club-summary-characterisation.test.ts`:
the real route over a fake world, six club shapes, an IN and five tagged requests at one to three
instants, every model request, write and reply snapshotted) was written first and green on the
old code, and the five club replays come out identical. $0: no model, no key.

**What moved onto the summary.**
- The route finds the club with `CLUB_ORG_SELECT` plus `ORG_FEATURES_SELECT` in its one query;
  the switches are `orgFeaturesFromRow` of that row (`org-features.ts` exports both, so
  `getOrgFeatures` and the route share one rule). Both of the route's `getOrgFeatures` reads go.
- One summary per request (`summaryScope`), read where the registration match used to be picked,
  so after the venue words' writes. Built from that row and switches, so it reads only the games,
  the match window, the last played candidates, the collector's name and, monthly, the months.
  `findRegistrationMatch` is deleted: the match is `nextMatchId` (the same selector over every
  live match). The month check is `!month.rowForOwnActivity` (`monthNotStartedFor`'s fact). The
  four monthly tests read `squad.mode`.
- `loadSquadState(orgId, now, { summary })`: the switches and the new `teamLabels` fact come
  from the summary. Every players' group owner gets that loader; answer and team ops the
  switches; the payment answer the payment switches and collector (`loadPaymentSnapshot`).
- `loadClubSnapshot` is deleted: `clubSnapshotOf(summary, matchId)` (pure, `pipeline/club-snapshot.ts`).
- The pool and partner asks in words read only `loadSquadMatchId` (the squad state's own match
  read and rule, one query instead of the whole state).

**Left, and why.** `loadSquadState` keeps its own 30-day match read and rule (D7), its roster in
database order (D13, C2), its active games in database order for the options answer (D12, as
A1 left `findSmallerSameSportActivity`) and the last match played with scores and teams; without a
summary (admin group, DMs) it reads the switches and team names itself until A3. The route keeps
its admin-id read (it excludes guests, the summary's roster does not, and members would cost the
roster reads), `organisersAnnounce(org)` on the row (needed before the summary is read), the raw
`org.language` reads (F9 agrees already), and the monthly reader's context, the mention names and
the squad post's match read (content and model input, not in A2's list).

**Edges named.** The summary's match window has no historical match; the old route's query did
(a historical match is a backfilled played one, never live). A failed read of the summary's games,
window or months now fails the request, where `monthNotStartedFor` caught its own failure. An
admin group `club` question, with no summary handed in until A3, reads a whole summary (5 to 8
reads) where `loadClubSnapshot` read 1 to 3.

---

## 4. Migration, in slices

Each slice is one PR, safe on its own, mergeable in this order. TDD in every slice: the
failing unit test first, then the sandbox scenario, then the code. Unit tests and the
Playwright suites make no model calls and cost nothing; the club-scenario replays make no
network calls at all.

**The proof for every Phase A slice is the club-scenario replay**: run
`npm run scenarios:replay` for all five clubs on the slice's branch and
`compare-cli.ts` against `e2e/scenarios/baseline/main`. A Phase A slice must produce
**zero cassette misses and zero transcript differences**. If it produces either, the
slice changed something it said it would not, and it goes back.

### 4.1 The slices at a glance

| slice | what | behaviour change | changes model input? | replay | size |
|---|---|---|---|---|---|
| A0 | build the summary, no consumer | none | no | free, identical | M |
| A1 | the scheduler reads it | none | no | free, identical | L |
| A2 | the analyze route and `loadSquadState` read it | none | no (must be byte-identical) | free, identical | L |
| A3 | HQ and DM handlers read it | none | no (must be byte-identical) | free, identical | M |
| A4 | web pages and actions read it | none | no | free, identical | M |
| B1 | "short" and "places open", one meaning each | yes, numbers on clubs with a minimum (the Vets) | **only if** the chase's "At risk" line moves to the minimum (decision K1) | free if K1 keeps it on places; else re-record | S |
| B2 | one month phase for every consumer | yes, monthly clubs before the list is posted | no direct change; can cascade (section 4.4) | likely free; check | M |
| B3 | one set of payment gates | yes, clubs with exactly one payment flag on (decision K2) | yes for `dm-qa` and My Payments answers in that state | re-record | M |
| B4 | one "next match" for answers and writes | edge cases only (a match stuck in the past, a cancelled future match) | in those edges only (`dm-qa` CONTEXT) | free in the five clubs | M |
| B5 | one fee | yes, what a player is told before the collector confirms (decision K3) | yes, `dm-qa`'s fee line | re-record | S |
| B6 | one "is this club served" | yes, setting-up and billing-paused clubs | edge only (`dm-reader` club list) | free in the five clubs | S |
| B7 | every door honours the switches | yes, web and DM doors of clubs with a switch off (decision K4) | fewer calls only (DM QA skipped when stats are off) | free (unused answers are not misses) | S |
| C1 | readers told a fact they lack today | yes | **yes, by design** | paid re-record | S each |
| C2 | one roster and alias order in every CONTEXT | none in meaning | **yes, ordering** | paid re-record | S |

Sizes: S is under about 150 changed lines of product code, M about 150 to 400, L above.
Tests are on top. A1 and A2 are L because of the files they touch, not because of what
changes in them.

### 4.2 Phase A: re-source, nothing changes

**A0. Build the summary, no consumer.**
- Files: new `src/lib/club-summary/{types,derive,load,scope}.ts` and their tests; the three
  guard tests (section 3.6), the source guard starting with today's full list.
- Behaviour: none. Nothing imports it yet.
- Tests (written first): one unit test per derive function, each run over the five club
  shapes of the scenario harness as fixtures (Sutton weekly with Stripe links, FNF
  organisers announce with payments off, the own-language club, ratings only with
  attendance off, the Vets monthly with £8 pay as you go and 12 to 16 players). The month
  phase gets a table test over every `SquadMonth.status`, a held key, no row, a closed
  month with a game still to play, and a month started part way. One Playwright API spec
  loads the summary for each seeded shape (no model, $0). (As built: see 3.7, item 11.)
- Model input: none.

**A1. The scheduler reads the summary.** After the concurrent scheduler PR (section 6) is
merged, not before.
- Files: `bot-scheduler.ts` (`computeDuePosts` and `computeForMatch` take the summary;
  the club row at `:564`, `getOrgFeatures` at `:963`, the month block at `:975-1085`,
  `paygPricePence` at `:1072`, the `paymentMessagesOnFor` calls at `:1049` and `:1164`),
  `due-posts/route.ts` (its preloaded months become the scope's summary),
  `deadline-summary.ts`, `unpaid-list.ts`, `team-proposal.ts:746`.
- Behaviour: none. `monthly` and `noMonthYet` are re-expressed from
  `match.month` with exactly today's mapping (running, or closed lately with only played
  games, and not before a part-way start, gives the month; an open month whose list has
  opened, or a held key, gives the sign-up shape; anything else, a priced month included,
  is `noMonthYet`; corrected in A0, see 3.7 item 6). The disagreements stay; they are now two mappings of one fact, in
  one place, which is what B2 then resolves.
- Tests: a characterisation test written FIRST on main: `computeDuePosts` over the five
  shapes at twenty instants each (the scenario clocks), keys and texts snapshotted. The
  slice must leave the snapshot untouched. Existing scheduler tests unchanged.
- Model input: none. The chase composer (`message-analyzer.ts:247-301`) keeps loading its
  own match in this slice, so its CONTEXT is untouched.

**A2. The analyze route and `loadSquadState` read the summary.**
- Files: `analyze/route.ts` (the club row at `:489`, `getOrgFeatures` at `:541` and
  `:3307`, `findRegistrationMatch` at `:1262` and `:4570-4583`, the admin ids at
  `:2076-2083`, the month check at `:2090-2098`), `pipeline/load-state.ts` (takes the
  summary; `loadClubSnapshot` is deleted), `pipeline/answer-batch.ts:911`, the engine
  batch loaders that call `loadSquadState`, `pool-ask-words.ts:84` and
  `partner-ask-words.ts:118` (which load the whole squad state for its match id only).
- Behaviour: none in any scenario. One edge changes and is named in the PR: today the
  route picks the registration match from every live match with no date floor and the
  wall clock, while `loadSquadState` looks back 30 days with the request clock. The
  summary uses one rule for both. They differ only for a live match left uncompleted for
  more than 30 days, which the completion cron prevents.
- Must be byte-identical: everything the router and the extractors are shown. The roster
  keeps today's read and today's order in this slice (ordering is C2, and the concurrent
  HQ PR, section 6).
- Tests: the existing pipeline unit tests and `e2e/sim` stubbed specs unchanged; a unit
  test that `loadSquadState(summary)` equals today's `loadSquadState` for the five shapes.
- Model input: none, proven by the replay (zero misses across all five clubs).

**A3. HQ and DM handlers read the summary.** After the concurrent HQ PR (section 6).
- Files: `admin-group.ts:163-194`, `admin-group-help.ts:102-198`,
  `admin-group-intro.ts:41-57`, `team-proposal.ts:190-200` (`commandMatch`),
  `admin-group-paste.ts:76-80`, `match-graphics.ts:70-77`,
  `hq-squad-reader.ts:54-62` (its context load), `dm-registration-target.ts:54-93`,
  `dm-reply/route.ts` (the four club-row selects, `:1133-1135`), `dm-help.ts:115-196`.
- Behaviour: none. Where a handler picks "which match" differently from the selector
  today (D7), it keeps its own rule in this slice: B4 aligns them.
- Model input: the HQ readers' CONTEXT takes its values from the summary, rendered
  exactly as today. Proven by the FNF replay (the only club with HQ traffic).

**A4. Web pages and actions read the summary.**
- Files: `api/org/settings/route.ts:76-156`, `admin/settings/page.tsx`, `pay/[matchId]`,
  `collect/[matchId]`, `month`, `month/collect`, `admin/months`, `matches/[matchId]`,
  `app/page.tsx`, `matches/page.tsx`, `actions/teams-ready.ts`, `actions/payments.ts`.
- Behaviour: none. Each page keeps its current rule, now read from the summary.
- Tests: the existing `e2e/web` specs; one new web spec per page group that renders it for
  a monthly club and a weekly club ($0).
- Model input: none.

### 4.3 Phase B: one definition per fact

Each B slice removes one disagreement from section 2.3. Each starts with a failing test
for the club shape that shows the disagreement, then a sandbox scenario step in the
harness that shows it end to end, then the change. Where the right answer is a product
choice, the slice waits for Kemal (the K decisions in section 4.5).

**B1. "Short" and "places open".** (D1, D12)
- One derive: `matchNumbers(places, fewestToPlay, confirmed)` returns `placesOpen` and
  `belowMinimum`. Every "short" gate reads `belowMinimum`; every "N places open" line
  reads `placesOpen`. "Teams one short" (`team-proposal.ts:303`) is a different fact (the
  balancer's need) and keeps its own name. One `smallerFormats` rule replaces the three
  (`load-state.ts:206-215`, `bot-scheduler.ts:191-210`, `message-analyzer.ts:280-292`).
- Files: what the concurrent scheduler PR leaves of `bot-scheduler.ts:1390`, `:2376`,
  `:2863`, `:2942`; `recruit.ts:313`; `app/page.tsx:188`, `matches/page.tsx:76`.
- Behaviour: on a club with a minimum below its places (the Vets: 12 of 14), the chases
  and the recruit DM stop calling 13 "short". The dashboard colour follows the same fact.
- Model input: the chase composer is told "N of M confirmed, K places open" and
  "At risk: yes or no" (`chase-lead.ts:122-133`). `placesOpen` is the same number as
  today. "At risk" is computed from places (`chase-risk.ts:65-77`). If K1 keeps it on
  places, no model input changes. If K1 moves it to the minimum, that line changes for
  the Vets: an LLM change (side by side, paid chase-composer check, Vets re-record).
- Tests: unit tests on `matchNumbers` and `smallerFormats`; the Vets scenario at 13 of 14
  the day before, which today chases and after this does not (if K1 says so).

**B2. One month phase.** (D2a to D2e, D5)
- The summary carries the phase, not the decision. The slice adds one pure rule next to
  it, `monthly-gates.ts`: `flowOf(squadMode, phase)` returns `"weekly"` (a weekly club),
  `"month-pending"` (monthly, phase none, held, sign-up or priced: nothing that counts the
  squad and asks for more goes out) or `"month"` (running, or closed with only played
  games left). Every consumer that today asks "is this a month's game" calls it: the scheduler's
  17:00 branches, chases, payment poll, unpaid reminder, recruit chase
  (`bot-scheduler.ts:1836`, `:1942`, `:2376`, `:2863`, `:3049`, `:3095`),
  `deadline-summary.ts`, `squad-announce.ts:75-78`, the analyze route's IN hold, and the
  seed door (`month-seed-hq.ts:74-88`, which today counts any month of the club and not
  of the fixture). The slice also picks ONE fixture key for "this game's month": today
  `monthForMatch` matches by venue and weekday and `monthNotStartedFor` by activity id
  (D5); the venue and weekday key exists because a format switch re-points the match to
  another activity, so the test for the choice is a format switch mid-month.
- Behaviour: a monthly club before its list exists (phase none or held) gets none of the
  weekly posts, in every branch, including the organisers' 17:00 branch and the
  "Squad complete" post. Running months are unchanged.
- Model input: no prompt changes and no CONTEXT template changes. A post that is no
  longer sent changes `lastBotPost` (`load-state.ts:256-260`) for the next batch; see
  section 4.4 for whether that reaches a model.
- Tests: the month-phase table from A0, extended to the gate; the Vets scenario's first
  days (before the list is posted) and the same club with the organisers announcing.

**B3. Payment gates.** (D3, D4, and the payment items of D10)
- Named facts, no new rules: `payments.messagesOn` (the outer gate), `tracking` (the poll
  and unpaid lists), `collection`, `stripeReady`, and one derive for "a card can be
  taken", replacing the four spellings (`payments-live-announce.ts:44`,
  `group-hello.ts:351`, `payments.ts:50`, `actions/payments.ts:203`).
- Every sender of a payment message, web included (`month/page.tsx:154`, `/pay`,
  `/collect`), reads `messagesOn`; narrower gates stay where they are deliberate (the poll
  needs tracking: `payment-messages.ts:20`).
- Decision K2 settles the rest: the HQ "credit a payment" command is refused unless
  tracking is on (`pipeline/engine.ts:2637`), while the outer gate is tracking or
  collection; the help's payments topic is on only with collection
  (`onboarding-conversation.ts:263`); the settings page says "Payments: off" for a
  tracking-only club (`settings-summaries.ts:98`, with the tracking switch hidden,
  `org-features-meta.ts:69`).
- Model input: yes, for a club with exactly one flag on. `dm-qa` and My Payments render
  the payment state into the DM classifier's CONTEXT (`my-payments.ts:35-44`,
  `my-payments-rules.ts:115-142`). Sutton is such a club (tracking off, collection on:
  `pipeline/engine.ts:1724-1727` says so). So B3 is an LLM change for Sutton's DM answers:
  side by side of the rendered payment block, the `dm-qa-payments-live` spec on the dev
  key, Sutton re-recorded.

**B4. One "next match" for answers and writes.** (D7)
- The registration selector (`selectRegistrationMatch`) for every place that answers or
  writes about "the next match": `dm-reply/route.ts:1278-1285`, `dm-qa.ts:181`,
  `attendance/route.ts:174-178`, `status/route.ts:23-27`, `attendance.ts:158-167`,
  `app/page.tsx:90-96`, `matches/page.tsx:39`, `matches/[matchId]/page.tsx:253-262`,
  `message-analyzer.ts:255-262` (when no match id is passed). The posting rule
  (`isNextUpcomingForPosting`) stays a separate fact, `nextForPosting`, always computed
  with the cancelled-day hold (decision K5 for the two posts that skip it today,
  `bot-scheduler.ts:2138` and `:2254`).
- Also decided here: "today" is the London day everywhere (decision K5). Today the
  selector uses UTC midnight (`registration-match-select.ts:44-48`) and the posting rule
  London (`next-upcoming-match.ts:107-115`); they differ between 00:00 and 01:00 London in
  summer.
- Behaviour: edges only: a live match stuck in the past, a cancelled future match on the
  matches page, a past-deadline match on the legacy attendance route.
- Model input: `dm-qa`'s "UPCOMING MATCH" block changes only in those edges. None of the
  five clubs reaches them, so the replay stays free, but the PR still shows the old and
  new block for the edge case and runs the DM QA live spec once.

**B5. One fee.** (D9)
- Named facts: `matchFee` (what the collector confirmed for this match), `gameFee` (the
  game's default, `Activity.feePerPlayer`), `paygPrice`. Each consumer says which it
  means. Decision K3: what a player is told before the collector confirms. Today `dm-qa`
  tells the model the game's fee (`dm-qa.ts:228`) while `/pay` says "No fee set yet"
  (`pay/[matchId]/page.tsx:133`) and the direct pay path refuses
  (`direct-payment.ts:68`).
- Model input: yes, if K3 changes `dm-qa`'s fee line. LLM change: side by side,
  `dm-qa-payments-live` once, Sutton re-recorded.

**B6. One "is this club served".** (D10)
- `lifecycle.operational` and `lifecycle.settingUp` from the existing helpers
  (`isClubOperational`, `isClubSettingUp`, `servingClubWhere`), read by the monthly
  sweeps, the deadline and unpaid sweeps, the DM club choice, the group join, leave and
  bot-added routes, and the web "Generate match" action (`actions/activities.ts:195`,
  which today skips the cron's dormant, approval, pause and season break checks).
- Model input: the DM intent classifier is shown the person's clubs and whether each is
  setting up (`dm-intent.ts:383-386`, from `dm-reader.ts:46-62`). Only a person in a
  setting-up or paused club sees a different list; none in the five clubs.

**B7. Every door honours the switches.** (D8, D11, D13)
- The web IN button and rating link (`matches/[matchId]/page.tsx:274`, `:488`) read
  `features.attendance` and `features.playerRating`; DM questions read `features.statsQa`
  as the group does (`pipeline/engine.ts:1851`); bench offer DMs read `features.bench`.
  The group hello and the HQ intro describe the club from one pure description of the
  summary, so they cannot disagree about ratings or lists.
- Decision K4 for the web IN button on a club with attendance off.
- Model input: none changes; a DM question on a club with stats off is not sent to the
  model any more, which removes calls. An unused recorded answer is not a miss.

### 4.4 Phase B and the cassettes: the cascade question

A slice that only changes a code decision can still change what a later model call is
sent, because the decision changes the database and the next CONTEXT reads the database.
Two such paths exist, and both are real:

- **The players' group.** The extractor is shown `MATCHTIME'S LAST POST` and up to eight
  lines of `RECENT CHAT` (`pipeline/extractors.ts:1550-1561`), and the last post comes
  from the chat history the Pi forwards, else the last queued group job
  (`pipeline/answer-batch.ts:1062-1066`, `load-state.ts:256-260`). So **any slice that
  adds, removes or rewords a post in the players' group changes the next extractor call
  of that club**, even though no prompt changed.
- **DMs.** Every DM classifier is shown MatchTime's last three DMs to that person from the
  last 72 hours (`reply-context.ts:479-505`). A slice that changes a DM changes the next
  DM classification of that person.

The rule per slice, then:

1. Run `npm run scenarios:replay` on the branch. A Phase A slice must show no miss at all.
2. A Phase B slice may show misses, but **only after the first step whose transcript
   changed for the reason the slice states**, and only in the club the slice names. The
   compare tool's output up to that step is the review evidence. A miss earlier than
   that, or in another club, is a bug in the slice.
3. To see the rest of that club's run, the club is re-recorded on
   `ANTHROPIC_API_KEY_DEV`. By the cassettes' own meters a full club costs between
   $0.003 and $0.013 (Vets 53 calls $0.0129, Sutton 52 calls $0.0075, FNF 38 calls
   $0.0066, own-language 25 calls $0.0037, ratings only 45 calls $0.0027; all five, 213
   calls, about $0.03). This is a data change, not a prompt change, but it is still a
   live run, so it is asked for first, with the count and cost, per the repo rules.
4. The free alternative while iterating is `npm run scenarios:dry` (stubbed model): it
   shows the decision changes with no model at all, but not what the real model then
   reads.

Per slice: B1 changes chase posts (Vets); B2 removes weekly posts before a month exists
(Vets, and the organisers' branch); B7 removes DM answers on a club with stats off. Each
of those will need its club re-recorded. B4 and B6 change nothing in the five clubs. B3
and B5 change model input directly (DM CONTEXT), so they are LLM changes in their own
right.

### 4.5 Decisions Kemal makes before the slice that needs them

| id | question | slice | today |
|---|---|---|---|
| K1 | Does the chase still ask for the 14th player when 13 is above the club's minimum? Does "At risk" mean below the minimum or below the places? | B1 | the chases count places, the day-before nudges count the minimum |
| K2 | With exactly one payment flag on, which messages go out: the HQ credit command, the help's payments topic, the settings page's "Payments" line? | B3 | three different answers |
| K3 | Before the collector confirms a fee, does MatchTime tell a player the game's usual fee, or "not set yet"? | B5 | the DM answer says the game's fee, the pay page says not set |
| K4 | On a club with attendance off, may a player still tap IN on the website? | B7 | yes on the web, no in WhatsApp |
| K5 | Is "today" the London day for the next match, and do the deadline posts and the month's list honour a cancelled match's day like the announcement does? | B4 | UTC in the selector, London in the posting rule; two posts skip the hold |

### 4.6 Phase C: readers, only where the evidence asks for it

**C1. A reader is told a fact it lacks.** Only with a reproduced failure, one reader per
PR. Example candidates found by the inventory: `dm-qa` has no squad mode, so a monthly
regular's question is answered from a weekly picture; the chase composer is not told the
minimum. Each is an LLM change: old and new CONTEXT side by side, the reader's live spec
once on `ANTHROPIC_API_KEY_DEV`, the affected clubs re-recorded, calls and cost reported.

**C2. One order for names.** `withAliases` and the 22 alias reads have no `orderBy`, and
`load-state.ts:82-88` reads the roster with none either, so the order a model sees names
in is Postgres heap order, which changes after an UPDATE. One stable order in the summary
(display name, then id) makes model input deterministic. Changing the order changes model
input for every reader at once, so it is one PR, with a full re-record. Check first what
the concurrent HQ PR already fixed (section 6).

---

## 5. Risks, limits and sizes

### 5.1 Risks

1. **A stale summary after a write.** The biggest risk. A request that writes attendance and
   then gates on `match.confirmed` from the summary built before the write would decide on
   the old count. Mitigations: counts in `MatchFacts` are documented as "before this
   request's writes"; the engine keeps deciding on `SquadState` rows as it does today;
   any code that needs a count after a write calls `scope.refresh(orgId)`; a unit test per
   writer asserts the refresh. The scheduler is safe by construction (it computes before
   it writes; the claims happen at hand-off in `due-posts`).
2. **A Phase A slice that is not quite byte-identical.** The roster order, a date label
   format or a list order can change silently when a query moves. The replay is the guard:
   any cassette miss in a Phase A slice fails the slice. The scheduler's characterisation
   snapshot (A1) and the `loadSquadState` equality test (A2) catch the rest before the
   replay.
3. **The summary grows into a rules engine.** The shape guard and the "no decision fields"
   rule (section 3.6) are the defence. Review question for every PR that touches
   `types.ts`: "can a person check this on an admin screen?" If not, it belongs in a
   consumer or a pure rule module beside the summary (`monthly-gates.ts` in B2 is the
   pattern).
4. **Cost on the hot paths.** The scheduler polls each group about every 30 seconds. The
   summary replaces reads the poll already makes, so the net should be flat or fewer
   queries; A1 measures it (queries per poll before and after, logged once in the PR on
   the five scenario clubs) and must not add any.
5. **Collisions with work in flight.** `bot-scheduler.ts` and the HQ readers are being
   changed now (section 6). A1 and A3 wait for those PRs to merge, then rebase.
6. **Edge behaviour that moves in Phase A.** One is known: the registration match window
   in the analyze route (A2). Each Phase A PR lists any such edge by name, with why no
   scenario exercises it.
7. **The two kinds of "monthly regular".** Several places infer "this player is a month's
   regular" from the attendance row's `paymentMethod === "monthly"` (`fee-waiver.ts:92`,
   `payment-claim.ts:425`, `fee-waiver-rules.ts:49`, `payment-outcome.ts:117`, and
   `unpaid-list.ts` spells it as a literal while `bot-scheduler.ts:483` uses
   `isMonthlyRow`). That is a per-row fact, correctly, and the summary does not replace
   it; B2 only makes the two spellings one helper.

### 5.2 What this refactor will not fix

- **What the model reads in the words.** A misread message stays a misread message. The
  router, the extractors and their prompts are untouched by Phase A and B.
- **Decisions that are wrong but agreed.** If every consumer agrees on a rule Kemal does
  not want, the summary makes it consistent, not right. The K decisions are where that
  surfaces.
- **The order of the HQ log and group history** (D13 in part, and the history windows of
  different lengths: 8, 6, 10 and 5 lines). Those are context design, not club facts;
  C2 and the concurrent HQ PR address ordering only.
- **Per-player and per-row facts** (who paid this match, a player's commitment for a
  month, a free place). They stay where the rows are.
- **The legacy routes the Pi no longer calls** (`attendance`, `status`, `teams`, `score`
  under `api/whatsapp`, whose callers in `whatsapp-bot/src/api.ts:41` and `:55` have no
  callers, reported). The plan aligns them in B4 only if they turn out to be live; the
  cleaner fix is deleting them, which is a separate decision.

### 5.3 Rough size

| slice | product code | tests | notes |
|---|---|---|---|
| A0 | about 450 lines, new files | about 600 lines | the derive functions are mostly calls to existing rules |
| A1 | about 150 to 250 changed lines in `bot-scheduler.ts`, 50 elsewhere | the characterisation snapshot, about 300 lines | waits for the concurrent scheduler PR |
| A2 | about 200 lines across the route, `load-state.ts` and the batch loaders | equality test, about 200 lines | |
| A3 | about 200 lines across 10 files | about 150 | waits for the concurrent HQ PR |
| A4 | about 250 lines across 12 pages and actions | one web spec per page group | |
| B1 to B7 | 40 to 200 lines each | one failing test and one scenario step per disagreement | B2 and B3 are the largest |
| C1, C2 | under 100 lines each | live spec once, re-record | LLM changes |

Phase A is about a week of agent work in five PRs; Phase B is one small PR per
disagreement, each mergeable on its own once its K decision (if any) is made.

---

## 6. The two fix PRs being built now

Neither branch is on `origin` yet, so this is planned against their stated scope.

**1. `bot-scheduler.ts`: the "short" definition, and no model call when attendance is
off.**
- Overlaps D1 (the chases at `:2863` and `:2942`, the 17:00 `need` at `:1390`) and the
  chase composer path (`composeChase`, `:1339-1356`).
- Plan: A1 starts only after it merges, and its characterisation snapshot is taken on the
  merged main, so that PR's behaviour is the baseline, not a difference. B1 then moves
  whatever "short" definition that PR settles on into `matchNumbers` and applies it to the
  sites outside the scheduler (composers, recruit, web). If that PR already settles K1,
  B1 needs no decision.
- Cassettes: skipping a model call when attendance is off removes chase-composer calls in
  the ratings-only club (45 calls recorded); unused recorded answers are not misses, so
  its replay stays free unless it also changes a post.

**2. `organiser-pick.ts`, `hq-squad-reader.ts`, `admin-group-log.ts`: the nameless label,
a stable member order, the HQ message order.**
- Overlaps D13 (order) and the HQ part of A3 (`hq-squad-reader.ts:54-62` is one of A3's
  files) and C2.
- This PR changes model input by design (member order and refs, HQ log order), so it
  re-records the FNF cassette at least. A3 rebases on it and keeps whatever order it
  chose; C2 then extends one stable order to the readers it did not touch
  (`load-state.ts` roster, `withAliases`, the monthly reader's `createdAt` order) and
  should adopt the same order rule rather than a second one.
- Nothing in Phase A touches these three files before that PR merges.
