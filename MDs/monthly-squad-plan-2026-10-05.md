# Monthly squad: regulars who prepay for the month, PAYG players who fill the gaps

Design only. 2026-10-05. No code, schema or production row is changed by this PR.

**Status, 2026-10-05.** Kemal accepted all six recommendations (D1 to D6, section 13). Slice 2
is built (schema, settings, the month page, and starting a month part-way through, section
4.5). Kemal also asked not to wait for November, so the slice order changed: see "Timing" below
and the order at the top of section 12.

**Status, 2026-10-06.** Slice 5 (the weekly flow) is built, ahead of slices 3 and 4 as planned.
What was built, and where it differs from the text below, is in "Slice 5 as built" at the end
of section 12. Nothing in it needs a Pi deploy.

**Status, 2026-10-06 (later).** Slice 3 (the month opens, sign-up) is built. What was built,
and where it differs from sections 4.1 and 6.2, is in "Slice 3 as built" at the end of section
12. Replying IN to the list post as a WhatsApp quoted reply needs a Pi change; the typed
"IN FOR NOVEMBER" works without one.

Written for the "Vets MNF" prospect group (Monday night 7-a-side, about 14 players) after
Kemal joined it. Everything here is a per-club setting that is OFF by default, so Sutton FC
and every other club behave exactly as they do today.

Code read on `origin/main` at `cd7bfb2`. Every claim about existing behaviour cites the file
it was read from. The group's chat was read for its patterns only: no names, numbers or bank
details from it appear in this document. Everyone below is a made-up name.

---

## Summary for Kemal (one screen)

**How the group runs today, by hand.** Near the end of each month the organiser posts "List
for November" with numbered slots. People copy the whole list, add their name and paste it
back, so the list is re-pasted 20 to 30 times a month. Regulars commit for the month and pay
the collector by bank transfer before a deadline ("by Friday", so he can pay the venue
invoice). The price is worked out once numbers are known: a per-game share times the number
of games, minus credits. In October that was £7.50 a game: £30 for four games, or £22.50 for
anyone carrying one game of credit. A "pensioners rate" exists. PAYG players pay £8 a game,
some only on named dates ("PAYG 5th only"). A regular who misses a game stays paid and gets
credit off next month ("credits in arrears"). The same pasted list carries "(Paid £22.50)"
marks and, each week, a "Paid but can't play" section, and a PAYG player is found for each
empty slot.

**What we build: a "monthly squad" mode, in seven slices (one PR each, smallest first).**

1. **A list reader (no AI).** It reads their list exactly as they write it: month header,
   numbered and blank slots, "(Paid £22.50)", "paid", "(PAYG)", "(PAYG 5th only)" and the
   "Paid but can't play" section. It also fixes a real bug today: that section's names are
   read as playing names.
2. **Settings and data.** A "Monthly squad" switch on `/admin/settings`, a month table, a
   member table (regular or PAYG, standard or concession, slot) and a credits ledger. Nothing
   is posted yet.
3. **Month sign-up.** Seven days before the month's first game MatchTime posts "List for
   November" with this month's regulars already on it. People join by pasting the list with
   their name (as now), replying IN or PAYG to the post, or using a link.
4. **Price and payments for the month.** The organiser enters the per-game share (MatchTime
   suggests venue cost / regulars, and shows the club fee tip). MatchTime computes each
   regular's amount (share x games, minus credits) and posts the priced list. "(Paid ...)"
   marks and "paid" DMs are recorded. The collector confirms them in one tap. Reminders go
   out before the deadline, and the collector gets a summary after it. Regulars never get the
   per-match £ pay links.
5. **The weekly flow.** Each Monday's squad is the regulars plus that date's PAYG players. "Can't
   make it" moves a regular to "Paid but can't play" and earns a credit. The empty slot is
   offered to the bench and then to the PAYG pool (bench offer post plus DMs), and the PAYG
   player keeps that slot number. PAYG players pay £8 through today's per-match payments. The
   list is posted in their format, in one message, re-posted only when it changes.
6. **Credits and month close.** Credits are applied to next month's amount. A cancelled week
   gives every paid regular a credit. MatchTime handles joining or leaving mid-month, and the
   collector gets the month summary.
7. **Card payment for the month (optional).** It reuses the Stripe Connect checkout with the
   month amount. Bank transfer stays the default.

F3 (learn how a group runs) would turn this on later. F3 is not built yet: there is no PR,
only the backlog entry. When it is built, a free check for "List for <Month>" posts is enough
to suggest monthly mode.

**AI cost: zero new model calls, and no prompt changes.** Everything is fixed-vocabulary
parsing and arithmetic. Reading pastes before they reach the router should save about one
call per paste. No live-LLM run is needed for any slice.

**Club fee:** unchanged. It is still charged by games played. On the pricing screen the club
fee tip says it monthly: "add about 80p to each regular's month".

**Timing (changed 2026-10-05: start this week, not in November).** A club can open the
CURRENT month part-way through (section 4.5), so the order is now:

1. **Slices 1 and 2 now.** The organiser switches the mode on, opens October on `/admin/months`
   and seeds it from his own list.
2. **Slice 5 next (the weekly flow),** so the club can run the rest of October: the Mondays of
   12, 19 and 26 October.
3. **Slices 3 and 4 after that,** for the November sign-up. November 2026 has five Mondays
   (2, 9, 16, 23 and 30) and its list goes out around 26 October, so both must be live by
   about 24 October.
4. **Slice 6 by 1 December** (credits and month close). Slice 7 stays optional.

**Decisions for Kemal:** six, in section 13, each with a recommendation.

---

## 0. What I checked

- **The group's chat**, from the day Kemal was added (28 Sep) to today (5 Oct). About 25
  pasted lists, the price messages, the credit rules in the organiser's own words, two
  payment chases and one week's drop-outs and PAYG search.
- **Code on `origin/main` at `cd7bfb2`:**
  - Rolling squad: `rolling-squad.ts`, `rolling-squad-rules.ts`.
  - Weekly deadlines: `weekly-deadlines.ts`, `deadline-summary.ts`.
  - Bench and organiser pick: `bench-confirmation.ts`, `bench-offer-copy.ts`,
    `organiser-pick.ts`, `organiser-pick-rules.ts`, `squad-capacity.ts`, `squad-reclaim.ts`.
  - Admin channel: `admin-channel.ts`, `admin-group.ts`.
  - Pasted lists: `pasted-roster.ts`, `pasted-roster-registration.ts`, `squad-from-list.ts`,
    the analyze route (`api/whatsapp/analyze/route.ts`), `group-copy.ts`.
  - Payments: `payments.ts`, `payment-flow.ts`, `payment-claim.ts`,
    `payment-claim-classifier.ts`, `direct-payment.ts`, `unpaid-rules.ts`, `unpaid-list.ts`,
    `owner-deps.ts`, `stripe.ts`, `poll-vote/route.ts`.
  - Club fee: `club-billing-rules.ts`, `club-billing-cycle-rules.ts`, `club-billing-view.ts`.
  - Also: `recruit.ts`, the i18n tables and tests, `prisma/schema.prisma`, `vercel.json`, the
    Baileys inbound reader (`whatsapp-bot/src/baileys/inbound.ts`), `MDs/findings.md` (F1 and
    F3), and `MDs/friday-group-features-plan-2026-09-30.md` and
    `MDs/club-fee-billing-plan-2026-10-01.md` for conventions.
- **No production database reads were needed.** Vets MNF is not a MatchTime club yet.

### Five facts from the code that shape the design

1. **A pasted list registers almost nobody today, on purpose.**
   - `reconcilePastedRoster` (`pasted-roster.ts:303`) registers names only when the paste
     restates the current confirmed squad as an exact prefix, in order, and then adds names
     after it.
   - Vets MNF changes slots in the middle (slot 6 goes from one regular to a PAYG player), so
     every one of their pastes would be `prefix-mismatch` and register nothing. Monthly mode
     needs its own reader, keyed by slot and name, not by prefix.
2. **"Paid but can't play" is read as playing names today.**
   - `parsePastedRoster` (`pasted-roster.ts:171`) only knows the headers `Reserves`, `Subs`,
     `Substitutes` and `Standby` (`RESERVE_HEADER`, `:85`).
   - Any other header line is skipped, and the numbered lines under it are pushed onto the
     playing entries. So "1. Sam" under "Paid but can't play" becomes a 15th playing name.
   - The clamp keeps that from writing anything today. It is still wrong, and slice 1 fixes
     it for every club.
3. **The "(Paid £22.50)" information is thrown away.**
   - `cleanName` (`pasted-roster.ts:103`) strips a trailing bracket and does not keep it.
   - "Toby paid" (no brackets) survives as the name "Toby paid".
   - Nothing reads payment marks from a list anywhere in the code.
