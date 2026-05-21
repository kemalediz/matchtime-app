# MatchTime — Session Handoff (2026-05-19)

> Read this first in a fresh session. It's the single-page context dump for
> everything done/decided in the long 2026-05-11→19 working sessions, plus the
> rules to work by. Long-form source-of-truth still lives in the auto-memory
> (`~/.claude/projects/-Users-kemal-Projects-Cressoft-Sports/memory/`:
> `MEMORY.md`, `project_matchtime.md`, `learnings.md`, `skills.md`,
> `feedback_preferences.md`). `MDs/skills.md` + `MDs/learnings.md` are the
> in-repo, committed copies (symlinked into memory).

---

## 1. What this project is

**MatchTime** — multi-tenant WhatsApp bot + web app that runs amateur football
groups (attendance, team balancing, bench, MoM voting, player ratings,
reminders, stats, payments). Live at **https://matchtime.ai**. Rebrand from
"MatchDay" (2026-04-19). Primary tenant: **Sutton FC** (Kemal's Tuesday game).
Second tenant being onboarded: **Amir's Thursday group** (wants MoM + ratings
ONLY).

### Architecture (the "dumb bot")
- **Web/logic**: Next.js 16.2 beta (Turbopack), Prisma 7.5 + `@prisma/adapter-pg`
  (Supabase Postgres), NextAuth v5, Tailwind v4. Deployed on **Vercel** as
  `cressoft/matchtime` (renamed from `matchday` on 2026-05-21).
- **Bot client**: a Raspberry Pi (`matchtime-pi.tail1437f5.ts.net`,
  `~/matchtime-bot`, `matchtime-bot.service`) running whatsapp-web.js. It is
  DUMB: it polls `/api/whatsapp/due-posts` (~5 min) and flushes batched group
  messages to `/api/whatsapp/analyze` (~10 min), executes returned
  instructions, and ACKs via `/api/whatsapp/ack`. All intelligence is
  server-side.
- **LLM**: analyzer is **Sonnet 4.5** (`claude-sonnet-4-5`); onboarding
  extractor is Haiku 4.5. Prompt caching (1h ephemeral) on system prompt +
  match context.
- **Co-developer "Hermes"**: Kemal also drives this repo from a Slack app.
  Commits authored `Hermes <davidediz@cressoft.local>`, merges straight to
  `main` no PR. Don't be surprised by commits you didn't make.

### Core principle
**LLM for understanding; deterministic code for compute & high-stakes
mutations.** Every recurring failure this project has hit was "LLM reasoned
correctly but skipped/mis-fired the mutation" — fixed with deterministic
guards (safety nets, alias-before-bail, words-must-match-action, regex
fallback, correction-cue, seatbelt), never by "trusting the LLM more".

---

## 2. Rules to work by (Kemal's stated preferences)

1. **Fix the code/prompt, not the symptom.** "Do not send a one-off message,
   just fix the code or prompt, whichever is wrong." One-off scripts are only
   for live-incident remediation, never as the fix.
2. **Never invent rules beyond the spec.** If Kemal asked for a time-based
   trigger, don't also add a buffer-size trigger. Do exactly what was asked.
3. **Think before you fix.** "Don't fix it immediately, think first then fix."
   For anything structural, present the plan and trade-offs first.
