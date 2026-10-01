# Club fee billing: free month, then £9.99 a month per group

Plan, 2026-10-01. Design only: no code, schema, Stripe setting or production row was
changed to write it. Direction (the outline) accepted by Kemal on 2026-10-01. Every
claim about the current code cites the file it was read from, on `origin/main` at
`cd38c51` (sections 7.1 and 7.2 were checked again at `dca3057`; sections 1, 4.5, 8.1
and 9 at `8dc9646`).

Revised 2026-10-01, four passes:

- **Second pass:** every club fee message explains how to split the fee among the
  players, with a worked example from the club's own game (section 7.2).
- **Third pass (Kemal's decisions, 2026-10-01):**
  1. The **money collector** (`Organisation.paymentHolderId`) adds and owns the card for
     the club fee, not the owner. With no collector set, the owner does, and is nudged
     to set one (sections 4.5, 7, 8.1).
  2. Adding the club fee to match fees (the old slice B7) is **not planned**: players
     generally pay the collector by bank transfer, so it would help few clubs. The club
     fee tip is how clubs cover the fee (section 14).
  3. The AI cap for paying clubs stays **open**, with today's state written down from
     the code and a recommendation (section 9, decision 10).
- **Fourth pass (Kemal's decisions, 2026-10-01, shipped in the AI cap PR):**
  1. **New AI daily caps.** $2.00 a day for the free month (30 days from approval), then
     **$1.50 a day** for a paying club; unapproved or muted clubs $0 as before. Decision
     10 is now **decided** (section 9).
  2. When a club reaches its cap, its **admins are told once a day** through the admin
     channel (section 9).
  3. **AI top-ups (planned)**, a future slice after B1 to B6 (section 9.1, decision 18).

---

## One-screen summary (for Kemal)

**What the club experiences**

1. You approve their club (as today). Their **free month starts at that moment**. No card
   is asked for.
2. **Day 21:** one WhatsApp DM to the club's **money collector** (or the owner, if no
   collector is set): "the free month ends on 31 Oct, add a card here". The link opens a
   small billing page for that club, signed in, with an **Add a card** button. That opens
   Stripe's own card page. Nothing is charged before day 30.
3. **Day 28 and day 30:** one short reminder each, only if there is still no card.
4. **Day 30 to 37 (grace):** MatchTime keeps working normally. Organisers and admins see
   a banner on the website.
5. **Day 37, still no card:** MatchTime goes **quiet** in that group: no posts, no
   replies, no AI. It stays in the group and keeps all the data. The collector (or owner)
   gets **one** DM explaining how to switch it back on. **Nothing is said in the group.**
6. Card added at any point: £9.99 a month from day 30 (or at once, if they come back after
   a pause). The collector changes the card or cancels on Stripe's own page. A failed
   payment gets Stripe's automatic retries for a week, MatchTime keeps working, then the
   same quiet rule applies.

**Who pays: the money collector.** The person who already collects the match fees adds
the card, because they are the one adding the club fee share to what players pay. With no
collector set, the owner is asked instead, and every card reminder also asks them to
choose a collector. A collector who is a player (not an admin) gets a page for **just the
club's billing**, with no access to the admin pages (section 4.5). Admins see the billing
status on `/admin/settings`.

**When the collector changes:** the Stripe customer belongs to the club, not the person.
The new collector gets one DM asking them to put their own card on at their convenience;
the old card keeps paying until they do. Recommended: the old card is then removed
automatically and its owner told in one DM (decision 5).

**What you control** (on `/admin/clubs`): each club's plan: **Standard £9.99**,
**Free**, or **Custom** (for example £5 for an early supporter). Sutton FC and every
club that existed before self-join are never billed and never paused.

**How the money is kept apart:** the club fee is a normal **Stripe Billing subscription
on MatchTime's own Stripe account**. It never touches Stripe Connect or the collector
accounts that players pay their match fees into. It has **its own webhook endpoint and
its own signing secret**. We never see or store card numbers.

**How the club covers it:** the collector adds a small share to what each player pays for
a game, and pays the £9.99 by card. The day 21 card DM, the admins' notice and the
billing pages carry a **club fee tip** worked out from the club's own game, for example: "your weekly 5-a-side is 10
players and about 4 games a month, so £9.99 works out at about *25p a player per game*.
If your game costs £8 each, charge *£8.25* and the club fee is covered." It works the same
whether players pay by bank transfer, cash or card, and says nothing to players about
cards (section 7.2). MatchTime does not take the share itself (section 14).

**Who gets messaged:** card and payment DMs, with a signed-in link to the billing page, go
**only to the collector** (or the owner when there is none), by the platform DM channel.
The club fee tip also goes to **all the club's admins** through the club's own admin
channel ("Admin messages go to": one person, the admin WhatsApp group, or each admin).
English or Turkish. **No DMs to you.** Billing numbers sit on `/admin/clubs`.

**VAT:** Cressoft is VAT registered and **£9.99 includes VAT** (about £8.33 to
Cressoft, £1.66 VAT). The Stripe price is tax inclusive with a fixed 20% UK VAT rate, and
invoices show Cressoft's legal name, address and VAT number. **UK billing addresses only
at first**, because selling to consumers abroad (Turkey, the EU) brings foreign VAT
registration. After VAT, Stripe and about £3 of AI, a club leaves about **£4.90 a
month** (section 5.4).

**AI cost guard (decided, decision 10):** $2.00 a day in the free month, then $1.50 a
day. When a club hits its cap its admins get one message that day. The global switch
`AI_DAILY_CAP_DISABLED` is being removed from production so the caps apply again.
Later, admins will be able to buy **AI top-ups** (section 9.1).

**Cost to build:** six PRs (B1 to B6). No prompt changes, so **no paid AI test runs**.
Stripe is tested in test mode and with signed fixture events; **live mode is touched only
at rollout, by you, in the dashboard**.

**Switch:** `BILLING_ENABLED`, off by default. Off means nobody is billed or paused, and
any paused club comes straight back. It starts with **new clubs only**.

**Decisions I need from you:** section 15 (eighteen, four of them already decided and
recorded there, each open one with a recommendation).

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

---

## 2. Money separation

- **Club fee:** a Stripe **Customer** and **Subscription** on the **platform account**
  (the account `STRIPE_SECRET_KEY` already points at), **one Customer per club**,
  whoever's card is on it. No `stripeAccount` header, no Connect, no
  `application_fee_amount`. The money is MatchTime revenue, like the 1% platform fee
  already is.
- **Match fees:** unchanged. Direct charges on each collector's connected account, the
  Connect webhook, `applyCheckoutEvent`. Nothing in this plan changes what a player pays
  or what the collector receives (section 14).
- **Two webhooks, two secrets, two routes:**
  - existing `/api/stripe/webhook`, **Connected accounts** scope, `STRIPE_WEBHOOK_SECRET`;
  - new `/api/stripe/billing-webhook`, **Your account** (platform) scope,
    `STRIPE_BILLING_WEBHOOK_SECRET`.
  Stripe signs each endpoint with its own secret, so an event delivered to the wrong
  route fails signature checking and is refused rather than mis-applied.
- **Defence in depth:** billing Checkout sessions never carry `matchId` or `userId`
  metadata (they carry `orgId`, `payerUserId` and `purpose: "club-fee"`), so even a
  misrouted event is ignored by `applyCheckoutEvent`. The billing handler ignores
  anything without `purpose: "club-fee"`. A unit test pins both.
- **Card details:** entered only on Stripe Checkout and changed only in the Stripe
  Customer Portal. We store the customer id, subscription id, status, period end, who
  added the card and, for display, card brand and last four digits. Nothing else.

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

There is **no new "who pays" column.** The person asked to pay is always worked out
from `paymentHolderId` and the memberships at the moment it is needed (section 4.5), so
changing the collector in Settings is the only step.

### 3.2 New `ClubBilling`: the Stripe details, one row per billed club

```prisma
model ClubBilling {
  orgId                    String    @id
  trialStartedAt           DateTime            // = approvedAt at the first approval
  trialEndsAt              DateTime            // trialStartedAt + 30 days. Written ONCE, never reset.
  graceEndsAt              DateTime?           // trialEndsAt + 7d, or paymentFailedAt + 7d
  stripeCustomerId         String?   @unique   // one per club, kept when the collector changes
  stripeSubscriptionId     String?   @unique
  stripeSubscriptionStatus String?             // Stripe's own word: trialing, active, past_due, canceled, unpaid ...
  stripePriceId            String?
  currentPeriodEnd         DateTime?
  cancelAtPeriodEnd        Boolean   @default(false)
  stripePaymentMethodId    String?             // pm_..., the card the subscription charges
  cardBrand                String?
  cardLast4                String?
  cardHolderUserId         String?             // who added the card on file (the collector, or the owner)
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
                         // | "payer-changed" (new collector, 4.5) | "card-replaced" (old card holder, 4.5)
                         // | "fee-tip" (admin channel, 7.2) | "plan-billed" (B3, billed again after Free)
  cycleKey      String   // e.g. trialEndsAt ISO date, or the invoice id; for "payer-changed",
                         // the new collector's user id; for "card-replaced", the old payment method id
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
The collector and the owner are both club members with a phone, so the existing
recipient rule (rule 12: a number MatchTime already knows) passes.

The admin channel's club fee tip does **not** use the platform channel: it goes through
`sendAdminNotice`, like every other message a club's admins get (section 7.1).

---

## 4. States, transitions and who pays

### 4.1 Day numbers

Day 0 is `approvedAt`. `trialEndsAt` = day 30, `graceEndsAt` = day 37 (for a club with
no card). Reminders go out at or after **10:00 London** on their day. "The payer" below is
the billing contact of section 4.5: the collector, or the owner when there is none.

| Day | Instant | Condition | Action |
|---|---|---|---|
| 0 | `approvedAt` | `BILLING_ENABLED`, plan not free, no `ClubBilling` row yet | `trial`; create `ClubBilling` |
| 21 | `trialEndsAt - 9d` | still `trial` | DM "trial-21" to the payer, with the club fee tip; tip to the admin channel (7.2) |
| 28 | `trialEndsAt - 2d` | still `trial` | DM "trial-28" to the payer |
| 30 | `trialEndsAt` | still `trial` | to `grace`; DM "trial-ended" to the payer; banner |
| 37 | `graceEndsAt` | still `grace` | to `paused` (no-card); DM "paused" to the payer |

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
| `subscribed` | the payer cancels in the Portal | `subscribed`, `cancelAtPeriodEnd` | card shows "Ends on {date}"; no DM |
| `subscribed` | period ends after a cancel (`customer.subscription.deleted`) | `paused` (cancelled) | DM "paused" |
| `paused` | card added, first invoice paid | `subscribed` | **resume** (4.4); DM "resumed" |
| any but `exempt` | collector changed in Settings | unchanged | DM "payer-changed" to the new collector (4.5) |
| `subscribed`, `past_due` | new collector's card saved | unchanged (`past_due` retries the open invoice on the new card) | old card removed; DM "card-replaced" to its holder (4.5) |
| `trial`, `grace`, `subscribed`, `past_due` | MatchTime removed from the group (slice B5) | `paused` (removed) | Stripe sub set to cancel at period end; **no DM** |
| `paused` (removed) | MatchTime re-added to the same group before `trialEndsAt` | `trial` | resume (4.4) |
| any | Kemal sets plan Free | `exempt` | cancel the Stripe sub at once; resume if paused |
| `exempt`, plan was Free, free month already had | Kemal sets Standard or Custom (or presses Standard again) | `trial` while the original `trialEndsAt` is still ahead (its end kept, never reset); else `grace` with a **fresh 7 days from now** | grace only: one DM "plan-billed" to the billing contact asking for a card (B3). Never trialled: stays `exempt`, "Start free month" is its way in. Flag off: nothing |
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
  `openClubPortal`, `removeMyCard`), never trusting that the page was shown.
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

**When the collector changes.** The Stripe Customer, the subscription and the price stay
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
   the webhook sets the new payment method as the subscription's and the Customer's
   default (`subscriptions.update({ default_payment_method })`, `customers.update({
   invoice_settings.default_payment_method, email, name })`), so receipts go to the new
   collector, then updates `cardHolderUserId`, `stripePaymentMethodId`, brand, last four
   and the VAT country check. A `past_due` invoice is retried on the new card at once
   (`invoices.pay`).
   Setup mode rather than the Customer Portal, because the Portal would show the new
   collector the old collector's card and invoice history (with the old billing
   address), and lets them cancel before they have a card of their own on.
5. **The old card: recommend removing it automatically** (decision 5) once the new one
   is the default: `paymentMethods.detach(oldPm)`, then one DM "card-replaced" to the old
   card holder: "{newName} now pays the MatchTime fee for {club}; your card has been
   removed and won't be charged again." Why: after the change the old collector can no
   longer manage the subscription, and leaving a card they cannot see on a club they no
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

The **Customer Portal** (change card, cancel, invoices) is opened only for the contact
when they are also the card holder. Its invoice history is switched **off** (5.1):
invoices carry the billing address of whoever paid, so a later collector should not see
an earlier collector's home address. Each payer gets every receipt and invoice by email
from Stripe instead, at the address on the Customer, which follows the current card.

**Admins** keep the billing card on `/admin/settings` (8.1) and the banner (8.2): status,
who pays, next payment, and a link to `/billing/<orgId>` (which opens read-only for an
admin who is not the contact). The money stays visible to the people running the club,
while only the person paying can touch the card.

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
- **Customer Portal** configuration: update payment method, cancel **at period end**;
  **invoice history off** (4.5); no plan switching, no quantity changes. The return URL
  is passed per session (`/billing/<orgId>`).
- **Smart Retries** on, "retry up to 4 times within 1 week", then **cancel the
  subscription**. That makes Stripe's retry window equal our 7-day payment grace.
- **Customer emails:** receipts, invoices and failed-payment emails on (Checkout collects
  an email, so this is a free second channel besides the DM, and is where each payer
  gets their invoices).
- **Webhook** (platform scope, "Your account") to `https://matchtime.ai/api/stripe/billing-webhook`
  with the events in 5.3. Its secret goes in `STRIPE_BILLING_WEBHOOK_SECRET`.

### 5.2 Calls (all in a new `src/lib/stripe-billing.ts`, beside `stripe.ts`, same client)

All four actions sit behind `requireClubBillingAccess` (4.5).

**Add a card** (`startClubCheckout(orgId, userId)`), for the billing contact when the
club has no subscription:

- find or create the Customer: `customers.create({ name: club name, metadata: { orgId } })`,
  store `stripeCustomerId`;
- `checkout.sessions.create({ mode: "subscription", customer, client_reference_id: orgId,
  line_items: [{ price, quantity: 1 }], metadata: { orgId, payerUserId, purpose:
  "club-fee" }, subscription_data: { metadata: { orgId, purpose: "club-fee" },
  trial_end? }, success_url: /billing/<orgId>?done=1, cancel_url: /billing/<orgId> })`;
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

**Use my card instead** (`startCardReplace(orgId, userId)`), for the billing contact when
the club has a subscription and the card on file is someone else's: Checkout
`mode: "setup"` on the same Customer, as in 4.5 point 4.

**Change card or cancel** (`openClubPortal(orgId)`), for the contact who is also the card
holder: `billingPortal.sessions.create({ customer, return_url: /billing/<orgId> })`, then
redirect.

**Remove my card** (`removeMyCard(orgId)`), for the card holder who is no longer the
contact: `paymentMethods.detach`, as in 4.5 point 6.

The DM links point at **our** page, not at Stripe: a Checkout session expires within 24
hours, so a fresh session is created at the moment of the tap.

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
| `checkout.session.completed` (mode subscription) | store subscription id, payment method, card brand and last four, `cardHolderUserId` from `metadata.payerUserId`; `trial` or `grace` or `paused` to `subscribed`; DM "card-added" (or "resumed") |
| `checkout.session.completed` (mode setup, `action: "replace-card"`) | make the new card the default (4.5 point 4); retry an open invoice; detach the old card and DM "card-replaced" (4.5 point 5) |
| `customer.subscription.created` / `.updated` | sync status, `currentPeriodEnd`, `cancelAtPeriodEnd`, price, default payment method; `past_due` or `unpaid` drive 4.2 |
| `customer.subscription.deleted` | `paused`, reason `cancelled` if `cancelAtPeriodEnd` was set, else `payment-failed` |
| `invoice.paid` | clear failure fields; `past_due` or `paused` to `subscribed` |
| `invoice.payment_failed` | first failure of that invoice: `past_due`, DM "payment-failed" |
| `invoice.payment_action_required` | card needs a bank check (3DS): DM "payment-failed" with the invoice's hosted link instead of the billing page |
| `payment_method.detached` | if it was the card on file, clear the card fields (covers a removal made in the Portal or the Stripe dashboard) |
| anything else | 200, recorded, ignored |

A handler error returns 500 so Stripe retries; the `BillingEvent` row records the error
and is retried cleanly because `processedAt` is still null.

### 5.4 VAT (Kemal, 2026-10-01: Cressoft is VAT registered, £9.99 includes VAT)

**The numbers.** At the UK standard rate of 20%, a VAT-inclusive £9.99 is £9.99 / 1.2 =
£8.325 net. Stripe rounds per invoice, so the split shows as **about £8.33 net plus
£1.66 VAT** (it may print as £8.32 plus £1.67; either way the customer pays exactly
£9.99). A Custom £5.00 is £4.17 net plus £0.83 VAT.

**Who the customers are.** Mostly individual collectors or organisers paying out of their
own pocket and recovering it through the match fee (B2C), living in the UK: every club
plays in London, and `src/lib/london-time.ts` is hardcoded to Europe/London. A club or
company that wants a VAT invoice in its own name can add its VAT number at Checkout
(`tax_id_collection`); nothing else changes, because a UK business customer is charged
UK VAT the same way.

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
it with a receipt to the address on the Customer (the current payer's, 4.5). Set once in
the Stripe dashboard (Settings, Business details, and Invoice settings): Cressoft's
**legal name, registered address and VAT number**, with the VAT number added as the
account's tax ID so it prints on every invoice, plus a footer such as "MatchTime is a
service of {legal name}". With the Tax Rate applied, each invoice shows the net amount,
"VAT (20%, inclusive)" and the total. That covers what a full UK VAT invoice needs; for
consumers a simplified invoice would already do. (I have not seen what the live dashboard
has today; rollout step 3 checks it.)

**Organisers outside the UK (for example Turkey). Recommend UK only at first.**

- For an electronic service sold to a **consumer**, VAT is due where the customer lives,
  and a UK seller gets **no threshold** abroad:
  - **EU consumers:** EU VAT from the first sale, normally through the non-Union OSS
    scheme;
  - **Turkey:** foreign providers of electronic services to Turkish consumers must
    register for Turkish VAT (a simplified registration; 20% at present) and file there.

  That is real admin for £9.99 a month. This is the general rule as I understand it; your
  accountant should confirm it for Cressoft before anything is sold outside the UK.
- **How "UK only" is enforced:** Checkout requires a billing address, in both the
  subscription and the replace-card sessions. On `checkout.session.completed` the webhook
  reads the billing address country and the card's issuing country. Both GB: normal.
  Either one not GB: the subscription is kept (refusing after the card is taken would be
  worse), `vatCountryCheck` is set, the club shows **"Check VAT country"** on
  `/admin/clubs`, and you decide: keep it (someone living in London with a Turkish card
  is still a UK customer when the address and other evidence say UK), make the club
  Free, or cancel and refund. HMRC expects two non-conflicting pieces of evidence of
  where a consumer lives; the address and the card country are those two.
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
| A club that hits the $1.50 a day AI cap every day (about £33 a month), caps switched on | about minus £25 |
| The same club with the caps switched off as today ($50 a day ceiling, over £1,000 a month at worst) | unbounded in practice |

Stripe's rates above are their standard UK list prices as I understand them, not read
from Cressoft's account; the Billing fee in particular depends on the account's plan. A
Custom £5.00 plan nets £4.17, about £3.66 after Stripe fees, so it roughly breaks even at
£3 of AI. The last two rows are why the caps are switched back on before launch
(section 9, decision 10).

---

## 6. The scheduler

A new cron, **`/api/cron/billing`, hourly** (`0 * * * *` in `vercel.json`), behind
`CRON_SECRET` like the others. With `BILLING_ENABLED` off it returns at once.

Each run loads clubs in `trial`, `grace` or `past_due` and, for each, asks the pure
`billingDue(club, now)` which of these is due:

| Kind | Due when | Also |
|---|---|---|
| `trial-21` | now at or after day 21 at 10:00 London, still `trial` | skipped if `trial-28` is already due (a late cron never sends two in a row); also queues the admin channel tip (`fee-tip`), which is **not** skipped with it: if day 21 was missed, the tip goes with day 28, and the day 28 DM then carries the tip too |
| `trial-28` | day 28 at 10:00 London, still `trial` | |
| `trial-ended` | at or after `trialEndsAt`, still `trial` | moves to `grace` first; the DM waits for 10:00 if it is night |
| `paused` | at or after `graceEndsAt`, still `grace` or `past_due` | moves to `paused`; the DM waits for 10:00 |

The state change happens on time; only the DM waits for daytime (10:00 to 20:00 London),
using `sendAfter` on the `PlatformJob`. Every DM is claimed first in `BillingNotice`
(`orgId, kind, cycleKey`), then the recipient is resolved (`billingContact`, 4.5) and the
DM queued with `queuePlatformDm({ purpose: "billing" })`; the admin tip is claimed the
same way and queued with `sendAdminNotice` (section 7.2). Hourly runs make a missed run
harmless.

Why a Vercel cron and not the Pi scheduler: the Pi scheduler is per group and is exactly
what stops polling for a paused club, and the day-37 DM must go out after the pause.
The platform channel is the one sender that works whatever a club's switches say.

---

## 7. Messages: who gets what, the club fee tip, and the copy (English and Turkish)

### 7.1 Who gets which message

| Message | Recipient | Channel | Why |
|---|---|---|---|
| "You're live" (`sj_dm_approved`), with a short tip | the organiser who asked to join | platform DM (`organiser-decision`, as today in `club-approval.ts` ~509) | It is the first message after approval; no collector is set yet for a new club. |
| Day 21 (with the tip), 28, 30, paused, card added, payment failed, resumed | the **billing contact**: the money collector, else the OWNER (4.5) | platform DM (`purpose: "billing"`) | Each carries the contact's own **signed-in link to `/billing/<orgId>`**. A personal sign-in link must never be posted in a group. |
| "Set a money collector" nudge | the OWNER, inside the day 21, 28 and 30 DMs, only when no collector is set | same DMs | The collector is who should pay; the owner is the fallback, not the plan. |
| "Payer changed" | the new collector, once | platform DM (`purpose: "billing"`) | They now look after the card (4.5). |
| "Card replaced" | the old card holder, once | platform DM (`purpose: "billing"`) | Their card was removed (4.5 point 5). |
| Club fee tip, day 21 (sent once per free month) | **all admins**, through the admin channel | `sendAdminNotice` (`BotJob`s, next `due-posts` poll) | So every admin knows how the fee is covered, whoever runs the money. |
| Billing status card on `/admin/settings` | every OWNER and ADMIN who opens Settings | web | Always there to look up. |
| Billing page `/billing/<orgId>` | the contact (buttons), an old card holder (remove only), admins (read-only) | web | 4.5. |

The day 21 DM carries the club fee tip itself, so the person who sets the match fee and
pays the card hears it once, from the message that asks them for the card. The admin
channel tip is **skipped** when the admin channel would reach only the contact (mode
"one person" resolving to them, checked with `resolveAdminNoticeTargets` before sending),
so the common new-club case (no collector, owner is the one person) gets one message,
not two. In "each admin" or "admin group" mode a contact who is also an admin may read
the tip twice, once in the card DM and once from the admin channel; accepted (decision
17).

Because the admin tip goes through `due-posts`, a muted club (`whatsappBotEnabled` off)
gets it when unmuted, like every other admin notice, and a paused club does not get it at
all (a paused club has no `due-posts` poll; the tip is not useful then anyway). Day 21 is
always in the free month, when the club is serving. The billing DMs use the platform
channel and go out whatever the club's switches say.

### 7.2 The club fee tip

This is how a club covers the fee: **the collector adds a small share to what each player
pays for a game, and pays the £9.99 by card.** It works for bank transfer, cash and card
alike, because it only changes the amount the collector asks for. No message to players
mentions cards or the club fee; players just see the match fee.

**The numbers, per club** (a pure `clubFeeTip(input)` in `club-billing-rules.ts`, no
database):

- **Price:** £9.99, or the Custom price (`billingPricePence`). No tip for Free or
  `exempt` clubs (nothing to cover).
- **Players per game** = 2 x `Sport.playersPerTeam` of the club's weekly activity (a
  5-a-side is 10, a 7-a-side 14, an 8-a-side 16, a 9-a-side 18).
- **Games per month** = 4 x the number of the club's distinct weekly game slots (active
  `Activity` rows, one per weekday and time; a format-switch pair on the same evening
  counts once, as `generate-matches` already dedupes by kickoff within 90 minutes,
  `match-slot.ts`). One weekly game is 4; no active activity also reads as 4. Recommend
  counting every month as four weeks rather than counting the real calendar (a month has
  4.33 weeks on average), so the share is stable month to month and a cancelled week does
  not leave a gap (decision 16).
