# Club fee billing: free month, then £9.99 a month per group

Plan, 2026-10-01. Design only: no code, schema, Stripe setting or production row was
changed to write it. Direction (the outline) accepted by Kemal on 2026-10-01. Every
claim about the current code cites the file it was read from, on `origin/main` at
`cd38c51` (sections 7.1, 7.2 and 14 were checked again at `dca3057`).

Revised 2026-10-01 (second pass): Kemal decided that every club fee message explains
how to split the fee among the players, with a worked example from the club's own game,
sent to all the club's admins and to the money collector (sections 7.1 and 7.2). Adding
the club fee to card match fees is written up as an optional slice B7 (section 14),
which needs Kemal's yes.

---

## One-screen summary (for Kemal)

**What the organiser experiences**

1. You approve their club (as today). Their **free month starts at that moment**. No card
   is asked for.
2. **Day 21:** one WhatsApp DM to the organiser: "your free month ends on 31 Oct, add a
   card here". The link opens their club settings, signed in, with an **Add a card**
   button. That opens Stripe's own card page. They are **not charged before day 30**.
3. **Day 28 and day 30:** one short reminder each, only if there is still no card.
4. **Day 30 to 37 (grace):** MatchTime keeps working normally. Organisers and admins see
   a banner on the website.
5. **Day 37, still no card:** MatchTime goes **quiet** in that group: no posts, no
   replies, no AI. It stays in the group and keeps all the data. The organiser gets
   **one** DM explaining how to switch it back on. **Nothing is said in the group.**
6. Card added at any point: £9.99 a month from day 30 (or at once, if they come back after
   a pause). They change the card or cancel on Stripe's own page. A failed payment gets
   Stripe's automatic retries for a week, MatchTime keeps working, then the same quiet
   rule applies.

**What you control** (on `/admin/clubs`): each club's plan: **Standard £9.99**,
**Free**, or **Custom** (for example £5 for an early supporter). Sutton FC and every
club that existed before self-join are never billed and never paused.

**How the money is kept apart:** the club fee is a normal **Stripe Billing subscription
on MatchTime's own Stripe account**. It never touches Stripe Connect or the collector
accounts that players pay their match fees into. It has **its own webhook endpoint and
its own signing secret**. We never see or store card numbers.

**How the club covers it:** every club fee message carries a **club fee tip** worked out
from the club's own game, for example: "your weekly 5-a-side is 10 players and about 4
games a month, so £9.99 works out at about *25p a player per game*. If your game costs
£8 each, charge *£8.25* and the club fee is covered." It is in the "you're live" DM, the
day 21 notice and the billing card on the settings page (section 7.2).

