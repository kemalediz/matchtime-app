# Club fee billing: free month, then up to £9.99 a month per group, charged for the games played

Plan, first written 2026-10-01, **rewritten 2026-10-02 for charging by games played**.
Design only: no code, schema, Stripe setting or production row was changed to write it.
Every claim about the current code cites the file it was read from, on `origin/main` at
`b60c941` (B1 to B5 merged, billing dark) unless a section says otherwise.

**Fifth pass (Kemal, 2026-10-02): the club fee is charged by matches PLAYED in the month.**
Fee = £9.99 x played / scheduled, VAT inclusive, charged after the month ends. His
examples, which this plan must reproduce exactly: 3 of 4 played is **£7.49**; 4 of 5
played is **£7.99**; 0 of 4 played is **nothing**; a month with no games at all (a summer
break) is **nothing**. This replaces the flat £9.99 monthly subscription that slices B1 to
B5 built (merged, live but dark: `BILLING_ENABLED` is off, so no club has ever been
billed). The pass rewrites the summary and sections 2, 2A (new), 3, 4.1, 4.2, 5, 6, 7, 8,
10 to 13 and 15; sections 4.3, 4.4, 4.5 (with small edits), 9, 9.1 and 14 still hold.

Earlier passes (2026-10-01), still in force unless a section below says otherwise:

- **Second pass:** every club fee message explains how to split the fee among the
  players, with a worked example from the club's own game (section 7.2).
- **Third pass:** the **money collector** (`Organisation.paymentHolderId`) adds and owns
  the card, the owner when none is set (4.5); adding the club fee to match fees is not
  planned (14).
- **Fourth pass:** AI caps of $2.00 a day in the free month, then $1.50; admins told once
  a day at the cap; AI top-ups planned (9, 9.1).

---

## One-screen summary (for Kemal)

**What the club experiences**

1. You approve their club (as today). Their **free month starts at that moment**. No card
   is asked for.
2. **Day 21:** one WhatsApp DM to the club's **money collector** (or the owner, if no
   collector is set): "the free month ends on 1 Nov, add a card here". The link opens the
   club's billing page with an **Add a card** button, which opens Stripe's own card page.
   **Nothing is charged when the card is added.**
3. **Day 28 and day 30:** one short reminder each, only if there is still no card.
4. **Day 30 to 37 (grace):** MatchTime keeps working; a banner on the website. **Day 37,
   still no card:** MatchTime goes **quiet** in that group (no posts, no replies, no AI,
   all data kept) and the collector gets one DM. Nothing is said in the group. (All as
   built in B1 to B4.)
5. **The club's month** runs from the day the free month ended to the same day next
   month (free month ends 1 Nov: the months are 1 Nov to 30 Nov, 1 Dec to 31 Dec, and so
   on; ends 17 Oct: 17 Oct to 16 Nov). **The morning after each month ends**, MatchTime
   counts the games and charges the card **only for the games played**:
   - 3 of 4 played: **£7.49**; 4 of 5: **£7.99**; all played: **£9.99**;
   - nothing played, or no games at all (a summer break): **nothing is charged**, no
     invoice.
   The collector gets one DM: "4 of 5 games played between 1 Nov and 30 Nov, £7.99
   charged to your card ending 4242 (VAT included)". Stripe emails the receipt.
6. **First charge:** about **day 61**, for the first month after the free one.
7. **Stopping:** "Stop paying" on the billing page ends billing **at the end of the
   current month**; MatchTime keeps working until then, and that last month is charged
   for its games as usual. Removing MatchTime from the group stops it at once; the games
   played before that are charged when the month ends.
8. A failed payment: Stripe retries, MatchTime keeps working for 7 days, then the same
   quiet rule applies.

**What counts as played:** a real weekly game that MatchTime ran and that took place: the
match ended (`COMPLETED`), it was not cancelled, and at least one player said IN or a
score was entered. **What counts as scheduled:** every week the club's weekly game(s)
would normally be on in that month (4 or 5 per weekly game), plus any extra one-off match.
So a cancelled week, a week MatchTime was paused and a summer-break week all lower the
fee. A switched format (7-a-side to 5-a-side) is one game, never two (section 2A).

**Rounding:** £9.99 x played / scheduled, **rounded down to the penny**, so it is never
more than the exact share. Under 30p (Stripe's minimum card charge, only possible on a
low Custom plan) nothing is charged.

**How it is charged (recommended):** the club's card is saved on Stripe (no subscription).
After each month our hourly billing cron works out the amount and creates **one Stripe
invoice for that month**, VAT included, charged to the saved card. No invoice when the
amount is zero. This replaces the B3 subscription; section 5 compares it with a metered
subscription and lists exactly what in B3 and B4 changes.

**What you control** (on `/admin/clubs`): each club's plan: **Standard £9.99**, **Free**,
or **Custom** (for example £5). A Custom price is the club's **monthly maximum** and
scales the same way (3 of 4 played on £5 is £3.75). Sutton FC and every club that existed
before self-join are never billed.

**How the club covers it (the club fee tip):** a game played costs the club at most
£9.99 / 4 = £2.50, so with 10 players it is still about **25p a player per game**, and a
week not played costs nothing. The tip wording changes to say so (section 7.2).

**VAT:** every charge includes 20% UK VAT (a fixed inclusive Tax Rate). £7.49 is about
£6.24 to Cressoft and £1.25 VAT. UK billing addresses only at first.

**Cost to build:** four PRs (P1 to P4, section 13), replacing the subscription parts of B3
and the money parts of B4; B1, B2's gates, B4's reminders and B5 mostly stay. No prompt
changes, so **no paid AI test runs**. Stripe is tested in test mode; live mode only at
rollout, by you.

**Switch:** `BILLING_ENABLED`, still off. Nothing changes for any club until you turn it
on. **PR #184 (B6, help page and runbook) describes the flat fee and the subscription
setup; recommend holding it and folding it into P4.**

**Decisions I need from you:** four, at the end (section 15.2).

---

## 1. What exists today (verified in code)

| Piece | Where | What it does now |
|---|---|---|
| Approval | `decideClub` in `src/lib/club-approval.ts` (~line 300 to 430) | Approve writes `approvalStatus = "approved"`, `approvedAt = now` (~421), turns the bot on. Suspend (`approved` to `suspended`) only for clubs with `approvedAt` set, turns the bot off **and leaves the group**. |
| "Approved" and "operational" | `src/lib/club-approval-state.ts` | `APPROVED_CLUB_WHERE`, `isClubOperational(org)` = approved and not dormant, deliberately blind to the mute switch. |
| Where the gates are read | `api/whatsapp/orgs/route.ts` (orgs query ~23), `api/whatsapp/due-posts/route.ts` (~184, `whatsappBotEnabled: true`), `api/whatsapp/analyze/route.ts` (~478, ~4186), crons `bot-health` (~65), `none-bucket-shadow` (~94), `extract-squads` (~75), `src/lib/match-completion.ts` (~41), `src/lib/rolling-squad.ts` (~187), `fixtureSkipReason` in `src/lib/org-lifecycle.ts` (~120), and `isClubOperational` in `unpaid-list.ts`, `deadline-summary.ts`, `organiser-pick.ts`, `badge-announcement-scheduler.ts` | Every place MatchTime acts on its own initiative already passes through one of these. |
| Silent groups | `loadSilentGroupIds` / `computeSilentGroups` in `club-approval.ts` (~150 to 195); returned by `/api/whatsapp/orgs` as `silentGroups` | The Pi drops their messages and never lets "@MatchTime setup" monitor them. A group owned by an approved club is never silent today. |
| DM sender rail | `dm-reply/route.ts` ~410, `onlyUnapprovedClubs` | A sender whose only clubs are unapproved never reaches a model path. |
| AI cap | `aiAllowanceUsd` in `src/lib/ai-budget.ts` (~166 to 180) | Unapproved, bot off or no group: $0, before anything else. Then the global switch `AI_DAILY_CAP_DISABLED`: when set, $50 a day (`UNCAPPED_USD`) for every allowed club, **ignoring the per-club override too**. Otherwise the override `aiDailyCapUsd`, else $2.00 a day (`NEW_CLUB_CAP_USD`) for 30 days (`NEW_CLUB_WINDOW_DAYS`) from `approvedAt ?? aiWindowStartAt ?? createdAt`, then $1.50 (`DAILY_CAP_USD`); before 2026-10-01 these were $0.25 for 28 days, then $1.00. Section 9. |
| Platform DM channel | `src/lib/platform-jobs.ts` (`queuePlatformDm`, `PLATFORM_DM_PURPOSES` = otp, connect-reply, organiser-decision), Pi poller | Goes out whatever the club's switches say (it does not depend on `due-posts`). Recipient must be a number MatchTime already knows: a User with that phone (rule 12, ~17). Pi pacing of one DM a minute applies. |
| Owner DMs | `queueOwnerDm` in `src/lib/owner-dm.ts` | Approvals and acks to Kemal only; a source guard (`__tests__/platform-jobs-source-guard.test.ts`) forbids anything else from using it. **Billing will not use it.** |
| Signed-in links | `buildAdminLink` in `src/lib/admin-link.ts`; `signMagicLinkToken`, `MAGIC_LINK_TTL`, `MAX_TTL_BY_PURPOSE` in `src/lib/magic-link.ts`; landing `src/app/r/[token]/page.tsx`; `pinOrgFromMagicLink` in `src/lib/org.ts` (~28) | `buildAdminLink({ userId, orgId, nextPath, ttlSeconds? })` mints a `sign-in` magic link (short link) to **any same-origin path**; it checks only that `nextPath` starts with one `/`. Default TTL `MAGIC_LINK_TTL.actionNudge` (48 hours); a `sign-in` token may live up to 365 days. Tapping it creates a normal session **as that user** and redirects to `nextPath`; `orgId` pins the club cookie when the user is a current member. It grants nothing the user's role does not already have: `/admin/*` redirects anyone who is not an OWNER or ADMIN (`src/app/admin/layout.tsx`, `isOrgAdmin` in `org.ts` ~123). |
| Collector page precedent | `src/app/collect/[matchId]/page.tsx`, `requireMatchCollectorOrAdmin` in `src/app/actions/payments.ts` (~262) | A page **outside `/admin`** for the money collector, who is often a player, not an admin. Guard: `paymentHolderId === userId`, else must be an org admin. Reached by a signed-in link to `/collect/<matchId>` sent to the collector's own phone (`direct-payment.ts` ~165, `bot-scheduler.ts` ~2130). |
| Admin channel (slice 2a) | `sendAdminNotice` in `src/lib/admin-channel.ts`; pure rules in `admin-channel-rules.ts` (`resolveAdminNoticeTargets`) | A club's "Admin messages go to": `one-person` (the chosen admin, NULL = owner; the default for new clubs), `admin-group` (one post in the linked admin WhatsApp group, falling back to the owner by DM at emit time if the Pi cannot send there), or `each-admin` (every OWNER and ADMIN with a phone; Sutton FC). Queued as `BotJob`s that the club's next `due-posts` poll hands the Pi, so a muted club sends nothing until unmuted. A DM carries the reader's own signed-in link; a group post carries the plain URL. Returns `{ channel, queued }`, not who was reached. Holds a notice queued 22:00 to 07:59 until 08:00 by default. |
| Money collector | `Organisation.paymentHolderId` (`prisma/schema.prisma` ~202); set by `setPaymentHolder` in `src/app/actions/payments.ts` (~137) | Often not the owner and not an admin (Sutton: Kemal owns, Elvin collects). `setPaymentHolder` is admin only and requires a current member **with a phone**; there is no "unset" action. Self-join does not set it (`self-join-club.ts`), so a new club usually has none until set in Settings. Collector DMs today are plain `BotJob` `dm` rows (e.g. `payment-flow.ts` ~71). |
| The owner | `Membership.role = "OWNER"` | No owner column on `Organisation`. Code that DMs "the owner" takes a current OWNER membership with a phone (e.g. `admin-group-link.ts` ~383). |
| Admin group members | `detectAdminGroupCandidate` in `src/lib/admin-group-link.ts` (~115); `api/whatsapp/sync-participants` | The participant list of an admin group is read only once, when MatchTime is added, to decide whether it is an admin group; it is **not stored** against the club. `sync-participants` only matches the club's own group (`whatsappGroupId`). So the server **cannot tell who is in a club's admin group**. |
| Players per game | `Sport.playersPerTeam` (`schema.prisma` ~547), seeded from `SPORT_PRESETS` in `src/lib/sport-presets.ts` (`football-5aside` 5, `-7aside` 7, `-8aside` 8, `-9aside` 9, `-11aside` 11, futsal 5 ...); each `Activity` has a `sportId`, `dayOfWeek`, `isActive` | Self-join creates the club's one weekly activity with the chosen players per side (`self-join-club.ts` ~114 to 131). |
| Match fee | `Activity.feePerPlayer` and `feeSplitTotal` (~691), `Match.feePerPlayer` (~800) | The BASE per-player fee (before card or bank uplift). Null means no default; the collector is asked each week. `feeSplitTotal` means the pitch cost is split among those who played. |
| Stripe today | `src/lib/stripe.ts`, `src/app/api/stripe/webhook/route.ts`, `applyCheckoutEvent` in `src/lib/payment-flow.ts` | Connect Express accounts for collectors, **direct charges** on the connected account, 1% `application_fee_amount`. The webhook verifies with the single `STRIPE_WEBHOOK_SECRET` (the **Connected accounts** endpoint). `applyCheckoutEvent` ignores a session without `matchId` and `userId` metadata (~121). |
| Public route | `src/lib/public-paths.ts` ~49 | Everything under `/api/stripe` is already public (signature is the auth). |
| Removal from a live group | `handleGroupLeaveForSelfRemoval` in `whatsapp-bot/src/bot-added.ts` (~290) | The Pi tells the server only when MatchTime is removed from a **silent** group. Removal from a live club's group is not reported today. |
| Price on the site | `src/components/landing/landing-page.tsx` ~553, ~608, ~640; `src/app/help/admin/page.tsx` ~10, ~43 | "£9.99 a month per WhatsApp group ... first month is free", the split advice ("With 20 players, that works out at about 50p a player", landing ~608, help ~49), and "remove MatchTime from the group any time to stop". |
| Copy tests that bind this plan | `src/app/__tests__/public-copy.test.ts`; `src/lib/__tests__/self-join-copy.test.ts` (~100); `copy-golden.test.ts` (R185) | Public pages: no fee talk, "about 50p a player" required and "25p" forbidden on the landing page, and **never claims MatchTime collects the club fee** (`/(collects?\|charges?) the (club\|monthly) fee (for you\|automatically)\|automatically (collect\|split\|charge)/`). The "you're live" DM `sj_dm_approved` must **end with** "Your first month is free." and contain **no amount** (no £, no decimals). |
| Crons | `vercel.json` | Seven crons; none for billing. |

