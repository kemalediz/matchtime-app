# MatchTime — Session Handoff (2026-06-09 → 10): Payments go-live + `@lid` DM fix

> Day-of-match session. Goal evolved from "test payments" to **taking Sutton
> FC's match fees live for real money tonight**, then fixing two blocking
> infrastructure bugs discovered along the way (Stripe Connect webhook scope,
> and WhatsApp `@lid` DM resolution). Everything below is shipped + verified
> in production unless explicitly noted. Previous handoffs: `MDs/SESSION-HANDOFF-2026-05-20.md`.

---

## TL;DR — what changed

- **Payments are LIVE on Sutton FC** (`Sutton Football Club`, slug `sutton-fc`). Real
  money, Stripe **live** mode, direct charges on the collector's connected account.
- **Pay by Bank hidden** from the player menu (unreliable on connected accounts) —
  one-line revert when wanted. Card / Apple Pay / Google Pay + "pay directly" remain.
- **Money-collector picker** added to Settings → Payments (was script-only before).
- **Stripe Connect webhook was misconfigured** (scoped to the *platform* account, 0
  deliveries) → created a **Connected-accounts**-scoped destination; card payments now
  auto-mark paid.
- **WhatsApp migrated 1:1 DMs to `@lid` privacy JIDs** → the bot forwarded an empty
  phone → server dropped every DM as "unknown sender". Fixed bot-side (recover real
  number from the contact) + a collector-name server fallback.
- **Collector excluded** from pay-link DMs / chaser / collect roster (they collect, they
  don't pay): a 14-player squad → **13** links.
- Full chain proven end-to-end live: `@lid` fee DM → confirm → 13 links → card
  auto-marks via webhook.

---

## The money flow (how it works now)

Per-org **money collector** (`Organisation.paymentHolderId`) has their own Stripe
**Express connected account** (`stripeConnectAccountId`). Charges are **direct charges
on that connected account** (`{ stripeAccount }`), so funds settle to the collector;
MatchTime skims a **1% platform fee** via `application_fee_amount`. MatchTime never holds
the money.

**Post-match sequence** (`src/lib/bot-scheduler.ts` §6a-bis/ter, `src/lib/payment-flow.ts`):

1. Match ends → bot DMs the **collector**: "how much per player? (N played)".
2. Collector replies an amount → `handleCollectorFeeReply` sets `feePendingConfirm`,
   DMs back a confirm prompt ("£X per player, N to charge — reply ✅").
3. Collector replies ✅/yes → `releaseMatchPayments` sets `feePerPlayer`, stamps
   `paymentLinksReleasedAt`, and DMs **each confirmed player except the collector** a
   short pay link to `/pay/<matchId>`.
4. Player taps → **Card / Apple Pay / Google Pay** (Stripe Checkout, auto-marks paid via
   webhook) or **Pay the collector directly** (records intent, DMs collector to confirm).
5. Daily chaser (18:00 London, ≤10 days): re-sends links to unpaid card players; nudges
   the collector once/day for direct-pending. Collector never chased.

**Pricing (`src/lib/payments.ts`) — fixed-rate gross-up, UK card pricing:**
- `PLATFORM_FEE_RATE = 0.01` (1% of base). Card Stripe fee assumed **1.5% + 20p**.
- `totalForMethod`: `G = (base·qty + 0.20 + platform) / (1 − 0.015)`, **ceil to penny**
  (residual favours collector). Collector nets exactly base on UK cards.
- **Caveat (accepted, left as-is):** non-UK/international cards cost Stripe more
  (~2.5–3.25%), so the collector under-recovers a few pence on those. Fine for a UK group.
- Calculated **dynamically** on the pay page (server `priceMethods` + client
  `totalForMethod` re-grosses per "paying for N").
- `platformFeePence` = 1% of base×qty → `application_fee_amount`.

---

## Two infrastructure bugs found + fixed (the important part)

### 1. Stripe Connect webhook scoped to the wrong account (card payments never auto-marked)

- **Symptom:** card test "worked" (charge succeeded) but the attendance never flipped to
  paid via the live webhook.
- **Root cause:** the only live webhook endpoint (`we_1TgQL6…`, "MatchTime production")
  was scoped to **"Your account"** (platform). But MatchTime uses **direct charges on the
  connected account**, so `checkout.session.completed` fires on the **connected account**
  and never reaches a platform-scoped endpoint. Dashboard showed **0 deliveries all week**.
  Stripe locks the account-vs-connected scope at creation — it's not editable.
- **Fix:** created a second destination **scoped to Connected accounts**
  (`we_1TgYEO…`, "MatchTime production (connected accounts)"),
  URL `https://matchtime.ai/api/stripe/webhook`, events
  `checkout.session.completed` + `checkout.session.async_payment_succeeded`. Its **new
  signing secret** was put into Vercel `STRIPE_WEBHOOK_SECRET` (prod) and redeployed.
- **Verified live:** £1 card test → attendance `paidAt` auto-stamped,
  `stripeSessionId: cs_live_…`, webhook delivery `200`.
- **Note:** the old "Your account" endpoint still exists but is irrelevant (we create no
  platform-account checkouts). Code path unchanged: `src/app/api/stripe/webhook/route.ts`
  verifies with the single `STRIPE_WEBHOOK_SECRET`; that secret is now the **connect**
  endpoint's. **If you ever roll the secret or add another connected-account event type,
  it's this `we_1TgYEO…` destination that matters.**

**LESSON:** For Stripe Connect **direct charges**, the webhook MUST be a **Connected
accounts** destination. A platform-scoped endpoint silently receives nothing. Always
check `Event deliveries` count, not just that an endpoint "exists".

### 2. WhatsApp `@lid` privacy DMs broke ALL DM handling

- **Symptom:** collector replied "£10.15" to the fee-ask DM; nothing happened. Match still
  `fee=null`.
- **Root cause:** WhatsApp migrated 1:1 DMs from `phone@c.us` to opaque **`@lid`** JIDs
  (no phone in the JID). The bot (`whatsapp-bot/src/index.ts`) forwarded `phone=""` for
  `@lid` senders; the server (`/api/whatsapp/dm-reply`) resolves the sender **by phone
  first**, then a pushname fallback **scoped only to open roster surveys**. A collector with
  no open survey → **"unknown sender"** → reply dropped. This broke *every* `@lid` DM:
  collector fees, check-ins, bench confirms, DM Q&A, direct-pay confirms.
- **Fix (universal, bot-side):** for non-`@c.us` DMs, recover the real number from
  `Contact.number` (via `msg.getContact()`) and forward it, so the server's normal phone
  lookup works for everything. Added a `[dm] resolved … phone=…` debug log.
- **Fix (belt-and-braces, server-side):** in `dm-reply`, if still unresolved, match the
  pushname against **money collectors** of payment-collecting orgs (tightly scoped to
  `paymentHolderId` users, decisive-match only) — protects the highest-value path if
  `Contact.number` is ever empty.
- **Verified live:** `[dm] resolved from=…@lid phone=447525334985 name=Kemal Ediz` →
  `feePendingConfirm` set → ✅ → **13** links released, collector excluded.

**LESSON:** `msg.from.endsWith("@c.us")` is no longer a safe way to get a DM sender's
phone — `@lid` is now common. Always resolve via `Contact.number`. Any future feature that
keys a DM sender off the JID phone needs the contact-resolution step.

---

## Collector is excluded from the pay flow

The collector collects the pot; they don't pay themselves. `paymentHolderId` (== the
replying `userId` in `handleCollectorFeeReply`) is skipped in:
- `releaseMatchPayments` — no pay-link DM to the collector.
- `bot-scheduler` daily pay-chaser — collector not chased.
- `/collect/[matchId]` roster — tracks payers only.
- `handleCollectorFeeReply` headcount — "N players to charge" and any "£X total to split"
  exclude the collector (so 14-squad → **13**; 5-a-side → 9; 3-a-side → 5).

