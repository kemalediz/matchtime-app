# Social / location-based features — design (2026-06-12)

**Status: DESIGN ONLY — no code, no schema changes shipped with this doc.**

Goal: let a club that is short for a game reach **opted-in players from other
groups who are physically nearby** — without ever leaking anyone's phone
number, roster, or location to a club they didn't choose to share it with.
This dovetails with the parallel autonomous-onboarding design
(`MDs/autonomous-onboarding-design-2026-06-12.md`): onboarding is where the
venue gets captured as a real place, and the consent opt-in is a feature an
admin/player can switch on afterwards.

Product owner's brief: *"Bring players from nearby groups based on location —
IF users are open to share their phone with others"*, with venues captured as
Google Maps addresses so the bot can detect players nearby.

---

## Part A — Audit: what exists today

### A1. Venue / location

- `Activity.venue` is a **required free-text `String`** (`prisma/schema.prisma`
  ~line 349). Onboarding falls back to `"TBD"`
  (`src/app/actions/onboarding.ts:254`). No lat/lng anywhere in the schema; no
  `Venue` model.
- Venue is captured in three places, all free text:
  - **WhatsApp onboarding conversation** — `src/lib/onboarding-conversation.ts`
    asks *"Where do you play — the venue name?"* (line ~490) and takes the
    answer verbatim (`.slice(0, 120)`), per the hard-won "deterministic capture
    at the step, LLM only as enhancement" rule (learnings.md ~line 154).
  - **Onboarding analyzer** — `src/lib/onboarding-analyzer.ts` infers `venue`
    from chat history (never invents one).
  - **`/admin/activities`** — plain `<input>` (`page.tsx` line ~288), saved by
    `src/app/actions/activities.ts`.
- No Maps/Geocoding usage anywhere in the repo. `.env` has Google **OAuth**
  creds only (`GOOGLE_CLIENT_ID/SECRET`); no Maps key.
- **Reusable sibling pattern (CressoftSchedule):** the Schedule app enabled the
  Google Calendar API on the shared GCP project `cressoft-recruitment` and
  reused the `n8n-prod-vm@cressoft-recruitment.iam.gserviceaccount.com` SA with
  an extra scope. Precedent: *enable the API on `cressoft-recruitment`, keep the
  credential server-side*. For Maps the credential type differs — Geocoding /
  Places use **API keys**, not service accounts — but the project, billing and
  enablement workflow are identical.

### A2. Recruit flow (the extension hook)

`src/lib/recruit.ts` → `inviteRecentPlayers(orgId)`:

1. Finds the next upcoming match; **capacity guard** bails when
   `openSlots = maxPlayers − confirmed ≤ 0` (hardened 2026-06, commit
   `151accd`, together with the tightened `looksLikeRecruitRequest()` regex
   trigger).
2. Candidates = distinct CONFIRMED attendees of the last 3 completed matches
   **in the same org**, minus anyone who already responded, minus anyone
   without a phone.
3. Per candidate: idempotency via `SentNotification` key
   `"<matchId>:recruit-dm:<userId>"`, then a `BotJob {kind:"dm"}` with a
   short-link magic URL (attendance orgs) or "reply IN in the group" copy.

This is exactly the right seam for a cross-group stage: *same-org recruits
exhausted + still short* is a computable condition at the end of this function.
The `BotJob` queue, `SentNotification` idempotency, `ShortLink` magic links and
`getOrgFeatures()` gating are all reusable as-is.

### A3. Player identity across orgs

- `User.phoneNumber` is **globally unique, E.164-enforced** at three layers
  (normaliser, Prisma `auto-normalise-phone` extension in `src/lib/db.ts`, DB
  CHECK `user_phone_e164`). One human = one `User` across all clubs.
- `Membership` is the per-org edge (role, `leftAt`, `provisionallyAddedAt`,
  `lastSeenInGroupAt`) — so "guest from another club" maps naturally onto a
  provisional membership.
- **Notable audit finding:** `User.matchRating` (Elo) and `seedRating` are on
  `User`, *not* `Membership` — a player's rating already silently travels
  across clubs today. Reputation portability half-exists by accident; see B5/risks.