4. **Minimal, additive, reversible over big refactors.** Kemal explicitly
   rejected a large analyzer pipeline rewrite ("too much changes… this surgery
   may fail… how confident are you?"). Prefer additive seatbelt guards that
   are instantly revertible.
5. **Words must match action.** If the bot says it did X, it must have done X.
6. **Never silently drop a player.** Nobody is removed for silence, slowness,
   decline, or being asleep. Unresolved attendance → group nudge + admin queue.
7. **Bot voice for group posts.** Messages "from MatchTime" are written in the
   bot's voice, not Kemal's. "This message should come from MatchTime, not me."
8. **Autonomy is expected.** When Kemal says "you're fully autonomous, do the
   entire job and testing yourself" — ship it end to end: code → deploy →
   test against prod → fix → re-test → commit → update memory. Don't wait.
9. **Deploy discipline.** Push → wait for `vercel ls matchtime` **Ready**
   before running prod tests or queueing BotJobs (a deploy-race once caused
   out-of-order poll delivery). The `●` status glyph greps unreliably.
10. **Generic / commercialisable design.** No hardcoded Sutton values; every
    static value must become per-group/dynamic. Disabled features only
    disabled for that one group.
11. **Test against deployed prod.** Local `.env` has **no `ANTHROPIC_API_KEY`**
    (Vercel-only) so onboarding/analyzer can't run locally — harnesses hit the
    deployed server with self-wiping synthetic orgs.

---

## 3. What we built/fixed across these sessions

### Multi-tenant Phase 1 — per-org feature config
- `Organisation.feature{Attendance,Bench,TeamBalancing,MomVoting,PlayerRating,
  Reminders,StatsQa}` + existing `paymentTrackingEnabled`. Default **true** so
  Sutton is unchanged.
- `src/lib/org-features.ts#getOrgFeatures` (+ client-safe
  `org-features-meta.ts`).
- 3 gating chokepoints: analyze `executeVerdict`, Recent-History block,
  bot-scheduler **post-compute key-classified filter** (the single reviewable
  transform that drops off-feature instructions — this is how Amir's group
  runs MoM+ratings only).
- Admin Settings → "Bot features" toggles (`setOrgFeature`).

### Multi-tenant Phase 2 — autonomous in-group onboarding
- `@MatchTime setup` (tight trigger regex) in a group with no live org →
  creates `OnboardingSession` → multi-turn in-group Q&A (anyone answers) →
  provisions Sport/Activity/Match + flips feature flags + `whatsappBotEnabled`.
- `src/lib/onboarding-conversation.ts`: **LLM extracts, deterministic code
  controls**. Every step is LLM-independent for *progression*
  (name/venue captured verbatim-at-step; players/day/time/recurrence regex;
  features deterministic-first). `regexExtract` is the LLM-down fallback wired
  into every `extract()` failure path. Correction-cue gate stops a day word in
  a later venue answer clobbering the real day.
- `handleOnboardingIfApplicable` runs *before* the bot-enabled gate; `liveOrg`
  guard can't hijack Sutton. `/api/whatsapp/orgs` returns `onboardingGroups`
  so the Pi keeps polling in-progress setups across restarts.

### Onboarding self-introduction (the latest piece, 2026-05-19)
- On the **opening** `@MatchTime setup` turn the bot now leads with an
  attractive `INTRO` constant (sells attendance / fair teams / smart bench /
  MoM & ratings / reminders+stats) then appends the first setup question via
  `withIntro()`.
- Fires opening turn ONLY (`isOpening` = stage `collecting` +
  `lastHandledWaId == null` + no `groupName`). Later turns byte-identical.
  The separate, feature-accurate post-setup `botIntroMessage(features)` in
  `bot-scheduler.ts` is unchanged.
- Rationale: a brand-new group can't get proactive posts (no org → no
  due-posts pipeline / BotJob needs orgId), so the `@MatchTime setup` invite
  *is* the "bot entered the group" moment — the intro belongs there.

### Bench redesign (offer-to-all, first-confirm-wins, never-eliminate)
- Old sequential-chain bench code dropped 3 overnight benchers for sleeping
  (Karahan incident). Replaced: `BenchSlotOffer` (one row per open slot)
  broadcast to the WHOLE bench; first to 👍/IN/YES claims it atomically
  (`updateMany` guarded on `resolvedAt:null`); promoted + TeamAssignment
  transfer + group announce. **Nobody is ever dropped** for silence/decline/
  slowness. No per-person timers. Daytime-gated (London 08–22). Sweep only
  closes offers at kickoff. `resolveBenchConfirmation` shared by
  reaction/dm-reply/analyze. Regression gate: `scripts/test-bench-offer.ts`.

### Squad-full announcement
- `src/lib/squad-announce.ts#announceSquadFullIfJustFilled(matchId)` —
  idempotent + atomic (creates `<matchId>:squad-locked` SentNotification
  first, catch→skip). Posts numbered roster + N/N + kickoff. Called from every
  confirm path (`registerAttendance`, `resolveBenchConfirmation`). Re-armed on
  a confirmed drop (the squad-locked key is deleted in `cancelAttendance`).

### "LLM reasons right but skips the action" failure-class fixes
- Prompt rule "NEVER leave registerAttendance null on an in-intent" + server
  safety-net force-IN. Prompt rule "WORDS MUST MATCH ACTION". Consult
  `UserAlias` BEFORE bailing on an ambiguous fuzzy match (both `resolveSender`
  and `resolveOrProvisionByName`). `AnalyzedMessage` is the smoking-gun table.

### SEATBELT — swap ≠ drop
- "swap A with B" / "switch A and B" where BOTH are CONFIRMED is a **team
  swap, never a drop**. `handleTeamSwapIfApplicable(orgId, body)` at the top
  of the per-message loop resolves it deterministically from DB state and
  bypasses the LLM verdict. (Elvin/Abid incident: LLM read it as intent:out,
  dropped Elvin, a bogus bench offer got claimed — remediated live; seatbelt
  prevents recurrence.)

### Cost reduction for feature-light orgs
- Analyze route returns `ignored:"no-message-driven-features"` **before** the
  Sonnet call when an org has none of attendance/bench/teamBalancing/
  reminders/statsQa. Amir's MoM+rating-only group → ~£0 LLM, and
  attendance/bench/teams chatter stays silent.
- `generate-teams` cron auto-completes matches with status in
  `[TEAMS_PUBLISHED, TEAMS_GENERATED, UPCOMING]` (was only TEAMS_PUBLISHED) so
  a team-less MoM-only match actually completes and its post-match flow fires
  (`now >= matchEndTime` guard still applies).

