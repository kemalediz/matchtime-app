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

## Conversational flows: never depend on LLM nondeterminism for progression (2026-05-19)

Phase 2 onboarding's first cut used the LLM to extract every event field. The QA suite (9 scenarios vs prod) flaked: bare answers ("Test FC Two" with no "we're …") sometimes weren't extracted → Q1 re-asked → a fixed-script conversation ran off the end; and `parsed.featureSelection ?? rx` let a wrong-but-non-null LLM value override the correct deterministic numbered-pick (`??` only falls back on null/undefined — a wrong `[...]` or `""` slips through). Lesson: in a multi-turn flow, **the answer to the question currently being asked must be captured deterministically** — free-text fields (name/venue) verbatim-at-their-step, structured fields by regex — with the LLM as an *enhancement* (multi-field messages, natural language), never the load-bearing path. A flow that needs the LLM to fire correctly N times in a row will fail ~(1-p)^N of the time.

## Removing an over-strict guard can open a clobber bug

To support "actually make it 7 a side", the `!session.X` merge guards were dropped so a field could be overwritten. That let a day word *incidentally* present in a later answer (venue "Tuesday Night Sports Centre", a one-off date "Saturday the 5th") silently overwrite the real match day. Fix = a **correction-cue** gate: overwrite a set field only when the message has an explicit cue (`actually|make it|instead|i meant|no wait|…`). General principle: "allow correction" ≠ "allow any later mention to overwrite" — require intent, not coincidence. Added `venue_with_dayword` as a permanent regression scenario.

## Test what the LLM-down path actually does

The "falls open" comment on the onboarding extractor was wrong — with no `ANTHROPIC_API_KEY` it didn't degrade gracefully, it re-asked Q1 forever. Local `.env` has no Anthropic key (Vercel-only), which is exactly why the in-process sim looped and surfaced it. Always exercise the no-LLM branch; "falls open" must mean *progresses deterministically*, not *returns null into a loop*. The fix (regexExtract wired into every extract() failure path) makes onboarding work even during an Anthropic outage.

## Autonomous QA loop that worked

Build a scenario suite that POSTs to the **deployed** server and asserts DB state (org/activity/flags), self-wiping each run. Iterate: run → read FAILs → fix root cause (not the test) → push → wait for Vercel → re-run, until N/N. Keep the suite as the permanent regression gate (must stay green). Pair it with a non-destructive gating/Sutton-regression test so feature isolation + the live org are both proven every change. Sweep synthetic test orgs/sessions (`qa-/gate-/sim-*` prefixes) at the end — prod should only ever show real orgs.

## Things to NEVER do (additions)
- Don't make a conversational state machine's progression depend on an LLM extraction succeeding — capture the current question's answer deterministically; LLM is the enhancer, not the spine.
- Don't use `a ?? b` to "fall back" when `a` can be a wrong non-null value (empty array, wrong guess). Use an explicit "a is usable?" check.
- Don't drop a `!alreadySet` guard to enable corrections without a correction-cue gate — coincidental later mentions will clobber good data.
- Don't trust `vercel ls` glyph-grep in a tight wait-loop (the `●` status doesn't parse reliably); push, wait ~1-2 min, verify by re-running the actual check. (Project rename `matchday`→`matchtime` completed 2026-05-21 so the project name now matches the brand.)

## Overnight + elimination = the Karahan incident (2026-05-19)

A bench slot opened at 00:24; the old code tagged+DM'd the bencher, ran a 2h timer, and at 01:24 — while he slept — marked him DROPPED and chained to the next (also dropped at 03:24). All three overnight benchers wiped for being asleep; meanwhile two month-old open roster surveys spam-clarified his every reply until he threatened the bot. Three compounding root causes, all now structurally fixed: (1) **never eliminate for silence** — declining/ignoring/slow must never remove someone; the redesign offers to the whole bench, first-come, nobody dropped, ever; (2) **never run engagement logic overnight** — daytime-gate (London 08:00–22:00) anything that pings/times-out a human; a slot opening at 2am waits till morning; (3) **stale state is a spam bomb** — anything with an "open" lifecycle (surveys) needs an age cap + a per-recipient send cap; "re-ask on every unclear reply, forever" is never acceptable. Meta-lesson: when a feature has a timer or a "move on if no response", ask "what happens if this fires at 3am / runs for a month / the person is just asleep?" before shipping.

## Prefer designs with no elimination / no timers when humans are in the loop

The sequential bench chain (ask #1, 2h, drop, ask #2…) was clever but every iteration of it produced an incident (Erdal lost 👎, Karahan dropped asleep). The replacement — broadcast the opening to everyone, first to say yes wins, nobody ever removed — is simpler, fairer, has no overnight edge, far less DM machinery, and matches how a human captain actually fills a spot. When a flow keeps generating incidents, the fix is usually a simpler model, not more guards on the complex one.

## The squad-list ritual IS the labelling system (2026-05-20)

For groups that don't use IN/OUT and instead re-paste the numbered squad with each sign-in (Amir's Thursday shape), the bot can derive ground-truth name↔phone aliases from the DIFF between consecutive lists. The sender of "previous-list + 1 new line" almost always added THEIR OWN name. So that single new line = ground truth for that phone's display name. No fuzzy matching, no admin curation: the group is labelling the data for the bot every time they sign in. This is what unlocked the `~T → "Tharan"` case that no letter-overlap fuzzy could ever bridge. Meta-lesson: when a group has a stable ritual, look for the signal IN the ritual — don't model it as noise.

