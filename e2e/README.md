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
npm run test:sim            # just the group-simulator scenario matrix (e2e/sim/)
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
| DM-Q&A stub — `answerScopedQuestion` returns the SCOPED CONTEXT itself instead of calling Anthropic, so specs assert the no-leak guarantee structurally (no raw phone digits ever enter the model's context; 📵 flags admin-only) | `src/lib/dm-qa.ts` | `MT_TEST_LLM_STUB_FILE` |

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

### Covered — group simulator (`e2e/sim/`, the WhatsApp regression net)

A **virtual WhatsApp group** abstraction (`e2e/sim/group.ts`) spins up a
fresh org + roster + match(es) per scenario and drives the REAL pipeline
end-to-end: post a message (with the verdict the LLM *would* emit, or an
inferred one for plain "in"/"out"), then assert the bot's react/reply,
every queued group post + DM (BotJob rows) and the DB end-state.

```ts
const g = await createGroup(request, db, {
  maxPlayers: 8,
  attendance: [{ key: "owner", status: "CONFIRMED" }, …],   // initial state
  features: { attendance: false, squadFromList: true },      // org flags
  completedMatch: { daysAgo: 1, confirmedKeys: […], teams: {…} },
});
const r = await g.post("pete", "in");                 // or .postBatch([...])
r.react; r.reply; r.groupPosts; r.dms;                // what the bot did
await g.confirmed(); await g.bench(); await g.dropped(); await g.openOffers();
await g.dm("pete", "YES");                            // 1-1 DM path
await g.reaction(msgId, "👍", "henry");               // offer-claim reaction
await g.pollVote({ waMessageId, voterKey, optionName }); // MoM/payment poll
await g.duePosts(londonAt(0, 8, 30));                 // scheduler at a pinned clock
await g.botAdded({ … });                              // onboarding event
// + createOnboardingGroup(request) for groups with no org yet.
```

Default roster: 16 members with phones (owner + 2 admins + 13 players),
2 without a number on record, 1 @lid-only member. Phones/ids are
allocated per-process so groups never collide; specs `resetDb()` once in
`beforeAll` and share a memoized group per serial describe-block
(re-`attach(request)`ed each test — the fixture context is per-test).

| Area | Spec | Scenarios |
|---|---|---|
| Onboarding | `sim/onboarding.spec.ts` | live-org group never re-enters onboarding; bot-added → intro; chat falls open; EVERYTHING → payments on + admins asked; admins by **name+phone AND @mention** → 2 ADMIN memberships + magic-link DMs; when&where → Activity + first Match (11-a-side → 22); roster import with @lid skipped; OWNER = consenting replier |
| Attendance | `sim/attendance.spec.ts` | IN→CONFIRMED; the filling IN posts ONE squad-complete announcement; IN at capacity→BENCH; OUT→DROPPED + open BenchSlotOffer; in-group bench claim (benchConfirmation) → promoted + offer resolved + announce; admin "move X to bench" → demote, slot freed, NO offer, no dup announce; benched player's own IN → promoted when a slot is free; **banter "X is out" while X chats → NOT dropped, bot silent**; third-party OUT for an absent player honoured; OUT from a non-registered player → silent; DM "YES" claims the offer (ack + announce), late claimer misses; 👎 reaction no-op, 👍 reaction claims |
| Squad messaging | `sim/squad-post.spec.ts` | burst of mixed messages collapses to ONE windowed "latest squad and bench" post; bench ALWAYS listed; stale single reply re-canonicalised (count + "slots open" + "need N more" prose recomputed); never "full + slot open"; never a total above the cap; never "X moves up from the bench" while X is benched; raw-digit pushnames never surface (provisioned as "New player") |
| Recruit | `sim/recruit.spec.ts` | explicit shortage from an admin → invite DMs to recent non-responders with phones (idempotent per match); "list the players" NEVER recruits; non-admin → 🔒; full squad → DMs nobody |
| Q&A / privacy | `sim/qa.spec.ts` | "who's on the bench?" → bench rewritten from DB; leaderboard replies pass through verbatim; DM "what's X's number?" → context contains ZERO phone digits + no 📵 flags for non-admins; "who's missing a number?" → 📵 flags for admins only, still digit-free; group "dm me …" → 📩 + private scoped answer; "my stats" → 📊 + personal magic-link DM |
| Opt-out | `sim/optout.spec.ts` | "stop messaging me about ratings" → flag set, ack only AFTER the write; morning rate-DM loop + evening reminder loop both skip opted-out (and already-rated); re-opt-in clears |
| Score + MoM | `sim/score-mom.spec.ts` | chat score with CUSTOM team labels (Bibs/Skins → redScore/yellowScore) → COMPLETED + Elo applied; non-participant non-admin refused silently; `/api/whatsapp/score` route; MoM poll vote recorded / re-vote replaces / self-vote refused / un-vote clears |
| Squad-from-list | `sim/squad-from-list.spec.ts` (+ `sim/squad-from-list-lib.ts` under tsx) | pasted lists archived to GroupMessage with the analyzer out of the loop; attendance verdicts dropped when attendance is OFF (stats-Q&A on); paste → squad built via `attributeDiffs` → alias learning ("~T" → Tharan) → `finaliseSquadForMatch` (existing members + aliases reused, unknown → provisional, **ambiguous → NEW provisional never a guess**, reserves → BENCH) |

Known sim-coverage limits (LLM-classification itself is out of scope by
design): the squad-from-list LLM *extraction* call, the in-group
"who's missing a number?" answer (generated by the model from 📵 flags
in its context — the DM path's context flags ARE asserted), and rating
submission with a merged-away player (covered in `web/rate.spec.ts`).

### DEFERRED (known gaps — next wave candidates)

- **Stripe webhook flow** (`/api/stripe/*`): checkout completion →
  `paidAt`, Connect onboarding. Needs `stripe-cli` fixtures or signed
  payload replay; nothing here drives Stripe.
- **Bench-confirmation residue**: the scheduler's bench-PROMPT posting
  and the expiry sweep chaining to the next bencher (the claim paths —
  👍/👎 reaction, DM YES/NO, in-group benchConfirmation — are now
  covered in `sim/attendance.spec.ts`).
- **Collector fee capture via chat** (`handleCollectorFeeReply`): "£8
  each" → fee set + links released (deterministic, good candidate).
- **Team generation / balancer / colour-swap / team-swap seatbelts** in
  the analyzer route.
- **Match completion cron** (`/api/cron/complete-matches`, MoM
  announcement; score capture + Elo now covered in
  `sim/score-mom.spec.ts`).
- **Squad-from-list EXTRACTION cron** (`/api/cron/extract-squads`) — the
  LLM extraction itself; the deterministic chain after it is covered in
  `sim/squad-from-list.spec.ts`.
- **Onboarding conversation** (Phase 2 "@MatchTime setup" multi-turn
  trigger; the group-add flow is covered in `api/onboarding.spec.ts` +
  `sim/onboarding.spec.ts`).
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

- Put browser flows in `e2e/web/`, API/integration in `e2e/api/`, and
  bot-behaviour scenarios in `e2e/sim/` (build on `e2e/sim/group.ts` —
  prefer a fresh `createGroup` per describe-block over mutating the
  shared fixture org).
- Reseed with `resetDb()` in `beforeAll` if the spec mutates state.
- Never import `@/lib/*` modules that touch Prisma from a spec — use the
  `db` fixture (pg) or extend `helpers/lib-tests.ts`.
- Stub analyzer verdicts with `setLlmStub({ [waMessageId]: {...} })`
  immediately before the POST.
- New fixture rows: extend `helpers/constants.ts` + `helpers/seed.ts`;
  keep phones inside `07700 900xxx`.