### A4. Consent / privacy primitives

- **`Membership.ratingDmOptOut` (+`At`)** — the freshest pattern: per-club,
  deliberately narrow scope documented in the schema comment, set via a DM
  keyword fast-path in `/api/whatsapp/dm-reply` (~line 305), helper
  `setRatingDmOptOut()` in `src/lib/notification-prefs.ts` returns the batch
  result so the bot **only acks after the write lands**. The new consent flag
  should copy all four habits (default-off, narrow documented scope, keyword
  fast-path, ack-after-write).
- **No raw numbers in any LLM/group context** — enforced in
  `src/lib/dm-qa.ts`: admin Q&A may surface only a boolean "📵 no number on
  record" flag, never digits; the prompt refuses contact details even under
  instruction-injection. learnings.md doubles down: don't trust the LLM with
  anything group-visible; deterministic server post-processors own the truth.
- **`@lid` privacy-mode senders** are a live reality — some users' numbers are
  hidden even from us. Any design assuming "we always have a number" is wrong.
- No user-level discoverability/visibility flag exists today. `isActive`,
  `onboarded`, `isSuperadmin` only.

---

## Part B — Feature design

### B1. Venue geocoding (structured venues)

**Schema: a new global `Venue` model + nullable FK from `Activity`.** Not
lat/lng columns on `Activity`, because a physical venue is shared — two clubs
playing at the same PowerLeague is itself the strongest possible "nearby"
signal (distance zero), and dedup by Google Place ID gives us that for free.

```prisma
/// A real-world place where games happen. Global (NOT org-scoped) and
/// deduped by Google Place ID, so two orgs at the same pitch share one
/// row — which is exactly the signal cross-group discovery wants.
/// Contains no personal data: safe to share across orgs by design.
model Venue {
  id               String   @id @default(cuid())
  /// Google Place ID — stable dedupe key. Null for manual/unresolvable pins.
  googlePlaceId    String?  @unique
  name             String                 // "PowerLeague Shoreditch"
  formattedAddress String?
  lat              Float
  lng              Float
  /// "places-autocomplete" | "geocoded-freetext" | "manual-pin"
  source           String   @default("geocoded-freetext")
  activities       Activity[]
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
}

model Activity {
  // ... existing fields unchanged; `venue` String stays as the display name
  venueId String?
  venueRef Venue? @relation(fields: [venueId], references: [id])
}
```

- **Back-compat:** `venueId` is nullable; the free-text `venue` string remains
  the display value everywhere it's shown today. Nothing breaks for existing
  activities; un-geocoded venues simply don't participate in nearby features.
