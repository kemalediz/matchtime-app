# Club fee billing: free month, then £9.99 a month per group

Plan, 2026-10-01. Design only: no code, schema, Stripe setting or production row was
changed to write it. Direction (the outline) accepted by Kemal on 2026-10-01. Every
claim about the current code cites the file it was read from, on `origin/main` at
`cd38c51`.

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

**Who gets messaged:** only the organiser (the club's OWNER), by the existing platform
DM channel, in English or Turkish. **No DMs to you.** Billing numbers sit on
`/admin/clubs`.

**Cost to build:** six PRs. No prompt changes, so **no paid AI test runs**. Stripe is
tested in test mode and with signed fixture events; **live mode is touched only at
rollout, by you, in the dashboard**.

**Switch:** `BILLING_ENABLED`, off by default. Off means nobody is billed or paused, and
any paused club comes straight back. It starts with **new clubs only**.

**Decisions I need from you:** section 14 (ten of them, each with a recommendation).

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
| Stripe today | `src/lib/stripe.ts`, `src/app/api/stripe/webhook/route.ts`, `applyCheckoutEvent` in `src/lib/payment-flow.ts` | Connect Express accounts for collectors, **direct charges** on the connected account, 1% `application_fee_amount`. The webhook verifies with the single `STRIPE_WEBHOOK_SECRET` (the **Connected accounts** endpoint). `applyCheckoutEvent` ignores a session without `matchId` and `userId` metadata (~121). |
| Public route | `src/lib/public-paths.ts` ~49 | Everything under `/api/stripe` is already public (signature is the auth). |
| Removal from a live group | `handleGroupLeaveForSelfRemoval` in `whatsapp-bot/src/bot-added.ts` (~290) | The Pi tells the server only when MatchTime is removed from a **silent** group. Removal from a live club's group is not reported today. |
| Price on the site | `src/components/landing/landing-page.tsx` ~553, ~608, ~640; `src/app/help/admin/page.tsx` ~10, ~43 | "£9.99 a month per WhatsApp group ... first month is free", the 50p split advice, and "remove MatchTime from the group any time to stop". |
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
  Connect webhook, `applyCheckoutEvent`.
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
  cycleKey      String   // e.g. trialEndsAt ISO date, or the invoice id
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

---

## 4. States and transitions

### 4.1 Day numbers

Day 0 is `approvedAt`. `trialEndsAt` = day 30, `graceEndsAt` = day 37 (for a club with
no card). Reminders go out at or after **10:00 London** on their day.

| Day | Instant | Condition | Action |
|---|---|---|---|
| 0 | `approvedAt` | `BILLING_ENABLED`, plan not free, no `ClubBilling` row yet | `trial`; create `ClubBilling` |
| 21 | `trialEndsAt - 9d` | still `trial` | DM "trial-21" |
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

- Product **"MatchTime club"**. Price **£9.99 GBP, monthly, recurring**, lookup key
  `club_monthly_standard`. Its id goes in `STRIPE_CLUB_PRICE_ID`; the product id in
  `STRIPE_CLUB_PRODUCT_ID`.
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
- the price is `STRIPE_CLUB_PRICE_ID`, or for a Custom plan a price under
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

---

## 6. The scheduler

A new cron, **`/api/cron/billing`, hourly** (`0 * * * *` in `vercel.json`), behind
`CRON_SECRET` like the others. With `BILLING_ENABLED` off it returns at once.

Each run loads clubs in `trial`, `grace` or `past_due` and, for each, asks the pure
`billingDue(club, now)` which of these is due:

| Kind | Due when | Also |
|---|---|---|
| `trial-21` | now at or after day 21 at 10:00 London, still `trial` | skipped if `trial-28` is already due (a late cron never sends two in a row) |
| `trial-28` | day 28 at 10:00 London, still `trial` | |
| `trial-ended` | at or after `trialEndsAt`, still `trial` | moves to `grace` first; the DM waits for 10:00 if it is night |
| `paused` | at or after `graceEndsAt`, still `grace` or `past_due` | moves to `paused`; the DM waits for 10:00 |

The state change happens on time; only the DM waits for daytime (10:00 to 20:00 London),
using `sendAfter` on the `PlatformJob`. Every DM is claimed first in `BillingNotice`
(`orgId, kind, cycleKey`), then queued with `queuePlatformDm({ purpose: "billing" })`.
Hourly runs make a missed run harmless.

Why a Vercel cron and not the Pi scheduler: the Pi scheduler is per group and is exactly
what stops polling for a paused club, and the day-37 DM must go out after the pause.
The platform channel is the one sender that works whatever a club's switches say.

---

## 7. DM copy (organiser only, English and Turkish)

All strings go into `src/lib/i18n/strings.en.ts` and `strings.tr.ts` (the parity test
covers them). `{price}` is "£9.99" or the custom price. `{share}` is the price divided by
20, rounded to the nearest penny ("about 50p"). Dates through `src/lib/i18n/dates.ts`
("Fri 31 Oct" and "31 Eki Cum"). `{link}` is `buildAdminLink` to
`/admin/settings#billing` for that organiser and club.

**Day 21**

> EN: Hi {name}, {club}'s free month on MatchTime ends on {date}. To keep MatchTime running in "{group}", add a card here: {link}
> It's {price} a month for the whole group, and nothing is taken before {date}. You can share it among the players if you like: with 20 players it's about {share} each.

> TR: Merhaba {name}, {club} için MatchTime'daki ücretsiz ayınız {date} tarihinde bitiyor. MatchTime'ın "{group}" grubunda çalışmaya devam etmesi için kartınızı buradan ekleyin: {link}
> Tüm grup için aylık {price}. {date} tarihinden önce hiçbir ücret alınmaz. İsterseniz bu tutarı oyuncularla paylaşabilirsiniz: 20 oyuncuyla kişi başı yaklaşık {share}.

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
no mention of AI, no message to the group.

---

## 8. Web

### 8.1 Organiser billing card on `/admin/settings` (`id="billing"`)

A new section in `src/app/admin/settings/page.tsx`, shown only when the club's
`billingStatus` is not `exempt` (Sutton FC sees nothing new). English and Turkish.

| State | What it shows | Buttons (OWNER only) |
|---|---|---|
| `trial` | "Free month until {date}. Then {price} a month for the whole group." Sharing tip. | **Add a card** |
| `subscribed` | "{price} a month. Next payment {date}. Card {brand} ending {last4}." or "Ends on {date}" after a cancel | **Change card or cancel** |
| `grace` | "Your free month has ended. MatchTime stops on {date} unless a card is added." | **Add a card** |
| `past_due` | "Last payment didn't go through. Stripe is retrying. MatchTime stops on {date} if it can't be taken." | **Update card** |
| `paused` | "MatchTime is paused. Your data is kept. Add a card to switch it back on." | **Add a card** |

ADMINs who are not the OWNER see the status text but not the buttons ("Ask {owner} to
add a card"). The sharing tip reads "You can split it among the players: with 20, it's
about {share} each." (advice only, no claim about what other groups do).

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
- A non-OWNER admin sees status, no buttons.
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
cancel in minutes. This is the only place real Stripe Billing behaviour is exercised
before live.

---

## 11. Rollout

1. **Flag** `BILLING_ENABLED`, off by default. Slices B1 to B5 ship dark. With it off:
   no trials start, the cron does nothing, every gate ignores `paused`, the settings card
   is hidden. The webhook still records and syncs events if any arrive.
2. **Test mode first:** product, price, Portal, Smart Retries and webhook created in
   **test mode**, test env vars on Preview, 10.3 run end to end.
3. **Live config, by Kemal in the Stripe dashboard** (no live keys through chat): live
   product and price, Portal, Smart Retries, customer emails, the platform-scoped billing
   webhook, and **delete the old platform-scoped `we_1TgQL6...` endpoint** if it still
   exists (section 2). Then Vercel prod env: `STRIPE_BILLING_WEBHOOK_SECRET`,
   `STRIPE_CLUB_PRICE_ID`, `STRIPE_CLUB_PRODUCT_ID`.
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
| B2 | **Trial and owner controls.** Trial at approval (`decideClub` approve, flag on), `/admin/clubs` billing column, plan control, "Start free month", settings card (read-only states), banner, i18n. | B1 | `club-approval.ts` (one call), `/admin/clubs`, `/admin/settings`, `admin/layout.tsx`, `i18n` |
| B3 | **Stripe.** `stripe-billing.ts`, Add a card (Checkout), Change card or cancel (Portal), billing webhook, sync, "card-added" DM, plan changes on live subscriptions, fake adapter. | B1, B2 | `stripe-billing.ts`, `api/stripe/billing-webhook`, settings actions |
| B4 | **Scheduler.** `/api/cron/billing`, day 21, 28, 30, 37, payment-failure grace, `purpose: "billing"`, `BillingNotice`, all DM copy EN and TR. | B2, B3 | `api/cron/billing`, `vercel.json`, `platform-jobs.ts` (purpose), `i18n` |
| B5 | **Removal from a live group.** Pi forwards self-removal for monitored groups too (`handleGroupLeaveForSelfRemoval`), server sets `paused (removed)` and cancels at period end for billed clubs only; **exempt clubs (Sutton) only log**. Re-add during the trial resumes it. Pi deployed with `scripts/deploy-pi.sh`, away from match time. | B3 | `whatsapp-bot/src/bot-added.ts`, `api/whatsapp/bot-removed`, `club-billing.ts` |
| B6 | **Go-live.** Help page paragraph, `.env.example`, runbook in this file. Then rollout steps 2 to 5. | B1 to B5 | `help/admin/page.tsx` |

B3 and the UI half of B2 can run in parallel after B1 if their files are split as above.
B1 touches `analyze/route.ts` only at the two org lookups.

---

## 14. Decisions for Kemal

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
7. **VAT:** is £9.99 VAT inclusive, and is the platform account VAT registered? Recommend
   price set as tax inclusive and Stripe Tax off until your accountant says otherwise.
8. **Custom price range:** recommend £1.00 to £9.99, monthly only, effective from the next
   month for clubs already paying. No annual plan for now.
9. **AI cap for paying clubs:** recommend no change ($1.00 a day after the first 28 days)
   and watch spend per club on `/admin/clubs`.
10. **Adding the fee to match fees** (the "about 50p each" idea built in): recommend not
    now. It mixes the club fee into Connect money, which this plan keeps apart on purpose.
    Revisit once a few clubs pay and ask for it; it would be its own plan.
