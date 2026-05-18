---
name: Learnings
description: Hard-won lessons from working on MatchTime with Kemal — both about the user and the product
type: feedback
originSessionId: 70ec7d56-8494-404f-90f8-117487d2d23f
---
A condensed digest of what's been learned across many sessions. The detailed source-of-truth is `feedback_preferences.md` (working style) and `project_matchtime.md` (product history). This file is the "if you only had 10 minutes to onboard a new agent" version.

---

## How Kemal works

**Execute autonomously.** Default to commit + push + deploy without asking permission for every step. He's said "do it yourself", "drive my screen", "go ahead". Confirm only on genuinely destructive things (dropping data, force-pushing main).

**Polished UI, never "basic".** First UI pass with small fonts + monochrome + minimal spacing got rejected. Larger base font (~16px), icon accents, progress bars, animation on tap/hover, consistent cards. Don't ship "works but bland".

**Generic + commercialisable.** No hardcoded names, no Sutton-specific text, no "WhatsApp bot" / "Pi" / "LLM" jargon in user-facing copy. Multi-tenant, per-org settings, pluggable sport presets. Help pages = commercial copy.

**Tradeoffs out loud on architecture decisions.** When there are 2-3 real alternatives, lay them out with pros/cons and recommend one. He picks knowingly. For pure implementation choices (which library / component for the same job), just pick.

**NEVER invent rules beyond the spec.** Multiple call-outs on this. If he says "every 10 min, plus urgency flush if kickoff < 1h", do exactly those two — don't add a "buffer-size flush" because it sounds reasonable. If a guard-rail feels useful, ASK before adding it. A safe extra rule is still an unauthorised rule.

**Plain English explanations.** Lead with what the user experienced, not protocol terms. "WhatsApp hid your phone for privacy" beats "the sender came through as @lid". Drop implementation jargon unless he's specifically debugging implementation.

**Optimistic in-place UI updates.** Admin edits (rating, role, phone) should patch local state, not refetch the list. Refetching jumps scroll + loses focus.

**Integer ratings.** `step={1}`, `parseInt`, integer validators. 0.5 was overkill; 1-point gaps are enough for the balancer.

**Apologies fast when the bot embarrassed itself.** When a bot post is clearly wrong, queue a fresh correction message via BotJob — don't try to edit the original (whatsapp-web.js doesn't support edit). Don't lose the group's trust.

**Pick up exactly where the user left off.** When he says "now back to the previous still-to-ship list", re-state the plan briefly as confirmation and execute. Don't make him repeat the items.

## Product principles (hard-earned)

**LLM for understanding, deterministic code for compute.** Phase 4 hybrid balancer is the canonical example: LLM reads chat → per-player rating delta clamped ±2 → deterministic balancer runs with adjusted ratings. Same pattern applies anywhere with a ground-truth right answer.

**Don't trust the LLM with anything visible to the group.** Three separate prompt rules failed in production despite being explicit. Build server-side post-processors that overwrite with truth from the DB. `enforceProximity` (TZ + roster header + temporal phrasing) and `enforceCanonicalRoster` (numbered list + count + "need N more") are the canonical examples.

**False precision is worse than silence.** "14 still haven't paid" was technically correct given paid-state but misleading because the data was incomplete. Gate any derived stat on "we actually have signal" — emit nothing rather than the wrong number.

**Silent-drop is worse than permissive-and-correctable** (for low-stakes writable fields). Score classification works but sender resolution fails → record the score anyway, let an admin correct it later. Reserve strict authorisation for high-stakes / destructive actions.

**Post-match timing matters.** Different buckets have different ideal cadences:
- Payment poll: ASAP (kickoff + duration), not when status flips to COMPLETED.
- Rating DMs + group promo: 08:00 London the morning after. Not midnight.
- MoM announcement: 5 days after match at 15:00 London.
"All match-end posts when status flips" was too coarse.

**One unified 17:00 group post per day per match.** Multiple branches (squad-chase / bench-thin / unpaid) sharing one dedup key (`<matchId>:evening-update:<dayKey>`) — first branch claims the day. Prevents the noise burst that triggered the rule (3 posts at 17:04/09).

**Daily 17:00 must show every player by name.** Numbered confirmed list (1...maxPlayers) + numbered bench list. Players scan + see themselves without scrolling.

