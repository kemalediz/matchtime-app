# Autonomous Onboarding — Design & Phased Plan (2026-06-12)

**Goal:** make MatchTime self-onboarding. Adding the bot to a WhatsApp group should be
the *entire* setup ceremony; the dashboard should guide (not assume) everything else.
The metric we optimise is **Time To First Match (TTFM): elapsed time + admin actions
from "bot enters group" to "first match exists, roster populated, features live."**

This is a design doc only — no code or schema was changed alongside it.

---

## Part A — Audit: what exists today

### A.1 The two onboarding paths that exist

#### Path 1 — Chat ("Phase 2") — `@MatchTime setup`

| Piece | File | What it does |
|---|---|---|
| Trigger pre-filter (bot) | `whatsapp-bot/src/index.ts:392-420` | An **unmonitored** group's messages are dropped unless a message mentions the bot/`match time` AND says `set up / setup / get started / onboard`. On a hit, `addMonitoredGroup()` starts forwarding that group. |
| Authoritative trigger (server) | `src/app/api/whatsapp/analyze/route.ts:2581` (`SETUP_TRIGGER`, `handleOnboardingIfApplicable`) | Runs **before** the bot-enabled-org gate. Creates an `OnboardingSession` (stage `collecting`) for a group with no live org; while a session is active, every batch routes to onboarding, not the analyzer. |
| State machine | `src/lib/onboarding-conversation.ts` (`handleOnboardingTurn`) | Deterministic stages `collecting → features → completed`. LLM (claude-haiku-4-5) extracts field values only; regex fallback (`regexExtract`) keeps it progressing if Anthropic is down. |
| Persistence | `prisma/schema.prisma:240` `OnboardingSession` | groupName, venue, dayOfWeek, kickoffTime, playersPerSide, recurrence, oneOffDate, selectedFeatures, lastHandledWaId. |
| Provisioning | `provisionOrgAndAskFeatures()` + `completeOnboarding()` in `onboarding-conversation.ts` | Creates Organisation + Sport (from `SPORT_PRESETS`), then Activity + first Match, maps the feature menu picks to the `feature*` columns, sets `featureSquadFromList` (derived), flips `whatsappBotEnabled=true`. |
| Post-completion intro | `src/lib/bot-scheduler.ts:383` `botIntroMessage()` | The feature-accurate "MatchTime bot is live" group post, fired once via the `org-{orgId}:bot-intro` idempotency key. |
| QA harness | `scripts/sim-onboarding.ts`, `scripts/sim-onboarding-remote.ts`, `scripts/test-onboarding-suite.ts` (9 scenarios: happy_basic, everything, except_payments, multifield_one_message, mid_flow_correction, chitchat_between, numbered_feature_pick, oneoff_match, venue_with_dayword) | Drives the real flow against synthetic groups, asserts resulting org/activity/flags, wipes after. |

**The conversation today** (8 admin messages minimum):

1. `@MatchTime setup` (the magic phrase — must be known in advance)
2. club name → 3. players per side → 4. day → 5. time → 6. venue → 7. weekly/one-off
   (each a separate question via `nextEventQuestion()`)
8. feature menu pick (8 numbered options; "everything" / "all except payments" supported)

On the **opening turn only**, the bot prefixes its first question with a sales-y
self-intro (`INTRO` const, `onboarding-conversation.ts:73`) — so a feature pitch DOES
exist, but it only appears *after a human already knew to type the magic phrase*.

**What chat onboarding does NOT do today (the real gaps):**

