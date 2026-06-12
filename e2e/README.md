# MatchTime e2e + API integration suite

Playwright suite that drives the real Next.js app (browser flows) and the
bot-facing API routes against a **fully isolated local test database** —
prod is never touched, no WhatsApp message is ever sent (the Pi bot is not
in the loop; `BotJob` / instruction rows are asserted instead), and the
LLM is stubbed.

## Running

```bash
npm run test:e2e            # full run (provisions everything itself)
npm run test:e2e -- web/pay.spec.ts   # one file; args forwarded to playwright
npm run test:e2e:ui         # Playwright UI mode
```

That single command:

1. Starts an **embedded Postgres** (binaries from the `embedded-postgres`
   npm package — no Docker, no system Postgres) on `127.0.0.1:54311`,
   data dir `.e2e/pgdata` (gitignored, persists between runs for speed).
2. `prisma db push` (this repo's schema-sync mechanism) + seeds the
   fixture world (`e2e/helpers/seed.ts`) via tsx.
3. Writes `.env.e2e` (gitignored) documenting the test DB URL.
4. Runs Playwright; its `webServer` boots `next dev` on `:3105` with a
   pinned env (`e2e/helpers/env.ts → buildTestEnv()`).
5. Stops the embedded Postgres.

`npx playwright test` directly is **blocked** (the config throws unless
launched through the orchestrator) so the suite can never run against an
unprovisioned/ambient `DATABASE_URL`.

### Safety model (read before changing anything)

- `assertSafeTestDbUrl` gates every DB-touching entry point: the URL must
  be loopback and must not contain any cloud-host marker (`supabase`,
  `pooler`, `amazonaws`, …). The worktree's `.env` (prod) is never read:
  the web server is spawned with every sensitive var explicitly pinned —
  `DATABASE_URL`/`DIRECT_URL` → embedded DB, `ANTHROPIC_API_KEY`/
  `STRIPE_SECRET_KEY`/`RESEND_API_KEY` → empty, `AUTH_SECRET`/
  `WHATSAPP_API_KEY` → test-only values. A prod-configured server would
  401 every API spec and reject every test-minted magic link.
- All seeded phones are in the UK reserved-fictitious range
  (`07700 900xxx`); all emails end `@e2e-test.invalid`.

### Test-only seams in prod code (inert unless the env flag is set)

| Seam | File | Activation |
|---|---|---|
| LLM stub — `analyzeBatch` reads verdicts from a JSON file instead of calling Anthropic | `src/lib/message-analyzer.ts` | `MT_TEST_LLM_STUB_FILE` |
| Clock override for scheduler windows — `x-test-now` header on `/api/whatsapp/due-posts` | `src/app/api/whatsapp/due-posts/route.ts` → `computeDuePosts(groupId, nowOverride?)` | `MT_TEST_MODE=1` |

### Architecture notes

- **Prisma stays out of the Playwright process.** The Prisma 7 generated
  client is ESM-TS (`import.meta`) that Playwright's transpiler can't
  load. Seeding runs under tsx (`e2e/helpers/seed-cli.ts`, invoked by
  `resetDb()`); spec-side DB asserts use plain `pg`
  (`e2e/helpers/test-db.ts`). Server libs that import Prisma are tested
  under tsx too (`e2e/helpers/lib-tests.ts`).
- **Auth**: fixtures mint real magic-link tokens (`signMagicLinkToken`
  with the test `AUTH_SECRET`) and drive `/r/<token>` — the same path a
  player tapping a WhatsApp link takes. `signInAs(page, U.x)` /
  `asAdmin` / `asPlayer` / `asCollector`.
- **Determinism**: one worker, serial files; specs that mutate state
  `resetDb()` in `beforeAll`. Fixture ids are constants
  (`e2e/helpers/constants.ts`).

## Coverage map

### Covered — web (browser)

| Area | Spec | Asserts |
|---|---|---|
| Magic-link login | `web/auth.spec.ts` | valid token → session + nextPath redirect; expired + garbage token → error state, no session; session persists |
| Pay page | `web/pay.spec.ts` | 3 methods render; exact per-method totals (£8 → bank £8.33 / card £8.41 / direct £8); quantity stepper reprices (×2 → £16.45/£16.61/£16); card click reaches Stripe boundary (error surfaced, Stripe never driven); **pay-directly: direct-pending set + exactly ONE collector DM even on repeat taps** (e013b6d); already-paid state |
| Collect page | `web/collect.spec.ts` | collector excluded from roster; **NET base×qty shown, not gross** (6b2de3f); paid/unpaid/direct-pending states; Refresh button (8d445d2); mark-received flips to paid; access control (player bounced, admin allowed) |
| Rate page | `web/rate.spec.ts` | submit ratings + MoM → rows land + redirect to stats; **stale-playerId guard: player deleted after page load → no 500, survivors' ratings land** (P2003 regression; the guard itself was added in this change) |
| Admin → Players | `web/admin-players.spec.ts` | provisional NEW row shows name at 390px (zero-width collapse regression); add-by-name dedup (existing unique name reused, ambiguous "Omar" creates fresh); merge flow deletes the duplicate; no horizontal overflow at mobile width |
| Admin → Settings/Activities | `web/admin-settings.spec.ts` | money-collector picker; payment-method toggle persists (UI → DB → reload → pay page gating); mobile no-overflow on settings + activities |
| Stats | `web/stats.spec.ts` | renders for a player with season data; works for a phone-less guest via magic link |

### Covered — bot/analyzer API (LLM stubbed)

| Area | Spec | Asserts |
|---|---|---|
| Analyzer apply path | `api/analyzer.spec.ts` | IN → CONFIRMED (react ✅); IN on full squad → BENCH (🪑, capacity respected); OUT → DROPPED + open BenchSlotOffer; **third-party BENCH demote** (CONFIRMED→BENCH, slot freed, exactly one row, no offer, no dup announce); **bench-demote safety net** (reply claims move, no registerFor → server synthesises the demote); waMessageId dedupe |
| DM reply | `api/dm-reply.spec.ts` | opt-out keyword → `ratingDmOptOut` set + ack BotJob only after write; re-opt-in clears; unknown sender ignored with zero writes |
| Scheduler | `api/due-posts.spec.ts` | morning rate-DMs to all confirmed players EXCEPT opted-out; evening reminders skip opted-out AND already-rated (clock pinned via x-test-now) |
| Dedup helper + squad-from-list | `api/resolve-and-pricing.spec.ts` → `helpers/lib-tests.ts` (tsx) | `findExistingOrgMember`: phone wins, alias hit, unique exact, unique fuzzy, ambiguous→null, unknown→null; `normaliseName`, `parseReservesFromBody`; `resolveOrProvisionSquadName` reuse vs provision |
| Fee math | `api/resolve-and-pricing.spec.ts` | `totalForMethod`/`priceMethods`/`platformFeePence`/`parseFeeReply` against hardcoded oracles |

### DEFERRED (known gaps — next wave candidates)

- **Stripe webhook flow** (`/api/stripe/*`): checkout completion →
  `paidAt`, Connect onboarding. Needs `stripe-cli` fixtures or signed
  payload replay; nothing here drives Stripe.
- **Bench-confirmation lifecycle end-to-end**: bench-prompt posting,
  👍/👎 reaction route, DM YES/NO claim, expiry sweep chaining to the
  next bencher (`/api/whatsapp/reaction`, parts of dm-reply).
- **Collector fee capture via chat** (`handleCollectorFeeReply`): "£8
  each" → fee set + links released (deterministic, good candidate).
- **Team generation / balancer / colour-swap / team-swap seatbelts** in
  the analyzer route.
- **Score capture + match completion cron** (`/api/cron/complete-matches`,
  Elo updates, MoM announcement).
- **Squad-from-list EXTRACTION cron** (`/api/cron/extract-squads`) — the
  LLM extraction itself; only the deterministic resolution helpers are
  covered.
- **Onboarding conversation** (group "@MatchTime setup" multi-turn).
- **Roster survey** flows; **group-join/leave/sync-participants**.
- **Other analyzer safety nets**: conditional-drop hold, IN/OUT intent
  backfills, proximity/roster reply rewriters (pure functions — easy
  unit targets later).
- **Wrapped/share card** (`/api/wrapped/*`) rendering.
- **Visual regression** (screenshots) — only overflow geometry is
  asserted today.
- **CI wiring** (GitHub Actions): the suite is CI-ready (self-provisions
  Postgres; set `CI=1` so `reuseExistingServer` is off) but no workflow
  file is committed.

## Conventions for new specs

- Put browser flows in `e2e/web/`, API/integration in `e2e/api/`.
- Reseed with `resetDb()` in `beforeAll` if the spec mutates state.
- Never import `@/lib/*` modules that touch Prisma from a spec — use the
  `db` fixture (pg) or extend `helpers/lib-tests.ts`.
- Stub analyzer verdicts with `setLlmStub({ [waMessageId]: {...} })`
  immediately before the POST.
- New fixture rows: extend `helpers/constants.ts` + `helpers/seed.ts`;
  keep phones inside `07700 900xxx`.