**Payment chase stops 1 day before kickoff.** ~5 reminders is enough; closer to match the focus shifts to "tonight's game".

**Poll-only payment chase, no name-and-shame.** Per Sait's suggestion: "tick the poll above to clear it" — never list unpaid names. Don't fire when paid count is 0 (no signal).

**MoM display must show the breakdown.** "X (2 votes)" is misleading when 7 others have 1 vote each. Always show "(N of T votes)" or "shared between X & Y" for ties. DB `groupBy` + `orderBy desc` is non-deterministic on tied counts — sort by name as a stable tiebreaker.

**Slot-emoji map ends at 🔟 then ✅.** Unicode has no single-grapheme keycap for 11+; concatenated keycaps don't render as one reaction; ⚽ (the original fallback) camouflaged among player reactions.

**Soft-removed members RESTORE on next message.** Don't filter `leftAt: null` in fuzzy-matcher queries. When a chosen unique candidate has `leftAt` set, call `restoreMembership(membershipId)` to clear it. Provisioning is for genuinely new names that match nothing in the active or soft-removed roster.

**Resolver never creates ghosts.** Phone first → exact name → first-name fuzzy with relaxed prefix → multiple candidates return null (logged) → provision only when nothing matches AND pushname ≥3 chars.

**Multi-org is first-class.** A user can own / admin / play in many orgs at once. Don't gate onboarding on "doesn't already own an org". Org switcher accepts repeated use; schema is per-membership; UI must match.

## Tech-specific learnings

**Vercel build pipeline:** `src/generated/prisma/` is gitignored. The `build` script runs `prisma generate && next build` so auto-deploys from a git push don't fail with "Can't resolve '@/generated/prisma/client'". CLI `vercel --prod` masked this because it uploaded the locally-generated copy.

**Vercel paste appends `\n` to secrets.** `AUTH_SECRET` and `EMAIL_FROM` have both been hit. Code reads now `.trim()` defensively. Always trim env-loaded secrets on read.

**Build can be silently broken.** Two routes colliding (e.g. `(auth)/onboarding` vs `/onboarding`) makes Turbopack refuse every build but doesn't show in `tsc --noEmit`. Always run `npm run build` (or check `vercel ls`) after pushing.

**Pi auto-deploy IS the rule.** The Pi runs the bot. When it falls behind `origin/main`, every server-side fix appears shipped but isn't actually live for bot-dependent paths. After every push: ssh + pull + restart.

**Pi 5 RTC battery is dead.** Clock resets on cold boot until NTP slews it forward; during that window `apt-get update` and TLS fail. Fix is in `reference_pi.md`. Battery on order; don't substitute a CR2032 (it'll leak on trickle charge).

**`whatsapp-web.js` `fetchMessages` is flaky** on freshly-linked LocalAuth sessions. The catch-up scan logs a warn and skips; inline `message` events work reliably. For historical replay use a one-off script.

**`@lid` privacy senders.** WhatsApp delivers some senders as `<opaque>@lid` instead of `<phone>@c.us`. Phone is unknown — fall back to unique pushname match within the org. The score-write path skips the user-resolution gate (record the score even when sender unresolved).

**Nicknames don't fuzzy-match.** Pushname "Nunu" → DB name "Elnur Mammadov" has zero letter overlap; same for "Mike" → "Michael Allen" (Mike isn't a prefix of Michael). The fuzzy-name layer can never bridge nicknames — it's a letter-overlap algorithm. Use `UserAlias` for these. The alias upsert is wired into `mergePlayers` so admin merges teach the system once-and-done; same pushname next week resolves cleanly with no new ghost.

**Tailscale SSH expires.** Roughly once a week the Pi auto-deploy script silently fails — SSH exits 0 but the session emits "Tailscale SSH requires an additional check. To authenticate, visit: https://login.tailscale.com/a/...". Server-side fixes (Vercel-served) keep working in the meantime; bot-protocol changes need the Pi current. Look for the auth line in the output; ask Kemal to click once.

