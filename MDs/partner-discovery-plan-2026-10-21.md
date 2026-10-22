# Finding partner clubs nearby (partner discovery)

Plan, 2026-10-21. Design only, nothing built. Replaces decision D1 of
`MDs/cross-club-player-ask-plan-2026-10-16.md` ("only the platform owner pairs clubs") and
changes how the number of places in an ask is chosen. Everything else in that plan stands.

**Kemal's ask (2026-10-21), short version:** picking partners from a dropdown of every club
breaks once there are thousands of clubs. Instead an organiser picks a distance ("up to 3 miles
from our venue"), MatchTime lists the clubs that play near them (name, members, where, when,
level), the organiser selects some or all and sends a request. If the other club's organiser
accepts, that acceptance is their consent and the pairing is live. Later, when the organiser needs
players, he asks and says how many (1 player, even if 4 places are open). No two-sided approval.

---

## 1. The answer

**Yes, it is simpler, and it is the better design.** The two-sided approval exists today only
because neither club started the pairing: the platform owner did (D1), so both owners had to
agree. Once a club sends the request itself, **the request is that club's consent**, and only the
receiving club has anything left to agree to. One step disappears.

**What changes**

| Today | After |
|---|---|
| Only the platform owner pairs clubs, from two dropdowns of every club (`src/app/admin/clubs/partners/page.tsx`). | An organiser of any club searches by distance from its own venue and sends requests to one, some or all of the clubs listed. |
| Both owners must accept (`planPartnershipAction`, "accept" sets `askerAcceptedAt` and `partnerAcceptedAt`). | The request sets the asking side's acceptance. The receiving club accepts once and the pairing is active. |
| Every club could, in principle, be paired by the platform owner. | Only clubs with **"Let nearby clubs find us"** on (the default) are listed or can receive requests. |
| An ask always requests every open place (`placesOpen`, `src/lib/partner-ask.ts`). | The organiser chooses 1 up to the open places. The ask closes once that many guests have a place. |

**What stays exactly as it is**

- One pairing row per direction (D2). "FNF may ask Sutton FC" is not "Sutton FC may ask FNF".
- The partner club's per-ask choice (D3): "post without asking" or "check each ask with us". The
  partner now picks it at the moment it accepts. **Kemal, 2026-10-22: "post without asking" is
  the default** (it was "check each ask with us").