**Who gets messaged:** card and payment DMs (they carry a signed-in link to add or change
the card) go **only to the organiser** (the club's OWNER), by the platform DM channel.
The club fee tip goes to **all the club's admins** through the club's own admin channel
("Admin messages go to": one person, the admin WhatsApp group, or each admin), **and to
the money collector**, who is the one who actually adds the share to the match fee, unless
the admin channel already reaches them. English or Turkish. **No DMs to you.** Billing
numbers sit on `/admin/clubs`.

**VAT:** Cressoft is VAT registered and **£9.99 includes VAT** (about £8.33 to
Cressoft, £1.66 VAT). The Stripe price is tax inclusive with a fixed 20% UK VAT rate, and
invoices show Cressoft's legal name, address and VAT number. **UK billing addresses only
at first**, because selling to consumers abroad (Turkey, the EU) brings foreign VAT
registration. After VAT, Stripe and about £3 of AI, a club leaves about **£4.90 a
month** (section 5.4).

**Cost to build:** six PRs (B1 to B6), plus a seventh (B7) only if you say yes to
section 14. No prompt changes, so **no paid AI test runs**. Stripe is tested in test mode
and with signed fixture events; **live mode is touched only at rollout, by you, in the
dashboard**.

**Optional, needs your yes (B7):** a per-club setting "Add the club fee to match fees"
for clubs that take card or bank payments through MatchTime. Each such payment carries
the player's share, taken with MatchTime's existing 1% platform fee, until the month's fee is covered; at month
end the owner's card pays only the shortfall (cash payers), or nothing. Section 14.

**Switch:** `BILLING_ENABLED`, off by default. Off means nobody is billed or paused, and
any paused club comes straight back. It starts with **new clubs only**.

**Decisions I need from you:** section 15 (seventeen of them, each with a
recommendation).

---

## 1. What exists today (verified in code)

| Piece | Where | What it does now |
|---|---|---|
| Approval | `decideClub` in `src/lib/club-approval.ts` (~line 300 to 430) | Approve writes `approvalStatus = "approved"`, `approvedAt = now` (~421), turns the bot on. Suspend (`approved` to `suspended`) only for clubs with `approvedAt` set, turns the bot off **and leaves the group**. |
| "Approved" and "operational" | `src/lib/club-approval-state.ts` | `APPROVED_CLUB_WHERE`, `isClubOperational(org)` = approved and not dormant, deliberately blind to the mute switch. |
| Where the gates are read | `api/whatsapp/orgs/route.ts` (orgs query ~23), `api/whatsapp/due-posts/route.ts` (~184, `whatsappBotEnabled: true`), `api/whatsapp/analyze/route.ts` (~478, ~4186), crons `bot-health` (~65), `none-bucket-shadow` (~94), `extract-squads` (~75), `src/lib/match-completion.ts` (~41), `src/lib/rolling-squad.ts` (~187), `fixtureSkipReason` in `src/lib/org-lifecycle.ts` (~120), and `isClubOperational` in `unpaid-list.ts`, `deadline-summary.ts`, `organiser-pick.ts`, `badge-announcement-scheduler.ts` | Every place MatchTime acts on its own initiative already passes through one of these. |
| Silent groups | `loadSilentGroupIds` / `computeSilentGroups` in `club-approval.ts` (~150 to 195); returned by `/api/whatsapp/orgs` as `silentGroups` | The Pi drops their messages and never lets "@MatchTime setup" monitor them. A group owned by an approved club is never silent today. |
| DM sender rail | `dm-reply/route.ts` ~410, `onlyUnapprovedClubs` | A sender whose only clubs are unapproved never reaches a model path. |
| AI cap | `aiAllowanceUsd` in `src/lib/ai-budget.ts` | Unapproved or bot off: $0, before any override. Otherwise the override `aiDailyCapUsd`, else **$0.25 a day for 28 days from `approvedAt ?? aiWindowStartAt ?? createdAt`**, then $1.00. `AI_DAILY_CAP_DISABLED=1` lifts every allowed club to $50 but keeps the $0 rules. |
| Platform DM channel | `src/lib/platform-jobs.ts` (`queuePlatformDm`, `PLATFORM_DM_PURPOSES` = otp, connect-reply, organiser-decision), Pi poller | Goes out whatever the club's switches say (it does not depend on `due-posts`). Recipient must be a known MatchTime user. Pi pacing of one DM a minute applies. |
| Owner DMs | `queueOwnerDm` in `src/lib/owner-dm.ts` | Approvals and acks only; a source guard (`__tests__/platform-jobs-source-guard.test.ts`) forbids anything else from using it. **Billing will not use it.** |
| Signed-in links | `buildAdminLink` in `src/lib/admin-link.ts` | Short sign-in magic link to one admin page of one club, TTL `MAGIC_LINK_TTL.actionNudge` (48 hours). |
| Admin channel (slice 2a) | `sendAdminNotice` in `src/lib/admin-channel.ts`; pure rules in `admin-channel-rules.ts` (`resolveAdminNoticeTargets`) | A club's "Admin messages go to": `one-person` (the chosen admin, NULL = owner; the default for new clubs), `admin-group` (one post in the linked admin WhatsApp group, falling back to the owner by DM at emit time if the Pi cannot send there), or `each-admin` (every OWNER and ADMIN with a phone; Sutton FC). Queued as `BotJob`s that the club's next `due-posts` poll hands the Pi, so a muted club sends nothing until unmuted. A DM carries the reader's own signed-in link; a group post carries the plain URL. Returns `{ channel, queued }`, not who was reached. Holds a notice queued 22:00 to 07:59 until 08:00 by default. |
| Money collector | `Organisation.paymentHolderId` (`prisma/schema.prisma` ~202); set by `setPaymentHolder` in `src/app/actions/payments.ts` (~137) | Often not the owner and not an admin (Sutton: Kemal owns, Elvin collects). Self-join does not set it (`self-join-club.ts`), so a new club usually has none until set in Settings. Collector DMs today are plain `BotJob` `dm` rows (e.g. `payment-flow.ts` ~71). |
| Admin group members | `detectAdminGroupCandidate` in `src/lib/admin-group-link.ts` (~115); `api/whatsapp/sync-participants` | The participant list of an admin group is read only once, when MatchTime is added, to decide whether it is an admin group; it is **not stored** against the club. `sync-participants` only matches the club's own group (`whatsappGroupId`). So the server **cannot tell who is in a club's admin group**. |
| Players per game | `Sport.playersPerTeam` (`schema.prisma` ~547), seeded from `SPORT_PRESETS` in `src/lib/sport-presets.ts` (`football-5aside` 5, `-7aside` 7, `-8aside` 8, `-9aside` 9, `-11aside` 11, futsal 5 ...); each `Activity` has a `sportId`, `dayOfWeek`, `isActive` | Self-join creates the club's one weekly activity with the chosen players per side (`self-join-club.ts` ~114 to 131). |
| Match fee | `Activity.feePerPlayer` and `feeSplitTotal` (~691), `Match.feePerPlayer` (~800) | The BASE per-player fee (before card or bank uplift). Null means no default; the collector is asked each week. `feeSplitTotal` means the pitch cost is split among those who played. |
| Match fee pricing | `totalForMethod`, `platformFeePence`, `PLATFORM_FEE_RATE` in `src/lib/payments.ts` (~80 to 95); `payByMethod` in `src/app/actions/payments.ts` (~185 to 230); `createCheckoutSession` in `src/lib/stripe.ts` (~118 to 170); `pay-options.tsx` | The player's total is grossed up so the collector nets exactly the base: `G = (base x qty + stripeFixed + platform) / (1 - stripePct)`, rounded up to the penny. MatchTime's 1% is `application_fee_amount` on a **direct charge** on the club's connected account (`Organisation.stripeConnectAccountId`, one per club; `resetCollectorConnect` clears it). Cash ("direct") carries no fee. The Connect webhook ignores refunds (`api/stripe/webhook/route.ts` ~63); refunds are not handled in code today. |
| Stripe today | `src/lib/stripe.ts`, `src/app/api/stripe/webhook/route.ts`, `applyCheckoutEvent` in `src/lib/payment-flow.ts` | Connect Express accounts for collectors, **direct charges** on the connected account, 1% `application_fee_amount`. The webhook verifies with the single `STRIPE_WEBHOOK_SECRET` (the **Connected accounts** endpoint). `applyCheckoutEvent` ignores a session without `matchId` and `userId` metadata (~121). |
| Public route | `src/lib/public-paths.ts` ~49 | Everything under `/api/stripe` is already public (signature is the auth). |
| Removal from a live group | `handleGroupLeaveForSelfRemoval` in `whatsapp-bot/src/bot-added.ts` (~290) | The Pi tells the server only when MatchTime is removed from a **silent** group. Removal from a live club's group is not reported today. |
| Price on the site | `src/components/landing/landing-page.tsx` ~553, ~608, ~640; `src/app/help/admin/page.tsx` ~10, ~43 | "£9.99 a month per WhatsApp group ... first month is free", the split advice ("With 20 players, that works out at about 50p a player", landing ~608, help ~49), and "remove MatchTime from the group any time to stop". |
| Copy tests that bind this plan | `src/app/__tests__/public-copy.test.ts`; `src/lib/__tests__/self-join-copy.test.ts` (~100); `copy-golden.test.ts` (R185) | Public pages: no fee talk, "about 50p a player" required and "25p" forbidden on the landing page, and **never claims MatchTime collects the club fee** (`/(collects?\|charges?) the (club\|monthly) fee (for you\|automatically)\|automatically (collect\|split\|charge)/`). The "you're live" DM `sj_dm_approved` must **end with** "Your first month is free." and contain **no amount** (no £, no decimals). |
| Crons | `vercel.json` | Seven crons; none for billing. |

One club has exactly one group (`Organisation.whatsappGroupId`), so "per group" and "per
club" are the same thing here.

---

## 2. Money separation

- **Club fee:** a Stripe **Customer** and **Subscription** on the **platform account**
  (the account `STRIPE_SECRET_KEY` already points at). No `stripeAccount` header, no
  Connect, no `application_fee_amount`. The money is MatchTime revenue, like the 1%
  platform fee already is.
- **Match fees:** unchanged. Direct charges on each collector's connected account, the
  Connect webhook, `applyCheckoutEvent`. (Only the optional slice B7, section 14, would
  add a club fee share to the match fee's `application_fee_amount`; the subscription
  itself stays on the platform account either way.)
- **Two webhooks, two secrets, two routes:**
  - existing `/api/stripe/webhook`, **Connected accounts** scope, `STRIPE_WEBHOOK_SECRET`;
  - new `/api/stripe/billing-webhook`, **Your account** (platform) scope,
    `STRIPE_BILLING_WEBHOOK_SECRET`.
  Stripe signs each endpoint with its own secret, so an event delivered to the wrong
  route fails signature checking and is refused rather than mis-applied.
- **Defence in depth:** billing Checkout sessions never carry `matchId` or `userId`
  metadata (they carry `orgId` and `purpose: "club-fee"`), so even a misrouted event is
  ignored by `applyCheckoutEvent`. The billing handler ignores anything without
  `purpose: "club-fee"`. A unit test pins both.
- **Card details:** entered only on Stripe Checkout and changed only in the Stripe
  Customer Portal. We store the customer id, subscription id, status, period end and,
  for display, card brand and last four digits. Nothing else.

**One thing to check before go-live (not verified, memory note only):** the memory note
says an old **platform-scoped** endpoint (`we_1TgQL6...`) still points at
`/api/stripe/webhook`. Once billing exists, that endpoint would start receiving platform
events (the new subscription checkouts) and fail them on signature, and Stripe would
retry and email warnings. **Delete it in the dashboard before switching billing on**
(rollout step 3).

---

## 3. Data model (all additive)

The codebase stores lifecycle states as strings with a TypeScript union and a Postgres
CHECK constraint (as `approvalStatus` does), not Prisma enums. Billing follows that.

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

### 3.2 New `ClubBilling`: the Stripe details, one row per billed club

```prisma
model ClubBilling {
  orgId                    String    @id
  trialStartedAt           DateTime            // = approvedAt at the first approval
  trialEndsAt              DateTime            // trialStartedAt + 30 days. Written ONCE, never reset.
  graceEndsAt              DateTime?           // trialEndsAt + 7d, or paymentFailedAt + 7d
  stripeCustomerId         String?   @unique
  stripeSubscriptionId     String?   @unique
  stripeSubscriptionStatus String?             // Stripe's own word: trialing, active, past_due, canceled, unpaid ...
  stripePriceId            String?
  currentPeriodEnd         DateTime?
  cancelAtPeriodEnd        Boolean   @default(false)
  cardBrand                String?
  cardLast4                String?
  payerUserId              String?             // who added the card
  paymentFailedAt          DateTime?           // first failure of the current unpaid invoice
  pausedAt                 DateTime?
  pausedReason             String?             // "no-card" | "payment-failed" | "cancelled" | "removed"
  billingCountry           String?             // from Checkout's billing address, ISO 3166 alpha-2
  cardCountry              String?             // the card's issuing country
  vatCountryCheck          Boolean   @default(false) // either is not GB: flagged on /admin/clubs
  resumedAt                DateTime?
  createdAt                DateTime  @default(now())
  updatedAt                DateTime  @updatedAt
}
```

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

### 3.4 New `BillingNotice`: one DM per club, per kind, per cycle

```prisma
model BillingNotice {
  id            String   @id @default(cuid())
  orgId         String
  kind          String   // "trial-21" | "trial-28" | "trial-ended" | "paused" | "card-added" | "payment-failed" | "resumed"
                         // | "fee-tip" (admin channel) | "fee-tip-collector" (the money collector, section 7.2)
  cycleKey      String   // e.g. trialEndsAt ISO date, or the invoice id; for "fee-tip-collector", the collector's user id
  platformJobId String?
  createdAt     DateTime @default(now())
  @@unique([orgId, kind, cycleKey])
}
```

Insert first, then queue the DM: a retried cron or a re-delivered webhook can never DM
twice about the same thing.

### 3.5 PlatformJob

No schema change. One new purpose, `"billing"`, added to `PLATFORM_DM_PURPOSES` in
`platform-jobs.ts`, and `src/lib/club-billing.ts` added to the source guard's allowlist.
The organiser is a MatchTime user, so the existing recipient rule (rule 12) passes.

The club fee tip does **not** use the platform channel: it goes through `sendAdminNotice`
and, for the collector, a plain `dm` `BotJob`, like every other message a club's
organisers get (section 7.1).

---

## 4. States and transitions

### 4.1 Day numbers

Day 0 is `approvedAt`. `trialEndsAt` = day 30, `graceEndsAt` = day 37 (for a club with
no card). Reminders go out at or after **10:00 London** on their day.

| Day | Instant | Condition | Action |
|---|---|---|---|
| 0 | `approvedAt` | `BILLING_ENABLED`, plan not free, no `ClubBilling` row yet | `trial`; create `ClubBilling` |
| 21 | `trialEndsAt - 9d` | still `trial` | DM "trial-21" to the owner; club fee tip to the admin channel and the collector (7.2) |
| 28 | `trialEndsAt - 2d` | still `trial` | DM "trial-28" |
| 30 | `trialEndsAt` | still `trial` | to `grace`; DM "trial-ended"; banner |
| 37 | `graceEndsAt` | still `grace` | to `paused` (no-card); DM "paused" |

### 4.2 The club (`Organisation.billingStatus`)

| From | Event | To | Side effects |
|---|---|---|---|
| (default) | migration, or approval with flag off, or plan Free | `exempt` | none, ever |
| `exempt` (self-join, never trialled) | Kemal "Start free month" on `/admin/clubs` | `trial` | `ClubBilling` with trial from now |
| `trial` | card added (Checkout complete, sub `trialing`) | `subscribed` | DM "card-added" |
| `trial` | day 30 | `grace` | DM "trial-ended" |
| `grace` | card added (sub `active`, first invoice paid at once) | `subscribed` | DM "card-added" |
| `grace` | day 37 | `paused` (no-card) | DM "paused" |
| `subscribed` | `invoice.payment_failed` | `past_due` | `paymentFailedAt`, `graceEndsAt = +7d`; DM "payment-failed"; banner |
| `past_due` | `invoice.paid` | `subscribed` | clear failure fields |
| `past_due` | Stripe gives up (`customer.subscription.deleted`, or status `unpaid`), or `graceEndsAt` passes | `paused` (payment-failed) | DM "paused" |
| `subscribed` | organiser cancels in the Portal | `subscribed`, `cancelAtPeriodEnd` | card shows "Ends on {date}"; no DM |
| `subscribed` | period ends after a cancel (`customer.subscription.deleted`) | `paused` (cancelled) | DM "paused" |
| `paused` | card added, first invoice paid | `subscribed` | **resume** (4.4); DM "resumed" |
| `trial`, `grace`, `subscribed`, `past_due` | MatchTime removed from the group (slice B5) | `paused` (removed) | Stripe sub set to cancel at period end; **no DM** |
| `paused` (removed) | MatchTime re-added to the same group before `trialEndsAt` | `trial` | resume (4.4) |
| any | Kemal sets plan Free | `exempt` | cancel the Stripe sub at once; resume if paused |
| any billed | Kemal suspends (existing off switch) | unchanged billing state, sub cancelled at once | the club is already off by approval |

The pure function `nextBillingState(club, event, now)` in `src/lib/club-billing-rules.ts`
(no database import, like `club-approval-state.ts`) owns this table. The single writer
`setBillingState()` in `src/lib/club-billing.ts` applies it with a compare-and-set on the
current `billingStatus`, so a webhook and the cron arriving together cannot both act. A
source guard test fails if any other file writes `billingStatus`.

**The free month happens once per club.** `trialEndsAt` is written once and never reset,
including when a club is re-approved. Combined with the existing one-club-per-phone rule
(`createOrganisation`), a second free month needs a second verified phone.

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
   after the approval check and before `aiDailyCapUsd` and `AI_DAILY_CAP_DISABLED`, so no
   override lifts it.
6. **Crons skip it.** The direct org queries (`bot-health`, `none-bucket-shadow`,
   `extract-squads`, `match-completion`, `rolling-squad`) switch to `SERVING_CLUB_WHERE`;
   `fixtureSkipReason` gains `"org-billing-paused"`, so no fixtures are generated.
   `crons-skip-unapproved.test.ts` is extended to assert the new fragment.
7. **DMs from players go nowhere near a model.** In `dm-reply` (~410), the rail
   `onlyUnapprovedClubs` becomes "only clubs that are not serving": silence. (The
   organiser's way back is the link in their DM and their settings page.)

What deliberately keeps working while paused:

- **The website**, signed in: data is all there, read and edit. Banner on top.
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
DM tells the organiser so (section 7).

---

## 5. Stripe objects and calls

### 5.1 Set up once per mode (test first, live at rollout, by Kemal)

- Product **"MatchTime club"**, tax code "General, electronically supplied services"
  (`txcd_10000000`). Price **£9.99 GBP, monthly, recurring, `tax_behavior: "inclusive"`**,
  lookup key
  `club_monthly_standard`. Its id goes in `STRIPE_CLUB_PRICE_ID`; the product id in
  `STRIPE_CLUB_PRODUCT_ID`.
- **Tax Rate** "VAT", 20%, `inclusive: true`, country GB, jurisdiction "United
  Kingdom". Its id goes in `STRIPE_CLUB_TAX_RATE_ID` (section 5.4).
- **Business details and invoice settings:** Cressoft's legal name, registered address and
  **GB VAT number** as the account tax ID, shown on invoices and receipts (section 5.4).
- **Customer Portal** configuration: update payment method, view invoices, cancel **at
  period end**; no plan switching, no quantity changes. Return URL
  `https://matchtime.ai/admin/settings#billing`.
- **Smart Retries** on, "retry up to 4 times within 1 week", then **cancel the
  subscription**. That makes Stripe's retry window equal our 7-day payment grace.
- **Customer emails:** receipts and failed-payment emails on (Checkout collects an email,
  so this is a free second channel besides the DM).
- **Webhook** (platform scope, "Your account") to `https://matchtime.ai/api/stripe/billing-webhook`
  with the events in 5.3. Its secret goes in `STRIPE_BILLING_WEBHOOK_SECRET`.

### 5.2 Calls (all in a new `src/lib/stripe-billing.ts`, beside `stripe.ts`, same client)

**Add a card** (`startClubCheckout(orgId, userId)`), a server action behind the button:

- find or create the Customer: `customers.create({ name: club name, metadata: { orgId } })`,
  store `stripeCustomerId`;
- `checkout.sessions.create({ mode: "subscription", customer, client_reference_id: orgId,
  line_items: [{ price, quantity: 1 }], metadata: { orgId, purpose: "club-fee" },
  subscription_data: { metadata: { orgId, purpose: "club-fee" }, trial_end? },
  success_url: /admin/settings?billing=done#billing, cancel_url: /admin/settings#billing })`;
- `trial_end` is set while the club is in `trial`: **`max(trialEndsAt, now + 49h)`**.
  Stripe requires a Checkout trial end at least 48 hours ahead, so a card added on day 29
  gets at most one or two extra free days rather than being charged early. In `grace`
  or `paused` there is no trial: the first £9.99 is taken at once;
- VAT: `subscription_data.default_tax_rates: [STRIPE_CLUB_TAX_RATE_ID]`,
  `billing_address_collection: "required"`, `tax_id_collection: { enabled: true }`, and
  the UK-only check in section 5.4;
- the price is `STRIPE_CLUB_PRICE_ID`, or for a Custom plan a price (also
  `tax_behavior: "inclusive"`) under
  `STRIPE_CLUB_PRODUCT_ID` with lookup key `club_monthly_<pence>`, created the first time
  it is needed and reused after.

The DM links point at **our** page, not at Stripe: a Checkout session expires within 24
hours, so a fresh session is created at the moment of the tap.

**Change card or cancel** (`openClubPortal(orgId)`):
`billingPortal.sessions.create({ customer, return_url })`, then redirect.

**Plan changes by Kemal:** Free cancels any subscription at once
(`subscriptions.cancel`, no proration). Custom or Standard on an existing subscription
swaps the item's price with `proration_behavior: "none"`, effective from the next month.

### 5.3 The billing webhook (`src/app/api/stripe/billing-webhook/route.ts`)

1. Verify with `STRIPE_BILLING_WEBHOOK_SECRET` (a sibling of `constructWebhookEvent`
   that takes the secret as an argument). No secret: answer `ignored`, as the Connect
   route does.
2. Insert `BillingEvent(id = event.id)`; a duplicate id returns 200 at once.
3. Resolve the org from `metadata.orgId`, else from `stripeCustomerId`. Ignore events
   without `purpose: "club-fee"` on the session or subscription.
4. **Re-fetch the subscription from Stripe** and sync from it, so out-of-order events
   (Stripe does not guarantee order) always converge on the latest truth.
5. Map to `nextBillingState` and apply through `setBillingState`.

| Event | What we do |
|---|---|
| `checkout.session.completed` (mode subscription) | store subscription id, card brand and last four, `payerUserId`; `trial` or `grace` or `paused` to `subscribed`; DM "card-added" (or "resumed") |
| `customer.subscription.created` / `.updated` | sync status, `currentPeriodEnd`, `cancelAtPeriodEnd`, price; `past_due` or `unpaid` drive 4.2 |
| `customer.subscription.deleted` | `paused`, reason `cancelled` if `cancelAtPeriodEnd` was set, else `payment-failed` |
| `invoice.paid` | clear failure fields; `past_due` or `paused` to `subscribed` |
| `invoice.payment_failed` | first failure of that invoice: `past_due`, DM "payment-failed" |
| `invoice.payment_action_required` | card needs a bank check (3DS): DM "payment-failed" with the invoice's hosted link instead of the Portal |
| anything else | 200, recorded, ignored |

A handler error returns 500 so Stripe retries; the `BillingEvent` row records the error
and is retried cleanly because `processedAt` is still null.

### 5.4 VAT (Kemal, 2026-10-01: Cressoft is VAT registered, £9.99 includes VAT)

**The numbers.** At the UK standard rate of 20%, a VAT-inclusive £9.99 is £9.99 / 1.2 =
£8.325 net. Stripe rounds per invoice, so the split shows as **about £8.33 net plus
£1.66 VAT** (it may print as £8.32 plus £1.67; either way the customer pays exactly
£9.99). A Custom £5.00 is £4.17 net plus £0.83 VAT.

**Who the customers are.** Mostly individual organisers paying out of their own pocket
(B2C), living in the UK: every club plays in London, and `src/lib/london-time.ts` is
hardcoded to Europe/London. A club or company that wants a VAT invoice in its own name
can add its VAT number at Checkout (`tax_id_collection`); nothing else changes, because
a UK business customer is charged UK VAT the same way.

**Stripe Tax or a fixed tax rate. Recommend the fixed rate.**

| | Fixed Tax Rate (recommended) | Stripe Tax |
|---|---|---|
| What it does | Applies 20% UK VAT, inclusive, to every club invoice | Works out the rate from the customer's location, for every country |
| Cost | Free | 0.5% of each charge where tax is calculated (about 5p a month per club), on top of Stripe's other fees |
| Fits | UK customers only, which is the recommendation below | Selling abroad, once registered there |
| Setup | One Tax Rate object | Turn on Stripe Tax, add the UK registration, `automatic_tax: { enabled: true }` |

With UK-only billing there is exactly one rate, so Stripe Tax adds cost and nothing else.
The Price is still created `tax_behavior: "inclusive"`, so moving to Stripe Tax later is a
change to the Checkout call, not a new price.

**Invoices and receipts.** Stripe makes an invoice for every subscription charge and emails
a receipt to the address entered at Checkout. Set once in the Stripe dashboard (Settings,
Business details, and Invoice settings): Cressoft's **legal name, registered address and
VAT number**, with the VAT number added as the account's tax ID so it prints on every
invoice, plus a footer such as "MatchTime is a service of {legal name}". With the Tax Rate
applied, each invoice shows the net amount, "VAT (20%, inclusive)" and the total. That
covers what a full UK VAT invoice needs; for consumers a simplified invoice would already
do. The settings card links to the Customer Portal, where every past invoice can be
downloaded. (I have not seen what the live dashboard has today; rollout step 3 checks it.)

**Organisers outside the UK (for example Turkey). Recommend UK only at first.**

- For an electronic service sold to a **consumer**, VAT is due where the customer lives,
  and a UK seller gets **no threshold** abroad:
  - **EU consumers:** EU VAT from the first sale, normally through the non-Union OSS
    scheme;
  - **Turkey:** foreign providers of electronic services to Turkish consumers must
    register for Turkish VAT (a simplified registration; 20% at present) and file there.

  That is real admin for £9.99 a month. This is the general rule as I understand it; your
  accountant should confirm it for Cressoft before anything is sold outside the UK.
- **How "UK only" is enforced:** Checkout requires a billing address. On
  `checkout.session.completed` the webhook reads the billing address country and the
  card's issuing country. Both GB: normal. Either one not GB: the subscription is kept
  (refusing after the card is taken would be worse), `vatCountryCheck` is set, the club
  shows **"Check VAT country"** on `/admin/clubs`, and you decide: keep it (someone
  living in London with a Turkish card is still a UK customer when the address and other
  evidence say UK), make the club Free, or cancel and refund. HMRC expects two
  non-conflicting pieces of evidence of where a consumer lives; the address and the card
  country are those two.
- Turkish-speaking organisers in London (the first prospects) are UK customers. Their
  language is a display choice and has nothing to do with VAT.

**Margin per club per month, VAT-inclusive price (Standard plan, UK card).**

| Line | Amount |
|---|---|
| Customer pays | £9.99 |
| VAT to HMRC (20%, inclusive) | £1.66 |
| **Net revenue** | **£8.33** |
| Stripe card fee (UK card, 1.5% + 20p of £9.99) | about £0.35 |
| Stripe Billing fee (pay-as-you-go, 0.7% of billing volume) | about £0.07 |
| AI (Kemal's planning figure; Sutton FC's September was about $3.50, roughly £2.60) | about £3.00 |
| **Left per club** | **about £4.91** |
| The same with Stripe Tax instead of a fixed rate | about £4.86 |
| The same with a non-UK card (about 3.25% + 20p; check current Stripe pricing) | about £4.74 |
| A club that hits the $1.00 a day AI ceiling every day (about £22 a month) | about minus £14 |

Stripe's rates above are their standard UK list prices as I understand them, not read
from Cressoft's account; the Billing fee in particular depends on the account's plan. A
Custom £5.00 plan nets £4.17, about £3.66 after Stripe fees, so it roughly breaks even at
£3 of AI. The last row is why decision 9 says to watch AI spend per club on
`/admin/clubs`.

---

## 6. The scheduler

A new cron, **`/api/cron/billing`, hourly** (`0 * * * *` in `vercel.json`), behind
`CRON_SECRET` like the others. With `BILLING_ENABLED` off it returns at once.

Each run loads clubs in `trial`, `grace` or `past_due` and, for each, asks the pure
`billingDue(club, now)` which of these is due:

| Kind | Due when | Also |
|---|---|---|
| `trial-21` | now at or after day 21 at 10:00 London, still `trial` | skipped if `trial-28` is already due (a late cron never sends two in a row); also queues the club fee tip (`fee-tip`, `fee-tip-collector`), which is **not** skipped with it: if day 21 was missed, the tip goes with day 28 |
| `trial-28` | day 28 at 10:00 London, still `trial` | |
| `trial-ended` | at or after `trialEndsAt`, still `trial` | moves to `grace` first; the DM waits for 10:00 if it is night |
| `paused` | at or after `graceEndsAt`, still `grace` or `past_due` | moves to `paused`; the DM waits for 10:00 |

The state change happens on time; only the DM waits for daytime (10:00 to 20:00 London),
using `sendAfter` on the `PlatformJob`. Every DM is claimed first in `BillingNotice`
(`orgId, kind, cycleKey`), then queued with `queuePlatformDm({ purpose: "billing" })`;
the tip is claimed the same way and queued with `sendClubFeeTip` (section 7.2).
Hourly runs make a missed run harmless.

Why a Vercel cron and not the Pi scheduler: the Pi scheduler is per group and is exactly
what stops polling for a paused club, and the day-37 DM must go out after the pause.
The platform channel is the one sender that works whatever a club's switches say.

---

## 7. Messages: who gets what, the club fee tip, and the copy (English and Turkish)

### 7.1 Who gets which message

| Message | Recipient | Channel | Why |
|---|---|---|---|
| "You're live" (`sj_dm_approved`), with a short tip | the organiser who asked to join | platform DM (`organiser-decision`, as today in `club-approval.ts` ~509) | It is the first message after approval; the admin channel may not be set up yet. |
| Day 21, 28, 30, paused, card added, payment failed, resumed | the OWNER only | platform DM (`purpose: "billing"`) | Each carries a **signed-in link to add or change the card**, and only the OWNER can (decision 4). A personal sign-in link must never be posted in a group. |
| Club fee tip, day 21 (sent once per free month) | **all admins**, through the admin channel | `sendAdminNotice` (`BotJob`s, next `due-posts` poll) | So every admin knows how to split the fee, whoever runs the money. |
| Club fee tip for the collector | the **money collector** (`paymentHolderId`), unless the admin channel already reached them | one `dm` `BotJob` | The collector is the one who adds the share to the match fee and may be neither an admin nor in the admin group. |
| Billing card on `/admin/settings` | every OWNER and ADMIN who opens Settings | web | Always there to look up. |

The owner's day 21 card DM no longer carries the sharing sentence: the tip arrives as its
own message through the admin channel, which reaches the owner in every mode except
"one person" set to someone else, and that is the club's own choice of who reads admin
messages.

Because the tip goes through `due-posts`, a muted club (`whatsappBotEnabled` off) gets it
when unmuted, like every other admin notice, and a paused club does not get it at all
(a paused club has no `due-posts` poll; the tip is not useful then anyway). Day 21 is
always in the free month, when the club is serving.

### 7.2 The club fee tip

**The numbers, per club** (a pure `clubFeeTip(input)` in `club-billing-rules.ts`, no
database):

- **Price:** £9.99, or the Custom price (`billingPricePence`). No tip for Free or
  `exempt` clubs (nothing to cover).
- **Players per game** = 2 x `Sport.playersPerTeam` of the club's weekly activity (a
  5-a-side is 10, a 7-a-side 14, an 8-a-side 16, a 9-a-side 18).
- **Games per month** = 4 x the number of the club's distinct weekly game slots (active
  `Activity` rows, one per weekday and time; a format-switch pair on the same evening
  counts once, as `generate-matches` already dedupes by kickoff within 90 minutes, `match-slot.ts`). One weekly game is 4; no active
  activity also reads as 4. Recommend counting every month as four weeks rather than
  counting the real calendar (a month has 4.33 weeks on average), so the share is stable
  month to month and a cancelled week does not leave a gap (decision 15).