**Time-of-day gates on bot posts.** Anything that fires off a row-creation event (e.g. `announce-match` when generate-matches creates next week's match) needs a London-hour window, otherwise the cron creating the row at 00:00 UTC = 01:00 BST wakes the group at 01:20 BST when the bot's next poll lands. `09:00 ≤ londonHour < 13:00` is the standard "morning" window. Plus an "is this the soonest unplayed match" check so future-week announcements don't overlap with this-week's ones.

**Next.js 16 beta.** Breaking changes vs training data. Read `node_modules/next/dist/docs/` before guessing API shape. Server actions exported from `"use server"` files MUST be async — non-async helpers go in a separate file (`src/lib/phone.ts` had to move out).

**Prisma 7 generates into the workspace, not `node_modules`.** `src/generated/prisma/` is gitignored. Scripts use `import { PrismaClient } from "../src/generated/prisma/client.ts"` with explicit `.ts` extension because tsx resolves it; plain Node ESM doesn't.

**Migration history is out of sync** from earlier debugging. Use `prisma db push`, not `prisma migrate`.

## Patterns I now reach for instinctively

- **Two queries, then in-memory join.** For list pages, do one `groupBy` + one `findMany({ where: { id: { in: ids } }})` to resolve names — never N+1 inside a `.map`.
- **Pre-compute facts in the prompt.** When the LLM keeps getting kickoff time or roster header wrong, don't add more rules — pre-format the value and inject "Use this exact string: X". Prompt rules can fail; pre-computed strings can't.
- **Audit tables for LLM decisions.** `RatingAdjustment`, `AnalyzedMessage` — store the LLM's output + reasoning so an admin can answer "why did this happen?" later.
- **One-off scripts for everything.** Even the smallest question gets a `peek-*.ts` or `check-*.ts`. Cheap to write, easy to find next time, traceable in git.
- **Idempotency-by-key everywhere bot-related.** `SentNotification`, `BotJob.sentAt`, `RetroReaction.sentAt`, `MoMVote @@unique [matchId, voterId]`. Every queued action has a stable identifier; ACKs mark sent.
- **Falls-open LLM calls.** Helper returns empty/null on any failure; user-visible flow continues with a deterministic fallback. Never block on Anthropic.

## The "LLM reasons correctly but skips the action" failure class (2026-05 — three incidents)

This is the single most important pattern from the May sessions. The analyzer's LLM kept getting the *understanding* right but emitting a verdict that did NOT materialise the DB write — the bot reacted 👍/replied confidently, but no Attendance row was written. The group trusts the words; the squad page disagrees; the player is silently lost until someone notices days later.

Three distinct shapes, all fixed:

1. **Najib (2026-05-08).** Said "In" when squad was 14/14 + bench empty. LLM classified `intent:in` but emitted `registerAttendance:null` with reasoning "this is odd". → Prompt rule **"NEVER LEAVE registerAttendance NULL ON AN 'in' INTENT"** (lists every excuse: full squad, empty bench, odd state, already-registered, history unclear) + **server safety net**: after the LLM call, if `intent==="in" && registerAttendance===null && this is the author's latest msg in the batch && user resolved`, force `"IN"` and warn.

2. **Erdal (2026-05-15).** Hasan asked "should Match time put Erdal to the bench?". LLM replied "Erdal goes on the bench" but emitted `intent:question / action:reply`, no `registerFor`. → Prompt rule **"WORDS MUST MATCH ACTION"**: any reply naming a player + announcing a state change MUST emit the matching `registerFor`. If not taking the action, rephrase as a question ("want me to add X?") — never announce an action you don't execute.

3. **Baki (2026-05-15).** "In" came through with pushname "ba" → fuzzy-matched BOTH Baki and Başar → resolver returned null on ambiguity. LLM was perfect; resolution failed. → **Consult `UserAlias` BEFORE bailing on ambiguous fuzzy** (alias rows are unique per orgId — they disambiguate cleanly). Applied to both `resolveSender` and `resolveOrProvisionByName`.

Meta-lesson: when a bot-action bug report comes in, the LLM verdict is usually RIGHT — look at the execution gate (`if (verdict.X && user)`), the sender resolver, and the deploy state before touching the prompt. `AnalyzedMessage` rows (intent / action / authorUserId / reasoning) are the smoking-gun table — write a `peek-*.ts` against it first.

## Other May learnings

**`enforceCanonicalRoster` must skip leaderboard-shaped blocks.** It rewrites any "N. Name" run with the canonical squad. The Recent-History attendance/MoM/Elo leaderboards are also "N. Name" — got clobbered ("top 3 most consistent" came back as the upcoming squad). Guard: skip the rewrite if any line in the run has ` — `, `%`, "wins", "votes", "matches", or "N/M (". Plus a prompt rule: historical/stats answers carry NO squad roster.

**Attendance % denominator = org's total completed matches, not per-player "matches since first played".** "3/3 (100%)" for a late joiner read identically to "4/4 (100%)" for an ever-present. With the fixed denominator a late joiner correctly shows 3/4 (75%).

**Standing-offer conditionals auto-bench.** "I'll be the 14th if you're short" / "back-up if anyone drops" → `conditional_in` + `registerAttendance:"BENCH"` (not 🤔-and-forget). The existing bench-confirmation DM flow then handles match day. Differentiator: standing-offer mentions the SQUAD/slot; personal-uncertainty ("if my back holds up", "maybe") stays `null` + 🤔. Both flavours in one message → default to the conservative `null`.

**Deploy-race burned a user-visible feature.** Queued feedback-poll BotJobs before Vercel finished building the new `group-poll` scheduler handler → text jobs (old code understood them) delivered, poll jobs skipped till next tick → follow-up landed before the polls. Always confirm `vercel ls` Ready before `--apply`-ing a script that depends on just-pushed scheduler code.

## Things to NEVER do

- Don't filter `leftAt: null` in fuzzy-matcher queries (creates ghost users).
- Don't add a row-creation-triggered bot post without a `londonHour` time-of-day gate (otherwise it fires at 01:20 BST when the cron creates the row at midnight UTC).
- Don't rely on letter-overlap fuzzy to bridge nicknames ("Nunu" → "Elnur"). Use `UserAlias` populated by `mergePlayers`.
- Don't trust LLM-emitted roster, time, or count — post-process server-side.
- Don't post on the bot's behalf without an idempotency key.
- Don't add rules Kemal didn't ask for — if it feels useful, ASK first.
- Don't ship UI in monochrome / small fonts / minimal spacing.
- Don't guess the WhatsApp message author when context is ambiguous (green bubble = the user; ✓ tick = outgoing).
- Don't break the live org's data — schema changes are strictly additive (nullable, defaulted).
- Don't run `prisma migrate` (history out of sync) or use the `aws-0` Supabase pooler.
- Don't skip the Pi redeploy after a push, even for server-only changes.
- Don't ship UI text with internal jargon ("regulars list", "pencil you in case-by-case") — write what the player needs to do next, in plain words.
- Don't classify natural-language replies aggressively when intent is ambiguous. Future-positive language ("maybe", "later", "might", "for now") leans toward `maybe` — never `out`. Removing a member is harsher than keeping them as casual.
- Don't build infrastructure for opt-in-only features (payment tracking, future tier system, etc.) without an org-level flag. Default OFF; orgs that want it flip the flag. Some clubs prefer offline tracking — respect that.
- Don't pitch magic-link forms for "click to confirm" UX without considering trust. Players DM'd by a bot find clicks suspicious; replying-in-DM with LLM-classification feels natural and works.
- Don't drop @lid privacy-mode senders. WhatsApp delivers some DMs with phone hidden in the JID. Always forward the pushname alongside any phone field so the server can fall back to name-based resolution scoped to the relevant context (e.g. open survey DMs).
- Don't surface the bot's diagnostic console.logs as an afterthought — `[msg] from=... fromMe=... bodyLen=...` on every incoming message has earned its keep multiple times for "did the bot even see this?" debugging.
- Don't let the LLM announce an action it didn't execute. A confident reply with no matching `registerFor`/`registerAttendance` write is the worst failure mode — the group trusts words, the DB disagrees, the player vanishes for a week. Words must match action.
- Don't let the resolver bail on ambiguous fuzzy without first checking `UserAlias` — admin-curated aliases are unique per org and exist precisely to break ties.
- Don't `--apply` a one-off that depends on just-pushed scheduler/due-posts code until `vercel ls` shows the deploy Ready. Schema push is instant; server code isn't; the bot polls every 5 min and will half-process the queue.
- Don't assume the project path/name is stable — it was rebranded matchday→matchtime mid-stream. Auto-memory symlinks dangle on rename; repoint before relying on memory reads.