- **Capture points:**
  - `/admin/activities` — add a Places **Autocomplete** field next to the
    venue input (or simpler v1: geocode-on-save of the typed string with a
    "📍 matched: PowerLeague Shoreditch, E2 — correct?" confirm row). Admin can
    clear the match if wrong.
  - **Onboarding (dovetail):** the onboarding flow keeps capturing the venue
    name verbatim (deterministic-capture rule), then a *non-blocking* server
    step geocodes it (Places Text Search biased to the org's country/region)
    and the bot confirms in-channel: *"Found it — PowerLeague Shoreditch,
    Whiston Rd E2 📍 — that the one?"* 👍 binds `venueId`; 👎/silence leaves it
    null and onboarding continues unaffected. The onboarding design doc should
    call a shared `resolveVenue()` helper rather than owning geocoding itself.
  - **Backfill:** one-shot `scripts/backfill-venue-geocode.ts` (dry-run
    default) geocodes existing `Activity.venue` strings; anything ambiguous
    ("the park", "school cages") is left null for an admin to fix in the UI.
- **API / GCP:** enable **Places API (New)** + **Geocoding API** on
  `cressoft-recruitment` (Calendar API precedent). New restricted API key →
  `GOOGLE_MAPS_API_KEY` (server-side env on Vercel; if client-side
  Autocomplete is used, a second key referrer-restricted to the app domains).
  Volume is tens of calls/month — comfortably inside Google's free tier
  ($200/mo credit ≈ 40k geocodes); still set a budget alert.
- **Distance math:** plain Haversine in app code over `lat/lng` doubles. With
  tens of venues and hundreds of users, **no PostGIS** — fetch candidates and
  filter in TypeScript (`src/lib/geo.ts`, ~15 lines). Supabase has PostGIS if
  this ever needs an index; don't pay that complexity now.

### B2. Player location signal — "where is a player near?"

Options weighed:

| Signal | Accuracy | Invasiveness | Effort | Verdict |
|---|---|---|---|---|
| **Derived home venues** — venues of matches the player actually attended (Attendance→Match→Activity→Venue) | Good (revealed preference: they demonstrably travel there) | **Zero** — no new data collected | Low (a query) | **Primary** |
| Explicit home area — **postcode district only** ("SM1", "E2"), geocoded to its centroid | Good | Low (coarse, ~1–2 km blur; deliberately NOT full postcode) | Low | **Optional refinement** at opt-in |
| Device GPS | Best | High — wrong for a WhatsApp-first product; nothing to attach it to | High | **Rejected** |

**Rule:** a player is *near* venue V if **any of their home venues is within
R km of V**, or (if set) their **home-area centroid is within R km**. Home
venues = venues of their CONFIRMED attendances in the last ~6 months across
*all* their orgs (cap at the 5 most recent distinct venues).

- Default **R = 10 km** (urban-tuned; matches "would actually travel on a
  weeknight"). Per-player override `nearbyRadiusKm` (clamped 1–30) offered at
  opt-in: *"How far would you travel for a game? (default 10 km)"*.
- Data minimisation: the derived signal stores **nothing new** — it's computed
  from attendance history we already hold. The postcode district is the only
  new datum and it's optional and coarse. This is the lightest signal that
  works, and it self-heals: play somewhere new, your "near" follows you.

### B3. Consent / phone-sharing model — **MT-brokered, double opt-in (recommended)**

Two tiers considered:

- **(a) MT-brokered invite — RECOMMENDED, and the only tier to build.**
  MatchTime DMs the opted-in player *on behalf of* the short club. The club
  never sees the player's number — or even their existence — unless the player
  accepts. On accept the player is added to the match; contact details flow
  only with a further explicit yes. MT (which already holds the number — it's
  how the bot DMs them) acts as the trusted broker; consent boundaries are
  enforced in deterministic server code.
- **(b) Full phone-sharing / directory** — opted-in players' numbers visible
  to nearby club admins. **Rejected**: irreversible disclosure (a number,
  once seen, can't be un-shared), a roster-harvesting magnet, and a GDPR
  data-minimisation failure when (a) delivers the same outcome. Do not build,
  even as an "advanced" toggle.

**Consent flag — per-User, default OFF:**

```prisma
model User {
  // Cross-club discoverability for nearby games. Default OFF — explicit
  // opt-in only. Narrow scope (documented like ratingDmOptOut): being
  // discoverable means MatchTime ITSELF may DM you about nearby games,
  // at most NEARBY_INVITES_PER_WEEK times. It does NOT expose your
  // number, name, or existence to any other club until you accept a
  // specific invite, and your number only on a further explicit yes.
  discoverableNearby     Boolean   @default(false)
  discoverableNearbyAt   DateTime?            // consent timestamp (GDPR record)
  discoverableConsentVer String?              // version of the consent copy shown
  nearbyRadiusKm         Int       @default(10)
  homeAreaLabel          String?              // "SM1" — postcode DISTRICT only
  homeAreaLat            Float?
  homeAreaLng            Float?
}
```

Per-**User**, not per-Membership: discovery is inherently cross-club; a
per-club flag would be incoherent ("discoverable from club A's perspective but
not B's" is meaningless when the inviter is a club you're in *neither* of).
The org-side has its own flag (B4) so a club controls whether it *uses* the
feature; the player controls whether they're *reachable* by it.

**Opt-in surfaces** (any of):
- DM keyword to the bot: "find me games nearby" / a prompt the bot offers
  after a player has been active a while;
- `/profile` toggle with the full consent copy;
- end of player onboarding (dovetail: the onboarding design may *offer* it,
  never pre-tick it).

**Consent copy (explicit, GDPR-grade):** *"If a game near you is short, I can
message you — max 2 a week. Other clubs never see your number or name unless
you say yes to a specific game. Reply STOP NEARBY anytime to switch this off.
OK?"* Record `discoverableNearbyAt` + `discoverableConsentVer`; ack only after
the write lands (the `setRatingDmOptOut` habit).

**Opt-out:** "STOP NEARBY" (or natural-language equivalent) DM fast-path in
`/api/whatsapp/dm-reply`, mirroring the rating opt-out; plus the `/profile`
toggle. Opting out also cancels any pending invites. Erasure request → flag
off, `homeArea*` nulled, `NearbyInvite` rows anonymised.

**UK GDPR posture:** lawful basis = **consent** (explicit, recorded, versioned,
revocable as easily as given). Purpose limitation: the flag authorises exactly
one thing — MT-sent nearby-game DMs. Data minimisation: no new location data
beyond an optional coarse district; no number crosses orgs without a second,
per-occasion yes. Google Maps is a processor only for venue strings (no
personal data sent — venue names/addresses only, never player data).

### B4. Cross-group "fill my game" flow

**Org-side gate:** new `Organisation.featureNearbyFill Boolean @default(false)`
(joins the existing feature-flag block, gated via `getOrgFeatures()`), toggled
in `/admin/settings` and offered in the onboarding feature menu. Both sides
must be on: org flag AND player consent.

**Trigger — extends `inviteRecentPlayers()`:** after the same-org loop, if
`featureNearbyFill && maxPlayers > 0 && openSlots > 0` and **same-org recruits
are exhausted** (zero new invites queued this call, or a follow-up sweep finds
the match still short ≥2 h after the same-org blast and ≥3 h before kickoff),
run `inviteNearbyPlayers(matchId)` from a new `src/lib/nearby.ts`. The admin
confirmation message says what happened: *"Squad's still short — I've also
pinged 4 nearby players who are open to guest games 🤞"* (count only — never
names, never which clubs).

**Matching pipeline (deterministic server code — explicitly NOT LLM; the
existing "no raw numbers / rosters in any LLM context" rule extends to this
entire feature):**

1. Venue must be geocoded (`Activity.venueId` set) — else skip silently.
2. Candidates: `User` where `discoverableNearby && isActive && phoneNumber != null`.
3. **Exclude** anyone with *any* Membership in the short org (left or not) —
   same-org people are the normal recruit path; ex-members left for a reason.
4. **Exclude** anyone who already has an Attendance on this match, an
   unresolved `NearbyInvite` anywhere, or a declined/expired invite from this
   org in the last 30 days.
5. **Distance:** near per B2, using `min(playerRadius, orgConfigured ≤ 30) km`.
6. **Availability heuristic:** exclude players with a CONFIRMED attendance at
   any match overlapping this slot (±2 h). Don't try to model free time beyond
   that — declining is one tap.
7. **Rate caps (hard):** ≤ **2 nearby invites per player per 7 days across all
   orgs**; ≤ 1 per player per match; ≤ **10 invites per match**; ≤ 2 fill
   campaigns per org per week. All enforced by counting `NearbyInvite` rows.
8. **Rank** by distance asc, then recency of last match played, then
   `|candidate.matchRating − org's avg|` asc (better games for both sides);
   take the top `min(openSlots × 2, 10)`.

**Invite DM (from MatchTime, club anonymous-ish — venue/time/format only, no
roster, no group identity beyond the activity name):**

> ⚽ A game near you needs a player — *7-a-side at PowerLeague Shoreditch, Thu
> 19 Jun 21:30* (£7). You're ~3 km away. Want in? Reply **YES** to grab the
> spot or **NO** to pass. (You get these because you opted into nearby games —
> reply *STOP NEARBY* to switch off.)

**Accept path (the broker handshake):**

1. Player YES → re-check the slot is still open (first-come; on a lost race:
   "ah, just filled — I'll keep you in mind 🤝", invite outcome `lost-race`).
2. Create `Membership` (role PLAYER, `provisionallyAddedAt = now`, new column
   `joinedVia String?` = `"nearby-fill"`) + `Attendance` CONFIRMED. The guest
   shows up in the squad list like anyone else; the existing provisional-member
   admin surface already handles review/removal.
3. Notify the org admin **without the number**: *"Ali (guest via nearby
   invite, played 14 MatchTime games, shows up 95% of the time) has taken a
   spot 👍"*.
4. **Contact exchange only on mutual yes:** bot asks the guest *"Want me to
   share your number with the organiser so you can coordinate? Otherwise I'll
   relay anything important."* Yes → number shared to the admin DM +
   `NearbyInvite.sharedContactAt` set (the admin requested the fill, which is
   their half of the handshake). No → MT relays venue/door-code/cancellation
   messages itself. Numbers never appear in the org's group, web UI, or any
   LLM context regardless.
5. Drop-out / no-show: normal drop flow; the guest's reliability record (B5)
   carries it.

**New model:**

```prisma
/// One cross-group nearby invite. Doubles as the rate-limit ledger,
/// the consent audit trail, and the anti-abuse record.
model NearbyInvite {
  id              String    @id @default(cuid())
  matchId         String
  match           Match     @relation(fields: [matchId], references: [id], onDelete: Cascade)
  orgId           String                       // denormalised: per-org cooldowns survive match deletion
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  distanceKm      Float
  sentAt          DateTime  @default(now())
  respondedAt     DateTime?
  /// "accepted" | "declined" | "expired" | "lost-race" | "cancelled" | "reported"
  outcome         String?
  sharedContactAt DateTime?                    // mutual-consent number share
  @@unique([matchId, userId])
  @@index([userId, sentAt])                    // weekly cap query
  @@index([orgId, userId, sentAt])             // per-org cooldown query
}
```

Reply handling: YES/NO/STOP NEARBY/REPORT keyword fast-paths in
`/api/whatsapp/dm-reply` keyed off the user's most recent open `NearbyInvite`
— deterministic first, LLM never load-bearing (learnings rule). Invites expire
at `min(kickoff − 1 h, sentAt + 24 h)`.

### B5. Broader social features — brainstorm + priority

Ranked by value ÷ (effort × privacy risk):

| # | Feature | Value | Effort | Privacy risk | Call |
|---|---|---|---|---|---|
| 1 | **Cross-group fill-my-game** (B4) | High — directly saves games from cancelling, the #1 pain | Medium | Managed by broker model | **Build (Phase 2)** |
| 2 | **"Find a game near me"** — player DMs the bot; it lists open slots within R km at orgs that set a new `listOpenSlotsNearby` flag. Pull-based inverse of #1: zero spam (player-initiated), reuses all Phase-1/2 data. Joining still runs the B4 accept path. | High | Low (once #1 exists) | Low — exposes only org-approved listings (activity, venue, time, slots count), no people | **Build (Phase 3)** |
| 3 | **Reliability passport** — cross-club "shows up" stats already derivable (games played, kept-vs-dropped %, no-shows). Shown to a host org when a guest accepts; arguably required for #1 to feel safe. | Medium-high | Low (a query + copy) | Low — aggregate counts, no content | **Build (Phase 2, as part of the accept notification)** |
| 4 | **Player guest-profile** — positions (exists: `PlayerActivityPosition`), preferred formats, availability windows ("weeknights after 8"), preferred venues. Sharpens #1 matching + #2 results. | Medium | Low-medium | Low (shared only on accept) | Phase 3–4 |
| 5 | **Rating portability** — a guest's level travels. *Audit finding: `matchRating` is already global on `User`*, so this half-exists. But raw cross-club Elo is unfair (1100 in a strong league ≠ 1100 in a casual kickabout — pools never mix, so ratings aren't comparable). Show a **coarse band** ("solid regular", "occasional") + games count to the host, never the number; longer-term, per-context rating or a cross-pool normalisation. | Medium | Medium (fairness design is the hard part) | Medium — a number following you across communities is reputationally sensitive | Phase 4; **decide guest-game Elo policy in Phase 2** (recommend: guest appearances do NOT move `matchRating` until pools are comparable) |
| 6 | **Open-slots web feed** (`/nearby` page) | Medium | Low after #2 | Low (same data as #2) | Phase 4 |
| 7 | **Club-to-club friendlies** — MT spots two orgs within ~5 km on the same night/format and brokers an admin-to-admin intro (both flags on; no rosters exchanged) | Medium-high but infrequent | Medium | Low-medium (org identity is shared — needs its own org-level consent) | Phase 4, exploratory |
| 8 | Device-location / live "players around me now" map | — | High | **Unacceptable** | Never |

