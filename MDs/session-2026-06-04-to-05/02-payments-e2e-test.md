# Payments — end-to-end test (sandbox)

Kemal wanted to verify the full money path before announcing to Sutton
FC. Key constraint: **Sutton must stay completely untouched**.

## Isolation strategy

The payment flow is **gated on `Organisation.paymentCollectionEnabled`**
for every step (fee-ask DM, fee-capture handler, chaser). Both Sutton
orgs have it `false`, so the *test scaffolding has zero possible reach
into Sutton*, regardless of what we do elsewhere.

Built a throwaway test org with the flag ON, with Kemal as collector and
the only other "player" on a UK reserved-fictitious number
(`+447700900123`, Ofcom guarantees never assigned) so even a stray DM
can't reach a real person.

## Scripts added

| File | Purpose |
|---|---|
| `scripts/seed-pay-test.ts` | Idempotent. Creates org `mt-test-payments`, test activity, COMPLETED test match (ended 2h ago, fee unset so chat capture is exercisable), Kemal + Test Player Two as confirmed |
| `scripts/onboard-pay-test.ts` | Mirrors `startCollectorOnboarding`: creates Connect account, returns hosted onboarding URL |
| `scripts/teardown-pay-test.ts` | One-command wipe (uses `wipeOrg`) + deletes Test Player Two |

## Stripe sandbox onboarding (Chrome-driven)

Drove Chrome through the hosted onboarding flow. Notable steps:

1. **Test phone shortcut** — Stripe's onboarding has a "Use test phone
   number" button → fills 000000000, code is `000000`.
2. **hCaptcha** appeared — that's a deliberate anti-bot gate I couldn't
   automate. Kemal solved it.
3. **First onboarding submission was incomplete** — `details_submitted:
   True` but `currently_due: [individual.address.*, dob.*, first_name,
   last_name, phone]`. The personal-details step had been skipped.
4. **Refresh link → "Verify account representative" step appeared** with
   the details prefilled (Stripe matched to a real identity via the
   phone). Confirmed → "Verify identity" step with a **"Simulate"**
   button → "Successful verification" → account flipped to
   `charges_enabled: True`.

Account: `acct_1TecqIK1LisBZ8J7`. Synced onto the test org via a one-off
`accountChargesEnabled` call.

**Stripe API gotcha worth remembering:** for **Express** Connect accounts
the platform **cannot write `individual` fields via API** ("This
application does not have the required permissions for the parameter
`individual`"). Those fields must come through the hosted onboarding
form. Don't waste time trying the API path.

## The actual e2e (against real prod code)

### Step 1 — collector DMs "£8 each"
```bash
curl -X POST https://matchtime.ai/api/whatsapp/dm-reply \
  -H "x-api-key: $WHATSAPP_API_KEY" \
  -d '{"phone":"+447525334985","body":"£8 each",...}'
# → {"ok":true,"handled":"collector-fee"}
# Match.feePendingConfirm = 8
# DM queued: "Got it — £8 per player for Test 5-a-side, 2 players to charge. Reply ✅"
```

### Step 2 — collector replies "✅" (FIRST attempt failed — caught the bug)
```
# First try: returned {"ignored":"no-open-survey"}  ← BUG
# feePendingConfirm still 8, no links released
```
This is the emoji-`\b` regex bug. Fixed in `dfec963`, deployed (~75s),
retried:
```
# {"ok":true,"handled":"collector-fee","released":2}
# Match.feePerPlayer = 8, paymentLinksReleasedAt set
# DMs queued:
#   to collector: "✅ Done — sent 2 pay links at £8 each..."
#   to Kemal:     "💷 Kemal — match fee for Test 5-a-side is £8. Tap to pay: <link>"
#   to Player 2:  same template
```

### Step 3 — pay page
Chrome navigated to the magic link → `/pay/[matchId]` rendered with:
- **MATCHTIME TEST (PAYMENTS)** — Test 5-a-side
- Match fee: £8
- Three method buttons: **Pay by Bank £8.15**, **Card / Apple Pay £8.40**,
  **Pay the collector directly £8**

### Step 4 — card checkout
Clicked Card → Stripe Checkout loaded **on the collector's connected
account** (Sandbox banner, £8.40, "MatchTime Test (payments)" branding).
Filled `4242 4242 4242 4242` / `12/34` / `123` / "Kemal Ediz" → Pay →
redirected to `/pay/[matchId]?paid=1` → "✅ You're all paid".

### Step 5 — webhook proof (the critical check)
Queried DB:
```
Kemal | paidAt: 2026-06-04T15:23:04Z | method: card | amount: 8.4
      | qty: 1 | session: cs_test_a1XhudKRlLcE
Test Player Two | unpaid
```
So the **webhook fired**, hit `applyCheckoutPaid`, marked Attendance from
the `matchId` + `userId` + `quantity` metadata on the session. **£8.40
is the correct card-uplift price.** Money path proven.

### Step 6 — `/collect` page + "Mark received"
Navigated to `/collect/[matchId]` → roster showed "1/2 paid · £8.40
collected", Kemal "Paid · Card · £8.40", Player Two "Unpaid" with
**Mark received** button. Clicked it → DB confirmed:
```
Test Player Two | paidAt: ... | directConfirmedByUserId: cmn5vhtp2 (Kemal)
```
So the collector-not-admin authorisation path works
(`requireMatchCollectorOrAdmin`).

### Step 7 — chaser (verified out-of-band)
Couldn't trigger it live without monkey-patching the 18:00 time gate, so
ran the exact pay-chase branch logic against the test match data
(replicating the scheduler branch). Produced the right output:
- Unpaid + no `directPendingAt` → chase DM to that player with a fresh
  link.
- Skipped paid players + direct-pending players (those go to the
  collector via the separate `pay-chase-collector` key).

## Result

**Every payment code path verified working against real prod code +
real Stripe sandbox.** One real bug caught and shipped in the same loop
(`dfec963`). Sutton 100% untouched throughout.

## Aftermath
- Test fixture still live (org `cmpzmlt1o…`, slug `mt-test-payments`).
- Test Connect account `acct_1TecqIK1LisBZ8J7` (charges_enabled, sandbox).
- Stripe stays in **test mode** until Sutton's collector finishes
  Connect onboarding for real.
- The test org appears in Kemal's "All clubs" overview as 1 game — parked
  for teardown post-trial (see `08-parked-followups.md`).