- **Share per player per game** = price / (sum of players over the month's games),
  **rounded up to the next 5p** (decision 14). With one weekly game that is price /
  games / players. Two different weekly games (a Tuesday 5-a-side and a Thursday
  7-a-side) are summed: 4 x 10 + 4 x 14 = 96 player-games.
- **Example match fee:** the activity's own `feePerPlayer` when set (the base fee, before
  any card uplift), else the latest `Match.feePerPlayer` for that activity, else a neutral
  **£8** example. A club that splits the pitch cost (`feeSplitTotal`) gets the "add it to
  each player's share" wording instead of a fee plus share sum.

| Club | Players | Games | Exact share | Rounded up to 5p | Example |
|---|---|---|---|---|---|
| 5-a-side, £9.99 | 10 | 4 | 24.98p | **25p** | £8 game, charge **£8.25** (covers £10.00) |
| 7-a-side, £9.99 | 14 | 4 | 17.84p | **20p** | £7 game, charge **£7.20** (covers £11.20) |
| 9-a-side, £9.99 | 18 | 4 | 13.88p | **15p** | £6 game, charge **£6.15** (covers £10.80) |
| 5-a-side, Custom £5 | 10 | 4 | 12.5p | **15p** | £8 game, charge **£8.15** (covers £6.00) |