---

## Part C — Privacy, safety, abuse guardrails

1. **Consent defaults OFF, everywhere.** `discoverableNearby` (player),
   `featureNearbyFill` + `listOpenSlotsNearby` (org) all `@default(false)`.
   Onboarding may offer, never pre-tick.
2. **Numbers never cross orgs without the per-occasion mutual yes** (B4 step
   4). Until then MT relays. Numbers never in group messages, never in another
   org's web UI, and — extending the existing `dm-qa.ts` rule — **never in any
   LLM context**, alongside a new rule: *nearby candidates' names/existence
   never enter an LLM prompt either*. Matching, invites, accept/decline are
   all deterministic server code.
3. **Anti-spam caps** (B4 step 7): ≤2 nearby invites/player/week globally,
   ≤1/player/match, ≤10/match, ≤2 campaigns/org/week, 30-day per-org cooldown
   after a decline. **3 consecutive ignored invites → auto-pause** the
   player's discoverability and confirm by DM ("paused these — reply RESUME
   if you still want them").
4. **No roster harvesting.** The short org never sees candidates — not a
   count-by-name, not a list, only "N players pinged" and, later, who
   *accepted*. The bot's Q&A refuses "who's nearby?" / "list opted-in players"
   for everyone including superadmins-via-DM. Org admins cannot query other
   orgs' members through any surface; `NearbyInvite` rows are visible only to
   superadmin tooling.