4. **Payments are per match only.**
   - `paidAt` lives on `Attendance` (one row per player per match, `schema.prisma` ~1476).
   - Pay links are released per match (`releaseMatchPayments`, `payment-flow.ts:35`) and
     chased daily (`bot-scheduler.ts` ~2063).
   - `PaymentCredit` (`schema.prisma:1621`) is a different thing from the group's "credit".
     It is a count of players one person paid for on one match ("Amir paid for 4").
   - There is no balance, no per-player price and no month anywhere for players.
   - There is no bank-details field, and the code never stores or shows account numbers.
5. **MatchTime never marks anyone paid on their word.**
   - A player's "paid" DM goes through two gates: a database check first, then one Haiku
     call (`payment-claim-classifier.ts:14`).
   - Even then it only sets "pending" (`markDirectPaymentPending`, `direct-payment.ts:107`).
     Only the collector's confirmation or a settled Stripe payment sets `paidAt`. A test pins
     this: `__tests__/paid-claim-never-sets-paid-at.test.ts`.
   - Vets MNF does the opposite today: players write "(Paid £22.50)" on their own line and
     everyone trusts it. Decision D3 settles this.

---

## 1. How the group actually works (patterns from the chat)

Made-up names throughout. The collector is "Sam" and the co-organiser is "Rob".

| Pattern | What the chat shows |
|---|---|
| Month list | Rob posts "List for October:" with three names and a "4. ...". People add themselves by copying the whole list and appending a line. The first full list took about 4 hours and 13 pastes. |
| Committing | A regular simply appears on the list. A newcomer is told "we normally have the majority pay monthly so Sam can secure the venue; 1 or 2 spaces if you fancy it weekly; or stay PAYG". |
| Price | Sam: "4 Mondays next month, we are one Monday in credit, let's see numbers then I can tell you cost". Later: "£22.50 for 4 games next month, pay by Friday as I need to pay the invoice". Someone else: "£22.50 for ones in credit". Sam: "£30 for newbies". 4 x £7.50 = £30 and 3 x £7.50 = £22.50, so the "newbie price" is **the full price with no credit**, not a separate tier. |
| Concession | One line reads "(paid pensioners rate)". The amount is never stated. |
| Paid marks | Written by the payer, in every style: "(paid)", "(Paid £22.50)", "(paid 22.50)", "Paid 30", "paid" with no brackets. One player asked someone else to "put paid on my name, it doesn't work for me" (he could not edit the list), and they did. |
| Chasing | Sam: "Lads please don't forget to do your payments. Missing 4." Count only, in the group. |
| PAYG on dates | "8. Alan (PAYG 5th only)". |
| Away weeks | "I can't make the next two Mondays as working away". Sam: "If you do your sub I can take it out of the following month, so next month you will be 3 games in credit." Kemal: away for two weeks at half term, will pay the whole month; Sam: "you will have 2 weeks credit following month, we do credits in arrears ... it's easier to calculate venue cost to each person that way". |
| Weekly drops | A regular's line is blanked and his name moves to a new "Paid but can't play" section. A PAYG player is then written into **the same slot number** ("6. Omar (PAYG)"). By match day the section had 5 names. |
| Finding PAYG | "Anyone free tomoz PAYG?" in the group, tagging two people. Kemal found one from another group. |
| Format | "7v7 this week?" / "Need 8v8". The list is 14 slots, and the format follows numbers. |
| After a game | PAYG players are asked to transfer £8 each to the collector. They reply "paid". |

What matters for the design:
- **Two clocks:** a monthly one (sign up, price, pay) and a weekly one (who plays Monday).
  One list carries both.
- **Slot numbers are stable through the month.** A fill-in takes the vacated number.
- **Credits are counted in games**, valued at the month they are used in.
- **Free text is short and formulaic.** Almost every state change is a re-pasted list.

---

## 2. The mode in one picture

```
            ~7 days before                 pay-by date             each Monday            morning after
            first game                     (e.g. Fri)                                     last game
 MONTH  ──► [list opens] ──► sign-ups ──► [priced] ──► payments ──► [running] ─────────────► [closed]
            regulars carried               amounts posted   reminders    weekly flow             credits settled,
            over from this month           (share x games   + summary                            summary to collector
                                           minus credits)
 WEEK                                                       seed regulars + dated PAYG ──► OUT = can't play + credit
                                                            ──► slot offered (bench, then PAYG pool) ──► PAYG pays £8 per game
```

Club setting `squadMode`: `"weekly"` (today, the default for every club) or `"monthly"`.

---

## 3. Data model (slice 2)

All additive. No existing column changes meaning.

**`Organisation`** (new columns)

| Column | Type | Meaning |
|---|---|---|
| `squadMode` | String, default `"weekly"` | `"weekly"` or `"monthly"`. CHECK constraint like the billing columns. |
| `paygPricePence` | Int? | Default PAYG price per game (800). Copied to `Match.feePerPlayer` for PAYG rows (5.6). |
| `monthListOpensDaysBefore` | Int, default 7 | When "List for <Month>" is posted, counted back from the month's first game. |
| `monthCreditRule` | String, default `"any-miss"` | `"any-miss"`, `"filled-only"` or `"none"` (D2). |
| `paymentInstructions` | String? | Optional free text the collector writes, such as "bank details in the group description". It is shown in payment DMs. MatchTime never asks for account numbers; this is the club's own text. |

**`SquadMonth`**: one row per club fixture per calendar month.

| Column | Meaning |
|---|---|
| `orgId`, `activityId`, `monthStart` (DATE, the London 1st) | Unique together. The fixture is the Activity (one weekly game). |
| `status` | `"open"` (sign-up), `"priced"` (amounts posted), `"running"` (first game played), `"closed"` |
| `gamesScheduled` | The month's matches of that fixture, counted when the list opens. Recounted when a week is cancelled or added. |
| `sharePerGamePence`, `concessionPerGamePence` | Set by the organiser at pricing (D1). Null until priced. |
| `newcomerPerGamePence` | Optional override. Null means newcomers pay the standard share (the chat shows they do). |
| `venueCostPence` | Optional bookkeeping, for the suggestion and the summary. |
| `payByAt` | The payment deadline. |
| `listOpenedAt`, `pricedAt`, `closedAt`, `summarySentAt` | Idempotency claims, compare-and-set like `rollingSeededAt`. |
| `startedMidMonthAt`, `startedByUserId` | Set when an organiser opened the month after it had begun (4.5). Null for a month MatchTime opened itself. |
| `gamesPlayedBeforeStart` | Games of the month already played when it was started here. They count as played for every regular seeded then (4.5). |

**`SquadMonthMember`**: one row per person per month.

| Column | Meaning |
|---|---|
| `monthId`, `userId` | Unique together. |
| `kind` | `"regular"` or `"payg"`. |
| `tier` | `"standard"` or `"concession"` (regulars only). |
| `slot` | The list number, stable for the month (regulars first, in sign-up order). |
| `paygMatchIds` | For "PAYG 5th only": the dated matches this PAYG player is in for. |
| `absentMatchIds` | Weeks a regular has said ahead of time they will miss. |
| `gamesCovered` | Games this person pays for: the whole month, or the rest of it if they joined mid-month. |
| `creditsApplied` | Credits used against this month (games). |
| `amountDuePence` | `share x (gamesCovered - creditsApplied)`, written at pricing, rewritten on any change before payment. |
| `paidClaimedAt`, `paidClaimSource`, `paidClaimedAmountPence` | "Says paid": from a list mark, a DM, the player's page, or a mark someone else wrote. |
| `paidAt`, `paidAmountPence`, `paidConfirmedByUserId`, `paymentMethod` | Confirmed: by the collector, or by Stripe (`"bank"`, `"card"` or `"cash"`). |
| `stripeSessionId` | Slice 7. |
| `joinedAt`, `leftAt`, `refundedPence`, `note` | Mid-month changes. A refund is recorded only; MatchTime moves no money for a bank transfer. |
| `source` | How the row came to be: `"seed-list"` or `"seed-tick"` (a mid-month start, 4.5), later `"paste"`, `"reply"`, `"page"`, `"admin"`. |

**`SquadCredit`**: the credits ledger, one row per game of credit.

| Column | Meaning |
|---|---|
| `orgId`, `userId`, `games` (usually 1) | |
| `reason` | `"missed"`, `"cancelled-week"`, `"left-mid-month"`, `"manual"` or `"carried-in"` (4.5) |
| `earnedMonthId`, `earnedMatchId` | Where it came from. |
| `appliedMonthId`, `appliedAt` | Null until used. |
| `voidedAt`, `voidedById`, `createdById` | An admin can void a wrong credit. Rows are never deleted, like `AttendanceEvent`. |

**`Attendance`** (no new column). A regular's weekly row is written with
`paymentMethod = "monthly"`. Every per-match payment path then skips rows with that value
(5.6).

**Why credits are counted in games, not pounds.** That is how the group counts them ("3 games
in credit"). It also means a credit stays fair if next month's share changes (the venue raises
its price, or fewer regulars sign up). A credit is worth the share of the month it is used in.

