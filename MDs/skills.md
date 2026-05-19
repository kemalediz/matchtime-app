---
name: Skills
description: How to work effectively in this codebase — tooling, patterns, and operational rituals
type: reference
originSessionId: 70ec7d56-8494-404f-90f8-117487d2d23f
---
A condensed quick-reference for the routines and patterns that make changes ship cleanly here. Detailed context lives in `project_matchtime.md` and `reference_*.md`; this file is the "what do I always do".

---

## Stack at a glance

- **Next.js 16.2 beta** (Turbopack). Breaking changes vs training data — read `node_modules/next/dist/docs/` before guessing.
- **Prisma 7.5** with `@prisma/adapter-pg` (Postgres on Supabase). Schema generates into `src/generated/prisma/` (gitignored) — `build` script runs `prisma generate && next build`.
- **NextAuth v5** with Credentials + Google + JWT sessions.
- **Tailwind v4** + plain utility classes (shadcn primitives almost all replaced — don't reintroduce them).
- **Anthropic SDK** — Haiku 4.5 for high-frequency message analyzer (10-min batches, 1h prompt cache); Sonnet 4.5 for one-shots (onboarding analyzer, hybrid balancer).
- **WhatsApp bot** in `whatsapp-bot/` — `whatsapp-web.js` on a Raspberry Pi 5, polls `/api/whatsapp/due-posts` every 5 min and dispatches dumb instructions.

## Repo layout shortcuts

- `src/lib/` — server-only helpers (db, auth, bot scheduler, message analyzer, balancer, magic-link, …).
- `src/app/` — Next App Router. `actions/` holds `"use server"` actions; `api/whatsapp/*` is the bot's HTTP surface.
- `prisma/schema.prisma` — single source of truth. Migrations history is out of sync from earlier debugging — use `prisma db push`, NOT `prisma migrate`.
- `scripts/` — one-off TS scripts, run with `node --env-file=.env --import tsx scripts/foo.ts`. Use `import { PrismaClient } from "../src/generated/prisma/client.ts"` (with `.ts` extension; tsx resolves it, plain Node ESM doesn't).
- `whatsapp-bot/` — separate npm app, bot only. Versioned in the same repo but only deploys when the Pi pulls.

## Local commands I always reach for

```bash
# TypeScript only — fastest sanity check
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx tsc --noEmit

# Full build before pushing — catches Server-Action async violations + duplicate routes
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npm run build

# Apply schema changes (NOT migrate — history is out of sync)
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx prisma db push
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx prisma generate

# Vercel deploy status (or check the dashboard)
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH vercel ls --scope kemaledizs-projects matchtime
```

The `PATH` prefix is because the user's shell defaults to Node 16, which Prisma 7 + Vercel CLI both reject (`ReferenceError: ReadableStream is not defined`).

## Standing rule: auto-deploy to the Pi after every push

After **every** `git push` that lands on `main`, even server-only changes:

```bash
ssh davidediz@matchtime-pi.tail1437f5.ts.net 'cd ~/matchtime-bot && git pull --ff-only && sudo systemctl restart matchtime-bot.service'
```

For bot code changes also run `cd whatsapp-bot && npm install --silent` between pull and restart. Verify with `systemctl status matchtime-bot.service --no-pager` — should be `active (running)` within ~10s.

If SSH returns "additional check required" with a `login.tailscale.com/a/...` URL, ask Kemal to click it once.

## Verification tools / pre-built scripts

The 90+ scripts in `scripts/` follow a `peek-*`, `check-*`, `find-*`, `fix-*` naming convention. Common ones:
- `peek-mom-apr21.ts` — read MoM votes for the latest match
- `check-bot-jobs.ts` — see what's queued / sent
- `check-state.ts` / `check-lineup.ts` — current attendance state
- `manual-attendance.ts` — fallback when wweb.js `fetchMessages` flakes
- `wipe-org.ts` — generic org delete (dry-run by default; `--apply`)
- `record-score.ts` — manual score entry
- `dbquery.ts` — read-only inspector
- `peek-roster-survey.ts` — survey DMs + responses + recent BotJob DMs
- `start-roster-survey.ts <slug> [--test-only-me] [--apply]` — kick off a survey (dry-run default; `--test-only-me` limits DM to Kemal for testing)
- `send-magic-link-shaz.ts` — template for ad-hoc per-player magic-link sign-in DMs

Pattern: peek before fixing, fix in a dedicated script when you can, never in a REPL.

## Deployment cadence

Atomic commits with conventional prefixes. Recent style:

```
feat(scope): short imperative
fix(scope): short imperative
chore(scope): short imperative
```

Common scopes: `balancer`, `mom`, `scheduler`, `analyze`, `reactions`, `admin/players`, `admin/organisations`, `onboarding`, `reply`, `chase`. Always include a body explaining the *why* and a `Co-Authored-By: Claude …` trailer.

Ship small + push + (Pi pull) + restart. Don't batch a week of work into one commit.

## Bot architecture

The bot is **dumb**. The server tells it what to post, with stable idempotency keys:

```
Pi every 5 min:
  GET /api/whatsapp/due-posts?groupId=X
    → [{ kind, key, ... }]
  for each instruction:
    execute (sendMessage / poll / DM / react)
    POST /api/whatsapp/ack { key, kind, waMessageId }
      → server upserts SentNotification(key)
```

Adding a new bot capability = new entry in the `DueInstruction` union in `src/lib/bot-scheduler.ts` + new case in `whatsapp-bot/src/scheduler.ts` + ACK handler if it needs DB updates. Never put scheduling logic on the bot — server owns "when".

When a bot↔server protocol field changes (new `DueInstruction` kind, new field on existing kind), call out **"needs Pi redeploy"** in the commit body. Older bot builds silently skip unknown kinds; ACK won't resolve until the Pi has the matching code.

## LLM design rules

1. **LLM for understanding, deterministic code for compute.** Classify intent / extract entities / phrase replies → LLM. Score / balance / Elo / cron windows → code. Hybrid (Phase 4 balancer) is usually better than all-LLM when there's a ground-truth right answer.
2. **Don't trust the LLM with anything visible to the group.** Post-process every LLM-emitted reply server-side. Existing post-processors: `enforceProximity` (TZ + temporal phrasing), `enforceCanonicalRoster` (numbered list + count + "need N more"). Prompt rules fail; deterministic rewriters succeed.
3. **Cache aggressively.** System prompt + match/squad context get `cache_control: { type: "ephemeral", ttl: "1h" }`. Only fresh chat history + the current batch are paid in full each call.
4. **Falls open by default.** If the API key is missing or Anthropic errors, return empty/skip — never block the user-visible flow.
5. **Right model for the right job.** Haiku for high-frequency (analyzer batches every 10 min). Sonnet for one-shots (onboarding analyzer, hybrid balancer) — accuracy beats cost on something that runs once per match/org.

## DB access patterns

- Always use the **`aws-1`** Supabase pooler (`aws-1-eu-west-1.pooler.supabase.com`). `aws-0` was the original buggy host.
- Schema changes go through `prisma db push`, not `migrate`.
- Prefer `groupBy` over N+1 query loops; the codebase has a few `getMomSummaries`-style helpers that batch lookups for a list of matches.
- Trim `.env`-loaded secrets defensively — Vercel's dashboard occasionally appends a stray `\n` to pasted values (`AUTH_SECRET`, `EMAIL_FROM` have both been hit).

## Phone normalisation

`src/lib/phone.ts#normalisePhone` strips Unicode bidi marks (U+200E/200F, U+202A-E) before anything else — WhatsApp / iOS contacts silently inject these on paste. Two visually identical numbers compare unequal otherwise. Route every new phone-entry path through `normalisePhone`.

For matching against a stored phone (already E.164), allow suffix matches in either direction so country-code mismatches between "0xxx" and "+44xxx" don't drop signal.

## Schema cascade conventions

When deleting things, walk the right order:
1. `Match` (cascades to `Attendance`, `TeamAssignment`, `Rating`, `MoMVote`, `SentNotification`, `PendingBenchConfirmation`, `RatingAdjustment`).
2. `Activity` (cascades to `PlayerActivityPosition`).
3. `BotJob`, `AnalyzedMessage`, `Sport` (no FK back-pressure but explicit clean-up).
4. `Organisation` (cascades `Membership`).
5. Orphan synthetic users (`onboarding+*`, `provisional+*`, `wa-*` whose only org was the one being deleted) — never real OAuth users.

Use `db.$transaction(async (tx) => …, { timeout: 60_000 })` for anything that spans more than two writes.

## Time / TZ

All user-facing times are **Europe/London**. The cron runs in UTC. `src/lib/london-time.ts` wraps `date-fns-tz` with `londonWallClockToUtc` and `formatLondon` — DST-safe. Plain `setHours(21, 30)` on Vercel produces 21:30 UTC = 22:30 BST in summer; the wrappers prevent that.

`londonHour(at)` and `londonDateKey(at)` are the standard time-of-day / date-of-day helpers used throughout the bot scheduler.

## Idempotency keys

Every queued bot instruction has a stable `key` so the same instruction never fires twice. Format conventions:

- `<matchId>:<kind>` — match-scoped event (e.g. `matchABC:announce-match`).
- `<matchId>:<kind>:<userId>` — per-user DM.
- `<matchId>:<kind>:<dayKey>` — daily firing (`evening-update:2026-04-27`).
- `org-<orgId>:<kind>` — org-scoped (e.g. `org-foo:bot-intro`).
- `botjob-<id>` — ad-hoc admin queue.
- `retro-react-<id>` — RetroReaction queue.

The server records `SentNotification` rows on ACK; the next compute step builds a `sentKeys` set and skips anything already there.

## Sender resolution (analyze route)

`resolveSender(orgId, msg)` runs every inbound message through this chain:

1. **Phone** — exact `User.phoneNumber` lookup (raw → `+` prefix → `normalisePhone`).
2. **Exact name** — case-insensitive equals against memberships in this org.
3. **First-name fuzzy** — relaxed prefix match (one side ≥3, other ≥2). Multiple candidates → return null (don't guess).
4. **`UserAlias`** — admin-curated nickname → user mapping, scoped to org.
5. **Provision** — last resort, only if pushname ≥3 chars.

Soft-removed memberships (`leftAt != null`) are INCLUDED in the candidate set; on a unique match the resolver calls `restoreMembership(membershipId)` to clear `leftAt`. Never filter `leftAt: null` in fuzzy-matcher queries — it creates ghost users.

Aliases are populated automatically by `mergePlayers`: the dropped user's name (and, for provisional ghosts, the email slug) is upserted into `UserAlias` for the kept user. Once-and-done — no manual UI for aliases yet, but the dataset grows organically with merges.

## Time-of-day gates on bot posts

Every bot post that's tied to creation-time of a row (rather than user action) needs a London-hour gate. Otherwise the cron creating the row at 00:00 UTC (= 01:00 BST during BST) fires an immediate notification at 01:20 BST when the bot polls. Concrete examples:

- `announce-match` — only fire `09:00 ≤ londonHour < 13:00`. The `generate-matches` cron creates next week's match nightly; the bot must NOT announce it at 01:20 BST.
- `announce-match` also needs an "is this the soonest unplayed match in the activity?" check — when today's match is still UPCOMING/TEAMS_GENERATED/TEAMS_PUBLISHED, don't announce next week's. Once today's flips to COMPLETED, the next morning's tick picks up the future one.

## DM-reply pipeline (roster surveys, future DM-driven features)

Bot's `message` event handler treats anything not ending in `@g.us` as a 1-1 DM and forwards to `/api/whatsapp/dm-reply` with `{ phone, body, waMessageId, authorName? }`. `fromMe` and empty bodies filtered. Diagnostic `[msg] from=… fromMe=… bodyLen=…` log line on every incoming message — keep it; debugging "did the bot see this?" without it is painful.

Server-side resolver order for inbound DMs:
1. Phone match against `User.phoneNumber` (most accurate; usually @c.us senders).
2. Fallback: pushname-based fuzzy match SCOPED to users with an open `RosterSurveyDM` (or whatever feature owns the active DM context). Never global-pushname-search — too ambiguous.
3. Multiple matches return null (don't guess).

The pushname forwarding is essential because @lid privacy-mode senders arrive with no phone in the JID. Without authorName, the server can't resolve them to a User.

## Org-level feature flags

Some features should be opt-in per org because admins have different workflows. Pattern:

- Add `Organisation.<feature>Enabled Boolean @default(false)` (default OFF — opt-in).
- Gate every server-side side-effect that depends on the feature with `if (!org.<feature>Enabled) return …`.
- Keep the FACING surface (e.g. payment poll posting, survey DM delivery) ungated — those are user-visible and admins might want a half-on state.
- Document the flag's reasoning and which org turned it on/off in the schema doc-comment.

Live examples: `Organisation.paymentTrackingEnabled` (Sutton off, paymentChase + bulkCredit + poll-vote-paidAt all silent). Future `whatsappBotEnabled`, `aiClassificationEnabled`, etc.

## Plain-English UI copy — never invent jargon

The product is multi-tenant / commercialisable. Copy that uses internal terminology ("regulars list", "pencil you in case-by-case", "bench-thin", "@lid") confuses real users and reads like internal Slack chatter. Rule: every user-facing string should describe what the user can DO next, in words a non-technical player would understand on first read.

Caught examples this session:
- "we'll take you off the regulars list" → "The admins will tidy up the roster at the end of the week. If you change your mind before then, just message back here 🙏"
- "we'll pencil you in case-by-case" → "just say IN in the group whenever you want to play that week, no need to confirm in advance"

## LLM classification for natural-language replies

When asking the LLM to bucket a free-text reply (in/maybe/out, intent classification, sentiment), bias toward the LESS DESTRUCTIVE bucket on ambiguity:

- Future-positive hedges ("maybe", "later", "for now", "we'll see", "might") → `maybe` (or whatever the soft option is), NEVER the destructive one.
- Hard `out` requires PERMANENT intent — no hedge, no future window.
- Confidence < 0.7 on anything destructive → force `unclear` and route to clarification prompt.
- If the user might re-engage based on the bot's reply, give them a path: "change your mind? just message back".

Pattern lives in `src/lib/roster-survey-classifier.ts`; same applies to any future destructive-action classifiers.

## Tailscale SSH gotcha

The Pi auto-deploy command is the standing rule. Roughly once a week the Tailscale SSH check expires; the SSH command exits cleanly (`exit 0`) but the actual session prints:

```
# Tailscale SSH requires an additional check.
# To authenticate, visit: https://login.tailscale.com/a/...
tailscale: failed to fetch next SSH action
```

If a Pi pull seems to do nothing despite the script running, look for that line in the output. Ask Kemal to click the URL once; that re-arms the check for another week. Server-side fixes (Vercel-served) keep working in the meantime — only bot-side code changes (`whatsapp-bot/`) need the Pi to be current.

## "Never break the live org" safety

Schema changes go in **strictly additive** — nullable + defaulted columns, new tables — so rolling back is safe. Sutton FC is live production; Kemal's Tuesday match depends on this code working every week.

For destructive operations (drop a column, change a status enum, delete data), check with the user first — even when superadmin tools exist.

## Project rebrand: matchday → matchtime (2026-05-17, via Hermes)

The repo folder was renamed `/Sports/matchday` → `/Sports/matchtime` and package names / UI / env var / prod URL / Pi paths / Vercel scope all rebranded. Consequences to remember:

- **`cd` into the old path fails.** Always use `/Users/kemal/Projects/Cressoft/Sports/matchtime`.
- **Auto-memory symlinks break on rename.** `~/.claude/projects/-Users-kemal-Projects-Cressoft-Sports/memory/{skills,learnings}.md` are symlinks into the repo's `MDs/`. After the rename they dangled until repointed with `ln -sf …/matchtime/MDs/…`. If a future rename happens, fix these first or the memory reads come back empty.
- **Pi paths rebranded too**: `~/matchtime-bot`, `matchtime-bot.service`, host still `matchtime-pi.tail1437f5.ts.net`. Vercel project is now `matchtime` (scope `kemaledizs-projects`).

## Hermes is a co-developer on this repo

Kemal also drives this codebase from a Slack app called **Hermes** (separate sessions; commits authored `Hermes <davidediz@cressoft.local>`). Hermes' memory lives in `~/.hermes/memories/{MEMORY,USER}.md` and its build conventions match ours (Node 20 PATH prefix, `prisma db push`, Vercel+Pi deploy). **Hermes' workflow preference: merge feature branches straight to `main` and push — no PRs unless asked.** When picking up after a gap, `git log --oneline -25` to see what Hermes shipped; check `~/.hermes/memories/` for its latest-feature notes.

## Ad-hoc bot polls + future-dated jobs (BotJob extensions)

`BotJob` is now the universal ad-hoc bot queue, not just text:

- **`kind: "group-poll"`** + `pollQuestion` / `pollOptions String[]` / `pollMulti` — emits a `group-poll` DueInstruction. Bot-side already handled it (payment-poll path), so no Pi change. Used for the feedback-poll round.
- **`sendAfter DateTime?`** (Hermes' reminder feature) — scheduler skips rows whose `sendAfter` is still future, so a `kind=dm` job fires on the right day. NL time → explicit London date via `londonDateTimeToUtc` (DST-safe, in `london-time.ts`), clamped `(now, now+60d]`.

Both reuse the existing `botjob-<id>` ack + idempotency path. Pattern for any future "do X later / post a poll" need: extend BotJob, don't invent a new table.

## Deploy-race: wait for Vercel "Ready" before queueing jobs that need new scheduler code

When a one-off script queues BotJobs that depend on scheduler logic you JUST pushed, the bot's next 5-min poll can fire BEFORE Vercel finished building — old scheduler code silently skips the unrecognised rows, newer ones get picked up a tick later, and messages land out of order (bit Kemal's feedback-poll: follow-up text arrived before the polls). Rule: after pushing scheduler/ due-posts changes, confirm `vercel ls` shows the new deploy **Ready** before running the `--apply` script. Schema (`prisma db push`) is immediate; server CODE is not.

## Analyzer Recent History block

`src/lib/match-history.ts#loadRecentHistory(orgId)` pre-computes per-org stats (every completed non-historical match with score + MoM, MoM-wins leaderboard incl. historical backfill, attendance leaderboard with **total-matches denominator**, Elo top-10 / bottom-5 ≥3 matches). `formatRecentHistoryBlock` renders it into the 1-h-cached context so the LLM can answer "who got MoM last week / most consistent attender / what was the score". Returns null pre-first-match. Extend HERE for new stat questions, not with new prompt rules.

## Per-org feature modules (Phase 1)

Every bot capability is an independent per-org toggle. `Organisation.feature{Attendance,Bench,TeamBalancing,MomVoting,PlayerRating,Reminders,StatsQa}` (+ pre-existing `paymentTrackingEnabled`), all default **true** so existing orgs (Sutton) are unchanged. Resolve via `src/lib/org-features.ts#getOrgFeatures(orgId)` / `getOrgFeaturesByGroup`. Client-safe labels live in `org-features-meta.ts` (no db import) — never import `org-features.ts` into a "use client" file. Three gating chokepoints: (1) analyze `executeVerdict` maps the verdict→module and returns silent when off; (2) `message-analyzer` skips the Recent-History block when `statsQa` off; (3) `bot-scheduler` post-compute filter classifies each DueInstruction by key (`announce-match`/`evening-update`/`chase-`/`pre-kickoff`/`cancel-nudge`/`switch-nudge`/`football-gear-reminder`→attendance, `bench-prompt*`→bench, `mom-*`→momVoting, `rate-*`→playerRating, `payment-*`→paymentTracking) and drops off-module ones; unknown/meta keys (bot-intro, admin DMs, retro-react, botjob) fail-open. Admin → Settings → "Bot features" optimistic toggles via `setOrgFeature`. Score is ungated (infra feeding MoM+ratings).

## Autonomous onboarding (Phase 2)

`@MatchTime setup` in an unconfigured group → in-group Q&A (anyone answers) → creates Sport/Activity/Match + flips Phase-1 flags. `OnboardingSession` (one active per group, stage collecting→features→completed). `src/lib/onboarding-conversation.ts`: **LLM extracts, deterministic code controls** — every step is LLM-INDEPENDENT for progression (groupName/venue captured verbatim at their asked step; players/day/time/recurrence via `regexExtract`; features deterministic-first via regex numbered/keyword map, LLM only for vague phrasing). `regexExtract` is the LLM-down fallback wired into `extract()` on null-key/no-block/throw. Structured fields only auto-fill UNSET; overwriting a set field needs an explicit correction cue (`actually|make it|instead|i meant|…`) so a day word inside a later venue answer can't clobber the real day. analyze route's `handleOnboardingIfApplicable` runs BEFORE the bot-enabled-org gate (tight SETUP_TRIGGER regex; `liveOrg` guard so it can't hijack a configured group; dedupes re-flushed batches by `lastHandledWaId`). `/orgs` returns `onboardingGroups`; bot adds them + dynamically `addMonitoredGroup` on a loose setup pre-filter (so a brand-new group's trigger isn't dropped by the startup-only monitored set).

## Onboarding/feature test harnesses

- `scripts/test-onboarding-suite.ts` — 9 scenarios POSTed to prod `/analyze`, asserts org/activity/feature flags, self-wipes each. The regression gate; must stay 9/9.
- `scripts/test-gating.ts` — synthetic MoM+rating-only org: asserts IN/teams silent in analyze + due-posts has no attendance/bench/teams; asserts Sutton all-on + no shadow session. Non-destructive.
- `scripts/sim-onboarding-remote.ts` — scripted convo vs prod (no WhatsApp). Local `.env` has **no ANTHROPIC_API_KEY** (Vercel only) so always test ONBOARDING against the deployed server, not in-process.
- `wipe-org.ts <slug> --apply` now also clears OnboardingSession.

## Vercel project is still named `matchday`

The rebrand didn't rename the Vercel project. `vercel ls --scope kemaledizs-projects matchday` (NOT `matchtime` — that errors "not a valid project name"). The `●` status glyph doesn't grep cleanly; don't build tight wait-loops on it — push, give it ~1-2 min, verify by re-running the check.

## Bench model: offer-to-all, first-confirm-wins (2026-05-19, replaced the elimination chain)

A confirmed player dropping (cancelAttendance → requestBenchConfirmationOnDrop) opens ONE `BenchSlotOffer` (one row per open slot, carries replacingUserId) broadcast to the WHOLE bench. First bencher to confirm — 👍/IN on the group post, or YES to the per-bencher DM — claims it ATOMICALLY (`benchSlotOffer.updateMany where resolvedAt:null` — first writer wins), gets promoted + the dropped player's TeamAssignment, group announced. `resolveBenchConfirmation({matchId,userId,decision})` is the shared claim entrypoint (reaction/dm-reply/analyze); decline = pure no-op; same return shape as before. NOBODY is ever dropped/eliminated for silence, declining, or being slow. No per-person timers. `sweepExpiredBenchConfirmations` now ONLY closes offers whose match kicked off (drops nobody). Daytime-gated emission (London 08:00–22:00) — a 00:24 drop never pings overnight; offer stays open with no waMessageId until morning. `PendingBenchConfirmation` table kept but legacy/unwritten (additive/rollback-safe). ack maps `offer-<id>` → BenchSlotOffer.waMessageId (and `offer-<id>:dm:<userId>` are the per-bencher DMs, skipped by the ack mapper). Analyzer context: "OPEN BENCH SLOT" block (any listed bencher claims, first wins) — not the old per-user pending list. Regression gate: `scripts/test-bench-offer.ts` (15 assertions, must stay green).

## Roster-survey DM hygiene (learned the hard way 2026-05-19)

Two roster check-in surveys left `status:"open"` since April were still capturing every inbound DM a month later and the "unclear" branch re-sent the SAME clarification on EVERY reply with no cap → 6+ spam DMs, player threatened the bot. Guards now: (a) `/dm-reply` ignores surveys older than 14 days; (b) ONE clarification per person per survey, hard cap (count prior clarification BotJobs by text prefix) then go silent. ALWAYS close a RosterSurvey when done (`status:"closed"`); a forgotten-open survey is a latent DM-spam bomb. `wipe-org.ts` clears them; `scripts/fix-karahan-bench-incident.ts` is the template for closing stale surveys + undoing wrongful drops.

## Onboarding self-introduction (2026-05-19)
First time the bot speaks in a new group (opening `@MatchTime setup` turn — `OnboardingSession` freshly created, `lastHandledWaId==null`, no `groupName`) it leads with an attractive `INTRO` constant in `src/lib/onboarding-conversation.ts` (sells attendance / fair teams / smart bench / MoM & ratings / reminders+stats) THEN appends the first setup question (`withIntro()`). Fires on the opening turn ONLY; all later turns unchanged. The post-setup, feature-accurate `botIntroMessage(features)` in bot-scheduler.ts is separate and unchanged. **Full dress-rehearsal harness:** `scripts/test-amir-lifecycle-remote.ts` (23 checks, live prod, self-wiping) — onboarding intro+flow, MoM/rating-only org provisioned, zero-LLM skip, teamless-match auto-complete via generate-teams cron, post-match feature gate (nothing leaks). Run: `npx tsx --env-file=.env scripts/test-amir-lifecycle-remote.ts`. **Gotcha fixed:** local `.env` `CRON_SECRET` was stale vs Vercel prod (analyze/due-posts use WHATSAPP_API_KEY which matched, so only cron-touching scripts silently 401'd) — synced local `.env` to prod value. Regression gates all green post-change: test-onboarding-suite 9/9, test-gating (Sutton intact), test-amir-lifecycle 23/23.