5. **Block/report.** Reply **REPORT** to any nearby invite → outcome
   `reported`, org excluded from inviting that player permanently, and after
   **2 distinct reporters** the org's `featureNearbyFill` auto-suspends
   pending superadmin review. New orgs (< 4 weeks old, or no completed
   matches) can't use nearby fill at all — kills the fake-club harvesting
   vector.
6. **Easy out:** "STOP NEARBY" fast-path (ack only after the write, per the
   `setRatingDmOptOut` precedent); `/profile` toggle; opting out cancels
   pending invites.
7. **Audit trail:** `NearbyInvite` is the ledger (who, when, how far, outcome,
   contact-share timestamp) + `SentNotification` idempotency keys
   (`"<matchId>:nearby-dm:<userId>"`); consent timestamp + copy version on
   `User`.
8. **GDPR:** consent basis, recorded + versioned; coarse-district-only home
   area; erasure clears flags + `homeArea*` + anonymises invite rows; Google
   receives venue strings only, never personal data; privacy-policy page
   updated before Phase 2 goes live.

---

## Part D — Phased plan

### Phase 1 — venues become places + consent primitive exists *(smallest valuable slice; no cross-club behaviour yet)*

The point: get the **data** (geocoded venues) and the **consent** (opt-in)
live and accumulating before any matching ships.