One club has exactly one group (`Organisation.whatsappGroupId`), so "per group" and "per
club" are the same thing here.


### 1.1 What the games-played charge rests on (verified at `b60c941`)

| Fact | Where | What it means for counting |
|---|---|---|
| Match statuses are `UPCOMING`, `TEAMS_GENERATED`, `TEAMS_PUBLISHED`, `COMPLETED`, `CANCELLED` | `enum MatchStatus`, `prisma/schema.prisma` ~10 | Only `COMPLETED` can be "played"; `CANCELLED` never is. |
| `COMPLETED` is written **automatically** for every open match once kickoff plus `Activity.matchDurationMins` has passed, for a serving club, **whether or not anyone played** | `completeFinishedMatches` in `src/lib/match-completion.ts` (~35 to 63), run every 15 minutes by `/api/cron/complete-matches` | `COMPLETED` alone does not prove the game happened: a week nobody turned up for, and nobody cancelled, is still `COMPLETED`. Hence the "a player said IN or a score was entered" test in 2A.3. |
| `COMPLETED` is also written when a score is entered | `api/whatsapp/score/route.ts` ~105, `src/lib/owner-deps.ts` ~83 | A score is evidence of play. |
| `COMPLETED` is written **quietly** (`postMatchEndFlow: false`) for matches that passed while a club was billing-paused, when it resumes | `resumeClubTx` in `src/lib/club-billing.ts` (~236 to 275) | These were not served by MatchTime and must not count as played (2A.3, pause spans). |
| `CANCELLED` is written in exactly two places: an admin's `cancelMatch` (refuses a `COMPLETED` match) and the admins' bulk cancel `bulkCancelMatches` | `src/app/actions/matches.ts` ~179 to 195; `src/app/actions/block-bookings.ts` ~290 | **No code cancels a match for low turnout today.** If such a rule is added later it writes `CANCELLED`, and the count needs no change. |
| Matches are deleted only as **empty, unplayed shells** (no attendance, ratings, MoM votes or teams) when a block booking is deleted, or when a whole club is wiped | `deleteBlockBooking` in `actions/block-bookings.ts` ~400 to 430 (`partitionBlockMatchesForDeletion`); `src/lib/wipe-org.ts` ~184 | A deleted match was never played. Its week still counts as scheduled when it falls on the weekly game (2A.2). |
| `Match.isHistorical` marks synthetic anchors for backfilled MoM votes | `schema.prisma`, `Match.isHistorical` | Never counted, either way. |
| `switchMatchFormat` re-points a match's `activityId` to the other format's activity and leaves the old activity active; the generator dedupes on the recurring fixture (org, venue, weekday) plus the match instant within 90 minutes | `src/lib/match-slot.ts` (`SLOT_TIME_TOLERANCE_MS`, `isSameRecurringFixture`); memory note on format-switch ghosts | Counting must never key on `activityId`. A ghost or a format pair inside 90 minutes is **one** game. |
| A billing-paused club gets no fixtures and no automatic completion | `fixtureSkipReason` (`org-billing-paused`) in `src/lib/org-lifecycle.ts` ~136; `servingClubWhere()` in `match-completion.ts` | Paused weeks have no match rows, so "scheduled" cannot come from match rows alone (2A.2). |
| Dormancy is `Organisation.dormantAt` (set or not); a dormant club gets no fixtures | `isOrgDormant`, `org-lifecycle.ts` ~86 | A whole dormant month plays nothing and pays nothing. |
| Kemal's mute (`whatsappBotEnabled` off) does **not** stop fixtures or completion | `fixtureSkipReason` and `servingClubWhere` do not read it | A muted club's games count as usual; set the club Free if a mute should also stop the fee. |
| Each `Activity` has `dayOfWeek`, `time` ("21:30", London), `venue`, `isActive`, `createdAt` | `model Activity` | The weekly calendar of 2A.2 is built from these. |
| Billing as built (B1 to B5): states, gates, the free month, reminders, grace and pause, the billing page, a flat subscription per club (Checkout in subscription mode, Smart Retries, Portal), the billing webhook, the hourly cron | `club-billing-rules.ts`, `club-billing.ts`, `club-billing-stripe.ts`, `stripe-billing.ts`, `club-billing-scheduler.ts`, `club-billing-schedule-rules.ts`, `club-billing-dms.ts`, `club-billing-removal.ts`, `api/stripe/billing-webhook`, `api/cron/billing` | Section 5.5 lists what stays and what changes. Nothing in Stripe live mode exists for it yet. |

---

## 2. Money separation

- **Club fee:** one Stripe **Customer** per club on the **platform account** (the account
  `STRIPE_SECRET_KEY` already points at), whoever's card is on it, and **one invoice per
  billing month** with something to charge. No `stripeAccount` header, no Connect, no
  `application_fee_amount`. The money is MatchTime revenue, like the 1% platform fee.
- **Match fees:** unchanged. Direct charges on each collector's connected account, the
  Connect webhook, `applyCheckoutEvent`. Nothing here changes what a player pays or what
  the collector receives (section 14).
- **Two webhooks, two secrets, two routes** (as built in B3):
  - `/api/stripe/webhook`, **Connected accounts** scope, `STRIPE_WEBHOOK_SECRET`;
  - `/api/stripe/billing-webhook`, **Your account** (platform) scope,
    `STRIPE_BILLING_WEBHOOK_SECRET`.
  An event delivered to the wrong route fails signature checking and is refused.
- **Defence in depth:** every club fee Checkout session, Customer and invoice carries
  `purpose: "club-fee"` and `orgId`, never `matchId` or `userId`, so a misrouted event is
  ignored by `applyCheckoutEvent`, and the billing handler ignores anything without
  `purpose: "club-fee"` (`isClubFeeMetadata` in `stripe-billing.ts`).
- **Card details:** entered only on Stripe Checkout. We store the customer id, the
  payment method id, who added the card, card brand and last four. Nothing else.

**Check before go-live (memory note, not verified):** an old **platform-scoped** endpoint
(`we_1TgQL6...`) may still point at `/api/stripe/webhook`. Delete it in the dashboard
before switching billing on (rollout step 3).

---

## 2A. What a club pays: games played, in arrears

### 2A.1 The billing month

**Recommended: the club's own month, starting when its free month ends.**

- **Month 1** starts at `trialEndsAt` (approval plus 30 days) and ends at **00:00 London
  on the same day of the next month**. Every later month runs from 00:00 London on that
  day to 00:00 London on that day of the following month. The day is the London date of
  `trialEndsAt`; a 29th, 30th or 31st is clamped to the last day of a shorter month and
  comes back the month after (every boundary is worked out from the first one, never by
  chaining). Examples: free month ends 1 Nov 14:00, months are 1 Nov 14:00 to 1 Dec
  00:00, then 1 Dec to 1 Jan (exactly calendar months); ends 17 Oct, months are 17 Oct to
  17 Nov, 17 Nov to 17 Dec; ends 31 Jan, months end on 28 Feb (or 29), 31 Mar, 30 Apr.
- **Shown to organisers as dates:** "1 Nov to 30 Nov", "17 Oct to 16 Nov" (the last day
  shown is the day before the next month starts). Like a phone contract: "your MatchTime
  month starts on the 17th".
- **Charged the morning after:** the month is closed at the first hourly billing run at
  least **6 hours** after it ends and inside the DM hours (10:00 to 20:00 London), so in
  practice **10:00 London on the first day of the next month**. Six hours covers the last
  evening game finishing and the 15 minute completion cron.

**Why not calendar months.** A club's free month ends on any day, so its first calendar
month would be a part month: a club whose free month ends on 17 Oct and plays both of the
two Tuesdays left in October would pay the full £9.99 for two weeks, because the formula
only looks at played over scheduled. Calendar months would need a second factor (days
covered out of days in the month) on the first month and on the last one, which is harder
to explain and to test. The club's own month has **no part months**, every charge is
"games played out of games scheduled in a full month", and the DM simply names the two
dates. The one alternative worth having is in decision 1 (15.2): calendar months for
everyone, with the free month stretched to the end of the calendar month it ends in.

**The last month.** "Stop paying" ends billing at the end of the current month (2A.6,
4.2), so the last month is also a full month and is charged the normal way. Removal from
the group and a suspension are the only ways a month ends early, and both are handled by
the count itself (the weeks after them count as scheduled and not played) or waived.

### 2A.2 Scheduled

The **scheduled games** of a month are the union of two sets, worked out by a pure
`countClubMonth(input)` in a new `src/lib/club-billing-cycle-rules.ts` (no database):

1. **The weekly calendar.** The club's weekly game slots: every `Activity` that is active
   when the month is closed, or that has at least one match in the month, grouped exactly
   as `clubFeeTip` already groups them (`weeklySlots` in `club-billing-rules.ts`: same
   weekday, kickoff times within 90 minutes is **one slot**, so a 7-a-side and 5-a-side
   pair is one game). For each slot, every date in the month on that weekday, at the
   slot's earliest kickoff time in London, from the slot's earliest `Activity.createdAt`
   on, is one scheduled game. A month always has 4 or 5 of each weekday, so a club with one
   weekly game has 4 or 5 scheduled games.
2. **The match rows.** Every `Match` of the club's activities with `isHistorical = false`
   and its kickoff (`Match.date`) inside the month, **whatever its status** (upcoming,
   completed, cancelled), deduplicated by the recurring fixture key (venue and weekday,
   `isSameRecurringFixture`) plus kickoff within 90 minutes (`SLOT_TIME_TOLERANCE_MS`), so
   a format-switch ghost and its real match are one game.

A match that falls within 90 minutes of a calendar game on the same weekday **is** that
game (counted once). A match that does not (an extra Saturday friendly, a game moved to
another day) adds one scheduled game.

What this does with each case:

| Case | Scheduled | Played |
|---|---|---|
| A normal week | 1 | 1 if played (2A.3) |
| A week the admin cancelled (`CANCELLED`) | 1 | 0 |
| A week nobody turned up for and nobody cancelled (auto `COMPLETED`, no IN, no score) | 1 | 0 |
| A week deleted as an empty shell (block booking deleted) | 1 if on the weekly calendar, else 0 | 0 |
| A format switch, or a ghost match from the old format | 1 (deduped) | 1 if either row was played |
| Two weekly games (Tuesday 5-a-side, Thursday 7-a-side) | 4 or 5 each, summed (8 to 10) | each counted |
| A week while MatchTime was paused for billing (no match row is generated) | 1 (from the calendar) | 0 |
| A summer break (club dormant, or activity left active but no games) | 1 per week from the calendar | 0 |
| A summer break with the activity switched off (`isActive` false) and no matches in the month | 0 | 0 |
| A match moved from Tue 31 Oct to Thu 2 Nov | Oct: the Tuesday counts (not played); Nov: the Thursday adds one | Nov: 1 if played |
| A new weekly game started mid month | its weeks from the activity's `createdAt` | each counted |
| A weekly game switched off mid month that had a match this month | the whole month's weeks of it | only those played |
| A synthetic historical match (`isHistorical`) | 0 | 0 |
| Kemal's mute (`whatsappBotEnabled` off) | as normal | as normal (1.1) |

Every approximation in the table goes the club's way: an unknown week counts as scheduled
and not played, which lowers the fee, never raises it.

### 2A.3 Played

A scheduled game is **played** when at least one of its match rows:

1. is `COMPLETED`, and `isHistorical` is false; and
2. kicked off inside the month; and
3. did **not** kick off while the club was billing-paused (a **pause span**, below); and
4. shows the game happened: at least one `Attendance` with status `CONFIRMED`, or a
   score (`redScore` and `yellowScore` both set), or the club tracks no attendance
   (`Organisation.featureAttendance` false, a MoM-only club, which has no IN list to
   show).

**Pause spans.** `setBillingState` (the one writer, `club-billing.ts`) writes a
`BillingEvent` row `mt.paused` when a club moves to `paused` and `mt.resumed` when it moves
out, in the same transaction, the way `mt.club-exempt` is already written by `setClubPlan`
(ids `mt_paused_<orgId>_<ms>` and `mt_resumed_<orgId>_<ms>`, never colliding with Stripe's
`evt_...`). A span runs from a `mt.paused` to the next `mt.resumed` (or to now). This
excludes the matches `resumeClubTx` completes quietly, without a new column on `Match`.

Played can never exceed scheduled: every played game is a member of the scheduled set.

### 2A.4 The fee

```
fee (pence) = floor( monthPrice x played / scheduled )
```