---

## 4. The month

### 4.1 The list opens

- **When:** `monthListOpensDaysBefore` days before the next month's first match of the
  fixture. It is posted at 10:00 London, through the scheduler, with a `SentNotification` key
  `<orgId>:<monthStart>:month-list`.
  - If the next month has no matches yet, the list opens when they exist.
  - `generate-matches` makes one week ahead, and block bookings make them all up front.
  - So slice 3 makes sure the month's matches exist when the list opens. It reuses
    `planBlockGeneration` in `block-booking.ts`, or generates the month's occurrences without
    posting. Future matches stay silent through `isNextUpcomingForPosting`.
- **Who is on it:** every regular of the current month, in their current slot order.
  - Left out: anyone who has left the group (`Membership.leftAt`) or is deactivated. These are
    the same exclusions as `carryOverExclusion` (`rolling-squad-rules.ts:140`).
  - Left out: anyone who has already said they are out for next month.
  - PAYG players are not carried over.
- **What the group sees** (in their style, in English and Turkish):

```
📋 List for November (5 Mondays: 2, 9, 16, 23, 30)

1. Alex
2. Bilal
3. Chris
...
11. Jake
12.
13.
14.

Regulars from October are on already. Not in for November? Say OUT FOR NOVEMBER.
New, or want a place for the month? Copy the list and add your name, or reply IN to this message.
Playing some weeks only? Add your name with (PAYG), or (PAYG 9th only).
Price and payment details follow once numbers are in.
```

- **Sign-up:** there are three doors, all deterministic.
  1. **A pasted list** (section 6). This is what the group already does.
  2. **A reply to the list post** (WhatsApp quoted reply): IN, PAYG, PAYG with dates, or OUT.
     It uses a fixed English and Turkish vocabulary, the way `bench-prompt-answer.ts` reads
     bench answers. A reply, because a plain "IN" in the group during the sign-up week still
     means this Monday's game, as today.
  3. **The member's month page** (magic link, 9.3): "I'm in for November" or "PAYG on these
     dates".
- **Capacity:** regulars are capped at the format's `maxPlayers` (14 for 7-a-side).
  - A 15th regular is put on the month's waiting list.
  - The admin channel is told once, through `sendAdminNotice` (`admin-channel.ts:162`).
  - The organiser can raise the cap: a bigger format, or let regulars rotate.

### 4.2 Price (slice 4)

- **When the organiser sets it.** Once numbers settle, MatchTime sends the admin channel:
  "November list: 12 regulars, 2 PAYG so far. Set the price: [link]". It sends this one day
  after the list opens, or as soon as the regulars fill the slots.
- **The pricing form** (`/admin/months`) asks for:
  - share per game;
  - concession share per game;
  - optional venue cost per game (for the suggestion);
  - pay-by date. The default is three days before the first game at 21:00, which matches
    "by Friday" for a Monday game.
- **The suggestion:** venue cost per game / regulars, rounded up to the next 50p. With the
  October numbers that is £7.50 a game. The organiser can type any amount (D1).
- **The club fee tip,** under the form, in month terms. It reuses `clubFeeTip`
  (`club-billing-rules.ts:520`), "split" mode, with the month's game count:
  "MatchTime charges the club up to £9.99 a month, only for games played. For 12 regulars
  and 5 games, adding 20p a game (£1.00 for the month) to each regular's share covers it."
- **What MatchTime works out,** per regular:

| Who | Games covered | Credits from October | Due for November at £7.50 |
|---|---|---|---|
| Alex (standard) | 5 | 0 | £37.50 |
| Bilal (standard) | 5 | 1 | £30.00 |
| Kemal-like regular away 2 weeks in October | 5 | 2 | £22.50 |
| Carl (concession, £5.00) | 5 | 0 | £25.00 |
| Dev (joined from 16 Nov) | 3 | 0 | £22.50 |

  Rules:
  - Credits are taken oldest first and never below zero. Any surplus stays in the ledger for
    the month after.
  - The collector (`Organisation.paymentHolderId`) appears on the list. He is never chased,
    which is the existing rule in `summariseUnpaid` (`unpaid-rules.ts:49`).
- **What the group sees:** the list re-posted with each amount, the pay-by date and the
  collector's instructions. Amounts are shown in the group because that is the group's own
  practice: they write "(Paid £22.50)" there themselves.

```
📋 List for November: £7.50 a game, pay Sam by Fri 30 Oct
(5 games = £37.50. Credits from October already taken off.)

1. Alex: £37.50
2. Bilal: £30.00
...
Bank details: see the group description.
Paid? Add (paid) after your name, or DM me "paid".
```

### 4.3 Payment tracking for the month (slice 4)

- **"Says paid"** comes from four places, all deterministic:
  - a "(paid ...)" mark on the payer's line in a pasted list (6.2);
  - a "paid" DM;
  - the "I've paid" button on the member's page;
  - a mark someone else wrote on that line.
  - The DM path reuses `handlePaymentClaimDm` (`payment-claim.ts:257`). Its first gate is a
    database query: "is anything owed?". Slice 4 widens that query to include an unpaid
    `SquadMonthMember`. The Haiku prompt is unchanged, because the question it answers ("is
    this a payment claim?") is the same. This is a code change, not a prompt change.
- **Confirmed** is set by the collector:
  - one tap on `/admin/months`;
  - or the daily digest in the admin channel: "3 say they've paid for November: 1 Alex
    £37.50, 2 Bilal £30, 3 Carl £25. Reply ALL, or the numbers that arrived."
  - Replies are read like organiser-pick replies (`parsePickReply`,
    `organiser-pick-rules.ts:235`, numbers, ALL, NONE), with no model.
- **How it shows in the list** depends on D3:
  - recommended: "(paid)" appears as soon as it is claimed, which is the group's own habit;
  - the summary and the admin page always show "says paid" separately from "confirmed".
- **Reminders before the pay-by date:**
  - 24 hours before, a group post with the count only, as the collector does today: "4 still
    to pay for November by Fri 30 Oct."
  - The same day, one DM to each unpaid regular with their amount, how credits were applied
    and the payment instructions.
  - A second DM on the morning of the deadline to anyone still unpaid.
  - All are inside 08:00 to 21:59 London. Payment DMs ignore the DM subscription flags, as
    they do today (`Membership` comment at `schema.prisma` ~620).
- **After the pay-by date:**
  - The admin channel gets: paid and confirmed, says paid, not paid (with names), and the
    month total against the venue cost if one was entered.
  - MatchTime removes nobody. The admin page has "Move to PAYG" and "Remove for the month"
    for the organiser.
- **Late payers:** chased once a day for 3 more days by DM, then silent. The admin page keeps
  showing them.

### 4.4 Month close (slice 6)

- **When:** the morning after the month's last game (08:00 London, the rolling-seed hour).
  Claim: `closedAt`.
- **What it does:**
  - Turns every credit-earning absence into `SquadCredit` rows (most already exist, 5.3).
  - Freezes the month's numbers.
  - Sends the collector, through the admin channel:

```
📒 October summary (4 games played)
Regulars: 12. Paid and confirmed: 11 (£282.50). Says paid, not confirmed: 1 (Jake, £22.50).
PAYG: 6 games played, £48 (4 paid, 2 to chase: Omar 12 Oct, Will 26 Oct).
Credits earned for next month: 9 games (Sam x2, Joel x2, Rob, Dimitri, Alex, Bilal, Carl).
Credits used this month: 10 games.
```

- **"In arrears":** credits earned after next month was priced apply to the month after next.
  Absences declared before pricing count straight away, which matches Sam's "anything you miss
  before you get after".

### 4.5 Starting part-way through a month (added 2026-10-05, built in slice 2)

Kemal: "I don't want to wait until November, can we start this week?" So a club does not have
to begin on the 1st. An organiser opens the CURRENT month on `/admin/months` and tells
MatchTime where things stand. Nothing is posted in the group.

- **What the organiser gives:**
  - who the regulars are, and who is PAYG;
  - who has paid, and how much;
  - credits carried into the month (games);
  - optionally the share per game, so MatchTime can work out what each regular owes.
- **Two ways in, one action** (`startCurrentMonth`, admin only, a monthly club only). Both are
  on the page and can be mixed:
  - **pasting the current list** (`source = "seed-list"`). `readMonthList` reads it with the
    slice 1 reader (`parseMonthlyList`) and `draftSeedFromList` (`squad-month-rules.ts`)
    matches its names to the club's players: the whole name, then a known alias, then the
    leading name. The page ticks those players for the organiser to check. A name that fits
    nobody, or more than one player, is listed for him to tick himself; MatchTime never guesses
    between two players. Reading a list saves nothing.
  - **ticking players** (`source = "seed-tick"`).
- **"Paid but can't play" names are paid regulars** who are out this week. They are seeded as
  regulars with "says paid" and no slot of their own on that list, so they take the lowest free
  number. Reserves are not members of the month.
- **The month is `running` at once.** Sign-up and pricing happened outside MatchTime, so
  `listOpenedAt` and `pricedAt` stay empty and `startedMidMonthAt` is set.
- **Games already played count as played for the regulars on the list.**
  - The month's games are counted from the calendar (the fixture's weekday in that month), not
    from Match rows: a club new to MatchTime has no Match row for a game it played before it
    joined. October 2026 is 4 Mondays, with 1 played by Tuesday 6 October.
  - `gamesScheduled` is the whole month and `gamesPlayedBeforeStart` the part already played.
    The organiser can correct both (a week that was cancelled, for example).
  - A regular's `gamesCovered` is the whole month. Nobody gets a credit or an absence for a
    game played before the start. A regular who did miss one is given a credit by hand in
    slice 6 ("Add credit").