1. **Nothing happens when the bot is added to a group.** The wweb.js `group_join`
   handler (`whatsapp-bot/src/index.ts:541`) filters the bot's own JID out of
   `recipientIds` AND gates on `isMonitoredGroup()` — a self-add to an unknown group
   is fully invisible. The product moment with maximum attention ("we just added a
   bot, what does it do?") is dead air.
2. **No admin is ever assigned.** `completeOnboarding()` creates Org/Sport/Activity/
   Match but **zero Membership rows**. The org has no OWNER. Consequences cascade:
   `findOrgAdminsWithPhone()` returns `[]`, so group-join admin DMs, daily
   provisional-review DMs, switch-format/cancel nudges, and the Stripe fee-ask all
   silently no-op. Nobody can log into `/admin` for this org without manual DB surgery.
3. **The roster starts empty.** `sync-participants` runs only on **bot startup** and
   only for orgs returned by `/api/whatsapp/orgs` at that moment. A freshly onboarded
   org gets no participant import until the Pi bot restarts; players trickle in via
   `group_join` events and message-driven provisioning instead.
4. **The group name is asked even though we know it.** `groupSubject` is plumbed into
   `OnboardingTurnInput` but never used; Q1 asks "what should I call your club?" when
   the WhatsApp subject is sitting right there.
5. **Sender identity is dropped.** `handleOnboardingIfApplicable` maps inbound
   messages to `{waMessageId, authorName, body}` — `authorPhone` (present in
   `InboundMessage`) is discarded, so the flow *couldn't* assign an admin even if it
   wanted to.
6. **Discoverability ≈ zero.** In practice the trigger has been typed by Kemal, and
   when it wedged (Amir's group, @-mention body bug) the fallback was a hand-rolled
   provisioning script — `scripts/onboard-amir.ts` exists precisely because the
   autonomous path failed and re-asking the admin "would look weird in front of the
   group". That script is the canonical evidence of the current owner-time cost.

#### Path 2 — Web (`/onboarding` wizard + `/create-org`)

- `src/app/onboarding/page.tsx` — 5-step wizard seeded from a **WhatsApp chat
  export** (.txt upload): parse authors → review players/seed ratings → optional LLM
  insights (`src/lib/onboarding-analyzer.ts`, claude-sonnet-4-5: positions, seed
  ratings, schedule, payment holder) → schedule (sport preset, day/time/venue) →
  confirm → `createOrgFromWizard()` atomically creates Organisation + **OWNER
  membership** + Sport + Activity + Users + Memberships.
- `src/app/create-org/page.tsx` — bare manual alternative.
- Auth: Google OAuth / email+password / WhatsApp-OTP account claim
  (`src/app/(auth)/claim/page.tsx`, `src/app/actions/claim.ts`).

**Web path gap (the biggest one in the whole system):** there is **no self-serve way
to connect a WhatsApp group**. `whatsappGroupId`/`whatsappBotEnabled` are displayed
read-only on `/admin/settings`; wiring them is a developer/DB task. A web-onboarded
org cannot reach the product's core value (the bot) without Kemal.

### A.2 Everything an admin must configure (zero → running a match)

| # | Step | Where | Writes |
|---|---|---|---|
| 1 | Account + org | `/login` → `/claim` → `/create-org` or `/onboarding` | User, Organisation, Membership(OWNER), Sport |
| 2 | Feature flags (12 toggles) | `/admin/settings` → `setOrgFeature()` (`src/app/actions/org.ts`) | `featureAttendance/Bench/TeamBalancing/MomVoting/PlayerRating/Reminders/StatsQa`, `paymentTrackingEnabled`, `paymentCollectionEnabled`, `payMethodPayByBank/Card/Direct` (`featureSquadFromList` is derived-only, correctly hidden) |
| 3 | Team labels | `/admin/settings` → `setOrgTeamLabels()` | `Organisation.teamLabels` |
| 4 | Activity | `/admin/activities` → `createActivity()` (`src/app/actions/activities.ts`) | name, sportId, dayOfWeek, time, venue, deadlineHours (default 5), matchDurationMins (default 60), feePerPlayer |
| 5 | Players | `/admin/players` → `createPlayer()` per player; or wait for `group_join` / `sync-participants` / analyzer auto-provision; phones at `/admin/players/phones`; seed ratings at `/admin/players/ratings`; positions at `/admin/players/positions` | User + Membership rows |
| 6 | First match | `/admin/activities` "Generate match" → `generateMatchesForActivity()`; thereafter daily `/api/cron/generate-matches` rolls weekly fixtures | Match |
| 7 | WhatsApp link | **no UI — developer task** | `whatsappGroupId`, `whatsappBotEnabled` |
| 8 | Payments (paying orgs) | `/admin/settings`: pick money collector (`setPaymentHolder`), "Connect bank" (`startCollectorOnboarding` → Stripe Express), per-activity fee | `paymentHolderId`, `stripeConnectAccountId`, `stripeChargesEnabled`, `Activity.feePerPlayer` |

### A.3 Friction map — where the time actually goes

Ranked by real cost (owner wall-clock, observed from the scripts/ graveyard and
session handoffs):

| Rank | Friction | Cost today |
|---|---|---|
| F1 | **WhatsApp group ↔ org linking is a developer task** (no UI, no pairing flow; `onboard-amir.ts` = 250 lines of one-off code for ONE group) | Hours of Kemal per org; blocks everything downstream |
| F2 | **No trigger on bot-add** — admin must be told the magic phrase out-of-band | A coordination round-trip per org; most groups would never discover it |
| F3 | **No admin/OWNER from chat onboarding** — dashboard access + every admin DM feature dead until manual fix | DB surgery per org |
| F4 | **Empty roster at completion** (sync only on bot restart) | Either a Pi restart per org or weeks of trickle-in; admin name/phone cleanup at `/admin/players` regardless |
| F5 | **8-message interrogation, one field per question** — group name asked despite knowing the subject; recurrence asked when "weekly" is the 95% answer | ~5–10 min of stilted group chat; each question is a drop-off opportunity |
| F6 | **12 individual feature toggles** with no recommended bundle on the dashboard (chat has "everything"; web has nothing) | Decision fatigue; admins don't know what half the toggles mean until they've seen them run |
| F7 | **Web wizard needs a chat export** — good for rich seeding, heavy as the *mandatory* path | 10–15 min + a "how do I export a chat?" support question |
| F8 | **No first-run guidance in `/admin`** — blank stat tiles, no checklist, no "what next" | Admin doesn't know matches auto-generate, doesn't find phones/ratings pages |
| F9 | Stripe/payments setup is fine (Express link works) but unreachable from chat and unprompted on the dashboard | Paying orgs stall at "connected nothing" |

**TTFM today, honestly estimated:**

- Chat path (when it works, and someone knows the phrase): ~10 min of chat **+
  hours-to-days of owner involvement** to assign the admin, fix the roster, and
  verify — in practice every real org so far (Sutton FC, Sutton Lads) was provisioned
  or repaired by hand.
- Web path: ~30–60 min of admin time across 6 pages **+ a developer dependency** (F1)
  before the bot does anything at all.

**TTFM proposed:** add bot → 2–3 replies in-group → **~3 minutes, zero owner
involvement**, roster pre-filled, first match scheduled, admin holding a magic-link
into the dashboard.

---

## Part B — Design: chat-driven autonomous onboarding

### B.1 Principles (carried over from `MDs/learnings.md`)

- **LLM for understanding, deterministic code for control.** The state machine stays
  in code; the LLM only extracts fields. Regex fallback everywhere (already the
  pattern in `onboarding-conversation.ts`).
- **Never depend on LLM nondeterminism for progression.** Every stage advances on a
  deterministic condition; every prompt re-asks with static copy on LLM failure.
- **Don't ask what we already know.** Group subject = club name. Bot-adder = default
  admin. Weekly = default recurrence. Participant list = roster.
- **Falls open, never blocks the group.** No consent → bot stays silent and dormant;
  the group is never spammed.

### B.2 New trigger: the bot detects being added

`whatsapp-web.js` fires `group_join` with the actor in `notification.author` and the
added members in `recipientIds`. Today the self-JID is filtered out; instead:

```
client.on("group_join", ...):
  if recipientIds includes selfId AND !isMonitoredGroup(groupId):
      → SELF-ADD. Collect: groupId, chat.name (subject),
        notification.author (the adder's JID → phone),
        chat.participants (same phone/lid/pushname extraction as the
        startup sync sweep, index.ts:114-152)
      → POST /api/whatsapp/bot-added  (new route)
      → addMonitoredGroup(groupId)
      → post the returned intro text to the group immediately
  else: existing behaviour unchanged
```

**`POST /api/whatsapp/bot-added`** (new, `src/app/api/whatsapp/bot-added/route.ts`):

1. If a bot-enabled org already exists for `groupId` → ignore (re-add of the bot to a
   live group; optionally re-fire `botIntroMessage`).
2. If an active session exists → return its current question (idempotent re-add).
3. Else create `OnboardingSession` with new fields: `source="group-add"`,
   `stage="introduced"`, `groupSubject`, `addedByPhone`, `participants` (JSON
   snapshot). Return `{ introText }` for the bot to post.

**Fallbacks (belt and braces, because wweb.js events are flaky):**

- Keep the existing `@MatchTime setup` trigger untouched — it now *resumes/creates*
  the same flow (`source="setup-trigger"`, skipping straight past the intro).
- The dashboard pairing code (Part C) is the third entry point.
- `/api/whatsapp/orgs` already returns `onboardingGroups` so mid-flow groups survive
  Pi restarts — keep that contract.

### B.3 The intro message (actual copy)

Posted the moment the bot lands in the group. Skimmable, non-native-friendly, sells
then asks ONE question that doubles as consent + feature selection + admin capture:

> 👋 Hey! I'm **MatchTime** — I run the boring parts of your game so nobody has to.
>
> Here's what I can do:
> ⚽ **Squad list** — say "in" or "out" here; I keep the list and chase when we're short
> ⚖️ **Fair teams** — balanced sides from real player ratings, posted before kickoff
> 🪑 **Bench** — someone drops? I offer the spot; first to claim it plays
> 🏆 **Man of the Match + ratings** — quick vote and a one-tap rating link after each game. No app to install
> 💳 **Payments** — I track who's paid, or collect match fees by link *(optional)*
> ⏰ **Reminders & stats** — "remind me Thursday", "who won MoM last week?"
>
> **Want me running here?** Whoever runs this group, just reply:
> • **YES** — switches on the usual setup (squad list, fair teams, bench, MoM, ratings, reminders)
> • **EVERYTHING** — the lot, including payment tracking
> • or name just the parts you want — e.g. *"just MoM and ratings"*
>
> Not interested? Ignore me and I'll stay quiet. 🤐

Notes on the copy: every feature is ≤1 line; the recommended bundle is the *first*
option so "YES" is the path of least resistance; payments are explicitly optional
(the most common carve-out, per the existing "everything except payments" handling);
the opt-out line removes social pressure and matches the falls-open principle.

### B.4 The state machine

New `OnboardingSession.stage` values (superset of today's; existing values keep
working so in-flight sessions and the test suite don't break):

```
introduced ──(feature reply)──▶ details ──(day+time+venue known)──▶ completed
    │                              │
    │ 7 days silence (cron)        │ "@MatchTime setup" already covers re-entry
    ▼                              ▼
 dormant                       abandoned (existing)
```

| Stage | Bot asks | Accepts | Deterministic writes on exit |
|---|---|---|---|
| `introduced` | (the intro above) | "YES" / "EVERYTHING" / "everything except payments" / named features / numbered picks — **reuses the existing regex+LLM feature extraction verbatim** (`regexExtract` featureSelection + `EXTRACT_PROMPT`) | • `selectedFeatures` ← bundle or picks (YES → attendance, bench, teamBalancing, momVoting, playerRating, reminders; statsQa is always-on per commit 3917f00)<br>• **Admin capture:** replier's `authorPhone` → `normalisePhone` → upsert User (placeholder email pattern from `group-join/route.ts:83`) → `adminUserId` on session. If the replier is @lid (no phone): fall back to `addedByPhone`; if that's also empty, park admin assignment and pick it up at completion via the dashboard claim flow (`/claim` already does WhatsApp-OTP merging).<br>• `groupName` ← `groupSubject` (no question asked) |
| `details` | **One combined question:** *"Done — you're the admin 🎽 One thing I need: **when and where do you play?** One message is fine, like: 'Thursdays 9pm at PowerLeague Shoreditch, 7-a-side'."* Follow-ups only for individually missing fields (existing `nextEventQuestion()` shrinks to day/time/venue/format). | Multi-field extraction **already works** (`multifield_one_message` scenario passes today). Defaults: `recurrence="weekly"` unless "one-off/just this once" stated (drop the question — F5); `playersPerSide=7` if unstated for football with a confirm-in-summary ("7-a-side — say 'actually 5-a-side' to change"). | Field-by-field session updates exactly as today (`canSet` + correction-cue rules unchanged). |
| `completed` | Completion summary (below) | — | Everything `completeOnboarding()` does today **plus**: ① `Membership` upsert `role="OWNER"` for `adminUserId` (or ADMIN if an OWNER exists — multi-org rules respected); ② **roster import**: run the `sync-participants` upsert loop over the session's `participants` snapshot (refactor the loop out of `src/app/api/whatsapp/sync-participants/route.ts` into `src/lib/participant-sync.ts` so both call sites share it); ③ queue a `BotJob` DM to the admin with a `signMagicLinkToken` link into `/admin` (pattern: provisional-review DM, `bot-scheduler.ts:~530`); ④ existing `org-{id}:bot-intro` group post still fires via the scheduler. |

**Completion message (actual copy):**

> ✅ **All set!** I'm live for **{GroupName}** with: *{feature labels}*.
>
> 📅 First match: **{Day} {time}** at **{venue}**{, every week}.
> 👥 I've added the **{N} people** in this group to the squad — no need to type anyone in.
>
> {AdminName}, I've sent you a private link to your admin page — player names,
> ratings and payments live there. Everyone else: just chat normally, say **"in"**
> when you're playing, and I'll handle the rest. ⚽

**Per-case handling:**

- **"YES"** → recommended bundle (everything except the two payment flags).
- **"EVERYTHING"** → bundle + `paymentTrackingEnabled`. (`paymentCollectionEnabled`
  is *never* chat-set — it requires Stripe; the admin DM + dashboard own it. The
  completion DM mentions it when payments were picked: "Want me to *collect* the
  money too? Connect a bank from your admin page — takes 2 minutes.")
- **"everything except payments"** → existing regex branch, unchanged.
- **Named/numbered picks** → existing mapping, unchanged, including the derived
  `featureSquadFromList` rule (MoM/ratings without attendance).
- **Nobody replies** → silence. A single nudge after 24h ("Still here if you want me
  — reply YES to get set up 👋", idempotency-keyed), then `dormant` after 7 days via
  a small sweep in the daily cron. `@MatchTime setup` or a re-add reactivates.
- **Group already has an org** → `bot-added` ignores (today's behaviour for the
  setup trigger, kept).
- **Multiple people answer** → state machine already accepts answers from anyone;
  admin = whoever gave the feature/consent reply (deterministic, explainable). The
  admin can promote others later at `/admin/players` (`updatePlayerRole`).

### B.5 Schema changes (additive only)

```prisma
model OnboardingSession {
  // existing fields unchanged …
  source        String   @default("setup-trigger") // "group-add" | "setup-trigger" | "dashboard-pair"
  groupSubject  String?            // WhatsApp subject at add time
  addedByPhone  String?            // notification.author → E.164
  adminUserId   String?            // captured admin (User.id)
  participants  Json?              // [{phone?, lidId?, pushname?}] snapshot at add time
  introNudgedAt DateTime?          // 24h re-nudge idempotency
}
```

`stage` is already a free string — `introduced`/`details`/`dormant` need no
migration beyond the new columns. No `Organisation` change needed for Phase 1.

### B.6 Why this can't regress the live analyzer

- The entire flow lives **before** the org gate in `analyze/route.ts` and only
  engages for groups with **no bot-enabled org** — Sutton FC and every live group
  short-circuit past it exactly as today.
- `SETUP_TRIGGER` regex is untouched; the new entry point is a separate route.
- `handleOnboardingTurn` changes are additive stages; the existing
  `collecting`/`features` branches stay for in-flight sessions and the 9-scenario
  suite (which gets new scenarios, not edits).
- The Pi-bot change is one new branch inside the existing `group_join` handler; the
  human-join path is byte-identical.

---

## Part C — Design: dashboard guided setup (parity)

### C.1 Shape: a checklist-driven wizard, derived from data

No stored step counter — **derive completion from the DB** so the checklist is always
truthful and survives chat-vs-web mixing:

```ts
// src/lib/setup-progress.ts (new)
type SetupStep = { key: string; done: boolean; href: string; cta: string };
getSetupProgress(orgId): {
  steps: [
    features:   org has had any setOrgFeature OR was chat-onboarded (proxy: selectedFeatures on a completed session, else "visited settings") — default "done" with the recommended bundle applied at org creation,
    activity:   db.activity.count > 0,
    whatsapp:   org.whatsappGroupId != null && whatsappBotEnabled,
    players:    active memberships ≥ playersPerTeam (enough for one side),
    firstMatch: db.match.count > 0,
    payments:   only listed when paymentCollectionEnabled; done when stripeChargesEnabled,
  ],
  pct, nextStep
}
```

### C.2 Surfaces

1. **`/admin` home card** (`SetupChecklist` component, top of
   `src/app/admin/page.tsx`): progress bar + the steps with one-tap CTAs. Dismissible
   (`Organisation.setupDismissedAt DateTime?` — one new column), auto-hidden at 100%.
   This replaces the current blank-stat-tile first run (F8).
2. **`/admin/setup` wizard** (new route, client component): first-run redirect target
   when `pct < 50` and not dismissed. Four screens, each one screen = one decision:
   - **Features** — the same FEATURE_META cards, but led by a single
     **"Use the recommended setup"** button (squad list, fair teams, bench, MoM,
     ratings, reminders — identical to chat's YES bundle) via a new
     `setOrgFeatureBundle(orgId, "recommended" | "everything" | keys[])` server
     action (thin loop over the `FEATURE_COLUMN` map in `src/app/actions/org.ts`).
     Each card reuses the `blurb` copy so chat and web describe features identically.
   - **First activity** — prefilled form (sport preset 7-a-side football, day/time
     blank, deadlineHours 5, duration 60); submits the existing `createActivity` and
     immediately offers **"Generate the first match"** → existing
     `generateMatchesForActivity`. One screen, two existing actions.
   - **Connect WhatsApp** — the F1 killer, see C.3.
   - **Players** — if WhatsApp connected: "your group members import automatically —
     here's who I found" (read-only list + link to `/admin/players/phones` for
     cleanup). If not: the manual `createPlayer` quick-add, plus a link to the
     chat-export wizard (`/onboarding`) repositioned as the *power tool* for seeding
     ratings/positions, not the mandatory path (F7).
3. **"Do it for me" shortcuts**: every wizard screen has a skip that applies the
   default (recommended bundle / 7-a-side preset / auto-import) — the wizard can be
   completed with 4 taps + one day/time/venue form.

### C.3 Self-serve WhatsApp pairing (the single biggest unlock)

New flow so no human ever edits `whatsappGroupId` again:

1. Wizard step shows: "Add **+44 7… (MatchTime)** to your WhatsApp group" → then
   either path completes the link:
   - **Path A (zero-code):** the bot's self-add fires `bot-added`; the dashboard step
     polls `getSetupProgress` and flips green when a session/org for *some* group is
     pending claim. Because the web org already exists, `bot-added` detects "adder's
     phone == an OWNER/ADMIN phone of an unlinked org" and instead of starting chat
     onboarding posts: *"This group is now connected to **{OrgName}** ✅"* and sets
     `whatsappGroupId`/`whatsappBotEnabled`, imports participants, fires the intro.
   - **Path B (explicit code, for phone-mismatch/@lid cases):** dashboard shows a
     6-char code (new `Organisation.pairingCode` + `pairingCodeExpiresAt`, server
     action `generatePairingCode`); anyone posts `@MatchTime pair AB12CD` in the
     group; the bot's loose pre-filter adds `pair` to its keyword set; a new server
     branch in `handleOnboardingIfApplicable` matches the code → links org ↔ group,
     imports participants, posts the intro. Code single-use, 24h TTL.
2. Either path ends in the same place as chat onboarding's completion: linked org,
   imported roster, scheduled intro post.

### C.4 Reuse guarantee (chat/web parity by construction)

One shared layer, two thin frontends:

| Capability | Shared function (new/existing) | Chat caller | Web caller |
|---|---|---|---|
| Feature bundle | `setOrgFeatureBundle` (new, wraps `FEATURE_COLUMN`) | `completeOnboarding` | wizard Features screen |
| Activity + first match | `createActivity` + `generateMatchesForActivity` (existing) | `completeOnboarding` (refactor to call these instead of inline `db.activity.create`) | wizard Activity screen |
| Roster import | `importParticipants(orgId, participants[])` (new `src/lib/participant-sync.ts`, extracted from the route) | completion step | pairing completion |
| Admin assignment | `ensureOrgAdmin(orgId, userId, role)` (new tiny helper) | `introduced` exit | org creation (already OWNER) |
| Feature copy | `FEATURE_META` blurbs (existing) | feature menu | wizard cards |

---

## Part D — Friction-reduction analysis (opinionated)

**The top 5 friction-killers, ranked by impact:**

1. **Self-serve WhatsApp pairing (F1).** Nothing else matters while linking a group
   requires Kemal. Chat path: solved by the bot-add trigger creating the org itself.
   Web path: solved by pairing (C.3). This single change converts MatchTime from
   "Kemal-operated service" to "product". *Impact: removes hours-to-days of owner
   time per org; unblocks any growth at all.*
2. **Bot-add = onboarding trigger (F2) + admin capture (F3).** The intro posts itself
   at the moment of maximum attention, and the YES-replier becomes OWNER with a
   magic-link DM into the dashboard. Kills the magic-phrase coordination and the
   "org with no admin" dead-end (which currently disables five admin-DM features
   silently). *Impact: TTFM from "days, assisted" to "minutes, unassisted".*
3. **Roster auto-import at completion (F4).** The participants snapshot travels with
   the session; completion upserts the whole group via the shared
   `participant-sync` loop. The admin never types a player name; cleanup (phones for
   @lid members, seed ratings) becomes optional polish, prompted by the existing
   provisional-review DM. *Impact: eliminates the single largest admin data-entry
   task (15–30 min/org) and the bot-restart dependency.*
4. **One-tap recommended bundle, both surfaces (F5/F6).** "YES" in chat; "Use the
   recommended setup" on the dashboard. Eight decisions become one, with the same
   bundle and the same blurbs in both places. Payments stay opt-in and are *offered*
   at the right moment (completion DM / wizard step) rather than buried in toggles.
   *Impact: removes the most drop-off-prone screen and the most confusing one.*
5. **Ask only what we can't know (F5).** Group subject = name (skip Q1); weekly =
   default (skip Q7); 7-a-side = football default with cheap correction; one combined
   "when & where" question with field-level follow-ups only for gaps. 8 questions →
   **2 replies** in the happy path. *Impact: chat setup drops to ~90 seconds and
   stops feeling like a form.*

**TTFM scoreboard (estimate):**

| | Current chat | Current web | Proposed chat | Proposed web |
|---|---|---|---|---|
| Admin actions | know phrase + 8 replies + (no admin/roster → owner fixes) | ~25+ clicks across 6 pages + chat export + **developer for WhatsApp** | add bot + 2–3 replies | 4 taps + 1 form + add bot to group |
| Elapsed | hours–days (owner-gated) | hours–days (owner-gated) | **~3 min** | **~10 min** |
| Owner (Kemal) time | hours | hours | **0** | **0** |

**Measure it:** TTFM is computable from existing timestamps —
`OnboardingSession.createdAt → first Match.createdAt` (chat) and
`Organisation.createdAt → first Match.createdAt` (web), plus
`participants count vs memberships created` for import coverage. Phase 4 adds a tiny
read-only report (script or `/admin/shadow`-style internal page); no new tables
needed.

**Defaults policy (sensible-defaults-everywhere, made explicit):** deadlineHours 5,
matchDurationMins 60, ratingWindowHours 120, recurrence weekly, sport
football-{N}aside preset by stated side-count else 7, team labels from preset,
statsQa always on, paymentTracking off, paymentCollection off until Stripe, name =
group subject, admin = consent-replier (fallback: bot-adder). Only day, time, and
venue are *unknowable* — so only they are mandatory questions.

---

## Part E — Phased implementation plan

Each phase ships independently and leaves the system strictly better.

### Phase 1 — "Adding the bot IS the onboarding" ⭐ build this first

The smallest slice that kills F2+F3+F4+F5 at once. Touches no live-analyzer code path
for existing orgs.

| Change | File(s) |
|---|---|
| Self-add detection branch in `group_join` (+ participants/subject/author collection, reusing the startup-sync extraction) | `whatsapp-bot/src/index.ts` |
| New `POST /api/whatsapp/bot-added` (idempotent; creates session `stage="introduced"`; returns intro text) | `src/app/api/whatsapp/bot-added/route.ts` (new) |
| New API client fn `postBotAdded` | `whatsapp-bot/src/api.ts` |
| Stages `introduced`/`details`/`dormant`; consent+bundle parsing ("YES"/"EVERYTHING" on top of existing feature regex); combined when&where question; subject-as-name; weekly default; admin capture from `authorPhone`; OWNER membership + roster import + magic-link DM at completion | `src/lib/onboarding-conversation.ts` |
| Pass `authorPhone` through to onboarding turns (1-line mapping fix) | `src/app/api/whatsapp/analyze/route.ts` (`handleOnboardingIfApplicable`) |
| Shared `importParticipants()` extracted from sync route | `src/lib/participant-sync.ts` (new), `src/app/api/whatsapp/sync-participants/route.ts` (refactor to call it) |
| Schema: `source`, `groupSubject`, `addedByPhone`, `adminUserId`, `participants`, `introNudgedAt` on OnboardingSession | `prisma/schema.prisma` + migration |
| 24h nudge + 7-day dormant sweep | small block in `src/app/api/cron/generate-matches/route.ts` (already daily) or `computeDuePosts` |
| New suite scenarios: `bot_added_yes_bundle`, `bot_added_everything`, `bot_added_named_picks`, `bot_added_ignored_then_nudge`, `admin_capture_lid_fallback`, `combined_when_where`, plus re-run all 9 existing | `scripts/test-onboarding-suite.ts`, `scripts/sim-onboarding.ts` |

Risks & mitigations:
- *wweb.js self-add event unreliable* → keep `@MatchTime setup` + (Phase 2) pairing
  as redundant entries; log every `group_join` payload on the Pi for a week.
- *@lid adder/replier (no phone)* → fall back chain (replier → adder → dashboard
  claim); never block completion on admin phone, just skip the magic-link DM and
  surface "claim your admin account" in the group completion message.
- *Analyzer regression* → all changes are in the pre-gate onboarding path or the Pi's
  unmonitored-group branch; run the existing 9 scenarios + a Sutton smoke
  (replayed batch) before deploy.

### Phase 2 — Self-serve WhatsApp pairing + setup checklist card

- `generatePairingCode` server action + `Organisation.pairingCode/pairingCodeExpiresAt/setupDismissedAt` columns.
- `pair` keyword in the Pi pre-filter; pairing branch in `handleOnboardingIfApplicable`; adder-phone == org-admin auto-pair in `bot-added`.
- `src/lib/setup-progress.ts` + `SetupChecklist` card on `/admin` (`src/app/admin/page.tsx`).
- Settings page: replace the read-only WhatsApp section with "Connect a group" (code + instructions).

### Phase 3 — Dashboard guided wizard (full parity)

- `/admin/setup` route + screens (C.2), `setOrgFeatureBundle` action, refactor
  `completeOnboarding` to call `createActivity`/`generateMatchesForActivity`
  (shared-layer table in C.4).
- First-run redirect from `/admin` when progress < 50% and not dismissed.
- Reposition `/onboarding` (chat-export) as the optional "seed ratings & positions
  from your chat history" power tool, linked from the Players step.

### Phase 4 — Payments handoff, telemetry, polish

- Completion-DM Stripe prompt → deep link to the settings payments section; fee-ask
  already exists (`{matchId}:fee-ask`).
- TTFM + import-coverage report script (`scripts/report-ttfm.ts`, read-only).
- Re-engagement: dormant-session "still here" on next bot re-add; copy iteration on
  intro/nudge based on real conversion.
- Optional: conversational corrections post-setup ("change kickoff to 8pm") — the
  analyzer already has admin fast-paths; add a settings-patch intent gated to admins.

### Test/rollout strategy (all phases)

`sim-onboarding.ts` for local conversation dry-runs → `test-onboarding-suite.ts`
against the deployed API (synthetic groups, auto-wiped) → a throwaway real WhatsApp
group with the bot on the Pi → then announce. The live orgs are protected
structurally (org gate) — every deploy still gets a Sutton replay smoke before being
called done.