- **Schema:** `Venue` model; `Activity.venueId` (nullable);
  `User.discoverableNearby/At/ConsentVer`, `nearbyRadiusKm`, `homeArea*`.
  All additive/nullable — zero impact on existing rows.
- **GCP/API:** enable Places API (New) + Geocoding API on
  `cressoft-recruitment`; restricted `GOOGLE_MAPS_API_KEY` env on Vercel;
  budget alert.
- **Critical files:** `prisma/schema.prisma`; new `src/lib/geocode.ts`
  (`resolveVenue(text, biasRegion)` — shared with the onboarding design) +
  `src/lib/geo.ts` (haversine); `src/app/actions/activities.ts` +
  `src/app/admin/activities/page.tsx` (geocode-on-save + confirm/clear UI);
  onboarding hook per B1 (coordinate with the onboarding doc — it should call
  `resolveVenue()`, not own geocoding); `scripts/backfill-venue-geocode.ts`;
  `/profile` opt-in card + consent copy; "STOP NEARBY"/opt-in keyword
  fast-paths in `/api/whatsapp/dm-reply`; `src/lib/notification-prefs.ts`
  gains `setDiscoverableNearby()`.
- **Exit criteria:** Sutton FC + Amir's group venues geocoded; ≥1 real player
  opted in; zero behaviour change for everyone else.

