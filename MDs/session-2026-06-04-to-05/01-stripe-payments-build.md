# Stripe payments — completing the build

Started this session continuing the per-match payment system. The bulk of
the code (schema, pricing lib, Connect lib, pay page, webhook) had landed
in a prior session; what shipped here was the **bot-mediated fee capture
+ release** and the **chaser**, plus a **collector dashboard** page.

## Commit `d6cd874` — chat fee-capture + chaser + collector page

### Collector chat fee-capture (`src/lib/payment-flow.ts`)
- `handleCollectorFeeReply(userId, text)` — runs inside the existing
  `dm-reply` route, BEFORE the survey / Q&A handlers.
- Only triggers for users who are `Organisation.paymentHolderId` of a
  `paymentCollectionEnabled` org with a recently-played match (4-day
  window) that hasn't released payment links yet.
- Two phases:
  1. **Capture** — collector DMs "£8 each" / "£80 total to split" →
     parsed by `parseFeeReply(text, headcount)` → echoes a confirm
     message + sets `Match.feePendingConfirm`.
  2. **Confirm** — collector replies `✅` (or "yes", "send it", "ok",
     etc.) → sets `feePerPlayer`, clears `feePendingConfirm`, calls
     `releaseMatchPayments(matchId)` which DMs each confirmed player a
     `/pay/<matchId>` magic link.
- Unprompted captures gated by `looksLikeFeeAmount(text)` so a stray
  number ("we had 10 players") can't become a fee.

### Scheduler additions (`src/lib/bot-scheduler.ts`)
- `fee-ask` — at match-end, DMs the collector once: "how much per
  player?". Gated on `paymentCollectionEnabled`. Mapped in the
  post-compute feature filter as well (defence in depth).
- `pay-chase` — daily 18:00 London, capped 10 days:
  - For unpaid card/bank players → re-DMs the pay link with rotating
    opener tone (Day 1 "Quick one X", Day 2 "X, gentle nudge", Day 3+
    "X, still owed").
  - For `directPendingAt` players → once-a-day nudge to the **collector**
    instead, linking to `/collect/<matchId>`.

### Collector page `/collect/[matchId]` + roster component
- `src/app/collect/[matchId]/page.tsx` — payment roster scoped to one
  match. Shows everyone's paid status, method, amount.
- `src/components/pay/payment-roster.tsx` — client island with a
  "Mark received" button per unpaid direct-pay row.
- Authorisation: a new `requireMatchCollectorOrAdmin` helper lets the
  org's **money collector** (paymentHolderId) settle direct payments
  even if they're not an org admin (Sutton FC case: Kemal owns, Elvin
  collects).

### Schema additions used
All shipped in a prior session, used here:
- `Match.feePerPlayer / feePendingConfirm / feeSetByUserId / feeSetAt /
  paymentLinksReleasedAt`
- `Attendance.paidAt / paymentMethod / paymentAmount / paymentQuantity /
  stripeSessionId / directPendingAt / directConfirmedByUserId`
- `Organisation.paymentCollectionEnabled / payMethod{PayByBank,Card,
  Direct} / stripeConnectAccountId / stripeChargesEnabled`

### Pricing model (surcharge-compliant, UK)
Card is the **standard** price; bank and direct are *discounts* from it,
not surcharges on card. From `src/lib/payments.ts`:

```js
METHOD_UPLIFT = {
  card: 0.40,        // ~1.5% + 20p on £10 + headroom
  pay_by_bank: 0.15, // ~10-20p flat
  direct: 0,
}
// £8 base → bank £8.15, card £8.40, direct £8.
```

`totalForMethod(base, method, quantity)` adds the uplift **once per
transaction** so paying for guests gets cheaper per head.

---

## Commit `dfec963` — emoji-confirm bug fix (found during e2e)

**Bug:** `"✅"` (and `"👍"`) didn't confirm a pending fee. The match's
`feePendingConfirm` stayed `8` and the pay-link release never fired —
the e2e test in `02-payments-e2e-test.md` caught it.

**Cause:** the original regexes ended in `\b`:
```js
const AFFIRMATIVE = /^(✅|👍|y|ye|yes|...)\b/i;
```
A word-boundary never matches after a lone emoji (no `\w` on either
side), so the whole match fell through to "unrelated chatter".

**Fix:** replaced both regexes with helper functions that match emoji
directly and normalise word replies:

```js
function isAffirmative(text: string): boolean {
  if (/[✅✔👍]/u.test(text)) return true;
  const t = text.trim().toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (!t) return false;
  const AFF = new Set(["yes","yep","ok","confirm","send","send it",
    "send them","go","sure","right","ok send", ...]);
  return AFF.has(t) || /^(yes|yeah|...|go)\b/.test(t);
}
```

Verified with a unit test covering `"✅"`, `"Yes please"`, `"ok send
them"`, `"👍"`, `"SEND IT"`, `"yeah go on"`, and negatives. Re-ran the
e2e — `released: 2`, links queued correctly.

---

## Verified live (matchtime.ai)
- `/api/stripe/webhook` returns 400 on a forged signature → secret
  loaded + verifying, route public via middleware.
- `/pay/[matchId]` and `/collect/[matchId]` gate to login.
- Charge loop wired: Checkout on connected account with `matchId` +
  `userId` + `quantity` metadata → `checkout.session.completed` →
  `applyCheckoutPaid` writes Attendance.

**Prod canonical:** `https://matchtime.ai`. Note `*.vercel.app` aliases
have Deployment Protection (401 on everything including the webhook) —
always smoke-test against matchtime.ai.