- When and how an ask goes out (D4, D12 cut-off and caps), volunteering by DM (PR #365), asking
  in words (PR #367), accepting a pairing notice by replying 1 or 2 (PR #364).
- Guest privacy (D7): name and club only, never a phone number, never the partner club's rating.
- Guests pay, are rated, and become past guests exactly as now (D10, D13, D15).

---

## 2. Discovery: finding clubs nearby

### 2.1 Who can be found, and who can look

Being listed shows another club where and when your group plays. **Kemal, 2026-10-22: the
setting is on by default.** Its owner or admin can switch it off at any time:

- New setting on the club settings page, Partner clubs section: **"Let nearby clubs find us and
  send requests"** (`Organisation.discoverable`, default **on**), with an info popup in English
  and Turkish saying exactly what other clubs will see. A new club sees the setting, already on,
  at signup.
- **Existing clubs are switched on at once, like new ones** (Kemal, 2026-10-22: no 7-day notice
  and no owner DM). Owners can switch it off any time in the Partner clubs section.
- **A club can search only while its own "Let nearby clubs find us and send requests" is on**
  (decided by Kemal, 2026-10-22, D-3). Switching it off hides the club and removes its search, so
  no club browses others while showing nothing of itself. It must also be listable (next bullet):
  with no confirmed venue it sees the "Confirm your venue" prompt instead, and a dormant or
  billing-paused club cannot search (recommended; Kemal can overrule).
- A club is listed only if it is approved, not dormant, not billing-paused, has a players' group,
  and has a **geocoded venue** (a `Venue` with `lat`/`lng`). **It does not need a game set up**
  (Kemal, 2026-10-22): a group of players with no match scheduled yet can be found. The venue is
  either an active game's venue (`Activity.venueId`) or, for a club with no game, a new optional
  **club home venue** (`Organisation.homeVenueId`), set **only with the venue lookup**, so it is
  always a geocoded `Venue`; no postcode or town entry (Kemal, 2026-10-22). A club with neither
  sees "Confirm your venue to find clubs near you" with a link to the venue lookup.
- **Live clubs with no geocoded venue get a DM** (Kemal, 2026-10-22: the location is a core club
  setting, added recently, so some clubs lack it). One message to the club's owners and admins,
  English and Turkish, linking straight to the venue lookup in settings and saying that being
  found by nearby clubs depends on it. Sent once at deploy (recommended); the settings prompt stays
  until the venue is set. In prod on 2026-10-21 that is MT Test only.
- **A club in its free trial is listed and can search** like any paying club (Kemal, 2026-10-22).
  "Billing-paused" means `ClubBilling.pausedAt` is set. A trial that ends with no card first runs
  the existing 7-day grace (`graceEndsAt`), so the club stays listed through the trial and the
  grace, and drops out only once billing actually pauses it. Exempt clubs have no `ClubBilling`
  row and are never paused.

Checked in prod (read-only, 2026-10-21): 6 clubs, 5 live; all 5 `Venue` rows are geocoded;
**MT Test's active game has no linked venue**, so MT Test would not be listed until its venue is
confirmed. Its existing pairings are unaffected (section 5).

### 2.2 The search

Page: **Partner clubs > Find clubs near you** (owners and admins).

- **Distance:** presets **1, 3, 5 and 10 miles**, default **3**, never more than 10 (Kemal, 2026-10-22: players will not travel further). Miles for every club (UK
  users); Turkish copy shows "mil". Kilometres can come later with a club setting if a non-UK club
  joins (D-9).
- **Measured from:** each of our active games' venues to each of theirs; a club with no active
  game uses its home venue instead. A club is in range if any pair is, and the list shows the
  **nearest** distance, rounded to 0.1 mile. A club with no game is never excluded by the "same
  day" filter.
- **Order:** nearest first. **Filter:** "Plays on the same day as us" toggle, off by default (a club
  that plays the same evening cannot usually lend players, but one that plays at another time can).
- **Scale:** a bounding-box query on `Venue.lat`/`lng` (new index), then the exact distance in code
  with the existing `distanceKm` (`src/lib/geo.ts`). Even with thousands of clubs, a 10-mile box returns
  a few hundred rows at most; pages of 50. No PostGIS needed.
- Clubs we are already paired with, or have a pending request to, show their status instead of a
  checkbox. Clubs that blocked us, or that declined us in the last 30 days, are simply not listed.

### 2.3 What one club sees about another

| Shown | Why it is safe |
|---|---|
| Club name | Chosen by the club for MatchTime; it is the name on its requests. |
| Venue name and town (from `Venue.name` and the town part of `formattedAddress`), distance | A public pitch, not a person. No coordinates are sent to the browser. |
| Each active game: day, kickoff time, format (for example "7-a-side", from `Sport.playersPerTeam`); "No regular game yet" for a club with none | What the requester needs to judge whether players could cross over. |
| Members: exact count of live, non-guest members | Kemal asked for it; a count names nobody. |
| Regular players: how many played at least 2 of the club's last 8 games | Tells a requester how big the pool really is. |
| Level, **only if the club set one** (section 2.4) | Self-declared, so it is the club's own claim. |

**Never shown:** member names, phone numbers, WhatsApp group names or invite links, organiser
names or numbers, fees, ratings of any kind, match history. The same card is shown to the
receiving club about the requester when a request arrives.

### 2.4 "Average club rating": why not, and what instead

**We will not show it** (decided by Kemal, 2026-10-22). Ratings are club-scoped since 2026-09-20: a player's 7.5 at one club
means "good compared with this group", not good on any shared scale. A casual club and a
competitive club can both average 6.5. Worse, the balancer's shrunk ratings pull every club towards
its own mean, so averages across clubs converge and would look meaningful while meaning nothing.
Showing it would invite exactly the wrong decision.

**Instead:** an optional **level the club sets itself**: Casual, Mixed or Competitive
(`Organisation.clubLevel`, null by default, Turkish: Rahat, Karışık, Rekabetçi). Shown as
"Level: Competitive (set by the club)". If unset, nothing is shown. Later, if wanted, a fact the
platform can measure honestly (for example "plays every week since March") can sit next to it.

---

## 3. The request flow

### 3.1 Sending

1. An organiser of club A ticks one, several, or all clubs in the list and presses
   **"Send request"**. A short confirm says what B will see and what accepting means.
2. One `ClubPartnership` row per selected club, A asking B, status `proposed`, with
   `askerAcceptedAt` and `askerAcceptedBy` set straight away: **A's request is A's consent**. No
   new status is needed; the existing rule already makes the row active when the second side
   accepts.
3. B's owners and admins get the pairing notice (DM, or the admin group if it has one), now
   worded as a request: "Friday MT Community (2.1 miles, Tuesdays 20:00, 7-a-side, 24 members)
   would like to ask your club for players when they are short. Reply *1* to accept or *2* to
   decline, or open <link>." The "reply 1 or 2" ending stays word for word.

### 3.2 Accepting

- **Who:** an owner or an admin of B (decided by Kemal, 2026-10-22, D-2). Today only owners
  accept; admins already approve each ask.
- Accepting makes the row `active`. **That acceptance is B's consent.** On the settings page the
  accept step also asks B's per-ask choice ("Post their asks straight away", default, or "Check
  each ask with us first"). Accepting by WhatsApp reply keeps the default, so the requester's asks
  go straight into B's players' group with no admin check. B's owner or admin can switch to "Check
  each ask with us first" at any time.
- A is told: "Sutton FC accepted. You can ask them for players from the match page or by asking
  MatchTime."
- Decline: A is told "Sutton FC is not taking requests right now." A cannot ask B again for 30 days.

### 3.3 One way or both ways

**One way (D-1, decided by Kemal, 2026-10-22).** B accepting lets A ask B, nothing more. B agreed to lend players,
not to borrow them, and A never agreed to lend. Making it two-way would need A's consent anyway.

To keep it one tap, B's confirmation (settings page and the reply to its "1") includes
**"Ask Friday MT Community for players too"**, a link that creates the reverse request with B's
consent already on it. A then accepts once. This is a link, not a new WhatsApp reply option, so
the pairing reply reader keeps its closed answer (accept, decline, neither) unchanged.

### 3.4 Limits and anti-spam

| Rule | Value (recommended) |
|---|---|
| New requests a club may send per London day | 20 (D-4). "Select all" beyond that sends the nearest 20 and says so. |
| Pending requests a club may have out at once | 50 (decided, Kemal 2026-10-22) |
| An unanswered **pairing** request | Expires after 14 days; A is told once. This is only the request to become partners. **An ask for players never has a 14-day limit: it ends with its match** (filled, no open place, the D12 cut-off before kickoff, or cancelled), as Kemal asked on 2026-10-22. |
| After B declines | A cannot re-request B for 30 days. B is not listed for A until then. |
| Block | B can **block A** from the request or the settings page: A can never request B, and B disappears from A's list. Unblock from settings. |
| Withdraw | A can withdraw a pending request at any time (row ends, no notice to B beyond the notice disappearing from its list). |
| Pause | Unchanged: either side pauses, only the side that paused resumes. |
| End | Either side's owner or admin ends an active pairing at any time. If B ended it, A waits 30 days to re-request. |
| Squad full | Every open ask for the match closes automatically, however the last place went (a guest, a home player saying IN, an organiser adding someone): each partner group gets its one "place is filled" line and remaining volunteers are thanked and stood down (Kemal, 2026-10-22). This is today's behaviour: `sweepPartnerAsks` runs on every due-posts poll and closes an ask once the match has no open place (`closeReason`, `placesOpen`). Recommended addition: an organiser can also cancel an open ask by hand, with the same line to each partner group. |
| Existing ask caps | Unchanged: 2 asks per London day into one partner group, one open ask per match and partner, the cut-off. |

### 3.5 What the platform owner keeps

The superadmin page (`/admin/clubs/partners`) loses the two "create" dropdowns and keeps the list
of every pairing with **pause** and **end** as an override for abuse or support (D-6). Creating a
pairing on a club's behalf would skip that club's consent, which is the point of the new design.

---

## 4. Asking for a number of players

- **Match page:** the partner-ask panel gets a number picker, **"Ask for [ 1 ] player(s)"**, from 1
  up to the open places, **default 1** (D-5), and lets the organiser tick which active partners
  to ask (default all). One press creates one ask per ticked partner, all carrying the same
  number and a shared `roundId`.
- **The number is for the whole round, not per partner.** Asking three clubs for 1 player means 1
  player in total. The round is filled when the guests who got a place (CONFIRMED) from any of its
  asks reach the number, or when the match has no open place left (today's rule). Then every ask
  in the round closes as `filled`, each partner group gets its one "place is filled" line (D8), and
  remaining volunteers are thanked and stood down (`standDownVolunteers`, unchanged).
- **More volunteers than wanted:**
  - A **first-come** club: volunteers take a place until the number is reached. The fill check and
    the place are written under one lock per match, so two volunteers at once cannot both take
    the last wanted place. A volunteer who arrives after that is told the place has gone
    (`xask_vol_closed`, existing).
  - An **organiser-pick** club (FNF): unchanged. Volunteers go on the **bench** labelled with their
    club, the organisers pick by number. Once they have picked the wanted number of guests, the
    round closes and the rest are stood down.
  - **Only the asking club's mode counts** (Kemal, 2026-10-22). Organiser-pick decides what happens
    to guests arriving at the asking club's own match. A partner club being organiser-pick has no
    effect on an ask it receives: MatchTime posts the ask straight into its players' group, not
    its admin group. Today's code already works this way (`partner-guest.ts` reads only the asking
    club's rule). The only thing that sends an ask to the partner's admins first is the partner's
    own choice "Check each ask with us first" (D3), which is no longer the default.
  - Important code fact: today a guest volunteer gets a place straight away whenever the match has
    one open (`registerAttendance` in `handlePartnerVolunteer`). With a number smaller than the open
    places this must stop at the number, or a request for 1 would take 4. That is the new rule.
- **The automatic ask** (D4 "auto") has no organiser to choose, so it keeps asking for every open
  place.
- **Asking in words (PR #367)** keeps asking for every open place in v1; its reply says "asked for 3
  players" so the organiser sees it. Teaching the admin extractor to read "1 player" is a prompt
  change: it is a separate later slice with the old/new prompt page and paid tests on the dev key
  (2026-10-18 rule), not part of this plan's core (D-7).

---

## 5. Moving from today

- **The two live pairings stay as they are.** Prod (read-only check 2026-10-21): Friday MT
  Community asks MT Test (active, standing) and MT Test asks Friday MT Community (active, each-ask).
  Both acceptances are already present, so the new rules read them as active pairings with
  nothing to migrate. No asks have been made yet (0 `PartnerAsk` rows).
- Being paired does not change being listed; both clubs are listed under 2.1 once they have a
  geocoded venue (MT Test has none yet, so it is not listed until its venue is confirmed).
- Existing `proposed` rows made by the platform owner (none in prod today) would keep needing both
  sides, which the current rule already does; only new requests start with the asker's consent.
- The superadmin create form is removed (section 3.5). `planCreate` stays only if D-6 keeps it.

---

## 6. Data model

```prisma
model Organisation {
  // Partner discovery (2026-10-21)
  discoverable      Boolean   @default(true)    // "Let nearby clubs find us and send requests"
  discoverableAt    DateTime?
  discoverableById  String?
  clubLevel         String?                     // "casual" | "mixed" | "competitive", CHECK constraint
  homeVenueId       String?                     // optional; where a club with no game is measured from
}

model ClubPartnership {
  // existing columns unchanged; a request = askerAcceptedAt set at creation
  origin        String    @default("owner")     // "owner" (platform owner) | "request"
  expiresAt     DateTime?                       // a pending request's expiry (14 days)
  endedAt       DateTime?
  endedByOrgId  String?
  endReason     String?                         // "declined" | "withdrawn" | "ended" | "expired" | "blocked"
  @@index([askerOrgId, status])
}

model ClubBlock {
  id              String   @id @default(cuid())
  blockerOrgId    String
  blockedOrgId    String
  createdByUserId String
  createdAt       DateTime @default(now())
  @@unique([blockerOrgId, blockedOrgId])
  @@index([blockedOrgId])
}

model PartnerAsk {
  // `places` already exists; it now holds the number the organiser chose
  roundId  String?   // asks sent together share it; the fill check counts across the round
  @@index([roundId])
}

model Venue {
  @@index([lat, lng])
}
```

One migration, additive only, applied before the deploy. The daily request cap counts rows with
`origin = "request"` and `askerAcceptedAt` since London midnight; the 30-day cooldown reads
`endReason`, `endedByOrgId` and `endedAt`.

---

## 7. Files that change

| File | Change |
|---|---|
| `src/lib/club-discovery-rules.ts` (new) | Pure: radius presets, bounding box, who is listable, who may search, the card fields, regular-player count, level parsing. |
| `src/lib/club-discovery.ts` (new) | Loads the nearby list for one club (one query plus `distanceKm`). |
| `src/lib/club-partnership-rules.ts` | New `planRequest` (caps, cooldown, block, already paired), `withdraw` and `block` actions, accept and end by owner or admin. |
| `src/lib/club-partnership.ts` | `requestPartnerships`, `withdrawRequest`, `blockClub`, discoverable and level settings, request expiry; new notice copy. Remains the one writer. |
| `src/lib/pairing-reply.ts` | No logic change; the notice it reads has new wording before the unchanged "reply 1 or 2" line. |
| `src/lib/partner-ask-rules.ts` | `canAsk` takes the chosen number (1 to open places); `closeReason` closes a round at its number. |
| `src/lib/partner-ask.ts` | `requestPartnerAsk` takes `places` and `roundId`; a new `requestPartnerRound` for several partners. |
| `src/lib/partner-guest.ts` | A guest takes a place only while the round is below its number (lock per match); round close stands the rest down. |
| `src/lib/bot-scheduler.ts` | Daily sweep: expire old requests. |
| `src/app/actions/partners.ts` | Actions: search, request, withdraw, block, unblock, discoverable, level. |
| `src/app/actions/partner-asks.ts` | Takes the number and the ticked partners. |
| `src/app/admin/partners/find/page.tsx` + `src/components/partners/find-clubs.tsx` (new) | The search page: radius presets, same-day filter, cards, select and send. |
| `src/components/settings/partner-clubs-section.tsx` | Discoverable toggle, level, "Find clubs near you", requests in and out, block list. Shown to every club, not only paired ones. |
| `src/components/match/partner-ask-panel.tsx` | Number picker and partner ticks. |
| `src/app/admin/clubs/partners/page.tsx` | Create form removed; list with pause and end. |
| `src/lib/i18n/strings.en.ts`, `strings.tr.ts`, settings info keys | Every new string in English and Turkish. |
| `prisma/schema.prisma`, one migration, `prisma/sql/partner-ask-check.sql` | Section 6, CHECKs for `clubLevel`, `origin`, `endReason`. |

---

## 8. Slices, in build order (TDD: failing tests first in every slice)

| # | Slice | Tests |
|---|---|---|
| P1 | Schema, discoverable setting (default on, existing clubs included), level, home venue via the venue lookup, one-off DM to live clubs with no geocoded venue. | Unit: setting writers, CHECKs, existing clubs read as on, DM sent once per club without a venue and never to one with a venue. Playwright: toggle and level on settings, EN and TR. |
| P2 | Nearby search (rules, loader, page). | Unit: distance, presets, listable and searcher rules, card has no names or numbers (a guard test on the loader's select), regular-player count. Playwright: seeded clubs at known distances appear and disappear as the radius changes; same-day filter; club without a venue sees the prompt. |
| P3 | Requests: send, accept (owner or admin), decline, withdraw, block, caps, cooldown, expiry; new notice wording; reverse-request link. | Unit: `planRequest` and every refusal; accept turns active in one step; 20-a-day cap under concurrency. Playwright: A sends to two clubs, B accepts one and declines one, A sees both outcomes. **One live pass of the existing pairing-reply cases on the dev key** (the notice the model reads has new words; 2026-10-18 rule), reporting calls and cost. |
| P4 | Choosing the number; rounds across several partners. | Unit: `canAsk` bounds, round fill across asks, first-come lock (two volunteers, one wanted), organiser-pick close after N picks, auto ask still asks for all. Playwright: panel picker and partner ticks. |
| P5 | Superadmin page: remove create, keep pause and end. | Playwright: page shows pairings, no create form. |
| P6 (later, optional) | Admin extractor reads a number ("ask Sutton for 1 player"). | Prompt rewritten whole, old/new page, paid tests on the dev key per the 2026-10-18 rule. |

P1 to P5 touch no prompt; the only model-facing change is the notice wording in P3.

---

## 9. Decisions for Kemal

| # | Question | Recommended |
|---|---|---|
| D-1 | Does accepting let only the requester ask, or both ways? | **Decided (Kemal, 2026-10-22): only the requester.** Offer a one-tap "ask them too" reverse request that the other club accepts. |
| D-2 | Who may send and accept requests? | **Decided (Kemal, 2026-10-22): owners and admins**, both. Owners are told when an admin accepts. |
| D-3 | Must a club be listed itself to search? | **Decided (Kemal, 2026-10-22): yes**, search needs the club's own toggle on. |
| D-4 | Request limits? | **20 new requests a day, 50 pending (decided), an unanswered pairing request expires after 14 days (an ask for players ends with its match), 30-day wait after a decline or an end by the other club, block available.** |
| D-5 | Default number on the ask picker? | **1**, up to the open places. Most asks are for one player and over-asking floods partner groups. |
| D-6 | Keep the platform owner's create form? | **No.** Keep the list with pause and end as an override. |
| D-7 | Asking in words (#367): number now or later? | **Later (P6)**, with its own prompt page and paid tests; until then words asks ask for every open place and say how many. |
| D-8 | Member count: exact, or a band? | **Exact total plus "regular players"**, as he asked. Names never. |
| D-9 | Miles only? | **Miles for now**, kilometres when a non-UK club joins. |
| D-10 | Show a level? | **No rating of any kind across clubs: decided (Kemal, 2026-10-22).** Still open: an optional self-set Casual, Mixed or Competitive level (recommended). |