- **Paid state keeps the honesty rule (D3).**
  - "Says paid" is a claim (`paidClaimedAt`) and never sets `paidAt`. A paid mark read from a
    pasted list is only ever "says paid".
  - "Paid, confirmed" is the organiser's own word on the page: it sets `paidAt` and
    `paidConfirmedByUserId`.
- **Credits carried in were already taken off what the regular paid,** so they are applied to
  this month (`creditsApplied`) and written to the ledger as used: one `SquadCredit` a game,
  reason `"carried-in"`, `appliedMonthId` = this month.
- **PAYG players owe nothing for the month.** They pay game by game (5.6).
- **Slot numbers:** a number written on a pasted list is kept. Ticked players are numbered in
  the order shown, regulars first.
- **Started once.** The unique key (club, fixture, month) makes a second press, or a second
  organiser pressing at the same moment, a refusal.
- **What it does not do yet:** the weekly flow for the rest of the month is slice 5. Until
  then the month is a record the organiser keeps on the page.

---

## 5. The week

### 5.1 Who is in each Monday

- **Seeding:** each match of a running month is seeded with:
  - every regular as CONFIRMED, at `position = slot`, except weeks in their `absentMatchIds`;
  - every PAYG player whose `paygMatchIds` holds that match.
- **When:**
  - For the month's first game: at pricing.
  - For each later game: 08:00 the morning after the previous game. This is the
    rolling-squad hour (`ROLLING_SEED_HOUR`, `rolling-squad-rules.ts:25`), so the posting
    rhythm is the same.
- **How:**
  - It reuses `seedRollingSquad` (`rolling-squad.ts:66`) with a different source: the month's
    members instead of last week's CONFIRMED rows.
  - It keeps the same idempotency claim (`Match.rollingSeededAt`), the same
    `AttendanceEvent` trail (new cause `"monthly-squad"`) and the same rule that a player who
    already has a row on the target is never touched (`decideSeed`, `:172`). So an early OUT
    wins.
- **Monthly mode replaces rolling squad for that club.** The settings page shows one or the
  other, not both.

### 5.2 Saying you can't make it

- **The ways to say it:** "OUT" in the group, a DM, a pasted list that blanks their line or
  moves them under "Paid but can't play", or the match page. The OUT path is today's
  (`cancelAttendance`, `attendance.ts` ~495).
- **What monthly mode adds:**
  - If the player is a paid (or says-paid) regular this month, a `SquadCredit` is written for
    that match, following `monthCreditRule` (D2).
  - They are listed under "Paid but can't play" in the next list post.
- **Several weeks at once** ("can't make the next two Mondays"):
  - The extractor writes an OUT for the next match only. Multi-week OUT is not something the
    router handles today.
  - Rather than a prompt change, the reply to such a message adds one line: "Away more than
    one week? Tick the Mondays here: [link]". The link opens the member page (9.3), which
    writes `absentMatchIds` for any future week. Those weeks are seeded as DROPPED and
    credited.
  - Spotting "two Mondays" deterministically ("next two", "the 12th and 19th", "half term")
    is listed as a later option, not built.