Rounding up means a full game covers the fee with a little to spare, which absorbs a
player short or a week off. To the penny, the 7-a-side would be 18p (covers £10.08), with
almost no slack.

**Sending it** (`sendClubFeeTip(orgId, now)` in `club-billing.ts`):

1. Claim `BillingNotice(orgId, "fee-tip", trialEndsAt)`; then
   `sendAdminNotice({ orgId, text, nextPath: null })`.
2. Work out whether that reached the collector. `sendAdminNotice` today returns only
   `{ channel, queued }`, so it gains a `reachedUserIds` field (the DM recipients it
   queued for; empty for a group post). The collector already has the tip when:
   - **one person:** the resolved recipient (the chosen admin, or the owner fallback) is
     the collector;
   - **each admin:** the collector is an OWNER or ADMIN with a phone, so was among them;
   - **admin group:** **this cannot be checked.** The server keeps no member list for a
     club's admin group: the participants are read once, when MatchTime is added, only
     to decide whether it is an admin group (`detectAdminGroupCandidate`,
     `admin-group-link.ts` ~115), and `sync-participants` only syncs the club's own group.
     So the collector **is DMed anyway**. If they are in the admin group they read it
     twice, once in the group and once by DM, with different first lines. Accepted:
     missing the person who sets the fee is worse than one repeat (decision 17).