- **Share per player per game** = price / (sum of players over the month's games),
  **rounded up to the next 5p** (decision 15). With one weekly game that is price /
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

**Where it appears:**

1. **The day 21 DM to the billing contact** (7.3), as its second paragraph. If day 21 was
   missed, in the day 28 DM instead.
2. **The "payer changed" DM** to a new collector (7.3), so a collector named after day 21
   still hears it.
3. **The admin channel**, once per free month (`sendClubFeeTip(orgId, now)` in
   `club-billing.ts`): claim `BillingNotice(orgId, "fee-tip", trialEndsAt)`; skip if the
   admin channel would reach only the contact (7.1); otherwise
   `sendAdminNotice({ orgId, text, nextPath: null })`. With no collector set, the admin
   text gains one line asking them to set one in Settings (the link is the reader's own
   signed-in link by DM, the plain URL in the admin group, as `sendAdminNotice` already
   does).
4. **The billing page and the settings billing card** (8.1), worked out at page load.
5. **The "you're live" DM** (`sj_dm_approved`), one short paragraph.

**Copy.** `{format}` is `sj_per_side_option` ("5-a-side"; in Turkish "5'e 5", "7'ye 7" through
the existing `perSideTr`). `{share}` is pence written "25p" in both languages (the clubs
are in London and play in pounds); a share of £1 or more is written "£1.05". `{fee}` and
`{feePlus}` through `gbp()` in `payments.ts`.

**The tip paragraph** (used in the day 21, day 28 fallback and "payer changed" DMs, and
the admin channel)

> EN: 💷 *Club fee tip:* your weekly {format} is {players} players and about {games} games a month, so {price} works out at about *{share} a player per game*. If your game costs {fee} each, charge *{feePlus}* and the club fee is covered.

> TR: 💷 *Kulüp ücreti ipucu:* haftalık {format} maçınız {players} oyunculu ve ayda yaklaşık {games} maç oynanıyor, yani {price} oyuncu başına maç başına yaklaşık *{share}* ediyor. Maç ücreti kişi başı {fee} ise *{feePlus}* alın, kulüp ücreti karşılanmış olur.

When the club's own fee is known, the last sentence reads "Your game is {fee} each, so
charging *{feePlus}* covers it." / "Maç ücretiniz kişi başı {fee}, *{feePlus}* alırsanız
karşılanır." When the pitch cost is split (`feeSplitTotal`): "When you split the pitch
cost, add about {share} to each player's share." / "Saha ücretini bölüştürürken her
oyuncunun payına yaklaşık {share} ekleyin."

The wording talks about what to **charge**, never how players pay, so it reads right for a
club where everyone transfers to the collector's bank account.

**Admin channel, no collector set, one extra line:**

> EN: Nobody is set as the money collector yet. Choose one in Settings: they'll look after the card for the club fee and get this tip too. {link}

> TR: Henüz para toplayan kişi seçilmedi. Ayarlar'dan birini seçin: kulüp ücreti için kartla o ilgilenecek ve bu ipucunu o da alacak. {link}

**"You're live" DM** (`sj_dm_approved`): one short paragraph **after** "Your first month
is free.", only when the club is billed (`BILLING_ENABLED` on and the plan is not Free).
With billing off the DM is exactly today's.

> EN: 💷 *Club fee tip:* after that it's {price} a month for the group, paid by card by whoever collects the match fees. With {players} players and about {games} games a month, that's about *{share} a player per game*, so a {fee} game could be charged at *{feePlus}*.

> TR: 💷 *Kulüp ücreti ipucu:* sonrasında grup için aylık {price}, maç ücretlerini toplayan kişi kartla öder. {players} oyuncu ve ayda yaklaşık {games} maçla bu, oyuncu başına maç başına yaklaşık *{share}* ediyor; {fee} olan bir maç için *{feePlus}* alabilirsiniz.

This breaks two pins in `self-join-copy.test.ts` (~100): the DM must **end with** "Your
first month is free." and contain **no amount**. Both stay true for the no-tip DM; the
slice adds a billed variant whose test pins that the tip follows the free-month sentence,
carries exactly the tip's amounts, and has no dash. The doc comment on `sj_dm_approved`
("never an amount") and the R185 copy-golden entries are updated with it.

**The website is unchanged.** The landing and help pages keep "With 20 players, that works
out at about 50p a player" (a month, one game a month each, no match fee). The tip is the
per game version of the same sum (25p x 4 games x 10 players is £10), and the public copy
test forbids "25p" on the landing page, which stays right because the tip is never on a
public page. The pin against claiming MatchTime collects the club fee stays as it is:
MatchTime does not (section 14).

### 7.3 Billing DM copy (to the billing contact)

All strings go into `src/lib/i18n/strings.en.ts` and `strings.tr.ts` (the parity test
covers them). `{price}` is "£9.99" or the custom price. Dates through
`src/lib/i18n/dates.ts` ("Fri 31 Oct" and "31 Eki Cum"). `{link}` is the contact's own
`buildAdminLink` to `/billing/<orgId>` (4.5). `{name}` is the recipient's name.

**"Set a money collector" line**, appended to the day 21, 28 and 30 DMs only when the
recipient is the owner because no collector is set:

> EN: Tip: if someone else collects the match fees, make them the money collector in Settings and they'll look after the card instead.

> TR: İpucu: maç ücretlerini başka biri topluyorsa, Ayarlar'dan onu para toplayan kişi yapın, kartla o ilgilensin.

**Day 21** (then the tip paragraph of 7.2)

> EN: Hi {name}, {club}'s free month on MatchTime ends on {date}. As the person who collects the match fees, you're the one I'll ask for the card. To keep MatchTime running in "{group}", add one here: {link}
> It's {price} a month for the whole group, and nothing is taken before {date}.

> TR: Merhaba {name}, {club} için MatchTime'daki ücretsiz ay {date} tarihinde bitiyor. Maç ücretlerini siz topladığınız için kartı sizden istiyorum. MatchTime'ın "{group}" grubunda çalışmaya devam etmesi için buradan ekleyin: {link}
> Tüm grup için aylık {price}. {date} tarihinden önce hiçbir ücret alınmaz.

When the recipient is the owner because no collector is set, the second sentence ("As the
person who collects ...") is left out and the "set a money collector" line is added.

**Day 28**

> EN: Hi {name}, a quick reminder: {club}'s free month ends on {date}. Add a card to keep MatchTime running in "{group}": {link}

> TR: Merhaba {name}, kısa bir hatırlatma: {club} için ücretsiz ay {date} tarihinde bitiyor. MatchTime'ın "{group}" grubunda çalışmaya devam etmesi için kart ekleyin: {link}

**Day 30 (trial ended, grace starts)**

> EN: Hi {name}, {club}'s free month has ended. MatchTime will keep running in "{group}" for one more week, until {graceDate}. Add a card any time before then: {link}

> TR: Merhaba {name}, {club} için ücretsiz ay sona erdi. MatchTime "{group}" grubunda bir hafta daha, {graceDate} tarihine kadar çalışmaya devam edecek. O tarihe kadar istediğiniz zaman kart ekleyebilirsiniz: {link}

**Paused (day 37, or payment not recovered, or cancelled)** (first line varies by reason)

> EN (no card): Hi {name}, MatchTime is now paused for {club}.
> EN (payment): Hi {name}, we couldn't take the {price} for {club}, so MatchTime is now paused.
> EN (cancelled): Hi {name}, the MatchTime plan for {club} has ended, so MatchTime is now paused.
> EN (all): I'm still in "{group}", but I won't post or reply there, and nothing has been said in the group. The players, matches and stats are all kept. To switch MatchTime back on, add a card here and it restarts within a few minutes: {link}

> TR (kart yok): Merhaba {name}, MatchTime {club} için şu an duraklatıldı.
> TR (ödeme): Merhaba {name}, {club} için {price} ödemesini alamadık, bu yüzden MatchTime şu an duraklatıldı.
> TR (iptal): Merhaba {name}, {club} için MatchTime planı sona erdi, bu yüzden MatchTime şu an duraklatıldı.
> TR (hepsi): Hâlâ "{group}" grubundayım ama orada mesaj atmayacağım ya da yanıt vermeyeceğim, gruba da hiçbir şey söylenmedi. Oyuncular, maçlar ve istatistikler saklanıyor. MatchTime'ı yeniden açmak için buradan kart ekleyin, birkaç dakika içinde tekrar başlar: {link}

**Card added**

> EN: Thanks {name}, your card is saved. MatchTime keeps running in "{group}". The first {price} is taken on {date}, then monthly, and Stripe emails you each invoice. To change your card or cancel: {link}

> TR: Teşekkürler {name}, kartınız kaydedildi. MatchTime "{group}" grubunda çalışmaya devam ediyor. İlk {price} {date} tarihinde, sonra her ay alınacak; her faturayı Stripe size e-postayla gönderir. Kartınızı değiştirmek ya da iptal etmek için: {link}

**Payment failed**

> EN: Hi {name}, this month's {price} for {club} didn't go through. Stripe will try again over the next few days, and MatchTime keeps running meanwhile. To update the card: {link}

> TR: Merhaba {name}, {club} için bu ayın {price} ödemesi alınamadı. Stripe önümüzdeki birkaç gün içinde tekrar deneyecek, bu sürede MatchTime çalışmaya devam ediyor. Kartı güncellemek için: {link}

When the failing card is not the recipient's (a collector change still in progress), the
last sentence reads "To put your own card on instead: {link}" / "Bunun yerine kendi
kartınızı eklemek için: {link}".

**Resumed**

> EN: MatchTime is back on for {club}. I'll pick things up again in "{group}" within a few minutes. Anyone who said IN while I was paused should say it again.

> TR: MatchTime {club} için yeniden açıldı. Birkaç dakika içinde "{group}" grubunda kaldığım yerden devam ediyorum. Ben duraklatılmışken VARIM yazanlar lütfen tekrar yazsın.

**Payer changed** (to the new collector, once; then the tip paragraph of 7.2)

> EN (card on file): Hi {name}, you're now the money collector for {club}, so you look after MatchTime's {price} a month for "{group}". {oldName}'s card keeps paying until you put yours on, whenever suits you: {link}

> TR (kart var): Merhaba {name}, artık {club} için para toplayan kişi sizsiniz, bu yüzden "{group}" için MatchTime'ın aylık {price} ücretiyle siz ilgileniyorsunuz. Siz kendi kartınızı ekleyene kadar {oldName} kişisinin kartından ödenmeye devam ediyor, size uygun bir zamanda ekleyebilirsiniz: {link}

> EN (no card yet): Hi {name}, you're now the money collector for {club}, so you look after MatchTime's {price} a month for "{group}". Add a card before {date} to keep it running: {link}

> TR (kart yok): Merhaba {name}, artık {club} için para toplayan kişi sizsiniz, bu yüzden "{group}" için MatchTime'ın aylık {price} ücretiyle siz ilgileniyorsunuz. Çalışmaya devam etmesi için {date} tarihinden önce kart ekleyin: {link}

`{date}` is the trial end, the grace end, or the next payment date, by state; in
`paused` the second sentence is "Add a card to switch it back on" / "Yeniden açmak için
kart ekleyin".

**Card replaced** (to the old card holder, once; no link)

> EN: Hi {name}, {newName} now pays the MatchTime fee for {club}. Your card has been removed and won't be charged for it again.

> TR: Merhaba {name}, {club} için MatchTime ücretini artık {newName} ödüyor. Kartınız kaldırıldı ve bunun için bir daha ücret alınmayacak.

House rules checked: no time-of-day greetings, no claims about what other organisers do,
no mention of AI, nothing in the club's own group (the admin tip may go to the separate
admin group, which is the club's own choice), nothing to players about cards or the club
fee, no em or en dashes.

---

## 8. Web

### 8.1 The billing page and the settings card

**`/billing/[orgId]`** (new, `src/app/billing/[orgId]/page.tsx`, outside `/admin`; 4.5).
English or Turkish by the club's language. Shown for any `billingStatus` but `exempt`
(an exempt club redirects to `/`).

| State | What it shows | Buttons (billing contact) |
|---|---|---|
| `trial` | "Free month until {date}. Then {price} a month for the whole group." Club fee tip. | **Add a card** |
| `subscribed`, own card | "{price} a month. Next payment {date}. Card {brand} ending {last4}." or "Ends on {date}" after a cancel | **Change card or cancel** |
| `subscribed`, someone else's card | "{price} a month, paid with {holderName}'s card until you put yours on. Next payment {date}." | **Use my card instead** |
| `grace` | "The free month has ended. MatchTime stops on {date} unless a card is added." | **Add a card** |
| `past_due` | "Last payment didn't go through. Stripe is retrying. MatchTime stops on {date} if it can't be taken." | **Update card** (own card) or **Use my card instead** |
| `paused` | "MatchTime is paused. All the data is kept. Add a card to switch it back on." | **Add a card** |

Every state shows the club fee tip (7.2). An old card holder who is no longer the contact
sees "Your card still pays {club}'s MatchTime fee until {contactName} adds theirs" and
**Remove my card**. An admin who is not the contact sees the status and the tip, no
buttons, and "{contactName} looks after the card".

**`/admin/settings` billing card** (`id="billing"` in `src/app/admin/settings/page.tsx`),
shown only when `billingStatus` is not `exempt` (Sutton FC sees nothing new). For every
OWNER and ADMIN: the state line from the table above, **who pays** ("{collectorName}
looks after the card", or "No money collector set: the owner is asked for the card"),
"card on file" yes or no (brand and last four only to the card holder, on the billing
page), and the club fee tip with the admin channel wording. One link, **Open billing**,
to `/billing/<orgId>`. When no money collector is set, the card adds "Choose a money
collector" pointing at the payments section of the same page.

### 8.2 Banner

In `src/app/admin/layout.tsx`, for OWNER and ADMINs, in `grace`, `past_due` and `paused`
only: one line with the date and a link to `#billing`. No banner in `trial`. A collector
who is a player never sees the admin layout; the DMs and the billing page cover them.

### 8.3 Owner view on `/admin/clubs`

`/admin/clubs` already lists only self-join clubs and is superadmin only. Add:

1. A **Billing** column on "Live clubs that joined themselves": plan, status, trial end
   or next payment, card on file yes or no, and who pays (collector, owner fallback, or
   "no billing contact").
2. Per club controls: **Plan** (Standard £9.99, Free, Custom £x.xx), and **Start free
   month** for a self-join club still `exempt` (one approved before the flag was on).
   Each goes through `setClubPlan()` / `startTrial()` in `club-billing.ts`, superadmin
   checked again in the action.
3. A small totals line: paying clubs, monthly total at current prices, clubs in grace,
   past due and paused. Read from our tables; Stripe's dashboard stays the money record.
4. Each club's AI spend for the last 30 days, next to its price (section 9).

Nothing here DMs anyone.

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

---

## 10. Test plan (free suites only)

**No prompt changes anywhere.** Everything is deterministic code and static copy, so
**no live-LLM suite or dry run is needed or requested.** TDD, red first, per slice.

### 10.1 Unit (vitest)

- `club-billing-rules.ts`: every row of 4.1 and 4.2 as pure `nextBillingState` and
  `billingDue` cases, including a cron that was down for two days (no double reminder),
  quiet-hours `sendAfter`, and the 49-hour Checkout trial rule on days 28, 29 and 30.
- `billingContact`: collector who is a current member with a phone; collector who left
  falls back to the owner; no collector, the owner; no owner with a phone, none.
- `requireClubBillingAccess`: contact, old card holder, admin viewer, superadmin viewer,
  a player who is neither (refused), a former member (refused); every server action
  refuses a viewer.
- `setBillingState`: compare-and-set race (webhook and cron at once, one wins);
  `trialEndsAt` never reset on re-approval; Free implies `exempt`.
- Source guard: only `club-billing.ts` writes `billingStatus`; only it queues
  `purpose: "billing"`.
- Gates: a paused club is absent from `/orgs`, present in `silentGroups`; `due-posts`
  404s; `analyze` ignores with **zero model calls**; each cron skips it;
  `fixtureSkipReason` returns `org-billing-paused`; `aiAllowanceUsd` is 0 with the
  global switch set and with an override; `dm-reply` returns silence for a member of
  only a paused club.
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
- Collector change: `setPaymentHolder` on a billed club DMs the new collector once
  (changing back and forth does not repeat it), on an `exempt` club never; the next
  scheduled DM goes to the new collector; a replace-card setup session sets the new
  default, retries an open invoice, detaches the old card and DMs its holder once;
  **Remove my card** detaches and DMs the contact; `payment_method.detached` from the
  dashboard clears the card fields.
- Resume: stale BotJobs dropped, future reminders kept, matches that passed during the
  pause completed with no post-match flow.
- VAT: the Checkout calls (subscription and setup) always carry a required billing
  address, and the subscription the inclusive Tax Rate and VAT number collection, for
  Standard and Custom prices alike; a completed session with a non-GB billing country or
  card country sets `vatCountryCheck` and keeps the subscription.
- Club fee tip (`clubFeeTip`): every row of the 7.2 table; Custom price; two weekly
  games summed; no activity reads as 4 games; share rounded up to 5p and never below 5p;
  own fee, latest match fee and the £8 fallback; `feeSplitTotal` wording; no tip for Free
  or `exempt`; no card wording in the tip.
- Tip routing: the day 21 DM carries the tip; a missed day 21 puts it in day 28; the
  admin channel tip is skipped when "one person" resolves to the contact and sent
  otherwise; the "no collector" line only when none is set; a second call sends nothing
  (`BillingNotice`).
- `sj_dm_approved`: unchanged with billing off (today's pins, including "ends with the
  free sentence" and "no amount"); with billing on, the tip follows the free sentence in
  both languages.
- i18n: every new string exists in both languages; Turkish dates render.

### 10.2 Playwright (web, free)

Under `MT_TEST_MODE`, `stripe-billing.ts` uses a fake adapter (`BILLING_STRIPE_FAKE=1`)
that returns a local "checkout" URL and records calls; the test then posts signed fixture
events to `/api/stripe/billing-webhook`.

- A **player who is the money collector** opens a billing magic link: lands on
  `/billing/<orgId>` signed in; taps **Add a card**, lands on the fake checkout; the
  test posts `checkout.session.completed`; the page shows "Next payment". The same user
  gets redirected away from `/admin/settings`.
- Collector change: a second player is made collector; their page shows "paid with
  {name}'s card" and **Use my card instead**; after a setup fixture event the page shows
  their card, and the first player's page access shows nothing to manage.
- An admin who is not the contact sees status, who pays and the tip on
  `/admin/settings#billing`, and a read-only billing page (a 7-a-side test club with a £7
  fee shows 20p and £7.20).
- Exempt club: no settings card; `/billing/<orgId>` redirects.
- Grace and paused: banner appears; `/api/whatsapp/orgs` (with `WHATSAPP_API_KEY`) drops
  the group and lists it in `silentGroups`; after a fixture `invoice.paid` it is back.
- `/admin/clubs`: superadmin sets Free, Custom £5 and Standard; "Start free month";
  non-superadmin gets 404.
- Cron: hitting `/api/cron/billing` with `x-test-now` at days 21, 28, 30 and 37 queues
  exactly one `PlatformJob` each, to the collector (or the owner when none), in the
  club's language, and moves the state.
- Group simulator (`e2e/sim`, stubbed model): a paused group produces zero outbound
  messages and zero model calls.

### 10.3 Manual, Stripe **test mode** only (before rollout)

On a Preview deployment with `sk_test` keys: real Checkout with card `4242 4242 4242
4242`, a 3DS test card, a declining card (`4000 0000 0000 0341`), a card replacement in
setup mode followed by a renewal (the new card is charged, the old one is detached), and
a **Stripe test clock** to run a subscription through trial end, renewal, failure and
Smart Retries to cancel in minutes. Open one test invoice PDF and check the legal name,
address, VAT number and the "VAT (20%, inclusive)" line, check the Portal shows no invoice
history, and try a Turkish billing address to see the flag. This is the only place real
Stripe Billing behaviour is exercised before live.

---

## 11. Rollout

1. **Flag** `BILLING_ENABLED`, off by default. Slices B1 to B5 ship dark. With it off:
   no trials start, the cron does nothing, every gate ignores `paused`, the settings card
   and the billing page are hidden. The webhook still records and syncs events if any
   arrive.
2. **Test mode first:** product, price, Portal, Smart Retries and webhook created in
   **test mode**, test env vars on Preview, 10.3 run end to end.
3. **Live config, by Kemal in the Stripe dashboard** (no live keys through chat): live
   product and tax-inclusive price, the 20% inclusive Tax Rate, business details and
   VAT number on invoices, Portal (invoice history off), Smart Retries, customer emails,
   the platform-scoped billing webhook, and **delete the old platform-scoped
   `we_1TgQL6...` endpoint** if it still exists (section 2). Then Vercel prod env:
   `STRIPE_BILLING_WEBHOOK_SECRET`, `STRIPE_CLUB_PRICE_ID`, `STRIPE_CLUB_PRODUCT_ID`,
   `STRIPE_CLUB_TAX_RATE_ID`.
4. **AI caps back on** (decision 10, decided): remove `AI_DAILY_CAP_DISABLED` from
   Vercel production and redeploy, before step 5. Planned right after the AI cap PR
   merges.
5. **Switch on for new clubs only.** `BILLING_ENABLED=1`. Every existing club stays
   `exempt`. Clubs approved from that moment get a trial. Self-join clubs approved
   before it are Kemal's call per club ("Start free month", decision 2).
6. **First real club:** watch `/admin/clubs` through their day 21, including who the DM
   went to.
7. **Copy:** the help page (`src/app/help/admin/page.tsx`) gains one paragraph on the
   money collector looking after the card, the card reminder, grace week and pause; the
   landing page needs no change.

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
| `AI_DAILY_CAP_DISABLED` | existing, production | emergency override only; being removed from production after the AI cap PR (decision 10) |
| `STRIPE_AI_TOPUP_PRICE_ID` | Vercel, slice T1 only | `price_...`, the £5 top-up, tax inclusive (9.1) |
| `BILLING_STRIPE_FAKE` | test only | `1` under `MT_TEST_MODE` for Playwright |

Added to `.env.example` with comments. Trial length (30), grace (7), reminder days
(21, 28) and the billing link TTL (9 days) are constants in `club-billing-rules.ts`, not
env.

---

## 13. Slices (one PR each)

| # | PR | Depends on | Main files |
|---|---|---|---|
| B1 | **Schema, rules and the quiet gate.** Columns, `ClubBilling`, `BillingEvent`, `BillingNotice`, CHECK constraints, `club-billing-rules.ts` (including `billingContact`), `setBillingState`, `SERVING_CLUB_WHERE`, `isClubOperational` and every gate in 4.3, AI allowance $0 when paused, `fixtureSkipReason`, `dm-reply` rail, kill switch, `resumeClub`. No visible change (every club `exempt`). | none | `prisma/`, `club-approval-state.ts`, `club-billing*.ts`, `orgs`, `due-posts`, `analyze` (org lookups only), crons, `ai-budget.ts`, `org-lifecycle.ts`, `dm-reply` |
| B2 | **Trial, pages and the club fee tip.** Trial at approval (`decideClub` approve, flag on), `/admin/clubs` billing column and AI spend, plan control, "Start free month", the billing page `/billing/[orgId]` with `requireClubBillingAccess` (read-only states), the settings card, banner, `clubFeeTip`, the tip paragraph in `sj_dm_approved`, i18n. | B1 | `club-approval.ts` (one call), `club-billing*.ts`, `src/app/billing/[orgId]`, `/admin/clubs`, `/admin/settings`, `admin/layout.tsx`, `i18n`, `self-join-copy.test.ts`. **Plan Free (from B1 review):** `setClubPlan` must set `billingStatus = "exempt"` FIRST, then `billingPlan = "free"`, in ONE transaction (through `setBillingState`'s `plan-free` event and the same locked transaction), because the CHECK `Organisation_billingFreeExempt_check` refuses a Free plan on a club that is not exempt. Leaving Free goes the other way round: plan first, then any status change. |
| B3 | **Stripe.** `stripe-billing.ts`, Add a card (Checkout, with the inclusive Tax Rate, billing address, VAT number collection and the UK check), Use my card instead (setup mode), Change card or cancel (Portal), Remove my card, billing webhook, sync, "card-added" and "card-replaced" DMs, plan changes on live subscriptions, fake adapter. **As built (2026-10-01):** `stripe-billing.ts` (pure Checkout builders, the real adapter, `getBillingStripe`), `stripe-billing-fake.ts` (tests only: `MT_TEST_MODE=1` and `BILLING_STRIPE_FAKE=1`, refused with a live key), `club-billing-stripe.ts` (the four actions, `processBillingWebhook` with `BillingEvent` idempotency, sync from a FRESH subscription read, `syncPlanToStripe`, `notifyPlanBilledAgain`), `app/actions/club-billing.ts` (each action re-checks `requireClubBillingAccess`), `queueBillingDm` in `club-billing.ts` (claim `BillingNotice` first; the only queuer of purpose `"billing"`). Also: only one Add a card session may be open per club (open ones are expired first), a second live subscription for a club is cancelled at once by the webhook, the B2 gap (Free and back) has the defined path in 4.2, and a "resumed" DM goes to the contact when a recovered payment brings a paused club back. Left for B4: the payment-failed and 3DS DMs, and any DM on Remove my card (the contact already had "payer-changed"). | B1, B2 | `stripe-billing.ts`, `api/stripe/billing-webhook`, billing page actions |
| B4 | **Scheduler and messages.** `/api/cron/billing`, day 21, 28, 30, 37, payment-failure grace, `purpose: "billing"`, `BillingNotice`, all DM copy EN and TR to the billing contact with `/billing` links, the "set a money collector" line, `sendClubFeeTip` (admin channel, with the one-person skip), the "payer changed" DM from `setPaymentHolder`. | B2, B3 | `api/cron/billing`, `vercel.json`, `platform-jobs.ts` (purpose), `actions/payments.ts` (one call), `i18n` |
| B5 | **Removal from a live group.** Pi forwards self-removal for monitored groups too (`handleGroupLeaveForSelfRemoval`), server sets `paused (removed)` and cancels at period end for billed clubs only; **exempt clubs (Sutton) only log**. Re-add during the trial resumes it. Pi deployed with `scripts/deploy-pi.sh`, away from match time. | B3 | `whatsapp-bot/src/bot-added.ts`, `api/whatsapp/bot-removed`, `club-billing.ts` |
| B6 | **Go-live.** Help page paragraph, `.env.example`, runbook in this file. Then rollout steps 2 to 7. | B1 to B5 | `help/admin/page.tsx` |

| T1 | **AI top-ups (planned, after B6).** Credit balance and `AiTopUp`, credit spent after the daily cap in `ai-budget.ts`, Buy more page and Checkout, webhook credit and refund, the Buy more link in the cap notice (9.1). | B3 | `ai-budget.ts`, `ai-cap-notice.ts`, `stripe-billing.ts`, billing webhook, `src/app/billing/[orgId]/ai`, `prisma/`, `i18n` |

B3 and the UI half of B2 can run in parallel after B1 if their files are split as above.
B1 touches `analyze/route.ts` only at the two org lookups.

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