- **A late drop** (after the club's weekly drop-out deadline, if one is set, #165) is still
  recorded. The admin channel is told, as today (`isLateDrop`, `rolling-squad-rules.ts:201`).
  Whether it still earns a credit is D2.

### 5.3 Filling the slot

- **Bench first.** A regular's OUT opens a place. If anyone is on the bench, today's bench
  offer runs unchanged:
  - one `BenchSlotOffer` per open slot;
  - a group post tagging the bench, plus a DM to each bencher (`bot-scheduler.ts` ~1580 to
    1680, copy `bench_offer_group_post` and `dm_bench_offer`);
  - the first to say IN wins (`resolveBenchConfirmation`, `bench-confirmation.ts:36`);
  - in organiser-pick mode (#167), the pick round runs instead.
- **Then the PAYG pool.** If the bench is empty, the place goes to the month's PAYG pool:
  - Who is in it: this month's PAYG members, plus anyone who played PAYG in the last three
    months.
  - Excluded: members with `subMatchInviteDm = false`, anyone already on this match, and
    anyone who has left.
  - What is sent: one group line, "1 place for Mon 12 Oct, £8 PAYG. First to say IN gets
    it.", and one DM each. This reuses the recruit DM builder (`recruit.ts`) and the same
    `BenchSlotOffer`, so the claim is the same atomic first-wins claim.
  - This replaces "Anyone free tomoz PAYG?".
- **The winner takes the vacated slot number.** In the chat a PAYG player was written into
  slot 6 after the regular in slot 6 dropped. This is the same idea as
  `team-slot-inherit.ts` for team sheets: the PAYG row gets `position` = the vacated slot.
- **The rest of the match is unchanged:** teams, the teams post, MoM and ratings.

### 5.4 The weekly list post

- **Their format, one message:**

```
📋 List for October: Mon 12 Oct, 20:00

1. Alex (paid)
2. Bilal (paid)
3. Chris (paid)
4. Dave (paid)
5. Ed (paid)
6. Omar (PAYG)
7. Fred (paid)
8. Alan (PAYG)
9. Gus (paid)
10.
11. Hal (paid)
12. Ian (paid)
13. Will (PAYG)
14. Jake

Paid but can't play
1. Sam
2. Joel
```

  - Paid marks follow D3.
  - A blank slot is shown blank, as the group does. The group post then says "1 place open,
    £8 PAYG, say IN".
- **When it is posted:**
  - at seeding;
  - after any change, at most once every 30 minutes, inside 08:00 to 21:59 London;
  - always on match morning.
- **Updating means re-posting.** Neither our Baileys layer nor WhatsApp itself supports editing
  a message for longer than a short window, so "updated" means re-posting. To keep the noise
  below what the group makes by hand:
  - MatchTime does **not** re-post after a member's paste that already matches its state;
  - it re-posts only when its state differs from the latest pasted list (a DM, the web page,
    a fill-in, or a correction).
- **A note on edited messages.** A member who edits a pasted list (WhatsApp's "edited") is not
  seen: `inbound.ts:201` drops protocol messages, edits included. The original paste is read.
  That is acceptable, because the next paste or the next post corrects it. It is listed in
  section 10.

### 5.5 Teams, MoM, ratings, stats

These are unchanged. Monthly mode only decides who is CONFIRMED.

### 5.6 Per-match payments in monthly mode

- **Regulars:** their weekly `Attendance` rows carry `paymentMethod = "monthly"`. Three paths
  skip those rows:
  - `releaseMatchPayments` (`payment-flow.ts:35`, no pay link);
  - the daily pay chase (`bot-scheduler.ts` ~2063);
  - `summariseUnpaid` (`unpaid-rules.ts:49`), so they are not counted in the unpaid tail or
    the admin unpaid list.
  - The payment poll at match end (`bot-scheduler.ts` ~1924) is skipped for monthly clubs. It
    would ask regulars to pay again.
- **PAYG players:** today's per-match flow, unchanged.
  - The match fee defaults to `paygPricePence`. The collector is still asked to confirm it the
    first time (`fee-confirm.ts`).
  - PAYG players get pay links (direct, bank or card, as the club allows), and a PAYG "paid"
    DM is read by today's claim path.
- **Guard test:** a monthly regular never receives a pay link, chase or poll.

---

## 6. Reading their pasted lists (slices 1 and 3)

### 6.1 The reader (slice 1, pure)

`parseMonthlyList(body)` lives in a new `src/lib/monthly-list.ts`. It returns:

- `month`: from "List for October", "October list", "Ekim listesi" and similar, or null;
- `slots`: `[{ slot, name, marks }]`. A blank slot is kept as `name: ""`, and the slot number
  is kept as written;
- `sections`: `cantPlay[]` ("Paid but can't play", "can't play", "out", "injured",
  "gelemeyenler", "ödedi gelemiyor") and `reserves[]` (the existing `RESERVE_HEADER` words);
- `marks` per line, from a fixed vocabulary:

| Written | Read as |
|---|---|
| `(paid)`, `paid`, `(Paid £22.50)`, `(paid 22.50)`, `Paid 30`, `ödedi`, `ödendi` | `paid`, with an amount if one is written |
| `(paid pensioners rate)`, `(paid concession)`, `(OAP)` | `paid`, tier hint `concession` |
| `(PAYG)`, `PAYG` | `payg` |
| `(PAYG 5th only)`, `(PAYG 9th, 23rd)`, `(PAYG 9 Kasım)` | `payg` with dates |
| any other bracket ("(Bossman)", "(GK)") | ignored, as today |

- **Names:** cleaned by the existing `cleanName` rules, after the marks are taken out, so "Toby
  paid" becomes the name "Toby" with the mark `paid`.
- **Emoji inside a name** ("Dev😁") is folded by `normaliseName` (`name-normalise.ts:29`).
- **The same slice fixes `parsePastedRoster`** for every club: an unrecognised header line now
  ends the playing block, so the lines under "Paid but can't play" are no longer read as
  playing names. That can only remove names from what the route considers, never add them.

### 6.2 Reconciling a paste with MatchTime's state (slice 3, then 5)

A paste is compared with MatchTime's own current list (the month's members and this week's
squad), **by name, not by position**. Names are resolved through the existing chain:
`resolveOrProvisionByName` in the analyze route (~3813), which tries exact, then first-name
fuzzy, then `UserAlias`, then provision. An ambiguous name is skipped.

| Difference in the paste | During sign-up (month open) | During the month (running) |
|---|---|---|
| A new name in a numbered slot | Regular for next month (PAYG if marked) | PAYG for this week's match, if a place is open; otherwise the bench |
| A name now under "can't play", or its line blanked | OUT for next month if the paste is in sign-up | OUT for this week (5.2), with a credit if they are a paid regular |
| A new paid mark | "Says paid" for the month (4.3) | Same. On a PAYG line it is a PAYG claim for this week. |
| A name missing that MatchTime has in | Ignored (see stale pastes below) | Ignored |
| Slot numbers reordered | Ignored. MatchTime's slot numbers stand. | Ignored |

- **Who can change whose line (D4):**
  - The sender's own line is always applied.
  - A change on someone else's line: recommended to apply it and DM that player, "Rob moved
    you to 'Paid but can't play' for Mon 12 Oct. Wrong? Reply IN." The chat shows players do
    this for each other ("put paid on my name").
  - A paid mark written by someone else is always "says paid", never confirmed.
- **Stale pastes:** someone copies an old list and adds their name, which re-adds a player
  who has since dropped. The rule is that **a paste can only move a person forward from what
  MatchTime last showed**. Re-adding a dropped player, or removing a paid mark, needs the
  player themselves or an admin. Otherwise every old copy would undo the week. The admin
  channel gets a one-line note when a paste is ignored this way, at most once a day.
- **Attribution and aliases:** a self-addition teaches a `UserAlias`, the same idea as
  `squad-from-list.ts` (`attributeDiffs`, ~386), but without its Sonnet call. The diff is
  against MatchTime's state, which it already holds.
- **Where in the route:**
  - For a monthly club, a list-shaped message is read by this reader **before** routing, and
    the route stops there.
  - Before slice 3 lands, check whether the router is already called for a paste today. If it
    is, this also saves a model call per paste.
  - Known risk (the terminal short-circuit bug class): an early return skips every guard below
    it. Slice 3 must call the same membership, mute, approval and AI-budget guards before
    returning, with a test per guard.
- **What MatchTime replies:**
  - Nothing in the group for a paste that only restates the list. A ✅ react on a paste that
    changed something, as for IN today.
  - Then the list post if its state now differs (5.4).

---

## 7. Members, prices and edge cases

| Case | Behaviour |
|---|---|
| **Regular** | In every week of the month unless they drop. Pays `share x games - credits`. |
| **Newcomer** | A regular with no credits, so pays the full amount. This is what the chat shows: £30 is 4 x £7.50. An optional newcomer share exists for clubs that charge more. |
| **Concession** | A regular with the concession share. Set by the organiser per member, or from a "(paid pensioners rate)" hint, which the admin confirms. |
| **PAYG** | Per game at `paygPricePence`, through the per-match flow. Can name dates. |
| **Joining mid-month** | Becomes a regular from the next unplayed game. `gamesCovered` = games left, amount = share x games left. The admin page can override. |
| **Leaving mid-month** (quits, or leaves the WhatsApp group) | Games left become credits (`"left-mid-month"`). If they never come back, the admin page shows "credit owed: 2 games, £15". The collector refunds it his own way and taps "Refunded", which writes `refundedPence` and voids the credits. |
| **Refunds in general** | Recorded, never sent. MatchTime cannot move bank money. A card payment (slice 7) can be refunded from the Stripe dashboard, and MatchTime records it from the webhook as it does today. |
| **5-Monday months** | `gamesScheduled` counts the real matches, so November 2026 is 5 games and £37.50 at £7.50. The list header names the dates. |
| **A cancelled week** | Cancelling the match (admin page, or a block cancel through `block-booking.ts` `selectCancellable`) writes one `"cancelled-week"` credit for every paid regular. The group is told "Mon 19 Oct is off. Regulars get 1 game credit off December." This matches "we are one Monday in credit". |
| **Venue price change** | Next month: the organiser sets a new share. This month: once anyone has paid, the price is locked. Changing it is an admin action that rewrites unpaid amounts and lists the paid ones as "owes £x more" or "£x credit", for the collector to settle. |
| **Format change mid-month** (7v7 to 8v8) | Today's format switch (`format-switch.ts`). Capacity changes for that week only. Monthly members are unaffected. |
| **More regulars than places** | Month waiting list (4.1). The organiser decides. |
| **Player in two clubs** | Members and credits are per club (`orgId`), like club-scoped ratings. |
| **The collector** | On the list, never chased (existing rule), and can mark his own line paid. |

---

## 8. Reminders and messages at a glance

Every message has English and Turkish keys in `strings.en.ts` and `strings.tr.ts`. The parity
test (`i18n/__tests__/strings.test.ts`) covers matching keys, no dashes in Turkish, and no
time-of-day greetings. All group posts are inside 08:00 to 21:59 London.

| When | Where | What |
|---|---|---|
| List opens (first game minus 7 days, 10:00) | Group | "List for November", regulars carried over (4.1) |
| One day later, or when the slots are full | Admin channel | "Set the price" with the link and the club fee tip |
| Priced | Group | Priced list with amounts and pay-by date |
| 24 hours before pay-by | Group | Count of unpaid |
| 24 hours before pay-by, and the deadline morning | DM to each unpaid regular | Amount, credits applied, payment instructions, "reply paid when done" |
| Daily while claims are waiting | Admin channel | "N say they've paid", reply ALL or numbers |
| After pay-by | Admin channel | Paid, says paid, unpaid, total against venue cost |
| Seeding, after changes, match morning | Group | Weekly list (5.4) |
| A regular drops, bench empty | Group plus PAYG pool DMs | "1 place, £8 PAYG, first to say IN" |
| A paste changes someone else's line | DM to that player | "Rob moved you to ..., reply IN if wrong" |
| Month close | Admin channel | Month summary (4.4) |

---

## 9. Admin pages

### 9.1 `/admin/settings`

There is a new "Monthly squad" section next to "Weekly routine". Each control has an ⓘ (F1,
PR #195).

- **How your squad works:** "Weekly (who said IN)" or "Monthly (regulars pay for the month)".
  Switching to monthly turns off rolling squad for the club and says so.
- **PAYG price per game.**
- **List opens:** N days before the month's first game.
- **Credits:** "Every game a paid regular misses" / "Only when their place is filled" / "No
  credits" (D2).
- **Payment instructions** (free text, optional).
- **Money collector** (existing, `setPaymentHolder`).

### 9.2 `/admin/months` (new)

- **Month tabs:** next month and this month, plus older months read-only.
- **Price form** with the suggestion and the club fee tip (4.2).
- **Member table:** slot, name, regular or PAYG, tier, games, credits used, due, status (not
  paid / says paid / confirmed, with source and time), and actions:
  - confirm or unconfirm paid;
  - change tier;
  - move to PAYG;
  - remove for the month;
  - mark away weeks;
  - add a member.
- **Credits tab:** the ledger per player (earned, used, void, refunded), with "Add credit" and
  "Void".
- **"Post the list now"** button.
- The match page (`/admin/matches/[id]`) shows "Paid but can't play" and PAYG labels.

### 9.3 The member's page (magic link)

Reached from any payment or sign-up DM and from "my month" in a DM. It shows:

- "In for November / PAYG on these dates / Not this month";
- the amount and how credits were applied;
- an "I've paid" button and the payment instructions;
- "Mondays I can't make" (ticks);
- "Pay by card" when slice 7 is on.

---

## 10. Risks and things that stay manual

- **The money itself is never seen.** Bank transfers happen outside MatchTime, so "confirmed"
  means the collector said so. This is the same honesty rule as today.
- **List ping-pong.** Mitigated by "don't re-post after a paste that matches" and the 30-minute
  floor (5.4). If the group still finds it noisy, the next step is to post the weekly list
  only at seeding and on match morning.
- **Edited messages are not read** (`inbound.ts:201`). The next paste corrects it. Reading edits
  is a separate Pi change, not planned here.
- **Multi-week OUT in free text** is not understood. It is covered by the member page link (5.2).
- **Stale pastes** are handled by the forward-only rule (6.2). The rule may need loosening if
  real use shows people legitimately re-adding others.
- **First month:** run a dry month with the organiser before trusting the summary. Slice 6's
  summary can be compared line by line with Sam's own sums for November.

---

## 11. F3, AI cost and the club fee

### 11.1 F3 (learn how the group works)

- **Status, checked today:**
  - F3 is a backlog entry in `MDs/findings.md` ("F3. Learn how the group works and set it up
    that way", 2026-10-01).
  - There is a local branch `feat/f3-learn-group-setup` with no code of its own.
  - `gh pr list --state all` shows no F3 PR.
  - So "being built, PR pending" is not what the repo shows yet.
- **How it maps:**
  - F3's plan already lists signals such as "an admin posts the list" (rolling squad) and
    "paid, sent, transferred" (payment tracking). Monthly mode adds one more: "List for
    <Month>" posts, "pay for the month", "in credit" and "PAYG". Those suggest
    `squadMode = "monthly"`, with the default PAYG price from the most common "£N" near
    "PAYG".
  - **This one needs no AI.** The new month-list reader (6.1) run over the captured history
    counts "List for <Month>" pastes for free. Two or more is a strong signal. F3's model call
    can confirm it, but is not needed for it.
  - Because monthly mode changes how money is asked for, F3 should **suggest** it, not apply
    it (D6). The organiser DM says "Your group runs a monthly list. Switch MatchTime to
    monthly mode? [link to settings]".

### 11.2 AI cost

- **No new model calls in any slice:**
  - list reading, sign-up replies, paid marks, pick-style admin replies and all arithmetic are
    code;
  - the "paid" DM path keeps its one existing Haiku call, with a wider first gate (4.3).
- **Likely savings:** a paste in a monthly club stops before routing (6.2), and this group
  pastes 20 to 30 times a month. The organiser's PAYG searches are replaced by a deterministic
  offer.
- **No prompt changes, so no live-LLM runs.** If a later slice wants multi-week OUT understood
  in free text, that is a router or extractor change. It needs a full prompt rewrite (not an
  append) and Kemal's approval for one paid check.
- **Every slice ships unit tests and Playwright tests, which are free.**

### 11.3 The MatchTime club fee

- **Billing is unchanged.**
  - The club is charged by games played (`countClubMonth` and `monthFee`,
    `club-billing-cycle-rules.ts:374` and `:489`).
  - Its "club month" is anchored on the free month's end, not the calendar month. The two
    months need not line up, and nothing here depends on them doing so.
- **The tip** appears on the pricing form and in the "set the price" admin message. It uses
  `clubFeeTip` "split" mode with the month's games: about 20p a player a game for 7-a-side,
  shown as a monthly figure for regulars ("about £1 a month for 5 games").
- **Adding the fee automatically** to the share is not planned. That matches the club fee
  plan, which says it does not add the fee to match fees (its section 14).

---

## 12. Slices (one PR each, smallest first)

**Build order (changed 2026-10-05):** 1, 2, **5**, 3, 4, 6, then 7 if wanted. Slice 5 moved
ahead of 3 and 4 so that a club that starts part-way through October (4.5) can run the rest of
the month. Slices 3 and 4 follow for the November sign-up. The slice numbers below are
unchanged, so earlier references still hold. Two things slice 5 can no longer assume:

- a `running` month may have no price (`sharePerGamePence` null) and no `pricedAt`, so the
  first seeding of a mid-month start is triggered by the start, not by pricing;
- "says paid" may come only from the organiser's seed, because the paid-claim paths are slice 4.

Every slice:
- follows red, green, refactor;
- adds English and Turkish copy together;
- leaves every club with `squadMode = "weekly"` byte-for-byte unchanged, proved by the
  existing golden snapshots (`copy-golden.test.ts`) and a test per slice;
- needs no live-LLM run.

### Slice 1: list reader, and the "can't play" fix (pure, about 1 day)

- **What:** `src/lib/monthly-list.ts` (`parseMonthlyList`, the marks vocabulary, the section
  headers, English and Turkish). Plus `parsePastedRoster` stops reading lines under an
  unknown header as playing names.
- **Unit tests:**
  - fixtures modelled on the chat shapes, with made-up names: the 14-slot list, blank slots,
    every paid style, the PAYG date forms, emoji in names, two sections, "List for October"
    and "Ekim listesi" headers;
  - reserve headers still work;
  - the existing pasted-roster tests still pass;
  - a new test that "Paid but can't play" names never reach `entries`.
- **Playwright:** none (no UI).

### Slice 2: schema, settings, empty month page (about 1 to 2 days)

- **What:**
  - the migration for section 3 (CHECK constraints for `squadMode` and `monthCreditRule`);
  - `OrgFeatures.squadMode`;
  - the "Monthly squad" settings section with ⓘ;
  - `/admin/months` read-only skeleton;
  - the server actions, admin only;
  - no scheduler work.
  - added 2026-10-05: starting the current month part-way through (4.5), by pasting the
    group's list (read by the slice 1 reader) or by ticking players.
- **Unit tests:**
  - setting validation;
  - only admins can change it;
  - switching to monthly turns rolling squad off;
  - `getOrgFeatures` defaults to weekly.
- **Playwright:** the settings section saves and reloads; `/admin/months` renders empty for a
  monthly club and 404s for a weekly one.

### Slice 3: month opens and sign-up (about 3 days)

- **What:**
  - a month's matches exist before the list opens;
  - the list-open post (4.1);
  - carry-over;
  - the three sign-up doors (paste, quoted reply, member page);
  - reconcile during sign-up (6.2);
  - the analyze-route early stop for monthly clubs, with every guard kept;
  - the regular cap and month waiting list.
- **Unit tests:**
  - list-open timing, including a 5-Monday month and a month whose matches don't exist yet;
  - carry-over exclusions (left, deactivated, PAYG, opted out);
  - paste diffs: self-add, add for someone else, stale paste ignored, PAYG with dates;
  - quoted-reply vocabulary in English and Turkish;
  - one test per guard on the early stop (muted club, paused club, unapproved club, AI budget
    untouched);
  - a weekly club's paste behaves exactly as today.
- **Playwright:** the member page sign-up (IN, PAYG with dates, OUT for the month);
  `/admin/months` shows the sign-ups.

### Slice 4: price, payments and reminders (about 3 days)

- **What:**
  - the pricing form, suggestion and club fee tip;
  - the amount arithmetic with credits;
  - the priced list post;
  - says-paid from the four sources;
  - collector confirm (page and digest reply);
  - reminders and the after-deadline summary;
  - regulars excluded from per-match pay links, chase, poll and unpaid tail (5.6);
  - the paid-claim first gate widened.
- **Unit tests:**
  - the amount table in 4.2 (each row);
  - credits oldest first and never negative;
  - concession;
  - joining mid-month;
  - price lock after the first payment;
  - a paid mark by someone else stays "says paid";
  - a claim never sets `paidAt` (extend the existing guard test);
  - digest reply parsing (ALL, numbers, NONE);
  - reminder timing, waking hours only;
  - the per-match payment paths skip `paymentMethod = "monthly"` rows;
  - PAYG rows still get links.
- **Playwright:** set a price, see amounts; confirm a payment on `/admin/months`; the member page
  shows the amount and "I've paid".

### Slice 5: the weekly flow (about 3 days)

- **What:**
  - seeding from the month (reusing `seedRollingSquad` with a month source);
  - away weeks;
  - OUT earns a credit (by rule) and lists under "Paid but can't play";
  - the PAYG pool offer after the bench;
  - the slot number inherited by the fill-in;
  - PAYG per-match fee default;
  - the weekly list post with its re-post rules;
  - DM to a player whose line someone else changed.
- **Unit tests:**
  - the seed (regulars, dated PAYG, away weeks, an early OUT wins, idempotent);
  - credit on OUT under each `monthCreditRule`, and late drops;
  - the PAYG pool membership and exclusions (opted out, left, already on the match);
  - first-wins claim through `BenchSlotOffer`;
  - the slot inherited;
  - the list post format in English and Turkish, with a golden snapshot;
  - no re-post after a matching paste;
  - the 30-minute floor;
  - organiser-pick mode still takes precedence.
- **Playwright:** the match page shows "Paid but can't play" and PAYG labels; the member page
  away-week ticks.

#### Slice 5 as built (2026-10-06)

Code: `monthly-week-rules.ts` (pure rules), `monthly-week.ts` (seeding, slots, credits, the
PAYG offer), `monthly-week-copy.ts` (English and Turkish), `monthly-paste.ts` (a member's
pasted list), and guarded branches in `attendance.ts`, `bench-confirmation.ts`,
`squad-announce.ts`, `bot-scheduler.ts`, `payment-flow.ts`, `payment-claim.ts`,
`unpaid-list.ts`, the analyze route, the due-posts route and the complete-matches cron. Every
branch is behind `squadMode = "monthly"` AND a running month for that match.

- **Seeding.** `Match.rollingSeededAt` is the claim, as planned. A match is seeded at once when
  its fixture has no played match behind it (a mid-month start), otherwise from 08:00 London
  the morning after the previous game. It runs on the cron, on every poll, and right after the
  organiser starts the month. A regular's row carries `paymentMethod = "monthly"` and
  `position` = their slot number.
- **Slots.** `Attendance.position` is the slot. Whoever comes in takes the lowest free number
  (a regular takes their own while it is free), written with a `monthly-squad` event.
- **Credits.** Reconciled from state after every change and on every poll, not written once on
  the OUT: a paid (or says-paid) regular who is out has one "missed" credit, and it is voided
  if they come back. `filled-only` writes it while somebody else holds their slot. A credit an
  admin voided is never written again.
- **The list post.** Keys are `<matchId>:month-list:<hash>:<n>`. The newest such row is "what
  the group last saw": a post of ours, a reply that carried the list, or a member's paste that
  showed the same list (kind `month-list-seen`, which does not count towards the 30 minutes).
  Slice 3's sign-up list must use a different key prefix.

**Where it differs from the plan above, or where the plan was wrong:**

1. **A blanked line (6.2).** The table says a blanked line is an OUT, and also that a missing
   name is ignored and a paste may only move a person forward. A blank line on an old copy looks
   exactly like a deliberate one, so a blank line is an OUT only when the player themselves or
   an admin pasted it. From anyone else it is ignored and counted as an old copy. Moving a name
   under "Paid but can't play" is applied whoever pasted it (D4).
2. **"Paid but can't play" and unpaid regulars.** A regular who has not paid and is out is
   listed under a second header, "Can't play". The list never calls somebody paid who is not.
3. **The 17:00 post and "Squad complete" (not in the plan).** Both would post a second,
   weekly-shaped roster beside the list, so neither fires for a match of a running month. The
   match-day line-ups still do. Scheduled chases use the fixed text (no composer call).
4. **A squad asked for in the group (not in the plan).** "Who's in?" is answered with the
   month's list instead of the weekly roster, and counts as the list having been shown.
5. **The PAYG offer (5.3).** It reuses the `BenchSlotOffer` and its keys, but not the recruit DM
   builder: the offer needs the price, so it has its own two strings. The group line tags
   nobody. With somebody on the waiting list who never answers, the pool is NOT asked: the
   plan only covers an empty bench.
6. **The payment poll (5.6).** Skipped as planned. A consequence the plan does not state: a
   monthly club that only has payment tracking (the poll) has no per-match way for a PAYG
   player to pay. It needs payment collection (pay links or "paid the collector") switched on.
7. **The PAYG fee (5.6).** After the match the collector is asked to confirm the club's PAYG
   price for the per-game players only ("£8 each for 2 players?", the existing confirm prompt).
   With no PAYG player on the match nobody is asked.
8. **The analyze route (6.2).** The paste is not a terminal branch. It claims the list as a
   clause (`claimFastPath`): a message that is only a list never reaches a model, and anything
   typed around the list still goes to the router and the attendance engine. A late paste is
   held out with the other late messages and changes nothing.
9. **Not built here:** the member page (away weeks, 9.3) and the match-page labels, which the
   slice list above names. `absentMatchIds` is honoured everywhere (seeded OUT, listed, credited)
   but nothing writes it yet except a paste that moves a regular out of a week that is not
   seeded. A "(paid)" mark on a PAYG line is ignored until slice 4.
10. **Edited 5.1:** `seedRollingSquad` is not reused; `seedMonthlySquad` is its own function
    with the same claim, because its source is the month's members and not a match.

**Changed after review (2026-10-06, same PR).** Where these differ from the notes above, these
stand.

- **A paste never creates a player and never guesses one.** Names are matched by exact name,
  a known alias or the leading name, and by nothing else. The analyze route's own resolver
  (prefix match, then a provisional member) is not reachable from a monthly paste. A name
  that matches nobody, matches two players, or is a club player who is not on the month's
  list is not registered, and the organisers (or the admin who pasted it) get one note a day
  with the names and how to add a player. The sender can still add themselves.
- **Is it the month's list at all?** Only with the month header, or when at least 60% of its
  names are this month's players. "Kit for Monday: 1. Bibs 2. Two balls" is neither.
- **Coming back.** A paste never brings back a player who dropped, an admin's included. Only
  the player's own paste does. A paste that tries is an old copy, and an old copy changes
  nobody else's line, whoever sent it.
- **Before the seed** (the hours after one game ends) a paste only records paid marks.
- **Regulars have priority at the seed.** A non-regular who said IN early goes to the waiting
  list (last in first) with a DM, and a regular who was waiting is brought in.
- **Credits.** A paid regular who is not CONFIRMED, whether dropped, away or left on the
  waiting list, has the credit. `filled-only` fills vacated places in the order they were
  vacated (earliest drop, then lower slot, then user id).
- **Before the month started here.** A game dated before `startedMidMonthAt` (or the 1st) is
  not the month's: no credit, no re-marked row, weekly posts.
- **Every open place is offered**, not only a place somebody drops out of, on each poll. One
  group post per place: when the list carries the "place open" line, the pool's own line is
  not sent. A pool player is DMed at most once per match.
- **The PAYG fee** is staged only when the Pi acks the fee question, never before.
- **A month started from a pasted list** saves the list's names as aliases of the matched
  players. A regular who has left the group frees their slot number. The pay page refuses a
  monthly regular.

**Changed after the second review (2026-10-06, same PR).** These replace the lines above where
they differ.

- **Leaving the group never voids a credit.** A regular who leaves stays a member of the
  month (flagged as left): not seeded, not listed, slot number free, but every credit they
  earned stays owed. A credit is only taken back from a regular who is still in the group and
  is playing after all.
- **One pool line per match per poll**, covering every open place ("2 places open"), and only
  for a place the group has not been told about: an offer opened after the last list post and
  the last pool line.
- **A paste that matched nobody is not swallowed.** The sender gets one DM a day saying what
  was not matched. A line that shares a word with the sender's own name, when they are not
  on the list and it is the only unmatched line, is the sender adding themselves. A member of
  the month whose headerless list was not read is told to paste it with its title line.
  Before the seed, the sender's own in or out is kept (an early IN, or an away week).
- **The PAYG fee** is staged only by an ack that carries the sent message's id (the Pi acks a
  failed DM with none). With no such ack after 30 minutes the question is asked once more. A
  collector's reply to an unstaged question stages the PAYG price and then confirms it.
- **Cost.** The running months are read once per poll, and played games are swept at most
  once an hour per club (the games still to play, every poll).
- **The seed's two exceptions.** A regular who asked for the bench (read from the attendance
  log) is not brought in over anybody and is not credited for that week. An organiser who is
  IN and not on the month's list is never moved to the waiting list.
- **No longer a regular.** A player moved off the month's regulars loses the "paid for by the
  month" mark on games not yet played, so they get the pay link and the pay page again.

**Changed after the third review (2026-10-06, same PR).**

- **The collector's reply to an unstaged PAYG fee question** stages the price only for the
  explicit yes, within 15 minutes of the question, with no other DM from MatchTime to the
  collector in between, and never when the question is known not to have sent (the Pi acked it
  with no message id) or the collector has already said no. A "no" is recorded and final: the
  price is never staged again for that match and the question is not re-asked. The collector
  then sets a fee by typing an amount, as in a weekly club.
- **Before the seed**, the sender's own in or out is applied only when the paste is about next
  week: not when its title names the game just played, and not when it is that game's list
  with nothing changed but paid marks.
- **Adding yourself under another name** needs your first name (or whole name) on the line. A
  surname alone is not enough.
- **Bench by choice** is read from the attendance log's note, which is one shared constant
  (`EXPLICIT_BENCH_NOTE`) with a test that fails if it changes. There is no structured field.

#### Slice 3 as built (2026-10-06)

Code: `month-signup-rules.ts` (pure rules), `month-signup.ts` (opening, the lock, the three
doors, the list post), `month-signup-copy.ts` (English and Turkish), the player's page
`/month`, the organiser's buttons on `/admin/months`, and guarded branches in
`bot-scheduler.ts`, the analyze route and the due-posts route. Every branch is behind
`squadMode = "monthly"`; a weekly club makes no query in any of them.

- **Opening.** On the due-posts poll, from 10:00 London on the day N days before the month's
  first game (`monthListOpensDaysBefore`), in waking hours only: the month's matches are
  created (deduped by slot, like the weekly cron), the month is created `open`, and this
  month's regulars are carried over in slot order, renumbered from 1. One month per recurring
  fixture (two formats of the same weekly game share one list). The unique key and an advisory
  lock make two polls at the same moment open one month.
- **The list post.** Keys are `org-<orgId>:msu:list:<monthId>:<hash>:<n>` (the weekly list's are
  `<matchId>:month-list:`). Posted when it differs from the list the group last saw, at most
  every 30 minutes, 08:00 to 21:59 London, and never after sign-up has ended. A member's paste
  that shows the same list counts as seen.
- **The three doors.** All end in `applySignup`, under the club-month's lock:
  1. a pasted list (`handleSignupPaste`), with slice 5's rules: a name is matched by whole
     name, alias or leading name; no player is ever created; only the SENDER'S own line is
     applied (their name in a numbered line is IN, PAYG when marked, with its dates); a paste
     never takes anybody OFF the month, the sender included; a list with no month in its
     title needs 60% of its names on the month. Names written in for somebody else are left alone and the sender is told by
     DM, once a day;
  2. a typed message in a fixed vocabulary (`readSignupMessage`): "IN FOR NOVEMBER", "OUT FOR
     NOVEMBER", "PAYG FOR NOVEMBER 9th and 23rd", "Kasım varım", "Kasım yokum". The whole
     message must be the full phrase with the month's full name ("Jan payg" signs nobody
     up). A plain "IN" is this week's game, as before;
  3. the player's page, `/month` (linked from the list post; sign-in is the usual one).
- **The cap.** Regular places are the format's squad size. The next person WAITS: they are
  stored as a PAYG player with a note (so the weekly flow offers them open places and never
  charges them for the month), told by DM, and the organisers are told once a month. An
  organiser can make them a regular on `/admin/months`, past the cap.
- **The organiser's buttons** on `/admin/months`: make regular, move to PAYG, remove for the
  month, add a player. Next month appears on the page as soon as its list is open.
- **No row is ever deleted.** OUT (and "remove") set `leftAt` and keep everything the row
  knows. A member who has left the group is not listed and holds no number; their row stays.
- **Somebody who says they have paid is not moved by their own message, paste or page.** Only
  an organiser changes their place. (No paid mark is written in this slice.)

**Where it differs from the plan above, or where the plan said nothing:**

1. **When sign-up ends (the plan gave no moment).** Two days before the month's first game
   (changed after review: it was a day after the list opened). The list post says so ("Names
   in by Sat 31 Oct, 20:00"). At that moment the month goes `running` and slice 5 takes it:
   the regulars are put on the first game and the WEEK's list is posted. Without this a month
   nobody priced would have stayed in sign-up and played its first game as a weekly club.
2. **After sign-up ends, until the month's first game,** people still join the MONTH: by
   "IN FOR NOVEMBER", the page, the organiser's buttons, and a pasted "List for November"
   from somebody who is not on the month with their own name on it (a regular, or PAYG if
   their line says so, subject to the cap; never game one as a one-off). The change is put
   on the week's match too. From the first kick-off only the organiser changes the month.
3. **Door 2 (6.2 says "a reply to the list post").** The Pi does not forward which message a
   reply quotes. The server reads a bare "IN" as a sign-up only when the batch carries the
   quoted text (`quotedBody`), which no Pi build sends yet. Until one does, the typed
   "IN FOR NOVEMBER" is the second door, and the list post tells people to type that. The
   rule for when a Pi does (`quotedSignupMonth`, tested): only a reply to MatchTime's own
   SIGN-UP list counts. A bare "IN" quoting the week's list is this week's game.
4. **D4 during sign-up.** The plan lets a paste change somebody else's line; slice 5's review
   narrowed adding to the sender alone, and sign-up follows it. Nobody is taken OFF by a
   paste either, except the sender. An organiser adds or removes on the page.
5. **"Anyone who has already said they are out for next month" (4.1).** There is nowhere to
   record that before the month exists. OUT works from the moment the list is open.
6. **PAYG players on the list.** Numbered on after the regular places ("15. Omar (PAYG 9,
   23)"), so the regular places stay visible. People waiting are under "Reserves".
7. **The cold announcement.** A match of a month in sign-up is not announced the weekly way
   ("Say IN to join, first 14 play") beside the month's list.
8. **MatchTime's own sign-up list is never read as the week's list.** Known by its title
   line ("List for November (5 Mondays: ...)"). Pasted back after sign-up has ended, it
   cannot put the PAYG players numbered on it onto game one.
9. **The month's games are its matches that are not cancelled.** A week cancelled before the
   list opened is not in the list's header, and is not a game anybody is charged for, carried
   over or joining later.
10. **One read of the month per poll.** The sweep reads the club's live months once and
   hands them to the posts.
11. **Not built here:** paid marks from a pasted sign-up list (they are read and handed to
   slice 4), and the "set the price" notice (slice 4).

### Slice 6: credits ledger, cancelled weeks, month close (about 2 days)

- **What:**
  - the credits tab (add, void, refunded);
  - "cancelled-week" credits on match cancel and block cancel;
  - leaving mid-month;
  - month close and the summary;
  - credits applied in arrears to the next unpriced month.
- **Unit tests:**
  - a cancelled week credits paid regulars only, once (idempotent on re-cancel and restore);
  - leaving mid-month credits games left;
  - "Refunded" voids them;
  - close runs once;
  - the summary numbers against a worked month;
  - a credit earned after the next month was priced lands in the month after.
- **Playwright:** add and void a credit; the month summary page matches the fixture.

### Slice 7 (optional): card payment for the month (about 2 days)

- **What:**
  - a one-off Stripe Checkout for `amountDuePence` on the club's connected account, reusing
    `createCheckoutSession` (`stripe.ts:136`) with `monthMemberId` in metadata;
  - the webhook branch in `applyCheckoutEvent` (`payment-flow.ts:117`) sets the member's
    `paidAt`;
  - the same uplift rules (`totalForMethod`, `payments.ts:78`).
- **Unit tests:**
  - the metadata branch;
  - an async bank failure reverses;
  - the uplift;
  - a weekly club is untouched.
- **Playwright:** the member page "Pay by card" button reaches the (faked) checkout.

**F3 hook:** not a slice here. When F3 is built, it adds the free "List for <Month>" count from
slice 1's reader and the suggestion DM (11.1).

---

## 13. Decisions for Kemal

**D1. Who sets the price?**
- **Option A:** the organiser types the per-game share; MatchTime suggests venue cost /
  regulars.
- **Option B:** MatchTime computes it from the venue cost automatically.
- **Recommendation: A.** The chat shows the organiser rounds and adjusts (credits owed to the
  whole group, a concession, waiting on "2 more"). An automatic number would be wrong as often
  as right, and it is his money.

**D2. Which misses earn a credit?**
- **Option A:** every game a paid regular misses, late drops included (their stated rule:
  "anything you miss before you get after").
- **Option B:** only when the place was filled.
- **Option C:** none.
- **Recommendation: A as the default, with B and C as club settings.** It is what this group
  does. B suits a club that worries about paying for empty places.

**D3. How much do we trust a "(paid)" mark?**
- **Option A:** show "(paid)" in the list as soon as a player claims it, keep "says paid"
  separate from "confirmed" everywhere else, and ask the collector to confirm in a daily
  digest.
- **Option B:** today's per-match rule, where nothing shows as paid until the collector
  confirms.
- **Recommendation: A.** It matches what the group does now. The collector already trusts the
  marks ("Missing 4" was counted from them). Under B the list would look worse than their own.
  The "never sets `paidAt`" rule still holds: only the collector or Stripe confirms.

**D4. Can a pasted list change someone else's line?**
- **Option A:** yes, and the affected player gets a DM to undo it.
- **Option B:** only their own line, or an admin's paste.
- **Recommendation: A, with the forward-only stale-paste rule (6.2).** Players do edit each
  other's lines in this group ("put paid on my name"). Refusing those would leave MatchTime's
  list behind the group's.

**D5. Card payment for the month: when?**
- **Option A:** bank transfer only at launch, card as slice 7 later.
- **Option B:** card in slice 4.
- **Recommendation: A.** The group pays by bank transfer today and the collector has no Stripe
  account. Card is a clean add-on once a club asks.

**D6. How does a club get switched to monthly mode?**
- **Option A:** the organiser switches it on `/admin/settings`. F3, when built, only suggests
  it.
- **Option B:** F3 applies it automatically, like its other settings.
- **Recommendation: A.** It changes how money is asked for, and a wrong switch would post
  amounts in a group. For Vets MNF, Kemal or the organiser turns it on when they join.