3. If not reached, claim `BillingNotice(orgId, "fee-tip-collector", collectorId)` and
   queue one `dm` `BotJob` to the collector's phone with the collector wording. A
   collector without a phone is skipped and logged. No sign-in link: the collector may
   not be an admin, and the tip needs none.
4. **No collector set:** admins only, and the admin text gains one line asking them to
   set one in Settings (the link is the reader's own signed-in link by DM, the plain URL
   in the admin group, as `sendAdminNotice` already does).

**A collector set later.** When `setPaymentHolder` names a new collector for a club that is
billed (`billingStatus` not `exempt`) and they have not had the tip
(`BillingNotice(orgId, "fee-tip-collector", userId)` is free), they get it then, once.
Recommend yes (decision 16); without it a collector chosen after day 21 never hears it.

**Copy.** `{format}` is `sj_per_side_option` ("5-a-side"; in Turkish "5'e 5", "7'ye 7" through
the existing `perSideTr`). `{share}` is pence written "25p" in both languages (the clubs
are in London and play in pounds); a share of £1 or more is written "£1.05". `{fee}` and
`{feePlus}` through `gbp()` in `payments.ts`.

**Admin channel tip** (day 21; one message)

> EN: 💷 *Club fee tip:* your weekly {format} is {players} players and about {games} games a month, so {price} works out at about *{share} a player per game*. If your game costs {fee} each, charge *{feePlus}* and the club fee is covered.

> TR: 💷 *Kulüp ücreti ipucu:* haftalık {format} maçınız {players} oyunculu ve ayda yaklaşık {games} maç oynanıyor, yani {price} oyuncu başına maç başına yaklaşık *{share}* ediyor. Maç ücreti kişi başı {fee} ise *{feePlus}* alın, kulüp ücreti karşılanmış olur.

When the club's own fee is known, the last sentence reads "Your game is {fee} each, so
charging *{feePlus}* covers it." / "Maç ücretiniz kişi başı {fee}, *{feePlus}* alırsanız
karşılanır." When the pitch cost is split (`feeSplitTotal`): "When you split the pitch
cost, add about {share} to each player's share." / "Saha ücretini bölüştürürken her
oyuncunun payına yaklaşık {share} ekleyin."

No collector set, one extra line:

> EN: Nobody is set as the money collector yet. Choose one in Settings so they get this tip too: {link}

> TR: Henüz para toplayan kişi seçilmedi. Bu ipucunu o da alsın diye Ayarlar'dan birini seçin: {link}

**Collector DM**

> EN: 💷 You collect the match fees for *{club}*, so here's how to cover the {price} club fee: your weekly {format} is {players} players and about {games} games a month, which works out at about *{share} a player per game*. If your game costs {fee} each, charge *{feePlus}* and the club fee is covered.

> TR: 💷 *{club}* için maç ücretlerini siz topluyorsunuz, o yüzden {price} kulüp ücretini nasıl karşılayabileceğinizi paylaşıyorum: haftalık {format} maçınız {players} oyunculu ve ayda yaklaşık {games} maç oynanıyor, bu da oyuncu başına maç başına yaklaşık *{share}* ediyor. Maç ücreti kişi başı {fee} ise *{feePlus}* alın, kulüp ücreti karşılanmış olur.

The own-fee and split-cost endings are the same as the admin tip.

**"You're live" DM** (`sj_dm_approved`): one short paragraph **after** "Your first month
is free.", only when the club is billed (`BILLING_ENABLED` on and the plan is not Free).
With billing off the DM is exactly today's.

> EN: 💷 *Club fee tip:* after that it's {price} a month for the group. With {players} players and about {games} games a month, that's about *{share} a player per game*, so a {fee} game could be charged at *{feePlus}*.

> TR: 💷 *Kulüp ücreti ipucu:* sonrasında grup için aylık {price}. {players} oyuncu ve ayda yaklaşık {games} maçla bu, oyuncu başına maç başına yaklaşık *{share}* ediyor; {fee} olan bir maç için *{feePlus}* alabilirsiniz.

This breaks two pins in `self-join-copy.test.ts` (~100): the DM must **end with** "Your
first month is free." and contain **no amount**. Both stay true for the no-tip DM; the
slice adds a billed variant whose test pins that the tip follows the free-month sentence,
carries exactly the tip's amounts, and has no dash. The doc comment on `sj_dm_approved`
("never an amount") and the R185 copy-golden entries are updated with it.

**The website is unchanged.** The landing and help pages keep "With 20 players, that works
out at about 50p a player" (a month, one game a month each, no match fee). The tip is the
per game version of the same sum (25p x 4 games x 10 players is £10), and the public copy
test forbids "25p" on the landing page, which stays right because the tip is never on a
public page.

### 7.3 Billing DM copy (OWNER only)

All strings go into `src/lib/i18n/strings.en.ts` and `strings.tr.ts` (the parity test
covers them). `{price}` is "£9.99" or the custom price. Dates through
`src/lib/i18n/dates.ts` ("Fri 31 Oct" and "31 Eki Cum"). `{link}` is `buildAdminLink` to
`/admin/settings#billing` for that organiser and club.

**Day 21**

> EN: Hi {name}, {club}'s free month on MatchTime ends on {date}. To keep MatchTime running in "{group}", add a card here: {link}
> It's {price} a month for the whole group, and nothing is taken before {date}. I've also sent a tip on splitting it among the players.

> TR: Merhaba {name}, {club} için MatchTime'daki ücretsiz ayınız {date} tarihinde bitiyor. MatchTime'ın "{group}" grubunda çalışmaya devam etmesi için kartınızı buradan ekleyin: {link}
> Tüm grup için aylık {price}. {date} tarihinden önce hiçbir ücret alınmaz. Bu tutarı oyuncular arasında nasıl paylaşabileceğinize dair bir ipucu da gönderdim.

**Day 28**

> EN: Hi {name}, a quick reminder: {club}'s free month ends on {date}. Add a card to keep MatchTime running in "{group}": {link}

> TR: Merhaba {name}, kısa bir hatırlatma: {club} için ücretsiz ay {date} tarihinde bitiyor. MatchTime'ın "{group}" grubunda çalışmaya devam etmesi için kart ekleyin: {link}

**Day 30 (trial ended, grace starts)**

> EN: Hi {name}, {club}'s free month has ended. MatchTime will keep running in "{group}" for one more week, until {graceDate}. Add a card any time before then: {link}

> TR: Merhaba {name}, {club} için ücretsiz ay sona erdi. MatchTime "{group}" grubunda bir hafta daha, {graceDate} tarihine kadar çalışmaya devam edecek. O tarihe kadar istediğiniz zaman kart ekleyebilirsiniz: {link}

**Paused (day 37, or payment not recovered, or cancelled)** (first line varies by reason)

> EN (no card): Hi {name}, MatchTime is now paused for {club}.
> EN (payment): Hi {name}, we couldn't take the {price} for {club}, so MatchTime is now paused.
> EN (cancelled): Hi {name}, your MatchTime plan for {club} has ended, so MatchTime is now paused.
> EN (all): I'm still in "{group}", but I won't post or reply there, and nothing has been said in the group. Your players, matches and stats are all kept. To switch MatchTime back on, add a card here and it restarts within a few minutes: {link}

> TR (kart yok): Merhaba {name}, MatchTime {club} için şu an duraklatıldı.
> TR (ödeme): Merhaba {name}, {club} için {price} ödemesini alamadık, bu yüzden MatchTime şu an duraklatıldı.
> TR (iptal): Merhaba {name}, {club} için MatchTime planınız sona erdi, bu yüzden MatchTime şu an duraklatıldı.
> TR (hepsi): Hâlâ "{group}" grubundayım ama orada mesaj atmayacağım ya da yanıt vermeyeceğim, gruba da hiçbir şey söylenmedi. Oyuncularınız, maçlarınız ve istatistikleriniz saklanıyor. MatchTime'ı yeniden açmak için kartınızı buradan ekleyin, birkaç dakika içinde tekrar başlar: {link}

**Card added**

> EN: Thanks {name}, your card is saved. MatchTime keeps running in "{group}". The first {price} is taken on {date}, then monthly. To change your card or cancel: {link}

> TR: Teşekkürler {name}, kartınız kaydedildi. MatchTime "{group}" grubunda çalışmaya devam ediyor. İlk {price} {date} tarihinde, sonra her ay alınacak. Kartınızı değiştirmek ya da iptal etmek için: {link}

**Payment failed**

> EN: Hi {name}, this month's {price} for {club} didn't go through. Stripe will try again over the next few days, and MatchTime keeps running meanwhile. To update your card: {link}

> TR: Merhaba {name}, {club} için bu ayın {price} ödemesi alınamadı. Stripe önümüzdeki birkaç gün içinde tekrar deneyecek, bu sürede MatchTime çalışmaya devam ediyor. Kartınızı güncellemek için: {link}

**Resumed**

> EN: MatchTime is back on for {club}. I'll pick things up again in "{group}" within a few minutes. Anyone who said IN while I was paused should say it again.

> TR: MatchTime {club} için yeniden açıldı. Birkaç dakika içinde "{group}" grubunda kaldığım yerden devam ediyorum. Ben duraklatılmışken VARIM yazanlar lütfen tekrar yazsın.

House rules checked: no time-of-day greetings, no claims about what other organisers do,
no mention of AI, nothing in the club's own group (the tip may go to the separate admin
group, which is the club's own choice), no em or en dashes.

---

## 8. Web

### 8.1 Organiser billing card on `/admin/settings` (`id="billing"`)

A new section in `src/app/admin/settings/page.tsx`, shown only when the club's
`billingStatus` is not `exempt` (Sutton FC sees nothing new). English and Turkish.