## Reserves are always guests, never the sender's self (2026-05-20)

When parsing a pasted squad with a `Reserves:` block, attributing the reserve addition to the sender as their own name is the bug. People don't put themselves in their own Reserves section — they put **other** people they're signing in as standby. The first cut of `attributeDiffs` had a "single addition + no string match = it's the sender's nickname" fallback that fired on `Amir → "Reserves: 1. Martin"` and wrongly aliased "martin" → Amir, so when the squad finaliser later tried to write a BENCH row for Martin it resolved back to Amir's CONFIRMED row and the upsert (empty `update: {}`) silently kept it. Fix: split detection — the lone-addition fallback only runs against the **playing-squad** additions; all reserve additions are unconditionally guests. The principle: section semantics inform attribution. The same `addition` means different things in `names` vs `reserves`.

## Vercel cron cap was 3 on Hobby — lifted by moving to Cressoft Pro (2026-05-20 → 2026-05-21)

Original problem (2026-05-20): adding a 4th cron to `vercel.json` failed the deploy with the GitHub status pointing at `vercel.link/3Fpeeb1` → `vercel.com/docs/cron-jobs/usage-and-pricing`. The existing 3 daily crons (`generate-matches`, `generate-teams`, `close-ratings`) kept working; adding `extract-squads` (any schedule) tipped over the limit. **Workaround used:** consolidate — folded squad-extraction into `generate-teams` as a daily backstop.

Resolved (2026-05-21): project transferred from `kemaledizs-projects` (Hobby) to `cressoft` (Pro) so the user's hobby-tier usage warnings stopped and the cron cap rose to 40. The dedicated `/api/cron/extract-squads` schedule (`*/30 * * * *`) was restored and the piggyback in `generate-teams/route.ts` removed. **General lesson:** when a platform cap forces a workaround, document it AND the path to undo when the cap goes — workarounds are easier to ship than to take back later if nobody remembers they exist.

## Long synchronous LLM calls inside `/api/whatsapp/analyze` will time out (2026-05-20)

I tried adding an inline `runSquadExtraction` call inside the analyze route's no-message-driven-features branch (would-have-been timely path for squad-from-list orgs to extract on every fresh paste). On the harness it 500'd around the 4th sequential POST — analyze responses were taking too long when each was awaiting a multi-second Anthropic call. Reverted. Lesson: the analyze route runs on the bot's hot poll path — keep its work tight. For expensive background work, use the cron path or rate-limit aggressively (`<= once per N minutes per org`) with a `SentNotification` lock; never just await a fresh LLM call on every batch.

## Three-layer defence when an LLM is unreliable on a STRUCTURED slot (2026-05-20)

Sonnet kept dropping the `Reserves:` block in extracted lists. Single-fix attempts (stronger prompt, then few-shot example) helped but didn't make it 100%. What worked: layered defence — prompt few-shot for the happy path, server-side merge-by-waMessageId for when the LLM splits one message across multiple entries, AND a deterministic backstop that reads structural section headers from the source body when the LLM still drops them. The deterministic backstop isn't "regex on user intent" (the thing we reject) — it's structural-label parsing of a literal section marker the user typed. That distinction is important: regex IS the right tool when the input has a fixed machine-readable shape; it's the WRONG tool when the input is "what did the user mean".

## When inline triggers are too expensive, batch via cron (2026-05-20)

The squad-extraction is `≤1 Sonnet call per org per cron tick`. The "timely" inline approach turned into 1 call per inbound batch (the bot flushes every ~10 min) — fine cost-wise but timeout-prone. Daily backstop in `generate-teams` gives 1 extraction/day per org, predictable. For Amir's Mon-Wed list-paste rhythm, daily is enough; the final list typically stabilises 8+ hours before kickoff. If we ever need sub-day timing for last-minute Thursday sign-ins we'll add an inline trigger with an explicit per-org rate-limit guard (e.g. SentNotification key `<orgId>:squad-extract-tick:<hour>`), not unbounded fire-on-every-message.

## Don't run Norton (or any consumer-AV "smart firewall") on a Mac that uses Tailscale, WireGuard, or anything VPN-shaped (2026-05-21)

Symptom: `tailscale ping` worked (DERP control plane fine), but ALL TCP and ICMP from the Mac to the Pi's Tailscale IP silently timed out. Both directions. After a long debugging chase we ruled out: Pi-side `iptables`/`nftables` (wide open for `tailscale0`), Tailscale Lock, ACL config, controlplane registration, sshd listening on :22, Pi reboot, tailscaled restart on both ends. tcpdump on `tailscale0` (Pi side) showed **0 packets** received during SSH attempts → packets weren't even reaching the Pi.