### Other this-session fixes
- Recent-History stats block (`src/lib/match-history.ts`) gated by statsQa.
- `enforceCanonicalRoster` skips leaderboard-shaped "N. Name" blocks.
- Standing conditionals ("I'll be 14th if short") → auto-bench.
- Alias chips in admin/players UI. Ad-hoc polls via
  `BotJob.kind:"group-poll"`. Bench-prompt now DMs the bencher too. Reaction
  route @lid pushname fallback. `/admin/unresolved` queue + badge.
- De-Sutton audit: `botIntroMessage` feature-aware, dropped hardcoded "Ask
  @Kemal"; analyzer "ringing Goals" → "the venue".

---

## 4. Current state (as of this handoff)

- **`main` is green and deployed.** Latest commits: `b86c03f` (onboarding
  self-intro + harness assertions), `69efe73` (in-repo skills.md note). Vercel
  deployment **Ready**; Pi auto-deploys.
- **Live incidents remediated**: Karahan (bench), Elvin/Abid (swap) — both
  fully fixed in the DB via dry-run-then-apply scripts; root causes fixed in
  code.
- **All regression gates pass against deployed prod**:
  - `scripts/test-amir-lifecycle-remote.ts` — **23/23** (incl. intro)
  - `scripts/test-onboarding-suite.ts` — **9/9** scenarios
  - `scripts/test-gating.ts` — all pass, Sutton intact
  - (`test-bench-offer.ts` 15, `test-bench-promote.ts` 6,
    `test-squad-announce.ts` 7, `test-swap-and-skip-remote.ts` 5 — green when
    last run this session)
- **Gotcha fixed**: local `.env` `CRON_SECRET` was stale vs Vercel prod (only
  cron-touching scripts 401'd silently; `WHATSAPP_API_KEY` matched so
  analyze/due-posts worked). Synced local `.env` to prod value.
- **Amir's group is safe to onboard** but has NOT been onboarded — Kemal will
  do that when ready.

---

## 5. How to test (run these in a fresh session)

All hit deployed prod, self-wipe their synthetic orgs. From repo root:

```bash
# Full Amir lifecycle (onboarding intro+flow, MoM/rating-only, zero-LLM skip,
# teamless auto-complete, post-match feature gate) — 23 checks
npx tsx --env-file=.env scripts/test-amir-lifecycle-remote.ts

# 9-scenario onboarding regression gate
npx tsx --env-file=.env scripts/test-onboarding-suite.ts

# Non-destructive feature isolation + Sutton regression
npx tsx --env-file=.env scripts/test-gating.ts

# Bench redesign regression (15 assertions)
npx tsx --env-file=.env scripts/test-bench-offer.ts
```

Wall-clock-gated behaviour (MoM poll at +5d 15:00 London, rating DMs
08:00–09:00 the morning after) can't be force-asserted at arbitrary run time —
covered by the unit suites, not the live lifecycle harness.

Deploy wait pattern after a push:
```bash
vercel ls matchtime   # wait until top Production row shows "Ready"
```

---

## 6. Key files

| Area | Path |
|---|---|
| Analyzer + seatbelt + onboarding router + skip-LLM | `src/app/api/whatsapp/analyze/route.ts` |
| Onboarding state machine + INTRO + extractors | `src/lib/onboarding-conversation.ts` |
| Per-org features | `src/lib/org-features.ts`, `src/lib/org-features-meta.ts` |
| Scheduler, post-compute feature filter, botIntroMessage | `src/lib/bot-scheduler.ts` |
| Bench (offer-to-all) | `src/lib/bench-confirmation.ts`, `requestBenchConfirmationOnDrop` in `bot-scheduler.ts` |
| Squad-full announce | `src/lib/squad-announce.ts` |
| Attendance mutations | `src/lib/attendance.ts` |
| Cron auto-complete | `src/app/api/cron/generate-teams/route.ts` |
| Group-join (members) | `src/app/api/whatsapp/group-join/route.ts` |
| Bot poll list | `src/app/api/whatsapp/orgs/route.ts` |
| Schema | `prisma/schema.prisma` |
| Live-incident scripts (templates) | `scripts/fix-karahan-bench-incident.ts`, `scripts/fix-elvin-swap-incident.ts` |

---

## 7. Open / next steps

- **Onboard Amir's Thursday group** (Kemal does this when ready; harness
  proves it's safe).
- Offered but **not approved**: per-match "undo last bot action" admin button.
- No other pending TODOs. Two-tier (Regulars + Subs) membership was pitched in
  the group as a proposal, not built.

---

## 8. Commands cheat-sheet

```bash
# Deploy status
vercel ls matchtime

# Pull prod env (if local .env secrets drift again)
vercel env pull /tmp/p.env --environment=production --yes

# Lint changed files
npx eslint src/lib/onboarding-conversation.ts

# Commit footer (always)
#   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