| State | What it shows | Buttons (OWNER only) |
|---|---|---|
| `trial` | "Free month until {date}. Then {price} a month for the whole group." Club fee tip. | **Add a card** |
| `subscribed` | "{price} a month. Next payment {date}. Card {brand} ending {last4}." or "Ends on {date}" after a cancel | **Change card or cancel** |
| `grace` | "Your free month has ended. MatchTime stops on {date} unless a card is added." | **Add a card** |
| `past_due` | "Last payment didn't go through. Stripe is retrying. MatchTime stops on {date} if it can't be taken." | **Update card** |
| `paused` | "MatchTime is paused. Your data is kept. Add a card to switch it back on." | **Add a card** |

ADMINs who are not the OWNER see the status text but not the buttons ("Ask {owner} to
add a card"). **Every state shows the club fee tip** (section 7.2), worked out from the
club's game and match fee at page load, to OWNER and ADMINs alike, with the admin
channel wording (no link line). When no money collector is set, the tip is followed by
"Choose a money collector so they get this tip too" pointing at the payments section of
the same page. Advice only, no claim about what other groups do.

### 8.2 Banner

In `src/app/admin/layout.tsx`, for OWNER and ADMINs, in `grace`, `past_due` and `paused`
only: one line with the date and a link to `#billing`. No banner in `trial`.

### 8.3 Owner view on `/admin/clubs`

`/admin/clubs` already lists only self-join clubs and is superadmin only. Add:

1. A **Billing** column on "Live clubs that joined themselves": plan, status, trial end
   or next payment, card on file yes or no.
2. Per club controls: **Plan** (Standard £9.99, Free, Custom £x.xx), and **Start free
   month** for a self-join club still `exempt` (one approved before the flag was on).
   Each goes through `setClubPlan()` / `startTrial()` in `club-billing.ts`, superadmin
   checked again in the action.
3. A small totals line: paying clubs, monthly total at current prices, clubs in grace,
   past due and paused. Read from our tables; Stripe's dashboard stays the money record.

Nothing here DMs anyone.

---

## 9. The AI cap and billing

- The cap keeps its rule: **$0.25 a day for 28 days from `approvedAt`**, then $1.00. The
  trial runs 30 days from the same instant, so for days 28 to 30 a trial club already
  has the full allowance. No change proposed.
- **Paused means $0**, added to `aiAllowanceUsd` just after the approval check (4.3
  point 5), with a test that `aiDailyCapUsd` and `AI_DAILY_CAP_DISABLED` cannot lift it.
- `AllowanceOrg` and `ALLOWANCE_SELECT` gain `billingStatus`.
- For scale: Sutton FC's whole September production AI bill was about $3.50
  (`MDs/llm-spend-september-2026.md`). The $1.00 daily ceiling allows up to about $30 a
  month, above a £9.99 fee, but only for a club far busier than Sutton. Worth watching on
  `/admin/clubs`, not worth a rule today (decision 9).

---

## 10. Test plan (free suites only)

**No prompt changes anywhere.** Everything is deterministic code and static copy, so
**no live-LLM suite or dry run is needed or requested.** TDD, red first, per slice.

### 10.1 Unit (vitest)

- `club-billing-rules.ts`: every row of 4.1 and 4.2 as pure `nextBillingState` and
  `billingDue` cases, including a cron that was down for two days (no double reminder),
  quiet-hours `sendAfter`, and the 49-hour Checkout trial rule on days 28, 29 and 30.
- `setBillingState`: compare-and-set race (webhook and cron at once, one wins);
  `trialEndsAt` never reset on re-approval; Free implies `exempt`.
- Source guard: only `club-billing.ts` writes `billingStatus`; only it queues
  `purpose: "billing"`.
- Gates: a paused club is absent from `/orgs`, present in `silentGroups`; `due-posts`
  404s; `analyze` ignores with **zero model calls**; each cron skips it;
  `fixtureSkipReason` returns `org-billing-paused`; `aiAllowanceUsd` is 0 with every
  override; `dm-reply` returns silence for a member of only a paused club.
- Kill switch: with `BILLING_ENABLED` off, a club with `billingStatus = "paused"` passes
  every gate exactly as an approved club.
- **Sutton unchanged:** default `exempt` passes every gate as before; existing
  copy-golden tests stay green.
- Webhook: signature with the billing secret accepted, with the Connect secret refused;
  duplicate event id ignored; out-of-order `subscription.updated` then
  `checkout.session.completed` converges; event without `purpose: "club-fee"` ignored;
  `applyCheckoutEvent` ignores a club-fee session. Fixtures are real-shaped event JSON
  signed with `stripe.webhooks.generateTestHeaderString`, Stripe client mocked; **no
  network**.
- Resume: stale BotJobs dropped, future reminders kept, matches that passed during the
  pause completed with no post-match flow.
- VAT: the Checkout call always carries the inclusive Tax Rate, a required billing
  address and VAT number collection, for Standard and Custom prices alike; a completed
  session with a non-GB billing country or card country sets `vatCountryCheck` and keeps
  the subscription.
- Club fee tip (`clubFeeTip`): every row of the 7.2 table; Custom price; two weekly
  games summed; no activity reads as 4 games; share rounded up to 5p and never below 5p;
  own fee, latest match fee and the £8 fallback; `feeSplitTotal` wording; no tip for Free
  or `exempt`.
- Tip routing (`sendClubFeeTip`): one person is the collector, no extra DM; one person is
  someone else, collector DMed; each admin with the collector an admin, no extra DM;
  each admin with a non-admin collector, collector DMed; admin group, collector always
  DMed; no collector, admins only with the "choose a collector" line; collector without
  a phone skipped; a second call sends nothing (`BillingNotice`); `setPaymentHolder` on a
  billed club DMs a new collector once, on an `exempt` club never.
- `sj_dm_approved`: unchanged with billing off (today's pins, including "ends with the
  free sentence" and "no amount"); with billing on, the tip follows the free sentence in
  both languages.
- i18n: every new string exists in both languages; Turkish dates render.

### 10.2 Playwright (web, free)

Under `MT_TEST_MODE`, `stripe-billing.ts` uses a fake adapter (`BILLING_STRIPE_FAKE=1`)
that returns a local "checkout" URL and records calls; the test then posts signed fixture
events to `/api/stripe/billing-webhook`.

- Organiser: card hidden for an exempt club; in `trial` sees the card, taps **Add a
  card**, lands on the fake checkout, the test posts `checkout.session.completed`, the
  card shows "Next payment".
- Grace and paused: banner appears; `/api/whatsapp/orgs` (with `WHATSAPP_API_KEY`) drops
  the group and lists it in `silentGroups`; after a fixture `invoice.paid` it is back.
- A non-OWNER admin sees status, no buttons, and the club fee tip with the club's own
  numbers (a 7-a-side test club with a £7 fee shows 20p and £7.20).
- `/admin/clubs`: superadmin sets Free, Custom £5 and Standard; "Start free month";
  non-superadmin gets 404.
- Cron: hitting `/api/cron/billing` with `x-test-now` at days 21, 28, 30 and 37 queues
  exactly one `PlatformJob` each, in the club's language, and moves the state.
- Group simulator (`e2e/sim`, stubbed model): a paused group produces zero outbound
  messages and zero model calls.

### 10.3 Manual, Stripe **test mode** only (before rollout)

On a Preview deployment with `sk_test` keys: real Checkout with card `4242 4242 4242
4242`, a 3DS test card, a declining card (`4000 0000 0000 0341`), and a **Stripe test
clock** to run a subscription through trial end, renewal, failure and Smart Retries to
cancel in minutes. Open one test invoice PDF and check the legal name, address, VAT
number and the "VAT (20%, inclusive)" line, and try a Turkish billing address to see the
flag. This is the only place real Stripe Billing behaviour is exercised
before live.

---

## 11. Rollout

1. **Flag** `BILLING_ENABLED`, off by default. Slices B1 to B5 ship dark. With it off:
   no trials start, the cron does nothing, every gate ignores `paused`, the settings card
   is hidden. The webhook still records and syncs events if any arrive.
2. **Test mode first:** product, price, Portal, Smart Retries and webhook created in
   **test mode**, test env vars on Preview, 10.3 run end to end.
3. **Live config, by Kemal in the Stripe dashboard** (no live keys through chat): live
   product and tax-inclusive price, the 20% inclusive Tax Rate, business details and
   VAT number on invoices, Portal, Smart Retries, customer emails, the platform-scoped billing
   webhook, and **delete the old platform-scoped `we_1TgQL6...` endpoint** if it still
   exists (section 2). Then Vercel prod env: `STRIPE_BILLING_WEBHOOK_SECRET`,
   `STRIPE_CLUB_PRICE_ID`, `STRIPE_CLUB_PRODUCT_ID`, `STRIPE_CLUB_TAX_RATE_ID`.
4. **Switch on for new clubs only.** `BILLING_ENABLED=1`. Every existing club stays
   `exempt`. Clubs approved from that moment get a trial. Self-join clubs approved
   before it are Kemal's call per club ("Start free month", decision 2).
5. **First real organiser:** watch `/admin/clubs` through their day 21.
6. **Copy:** the help page (`src/app/help/admin/page.tsx`) gains one paragraph on the
   card reminder, grace week and pause; the landing page needs no change.

**Rollback:** `BILLING_ENABLED` off. Every paused club serves again within one Pi org
refresh; reminders stop; nobody is DMed. Subscriptions keep charging, which is correct
for clubs that chose to pay; Kemal can cancel any in Stripe.

---

## 12. Env vars

| Name | Where | Value |
|---|---|---|
| `BILLING_ENABLED` | Vercel (server only) | `1` to turn on |
| `STRIPE_BILLING_WEBHOOK_SECRET` | Vercel | `whsec_...` of the **platform-scoped** billing endpoint |
| `STRIPE_CLUB_PRICE_ID` | Vercel | `price_...` (£9.99 monthly) |
| `STRIPE_CLUB_PRODUCT_ID` | Vercel | `prod_...`, for Custom prices |
| `STRIPE_CLUB_TAX_RATE_ID` | Vercel | `txr_...`, 20% UK VAT, inclusive |
| `STRIPE_SECRET_KEY` | existing | unchanged, same platform account |
| `STRIPE_WEBHOOK_SECRET` | existing | unchanged, Connect endpoint only |
| `BILLING_STRIPE_FAKE` | test only | `1` under `MT_TEST_MODE` for Playwright |

Added to `.env.example` with comments. Trial length (30), grace (7) and reminder days
(21, 28) are constants in `club-billing-rules.ts`, not env.

---

## 13. Slices (one PR each)

| # | PR | Depends on | Main files |
|---|---|---|---|
| B1 | **Schema, rules and the quiet gate.** Columns, `ClubBilling`, `BillingEvent`, `BillingNotice`, CHECK constraints, `club-billing-rules.ts`, `setBillingState`, `SERVING_CLUB_WHERE`, `isClubOperational` and every gate in 4.3, AI allowance $0, `fixtureSkipReason`, `dm-reply` rail, kill switch, `resumeClub`. No visible change (every club `exempt`). | none | `prisma/`, `club-approval-state.ts`, `club-billing*.ts`, `orgs`, `due-posts`, `analyze` (org lookups only), crons, `ai-budget.ts`, `org-lifecycle.ts`, `dm-reply` |
| B2 | **Trial, owner controls and the club fee tip.** Trial at approval (`decideClub` approve, flag on), `/admin/clubs` billing column, plan control, "Start free month", settings card (read-only states, with the tip), banner, `clubFeeTip`, the tip paragraph in `sj_dm_approved`, i18n. | B1 | `club-approval.ts` (one call), `club-billing-rules.ts`, `/admin/clubs`, `/admin/settings`, `admin/layout.tsx`, `i18n`, `self-join-copy.test.ts` |
| B3 | **Stripe.** `stripe-billing.ts`, Add a card (Checkout, with the inclusive Tax Rate, billing address, VAT number collection and the UK check), Change card or cancel (Portal), billing webhook, sync, "card-added" DM, plan changes on live subscriptions, fake adapter. | B1, B2 | `stripe-billing.ts`, `api/stripe/billing-webhook`, settings actions |
| B4 | **Scheduler and tip routing.** `/api/cron/billing`, day 21, 28, 30, 37, payment-failure grace, `purpose: "billing"`, `BillingNotice`, all DM copy EN and TR; `sendClubFeeTip` (admin channel plus collector, 7.2), `reachedUserIds` on `sendAdminNotice`, the new-collector tip in `setPaymentHolder`. | B2, B3 | `api/cron/billing`, `vercel.json`, `platform-jobs.ts` (purpose), `admin-channel.ts` (return value only), `actions/payments.ts` (one call), `i18n` |
| B5 | **Removal from a live group.** Pi forwards self-removal for monitored groups too (`handleGroupLeaveForSelfRemoval`), server sets `paused (removed)` and cancels at period end for billed clubs only; **exempt clubs (Sutton) only log**. Re-add during the trial resumes it. Pi deployed with `scripts/deploy-pi.sh`, away from match time. | B3 | `whatsapp-bot/src/bot-added.ts`, `api/whatsapp/bot-removed`, `club-billing.ts` |
| B6 | **Go-live.** Help page paragraph, `.env.example`, runbook in this file. Then rollout steps 2 to 5. | B1 to B5 | `help/admin/page.tsx` |
| B7 | **Optional, only with Kemal's yes (section 14):** "Add the club fee to match fees" for clubs taking card or bank payments through Stripe Connect. Ships dark behind its own per-club setting, after B6 has run live for a while. | B6 | `payments.ts`, `actions/payments.ts`, `pay-options.tsx`, `stripe.ts`, `api/stripe/webhook`, `api/stripe/billing-webhook`, `stripe-billing.ts`, `club-billing.ts`, `/admin/settings`, public copy |

B3 and the UI half of B2 can run in parallel after B1 if their files are split as above.
B1 touches `analyze/route.ts` only at the two org lookups.

---

## 14. Proposed, needs Kemal's yes: add the club fee to match fees (slice B7)

Not part of B1 to B6. Nothing here is built unless Kemal says yes (decision 13).

### 14.1 What the organiser gets

A per-club setting on `/admin/settings`, OWNER only: **"Add the club fee to match fees"**.
It can be switched on only when the club takes payments through MatchTime (Stripe
connected, `paymentCollectionEnabled`, card or Pay by Bank on) **and** a card is on file
for the club fee. When on:

- every card or Pay by Bank match payment carries the player's **club fee share** (the
  section 7.2 number, 25p for a 5-a-side at £9.99), taken by MatchTime in the same
  `application_fee_amount` that already carries the 1% platform fee;
- it **stops adding** once that month's fee is covered;
- at month end MatchTime charges the owner's card **only for the shortfall** (players who
  paid cash, or a quiet month), or nothing. The card stays on file as the backup.