- `monthPrice` is the plan's monthly maximum: **999** for Standard, `billingPricePence`
  for Custom. When the plan changed during the month, the **lower** of the price when the
  month started (stored on the month's row, 3.6) and the price when it closes.
- **Rounded down to the whole penny**, so a charge is never above the exact share.
- **No charge at all** (no Stripe invoice, nothing in the club's Stripe history) when
  `played` is 0, when `scheduled` is 0, or when the fee is **under 30p** (Stripe's minimum
  for a GBP card charge; Standard never gets there (its smallest charge, one game of
  fifteen with three weekly games, is 66p), only a low Custom plan with few games played,
  for example one of ten on £2.50). Each is recorded on the month's row with its reason, and nothing is carried
  over to the next month.
- Free plan and exempt clubs have no months at all.

**Kemal's examples, and more (Standard £9.99 unless stated):**

| Played / scheduled | Exact | Charged |
|---|---|---|
| 3 of 4 | 749.25p | **£7.49** |
| 4 of 5 | 799.2p | **£7.99** |
| 0 of 4 | 0 | **nothing** (no invoice) |
| no games at all (0 of 0, or a summer break 0 of 4) | 0 | **nothing** |
| 4 of 4, 5 of 5 | 999p | £9.99 |
| 2 of 4 | 499.5p | £4.99 |
| 1 of 5 | 199.8p | £1.99 |
| 7 of 9 (two weekly games) | 777p | £7.77 |
| Custom £5, 3 of 4 | 375p | £3.75 |
| Custom £1, 1 of 5 | 20p | nothing (under 30p) |

`floor` and "round half up" agree on both of Kemal's examples; `floor` is chosen because
it never charges a fraction of a penny more than the share (2 of 4 is £4.99, not £5.00).

### 2A.5 What a club sees in money terms

For a weekly 5-a-side on Standard: every game played costs the club **£9.99 / 4 = £2.50**
in a 4 week month and **£2.00** in a 5 week month, and a week not played costs nothing.
That is where the "about 25p a player per game" tip comes from (7.2): it is now the
**most** a game can cost, not an average.

### 2A.6 Edge cases at a glance

| Situation | What happens |
|---|---|
| The grace week (days 30 to 37) | It is the start of month 1. Its games count in month 1. |
| No card by day 37 (paused, no card) and never added | Month 1 closes with no card on file: recorded `no-card`, **not charged**, nothing chased (at most a week or so of games). Later months play nothing (paused) and charge nothing. |
| Card added while paused (no card) | MatchTime resumes at once, **nothing is charged at that moment**; the current month's games (including any before the pause) are charged at its end. |
| Payment failed | `past_due`, 7 days of grace with retries; the next month keeps counting as usual. |
| "Stop paying" | Billing ends at the end of the current month; MatchTime works until then; that month is charged normally; then `paused (cancelled)`. "Keep paying" undoes it before then. |
| "Stop paying" during the free month | Same as B3's cancel inside the free month: the card is removed, the club is back in `trial` with the same end date, and the normal reminders follow. |
| MatchTime removed from the group | `paused (removed)` at once (B5). The games played before the removal are charged at the end of that month (the weeks after it count as scheduled, not played). No later month charges anything. |
| Suspended by you | The open month is **waived** (closed, no charge), no later months while suspended. Any unpaid earlier invoice is left for you to void or keep in Stripe. |
| Plan set to Free | The open month is waived; any unpaid club fee invoice is **voided** (forgiven); no more months. |
| Plan changed between Standard and Custom | The lower of the two prices applies to the month it changed in. |
| Club deleted or wiped | No months; any open invoice is voided by you in Stripe (rare, logged on `/admin/health`). |

---

## 3. Data model

B1 built 3.1 to 3.5 (all live in the schema, dark). The games-played charge adds one table
(3.6), reuses two `ClubBilling` columns and leaves the subscription columns unused.

### 3.1 `Organisation`: three columns (the gate and the plan)

```prisma
/// Club fee billing (2026-10-01). Plan: MDs/club-fee-billing-plan-2026-10-01.md.
/// "exempt" | "trial" | "grace" | "subscribed" | "past_due" | "paused".
/// DEFAULT "exempt": every club that exists when this lands (Sutton FC included)
/// is never billed and never paused. Only an approval with BILLING_ENABLED on
/// moves a club to "trial". Single writer: src/lib/club-billing.ts.
billingStatus     String  @default("exempt")
/// "standard" | "free" | "custom". Set by the platform owner on /admin/clubs.
billingPlan       String  @default("standard")
/// Monthly price in pence when billingPlan = "custom" (e.g. 500). NULL otherwise.
billingPricePence Int?
```

CHECK constraints: `billingStatus` in the six values; `billingPlan` in the three;
`billingPlan = 'custom'` if and only if `billingPricePence IS NOT NULL AND
billingPricePence BETWEEN 100 AND 999`; `billingPlan = 'free'` implies
`billingStatus = 'exempt'`.

`billingStatus` lives on `Organisation` because it is a **gate**: it must sit in the
same `where` fragments as `approvalStatus` with no join.

There is **no new "who pays" column.** The person asked to pay is always worked out
from `paymentHolderId` and the memberships at the moment it is needed (section 4.5), so
changing the collector in Settings is the only step.

**Under the games-played charge** the plan columns keep their meaning, with one change of
words: `billingPricePence` is the club's **monthly maximum**, scaled by played over
scheduled like Standard's £9.99. The CHECK range (100 to 999) stays.

### 3.2 `ClubBilling`: one row per billed club (as built), and what changes

As built in B1 (`model ClubBilling` in `schema.prisma`): `trialStartedAt`, `trialEndsAt`
(written once), `graceEndsAt`, `stripeCustomerId`, `stripeSubscriptionId`,
`stripeSubscriptionStatus`, `stripePriceId`, `currentPeriodEnd`, `cancelAtPeriodEnd`,
`stripePaymentMethodId`, `cardBrand`, `cardLast4`, `cardHolderUserId`, `paymentFailedAt`,
`pausedAt`, `pausedReason`, `billingCountry`, `cardCountry`, `vatCountryCheck`,
`resumedAt`.

Under the games-played charge:

- **Kept as they are:** the trial and grace dates, the customer id, the card fields, the
  card holder, the payment failure and pause fields, the VAT country fields.
- **Reused:** `cancelAtPeriodEnd` now means "Stop paying was pressed: billing ends when
  the current month ends", and `currentPeriodEnd` mirrors the end of the current billing
  month (for the pages). No rename in the first slice, to keep the migration additive; a
  doc comment says what they mean now.
- **Unused:** `stripeSubscriptionId`, `stripeSubscriptionStatus`, `stripePriceId`. They
  stay NULL for every club (no club ever had a live subscription: `BILLING_ENABLED` was
  never on in production) and are dropped in a later cleanup migration once P2 has been
  live for a while.

### 3.3 New `BillingEvent`: webhook idempotency and audit

```prisma
model BillingEvent {
  id          String    @id            // Stripe event id, evt_...
  type        String
  orgId       String?
  receivedAt  DateTime  @default(now())
  processedAt DateTime?
  error       String?   @db.Text
  @@index([orgId, receivedAt])
}
```

Two new MatchTime-written types (no schema change): `mt.paused` and `mt.resumed`, the
pause spans of 2A.3, written by `setBillingState` in the transition's own transaction.

### 3.4 `BillingNotice`: one DM per club, per kind, per cycle (as built)

As built in B1 and B4 (`@@unique([orgId, kind, cycleKey])`, claim first, then queue). Two
new kinds, both keyed by the billing month's id:

- `month-charged`: the receipt DM to the billing contact once the month's invoice is
  paid (7.3);
- `month-free`: the "no games, nothing to pay" DM, only for the **first** zero month in a
  row, so a long summer break sends one, not one a month.

Insert first, then queue the DM: a retried cron or a re-delivered webhook can never DM
twice about the same thing.

### 3.5 PlatformJob

No schema change. One new purpose, `"billing"`, added to `PLATFORM_DM_PURPOSES` in
`platform-jobs.ts`, and `src/lib/club-billing.ts` added to the source guard's allowlist.
The collector and the owner are both club members with a phone, so the existing
recipient rule (rule 12: a number MatchTime already knows) passes.

The admin channel's club fee tip does **not** use the platform channel: it goes through
`sendAdminNotice`, like every other message a club's admins get (section 7.1).

### 3.6 New `ClubBillingMonth`: one row per billing month

```prisma
/// One billing month of a billed club (plan 2A). Opened by the billing cron
/// when the month starts, closed the morning after it ends. Single writer:
/// src/lib/club-billing-months.ts.
model ClubBillingMonth {
  id                 String       @id @default(cuid())
  orgId              String
  org                Organisation @relation(fields: [orgId], references: [id], onDelete: Cascade)
  /// 1 = the first month after the free month.
  index              Int
  startsAt           DateTime
  /// Exclusive: 00:00 London on the anchor day of the next month.
  endsAt             DateTime
  /// The plan's monthly maximum when the month opened (pence).
  priceAtStartPence  Int
  /// "open" | "closing" | "no-games" | "below-minimum" | "waived" | "no-card"
  /// | "invoiced" | "paid" | "failed" | "void"
  status             String       @default("open")
  scheduled          Int?
  played             Int?
  /// The maximum used: the lower of the price at start and at close.
  pricePence         Int?
  amountPence        Int?
  /// Why it was waived ("free-plan" | "suspended" | "removed-before-start" ...).
  reason             String?
  /// The games counted: one entry per scheduled game, with its match ids,
  /// kickoff, played or not and why. For the receipt page and any dispute.
  games              Json?
  stripeInvoiceId    String?      @unique
  closedAt           DateTime?
  paidAt             DateTime?
  refundedPence      Int          @default(0)
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt

  @@unique([orgId, index])
  @@index([status])
}
```

CHECK constraints: `status` in the ten values; `amountPence` is NULL or at least 30;
`status = 'invoiced' or 'paid' or 'failed'` implies `stripeInvoiceId IS NOT NULL`.

**Closing is a compare-and-set** (`open` to `closing`, then to its final status), so two
cron runs can never both close or both charge the same month; the Stripe calls also carry
an idempotency key per month (5.2).

---

## 4. States, transitions and who pays

### 4.1 Day numbers

Day 0 is `approvedAt`. Reminders go out at or after **10:00 London** on their day (as built
in B4, `club-billing-schedule-rules.ts`). "The payer" is the billing contact of 4.5.

| Day | Condition | Action |
|---|---|---|
| 0 | `BILLING_ENABLED`, plan not Free, no `ClubBilling` row yet | `trial`; create `ClubBilling` |
| 21 | still `trial`, no card | DM "trial-21" with the club fee tip; tip to the admin channel (7.2) |
| 28 | still `trial`, no card | DM "trial-28" |
| 30 (`trialEndsAt`) | no card | to `grace`; DM "trial-ended"; banner. **Month 1 opens** whatever the card state |
| 30 | card on file | stays `subscribed` (it moved there when the card was added). **Month 1 opens** |
| 37 (`graceEndsAt`) | still `grace` | to `paused` (no-card); DM "paused" |
| about 61 | month 1 closed (the morning after it ends) | charge for its games, or nothing (2A.4); receipt DM |

**What changed from the flat fee:** adding a card in the free month (or in grace) now
charges nothing at that moment, and the first charge is about day 61 instead of day 30.
**The card is still required by the end of the free month** (grace, then quiet), as built:
charging in arrears means a club uses a whole month before its first payment, so a card on
file before that month starts is the protection. The reminders say "add a card", the
copy changes only in what it says about when and how much (7.3).

### 4.2 The club (`Organisation.billingStatus`)

The six states stay (`exempt`, `trial`, `grace`, `subscribed`, `past_due`, `paused`), as do
`nextBillingState` (pure, `club-billing-rules.ts`) and the one writer `setBillingState`
with its compare-and-set. **`subscribed` now means "a card is on file and nothing is
overdue"**, not "a Stripe subscription is active".

| From | Event | To | Side effects |
|---|---|---|---|
| (default) | migration, approval with flag off, or plan Free | `exempt` | none, ever |
| `exempt` (self-join, never trialled) | Kemal "Start free month" | `trial` | `ClubBilling` with trial from now |
| `trial` | card saved (Checkout setup mode complete) | `subscribed` | DM "card-added"; nothing charged |
| `trial` | day 30 | `grace` | DM "trial-ended" |
| `grace` | card saved | `subscribed` | DM "card-added"; nothing charged |
| `grace` | day 37 | `paused` (no-card) | DM "paused" |
| `subscribed` | month closed, invoice paid | `subscribed` | DM "month-charged" |
| `subscribed` | month closed, nothing to charge | `subscribed` | DM "month-free" (first zero month in a row only) |
| `subscribed` | `invoice.payment_failed` | `past_due` | `paymentFailedAt`, `graceEndsAt = +7d`; DM "payment-failed"; banner |
| `past_due` | `invoice.paid` | `subscribed` | clear failure fields; DM "month-charged" |
| `past_due` | `graceEndsAt` passes | `paused` (payment-failed) | DM "paused" |
| `paused` (payment-failed) | "Update card and pay", invoice paid | `subscribed` | **resume** (4.4); DM "resumed" |
| `paused` (no-card) | card saved | `subscribed` | **resume**; DM "card-added" with the resumed wording; nothing charged now |
| `subscribed` | the payer presses **Stop paying** | `subscribed`, `cancelAtPeriodEnd` | page shows "Ends on {date}"; no DM; **Keep paying** undoes it |
| `subscribed` (stopping) | the month closes | `paused` (cancelled) | the month is charged as usual first; DM "paused" (cancelled wording) |
| `trial` (card on file) | Stop paying inside the free month | `trial` | card removed; same end date; reminders resume (as B3's cancel inside the free month) |
| `paused` (cancelled) | card saved, or **Start again** with the card on file | `subscribed` | resume; a new month count continues on the same anchor day |
| `trial`, `grace`, `subscribed`, `past_due` | MatchTime removed from the group (B5) | `paused` (removed) | no DM; this month's games so far charged when it ends |
| `paused` (removed) | MatchTime re-added | `subscribed` when a card is on file and no club fee invoice is unpaid; `trial` while the free month runs; else `paused` (no-card or payment-failed) | resume when serving again |
| any | Kemal sets plan Free | `exempt` | open month waived; unpaid club fee invoices voided; resume if paused |
| `exempt`, Free, free month already had | Kemal sets Standard or Custom | `trial` while the original `trialEndsAt` is ahead, else `grace` with 7 days from now | as built (B3) |
| any billed | Kemal suspends | unchanged | open month waived; no months while suspended |

Events that disappear with the subscription: `subscription-ended` (replaced by the month
close after Stop paying, event `billing-stopped`) and `subscription-unpaid` (the 7 day
grace end already pauses a `past_due` club). The `re-added` event's `subscription:
"paying" | "unpaid"` input becomes `card: "ok" | "unpaid" | null`, read from our own rows.

**The free month happens once per club** (unchanged): `trialEndsAt` is written once and
never reset.

### 4.3 How "quiet" reuses the existing gates

The paused state must not touch `whatsappBotEnabled`. That is Kemal's mute switch and,
per `org-lifecycle.ts`, must never be read as a lifecycle state; writing it from billing
would also mean a resume could unmute a club Kemal muted by hand. Instead:

1. **One new fragment and one helper**, next to the approval ones in
   `club-approval-state.ts`:
   - `SERVING_CLUB_WHERE = { approvalStatus: "approved", billingStatus: { not: "paused" } }`
   - `isClubOperational(org)` becomes approved **and** not dormant **and** not
     billing-paused. Every caller listed in section 1 picks it up with no other change.
   - Both read `isBillingPaused(org)`, which returns **false whenever `BILLING_ENABLED`
     is off**. That is the one kill switch (section 11).
2. **Pi stops listening and stops polling.** `/api/whatsapp/orgs` uses
   `SERVING_CLUB_WHERE` instead of `APPROVED_CLUB_WHERE` in the orgs query, so the group
   leaves the monitored set and `due-posts` is no longer polled for it.
3. **Pi drops its messages.** `loadSilentGroupIds` adds paused clubs' groups to
   `silentGroups`, and `computeSilentGroups` stops treating a paused club's group as
   "approved, never silent". Nothing is forwarded, so nothing reaches `analyze` or a
   model.
4. **Server refuses anyway.** `due-posts` (~184) and `analyze` (~478, ~4186) add
   `billingStatus: { not: "paused" }` to their org lookups: a stale Pi gets a 404 or
   "ignored", never a post or a model call.
5. **AI allowance is $0.** `aiAllowanceUsd` returns 0 for a paused club, checked right
   after the approval check and before `AI_DAILY_CAP_DISABLED` and `aiDailyCapUsd`, so
   neither lifts it.
6. **Crons skip it.** The direct org queries (`bot-health`, `none-bucket-shadow`,
   `extract-squads`, `match-completion`, `rolling-squad`) switch to `SERVING_CLUB_WHERE`;
   `fixtureSkipReason` gains `"org-billing-paused"`, so no fixtures are generated.
   `crons-skip-unapproved.test.ts` is extended to assert the new fragment.
7. **DMs from players go nowhere near a model.** In `dm-reply` (~410), the rail
   `onlyUnapprovedClubs` becomes "only clubs that are not serving": silence. (The
   payer's way back is the link in their DM and the billing page.)

What deliberately keeps working while paused:

- **The website**, signed in: data is all there, read and edit. Banner on top. The
  billing page (4.5) works, so the payer can add a card.
- **Players paying the collector** for a match already played (`/pay/<matchId>`). That
  is the players' own money owed to the collector; blocking it would hurt the club, not
  MatchTime. Chasers stop, because they post through `due-posts`.
- **Leaving the group cannot happen through billing.** `queuePlatformLeaveGroup` still
  refuses any group an approved club owns (`platform-jobs.ts` ~203), paused or not.

### 4.4 Resume

`resumeClub(orgId)` in `club-billing.ts`, called by `setBillingState` on any move out of
`paused`:

1. Status to the new state, `resumedAt = now`.
2. **Drop stale work.** Unsent `BotJob`s for the org with `sendAfter` null or in the
   past, created before `resumedAt`, are marked sent and logged as dropped (none should
   exist because crons skipped the club, but a job queued in the minute before the pause
   could). Future-dated personal reminders are kept.
3. **No catch-up posts.** Matches whose kickoff passed during the pause are completed
   quietly (the same write `completeFinishedMatches` makes, with no post-match flow), so
   the first poll after resume does not post a MoM poll or rating DMs for a match two
   weeks old. The slice pins this with a `due-posts` test using `x-test-now`.
4. The Pi picks the group up on its next org refresh (a few minutes). Nothing is posted
   in the group to announce the resume; the next scheduled post is the first thing the
   group sees.

Group messages sent during the pause were never forwarded, so there is no backlog and no
AI spend on resume. Players who said IN during the pause are not counted; the "resumed"
DM tells the payer so (section 7).

### 4.5 Who pays: the money collector (Kemal, 2026-10-01)

**Two roles, both worked out on demand** by pure functions in `club-billing-rules.ts`:

- **The billing contact** (`billingContact(org, members)`): the person every card and
  payment DM goes to, and who may add or replace the card.
  1. The money collector (`paymentHolderId`), when they are a current member
     (`leftAt` null) with a phone. `setPaymentHolder` already refuses a collector
     without a phone (`actions/payments.ts` ~151), so this is the normal case.
  2. Otherwise the club's OWNER: the first current OWNER membership with a phone, the
     same lookup `admin-group-link.ts` ~383 uses. Every DM that asks for a card then
     carries the "set a money collector" nudge (7.3).
  3. Neither: no DM, logged and counted on `/admin/clubs` ("no billing contact").
- **The card holder** (`ClubBilling.cardHolderUserId`): whoever added the card that is
  on file now. Normally the same person as the contact; different only between a
  collector change and the new collector putting their card on.

The DM recipient is resolved **when the DM is queued**, never stored, so a collector
named on day 25 gets the day 28 and day 30 reminders without any extra step.

**The billing page: `/billing/[orgId]`** (recommended; decision 4). A collector is often
a player, and `/admin/*` redirects every non-admin (`admin/layout.tsx`). Giving a player
an admin role to pay would open every admin page. Instead, one small page **outside
`/admin`**, built exactly like the collector's existing `/collect/[matchId]` page
(`src/app/collect/[matchId]/page.tsx`):

- **Guard** `requireClubBillingAccess(userId, orgId)` in `club-billing.ts`, modelled on
  `requireMatchCollectorOrAdmin` (`actions/payments.ts` ~262). It returns:
  - `"contact"` when `userId` is the billing contact: full page, all buttons;
  - `"card-holder"` when `userId` is the card holder but no longer the contact (an old
    collector): sees that their card is still paying, and one button, **Remove my card**
    (below);
  - `"viewer"` when `userId` is an org OWNER or ADMIN (`isOrgAdmin`): the status, no
    buttons;
  - otherwise it throws and the page redirects to `/`, as `/collect` does.
  Superadmins pass as viewers through `isOrgAdmin`.
- **Every server action re-checks the guard** (`startClubCheckout`, `startCardReplace`,
  `removeMyCard`, and under the games-played charge `stopPaying` and `keepPaying`; the
  Portal action `openClubPortal` retires, 5.5), never trusting that the page was shown.
- **The link:** `buildAdminLink({ userId: contactId, orgId, nextPath:
  "/billing/<orgId>", ttlSeconds: BILLING_LINK_TTL })`. `buildAdminLink` already accepts
  any same-origin path and pins the club (`admin-link.ts`, `org.ts` ~28); its name says
  who it was first written for, nothing in it is admin specific. The DM goes only to that
  user's own phone, as every signed-in link must.
- **TTL:** recommend `BILLING_LINK_TTL` = 9 days (a constant in `club-billing-rules.ts`),
  so the day 21 link still works when the day 28 reminder arrives, rather than the
  48 hour default. That is far under the 365 day ceiling for `sign-in` tokens
  (`MAX_TTL_BY_PURPOSE`). An expired link lands on `/login`, and the phone code sign-in
  then reaches the same page.
- **What the link grants:** a normal session as that user, exactly what the
  `/collect/<matchId>` links collectors already receive grant today. A player collector
  can reach `/billing/<orgId>` and the pages any player can; `/admin/*` still redirects
  them. **No new token purpose, no new auth scope, no admin role for the collector.**

**When the collector changes.** The Stripe Customer, its billing months and the plan stay
with the club. Only the card and the contact move.

1. An admin picks a new collector in Settings (`setPaymentHolder`, unchanged rules). For
   a billed club (`billingStatus` not `exempt`), it also calls
   `onBillingContactChanged(orgId)` in `club-billing.ts`, after the update.
2. The new collector gets **one** DM, "payer-changed" (claimed in `BillingNotice` with
   their user id, so changing back and forth never repeats it): they now look after the
   club fee, with the club fee tip and their billing link. Wording depends on the state:
   - no card yet (`trial`, `grace`, `paused`): "add a card before {date}" (the scheduled
     reminders then follow as usual);
   - a card on file (`subscribed`, `past_due`): "{oldName}'s card keeps paying until you
     put yours on, whenever suits you".
3. **Until they do, the old card keeps paying.** Nothing is cancelled, nothing changes
   for the club. Admins see "Paid with {oldName}'s card" on the settings card.
4. **Replacing the card:** on `/billing/<orgId>` the new collector taps **Use my card
   instead**. That opens Stripe Checkout in **setup mode** on the club's Customer
   (`mode: "setup"`, `metadata: { orgId, payerUserId, purpose: "club-fee", action:
   "replace-card" }`, billing address required). On its `checkout.session.completed`
   the webhook sets the new payment method as the Customer's default
   (`customers.update({ invoice_settings.default_payment_method, email, name })`; as built
   in B3 it also updated the subscription, which goes with P2), so receipts and the next
   month's invoice go to the new collector, then updates `cardHolderUserId`,
   `stripePaymentMethodId`, brand, last four and the VAT country check. An unpaid club fee
   invoice is paid on the new card at once (`invoices.pay`).
   Setup mode rather than the Customer Portal, because the Portal would show the new
   collector the old collector's card and invoice history (with the old billing
   address), and lets them cancel before they have a card of their own on.
5. **The old card: recommend removing it automatically** (decision 5) once the new one
   is the default: `paymentMethods.detach(oldPm)`, then one DM "card-replaced" to the old
   card holder: "{newName} now pays the MatchTime fee for {club}; your card has been
   removed and won't be charged again." Why: after the change the old collector can no
   longer manage the club's billing, and leaving a card they cannot see on a club they no
   longer collect for is the thing people complain to banks about. Keeping it as a
   backup would need their agreement, which a DM cannot reliably get.
6. **The old card holder can stop paying sooner.** Until the new card is on, the old
   holder may open `/billing/<orgId>` (guard role `"card-holder"`) and tap **Remove my
   card**. That detaches it; the new collector gets the "payer-changed" wording for a
   club with no card ("add a card before {next payment date}"), and if the next invoice
   finds no card the normal payment-failed path runs (DMs to the contact, 7 days, then
   quiet). Recommend offering it (decision 5): someone must always be able to stop
   charges to their own card.
7. **Same flow when no collector was set and the owner paid:** naming a collector later
   is a collector change from the owner to them. The owner's card keeps paying until
   the collector puts theirs on, then is removed and the owner told.

**No Customer Portal under the games-played charge** (5.2). B3 opened the Portal (change
card, cancel) for the contact whose own card is on file, with invoice history off.
Without a subscription there is nothing for it to cancel: **Change card** is the same
setup-mode session as "Use my card instead", and **Stop paying** is our own button. Each
payer still gets every receipt and invoice by email from Stripe, at the address on the
Customer, which follows the current card, and the billing page lists the club's past
months (8.1) without anyone's billing address.

**Admins** keep the billing card on `/admin/settings` (8.1) and the banner (8.2): status,
who pays, next payment, and a link to `/billing/<orgId>` (which opens read-only for an
admin who is not the contact). The money stays visible to the people running the club,
while only the person paying can touch the card.

---

## 5. Stripe objects and calls

### 5.1 Which Stripe mechanism (compared, one recommended)

The amount is only known after the month ends and is not linear in anything Stripe can
count (it is a share of a total that depends on the whole month). Three ways to charge it:

| | (a) Subscription with a metered price | (b) No subscription: one invoice per month from our cron (**recommended**) | (c1) Subscription at £0 plus an invoice item added before renewal |
|---|---|---|---|
| How | A Billing Meter, a price of 1p per unit (`usage_type: metered`, tax inclusive); at the month end we send one meter event whose value is the computed pence; Stripe invoices it at the period end | Card saved with Checkout in setup mode; at the month close our cron creates an invoice for the computed amount on the saved card | A £0 monthly subscription; before each renewal we add an invoice item to the customer, which the renewal invoice picks up |
| Timing risk | The meter event must be in before Stripe finalises the period's invoice (about an hour; meter events are processed asynchronously). A month boundary must be moved away from evening games, and a late cron run or slow meter processing bills the usage a month late | None: we close the month when we choose (6 hours after it ends) | The item must be added before the period ends; the same boundary problem as (a) without the async meter |
| Zero months | A **£0 invoice** every month with no games | **No invoice** | A £0 invoice |
| Retries and dunning | Smart Retries, as today | Stripe's automatic retries for one-off invoices with automatic collection (to confirm on the account in test mode; Stripe documents a retry schedule for one-off invoices in its revenue recovery settings) **plus our own 7 day grace**, which already drives `past_due` and the pause (B4). If the account cannot retry one-off invoices, the cron retries on days 1, 3 and 5 | Smart Retries |
| Cancel | Portal cancel at period end, a final metered invoice | Our **Stop paying** button (a flag on our row) | Portal cancel |
| Custom plans | One metered price for all plans (the maximum is ours); the custom price objects retire | The same: amounts are ours, no price objects at all | Same |
| What of B3 stays | Most: Checkout, subscription sync, adoption, duplicate handling, refunds, the 49 hour trial rule | Customer, Checkout **setup mode** (already built for "Use my card instead"), card replace, Remove my card, VAT checks, the webhook's skeleton, idempotency, DMs | Most, as (a) |
| What it costs to get wrong | Two state machines to reconcile (ours and Stripe's subscription), as B3 has to today; billing a month late if the meter is late | One state machine (ours); the risk moves to our own month close, which is a pure, tested function plus a compare-and-set | As (a) |
| Testable without Stripe | Partly (test clocks needed for the meter timing) | Fully with the fake adapter; Stripe test mode only for the real card behaviour | Partly |

Rejected outright: **charging £9.99 in advance and crediting unplayed games next month**
(it charges for a month with no games, which is exactly what Kemal said must cost
nothing), and **bare off-session PaymentIntents** (no VAT invoice, no receipt emails, no
retries).

**Recommendation: (b).** The amount is ours to work out; Stripe should collect a known
amount. (b) has no race with Stripe's period end, sends no £0 invoices, and removes the
part of B3 that exists only to reconcile Stripe's subscription state with ours (adoption,
duplicate subscriptions and their refunds, price correction, the 49 hour trial floor,
suspension markers). B1 and B2 are untouched; B4's reminders and payment DMs stay; B5
needs a small change. The cost is a rewrite of the subscription half of B3 (5.5), done
before anything ever went live.

### 5.2 Set up once per mode (test first, live at rollout, by Kemal)

- Product **"MatchTime club"**, tax code "General, electronically supplied services"
  (`txcd_10000000`). Its id goes in `STRIPE_CLUB_PRODUCT_ID`. **No Price** is created: each
  month's invoice item carries its own amount (`price_data`, tax inclusive) under this
  product. `STRIPE_CLUB_PRICE_ID` is no longer needed.
- **Tax Rate** "VAT", 20%, `inclusive: true`, country GB. Its id goes in
  `STRIPE_CLUB_TAX_RATE_ID` (as before).
- **Business details and invoice settings:** Cressoft's legal name, registered address and
  **GB VAT number** as the account tax ID, shown on invoices and receipts (as before).
- **Automatic retries for one-off invoices** (Settings, Billing, Revenue recovery): on,
  within one week, to match our 7 day grace. If the account offers retries for
  subscriptions only, leave it and rely on the cron's retries (5.4).
- **Customer emails:** successful payment receipts and failed payment emails on; "send
  finalised invoices" on, so each payer gets their VAT invoice.
- **Customer Portal: not needed.** Change card is setup mode (as "Use my card instead"
  already is) and stopping is our own button. `STRIPE_CLUB_PORTAL_CONFIG_ID` retires.
- **Webhook** (platform scope) to `/api/stripe/billing-webhook` with the events in 5.3.
  Its secret goes in `STRIPE_BILLING_WEBHOOK_SECRET` (as before).

### 5.3 Calls (`src/lib/stripe-billing.ts` adapter, same client)

**Add a card** (`startClubCheckout`, for the billing contact when no card is on file):
find or create the club's Customer (as built), then Checkout **`mode: "setup"`** on it,
`currency: "gbp"`, card only, `billing_address_collection: "required"`, `metadata: {
orgId, payerUserId, purpose: "club-fee", action: "add-card" }`, the same metadata on
`setup_intent_data`, success and cancel back to `/billing/<orgId>`. Checkout saves a
setup-mode card for later off-session charges; test mode confirms the SetupIntent's
`usage` is `off_session`. VAT number: `tax_id_collection` if Checkout allows it in setup
mode (to confirm in test mode); if not, a business payer asks and Kemal adds it to the
Customer in the dashboard (rare).

**Use my card instead / Change card / Update card and pay**: the same setup session with
`action: "replace-card"` (as built: `buildSetupCheckoutParams`). The webhook makes the new
card the Customer's default, removes the old one and, when a club fee invoice is unpaid,
pays it at once on the new card.

**Remove my card** (old card holder): as built.

**Stop paying / Keep paying** (billing contact): our own server actions; they set or clear
`ClubBilling.cancelAtPeriodEnd`. No Stripe call.

**Charge a month** (`chargeClubMonth`, called by the month close, 6):

1. `invoices.create({ customer, collection_method: "charge_automatically", auto_advance:
   true, pending_invoice_items_behavior: "exclude", default_payment_method: <card on
   file>, description: "MatchTime club fee, {club}, {from} to {to}: {played} of
   {scheduled} games played", metadata: { orgId, purpose: "club-fee", monthId } },
   { idempotencyKey: "club-fee-invoice-<monthId>" })`;
2. `invoiceItems.create({ customer, invoice, price_data: { product, currency: "gbp",
   unit_amount: <pence>, tax_behavior: "inclusive" }, tax_rates: [<VAT rate>], metadata:
   { monthId } }, { idempotencyKey: "club-fee-item-<monthId>" })`;
3. `invoices.finalizeInvoice(id)` then `invoices.pay(id)`; a decline is not an error here
   (Stripe sends `invoice.payment_failed`, and automatic collection keeps retrying);
4. the invoice id is stored on the month (`invoiced`) **before** step 2, and a month found
   in `closing` with no invoice id first searches Stripe
   (`invoices.search` on `metadata['monthId']`) so a crash between Stripe and our database
   never makes a second invoice after the 24 hour idempotency window.

The field names are checked against the Stripe library's API version in use
(`2026-05-27.dahlia`) when P2 is built; invoice items moved some fields in recent versions.

**Void** (`voidClubInvoice`): for plan Free (forgive what is unpaid). **Refunds** stay a
manual step in the Stripe dashboard; the webhook records them on the month.

**Retries without Stripe's schedule** (only if the account cannot retry one-off invoices):
the hourly cron calls `invoices.pay` on an open club fee invoice on days 1, 3 and 5 after
the first failure, in the daytime.

### 5.4 The billing webhook (`src/app/api/stripe/billing-webhook/route.ts`)

Unchanged skeleton (as built): verify with `STRIPE_BILLING_WEBHOOK_SECRET`, insert
`BillingEvent(id = event.id)` first, ignore Connect events and anything without
`purpose: "club-fee"`, 500 on a handler error so Stripe retries.

| Event | What we do |
|---|---|
| `checkout.session.completed`, setup, `action: "add-card"` | the card becomes the Customer's default; card fields, holder, VAT country check (as B3); `card-added` through `setBillingState`; DM "card-added" (daytime, else pending, as B4) |
| `checkout.session.completed`, setup, `action: "replace-card"` | as built: new default, old card detached, DM "card-replaced"; plus: an open club fee invoice is paid at once on the new card |
| `invoice.paid` | find the month by `metadata.monthId` (or `stripeInvoiceId`); month `paid`; `invoice-paid` (past_due or paused to subscribed); DM "month-charged" |
| `invoice.payment_failed` | month `failed`; `payment-failed` (to past_due, +7 days); DM "payment-failed", noted per invoice as built in B4 |
| `invoice.payment_action_required` | DM with the invoice's hosted page for the bank check, as built in B4 |
| `invoice.voided`, `invoice.marked_uncollectible` | month `void`; recorded |
| `charge.refunded` | `refundedPence` on the month, recorded; nothing else |
| `payment_method.detached` | as built: clear the card fields if it was the card on file |
| `customer.subscription.*` | ignored (none exist); answered 200 |

### 5.5 What changes in the built code (B1 to B5)

**Stays as built:** the states, gates, quiet mode and resume (B1); the trial at approval,
"Start free month", the plan control, the billing page's guard and the settings card
skeleton (B2); the Customer per club, the payer reset, setup mode, card replace, Remove my
card, the VAT country check, `BillingEvent` idempotency and the `isClubFeeMetadata` rule
(B3); the cron's on-time transitions, the reminders and their DM window, the pending
notices, the payment-failed and 3DS DMs, `payer-changed`, the fee tip routing (B4); the
removal and re-add plumbing from the Pi (B5).

**Changes:**

| File | Change |
|---|---|
| `club-billing-rules.ts` | `nextBillingState`: drop `subscription-ended` and `subscription-unpaid`, add `billing-stopped`; `re-added` reads our card and invoice state; retire `subscriptionStateEvent`, `checkoutTrialEnd`, `CHECKOUT_TRIAL_MIN_HOURS`, `isLiveSubscriptionStatus`, `isUnpaidSubscriptionStatus`; `clubFeeTip` gains the per game maximum; `billingTotals` reports last month's charges and this month so far |
| new `club-billing-cycle-rules.ts` | pure: month boundaries (`monthBounds(anchor, index)`, London midnights, clamping), `countClubMonth` (2A.2, 2A.3), `monthFee` (2A.4), `monthCloseDue` |
| new `club-billing-months.ts` | the single writer of `ClubBillingMonth`: open, count, close (compare-and-set), charge through the adapter, waive, mark paid or failed |
| `club-billing.ts` | `setBillingState` writes the `mt.paused` and `mt.resumed` rows; `setClubPlan` (Free) waives the open month and voids unpaid invoices; new `stopPaying` and `keepPaying` |
| `stripe-billing.ts` | `buildSubscriptionCheckoutParams` replaced by the add-card setup session; adapter gains `createMonthInvoice`, `findMonthInvoice`, `payInvoice`, `voidInvoice`; drops `retrieveSubscription`, `listLiveSubscriptions`, `updateSubscriptionPrice`, `cancelSubscription`, `setCancelAtPeriodEnd`, `findOrCreateCustomPrice`, `refundPaidInvoices`, `payOpenInvoices(subscriptionId)` (replaced by paying the open club fee invoices of the Customer), `createPortalSession`; config drops the price and Portal ids |
| `stripe-billing-fake.ts` | the same contract for the e2e suite |
| `club-billing-stripe.ts` | `startClubCheckout` becomes setup mode; `onSubscriptionCheckout` becomes `onCardAdded`; `onReplaceCard` stays (no subscription update, pays an open club fee invoice); `syncSubscription`, `cancelAndRefund`, the refund intents and `sweepOpenRefundIntents`, duplicate detection, price correction, `syncPlanToStripe` and `openClubPortal` are removed; `cancelSubscriptionOnSuspend` becomes "waive the open month"; invoice events map through `metadata.monthId` |
| `club-billing-scheduler.ts` | each run also opens due months and closes months that ended 6 hours ago (daytime); the refund sweep goes |
| `club-billing-dms.ts`, `club-billing-view.ts`, i18n | new DMs `month-charged` and `month-free`; revised copy of the reminders, card added, payment failed, paused, payer changed, plan billed and the tip (7.3) |
| `club-billing-removal.ts` | no Stripe call on removal (nothing to end at period end); re-add reads our card and invoice state |
| `app/billing/[orgId]`, `/admin/settings`, `/admin/clubs` | this month's running count and expected charge, the last months and their charges, Stop paying and Keep paying, "Change card" (setup mode) in place of the Portal |
| `prisma/` | `ClubBillingMonth` and its CHECKs (additive) |

---

## 6. The scheduler

The hourly `/api/cron/billing` (as built in B4) keeps its steps (on-time transitions, the
daytime DMs, pending notices) and gains two, for every billed, approved, self-join club
that is not exempt:

| Step | When | What |
|---|---|---|
| **Open** | at or after a month's `startsAt` (the first is `trialEndsAt`), at any hour | insert the `ClubBillingMonth` row for that index (unique `orgId, index`), with `priceAtStartPence`; update `ClubBilling.currentPeriodEnd`. Skipped for a suspended club and for a club paused because it was removed or stopped |
| **Close** | the first daytime run at least 6 hours after `endsAt` | compare-and-set `open` to `closing`; load the month's matches, activities, attendances and pause spans; `countClubMonth`; `monthFee`; then one of: `no-games` (played 0 or scheduled 0), `below-minimum`, `waived` (Free or suspended), `no-card` (games played, no card on file), or **charge** (5.3) and `invoiced`. Then: a zero month DMs "month-free" (first in a row only); a stopped club moves to `paused (cancelled)` |

The receipt DM is not sent by the close: it is sent when `invoice.paid` arrives (5.4), so
it only ever describes money actually taken. At night it is noted as pending and sent at
10:00, as every B4 billing DM is.

A month that was missed (cron down, flag off for a while) is closed late by the next run;
months are closed in index order, one per club per run. Flag off: no months open or close
(the runbook note in 11 on long flag-off periods applies to months too: a backlog of
closed months would all charge on the day it is switched back on, so list them first).

---

## 7. Messages: who gets what, the club fee tip, and the copy (English and Turkish)

### 7.1 Who gets which message

As built (B4), with two new DMs:

| Message | Recipient | Channel |
|---|---|---|
| "You're live" with a short tip | the organiser who asked to join | platform DM (`organiser-decision`) |
| Day 21 (with the tip), 28, 30, paused, card added, payment failed, resumed, **month charged**, **month free** | the **billing contact**: the money collector, else the OWNER (4.5) | platform DM (`purpose: "billing"`), with the contact's own signed-in link to `/billing/<orgId>` |
| "Set a money collector" nudge | the OWNER, inside the day 21, 28 and 30 DMs, only when no collector is set | same DMs |
| Payer changed, card replaced | the new collector, the old card holder | platform DM |
| Club fee tip, day 21, once per free month | all admins, through the admin channel (skipped when it would reach only the contact) | `sendAdminNotice` |

Nothing goes to the group and nothing goes to players. A receipt names the games count,
never which players played.

### 7.2 The club fee tip

How a club covers the fee: **the collector adds a small share to what each player pays
for a game, and pays the club fee by card.** Under the games-played charge each game
played costs the club at most the monthly price over four, and a week not played costs
nothing, so the share per game is a **maximum**, and charging it every game played covers
the fee exactly or with a little to spare.

`clubFeeTip(input)` (pure, as built) keeps its numbers: players per game = 2 x
`playersPerTeam`; games = 4 per weekly slot; share = price over the month's player-games,
**rounded up to the next 5p** (decision 15, still). It gains one field, `perGamePence` =
price / games, rounded up to the penny (£2.50 for £9.99 and one weekly game; £1.25 with
two).

| Club | Players | Games | Per game at most | Share | Example |
|---|---|---|---|---|---|
| 5-a-side, £9.99 | 10 | 4 | £2.50 | **25p** | £8 game, charge **£8.25** |
| 7-a-side, £9.99 | 14 | 4 | £2.50 | **20p** | £7 game, charge **£7.20** |
| 9-a-side, £9.99 | 18 | 4 | £2.50 | **15p** | £6 game, charge **£6.15** |
| 5-a-side, Custom £5 | 10 | 4 | £1.25 | **15p** | £8 game, charge **£8.15** |

**The tip paragraph** (day 21, the day 28 fallback, payer changed, the admin channel)

> EN: 💷 *Club fee tip:* MatchTime only charges for the games you play, up to {price} a month. Each game played costs the club at most {perGame}, which is about *{share} a player per game* for your {players} players. If your game costs {fee} each, charge *{feePlus}* and the club fee is covered. Weeks you don't play cost nothing.

> TR: 💷 *Kulüp ücreti ipucu:* MatchTime yalnızca oynadığınız maçlar için ücret alır, ayda en fazla {price}. Oynanan her maç kulübe en fazla {perGame} tutar; bu da {players} oyuncunuz için *oyuncu başına maç başına yaklaşık {share}* eder. Maç ücreti kişi başı {fee} ise *{feePlus}* alın, kulüp ücreti karşılanmış olur. Oynamadığınız haftalar için hiçbir şey ödemezsiniz.

The variants stay: own fee known ("Your game is {fee} each, so charging *{feePlus}* covers
it." / "Maç ücretiniz kişi başı {fee}, *{feePlus}* alırsanız karşılanır."), and the split
pitch cost ("When you split the pitch cost, add about {share} to each player's share." /
"Saha ücretini bölüştürürken her oyuncunun payına yaklaşık {share} ekleyin.").

**"You're live" DM** (`sj_dm_approved_tip`, after "Your first month is free.", billed
clubs only; with billing off the DM is exactly today's):

> EN: 💷 *Club fee tip:* after that MatchTime only charges for the games you play, up to {price} a month for the group, paid by card by whoever collects the match fees. Each game played costs at most {perGame}, about *{share} a player per game* with {players} players, so a {fee} game could be charged at *{feePlus}*.

> TR: 💷 *Kulüp ücreti ipucu:* sonrasında MatchTime yalnızca oynadığınız maçlar için ücret alır, grup için ayda en fazla {price}; ücreti maç ücretlerini toplayan kişi kartla öder. Oynanan her maç en fazla {perGame} tutar, {players} oyuncuyla *oyuncu başına maç başına yaklaşık {share}* eder; {fee} olan bir maç için *{feePlus}* alabilirsiniz.

The pins in `self-join-copy.test.ts` (no-tip DM ends with "Your first month is free." and
has no amount; the billed variant carries exactly the tip's amounts, no dash) keep
holding; the billed variant's expected text changes.

### 7.3 Billing DM copy (to the billing contact)

All strings in `src/lib/i18n/strings.en.ts` and `strings.tr.ts`. `{price}` is the plan's
monthly maximum ("£9.99" or the Custom price), `{amount}` the month's charge, `{from}` and
`{to}` the month's first and last day ("1 Nov", "30 Nov"; "1 Kas", "30 Kas"), `{link}` the
contact's own billing link. Unchanged strings (day 28, trial ended, card replaced,
resumed, the "set a money collector" line, the 3DS DMs) are not repeated here.

**Day 21** (then the tip paragraph)

> EN: Hi {name}, {club}'s free month on MatchTime ends on {date}. As the person who collects the match fees, you're the one I'll ask for the card. To keep MatchTime running in the {club} WhatsApp group, add a card here: {link}
> After that you only pay for the games you play, up to {price} a month for the whole group, charged after each month ends. Nothing is taken when you add the card; the first charge is on {firstCharge}.

> TR: Merhaba {name}, {club} için MatchTime'daki ücretsiz ay {date} tarihinde bitiyor. Maç ücretlerini siz topladığınız için kartı sizden istiyorum. MatchTime'ın {club} WhatsApp grubunda çalışmaya devam etmesi için buradan kart ekleyin: {link}
> Sonrasında yalnızca oynadığınız maçlar için ödersiniz, tüm grup için ayda en fazla {price}, her ay bittikten sonra alınır. Kartı eklediğinizde hiçbir ücret alınmaz; ilk ödeme {firstCharge} tarihinde.

**Card added**

> EN: Thanks {name}, your card is saved. MatchTime keeps running in the {club} WhatsApp group. Nothing has been taken: after each month I count the games played and charge only for those, up to {price}. The first charge is on {firstCharge}, and Stripe emails you each receipt. To change your card or stop: {link}

> TR: Teşekkürler {name}, kartınız kaydedildi. MatchTime {club} WhatsApp grubunda çalışmaya devam ediyor. Şu an hiçbir ücret alınmadı: her ayın sonunda oynanan maçları sayıyorum ve yalnızca onlar için, en fazla {price} alıyorum. İlk ödeme {firstCharge} tarihinde; her makbuzu Stripe size e-postayla gönderir. Kartınızı değiştirmek ya da durdurmak için: {link}

(The resumed variant keeps its middle sentence from B4: "MatchTime is back on for {club}
... should say it again.")

**Month charged** (new; after `invoice.paid`)

> EN: Hi {name}, {club} played {played} of {scheduled} games between {from} and {to}, so {amount} was charged to your card ending {last4} (VAT included; a full month is {price}). Stripe has emailed you the receipt. Details: {link}

> TR: Merhaba {name}, {club} {from} ile {to} arasında {scheduled} maçın {played} tanesini oynadı, bu yüzden {last4} ile biten kartınızdan {amount} çekildi (KDV dahil; tam ay {price}). Makbuzu Stripe size e-postayla gönderdi. Ayrıntılar: {link}

When every game was played: "{club} played all {scheduled} games between {from} and {to},
so {amount} was charged ..." / "{club} {from} ile {to} arasındaki {scheduled} maçın hepsini
oynadı, bu yüzden ...".

**Month free** (new; the first zero month in a row only)

> EN: Hi {name}, {club} played no games between {from} and {to}, so there is nothing to pay for that month. MatchTime only charges for the games you play.

> TR: Merhaba {name}, {club} {from} ile {to} arasında hiç maç oynamadı, bu yüzden o ay için ödenecek bir şey yok. MatchTime yalnızca oynadığınız maçlar için ücret alır.

**Payment failed** (the amount and the month instead of "this month's {price}")

> EN: Hi {name}, the {amount} for {club}'s games between {from} and {to} didn't go through. Stripe will try again over the next few days, and MatchTime keeps running meanwhile. To update the card: {link}

> TR: Merhaba {name}, {club} için {from} ile {to} arasındaki maçların {amount} ödemesi alınamadı. Stripe önümüzdeki birkaç gün içinde tekrar deneyecek, bu sürede MatchTime çalışmaya devam ediyor. Kartı güncellemek için: {link}

(The "not your card" ending stays as built.)

**Paused, payment wording**

> EN: Hi {name}, we couldn't take the {amount} for {club}, so MatchTime is now paused.
> TR: Merhaba {name}, {club} için {amount} ödemesini alamadık, bu yüzden MatchTime şu an duraklatıldı.

**Paused, cancelled wording** (after Stop paying)

> EN: Hi {name}, you stopped paying for MatchTime for {club}, so it is now paused. The last month has been charged for its games as usual.
> TR: Merhaba {name}, {club} için MatchTime ödemesini durdurdunuz, bu yüzden şu an duraklatıldı. Son ay, oynanan maçlar için her zamanki gibi ücretlendirildi.

(The shared second paragraph, "I'm still in the group ... add a card here and it restarts
within a few minutes", stays as built.)

**Payer changed** (the price sentence)

> EN: ... so you look after MatchTime's club fee for the {club} WhatsApp group: only the games played, up to {price} a month. ...
> TR: ... bu yüzden {club} WhatsApp grubu için MatchTime kulüp ücretiyle siz ilgileniyorsunuz: yalnızca oynanan maçlar, ayda en fazla {price}. ...

**Plan billed** (B3, a club set back from Free): "on the MatchTime plan again at {price} a
month" becomes "on the MatchTime plan again: only the games played, up to {price} a
month" / "yeniden MatchTime planında: yalnızca oynanan maçlar, ayda en fazla {price}".

House rules checked: no time-of-day greetings, no claims about other organisers, no
mention of AI, nothing in the club's own group, nothing to players, no em or en dashes.

---

## 8. Web

### 8.1 The billing page and the settings card

`/billing/[orgId]` (as built, guard `requireClubBillingAccess`) changes its state lines
and buttons:

| State | What it shows | Buttons (billing contact) |
|---|---|---|
| `trial` | "Free month until {date}. After that you only pay for the games you play, up to {price} a month." Tip. | **Add a card** |
| `subscribed`, in the free month | "Card saved. Nothing is taken until {firstCharge}." | **Change card**, **Stop paying** |
| `subscribed` | **This month** box (below), then "Card {brand} ending {last4}." | **Change card**, **Stop paying** (or **Keep paying** with "Ends on {date}") |
| `grace` | as built | **Add a card** |
| `past_due` | "The {amount} for {from} to {to} didn't go through. Stripe is retrying. MatchTime stops on {date} if it can't be taken." | **Update card and pay** |
| `paused` | as built | **Add a card** (or **Update card and pay** when an invoice is unpaid) |

**This month box** (worked out at page load from the same `countClubMonth`, with the
games still to come shown as not yet played):

> EN: This month ({from} to {to}): {played} of {scheduled} games played so far, {upcoming} still to come. So far that's {amount}; if every game is played it's {price}. Charged on {chargeDate}.
> TR: Bu ay ({from} ile {to} arası): şu ana kadar {scheduled} maçın {played} tanesi oynandı, {upcoming} maç daha var. Şu ana kadar {amount}; tüm maçlar oynanırsa {price}. Ödeme {chargeDate} tarihinde alınır.

Under it, **past months**: one line each, "1 Nov to 30 Nov: 4 of 5 games, £7.99 paid" /
"no games, nothing to pay", with the games list behind a "See games" toggle (the month's
`games` JSON: date, played or not and why: cancelled, nobody said IN, MatchTime paused).

**`/admin/settings` billing card** (admins): the state line, who pays, "card on file", this
month's count and expected charge, last month's charge, and the tip. **Banner** (8.2) as
built.

### 8.2 Banner

As built: `grace`, `past_due` and `paused` only, for OWNER and ADMINs.

### 8.3 Owner view on `/admin/clubs`

The Billing column shows plan ("Standard, up to £9.99" or "Custom, up to £5.00"), state,
card on file, who pays, **this month so far** ("2 of 5, £3.99") and **last month**
("£7.49 paid", "no games", "failed"). The totals line: clubs with a card, **charged last
month** (sum of the closed months' amounts), **this month so far**, and clubs in grace,
past due and paused. The plan control's Custom field is labelled "monthly maximum".

### 8.4 Public website and help copy (proposed, not edited in this plan)

Today the landing page says "£9.99 a month per WhatsApp group, not per player. Your first
month is free" (`landing-page.tsx` ~553, ~577, ~640), the split advice "With 20 players,
that works out at about 50p a player" (~608), and "No contract. Remove MatchTime from the
group any time to stop" (~585). Proposed (P4), each pinned by `public-copy.test.ts` and
`e2e/web/public-site.spec.ts`:

- Price line: "Up to £9.99 a month per WhatsApp group, not per player, and **you only pay
  for the weeks you play**. Your first month is free."
- A short worked line: "Play 3 weeks out of 4 and it's £7.49. Take a month off and it's
  nothing."
- The split advice stays true as a maximum ("about 50p a player" a month with 20 players);
  the "25p" ban on the landing page stays.
- "No contract. Stop any time" stays.
- Help page (`help/admin/page.tsx`, the `#club-fee` paragraph from PR #184): rewritten for
  games played, the month dates, the morning-after charge, Stop paying, and the receipt.
- Turkish versions where the site has them. The rule against claiming MatchTime
  collects the club fee for the club stays.

---

## 9. The AI cap and billing (decided, decision 10)

**Decided by Kemal, 2026-10-01, and shipped in the AI cap PR (`src/lib/ai-budget.ts`,
`src/lib/ai-cap-notice.ts`):**

- **Free month: $2.00 a day** (`NEW_CLUB_CAP_USD`) for the first **30 days**
  (`NEW_CLUB_WINDOW_DAYS`) from `approvedAt ?? aiWindowStartAt ?? createdAt`, so the AI
  window and the 30 day trial now line up.
- **Paying clubs: $1.50 a day** (`DAILY_CAP_USD`) after that. Sutton FC keeps its
  per-club override of $1.50 (same value).
- **Unapproved, muted or no group: $0**, as before. Spend with no club yet (the web
  wizard's chat analysis) keeps the old $0.25 (`PRE_CLUB_CAP_USD`): the free month
  starts at approval, and nobody has approved anything yet.
- **`AI_DAILY_CAP_DISABLED` stays in code as an emergency override** and is being removed
  from Vercel production so the caps apply. While set it still beats the per-club
  override, on purpose: an emergency switch some clubs ignore is not one. To stop one
  club spending, mute or suspend it.
- **The admins are told, once a day.** The first time a club is capped on a London day,
  its admins get one message through the admin channel (`sendAdminNotice`: one person,
  the admin group, or each admin), never Kemal. Claimed by a `SentNotification` key
  `<orgId>:ai-cap:<YYYY-MM-DD>`, so racing refusals send one. Not for unapproved,
  dormant or muted clubs, and not from 22:00 London (it would arrive the next morning
  about a day that is over). It says what still works (a plain In or Out in the
  group, scheduled posts), that questions and other AI requests get no answer, that it
  resets at midnight UK time, and how to get more (today: email hello@matchtime.ai;
  later the **Buy more** link from 9.1).

**Before that PR, verified in `src/lib/ai-budget.ts` (`aiAllowanceUsd`, ~166 to 180):**

- `AI_DAILY_CAP_DISABLED=1` is set in Vercel **production** (the variable is listed in
  `vercel env ls production`; its value is encrypted, and Kemal confirmed it is `1`). It
  was set on 2026-09-30 when Kemal asked to remove the allowance globally. So **every
  approved club may currently spend up to $50 a day** (`UNCAPPED_USD`). The switch is
  read **before** the per-club override, so overrides do nothing while it is on.
- The $0 rules still hold with the switch set: an unapproved club, a club with the bot
  off or no linked group spends nothing.
- **With the switch off**, the rule is: the per-club override `aiDailyCapUsd` when set
  (Sutton FC's is $1.50, per Kemal, not re-read from the database); otherwise $0.25 a day
  (`NEW_CLUB_CAP_USD`) for 28 days (`NEW_CLUB_WINDOW_DAYS`) from
  `approvedAt ?? aiWindowStartAt ?? createdAt`, then $1.00 a day (`DAILY_CAP_USD`).

**What billing adds:**

- **Paused means $0**, added to `aiAllowanceUsd` just after the approval check and before
  the global switch (4.3 point 5), with a test that neither `AI_DAILY_CAP_DISABLED` nor
  `aiDailyCapUsd` can lift it.
- `AllowanceOrg` and `ALLOWANCE_SELECT` gain `billingStatus`.
- The free-month window and the trial both start at `approvedAt` and both run 30 days
  (the window was 28 before the AI cap PR), so a trial club has the free month allowance
  exactly while it is in trial.

**Why the cap still matters with billing:** a paying club that used its full $1.50 every
day would cost about £33 a month against £8.33 net revenue; with the switch on, the same
club's ceiling is $50 a day. A free month club at its full $2.00 every day would cost
about £45 before any revenue. For scale,
Sutton FC's whole September production AI bill was about $3.50
(`MDs/llm-spend-september-2026.md`), so a normal club is far below either ceiling; the cap
is the guard against the abnormal one. Spend per club is shown on `/admin/clubs` (8.3).

### 9.1 AI top-ups (planned)

A future slice (**T1**), after B1 to B6. Nothing of it is built. It is the answer to "Need
more?" in the cap notice.

**What the club sees.** The cap notice ends with a **Buy more** link instead of the email
line (`buildAiCapAdminNotice` already takes a `buyMoreUrl`, so only that argument
changes). The link opens a small page with one button, **Buy £5 of extra AI**, which goes
to Stripe Checkout. Once paid, MatchTime answers again straight away, the same day.

**Who can buy:** the money collector or any owner or admin of the club. A DM carries the
reader's own signed-in link (`buildAdminLink`) to `/billing/<orgId>/ai`; a post in the
admin group carries the plain URL, which asks for sign-in. The page guard is
`requireClubBillingAccess` (4.5) widened to owners and admins.

**Payment.** A one-off Stripe Checkout payment (`mode: "payment"`) on the **platform
account**, not a Connect account: this is Cressoft's revenue, like the club fee. One
tax-inclusive Price (`STRIPE_AI_TOPUP_PRICE_ID`) with the same 20% inclusive Tax Rate as
the club fee (5.4), so £5.00 includes VAT. Receipts by email from Stripe. Metadata
carries `purpose: "ai-topup"`, `orgId` and the buyer's `userId`; the billing webhook
(5.3) credits the club on `checkout.session.completed`, idempotent on the session id.

**Mechanics (proposed):**

1. **A credit balance on the club.** `Organisation.aiCreditUsd` (dollars, default 0) and a
   small `AiTopUp` table (session id unique, org, buyer, pence paid, dollars credited,
   time) for audit and idempotency. One top-up adds its dollars to the balance.
2. **The daily cap is spent first, the credit after.** In `ai-budget.ts` the reservation
   tries today's allowance as now. When that is used up and the club has credit, the
   hold is taken from the credit instead, in one statement
   (`UPDATE ... SET "aiCreditUsd" = "aiCreditUsd" - hold WHERE "aiCreditUsd" >= hold`),
   so racing calls cannot spend the same cent twice. On settle the real cost is booked
   and the unused part of the hold goes back to the balance. Same overshoot bound as
   today, at most a few cents.
3. **Credit never lifts a $0.** Unapproved, muted, suspended or paused clubs spend
   nothing whatever their balance. Credit is not used while `AI_DAILY_CAP_DISABLED` is
   set.
4. **It lasts until used**, across days. It is not refundable once used; a refund of an
   unused top-up is done by hand in Stripe, and `charge.refunded` takes the refunded
   share back off the balance (never below 0).
5. **The cap notice follows the credit.** With credit left, reaching the daily cap sends
   no notice (nothing changes for the group). When the credit also runs out, the usual
   once-a-day notice goes out with the Buy more link, under the same claim key.
6. **Visible to Kemal** on `/admin/clubs` (balance and top-ups), and to the club on the
   billing page.

Files, roughly: `ai-budget.ts` (reserve and settle), `ai-cap-notice.ts` (the link),
`stripe-billing.ts` and the billing webhook (B3), `src/app/billing/[orgId]/ai`, a
migration, i18n. No prompt change, so no paid AI test runs. Depends on B3.

**Under the games-played charge:** a club that plays no games pays nothing but can still
spend AI (stats questions, setup); the $1.50 a day cap bounds that at about £33 a month,
and a normal club's whole month is a few dollars. No change proposed; `/admin/clubs`
shows AI spend next to each club's charges.

---

## 10. Test plan (free suites only)

**No prompt changes anywhere**, so **no live-LLM suite or dry run**. TDD, red first, per
slice. Unit and Playwright suites only; Stripe test mode by hand before rollout.

### 10.1 Unit (vitest)

- **Month boundaries** (`monthBounds`): a free month ending on the 1st (calendar months),
  the 17th, the 29th, 30th and 31st (February clamped, March back to the 31st), a free
  month ending across the October and March clock changes, month 1 starting at
  `trialEndsAt` itself; computed from the anchor, never chained (month 13 of a 31st
  anchor is a 31st).
- **Counting** (`countClubMonth`), each as a fixture of activities, matches, attendances
  and pause spans: Kemal's four examples (3 of 4 is 749p, 4 of 5 is 799p, 0 of 4 and 0 of
  0 are no charge); a cancelled week; an auto-completed week with nobody IN and no score
  (not played); the same with a score (played); a MoM-only club (`featureAttendance`
  false); a format-switch pair and a ghost row in the same slot (one game); Sutton FC's
  real shape (`tuesday-7aside` 21:30 and `tuesday-5aside` 21:15, one game); two weekly
  games summed; an extra one-off match (adds one); a match moved across the month
  boundary; a historical match (ignored); a deleted empty shell on the calendar (scheduled,
  not played); a new activity mid month (from `createdAt`); a switched-off activity with
  no matches (not counted); matches inside a pause span (not played, still scheduled);
  matches completed quietly by `resumeClub` (not played); kickoffs exactly at `startsAt`
  (in) and at `endsAt` (out).
- **The fee** (`monthFee`): floor to the penny; the lower of start and close price; Custom
  scaling; 29p not charged, 30p charged; never above the price; zero cases produce no
  charge.
- **The month close** (`club-billing-months.ts`, database mocked): open is idempotent
  (unique index); close is a compare-and-set (two runs at once, one charges); a crash
  after the Stripe invoice and before our write finds the invoice by `monthId` and does
  not create another; `no-card`, `waived` (Free, suspended), `below-minimum`, `no-games`
  paths make no Stripe call; a stopped club moves to `paused (cancelled)` after its last
  month is charged; months close in order after a cron outage.
- **State machine:** every row of 4.2, including card saved in `trial`, `grace` and
  `paused (no-card)` (nothing charged), Stop paying and Keep paying, Stop paying in the
  free month, re-added with and without a card or an unpaid invoice.
- **Webhook:** `invoice.paid` and `invoice.payment_failed` map to the month by metadata;
  an invoice without `purpose: "club-fee"` is ignored; a re-delivered `invoice.paid` sends
  one receipt; `checkout.session.completed` setup `add-card` saves the card and charges
  nothing; `replace-card` pays an open club fee invoice; subscription events are ignored;
  `charge.refunded` records only.
- **Adapter calls** (pure builders and the fake): the invoice is created with
  `pending_invoice_items_behavior: "exclude"`, the card on file, the metadata and an
  idempotency key per month; the item is tax inclusive with the VAT rate and the product;
  no call uses `stripeAccount`.
- **DMs and copy:** `month-charged` (some and all played), `month-free` (first zero month
  only, not the second), revised day 21, card added, payment failed, paused, payer
  changed, plan billed and tip strings in both languages, no dashes; i18n parity; the
  `sj_dm_approved` pins as in 7.2.
- **Kill switch and Sutton:** with `BILLING_ENABLED` off no month opens or closes and no
  invoice is ever created; an exempt club never gets a month.
- **Source guards:** only `club-billing-months.ts` writes `ClubBillingMonth`; only the
  adapter calls Stripe; nothing outside billing creates invoices on the platform account.

### 10.2 Playwright (web, free; fake Stripe adapter under `MT_TEST_MODE`)

- A player who is the money collector adds a card (fake setup checkout, then a signed
  `checkout.session.completed` fixture): the page says nothing has been taken and shows
  the first charge date.
- The cron with `x-test-now` at the end of month 1 (fixture club: one Tuesday game, 5
  Tuesdays, 4 played, 1 cancelled): one fake invoice of 799p; after a signed
  `invoice.paid` fixture, exactly one `PlatformJob` with the receipt text; the page shows
  "4 of 5 games, £7.99 paid".
- A month with no games: no invoice, one "month-free" DM; a second zero month: no DM.
- A failed payment fixture: banner, `past_due`, "Update card and pay"; then `invoice.paid`
  clears it.
- Stop paying: "Ends on {date}"; at the month close the last month is charged and the
  club pauses; Keep paying before then undoes it.
- `/admin/clubs`: this month so far and last month per club; Custom labelled "monthly
  maximum".
- The group simulator (`e2e/sim`, stubbed model): unchanged, a paused group sends nothing.

### 10.3 Manual, Stripe test mode only (before rollout)

On a Preview deployment with `sk_test` keys (the Preview setup is in PR #184's runbook):
add a card with `4242 4242 4242 4242` (nothing charged); run the cron with `x-test-now` at
a month close and see the invoice, its PDF (legal name, address, VAT number, "VAT (20%,
inclusive)", the description with the games count) and the receipt email; repeat with a
declining card (`4000 0000 0000 0341`) and watch the retries on the account (this is where
"does the account retry one-off invoices" is answered); a card that needs a bank check
off-session (`4000 0027 6000 3184`) for the 3DS DM; Change card, then pay an open invoice
on the new card; Stop paying through a month close; set Free with an unpaid invoice (it is
voided).

---

## 11. Rollout

1. **Flag** `BILLING_ENABLED` stays off while P1 to P4 ship dark.
2. **Test mode first:** product, VAT rate, retries setting, customer emails and the
   webhook (with the event list of 5.4) in test mode; 10.3 end to end on a Preview.
3. **Live config, by Kemal in the Stripe dashboard:** the same, plus business details and
   VAT number, and delete the old platform-scoped `we_1TgQL6...` endpoint if it exists.
   Vercel production env: `STRIPE_BILLING_WEBHOOK_SECRET`, `STRIPE_CLUB_PRODUCT_ID`,
   `STRIPE_CLUB_TAX_RATE_ID`. **No** `STRIPE_CLUB_PRICE_ID` or
   `STRIPE_CLUB_PORTAL_CONFIG_ID`.
4. **AI caps:** check `AI_DAILY_CAP_DISABLED` is still absent from production (PR #184
   found it absent on 2026-10-01).
5. **Switch on for new clubs only.** Every existing club stays `exempt`.
6. **First real club:** watch `/admin/clubs` through day 21, then its first month close
   (about day 61): the count, the invoice and the receipt DM.
7. **Copy:** the website and help changes of 8.4 go out with P4, before step 5.

**Rollback:** `BILLING_ENABLED` off. Paused clubs serve again within one Pi org refresh;
reminders stop; **no month opens or closes, so nobody is charged**. Invoices already
created stay in Stripe; Kemal can void or refund any.

**Runbook notes kept from B4's review:**

- **Flag off for more than a week, then on again.** Free months and grace weeks catch up at
  once (as before), and **every month that ended while the flag was off closes on the first
  daytime run**, each charged for its games. Before switching back on, list the clubs with
  months ended in the gap (`/admin/clubs`) and decide: let them charge, or waive them (a
  plan change to Free and back, or a one-off update agreed with Kemal).
- **Dormant self-join clubs** (was an open question): resolved by this model. A dormant
  club plays no games and pays nothing, with no special rule.

**PR #184 (B6).** Its help paragraph describes the flat £9.99, and its runbook (section
16 there) creates a monthly Price, a Portal configuration, Smart Retries for
subscriptions and subscribes the webhook to `customer.subscription.*`. All of that changes
under 5.2 and 5.4. Recommend not merging it as it is; P4 carries its Preview setup steps
(which still hold) and the rewritten Stripe steps.

---

## 12. Env vars

| Name | Where | Value |
|---|---|---|
| `BILLING_ENABLED` | Vercel (server only) | `1` to turn on |
| `STRIPE_BILLING_WEBHOOK_SECRET` | Vercel | `whsec_...` of the platform-scoped billing endpoint |
| `STRIPE_CLUB_PRODUCT_ID` | Vercel | `prod_...`, now **required**: every month's invoice item is made under it |
| `STRIPE_CLUB_TAX_RATE_ID` | Vercel | `txr_...`, 20% UK VAT, inclusive |
| `STRIPE_CLUB_PRICE_ID` | retired with P2 | no longer read |
| `STRIPE_CLUB_PORTAL_CONFIG_ID` | retired with P2 | no longer read |
| `STRIPE_SECRET_KEY` | existing | unchanged, same platform account |
| `STRIPE_WEBHOOK_SECRET` | existing | unchanged, Connect endpoint only |
| `AI_DAILY_CAP_DISABLED` | emergency override only | must be absent in production |
| `STRIPE_AI_TOPUP_PRICE_ID` | slice T1 only | `price_...`, the £5 top-up (9.1) |
| `BILLING_STRIPE_FAKE` | test only | `1` under `MT_TEST_MODE` for Playwright |

Constants, not env: trial 30 days, grace 7, reminders days 21 and 28, the billing link TTL
9 days, the close delay 6 hours, the Stripe minimum 30p, all in the rules files.

---

## 13. Slices

### 13.1 B1 to B6 as built (record)

| # | PR | Depends on | Main files |
|---|---|---|---|
| B1 | **Schema, rules and the quiet gate.** Columns, `ClubBilling`, `BillingEvent`, `BillingNotice`, CHECK constraints, `club-billing-rules.ts` (including `billingContact`), `setBillingState`, `SERVING_CLUB_WHERE`, `isClubOperational` and every gate in 4.3, AI allowance $0 when paused, `fixtureSkipReason`, `dm-reply` rail, kill switch, `resumeClub`. No visible change (every club `exempt`). | none | `prisma/`, `club-approval-state.ts`, `club-billing*.ts`, `orgs`, `due-posts`, `analyze` (org lookups only), crons, `ai-budget.ts`, `org-lifecycle.ts`, `dm-reply` |
| B2 | **Trial, pages and the club fee tip.** Trial at approval (`decideClub` approve, flag on), `/admin/clubs` billing column and AI spend, plan control, "Start free month", the billing page `/billing/[orgId]` with `requireClubBillingAccess` (read-only states), the settings card, banner, `clubFeeTip`, the tip paragraph in `sj_dm_approved`, i18n. | B1 | `club-approval.ts` (one call), `club-billing*.ts`, `src/app/billing/[orgId]`, `/admin/clubs`, `/admin/settings`, `admin/layout.tsx`, `i18n`, `self-join-copy.test.ts`. **Plan Free (from B1 review):** `setClubPlan` must set `billingStatus = "exempt"` FIRST, then `billingPlan = "free"`, in ONE transaction (through `setBillingState`'s `plan-free` event and the same locked transaction), because the CHECK `Organisation_billingFreeExempt_check` refuses a Free plan on a club that is not exempt. Leaving Free goes the other way round: plan first, then any status change. |
| B3 | **Stripe.** `stripe-billing.ts`, Add a card (Checkout, with the inclusive Tax Rate, billing address, VAT number collection and the UK check), Use my card instead (setup mode), Change card or cancel (Portal), Remove my card, billing webhook, sync, "card-added" and "card-replaced" DMs, plan changes on live subscriptions, fake adapter. **As built (2026-10-01):** `stripe-billing.ts` (pure Checkout builders, the real adapter, `getBillingStripe`), `stripe-billing-fake.ts` (tests only: `MT_TEST_MODE=1` and `BILLING_STRIPE_FAKE=1`, refused with a live key), `club-billing-stripe.ts` (the four actions, `processBillingWebhook` with `BillingEvent` idempotency, sync from a FRESH subscription read, `syncPlanToStripe`, `notifyPlanBilledAgain`), `app/actions/club-billing.ts` (each action re-checks `requireClubBillingAccess`), `queueBillingDm` in `club-billing.ts` (claim `BillingNotice` first; the only queuer of purpose `"billing"`). Also: only one Add a card session may be open per club (open ones are expired first), a second live subscription for a club is cancelled at once by the webhook, the B2 gap (Free and back) has the defined path in 4.2, and a "resumed" DM goes to the contact when a recovered payment brings a paused club back. Left for B4: the payment-failed and 3DS DMs, and any DM on Remove my card (the contact already had "payer-changed"). **Review hardening (PR #181):** a live subscription for a club on Free, exempt or gone is cancelled at once and refunded by the webhook, never adopted; open Checkout sessions expire on every session, plan or price change; an adopted subscription on a stale price is corrected; Stripe itself is asked for live subscriptions before any new session; adoption is a compare-and-set, and a duplicate is cancelled AND refunded automatically, recorded on /admin/health (kind `club-billing`), never a DM; an unpaid subscription always offers "Update card and pay" (setup mode, open invoice retried); the card holder is never read from subscription metadata (Checkout payer, or the contact after a Portal card change); the Portal needs `STRIPE_CLUB_PORTAL_CONFIG_ID` (no fallback, no button without it) and is only for the contact whose own card is on file; a new payer's session first resets the shared Customer (name back to the club; email, address, phone and VAT numbers cleared) and the webhook then writes the payer's email and address; the webhook answers 503 without its secret and ignores Connect events; a cancel inside the free month goes back to `trial`, and a new card keeps the original trial end; billing DMs are claimed and released on failure, and "resumed" and "plan-billed" are written as pending notices in the state change's own transaction; suspending a club (4.2, decision 7) cancels its live subscription at once with no automatic refund (wired in B3). **Round-2 review:** a live subscription for a Free or exempt club is cancelled and only invoices paid AFTER the club became Free are refunded (the moment is a `BillingEvent` row of type `mt.club-exempt`, written by `setClubPlan`); a suspended or deleted club's is cancelled with no automatic refund; only a true duplicate is refunded in full. The order is: /admin/health event, refund intent (`BillingEvent` `mt_refund_<sub>`), refunds (idempotent per invoice), cancel, intent closed (changed in B4: the cancel now comes BEFORE the refunds); an open intent is finished by the next event for that subscription. The shared Customer is reset only when a new payer's card is CONFIRMED (in the webhook), never at session start; setup mode collects no VAT number, so a business payer adds theirs in the Customer Portal (enable tax IDs in its configuration). A subscription cancelled by a suspension is marked `cancelledBy: suspend` and, like every event for a suspended club, never moves the billing state (B4: never schedule reminders for a club that is not approved). Pending DMs are re-checked before sending (plan-billed only in its own grace cycle, resumed only while serving) and skipped when older than 3 days, superseded, or with no contact. A DM claim older than 10 minutes can be taken over. Live subscriptions are read across every page; "live" is `isLiveSubscriptionStatus` everywhere (Stripe's `paused` counts as live: it can resume and charge). | B1, B2 | `stripe-billing.ts`, `api/stripe/billing-webhook`, billing page actions |
| B4 | **Scheduler and messages.** `/api/cron/billing`, day 21, 28, 30, 37, payment-failure grace, `purpose: "billing"`, `BillingNotice`, all DM copy EN and TR to the billing contact with `/billing` links, the "set a money collector" line, `sendClubFeeTip` (admin channel, with the one-person skip), the "payer changed" DM from `setPaymentHolder`. **As built (2026-10-01):** `club-billing-schedule-rules.ts` (pure: the 10:00 to 20:00 London DM window, day 21 and 28 at 10:00 London counted in calendar days back from the London date of `trialEndsAt`, `billingTransitionDue`, `billingDmsDue`, `feeTipDue`), `club-billing-dms.ts` (the scheduled DMs, `sendClubFeeTip`, `onBillingContactChanged`, `notePaymentProblem`, `flushPendingBillingDms`), `club-billing-scheduler.ts` (`runBillingCron`) and `api/cron/billing` (hourly). State changes happen on time at any hour through `setBillingState`; a DM that becomes due at night is not queued with a `sendAfter` but left pending (or simply not yet due) and the 10:00 run re-checks it is still true before sending, so nobody is asked for a card they added at 07:00. The webhook's own DMs (card added, card replaced, resumed, billed again) follow the same rule: at night they are written as pending notices and the 10:00 run re-checks them (card added: still the club's live subscription; card replaced, keyed `<old card>|<old holder>`: the old card still off the club) before sending. A 3DS DM to a contact whose card is not the one being charged offers both the bank check and "put your own card on". A skipped "payer changed" notice is re-opened by the next real change to the same person. Every DM says "the {club} WhatsApp group". `invoice.payment_failed` and `invoice.payment_action_required` are NOTED by the webhook (pending `BillingNotice` kinds `payment-failed` and `payment-action`, once per invoice); a 3DS one is sent at once in the daytime with the invoice's hosted page, a failed one waits at least 30 minutes so a 3DS event for the same invoice supersedes it; both are re-checked against Stripe (invoice still open) before sending. A "paused" DM goes for any pause in the last 3 days except removal from the group, whoever paused it (cron or webhook). The admin tip claims `fee-tip` before the channel check and is skipped for good when the channel reaches only the contact; in "each admin" mode the contact is left out of the admin DMs. No contact: no DM, an /admin/health event. Follow-up from the B3 review: `finishCancelAndRefund` now CANCELS FIRST, then refunds, and the cron's `sweepOpenRefundIntents` completes any refund intent left open (older than 5 minutes), whatever `BILLING_ENABLED` says. No schema change. | B2, B3 | `api/cron/billing`, `vercel.json`, `platform-jobs.ts` (purpose), `actions/payments.ts` (one call), `i18n` |
| B5 | **Removal from a live group.** Pi forwards self-removal for monitored groups too (`handleGroupLeaveForSelfRemoval`), server sets `paused (removed)` and cancels at period end for billed clubs only; **exempt clubs (Sutton) only log**. Re-add during the trial resumes it. Pi deployed with `scripts/deploy-pi.sh`, away from match time. | B3 | `whatsapp-bot/src/bot-added.ts`, `api/whatsapp/bot-removed`, `club-billing.ts` |
| B6 | **Go-live.** Help page paragraph, `.env.example`, runbook in this file. Then rollout steps 2 to 7. | B1 to B5 | `help/admin/page.tsx` |

| T1 | **AI top-ups (planned, after B6).** Credit balance and `AiTopUp`, credit spent after the daily cap in `ai-budget.ts`, Buy more page and Checkout, webhook credit and refund, the Buy more link in the cap notice (9.1). | B3 | `ai-budget.ts`, `ai-cap-notice.ts`, `stripe-billing.ts`, billing webhook, `src/app/billing/[orgId]/ai`, `prisma/`, `i18n` |

B3 and the UI half of B2 can run in parallel after B1 if their files are split as above.
B1 touches `analyze/route.ts` only at the two org lookups.

### 13.2 Games played: four PRs (P1 to P4), all dark behind `BILLING_ENABLED`

| # | PR | Depends on | Main files | Risks |
|---|---|---|---|---|
| P1 | **Counting games (pure, plus schema).** `club-billing-cycle-rules.ts` (month boundaries, `countClubMonth`, `monthFee`), `ClubBillingMonth` and its CHECKs, the `mt.paused` and `mt.resumed` rows in `setBillingState`, a loader that reads a club's month (matches, activities, attendances, pause spans), and a **read-only script** that prints any club's count and fee for any past month (to show Kemal Sutton FC's real numbers before anything charges). No Stripe, no visible change. | B1 | `prisma/`, `club-billing-cycle-rules.ts`, `club-billing.ts` (spans), `scripts/` | Counting is the whole product: a wrong count is a wrong charge. Mitigated by the exhaustive fixtures in 10.1 and the script run on real clubs' data before P2 merges. |
| P2 | **Stripe: card on file and one invoice per month.** Setup-mode Add a card, `onCardAdded`, the invoice adapter and fake, the month close and charge in `club-billing-months.ts`, webhook mapping by `monthId`, Stop paying and Keep paying, Free voids, suspend waives, B5's removal without a Stripe call, and the **removal** of the subscription code (5.5). | P1 | `stripe-billing.ts`, `stripe-billing-fake.ts`, `club-billing-stripe.ts`, `club-billing-months.ts`, `club-billing-rules.ts`, `club-billing-removal.ts`, `api/stripe/billing-webhook` | Money: a double charge, a charge on the wrong club, an off-session card that needs a bank check. Mitigated by the compare-and-set, idempotency keys plus the search by `monthId`, metadata checks, the 3DS DM path that exists, and a **second adversarial review** (money). Removing B3 code risks dropping a guard that still matters: the review walks every B3 review finding (13.1) and says why it is kept or no longer applies. |
| P3 | **Scheduler and DMs.** Opening and closing months in the hourly cron (6 hour delay, daytime), retries by the cron if the account cannot retry one-off invoices, `month-charged` and `month-free`, the revised DM copy in English and Turkish (7.3), the tip's `perGamePence` and wording (7.2), `sj_dm_approved_tip`. | P2 | `club-billing-scheduler.ts`, `club-billing-schedule-rules.ts`, `club-billing-dms.ts`, `club-billing-view.ts`, `i18n` | A cron outage then a burst of closes (months close in order, one per club per run); a DM about money not taken (receipts only on `invoice.paid`). |
| P4 | **Pages, owner view, public copy and runbook.** The billing page's month box and past months, Change card and Stop paying buttons, the settings card, `/admin/clubs` columns and totals, "monthly maximum", the website and help copy of 8.4 with their copy tests, and the go-live runbook rewritten for 5.2 and 5.4 (taking over PR #184). | P1 (page counts), P3 (copy) | `app/billing/[orgId]`, `/admin/settings`, `/admin/clubs`, `landing-page.tsx`, `help/admin/page.tsx`, `public-copy.test.ts`, `public-site.spec.ts`, this file | Public claims must match shipped behaviour: the site copy ships only once P1 to P3 are merged. |

P1 and the website half of P4 can run in parallel (no shared files). P2 waits for P1; P3
for P2. Each PR runs its own unit tests while iterating and the full suite, type check
and build once before handing back.

---

## 14. Not planned: adding the club fee to match fees (was slice B7)

An earlier pass proposed an optional per-club setting that would add each player's club
fee share to card and Pay by Bank match payments taken through Stripe Connect, collect
it in MatchTime's application fee, and charge the collector's card only for the
shortfall at month end.

**Kemal, 2026-10-01: not planned.** Players at these clubs generally pay the collector by
direct bank transfer, which never passes through MatchTime, so the setting would cover
little of the fee for most clubs while adding a second money path, refund handling, a
shares ledger, month-end credits and a VAT question for the accountant. The club fee tip
(7.2) gives the same result for every club, whatever the payment method: the collector
adds the share to what players transfer and pays the £9.99 by card.

It could be revisited if card payments through MatchTime become common. The earlier
design (shares carried in `application_fee_amount`, a `ClubFeeShare` table, a Stripe
customer balance credit against the full-price invoice, refunds of the share) is in this
file's history at commit `8dc9646` (#176).

**Under the games-played charge** the tip still covers the fee the same way: the collector
adds the per game share to what players pay, and the card pays only for the games
played.

---

## 15. Decisions

### 15.1 Earlier decisions (record, 2026-10-01)

Status under the games-played charge: **1, 2, 4, 5, 8, 10, 11, 12, 14, 15, 16, 17, 18
still hold** as written. **3** (the 49 hour Checkout trial rule) **no longer applies**:
adding a card charges nothing. **6** (removal) becomes "pause at once, the games played
before it are charged at the end of that month". **7** (suspend) becomes "the open month
is waived". **9** and **13** (Custom range and floor) now set a monthly **maximum**; the
range £1.00 to £9.99 stays, and anything that works out under 30p is not charged.


1. **Trial length: 30 days from approval, then 7 days grace.** Recommend yes, as in the
   outline. The site says "first month free"; the grace week is on top and not advertised.
2. **Self-join clubs approved before billing is switched on** (your test clubs, today's
   first prospects): recommend they stay free until you press **Start free month** for
   each, so nobody gets a "your free month ends" DM for a month that silently started
   earlier.
3. **Card added late (day 29 or 30):** recommend the trial end is pushed to at least 49
   hours ahead (Stripe's minimum), so they get one or two extra free days rather than an
   early charge.
4. **Who adds the card. Decided (Kemal, 2026-10-01): the money collector**
   (`paymentHolderId`); the OWNER when none is set, with a "set a money collector" line in
   each card reminder. Admins see the status on `/admin/settings`. Recommended way to do
   it safely (4.5): a billing page `/billing/[orgId]` outside `/admin`, with its own
   guard, reached by the existing signed-in link (`buildAdminLink`, 9 day TTL). The
   collector needs no admin role and gets no access to admin pages, as with today's
   `/collect/<matchId>`. Please confirm the page approach.
5. **When the collector changes. Decided (Kemal, 2026-10-01):** the Stripe customer stays
   with the club; the new collector is DMed once to put their card on at their
   convenience; the old card keeps paying until then. Two recommendations:
   (a) **remove the old card automatically** once the new one is the default, and tell
   its holder in one DM (4.5 point 5). Recommend yes.
   (b) **let the old card holder remove their card** before then, from the billing page;
   the club then follows the normal payment-failed path if no new card arrives (4.5
   point 6). Recommend yes.
   Plus: the Portal's invoice history is switched off so a new collector never sees an
   earlier collector's billing address; each payer gets invoices by email.
6. **Removing MatchTime from the group** (B5): recommend it pauses billing and cancels at
   the end of the paid month, no refund, no DM. Alternative: skip B5 and rely on the
   Portal cancel only (then a removed club in trial would still get reminder DMs).
7. **Your off switch on a paying club** (suspend): recommend cancel the subscription at
   once with no automatic refund; you refund by hand in Stripe if you choose.
8. **VAT method:** confirmed, Cressoft is VAT registered and £9.99 includes VAT.
   Recommend a **fixed 20% inclusive Tax Rate**, not Stripe Tax (free, and exact for UK
   only); the Price is still created tax inclusive so a later move to Stripe Tax is easy.
9. **Custom price range:** recommend £1.00 to £9.99, monthly only, effective from the next
   month for clubs already paying. No annual plan for now.
10. **AI cap for paying clubs. Decided (Kemal, 2026-10-01):** $2.00 a day for the free
    month (30 days from approval), then $1.50 a day; Sutton keeps its $1.50 override;
    unapproved and muted $0. `AI_DAILY_CAP_DISABLED` stays in code as an emergency
    override and is removed from production. Admins are told once a day when their
    club reaches its cap (section 9).
11. **UK only at first:** recommend yes. Non-UK billing address or card: subscription
    kept, club flagged "Check VAT country" for you to decide. Selling to consumers in
    Turkey or the EU waits until your accountant has set up foreign VAT (Turkish
    simplified registration, EU non-Union OSS).
12. **Invoice details:** please confirm the exact legal name, registered address and VAT
    number to put on invoices (Stripe Settings, Business details), and whether the
    footer should say "MatchTime is a service of {legal name}". Recommend also letting
    a club enter its own VAT number at Checkout.
13. **Custom price floor:** a £5.00 plan nets £4.17 before Stripe and AI, roughly
    break-even at £3 of AI. Recommend £5 as the lowest custom price you offer in
    practice, and Free (not a lower price) for anyone below that.
14. **Adding the club fee to match fees. Decided (Kemal, 2026-10-01): not planned**
    (section 14). Clubs cover the fee with the club fee tip: the collector adds the
    per-player share to what players transfer and pays £9.99 by card.
15. **Rounding the share:** recommend **up to the next 5p** (25p, 20p, 15p): round
    numbers to add to a match fee, and a full game covers the fee with a little to spare.
    Alternative: up to the next penny (18p for a 7-a-side), which leaves almost no slack.
16. **Games per month in the tip:** recommend **4 per weekly game, every month**, not
    the real calendar count, so the tip does not change month to month and a five-week
    month or a cancelled week is absorbed.
17. **Reading the tip twice:** the collector gets the tip in their day 21 card DM; the
    admin channel tip is skipped when it would reach only them, but in "each admin" or
    "admin group" mode a collector who is also an admin (or in the admin group, which the
    server cannot see) may read it twice. Recommend accepting the repeat (7.1).
    Alternative: store the admin group's members from the Pi, a separate piece of work.
18. **AI top-up size and price (slice T1, 9.1).** Recommend **one size: £5.00 including
    VAT for $4.00 of extra AI**, which lasts until used. After VAT (£0.83) and Stripe's
    card fee (about £0.28) about £3.89 is left, roughly $5.20, so $4.00 of AI leaves a
    small margin for refunds and support. $4.00 is about two and a half extra days at
    the $1.50 cap, or many days for a club that only goes slightly over. Alternative: a
    second £10 size for $8.50. Your call.

### 15.2 Decisions for Kemal (2026-10-02)

1. **Which month is billed.** Recommend **the club's own month**, from the day its free
   month ends to the same day next month (London midnights; free month ends 1 Nov means
   calendar months), charged at 10:00 the morning after it ends. No part months, so
   played over scheduled is always fair. Alternative: calendar months for every club, with
   the free month stretched to the end of the calendar month it ends in (30 to 60 days
   free, simpler wording, "October" in every receipt).
2. **What counts as scheduled and played.** Recommend **scheduled = every week of the
   club's weekly game(s) in the month, plus any extra match**, so a paused or summer-break
   week lowers the fee; and **played = the match ended, was not cancelled, and at least
   one player said IN or a score was entered** (any ended match for a club that does not
   track IN), never counting a format pair or a ghost twice. Alternative: count only match
   rows (simpler, but a part month of games with the rest of the month off would pay in
   full).
3. **How Stripe charges it.** Recommend **no subscription: the card is saved, and our cron
   creates one VAT-inclusive invoice per month with something to charge** (5.1, option b).
   No £0 invoices, no race with Stripe's period end, and the subscription half of B3 goes.
   Alternative: a subscription with a metered price, keeping more of B3 but with £0
   invoices and a timing risk at every month end.
4. **Small charges, stopping and Custom plans.** Recommend: under **30p nothing is
   charged** (only possible on a low Custom plan with few games played); **Stop paying ends at the
   end of the current month**, which is charged for its games as usual; removal from the
   group charges the games played before it at the month end; a suspension waives the open
   month; and a **Custom price is a monthly maximum** that scales the same way (3 of 4 on
   £5 is £3.75).