### Phase 2 — brokered cross-group fill

- **Schema:** `NearbyInvite`; `Organisation.featureNearbyFill`;
  `Membership.joinedVia`.
- **Files:** new `src/lib/nearby.ts` (pipeline B4); `src/lib/recruit.ts`
  (post-exhaustion hook + admin copy); `/api/whatsapp/dm-reply` YES/NO/REPORT
  fast-paths + the broker contact-share question; `src/lib/org-features.ts` +
  `/admin/settings` toggle; reliability snippet in the admin accept
  notification (feature #3); guardrail caps + auto-suspend; privacy policy.
- **Decision to make here:** guest games and Elo — recommend guests' Elo
  frozen for guest appearances (exclude `joinedVia="nearby-fill"` provisional
  members from `elo.ts` updates) until cross-pool fairness is designed.
- **Depends on:** Phase 1 data; the already-landed recruit trigger/capacity
  hardening.

### Phase 3 — pull-based discovery

- `Organisation.listOpenSlotsNearby`; "find a game near me" DM intent
  (deterministic keyword + dm-qa awareness, but slot data assembled
  server-side and pasted into the reply — the LLM never queries it); joining
  reuses the B4 accept path end-to-end.

### Phase 4 — community layer (exploratory)

- Guest profiles / availability windows; coarse reputation bands; `/nearby`
  web feed; club-to-club friendlies (own org-level consent + design pass).

### Risks

- **Privacy is the existential one** — one leaked number kills trust in a
  WhatsApp-native product. Mitigated by broker-only design, deterministic
  code, default-off, and the LLM exclusion rule; still warrants a pre-launch
  red-team pass on every reply surface (dm-qa, group replies, admin Q&A).
- **Geocoding ambiguity:** "the cages", "school pitch" won't resolve — by
  design they stay null and the feature degrades to off for that activity.
  Never guess; confirm-or-null (false precision is worse than silence).
- **Cross-org data-model creep:** guest memberships must not pollute rosters,
  surveys, payment chases, or daily lists — scope those queries to exclude
  fresh `joinedVia="nearby-fill"` provisionals except where the guest is
  actually in the squad. Audit the roster queries in Phase 2.
- **Global Elo contamination** (B5 #5) — decide before the first guest game.
- **Cold start:** with few opted-in players the feature looks dead. Frame
  Phase 2 copy accordingly ("I'll keep an eye out") and seed via Phase-3
  pull-based discovery, which works at any density.
- **WhatsApp deliverability:** invite DMs go to numbers the bot already knows
  (existing MT users only — discovery never cold-messages strangers), so
  ban-risk is no worse than today's recruit DMs; the weekly caps also protect
  the bot account.
- **Cost:** Maps usage is rounding-error volume; the key restriction + budget
  alert make it boring.

### Dovetail with the autonomous-onboarding design

1. Onboarding captures the venue **name** deterministically (unchanged); it
   then calls Phase 1's `resolveVenue()` and runs the 👍-confirm step — the
   geocoder lives here, not in the onboarding doc.
2. The onboarding feature menu lists `featureNearbyFill` as an opt-in line
   ("invite nearby guest players when short — off by default").
3. Player-facing onboarding/welcome may *offer* `discoverableNearby` with the
   full consent copy; never pre-ticked.