Players who pay the collector directly (cash or bank transfer) pay no share: MatchTime
never touches that money, which is exactly why there can be a shortfall.

### 14.2 What changes for the player

- `totalForMethod(base, method, qty)` in `payments.ts` gains a `clubSharePence` argument
  and grosses it up with the rest, so the collector still nets exactly the base and the
  Stripe fee on the share is covered too:
  `G = (base x qty + stripeFixed + platform + share) / (1 - stripePct)`, rounded up to the
  penny as today. `share` is for the whole payment (guests included), already capped.
- `platformFeePence` stays the 1% only; a new `applicationFeePence = platform + share` is
  what `payByMethod` passes to `createCheckoutSession`. Stripe takes its processing fee
  from the connected account as today; the share and the 1% land on MatchTime's platform
  balance.
- The pay page (`pay-options.tsx`, which calls `totalForMethod` itself to show totals)
  gets the same share from the server, so the shown and charged amounts match, and one
  small line under the total: "Includes 25p towards {club}'s MatchTime plan." / "25p'si
  {club} kulübünün MatchTime planına gidiyor." Recommend showing it: players see the
  amount go up by the share and should know why.
- `Attendance.paymentAmount` keeps recording what the player paid (it now includes the
  share). The collector's "who paid" label is unchanged.

Worked example, 5-a-side, £8 base, card, one player: today 1% is 8p and the total is
(8.00 + 0.20 + 0.08) / 0.985 = **£8.41**. With a 25p share it is (8.00 + 0.20 + 0.08 +
0.25) / 0.985 = **£8.66**; the application fee is 33p; the collector still nets £8.00.

### 14.3 Tracking the share and stopping when covered

A new table, per club, not per collector:

```prisma
model ClubFeeShare {
  id                 String    @id @default(cuid())
  orgId              String
  checkoutSessionId  String    @unique   // the match payment's Checkout session (cs_...)
  connectedAccountId String              // the collector account it was charged on, for refunds
  applicationFeeId   String?             // fee_..., once the charge succeeds
  sharePence         Int
  refundedPence      Int       @default(0)
  status             String              // "reserved" | "settled" | "refunded" | "applied"
  appliedInvoiceId   String?             // the club fee invoice it was credited to
  createdAt          DateTime  @default(now())
  @@index([orgId, status])
}
```

- **At checkout** (`payByMethod`), `remaining = price - settled and unapplied shares -
  shares reserved in the last 30 minutes`. The payment carries `min(share x qty,
  remaining)`, never below 0, and a `reserved` row is written with the session id. When
  `remaining` is 0 the payment is exactly today's.
- **On payment** (the Connect webhook's existing `checkout.session.completed`,
  `applyCheckoutEvent`), the row becomes `settled` with the application fee id. An
  expired session's reservation lapses after 30 minutes.
- Two players paying in the same second can both see the last few pence as remaining, so
  a month can be over-covered by at most one share per concurrent payer. That surplus is
  credited like the rest and carries over to the next month (14.4).

**The money collector changes mid-month.** Shares are keyed by `orgId`, and the club's
connected account is a club field (`Organisation.stripeConnectAccountId`). A new collector
means `resetCollectorConnect` clears the account and the new collector connects their
own. Meanwhile card payments are unavailable (`payByMethod` refuses without a connected
account), so no shares are taken and any gap becomes shortfall. Once the new account is
connected, shares continue into the same club's count. Application fees from the old and
new accounts both land on MatchTime's platform balance, so the month's total does not
care who collected. Each row keeps `connectedAccountId`, so a refund of a payment taken
on the old account can still find it.

### 14.4 Month end: Stripe customer balance credit (recommended)

The club fee subscription stays exactly as in section 5: £9.99 (or Custom), VAT
inclusive, billed monthly in advance. Shares collected during one month are credited
against the **next** invoice. With the card added during the free month, shares from the
free month go towards the first £9.99.

**Recommended mechanism: a customer balance credit.** On the billing webhook's
`invoice.created` for a renewal (the subscription's invoice is created as a draft and
finalised about an hour later), MatchTime sums the club's `settled` shares and adds one
credit with `customers.createBalanceTransaction(customer, { amount: -min(sum, invoice
total), currency: "gbp", description: "Club fee shares from match payments, {month}" })`,
then marks those rows `applied` with the invoice id. Stripe applies a credit balance
automatically when the invoice is finalised: the invoice still shows £9.99 including
£1.66 VAT, and the amount charged to the card is only what is left, or nothing.

