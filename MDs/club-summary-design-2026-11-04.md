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
   into the scheduler. The text of A1 below is corrected. (Slice B2 replaces both the facts
   and the mapping with one phase, matched by the game's Activity: section 3.18.)
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
   `nextForPosting` is `{ withHold, withoutHold }` (D7, K5; one boolean since B4, 3.16); `month.regulars` counts the
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
  The match is `nextMatchId` (the same selector over every live match). The month check is
  `!month.rowForOwnActivity` (`monthNotStartedFor`'s fact). The four monthly tests read
  `squad.mode`.
- **Fail-soft** (review of #524): if the summary cannot be read, the error is logged once and the
  request runs as before A2: `findRegistrationMatch` (kept for this only), `monthNotStartedFor`
  with its own catch, and every owner reading its own switches, state, payment flags and club
  setup. A test makes the summary load throw and checks every shape and message gives the same
  response, model requests and writes. So the route stays on the source and registration
  ratchets: the fallback names `squadMode` and runs a selector of its own.
- `loadSquadState(orgId, now, { summary })`: the switches and the new `teamLabels` fact come
  from the summary. Every players' group owner gets that loader; answer and team ops the
  switches; the payment answer the payment switches and collector (`loadPaymentSnapshot`).
- The club answer: `clubSnapshotOf(summary, matchId)` (pure, `pipeline/club-snapshot.ts`).
  `loadClubSnapshot` stays for a caller with no summary (the admin group until A3, a fail-soft
  request); the characterisation checks the two agree on every shape.
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
(a historical match is a backfilled played one, never live).

### 3.10 As built in slice A3 (the admin group and the DMs read the summary's facts of the club's row)

Built on `refactor/club-summary-a3` (PR against `refactor/club-summary`). No value changes: the
characterisation (`src/lib/__tests__/hq-dm-club-summary-characterisation.test.ts`: the real
`POST /api/whatsapp/admin-group` and `POST /api/whatsapp/dm-reply` over a fake world, six club
shapes each given an admin group, fifteen HQ messages and seven DMs at one or two instants, every
model request, write and response snapshotted) was written first and green on the old code, and
the five club replays come out identical. $0: no model, no key.

**Why the row facts, not the whole summary.** Measured first: the same fake counts every read.
With the club's row and switches handed in, the whole summary still reads the games, the match
window and the last played candidates (3), the collector's name (4) and, monthly, the months and
held keys (6). An HQ message or a DM uses one or two club facts, and every one of them except
"which match", the collector's name and a match's fee is on the club's row, which both doors read
anyway: the HQ door finds the club by its group, a DM handler reaches it through the sender's
memberships. Loading the whole summary there would have put the reads of a squad question, the
teams, the poster, a paste, a score or an ask up by 1 to 3. So A3 adds the summary's facts of the
row alone (additive, `club-summary/types.ts` and `derive.ts`):

- `ClubRowFacts`: `orgId`, `name`, `language`, `lifecycle`, `groups`, `features`, `teamLabels`,
  `routine`, `squad` without `months`, `payments` without `collectionLive` and with the
  collector's id only. Built by `clubRowFacts(org, features)` from the same derive functions
  `buildClubSummary` runs; `__tests__/row-facts.test.ts` checks every field equals the whole
  summary's, for every shape.
- `src/lib/club-row-facts.ts` (outside the summary's folder): `CLUB_ROW_SELECT`
  (`CLUB_ORG_SELECT` plus `ORG_FEATURES_SELECT`) and `clubRowFactsOf(row)`, fail-soft.

**What moved.**
- `admin-group.ts`: the club is found by its group with `CLUB_ROW_SELECT` (plus
  `featurePlayerPool`) in its one query; the billing pause and the mute switch are the row
  facts' `lifecycle`; the row facts go to `understandAdminMessage` (`club`) and from there to every
  owner that read them again: the question (`admin-group-question.ts`: the squad state, the answer
  batch's switches, the payment snapshot, the club answer), the score, the squad change and the ask
  for a player (each one's squad state), the teams (`team-proposal.ts`, the announcer) and the HQ
  squad reader's team names (`hq-squad-reader.ts`). Off the source ratchet: `lib/admin-group.ts`.
- `pipeline/load-state.ts`: `loadSquadState` and `loadPaymentSnapshot` take the slice they read
  (`SquadStateClub`: a `ClubSummary` or a `ClubRowFacts`); `loadClubSnapshot` takes `club` (who
  collects, "Teams ready"), so it no longer reads the row for them. The collector's name and the
  match's fee are still read there.
- `dm-registration-target.ts` (the cold DM IN) and `dm-help.ts`: the switches from the club row
  their membership read already joins (`CLUB_ROW_SELECT`), not a read per club.

**Fail-soft.** Row facts that cannot be built are logged once ("the club summary could not be
read") and come back null; each owner then reads its own facts, as before A3. The
characterisation makes `clubRowFacts` and `loadClubSummary` throw and checks every shape, instant,
HQ message and DM gives the same response, model requests and writes (one log per HQ message, at
most one per DM handler).

**Left, and why.**
- "Which match": `commandMatch` (`team-proposal.ts`), `nextGraphicMatch` (`match-graphics.ts`), the
  paste's `registrationMatch` (`admin-group-paste.ts`) and the DM target's selector. Each needs the
  summary's match window (3 reads or more) to replace one or two of its own; they already run the
  same selector over the same live matches (the summary's window only drops historical matches,
  as A2 named). B4 is where "which match" becomes one fact.
- The HQ squad reader's members, aliases, squad and teams: content and model input. The summary's
  roster costs five to seven reads, and its aliases are sorted where the reader shows them in the
  database's order (a change of model input, C2).
- The HQ introduction (`admin-group-intro.ts`): sent once per link, two reads; its row read is the
  same one read either way and the weekdays need the games.
- `hqHelpGates` and the HQ pipeline's own row reads (`admin-group-help.ts`,
  `admin-group-understand.ts`): they read the row the door read with the summary's select;
  renaming their inputs to the facts would save no read, so both stay on the ratchet.
- `dm-reply/route.ts`: one-column reads (the club's name for the bench offer and the tentative
  follow-up, the collector's club, the language for the recruit and partner replies). No club row
  is at hand there, and the whole summary would cost more than each.
- `loadClubSummary` is therefore not called on the HQ or DM paths at all.

### 3.11 As built in slice A4 (the web pages and actions read the same row facts)

Built on `refactor/club-summary-a4` (PR against `refactor/club-summary`, rebased onto A3). No value
changes: the web characterisation (`src/app/__tests__/web-club-summary-characterisation.test.ts`:
the pay, collect, month, month collect, admin months and match pages, `GET /api/org/settings`,
`getTeamsReady` and `requireMatchCollectorOrAdmin`, over nine club shapes (the five fixtures, Sutton
in Turkish, and three variants that switch on what the five leave off), as the organiser, a player
and the collector, the HTML, JSON, redirect or 404 of each load snapshotted) was written first and
green on the old pages, on A2 and again on A3, and the slice leaves it untouched. $0: no model, no
key.

**One type for every door.** For the same reason as A3 (3.10), measured on the pages: each keeps its
own match rule in Phase A (D7: the dashboard's instant, the match list's no-status filter, the match
page's in-flight block), so the whole summary would add four to seven reads per load for games,
matches and months no page uses. So the web pages read A3's `ClubRowFacts`, from the club row each
already reads (`CLUB_ROW_SELECT` rides on its match or membership query). A4 was built in parallel
with its own near-identical type; on review the two were made one, A3's name and shape kept, and
the web's two extra facts of the row added to it (additive, every A3 caller and its snapshot
unchanged):
- `payments.switches`: the pay method switches as stored (`methods` is what a player can use);
  the settings page shows the switches, and `/pay` feeds them to `availablePayMethods`.
- `routine.teamsReadyChosen`: an organiser has set Teams ready (`getTeamsReady`'s "default").

`__tests__/row-facts.test.ts` is the one equality test for both slices: every field equals the
whole summary's for every shape, and the two extras are the row's columns. `club-row-facts.ts`
gains `loadClubRowFacts(orgId, where)`: the same facts in one read, for a server action given only
the club's id (`getTeamsReady`), fail-soft like `clubRowFactsOf`.

**What moved.**
- `/pay/[matchId]`: the collector, the pay method switches and charges (into
  `availablePayMethods`), the instructions and squad mode (into `directPayInstructions`).
- `/collect/[matchId]` and `requireMatchCollectorOrAdmin`: the collector; the club's team names.
- `/month`: the monthly gate, the collector, the instructions. `/month/collect`, `/admin/months`:
  the monthly gate.
- `/matches/[matchId]`: the team names, the MoM chooser, collection and the collector (the payments
  link), the rolling squad (carry over), the bench pick mode (organiser picks), the squad mode (the
  month's list). Its second club read (`orgPay`) is gone: those columns ride on the match query.
- `GET /api/org/settings`: every club fact it returns (the switches, payment flags and pay method
  switches, the players' group, the mute switch, Stripe, the collector, the weekly routine, the
  monthly squad settings, the team names), through `settingsFactsOf`, same keys and order.
- `getTeamsReady`: `routine.teamsReady`, `teamsReadyChosen`, `groups.hq.groupId`, `squad.mode`, in
  one read (`loadClubRowFacts`).

**Fail-soft.** If the facts cannot be built or read, one log line ("the club summary could not be
read") for that build and the page runs today's reads of the same row (each page keeps them side
by side with the new source, so Phase B deletes one side). A test makes `clubRowFacts` throw for
every shape, viewer and load and checks the same output and one log line per attempt (the collect
page makes two: the page and the collector check). Two existing tests (`api-privacy`,
`teams-ready`) handed in a partial club row, which sent them down the fallback; they now hand in a
whole row. (A probe that turns the fallback into a throw found one more, outside A4:
`club-billing-replies.test.ts` reaches the admin group with a partial row.)

**Left, and why.**
- `app/page.tsx` (dashboard) and `matches/page.tsx`: their only club facts are the name and the
  language; their next match and the "low" colour are their own rules (D7, D1), which Phase A keeps.
- `admin/settings/page.tsx`: a client component with no reads; its facts come from the settings
  route and the server actions.
- The language and the club's name stay raw reads of the row on every page (F9 agrees, as A2 left
  them); `nameEditable` (`approvalStatus === "draft"`: the summary has no draft predicate), billing on
  `/admin/months`, `featurePlayerPool` on the match page, and `/month`'s list of the player's other
  monthly clubs (a filter over other clubs) are not summary facts.
- `payByMethod`'s guards read `resolvePayContext`'s row (direct-payment.ts, shared with the DM "Paid"
  path); the Connect actions read `stripeConnectAccountId` to call Stripe and write.
- `admin/layout.tsx`'s Months link: the same monthly gate as `/admin/months`, but not on A4's list.
- Every disagreement stays (Phase A): `/month` offers "I've paid" with both payment flags off and
  `/pay` reads neither (D3), the pay page's "No fee set yet" against the DM's game fee (D9, K3), the
  web IN with attendance off (D8, K4).
- The source ratchet does not tighten: every A4 file keeps today's read as its fallback, so it still
  names the columns (as A2's route).

**Reads per page load** (the fake world, real code paths, as the organiser): the match page one
fewer for every shape (Sutton 12 to 11 and 17 to 16, FNF 17 to 16, the Vets 15 to 14 and 17 to 16,
ratings only 14 to 13, muted 17 to 16); every other page the same (pay 3 to 4, collect 2 to 4, month
2 weekly or 8 monthly, month collect 2 or 21, admin months 4 or 20, settings 6, Teams ready 3).

### 3.12 As built in slice B3 (one payments rule on every door)

Built on `refactor/club-summary-b3` (PR against `refactor/club-summary`). Decision K2 (Kemal,
2026-11-04, the main session's recommendation): ONE rule for "payments are on for this club", the
existing `paymentMessagesOn` (tracking OR collection), which the summary exposes as
`payments.messagesOn`; every door follows it the same way. Narrower gates stay where they are
deliberate and name the rail they need: the poll path still needs tracking (`poll-vote`, the unpaid
group reminder), pay links, fee asks and pay chases still need collection, and a match's "does
MatchTime know who paid" (`matchHasPaymentSource`) is still the poll or released links.

**The doors (D3), each with a failing test first.**
- The credit command ("@Match Time Amir paid for 4"): `pipeline/engine.ts` and
  `admin-ops-engine-batch.ts` refused it unless TRACKING was on; both now read
  `paymentMessagesOnFor(state.features)`, and `SquadState.features` carries `paymentCollection`
  (from the summary's switches). So Sutton FC (collection on, tracking off) can credit. It is still
  an admin's alone, read in the players' group; HQ still answers "not done from HQ" (unchanged).
- The help's payments topic (players' group, HQ and DMs, one builder): on only with COLLECTION; now
  on by the rule. A club on the old poll alone gets its own explainer (`onbHelpPaymentsTracking`,
  EN and TR: the poll, the unnamed count, "who still owes"), never naming the hidden setting; an
  organiser's "help payments" also says how to record a payment made for others
  (`onbHelpPaymentsCreditOrganiser`). The bare help lists payments for such a club, labelled
  "payments" ("ödemeler"), as the settings card and the explainer call it, by one label builder
  (`paymentsByPollOnly`, used for the explainer and both topic lists; review of #528). A club that
  collects, or has payments off, keeps "match fees".
- The settings page's Payments line: "Not collecting match fees" whenever collection was off; now
  off only by the rule, and a poll-only club reads "Keeping track of who has paid" (TR "Kimin
  ödediği takip ediliyor"). The tracking switch stays hidden (2026-10-16); see below.
- `/month`: offered "I've paid" (and `sayMonthPaid` recorded it) with both flags off, and showed what
  a regular owes, the pay-by line, the instructions and the paid state. With payments off the page
  now says nothing about payments (the money block is gone, `facts.payments.messagesOn`, the row as
  fallback) and the action records nothing; the month itself (the list, the games, the days away)
  stays. Review of #528: the amount and the pay-by line follow the button.
- `/pay`: read neither flag; with payments off it now says "Nothing to pay here" (EN and TR) and
  shows no method, and `resolvePayContext` refuses every pay action with `PAYMENTS_OFF_REASON` (the
  "Paid" DM never reaches it with them off: it reads only matches of a club that collects).
- `/collect`: with payments off the "send the fee to release the pay links" hint is replaced by
  "Payments are off for this club" (EN and TR). The match page's "Payments · who's paid" link: shown
  with collection only, now by the rule (a poll-only club sees who ticked).
- The monthly paid-claim DM reader (`handlePlayerPaidDm`): the model was asked first and the gate
  read after; the gate now runs BEFORE the model, so with payments off no model is called, nothing
  is recorded, and the DM goes on to the next handler as any DM does.
- DM payment answers (`decideMyPayments`, `loadMyPayments`), the group's "who has not paid"
  (`decidePaymentSnapshot`), the free place (`fee-waiver.ts`, `hqHelpGates`), the friend link and
  pool offer fees: each restated the rule inline; each now calls it. No value changes.

**"A card can be taken" (D4), one rule.** `isPaymentCollectionLive` (collection on, a connected
account, charges enabled) moved into the pure `payments.ts` (re-exported by
`payments-live-announce.ts`), so the summary's `collectionLive` is derived (`paymentFacts`), not
handed in by the loader, and `ClubRowFacts` carries it. `availablePayMethods` offers card and Pay by
Bank on it (it read `stripeChargesEnabled` alone), the group hello calls it (it restated it), and the
pay action checks it (it read the account and charges). `PAY_METHOD_SELECT` gained
`paymentCollectionEnabled` and `stripeConnectAccountId`. In production charges imply an account
(both are cleared together), so the only club that moves is one with collection OFF and a Stripe
account left over: no card or bank button on `/pay` (it has payments off or the poll only, so no
pay link is ever sent to it). The e2e seed had charges enabled with no account; it now has a
placeholder account (STRIPE_SECRET_KEY stays unset in e2e). The method labels are unchanged.

**A guard.** `__tests__/payments-one-rule.test.ts` fails on a file that combines the two payment
flags, or the account and charges, outside `payment-messages.ts` and `payments.ts` (one named
narrower rule, `matchHasPaymentSource`, is listed with its reason).

**Model input: none changes.** The DM question answerer's YOUR PAYMENTS block already followed the
rule (an inline OR), and its ways to pay are unchanged for every shape (Sutton has an account);
`__tests__/my-payments-one-flag.test.ts` pinned the block for collection only (EN and TR dates),
tracking only and both off, and the group's payment answer for the same three, FIRST on the old code,
and it is unchanged. The help and the pay pages are fixed copy, not model input. The monthly claim
reader makes FEWER calls (none with payments off). No scenario club has exactly one flag on (the
sandbox Sutton has both), and no scenario step asks for help or says "paid" by DM on a payments-off
club, so the five replays run with 0 misses and the transcripts are identical to `baseline/main`
(`scenarios:compare`: all five "identical"; no new cassette, no `baseline/b3`). FNF's replay matched
two team-balancer requests by the loose key ("reordered": the same lines in another order, the row
order of D13, the same site `baseline/main-before-519-520` shows five times); B3 sends the balancer
nothing new. $0: no model, no key.

**Characterisation snapshots updated, only for B3** (every entry):
- A2 `loadSquadState` (10 entries, every shape and instant): the new `features.paymentCollection`
  (true for Sutton and Sutton in Turkish, false elsewhere). No model request, write or reply moved.
- A3 `dm-reply: muted` (the tracking-only shape): the organiser's bare help lists payments and no
  longer calls it switched off.
- A4 `pay > fnf`, `pay > ratings`, `pay > vets` (both flags off): every `/pay` load says "Nothing to
  pay here" and every `/collect` load shows the payments-off notice; `match > muted`,
  `match > vets-instr` (tracking on): the "Payments · who's paid" link.
- The copy golden (EN, TR) and the Turkish onboarding review: "help payments" for a club with
  tracking only, and the bare help's topic list (the payments line, then its label "payments"
  after the review of #528; A3 `dm-reply: muted` the same label line). `help-before-organisers.json`: the two all-on
  organiser "help payments" entries (EN, TR) gain the credit line.
- A1 (scheduler) and the club-summary tests: unchanged, except the summary fixtures no longer hand in
  `collectionLive`.

**Left, and why.**
- The credit command is still not done from HQ ("not done from HQ"), as before B3.

**Open items.**
- The tracking switch stays hidden on the settings page, as decided on 2026-10-16 (the main
  session's review of #528 keeps it). So a poll-only club reads "Keeping track of who has paid" with
  no switch on the page to turn it off; it would need the ⓘ entry and a change to that decision.

### 3.13 As built in slice B1 ("short" and "places open", one meaning each)

Built on `refactor/club-summary-b1` (PR against `refactor/club-summary`), after Kemal's decision
K1 (section 4.5). This is a Phase B slice: it changes behaviour on purpose, and it changes what
the chase composer is sent, so it is an LLM change under the repo rules.

**One definition.** `squad-short.ts` holds both facts and nothing else computes them:
- `placesOpen(places, confirmed)`: the places not yet taken, never negative;
- `squadNumbers({ places, confirmed, minPlayers, playersPerTeam })`: `placesOpen`, `shortBelow`
  and `short` (below the game's minimum, else two full sides of its format, #519's rule). The
  summary's `matchNumbers` IS this function now; `squadNumbersAt` takes a threshold already read
  (the composer, handed it by the scheduler) and `matchSquadNumbers` a match row with its game
  (the two web pages, which keep their own match query as A4 left them).

Every "places open" in the code calls `placesOpen` (the scheduler's `need`, the four reply
composers in `pipeline/compose.ts`, the squad post and the reply guard in `group-copy.ts`, the
rolling and list-published tails, the pick hint, the unnamed-guest ask, the recruit DM, the
deadline summary, "Squad complete", the engine's free-place test, the monthly week, its asks and
its list, the rolling seed, the organiser pick, the HQ group ask, the admin list header in both
languages, and `/api/whatsapp/status`). The one-derive guard's `places` pattern now also catches
`Math.max(0, <x>.maxPlayers - ...)`, and its list is down to the definition's own comment and the
monthly seed's allocation (places less the regulars already in and the players it keeps, which
is not "places open").

**K1 as code.**
- (a) The players' chases still ask while a place is open. Their wording follows `short`: below
  the minimum, today's copy ("8 short", "need 8 more"); at or above it, new copy that says the
  places left ("6 places left", "1 place left"; Turkish "6 kişilik yer kaldı"), for the 17:00
  update, the match-day morning, the 3 to 4 hour and the last call, in the fixed lines and in
  what the model is told.
- (b) `computeChaseRisk` needs `short`: at or above the minimum nothing is at risk, so the model is
  told "At risk: no" and never writes "we'll have to call it off". The format-switch line on the chase
  ("If we don't find 6 more, we could switch to...") is added only while the squad is short.
- (c) The web's squad bar (dashboard and match list) was blue from 75% of the places, a third
  "low" (D1). It is now green when full, blue when the game is on, amber while it is short. For
  a club with no minimum that makes 11 to 13 of 14 amber where it was blue.
- The recruit chase-up DM's gate was called `squadShort` and meant "a place is open"; it is
  `placeOpen` now, with the same value.

No word check on the model's line: the CONTEXT facts and the prompt carry K1 (review of #529;
the analyzer redesign of 2026-08-31 removed that kind of correction layer). If a deterministic net
is ever wanted, it should be structural, not text matching: the model writes only the ask and
code renders the numbers sentence ("6 places left" or "8 short", and the call-off line only
when at risk) from the facts, as it already renders the squad list. Not built.

**What the composer is sent.** One new fact line, `Enough to play: yes|no`, between the squad and
"At risk". The system prompt was rewritten as a whole: a "Where the squad stands" block states
the two squad facts and the at-risk rule once, and the examples are grouped by what they teach
(not enough to play, enough to play), English and Turkish side by side. 2,871 characters before,
3,730 after (about 1,100 to 1,430 tokens), above the cache floor. The old and new prompt and
facts, side by side for a 12 of 18 game with a minimum of 12 and a 10 of 18 one, are in the PR.

**Left, and why.**
- D12 (`smallerFormats`, three rules): not part of "short" or "places open", and moving it
  changes the 10:00 switch offer's tie-break by row order (A1 named it). A slice of its own.
- "Teams one short" (`team-proposal.ts`) is the balancer's need, a different fact (plan 4.3).
- The "is the squad full" tests (`confirmed >= maxPlayers` in the attendance writers, the
  organiser pick, the bench upgrade, the tentative follow-up) are capacity checks inside writes,
  not counts of places open; they stay.
- The players' group answers ("how many are we?", the options answer) still say "need N more";
  K1 is about the chases.
- The 18:00 "Match in trouble" offer keeps `fewestAnyFormat` (the lowest minimum of any format of
  the sport), D1's third meaning, deliberately: it asks whether the game can be played at all.

**Proof.** Paid, all on `ANTHROPIC_API_KEY_DEV`, about 124 calls and $0.023 in all (including
a second pass of the live script after the review removed the word check: 16 of 16, 16 calls,
$0.0018):
`scripts/chase-at-risk-live.ts` (the 12 scenarios plus 4 at or above a minimum, English and
Turkish) 16 of 16, 16 calls, $0.0022; `e2e/sim/chase-composer-live.spec.ts` (the real scheduler
route, plus two K1 cases, both languages) 8 of 8, 8 calls, $0.0010 (its roster check still expected
the list the chase stopped using on 2026-10-20, fixed here). The club replay was run free first:
FNF, the Vets and ratings-only came out identical to `baseline/main`, because none of them sends a
players' chase at or above its minimum in its scripted week (FNF's organisers announce, the Vets are
monthly); Sutton and the Turkish club missed only their chase-composer calls, so only those two were
re-recorded (77 calls, $0.0169). `baseline/b1` is the replay of all five on the new cassettes (zero
misses); against `baseline/main` the only differences are seven chase posts of those two clubs, all
below the minimum, which the model words differently with the same meaning, and their text-log
rows. Unit tests: the A1 to A4 characterisations are unchanged; the golden copy gained five entries
per language (the "places left" lines) and changed none.

### 3.14 As built in slice B5 (one fee)

Built on `refactor/club-summary-b5` (PR against `refactor/club-summary`), after Kemal's decision
K3 (section 4.5). A Phase B slice: it changes what players are told on purpose, and it changes
what the DM answerer is sent, so it is an LLM change under the repo rules.

**One definition.** `fee-fact.ts` (pure) is the only rule for "the fee a player is told":
`feeFact({ matchFee, gameFee, splitTotal, paygPence, collection })` returns `amount`, `source`
(`match`, `payg` or `game`), `confirmed`, `notConfirmedYet` and `splitTotal`.
- `matchFee` (`Match.feePerPlayer`) is what the collector confirmed; it always wins and is the
  only `confirmed` fee. `chargeableFee` returns it and nothing else.
- Otherwise the usual fee: the club's PAYG price in a week of a running month (the amount
  `stagePaygFee` asks the collector to confirm), else the game's fee unless the game splits the
  total (a split game has no per-player amount until the collector enters the total).
- `notConfirmedYet` is the usual fee of a club that collects (`collectsMatchFees`, a new named
  helper in `payment-messages.ts`): only there does a collector confirm each match's fee. A
  club that does not collect has no confirmation step, so its usual fee is stated as it is.
The summary's `MatchFacts.fee.forPlayers` is this fact (the PAYG price when the match's
`month` is running and the kickoff is not before its start, `loadMonthlyWeek`'s rule), and
`ClubSnapshot.fee` is it too. `guestFeePounds` (the guest doors' rule) is deleted.

**The doors (D9), each with a failing test first.**
- The DM answer (`dm-qa.ts`, `my-payments.ts`, `my-payments-rules.ts`): it told the model
  "Usual match fee: £6 per player" from `match ?? game`, confirmed or not, and a split game's
  total as a per-player fee. It now sends the fact (model input, below).
- The club answer in the players' group and HQ (`answer_club`, from `clubSnapshotOf` or
  `loadClubSnapshot`): "Match fee: £6 a player" whatever its source. Now "usually £6 a player,
  not confirmed yet" before the collector confirms, "£8 a player (pay as you go)" for a month's
  game, "the pitch cost split between who played" for a split game (it said the total as a
  per-player fee before). `loadClubSnapshot` reads the PAYG price only for a monthly club with
  no confirmed fee, so the two sources agree (the A2 characterisation checks it).
- The pay page: "No fee set yet" whenever the match had no fee. Now, with a usual fee, "Fee not
  confirmed yet ... The usual fee for X is £6 a player, but Kemal hasn't confirmed this match's
  fee yet. You can pay here once it's confirmed", with no pay buttons; with no fee at all, the
  old text (now in the string table, EN and TR). Charging is unchanged: the buttons, the direct
  pay path (`direct-payment.ts`) and pay links read only the match's confirmed fee.
- The pool offer and the placed DM, the friend link DM and page, the partner ask: the same
  fact; a usual fee of a club that collects reads "usually £6, not confirmed yet" (EN and TR, one
  string per template so each sentence still reads).
- Help: the "help payments" explainer for a club that collects gains one line (EN, TR: ask the
  fee before it is confirmed and you get the usual one, marked; nobody is asked to pay until it
  is); the web guide says the same on `/help/player` (Paying) and `/help/admin` (Payments).

**What the DM answerer is sent.** One CONTEXT line in YOUR PAYMENTS, rewritten in place, and the
system prompt's money bullet, rewritten in place after the first paid run (the model added the
unconfirmed fee to answers about something else; the bullet now names the upcoming fee once and
says it is given when asked, as YOUR PAYMENTS states it, confirmed or not; 2,805 to 3,022
characters). Before: `- Usual match fee: £6 per player`. After, by state:
`- Upcoming match's fee: £7 per player, confirmed by the money collector.`;
`- Upcoming match's fee: not confirmed yet. The usual fee is £6 per player; the money collector
confirms it after the game.`; the PAYG variant ("£8 per player, the pay as you go price
(regulars pay for the month instead)"); a split game ("the pitch cost split between who
played; the money collector sets it after the game."). The line is shown, as before, only for a
club that collects. The side by side page is in the PR.

**A guard.** `src/lib/__tests__/fee-one-rule.test.ts` fails on a file that falls back from one
fee to another inline outside `fee-fact.ts` (`feePerPlayer ?? ...feePerPlayer`, `matchFee ??`,
`match fee else PAYG`), with one named narrower rule (`month-close.ts`: the month's close lists
what each PAYG player owes, a summary for the collector, not a charge), and checks that each
door imports the rule.

**Left, and why.**
- The club's own PAYG lines in a monthly week (the PAYG pool DMs and group line, "£8. Say IN to
  take one", `bot-scheduler.ts` section 3) state the club's PAYG price as its price list. No
  club that runs a monthly squad collects through MatchTime today (the Vets have payments off),
  so they and the pool offer cannot disagree in production; if one ever does, those lines are
  the next to read `feeFact`.
- The collector's own fee question and confirm (`bot-scheduler.ts`, `payment-flow.ts`) are the
  confirmation itself, not a door that tells a player.
- A fee pending the collector's yes (`feePendingConfirm`) is not told to players: it is what the
  collector typed, not yet confirmed.
- `/collect` is the collector's page and shows the match's fee as set.
- The pay page reads the PAYG price only for a club that collects (as the DM answer does); a
  monthly club on the old poll alone would see the game's usual fee there. No such club exists.

**Proof.** Paid, all on `ANTHROPIC_API_KEY_DEV`, 103 calls, about $0.023:
`e2e/sim/dm-qa-payments-live.spec.ts` with the CONTEXT change alone (26 calls, $0.0047): the fee
answer was right, but the unconfirmed fee was added to unrelated answers, hence the bullet rewrite;
the same spec after it (38 calls, $0.0067) 8 of 8 in English and Turkish, the fee given only when
asked ("The fee for Fri 6 Nov at 20:00 isn't confirmed yet. The usual fee is £8 per player").
Its "how do I pay?" case is routed to the payments help topic by the DM reader, on the base branch
too (checked, 8 calls, $0.0007), so it is not B5's and was left out of the second run.
`scripts/dryrun-dm-qa.ts` on Haiku, once per set (main TR and EN, s3, pay; 23 calls, $0.0093): all
clean. `e2e/sim/dm-context-live.spec.ts` 3 of 3 (8 calls, $0.0013). The club replay is free: all
five clubs hit every cassette (0 misses), so nothing was re-recorded; `baseline/b5` against
`baseline/b1` is identical for all five, because no scripted week asks the fee, sends a guest
offer or opens the pay page before a fee is confirmed. Unit tests: the A2 to A4
characterisations changed only on the fee line (listed in the PR), A1 is unchanged; the copy golden
gained seven B5 cases per language and changed none.

Rebased onto B7 (#532): `dm-qa.ts` merged cleanly (B7's stats-off facts and B5's fee line and
money bullet both kept). `dm-qa-payments-live` once on the merged code: 10 of 10 (B7's stats-off
case included), 48 calls, $0.0075. `baseline/b5` re-made on the merged code: 0 misses, identical
to `baseline/b7` for all five clubs. The A3 DM entries also pin the prompt's hash, which the
money bullet changes (8 entries, `43b0f38b` to `3f26110c`).

### 3.15 As built in slice B7 (every door honours the switches)

Built on `refactor/club-summary-b7` (PR against `refactor/club-summary`), after Kemal's decision
K4 (section 4.5). Phase B: it changes behaviour on purpose, and one model input (the DM answer's
CONTEXT for a club with stats answers off), so that part is an LLM change.

**The principle (K4, Kemal 2026-11-04, the main session's recommendation).** What WhatsApp refuses
with a switch off, the website and the DMs refuse too, with one short plain line. Where a switch's
own settings card (ⓘ) says on purpose that another door keeps working, that card is the decision
and B7 leaves it (below, "Left").

**The inventory.** Three read-only passes over every switch and every door (players' group, HQ,
DMs, web pages and actions, scheduled jobs). The players' group is the reference: it refuses IN and
OUT with attendance off (`engine.ts`, `attendance-engine-batch.ts`), a stats question with stats
answers off, a build with team generation off, a reminder with reminders off, all silently.

**Doors changed, each with a failing test first** (`src/lib/__tests__/switches-every-door.test.ts`,
`src/app/__tests__/switches-every-door-web.test.ts`, `match-completion-conditional.test.ts`; each
red on the old code, then green):

| switch | door | before | after |
|---|---|---|---|
| attendance (K4) | the match page | "I'm in!" on every upcoming match | no button; one line: "<club> doesn't take sign-ups through MatchTime, so there's no IN or OUT for this game here." (EN and TR, `web_attendance_off`) |
| attendance (K4) | `attendMatch`, `dropFromMatch` | wrote the row | refuse with the same line, write nothing |
| attendance | the tentative follow-up DM ("can you play?") | unclassified, sent with attendance off | dropped by the scheduler's gate |
| bench | the bench offer's DM to each bencher | its key (`offer-<id>:dm:<user>`) matched no feature, so it went out with bench off (D8) | dropped by the scheduler's gate, like the group post |
| player ratings | the match page | rate button with ratings off | no rate button |
| player ratings | the rate page, `submitRatings`, the MoM vote cast there | took ratings and votes | "<club> doesn't use player ratings in MatchTime, so there's nothing to rate here." (EN and TR, `web_ratings_off`); both actions save nothing, even from a link sent before |
| player ratings | the "rate your teammates" email (match completion, first score) | sent | not sent |
| stats answers | a DM question (`dm-qa.ts`) | answered from the player's stats and the club's results | no stats and no history are loaded; the CONTEXT says they are switched off, and the answer says so (below) |
| (D11) | the HQ introduction | ratings claimed whenever the switch was on; "I keep track of IN and OUT" for a weekly club with a pasted squad | one pure description, `club-description.ts` (`describeClub`), read by the hello and the introduction: ratings only when the rating DMs reach someone (attendance or a pasted squad), the players' MoM only with ratings, IN and OUT only when MatchTime reads them |

The scheduler's extra gate is `gateFeatureOfKey` (`due-key-feature.ts`), read by `featureGateAllows`.
It is deliberately not part of `featureForDueKey`: `topicOfDueKey` reads that, and the topic is
what a DM classifier is shown about a past message (`reply-context.ts`), so classifying the two keys
there would have changed model input. A test pins that the topics are unchanged.

**What the DM answer is sent (LLM change).** The system prompt is not changed. For a club with
stats answers off only, the CONTEXT drops YOUR STATS and the Recent History block and gains one line:
"STATS AND RESULTS: switched off by this club's organisers. For this club MatchTime gives no stats,
ratings, form, match results, scores, Man of the Match winners or leaderboards, and when asked for
one it tells the player the organisers have switched them off." For every other club the CONTEXT is
byte for byte the same (unit test; no scenario club has stats answers off). The line was reworded
twice in the paid check: the first wording gave a correct but vague "I can't share that" to two
Turkish questions. Old and new, with the answers: the PR's side-by-side page.

**Proof.** Paid, all on `ANTHROPIC_API_KEY_DEV`, 76 calls, about $0.013:
`scripts/dryrun-dm-qa.ts SET=statsoff` (new set: stats, MoM, results and the match, EN and TR), 20
calls over three wordings, $0.0041, final wording 8 of 8 with nothing leaked;
`e2e/sim/dm-qa-payments-live.spec.ts` (the real dm-reply route, plus a new stats-off case per
language) 26 + 10 + 10 + 10 calls, $0.0093: the new case 2 of 2, "has Riley paid?" 2 of 2, the
money cases 4 of 4, and "how do I pay?" failed in both languages because the help reader took it
(`handled: "dm-help"`) before the DM answer; B7 changes no file on that path and its cause is not
traced here. The five club replays: free, 0 misses, and the transcripts are identical to
`baseline/b1` (`baseline/b7`); section 4.4's expected re-record does not arise, because no scenario
club has stats answers off, no scripted step taps IN on the website, and the ratings-only club
rates with its ratings on. Characterisation: A4 `match > ratings` (attendance off) is the one changed
entry, the IN button replaced by the line; A1, A2 and A3 unchanged. The golden copy gained the two
new lines per language and changed none. One existing test changed on purpose:
`admin-group-intro.test.ts` (FNF with ratings off and the players voting no longer claims Man of the
Match in HQ, as the hello already did not).

**Left, and why.**
- **Team generation off.** Its settings card says on purpose that "the Generate teams button on a
  match page on the website still works", and that Teams ready (the HQ proposal) is a separate
  setting. So the web button, the teams page and the HQ team commands still build teams with the
  switch off. If K4's principle should reach them too, that is Kemal's call (K6, below).
- **Man of the Match off.** Its card says "Players can still vote on the rating page, and the votes
  still count in stats and badges." Kept: the vote is closed only with ratings off.
- **Reminders.** The players' group is the only door that takes one and it checks the switch; a
  reminder queued before the switch was turned off still sends (a plain BotJob, nothing marks it as
  a reminder).
- **Writes that build a squad of record** with attendance off: an organiser adding a player on the
  web, the HQ pasted list, a pasted list in the players' group, the rolling squad's seeding. Ratings
  and MoM go to the match's squad, so these are how an attendance-off club gets one (the attendance
  card says so). The legacy `/api/whatsapp/attendance` route, which the Pi no longer calls, is left
  for the cleanup in 5.2.
- **The players' group answering results and rating progress with stats answers off**: that is the
  reference door itself, not a door that disagrees with it.
- **Mute, billing pause and dormancy** on DM handlers, the web pool and partner asks and the
  platform's pool DMs: "is this club served" is B6.
- **Pool and partner switches**: every door the inventory found goes through the one rule of each
  (`poolOffersOpenForClub`, `canAsk`); nothing to align switch-wise.
- **Order of names (D13)**: C2.

### 3.16 As built in slice B4 (one "next match", one "today")

Built on `refactor/club-summary-b4` (PR against `refactor/club-summary`), after Kemal's decision
K5 (section 4.5). Phase B: it changes behaviour on purpose, in edges, and in one edge it changes
which match the DM answerer is told about, so that part is an LLM change.

**K5 (Kemal, 2026-11-04, the main session's recommendation).** "Today" is always the London day.
Every post that holds on a cancelled match's day (the announcement already did) does the same:
the deadline posts and the month's list included. Where consumers genuinely ask different
questions, each question is its own named fact, defined once; they are not forced into one.

**Three questions, three facts.**

| fact | the question | the rule, defined once | read by a door with no summary through |
|---|---|---|---|
| `ClubSummary.nextMatchId` | the club's next match: where an IN lands, and what every answer, write and page about "the next match" means | `selectRegistrationMatch` over every live match, never a historical one: the soonest dated on the London day of the clock or later, none while a live match dated before that day is still in flight | `next-match.ts`: `nextMatchWhere` (the candidates), `findNextMatch`, `findNextMatchPerClub`, `inFlightWhere` (the block as a query), `upcomingMatchesWhere` (the match list) |
| `MatchFacts.nextForPosting` | is this the fixture's next match to post about | `isNextUpcomingForPosting`, the cancelled-day hold always on: the clock is a required argument now, so no post can skip the hold | `postingMatchWhere` (scheduler-windows.ts): the matches the rule reads, the live ones and the cancelled ones whose day may still hold |
| `ClubSummary.lastPlayedMatchId` | the last match played | unchanged (A0) | unchanged |

`nextForPosting` was `{ withHold, withoutHold }` (A0 kept both of today's values); it is one
boolean now, and in the scheduler it is computed once per match (`computeForMatch`) and read by
all five posts there.

**"Today" (K5).** `londonDayStart` (london-time.ts) is 00:00 London on the day an instant falls
on. The selector and `eligibleRegistrationMatch` used UTC midnight; the in-flight block in
`registerAttendance` and on the match page used UTC midnight too; the daily caps' `londonMidnight`
(club-connect-rules.ts) is now the same function. In winter nothing changes (London midnight is UTC
midnight). In summer two things move, both pinned by tests at 00:30 BST: from London midnight, last
night's match that is still live is yesterday's, so it blocks registering for the next one (before
B4 it was "today's match" until 01:00); and a match kicking off between 00:00 and 01:00 London is
that London day's match all day (before B4 it counted as the day before, so it blocked itself).

**The posts (K5), each with a failing test first.**

| post | before | after |
|---|---|---|
| the drop-out reminder, the published list (`bot-scheduler.ts`) | `isNextUpcomingForPosting(siblingMatches, m)`: no clock, no cancelled matches, never held | `nextForPosting`: held on a cancelled game's day; a reminder whose window closes inside the hold is not sent, the list goes out the next morning |
| the month's list (`bot-scheduler.ts`, 2-monthly) | the same, never held | held, posted the next morning |
| the admin deadline summary (`deadline-summary.ts`) | read live matches only, no clock | `postingMatchWhere` plus the clock; only the live matches are summed up |
| the organiser pick (`organiser-pick.ts`) | read live matches only, no clock | `postingMatchWhere` plus the clock; only the live matches are swept |
| the partner-club ask (`partner-ask.ts`) | held already, but read every match of the last two days, so a live match left over from before then held nothing | `postingMatchWhere` |
| the announcement, the 17:00 post | held already | unchanged, now reading the one `nextForPosting` |

**The next match (D7), each with a failing test first.**

| door | before | after |
|---|---|---|
| the DM answer (`dm-qa.ts`) | the earliest live match, no date floor: a match left live from last week was "UPCOMING MATCH" | the club's next match; in that edge "UPCOMING MATCH: none scheduled right now.", as an IN would be refused (model input, below) |
| the recruit blast (`recruit.ts`, the HQ and DM "invite players") | the soonest live match from UTC midnight: with last week's game live it invited everyone to next week's, where their IN was then refused | the club's next match; in that edge the no-match refusal |
| which of an admin's clubs a DM acts on (`dm-reply` `orgWithUpcomingMatch`) | the soonest live match from UTC midnight across his clubs | each club's next match, in one read, the soonest of those |
| an admin's "invite players" with no next match (DM; the group and HQ print the same refusal) | the DM fell through unanswered; the group and HQ said "There's no upcoming match to invite players to." | one plain line on every door (main session's review of #537, on Kemal's delegation): when the last game is still not finished, "There's no upcoming match to invite players to yet: the game on Tue 3 Nov hasn't been finished. Once its score is in or it's closed, I can invite players for the next one." (EN and TR, `recruit_no_match_unfinished`, golden R62b), else today's plain refusal; the DM now replies with it for the club with a next match, else the admin's first club. The unfinished game comes from the same candidate read (`findNextMatchOrUnfinished`) |
| the dashboard (`app/page.tsx`) | the first live match after this instant: after kickoff it jumped to next week's, and with last week's game live it offered an IN the server refused | the club's next match |
| the match list (`matches/page.tsx`) | every match from this instant, any status: a cancelled game was listed as upcoming, and today's game left both lists at kickoff until the cron completed it | `upcomingMatchesWhere`: live matches from today, London |
| the in-flight block (`attendance.ts`, `matches/[matchId]/page.tsx`) | its own query, UTC midnight | `inFlightWhere` |
| the seed nudge (`seed-nudge.ts`) | the soonest live match not yet kicked off | the summary's `nextMatchId` (a kicked-off one is "no match" in its precheck, as before) |
| the chase composer with no match id (`message-analyzer.ts`, the production dry run only) and that dry run's header | the first live match with its sign-up deadline ahead, which the selector's own header says is not a gate | the club's next match |
| the analyze fallback, the HQ paste, the poster, the first-teams notice, the DM IN target | the selector over a query of their own (no historical filter) | `findNextMatch` or `nextMatchWhere`: the same set, one `where` |

The one-derive guard's `registration` ratchet: `next-match.ts` (2) replaces four files; three
remain (below).

**Left, and why.**
- `loadSquadState`'s own 30-day read (the same selector, now on the London day): it differs only
  for a live match more than 30 days old, which the 15-minute completion cron prevents (A2 named
  it). Reading the request's summary there instead would decide on a summary read before the
  request's writes (5.1, risk 1).
- The HQ team commands (`team-proposal.ts` `commandMatch`): the same selector over the club's
  games' live matches, the same set.
- The legacy `api/whatsapp/attendance` and `status` routes: nothing calls them (the Pi's
  `postAttendance` in `whatsapp-bot/src/api.ts` has no caller), so per 5.2 they are for deleting,
  not aligning.
- Which club a DM question is about (`dm-qa.ts` `mostRecentOrg`, the club with the most recent
  match) and the admin's "rating progress" club (`orgWithCompletedMatch`): club choices, not the
  next match.
- Mute, billing pause, dormancy and quiet hours (B6): not touched.

**What the DM answerer is sent (LLM change).** No prompt and no CONTEXT template changes: the
system prompt is byte for byte the same (its hash in the A3 entries is unchanged). Only which
match the UPCOMING MATCH block describes moves, and only in the edge where a live match dated
before today has not been completed: it now says "UPCOMING MATCH: none scheduled right now." (the
line a club with no match already gets), and YOUR PAYMENTS has no upcoming fee line. For a normal
week the block is the same match as before. Old and new, from the A3 characterisation (FNF on Sat
7 Nov with Fri 6 Nov still live; the Vets on Fri 13 Nov with Mon 9 Nov still live), with the paid
answers: the side by side page in the PR.

**No sandbox scenario step.** The five scenario clubs play in November, in GMT, where London
midnight is UTC midnight, so no step can show the BST edge; a summer copy of a club would need its
own cassette (a paid recording). The 00:30 BST cases are pinned by unit tests instead
(`registration-match-select`, `london-day-start`, `next-match`, `derive`, `attendance-in-flight-london-day`).

**Proof.** Paid, all on `ANTHROPIC_API_KEY_DEV`, 88 calls, about $0.014:
`scripts/dryrun-dm-qa.ts SET=nomatch` (new set: the edge's CONTEXT, EN and TR, once each, 6 calls,
$0.0018): 6 of 6 answers right ("There's no match scheduled right now...", "Şu an planlanmış bir
maç yok"), the asker's £6 still answered; the check flagged the Turkish "6 £" for not reading
"£6", so it now accepts both (not re-run). `e2e/sim/dm-context-live.spec.ts` (the real dm-reply
route) 3 of 3, 8 calls, $0.0010. `e2e/sim/dm-qa-payments-live.spec.ts` once in full (26 calls,
$0.0041): "how do I pay?" failed in both languages with `handled: "dm-help"`, the failure B5 and B7
recorded on this base branch (the fix, #534, is on main), and the serial run stopped there; the
rest once (`--grep-invert "how to pay"`, 48 calls, $0.0073): 10 of 10, the next game's unconfirmed
fee included. The club replay is free: all five clubs hit every cassette (0 misses; FNF's two
"reordered" balancer requests are the row-order matches B3 named), so nothing was re-recorded;
`baseline/b4` against `baseline/b5` is identical for all five, because the scenario clocks are in
GMT, no scripted week cancels a game or sets weekly deadlines, and no match is left uncompleted.
Unit tests: A1, A2 and A4 characterisations unchanged; A3 changed in four entries, all the edge
(FNF `2026-11-07 question`, the Vets `2026-11-13 question`: UPCOMING MATCH none scheduled; FNF
`2026-11-07 invite` and the Vets `2026-11-13 invite`: no blast, the one-line refusal naming the
unfinished game, and one model call fewer, since the DM no longer falls through to the question
reader); the golden copy gained R62b in each language and changed none. The review change is no
model input (the code's reply after the existing intent) and its replay was free. Rebased onto B6
(#536): the doc merged with both sections kept (3.16 here, 3.17 B6's) and both decision rows (K5,
K7); A1, A2 and A4 equal B6's, A3 differs from B6's in the four entries above only; `baseline/b4`
re-made on the rebased code: 0 misses, identical to `baseline/b6` for all five clubs.

### 3.17 As built in slice B6 (one rule for "may MatchTime send this club anything now, and what")

Built on `refactor/club-summary-b6` (PR against `refactor/club-summary`). Decision K7 (the main
session's recommendation; Kemal delegated these on 2026-11-04): one definition per lifecycle fact,
every sender applies it the same way; quiet hours hold, they never drop; a muted club gets nothing
in the players' group but what the mute rules already allow; a dormant or billing-paused club gets
nothing. Where the senders disagreed, the strictest existing behaviour was taken unless it broke an
existing, intended exemption; each such choice is a K7 entry below. No model input changes (below),
so this is not an LLM change: $0, no key used.

**The rule.** `src/lib/club-voice.ts` (pure), read from the summary's lifecycle facts
(`ClubSummary.lifecycle`, `ClubRowFacts.lifecycle`):

| state | when | what MatchTime sends the club |
|---|---|---|
| silent | not approved, setting up, dormant, or paused for the club fee (in that order of reasons) | nothing, on any door: no post, no reply, no DM to a member, no notice to the organisers. What is already queued waits at the drain and is dropped when the club comes back (`dropQueuedMessages`). MatchTime's own messages about the club (owner approval DMs, setup DMs, billing DMs) are the platform's voice and go on the platform channel, as before. |
| muted | the mute switch off on a club that is otherwise served (Kemal's engineering switch, flipped on a live club for an hour of work) | nothing MatchTime sends on its own: no players' group post, no scheduled post, no notice, no queued DM goes out; it all waits for the unmute and then goes. A member's DM is still read and answered as on main (the reply is a queued DM, so it waits too). In HQ only the club's own open organiser pick round. Writes are not messages: fixtures, seeding and the rolling squad carry on (org-lifecycle.ts). |
| on | everything else | everything, at the club's quiet hours |

`clubVoice(facts)` returns the state (and the reason when silent), `clubSpeaks` is `state === "on"`,
`servedClubWhere()` and `speakingClubWhere()` are the Prisma fragments (on or muted; on), and
`inServedClubWhere()` the served clubs for a membership query (the DM door's club pick). `__tests__/club-voice.test.ts` checks the
fragments say exactly what `clubVoice` says for all 48 combinations of the five stored columns, with
`BILLING_ENABLED` on, and that a paused column means nothing with it off. `voiceFactsOfRow` is the
same facts from a club's row (the fail-soft path, the admin channel, the pool's offers); a row read
without a column is never silenced by it. Quiet hours keep their one definition (message-hours.ts).

Why one state machine and not seven checks: `whatsappBotEnabled` is already false for every
unapproved and every setting-up club (two CHECK constraints), so the six spellings of D10 only ever
disagreed on dormancy and the billing pause, and on which door read them. The order of the reasons
is the order a person fixes them in.

**The senders, each with a failing test first** (`src/lib/__tests__/club-voice-every-door.test.ts`
runs the real routes over the A3 fake world with a recording model; each case was red before):

| sender | before | after |
|---|---|---|
| the drain (`due-posts`, every scheduled post and every queued message of every sender: the players' group, HQ, DMs, the sweeps, the web's actions) | bot on and not paused; a dormant club with its bot on was polled and every queued job went out | `speakingClubWhere()`: a dormant club gets a 404 and no post. `computeDuePosts` reads `clubSpeaks(club.lifecycle)` (it read the mute switch alone) |
| the players' group (`analyze`) | bot on and not paused | `speakingClubWhere()`: a dormant club's batch is ignored before any model |
| the picture reader (a model reads an organiser's picture) | bot on and `servingClubWhere()` | `speakingClubWhere()` |
| HQ (`admin-group.ts`) | the billing pause only; a dormant club was answered in full | `clubVoice`: silent is ignored ("club-dormant", "club-billing-paused" as before, "club-not-served"); muted keeps the pick round (K7 d) |
| the DMs (`dm-reply`) | the approval and billing rail (all clubs), then the setting-up rail; no handler read dormancy, so a dormant club's member was read and answered | a third rail, `dmClubsSilence` (club-voice-db.ts): a sender whose every current club is silent is ignored before any model, nothing queued ("club-dormant", "club-not-served"). A muted club is served, so its members are read and answered as on main. The four club picks (the question answer, the cold IN, an organiser's instruction, the subscription ack) take only a served club (`inServedClubWhere()`, was `IN_LIVE_STAGE_CLUB_WHERE`) |
| the organisers' notices (`sendAdminNotice`, the one way organisers are told something: the sweeps, the partner asks, join and leave, the web's actions) | queued for any club; never released while it was paused, unapproved or setting up, dropped on resume or go-live, and released for a dormant one | not queued for a silent club (one log line). A muted club's is queued and waits, as before |
| the score ask in HQ (`adminGroupPost`, D15) | the default window, whatever the club chose | the club's own quiet hours; held, asked again on the next poll inside its 24 hours, never dropped |
| the player pool's offers (`admitPoolOfferJobs`, every pool DM on a club's behalf, from any door) | the pool's own switches only | a silent club's offer is cancelled ("club-silent"), a muted club's held |
| the match page's ask, partners and pool (`requestAskRound`, the web's one door for both) | asked for any club | a club that does not speak asks nobody; the organiser reads "MatchTime isn't sending messages for your club right now, so nobody was asked." (TR "MatchTime şu an kulübünüz için mesaj göndermiyor, bu yüzden kimseye sorulmadı.", `xask_round_club_quiet`) |
| the two once-only posts queued from the web: "payments are live" (`payments-live-announce.ts`) and the pool share post (`pool/club-share.ts`) | the mute switch alone | the rule; a club that does not speak keeps the once-only key, so it is told when it speaks again |
| waking a club from dormancy (`reactivateOrganisation`) | the queue from its dormant weeks went out on the next poll | dropped first, then woken: no catch-up, the billing resume's rule (`dropQueuedMessages`, which the resume now calls too) |

**K7, the choices** (the strictest existing behaviour unless it broke an intended exemption):

- a. **Dormant is silent on every door.** The crons, the month, pick and badge code and the venue
  reminder already treated a dormant club as not served (`isClubOperational`: "may MatchTime act for
  this club on its own initiative?"); the drain, the players' group, HQ, the DMs and the picture
  reader did not. Dormancy still never touches the mute switch or stops a write (actions/org.ts).
- b. **A muted club's members are still read and answered by DM, as on main** (decided by the main
  session in its review of #536, on Kemal's delegation; the first build ignored them). Mute is Kemal's
  engineering switch (prisma/schema.prisma), flipped on a live club for an hour of work, and dropping
  a DM would lose a real action: a "paid" claim, an OUT, a rating or a pool reply. The reply is a
  queued DM, so it waits at the drain for the unmute, like everything else MatchTime sends (c). A
  silent club's members are ignored before any model, as a paused club's already were.
- c. **Mute holds, it does not drop.** What is queued for a muted club waits and goes on the unmute
  (kept: `sendAdminNotice` documents it, and the switch is used for an hour of maintenance on a live
  club). Silence drops on the way back (billing resume, go-live, and now the wake from dormancy).
- d. **HQ answers a muted club's open organiser pick round** (kept: an existing, intended exemption,
  admin-group.ts).
- e. **A silent club's organisers are not queued a notice.** It would never be released while
  silent and is dropped on the way back, so queuing it bought nothing (and released a dormant club's).
- f. **The pool and the partner ask follow the club's voice.** A pool offer is cancelled for a
  silent club and held for a muted one (silent drops, mute holds, as c); the web's ask is refused
  for both with one line, as K4 refuses on the web what WhatsApp refuses.
- g. **Quiet hours: the club's own, on every HQ post (D15).** Kept: the notices that pass
  `holdOvernight: false` (a join, a leave, a new player's IN, the partner ask's time-critical lines)
  still go at once by DM, as their callers document.
- h. **Setting up stays silent for the club and open for MatchTime's setup DMs** on the platform
  channel (kept, the setup hold's design).

**What a model is shown: nothing changes.** No prompt and no CONTEXT template changed. Every club
shape of the A1 to A4 characterisations sends the same model requests, the muted club's DMs
included. The DM club picks differ only for a person in a served club and a silent one; the DM
answerer is then given exactly what a member of the served club alone is given, an input every
existing suite already covers. The DM reader's club
list (`dm-reader.ts`, `APPROVED_CLUB_WHERE`) is untouched, so its input is the same for everyone. So
no paid run: $0.

**Characterisation: A1 to A4 unchanged.** (The first build changed A3 `dm-reply: muted`, the muted
club's DMs ignored; with K7 b reversed it is back to its main behaviour, byte for byte.) The copy golden gained one entry per
language (`B6 xask_round_club_quiet`) and changed none. Source pins updated for the new club pick:
`partner-guest-exclusions`, `partner-guest-not-a-member` (`inServedClubWhere()` beside
`ORDINARY_MEMBER_WHERE`).

**The replay.** Free: the five clubs replayed from their cassettes on the final code with
0 misses and 0 upstream calls (FNF 38 of 38 hits, own-language 25, ratings only 30, Sutton 52, the
Vets 53), and `baseline/b6` against `baseline/b5` is identical for all five (`scenarios:compare`,
exit 0). None of the five is dormant, paused or setting up, and the own-language club's mute and
unmute in its script asks nothing of HQ while muted, so no step changes. No new
cassette was recorded.

**Left, and why.**
- **The orgs list the Pi reads** (`/api/whatsapp/orgs`) still lists a dormant club with its bot on as
  served, and the Pi forwards its messages; the server refuses them on every door now. Moving it
  would change what the Pi treats as an unknown group (the self-join flow), which is not B6's.
- **Handlers that run before the DM rails** (pool confirm, approver, connect, GO, the organiser pick
  reply, the collector's digest reply, the bench offer reply): each reads its own open thread and the
  billing pause where it did; what they queue waits at the drain, which now reads the whole rule.
- **Reactions, poll votes, scores, the team and status reads, group join, leave and sync**: writes
  or reads with no message of their own; anything they queue (an ack, a notice) goes through the
  drain or `sendAdminNotice`.
- **The web "Generate match"** (D10): a write an organiser asks for, not a message; the cron's
  checks are for what MatchTime does on its own initiative.
- **A muted club's queue on the unmute** goes out (K7 c). There is no unmute writer in the code (the
  switch is set by hand), so a cleanup there would have no caller.
- **The pool share card's line** for a club that does not speak still reads "Connect your players'
  WhatsApp group to MatchTime first", as it did for a muted club; a line of its own would be copy for
  an edge no club is in.
- **`isClubOperational`** stays the consumers' name for "served, mute aside" in the sweeps that
  already read it (blind to setting up, as its doc says); inside the drain they only run for a club
  that speaks.

### 3.18 As built in slice B2 (one month phase for every consumer)

Built on `refactor/club-summary-b2` (PR against `refactor/club-summary`). Decision K8 (the main
session's principle, on Kemal's delegation, 2026-11-04): a month is matched to a game by the game's
Activity, never by venue and weekday; one phase function; where today's consumers disagree, the
behaviour the Vets actually need wins: a list posted mid-month starts the month (#502), and a weekly
post never reaches a monthly club. Each choice is a K8 entry below. No prompt and no CONTEXT template
changes (below).

**One phase, defined once.** `MonthPhase` (club-summary/types.ts) is the phase of ONE game:

| phase | when |
|---|---|
| `none` | no SquadMonth row for the game's own Activity and the London month of its kickoff, and no held key; or a game dated before the month was started part-way (`beforeStart`: the month began after it, so it was a game of no month) |
| `held` | no row, and a held key of that Activity and month (MatchTime waits for the organiser's list) |
| `signup` | the row is `open` (its list opened or not yet) or `priced` (a stored status no writer sets: pricing is `pricedAt` on an open month) |
| `running` | the row is running and the game is on or after its start |
| `closed` | the row is closed |

`monthPhaseFor` (derive.ts) is the only function that computes it; `monthPhaseOfGame` is its
month-level half (one Activity and London month, no match), for the seed door. The game's month is the
row of the table's unique key (`orgId, activityId, monthStart`), so there is at most one and the old
"two rows of one fixture, the one furthest on" rank is gone. `MatchMonthFacts` lost `listOpened`,
`held` and `rowForOwnActivity` (each was one of today's disagreeing values) and `MonthFacts` its
`fixture`.

**What a consumer does with it, decided once** (`monthly-gates.ts`, pure):
- `monthFlowOf({ mode, month, stillToPlay })`: `weekly` (a weekly club), `month` (a running month, or a
  played game of a closed one), `month-pending` (a monthly club's game whose month is not under way:
  none, held, sign-up, or a closed month's game still to play; also a monthly club's match with no month
  fact at all, never weekly);
- `monthNotStartedOf({ mode, month })`: the players' group IN hold (#502), phase `none` or `held`.

A door with no summary reads the same function through `loadMatchMonth(matchId)` (month-phase.ts:
the match, its game's month row by the unique key, the held key of that game and month), which
replaces `monthNotStartedFor` (month-not-started.ts, deleted, off both ratchets). `monthForMatch`
(monthly-week.ts: `loadMonthlyWeek`, the hourly sweep) and the monthly seed's target match match by
`RunningMonth.activityId` too.

**The consumers, each with a failing test first** (`monthly-gates.test.ts`, `month-phase.test.ts`,
`month-pending-scheduler.test.ts`, `activity-format-switch-monthly.test.ts`, and a case in each of
`deadline-summary`, `unpaid-list`, `squad-announce`, `month-seed-under-way`; each red on the base
branch where behaviour changes):

| consumer | before | after |
|---|---|---|
| the scheduler's month shape (`schedulerMonthShape`, deleted) | four shapes from the facts plus two windows: a priced month, or an open one before its list opened, was "no month yet" (A1's note in 3.7); held and sign-up were treated as sign-up | `monthFlowOf` per match; `monthly` (the month context) only for the flow `month`, `monthPending` for every other match of a monthly club |
| the announcement | no month: the monthly copy (#501); priced or open before its list: the same monthly copy | no month: unchanged; any month that exists (sign-up, priced or not yet listed) or is held: nothing (K8 b) |
| the organisers' 17:00 post (D2a) | skipped a running month only, so a monthly club with no month got the weekly squad | skipped for every monthly club's game |
| the match-day chases and the 2h last call | a held or sign-up month's game got the players' group chase; with the organisers announcing, a no-month game got the chase notice | nothing on either side for a game whose month is not under way (K8 c) |
| the payment poll, the unpaid group reminder (D2c) | `!monthly`: a monthly club's game with no month got both | weekly clubs only (K8 f for a game before a part-way start) |
| the fee ask to the collector | a no-month game got the weekly "how much per player?" | not for a game whose month is not under way (K8 d) |
| the recruit chase-up DM | read no squad mode | not for a game whose month is not under way (K8 e) |
| the admin deadline summary (D2b) | read no squad mode | weekly clubs only, as the scheduler's own deadline posts |
| the organisers' unpaid list (`unpaid-list.ts`) | a no-month game's players listed as owing | not for a game whose month was not under way; a running month's game keeps its list (its pay as you go players) |
| "Squad complete" (D2d) | held back only with a running month (`loadMonthlyWeek`) | never for a monthly club (`monthFlowOf`, no read) |
| the players' group IN hold (analyze route) | `!rowForOwnActivity` from the summary, `monthNotStartedFor` without one | `monthNotStartedOf` of the phase, through `loadMatchMonth` without a summary; the same values |
| `monthForMatch`, `loadMonthlyWeek`, the sweep, the monthly seed's target | the same venue and weekday | the same Activity (K8 a) |
| the seed door (`seedableMonths`, D5) | any SquadMonth of the club in the London month counted as started | only the game's own month (`monthPhaseOfGame`: sign-up, running or closed); none or held may be started from a list |
| the monthly reader's "started" (D5) | recomputed inline | `hasStarted` (`monthStarted`'s rule); byte for byte the same CONTEXT |
| a switch to another of the club's games (`switchMatchToActivity`, the web switch page and "@Match Time switch to 5 a side") | re-pointed the match's Activity for any club | refused for a monthly club with one plain line, EN and TR (`monthlyKeepsGame`), nothing written; the size switch inside the game (#517) is untouched (K8 a) |

**K8, the choices** (what the Vets need; a weekly post never reaches a monthly club):

- a. **A game's month is its Activity's.** The venue and weekday key existed because a switch to
  another Activity re-points a match; with the activity key such a switch would take a month's game
  out of its month (no list, its regulars' INs held, every post held). So a monthly club's game is
  never moved to another of its games: "*Vets 7s* runs as a monthly squad, so its games stay on it
  and I can't move one to another of your games. You can change a game's size inside it instead,
  for example *@Match Time make it 8 a side* (if it has only one size, set the fewest and most
  players first)." (TR: "*Vets 7s* aylık kadroyla oynanıyor, bu yüzden maçları onda kalıyor ve birini
  başka bir maçınıza taşıyamam. Bunun yerine maçın kişi sayısını değiştirebilirsiniz, örneğin
  *@Match Time 8'e 8 oynayalım* (tek bir boyutu varsa önce en az ve en fazla oyuncu sayısını
  ayarlayın).") The format switch mid-month the plan asked to test is the size switch, which keeps the
  Activity, so the month stays (derive test).
- b. **A month that exists is in sign-up until it runs.** A priced month, or an open one before its
  list opened, was "no month yet" to the scheduler and got the monthly announcement ("the organiser
  will post the month's list"); it is in sign-up now, like an open month with its list: the month's
  list is the announcement. Neither state is written by today's code (rows are created open with
  `listOpenedAt`, or running; nothing writes "priced"), so no club moves.
- c. **No chase, on either side, before the month is under way.** A held or sign-up month's game got
  the players' group chases with the fixed text, and with the organisers announcing a no-month game got
  the chase notice; "N more needed" counts whoever said IN, not the squad.
- d. **No fee ask for a game whose month is not under way.** Its players are the month's regulars
  (playing off the list) and whoever said IN. No monthly club collects through MatchTime today (the
  Vets have both payment flags off, B5 named the same), so nothing moves in production. If one ever
  does, a no-month game's pay as you go players and guests could get the running month's PAYG fee ask;
  not built.
- e. **No recruit chase-up DM for a game whose month is not under way**: "we still need N" counts
  whoever said IN.
- f. **A game before a part-way start is a game of no month.** Slice 5's review pinned the weekly
  payment poll and fee ask for it ("its poll, its fee question and its chase are the weekly ones");
  it now gets what a monthly club's no-month game gets: nothing weekly. Its money is moot in
  production for the same reason as d. The test is rewritten with a weekly guard
  (`monthly-week-scheduler.test.ts`).
- g. **The scheduler's two month windows are gone.** A month in sign-up counted only for this London
  month or the next, and a closed month only for 14 days after its close. The summary's match window
  (live matches, ten days of played ones) already bounds both; a game two months out exists only once
  its list opened.

**#535 on main** (one daily 17:00 rule for every club, monthly clubs posting the month's list) is not
ported. Its rule reads `monthly?.seeded && !monthly.signup ? "month" : monthly || noMonthYet ?
"no-month" : "weekly"`; on this branch `monthly` is the month flow only and `monthPending` replaces
both `noMonthYet` and `monthly.signup`, so the rebase is `monthly?.seeded ? "month" : monthly ||
monthPending ? "no-month" : "weekly"` and its organisers' branch reads `monthPending` where it read
`noMonthYet`. The facts it needs (a running month with its regulars on, no month yet) are the phase
and `seeded`.

**What a model is shown: nothing changes.** No prompt and no CONTEXT template changed. The monthly
reader's "started" is the same value through `hasStarted`. A post that is no longer sent could change
`lastBotPost` for the next extractor call of that club (4.4); none of the five scenario clubs sends
one of the removed posts in its scripted weeks (below), so no model input moved. $0, no key used.

**Characterisation, only the intended B2 change** (every entry):
- A1, `vets-signup` (computeDuePosts and the poll): the 2h last call for Mon 7 Dec, a game of December
  in sign-up, is gone (K8 c).
- A1, `self-join` (computeDuePosts and the poll; monthly, tracking on, a priced month): the weekly
  payment polls for Mon 2 and Mon 9 Nov are gone (D2c, K8 b).
- A2, A3, A4: unchanged. The fake world now answers SquadMonth's one compound key
  (`orgId_activityId_monthStart`), which `loadMatchMonth` reads on the analyze fallback.
- The copy golden gained `B2 monthlyKeepsGame` per language and changed none.
- `partner-offer-line.test.ts` (a source pin) reads the new branch order (pending first).

**The replay.** Free: the five clubs replayed from their cassettes on the final code with 0 misses
and 0 upstream calls (FNF 38 of 38, own-language 25, ratings only 30, Sutton 52, the Vets 53; FNF's
two "reordered" balancer requests are the row-order matches B3 named), and `baseline/b2` against
`baseline/b4` is identical for all five (`scenarios:compare`, exit 0). Section 4.4 expected the Vets
to change; they do not, because the Vets' script starts on 10 November with no month and both
payment flags off: before the list is posted at 12:00 the only scheduled post due is the
announcement, which keeps its monthly copy, and the removed posts (the payment poll, the fee ask,
the chases of a month not under way, the organisers' side) never fall due in its week. Nothing was
recorded; no paid call was made. The B2 differences are pinned by the unit tests and the A1
characterisation above instead.

**Left, and why.**
- **The month's calendar of games** (the sign-up list's games, `loadCommitmentStates`, month-close's
  games and leaver credits, the month opener's "one month per fixture") stays on the venue and weekday
  key. It is the calendar a month is opened with, shared with the ghost-match slot dedupe, and moving
  it is a change inside money writers. With a monthly club's game never moved to another Activity
  (K8 a) and a month's games created on its own Activity, the two keys pick the same games; they
  could differ only for a monthly club with two formats of one fixture whose weekly generator made the
  week's match on the other format first. No such club exists. The fixture ratchet
  (`one-derive-guard.test.ts`, `isSameRecurringFixture(` per file) keeps every other file off it.
- **The players' group squad post swap (D2e)** stays a text comparison: it is the content of a reply,
  and it already follows the phase through `currentWeekListPost` (`loadMonthlyWeek`, the activity
  key). A no-month club's "who's in?" is answered with whoever is in, as today.
- **The monthly reader's MONTHS block** still sees open, priced or running months of this and next
  month: widening it is model input (C1).
- **The bench offers and pay as you go pool offers** of a no-month game read the open places, not a
  weekly roster; not in D2.
- **The help and the web guide** are unchanged: the refusal is a one-line answer to an organiser who
  asks for something a monthly club does not do, not a feature.

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
- As built: the pages read A3's row facts (`ClubRowFacts`) from the row they already read, not the
  whole summary, and the dashboard and the match list did not move (section 3.11).

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
- As built (K1 decided): section 3.13. The chase still asks while a place is open (K1 a),
  so it is the wording and "at risk" that move, not whether it chases; `smallerFormats`
  (D12) was left for a slice of its own.

**B2. One month phase.** (D2a to D2e, D5) As built: section 3.18 (the phase names, the gate's
name and the activity key differ from the plan below; K8 lists every choice).
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
- As built (K5 decided): section 3.16. Three named facts (the next match, the posting rule,
  the last match played); the posting rule's hold is on every post; the legacy
  `attendance` and `status` routes were left (no caller, 5.2).

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
- As built (K7 decided): section 3.17. One rule, `club-voice.ts` (on, muted, silent), read at the
  drain, the players' group, HQ, the DMs (silent clubs only), the organisers' notices, the pool's
  offers and the web's ask. The DM reader's club list was left as it was, so no model input changes; the web "Generate
  match" is a write, not a message, and stays as it is.

**B7. Every door honours the switches.** (D8, D11, D13)
- The web IN button and rating link (`matches/[matchId]/page.tsx:274`, `:488`) read
  `features.attendance` and `features.playerRating`; DM questions read `features.statsQa`
  as the group does (`pipeline/engine.ts:1851`); bench offer DMs read `features.bench`.
  The group hello and the HQ intro describe the club from one pure description of the
  summary, so they cannot disagree about ratings or lists.
- Decision K4 for the web IN button on a club with attendance off.
- As built (K4 decided): section 3.15. The DM stats line is an LLM change (CONTEXT only); team
  generation and Man of the Match were left as their settings cards describe them.
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
| K1 | Does the chase still ask for the 14th player when 13 is above the club's minimum? Does "At risk" mean below the minimum or below the places? | B1 | the chases count places, the day-before nudges count the minimum. **Decided by Kemal, 2026-11-04 (the main session's recommendation): at or above the game's minimum the game is ON. (a) The players' chases still ask for the open places while any is open, but never say "short" or "N short": they say the places left ("3 places left"); below the minimum they keep today's "short" wording. (b) "At risk", and any "we'll have to call it off", only below the minimum. (c) Every other "short" and "places open" reads the summary's `squad-short.ts` facts: one definition, no copies.** Built in B1 (section 3.13). |
| K2 | With exactly one payment flag on, which messages go out: the HQ credit command, the help's payments topic, the settings page's "Payments" line? | B3 | three different answers. **Decided 2026-11-04** (Kemal accepted the recommendation): ONE rule, the existing `paymentMessagesOn` (tracking OR collection), exposed by the summary as `payments.messagesOn`, followed the same way on every door; "a card can be taken" is one rule too, `isPaymentCollectionLive`. Built in B3 (section 3.12). |
| K3 | Before the collector confirms a fee, does MatchTime tell a player the game's usual fee, or "not set yet"? | B5 | the DM answer says the game's fee, the pay page says not set. **Decided by Kemal, 2026-11-04 (the main session's recommendation): before the collector confirms a match's fee, a player who asks, on any door (DM answer, group or HQ answer, pay page, offers and asks), is told the game's usual fee marked as not confirmed yet ("usually £8, not confirmed yet"); once confirmed, the confirmed fee. Pay links and charging use only a confirmed fee. The summary exposes ONE fee fact (amount, confirmed or not, source) and every door reads it.** Built in B5 (section 3.14). |
| K4 | On a club with attendance off, may a player still tap IN on the website? | B7 | yes on the web, no in WhatsApp. **Decided by Kemal, 2026-11-04 (the main session's recommendation): no. Players cannot tap IN or OUT on the website either; the match page explains the club doesn't take sign-ups through MatchTime. The same principle for every switch the plan found ignored on some door: if WhatsApp refuses it with the switch off, the web and DMs refuse it too, with a short plain explanation.** Built in B7 (section 3.15). |
| K6 | With team generation off, should the website's Generate teams, the teams page and the HQ team commands refuse too? | after B7 | the settings card says on purpose that the web button still works and that Teams ready is separate; B7 left them (3.15) **Decided by the main session, 2026-11-04, on Kemal's delegation: with automatic teams off, the organiser's own Generate teams on the web and the HQ "make the teams" keep working, as the settings card promises.** |
| K5 | Is "today" the London day for the next match, and do the deadline posts and the month's list honour a cancelled match's day like the announcement does? | B4 | UTC in the selector, London in the posting rule; two posts skip the hold. **Decided by Kemal, 2026-11-04 (the main session's recommendation): "today" is always the London day; and every post that holds on a cancelled match's day (the announcement already does) does the same, the deadline posts and the month's list included. Where consumers genuinely ask a different question ("the match being registered for", "the fixture's next match to post about", "the last match played"), each is its own named fact in the summary, defined once.** Built in B4 (section 3.16). |
| K7 | Where today's senders disagree on "is this club served" (D10, D15), which wins? | B6 | the mute switch alone, it plus the billing pause, `servingClubWhere`, `isClubOperational`, that plus setting up, two DM club picks; dormancy read by none of the doors a message leaves by; the HQ score ask on the default window. **Decided by the main session, 2026-11-04, on Kemal's delegation: one rule, `club-voice.ts`: silent (not approved, setting up, dormant, paused) sends nothing on any door, reads no DM and drops its queue on the way back; muted holds everything MatchTime sends on its own (posts, notices, queued DMs) until the unmute, still reads and answers its members' DMs as on main (the reply waits too), and HQ answers only its open pick round; quiet hours are the club's own on every door and hold, never drop. The eight choices are listed in section 3.17 (b revised in the review of #536).** Built in B6 (section 3.17). |
| K8 | "Has this game's month started", and what a monthly club's game gets before it (D2, D5) | B2 | five definitions: venue and weekday in the scheduler, activity id in the IN hold, any month of the club at the seed door, an inline "started" in the reader, running months only in `loadMonthlyWeek`; a priced month, or an open one before its list, "no month yet" to the scheduler; the organisers' 17:00 post, the payment poll, the unpaid reminder and list, the fee ask, the recruit chase, the deadline summary and "Squad complete" each reaching some monthly games. **Decided by the main session, 2026-11-04, on Kemal's delegation: a month is matched to a game by the game's Activity, never by venue and weekday; one phase function (`monthPhaseFor`: none, held, sign-up, running, closed), turned into what a consumer does in one place (`monthly-gates.ts`); a list posted mid-month starts the month (#502) and a weekly post never reaches a monthly club. The seven choices are listed in section 3.18 (a monthly club's game is never moved to another of its games; a month that exists is in sign-up until it runs; no chase, fee ask or recruit chase before the month is under way; a game before a part-way start is a game of no month; the scheduler's two month windows go).** Built in B2 (section 3.18). |

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