---

## Payment tracking vs Payment collection (don't confuse them)

Two **separate** org features:
- **`paymentTrackingEnabled`** ("Payment tracking") = *legacy* group-poll chaser ("who's
  paid?" posted to the group). **Disabled on Sutton FC this session** — it duplicated/noised
  the new flow.
- **`paymentCollectionEnabled`** ("Payment collection") = the Stripe flow above (pay links,
  collect page, private DM chaser). **Keep ON.** Its chaser is gated independently, so
  turning tracking off doesn't affect it.

---

## Other player-facing changes shipped this session

- **Pay-by-bank hidden** (`/pay/[matchId]` `Methods`): the `pay_by_bank` push is commented
  out — org toggle, pricing, `payByMethod` all still wired; re-enable = one-line revert.
  Copy referencing "Pay by Bank" also removed from fee-link DM, collector confirm, and
  chaser.
- **Card option label:** "Card, Apple or Google Pay" (was wrapping as
  "Card / Apple Pay / Google Pay").
- **Card transaction description (collector-facing):** PaymentIntent `description` =
  `"<name> - <day Month>"` (e.g. "Amir - 9th June", `+N` for guests) so the collector can
  tell who paid from their Stripe payments list. Player-facing line item unchanged.
- **Collect page reachable:** "Payments · who's paid" link on `/matches/[matchId]` for an
  org admin **or** the collector (was only reachable via the post-match DM).
- **Money-collector picker:** Settings → Payments dropdown (`setPaymentHolder` action,
  `/api/org/settings` returns `paymentHolderId` + eligible members with phones).
- **Recruit DMs for attendance-OFF orgs** (earlier in session, `3d14bf6`): no false "N
  spots left", no useless app link — "reply IN in the group" instead.
- **Edit-teams / colour-swap / move-up-from-bench / conditional-drop HOLD**: see commits
  `7f6b8a9`, `9210a1e`, `b726f63`, `53f15af`, `5959517`, `50ecdd8` (analyzer + UI work
  from the first half of the session).

---

## Stripe config reference (live mode)

- Platform account: `acct_1TeMnhGWf71DV2cF` (Cressoft Consultancy Limited).
- **Connect webhook (THE one that matters):** `we_1TgYEOGWf71DV2cFhK8jA4ct`
  "MatchTime production (connected accounts)" → `https://matchtime.ai/api/stripe/webhook`,
  Connected-accounts scope, events `checkout.session.completed` +
  `checkout.session.async_payment_succeeded`. Secret in Vercel `STRIPE_WEBHOOK_SECRET`.
- Old platform-scoped endpoint `we_1TgQL6…` — irrelevant, can delete later.
- **Sutton FC** (`sutton-fc`, org `cmnnwhdx30000zfr85q18lyy9`): collection ON, collector =
  **Kemal** (`cmn5vhtp2000004ifh4dqbsym`), connected account `acct_1TgVO8KC83hTt3wd`,
  charges enabled, card + direct on, pay-by-bank toggle on but hidden in UI.
- **Test org** (`mt-test-payments`, `cmpzmlt1o0000gv9kf3rutpd9`): connected account
  `acct_1TgRuoGu55tcc286`. Seed/teardown: `scripts/seed-pay-test.ts`,
  `scripts/onboard-pay-test.ts`, `scripts/teardown-pay-test.ts`.
- Stripe enabled on connected accounts this session: **Pay by Bank, Google Pay** (Apple Pay
  already on). Pay-by-Bank works at Stripe level but is hidden in MatchTime UI.

---

## Tonight's live result (Tuesday 7-a-side, `cmpvvfqs3000104jsban4is5p`)

- 14 confirmed (3 dropped: Ehtisham, Youssef, Wasim — not charged).
- Fee set **£10.15/player** → **13 pay links released** (collector Kemal excluded ✅).
- Collect page: https://matchtime.ai/collect/cmpvvfqs3000104jsban4is5p

---

## Open items / TODO

- [ ] **Verify `Contact.number` populated** on the live `[dm] resolved` log for a range of
      `@lid` senders. It worked for Kemal; if any show `phone=?`, add a deeper LID→phone
      lookup (the server collector-name fallback covers the collector meanwhile).
- [ ] **Tear down `mt-test-payments` org** after the Stripe trial (carried over from before).
- [ ] Optional: delete the stale platform-scoped webhook `we_1TgQL6…`.
- [ ] International-card under-recovery is **accepted** (not a TODO) — revisit only if a
      non-UK card actually short-changes a collector.
- [ ] Pay-by-bank is hidden, not removed — revisit if/when reliable on connected accounts.

---

## Key files touched

| Area | File |
|---|---|
| Pricing / gross-up | `src/lib/payments.ts` |
| Stripe wrapper | `src/lib/stripe.ts` (`payerDescription` → PaymentIntent description) |
| Pay actions | `src/app/actions/payments.ts` (`setPaymentHolder`, `payByMethod`) |
| Post-match flow | `src/lib/payment-flow.ts` (`releaseMatchPayments`, `handleCollectorFeeReply`) |
| Scheduler (fee-ask, chaser) | `src/lib/bot-scheduler.ts` |
| Pay page | `src/app/pay/[matchId]/page.tsx` (pay-by-bank hidden) |
| Pay options UI | `src/components/pay/pay-options.tsx` |
| Collect page | `src/app/collect/[matchId]/page.tsx` + `src/components/pay/payment-roster.tsx` |
| Settings UI + API | `src/app/admin/settings/page.tsx`, `src/app/api/org/settings/route.ts` |
| Webhook | `src/app/api/stripe/webhook/route.ts` |
| DM resolution (`@lid` fix) | `whatsapp-bot/src/index.ts`, `src/app/api/whatsapp/dm-reply/route.ts` |

## Commits (this session, newest first)

```
488c61b fix(payments): exclude collector from fee-prompt count + total split
a4cbf3b fix(dm): resolve @lid privacy DMs to the real user
9983208 style(payments): shorten card option label to one line
044a769 feat(payments): show Google Pay in the card option label
2e3263e chore: redeploy to pick up new STRIPE_WEBHOOK_SECRET (connect webhook)
0261c13 feat(payments): exclude the money collector from pay flow
906b48f fix(payments): drop 'pay by bank' from the daily chaser DM copy
3d53613 feat(payments): payer-name card description + reachable collect page
79ecbc9 feat(payments): pick the money collector in Settings UI
799c869 fix(payments): drop 'Pay by Bank' from player+collector DM copy
307f94f fix(payments): hide Pay by Bank from player pay menu
3d14bf6 fix(recruit): no spot-count or app link for attendance-off orgs
53f15af fix(analyzer): deterministic conditional-drop HOLD
50ecdd8 feat(squad): "Move up" bench→squad in the squad list
5959517 feat(teams): "move up from bench"
b726f63 fix(analyzer): conditional drop offers must not auto-drop the player
7f6b8a9 feat(teams): full Edit-teams UI
37705a9 fix(payments): auto-refresh Connect status on return from onboarding
3601719 feat(payments): pre-fill collector's Stripe business profile
435f82d feat(payments): "Manage bank / payouts"
cac6a1e feat(payments): self-service "Disconnect / start over"
9210a1e fix(analyzer): "swap the colours" flips labels, never regenerates
```