Why not the alternatives:

| Option | Problem |
|---|---|
| Customer balance credit (recommended) | none of the below; the invoice keeps the full price and the full VAT line, so VAT is still accounted on the £9.99 supply to the club |
| A negative invoice item (a discount line) | lowers the invoice total, so it also lowers the VAT on the invoice, which is wrong if the shares are payments towards the same £9.99 |
| Usage-based (metered) pricing | turns a fixed £9.99 into a variable charge, needs a different Price and Product, and still has to net off money taken elsewhere |
| Coupons | fixed or percentage amounts, not "whatever was collected" |

**If the webhook misses the draft window**, the credit still sits on the customer and is
used by the next invoice. Nothing is lost; the owner pays in full once and less next
month. The settings card shows it ("£6.40 of this month's £9.99 covered by match
payments so far"; "£2.00 credit carried to next month").

**Reconciliation:** the hourly billing cron (section 6) also checks, once a day, the
platform's application fees (`applicationFees.list`) for the club's connected account
against the `ClubFeeShare` rows, so a missed Connect webhook only delays a share.

### 14.5 VAT

The £9.99 stays VAT inclusive and is invoiced to the club (the owner), exactly as in 5.4.
The shares are treated as **payments towards that invoice**, made through the club's
match fee collection, not as a separate sale to each player: players get no VAT invoice
from MatchTime, and the collector's Stripe receipt is unchanged except for the higher
amount. This is the reading the customer balance mechanism matches. **Accountant to
confirm** before B7 ships (decision 13(c)): whether HMRC would see the shares as
consideration from the players for a supply to them, which would change the treatment.

### 14.6 Refunds of a match payment

Today MatchTime does not handle refunds in code at all: the Connect webhook ignores them
(`api/stripe/webhook/route.ts` ~63), and a collector who wants to refund a player does it
in Stripe. On a direct charge, a refund made on the connected account does **not** give
back MatchTime's application fee unless the refund is created with
`refund_application_fee` (a platform API option); I have not verified what an Express
collector can do from their own Stripe dashboard. Test mode will show it.

**Recommend refunding the share too**: the player did not play, and the club's month is
then simply less covered. B7 adds `charge.refunded` to the Connect webhook's handled
events: for a charge whose session has a `ClubFeeShare`, MatchTime refunds the share
portion of the application fee (`applicationFees.createRefund(feeId, { amount })`) to the
connected account, so the collector can pass it on, and lowers the row (`refundedPence`).
If the share was already credited to an invoice, the club's next credit is reduced by
that amount instead. The 1% is left as today's code leaves it.

### 14.7 Public copy and the test that forbids it

`public-copy.test.ts` has a pin "never claims MatchTime collects the club fee itself":
`/(collects?|charges?) the (club|monthly) fee (for you|automatically)|automatically
(collect|split|charge)/`, and a separate pin against fee talk ("platform fee", "card
fee", "1%" and so on). With B7 the honest claim is narrower than either form, so:

- Website wording (landing pricing section ~608 and help admin page ~49), after the 50p
  line: "If your club takes card or bank payments through MatchTime, you can choose to
  add each player's share to their match fee, and your card only pays what is left at
  the end of the month." It names no MatchTime fee and avoids "automatically".
- The test keeps "automatically (collect|split|charge)" and "collects the club fee for
  you" forbidden (the setting is a choice and cash payers are not covered), and gains a
  positive pin: any sentence on a public page that mentions adding the share to the
  match fee also contains "card or bank payments" and "you can choose". Its comment is
  updated to say why.
- The landing pin "about 50p a player" stays; "25p" stays off the landing page.

### 14.8 Failure modes

| What goes wrong | Effect | Handling |
|---|---|---|
| Two payments race for the last pence | month over-covered by a few pence | credit carries to the next month |
| Connect webhook late or lost | share not counted yet; owner may pay more this month | daily reconciliation against `applicationFees.list`; surplus carries over |
| `invoice.created` handled after finalisation | credit lands on the next invoice | shown on the settings card; nothing lost |
| Collector disconnects, or changes mid-month | no card payments, so no shares | the shortfall is charged to the card as normal (14.3) |
| Club moved to Free or `exempt` mid-month | no invoice left to credit | shares stop at once; collected credit is listed on `/admin/clubs` for Kemal to refund by hand |
| Club cancels or is paused with credit left | credit sits on the Stripe customer | same: listed on `/admin/clubs`; no automatic refund |
| Owner's card fails for the shortfall | `past_due`, as section 4 | unchanged; shares keep counting while `past_due` |
| `BILLING_ENABLED` switched off | nobody is billed | no new shares are added (the setting is ignored); credit already on a customer stays there for Kemal to refund or use |
| Price changes (Custom) | cap would use the old price | the cap reads the subscription's current price at checkout |
| Pay page shown, then the month is covered before the player pays | total on screen is higher than needed | the share is fixed when the Checkout session is created, and the page shows the same server figure; at most one share over |

### 14.9 Tests (free suites)

Unit: the gross-up with a share (collector nets the base exactly, for card and bank,
qty 1 and 3); application fee = 1% + share; the cap and reservations; a race (two
checkouts, one remaining share); a refund before and after crediting; the balance credit
amount on `invoice.created` (capped at the invoice total, idempotent on a re-delivered
event); collector change keeps the club's count; cash payments never carry a share;
setting off, Free, `exempt` or flag off means today's totals to the penny (existing
payment tests stay green). Playwright: the pay page shows the line and the higher total;
the settings card shows "covered so far". Test mode by hand: a test clock month with
three card payments and one cash payer, checking the invoice shows £9.99 incl VAT and
charges only the shortfall.

---

## 15. Decisions for Kemal

1. **Trial length: 30 days from approval, then 7 days grace.** Recommend yes, as in the
   outline. The site says "first month free"; the grace week is on top and not advertised.
2. **Self-join clubs approved before billing is switched on** (your test clubs, today's
   first prospects): recommend they stay free until you press **Start free month** for
   each, so nobody gets a "your free month ends" DM for a month that silently started
   earlier.
3. **Card added late (day 29 or 30):** recommend the trial end is pushed to at least 49
   hours ahead (Stripe's minimum), so they get one or two extra free days rather than an
   early charge.
4. **Who can add the card:** recommend the club's OWNER only; admins see the status.
   Alternative: any admin can pay.
5. **Removing MatchTime from the group** (B5): recommend it pauses billing and cancels at
   the end of the paid month, no refund, no DM. Alternative: skip B5 and rely on the
   Portal cancel only (then a removed club in trial would still get reminder DMs).
6. **Your off switch on a paying club** (suspend): recommend cancel the subscription at
   once with no automatic refund; you refund by hand in Stripe if you choose.
7. **VAT method:** confirmed, Cressoft is VAT registered and £9.99 includes VAT.
   Recommend a **fixed 20% inclusive Tax Rate**, not Stripe Tax (free, and exact for UK
   only); the Price is still created tax inclusive so a later move to Stripe Tax is easy.
8. **Custom price range:** recommend £1.00 to £9.99, monthly only, effective from the next
   month for clubs already paying. No annual plan for now.
9. **AI cap for paying clubs:** recommend no change ($1.00 a day after the first 28 days)
   and watch spend per club on `/admin/clubs`.
10. **UK only at first:** recommend yes. Non-UK billing address or card: subscription
    kept, club flagged "Check VAT country" for you to decide. Selling to consumers in
    Turkey or the EU waits until your accountant has set up foreign VAT (Turkish
    simplified registration, EU non-Union OSS).
11. **Invoice details:** please confirm the exact legal name, registered address and VAT
    number to put on invoices (Stripe Settings, Business details), and whether the
    footer should say "MatchTime is a service of {legal name}". Recommend also letting
    a club enter its own VAT number at Checkout.
12. **Custom price floor:** a £5.00 plan nets £4.17 before Stripe and AI, roughly
    break-even at £3 of AI. Recommend £5 as the lowest custom price you offer in
    practice, and Free (not a lower price) for anyone below that.
13. **Adding the club fee to match fees** (slice B7, section 14): your call, it is the
    one optional part. Recommend **yes, but after B1 to B6 have run live** with a few
    paying clubs, as its own PR behind its own per-club setting. It keeps the money
    separation of section 2 for the subscription itself; only the share rides on the
    Connect application fee, which already carries MatchTime's 1%. If yes, three
    sub-decisions:
    (a) **refunds:** recommend a refunded match payment gives the share back too (14.6);
    (b) **month end:** recommend a Stripe **customer balance credit** against the
    full-price invoice, not a discount line or metered price (14.4);
    (c) **VAT:** please have your accountant confirm that the shares can be treated as
    payments towards the club's VAT-inclusive invoice (14.5).
    No: the club fee tip (section 7.2) still tells organisers how to cover it themselves.
14. **Rounding the share:** recommend **up to the next 5p** (25p, 20p, 15p): round
    numbers to add to a match fee, and a full game covers the fee with a little to spare.
    Alternative: up to the next penny (18p for a 7-a-side), which leaves almost no slack.
15. **Games per month in the tip:** recommend **4 per weekly game, every month**, not
    the real calendar count, so the tip does not change month to month and a five-week
    month or a cancelled week is absorbed.
16. **A collector named after day 21** gets the tip by DM once, for a billed club.
    Recommend yes.
17. **Collector in the admin group:** the server cannot see who is in a club's admin
    group, so in admin group mode the collector is DMed the tip as well, and may read it
    twice. Recommend accepting the duplicate (7.2). Alternative: store the admin group's
    members from the Pi, a separate piece of work.
