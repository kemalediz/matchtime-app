# Parked follow-ups (remind Kemal next session)

Both also saved as a memory at
`~/.claude/projects/.../memory/project_parked_followups.md` so they
auto-surface next time we work together.

## 1. Shorten the magic-link DMs

### Why it matters
Current links are `matchtime.ai/r/<base64-payload>.<sig>` ≈ **230–280
chars**. The payload + signature both live in the URL; that's elegant
(stateless verify) but ugly in WhatsApp.

### Agreed design — server-side short-code redirect
Store the signed token in a small `ShortLink` table keyed by a random
8-char code; ship the *code* in the URL:
- `matchtime.ai/r/k7Qp2m9` (~30 chars instead of ~250)

Build outline:
1. New Prisma model `ShortLink { code @id; token; expiresAt; createdAt }`.
2. New helper `buildShortMagicLinkUrl(token)` — generates a random code,
   stores it, returns the short URL. Replaces `buildMagicLinkUrl`
   call sites that send links to humans.
3. `/r/[token]` page distinguishes legacy long tokens (contain `.`) from
   short codes (no `.`):
   - Long token → existing peek + signIn path (backward compatible).
   - Short code → API lookup → resolves to token → same peek + signIn.
4. **Backward compatible** — every link already in players' chats
   (especially the permanent stats links — `MAGIC_LINK_TTL.permanent =
   100 years`) keeps working forever.

### Call sites to update (6)
- `src/app/actions/players.ts`
- `src/app/actions/payments.ts`
- `src/app/actions/phone-signup.ts`
- `src/app/api/whatsapp/analyze/route.ts`
- `src/lib/bot-scheduler.ts`
- `src/lib/payment-flow.ts`

### Open decision
- **Short code only** → matchtime.ai/r/k7Qp2m9 (~30 chars). Free, all
  the win.
- **Short code + shorter domain** → e.g. matchti.me/r/k7Qp2m9 (~25
  chars). Needs domain purchase + DNS, marginal win for the cost.

Kemal leans toward the bigger improvement — Auto Mode could just ship
short-code-only as the obvious right call when we pick this up.

### Watch out
- It's the sign-in path. Treat with care: test e2e against the live
  sandbox + verify both legacy AND new shapes resolve.
- Short codes must be cryptographically random (don't use sequential
  ids).
- Short-code rows can be pruned by a cron once
  `expiresAt < now() - <grace window>`.

---

## 2. Tear down `mt-test-payments` org

Created during the e2e (`02-payments-e2e-test.md`). Still live —
appears in Kemal's "All clubs" overview as 1 game and clutters the
view.

**Don't run while the Stripe trial might still resume.** Once Sutton's
collector is onboarded and you're live on real charges, the test fixture
has no purpose.

### Teardown
```bash
npx tsx --env-file=.env scripts/teardown-pay-test.ts
```
That script (already written): `wipeOrg(orgId)` cascades the org +
activities + matches + memberships + attendances, and deletes the
fictitious Test Player Two (`+447700900123`).

Stripe-side: the test Connect account `acct_1TecqIK1LisBZ8J7` remains
in the sandbox dashboard — fine to leave (it costs nothing) or delete
via the Stripe dashboard.

---

## When/how I'll remind

Memory `project_parked_followups.md` will load at the start of every
future session in this project. I'll surface both items in my first
response unless Kemal's mid-something urgent. He can also just ask
"what was that magic-link plan again?" and I'll have it.