Root cause: Norton Security stacked **three** layers of network interception on the Mac. (1) A kernel **Network Extension** (`com.norton.mes.networkextension`) silently dropped new TCP. (2) Userspace daemons `com.norton.filter` / `com.norton.proxy` / `com.norton.hns` did app-level filtering, all kept alive by launchd `KeepAlive=true` (so `killall` was futile — they respawned with new PIDs within seconds). (3) **Norton Secure VPN** registered `utun7` (IP `10.5.0.2`) AND inserted a **default route via `10.5.0.2`** into the kernel routing table. macOS's source-address selection then picked `10.5.0.2` as the source IP even for traffic the most-specific route sent via Tailscale's `utun4` — and the Pi's tailscaled silently dropped packets from non-tailnet source IPs.

What didn't work: disabling Norton's NE in System Settings (only stopped layer 1), killing the daemons (KeepAlive respawn), uninstalling Norton (left the `utun7` interface + default route in the kernel). What DID work: full uninstall + **reboot** (clean network stack with no leftover utun7).

Lesson: consumer AV products on macOS that advertise a "Smart Firewall" or "Secure VPN" assume they OWN the network stack. They install themselves at four layers (kernel NE, userspace filter, transparent proxy, full-tunnel VPN) and the off-switches don't reliably tear them down. Tailscale (and any tunnel-based VPN) becomes silently broken in unintuitive ways — disco pings succeed because Norton routes them through its tunnel by mistake, but real TCP fails. Recommendation: don't install Norton on a Mac you also want to use developer/infrastructure VPNs on. macOS's own Gatekeeper + XProtect + Notarization gives most users sufficient defence.

Meta-lesson on debug strategy: when `tailscale ping --icmp` "works" but real TCP doesn't, don't trust it as proof the data plane is healthy — `--icmp` bypasses the host OS network stack (tailscaled crafts the packet directly). The real data-plane test is `tcpdump` on the destination's `tailscale0` interface during a TCP probe; if 0 packets show up, the failure is on the source's stack, not in transit.

## Duplicate User rows from phone-format drift — the proper multi-layer fix (2026-05-25)

This had recurred several times despite point fixes (Idris had a dup pair, then Omar had one — manifesting as the bot silently no-op'ing on a real drop because sender-resolution matched the wrong User row). The root cause was that `User.phoneNumber` was a free-form `String?` with only a `@unique` constraint at the application layer — so `"+447943789944"`, `"07943 789944"`, and `"+44 7826 286403"` were all "different" values for the same human. Multiple write paths (admin UI, profile edit, onboarding, magic-link signup) each wrote the user's raw input; whichever one wrote first won and the others quietly created a second row.

**Why patching at point-of-use kept failing:** even with `normalisePhone()` in the codebase, every new write site was one more place to forget the call. The set of write paths grows; the set of devs/agents remembering grows in the opposite direction.

**Defence-in-depth fix that actually holds (4 layers):**

1. **Tightened `normalisePhone`** so its output is *total* — always strict E.164 (`+CC<7-15 digits>`) or `null`. No more "passthrough whatever the user typed minus whitespace" — that was the original drift surface. Added: "447XXXXXXXXX" (UK WhatsApp JID format) → "+447XXXXXXXXX"; any input without a derivable `+CC` → null.
2. **Prisma extension `auto-normalise-phone` in `src/lib/db.ts`** — intercepts every `user.create/update/upsert/createMany/updateMany` and runs the data's `phoneNumber` through `normalisePhone`. Single point of enforcement; any TS/JS caller is covered automatically, no per-callsite discipline required.
3. **DB-level CHECK constraint `user_phone_e164`** — `phoneNumber IS NULL OR phoneNumber ~ '^\+[1-9]\d{6,14}$'`. Even raw SQL via `$executeRaw` or psql can't bypass this. Installed by `scripts/normalise-phones-migration.ts --install-constraint` after data is clean.
4. **One-shot migration** (`scripts/normalise-phones-migration.ts`) cleaned existing prod data: 2 dup pairs merged via `mergePlayersCore` (Idris × 2, Omar × 2), 4 junk phones nulled, 1 post-merge sweep rewrote a keeper's stored phone to canonical. Idempotent; safe to re-run; default mode is dry-run.

**Bonus refactor done at the same time:** the merge logic that lived inline in the `mergePlayers` server-action got extracted into `src/lib/merge-players-core.ts` so the migration script can call it without going through the auth wrapper. Both code paths now share one implementation.

**General lesson:** when a class of bug recurs despite "fixes," the fix is almost always at the wrong layer. Point-of-use normalisation is a recipe for drift; canonical enforcement at the storage layer (extension + CHECK) is the only thing that holds. If you find yourself patching the same bug shape twice, stop patching and move the constraint down a layer.

**Test/harness gotcha hit during this:** several harnesses generated synthetic phone numbers with `Date.now().toString(36)`, which inserts letters into the digit string (e.g. `"+447776mnmv0"`). These started failing the CHECK constraint. Fixed by switching to `toString()` (digits only). Anything that synthesises a phone in test/dev code must stay E.164-clean — the constraint won't bend.
