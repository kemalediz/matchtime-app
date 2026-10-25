# The local player pool

Plan, 2026-10-23. Design only, nothing built, no prompts run. Builds on, and partly replaces,
the June design `MDs/social-location-features-design-2026-06-12.md` (parts B2 to B4), and reuses
the cross-club ask (`MDs/cross-club-player-ask-plan-2026-10-16.md`) and partner discovery
(`MDs/partner-discovery-plan-2026-10-21.md`) almost whole.

**Kemal's ask (2026-10-23), short version:** MatchTime becomes a local football network. People
who are not in any match group can tell MatchTime they want to play near them. When a club is
short, MatchTime contacts those people and offers them a place, so they end up playing (and maybe
joining the group).

---

## 1. The answer in brief

- **Sign-up is web first, confirmed on WhatsApp.** A public page (`matchtime.ai/play`) takes
  name, area, days, formats and consent. Its last step opens WhatsApp with a prefilled message
  carrying a code. **The person messages MatchTime first**, which verifies the number and is what
  keeps cold DMs (and the ban risk they carry) out of the design.
- **A club asks the pool the way it asks a partner club today.** Same triggers (short-squad
  notice, the match page, the automatic ask, asking in words later), same rounds, same "how many
  players", same first-come or organiser-pick rule, same guest membership, same pay link, same
  ratings. The pool is one more kind of "partner", not a parallel system.
- **The organiser approves before anyone is contacted** (one tap on the round, not per person),
  sees nobody until someone accepts, and then sees a name and a standing line, never a number.
- **Strict caps** on how often one person is offered games, how many offers a round sends, and how
  many pool DMs go out per hour across the platform.
- **Existing members of any club can opt in too**, from their profile, to be offered games
  elsewhere.
- **Growth** (shareable referral link, leaflets with QR codes, a funnel dashboard) comes after the
  core works, as later slices.

---

## 2. What exists today (traced in code)

| Piece | Where | What it gives us |
|---|---|---|
| Unused opt-in columns | `prisma/schema.prisma:95-106`, `User.discoverableNearby`, `discoverableNearbyAt`, `discoverableConsentVer`, `nearbyRadiusKm`, `homeArea*` | Added 2026-06-18 (`911bc92d`), never read or written by any code under `src/`. **0 users opted in** (prod, read-only, 2026-10-23). |
| Shared geocoded venues | `Venue` (`schema.prisma:~863`), `Activity.venueId`, bounding box and distance in `src/lib/club-discovery-rules.ts:83` (`boundingBox`), `:96` (`nearestMiles`), `src/lib/geo.ts:6` (`distanceKm`) | Everything needed to say "this player is 2.1 miles from this pitch". 5 geocoded venues in prod. |
| The platform channel | `PlatformJob` (`schema.prisma:2750`), `src/lib/platform-jobs.ts:230` (`queuePlatformDm`) | DMs that belong to no club. Its rule (header of `platform-jobs.ts`): only numbers MatchTime already knows, except sign-up codes. A pool person has no club, so his DMs go here, not as a `BotJob` (`BotJob.orgId` is required, `schema.prisma:1692`). |
| Inbound DMs | `src/app/api/whatsapp/dm-reply/route.ts` | Handler order is the contract (header). Self-join's code DM (`handleConnectDm`, `:188`) runs before the sender lookup. **An unknown sender is ignored today** (`:509`). |
| Code DMs from the website | `src/lib/connect-dm.ts` | The pattern we reuse: the site shows a short code, the person sends it to MatchTime, a deterministic handler matches the code (a token, not language). |
| Partner asks and rounds | `src/lib/partner-ask.ts:219` (`requestPartnerAsk`), `:344` (`requestPartnerRound`), `:658` (`sweepPartnerAsks`), `:952` (`sweepAutoPartnerAsks`), `src/lib/partner-ask-rules.ts:89` (`canAsk`), `:199` (`closeReason`), `:277` (`autoAskDue`) | Windows, cut-off, number of places, round fill across asks, auto ask only when the club's own bench is empty. |
| Short-squad notice offering an ask | `src/lib/bot-scheduler.ts:1366-1410` (`partnerOfferFor`, `withPartnerOffer`) | The notice to organisers already ends with "you could ask X". The pool becomes one more line there. |
| Guest on another club's match | `src/lib/partner-guest.ts:95` (`handlePartnerVolunteer`), `:349` (`standDownVolunteers`), `:443` (`retirePastGuests`), `:474` (`keepGuestAsMember`); `Membership.guestFromOrgId` / `guestMatchId` (`schema.prisma:849`) | The only writer of a person onto another club's match. Guest pays, is rated, becomes a past guest. CHECK today: both guest columns null or both set, so a pool guest (no home club) needs a small change (section 7). |
| Guest standing line | `src/lib/partner-guest-standing.ts:25` | A band from his own club's ratings. A pool-only player has no club, so the line falls back (section 5). |
| Reading a closed answer with the model | `src/lib/pairing-reply.ts` (accept / decline / neither, min confidence 0.8, Haiku, test stub seam) | The shape for reading a reply to a pool offer. |
| Proactive DM opt-outs | `Membership.subMatchInviteDm` etc. (`schema.prisma:809`), `src/lib/dm-subscriptions.ts` | Per-membership today. The pool flag is per person (no membership exists). |
| Recruit blast | `src/lib/recruit.ts:263` (`inviteRecentPlayers`) | Own-club recent players. Unchanged; the pool comes after it, never instead. |
| Pi pacing | `src/lib/dm-reply-priority.ts` header | **The Pi sends at most one DM a minute.** Every pool offer competes with pay links and replies for that minute. This is a hard ceiling on volume. |

Prod numbers (read-only SELECTs, 2026-10-23): 185 users, 164 with a phone, 212 live memberships
in 5 live clubs, 33 people already in more than one club, 4 partner asks made, 2 guest memberships.

**What is not built and this plan does not assume:** a privacy policy page (no `/privacy` route
exists under `src/app`; it is a launch prerequisite), and any stored WhatsApp group invite link
(none in the schema).

---

## 3. Signing up with no group

### 3.1 Channel: recommend both, but always ending on WhatsApp

1. **Web page `/play`** (public, EN and TR, `isPublicPath` in `src/lib/public-paths.ts` gains it).
   The form asks:
   - first name and last initial (shown to an organiser only after the person accepts a game);
   - **area: UK postcode district only** ("SM1", never a full postcode), geocoded once to a
     centre point; or pick one or more pitches from the venue lookup (`venue-suggest-*`);
   - **how far he will travel:** 1, 3, 5 or 10 miles (the discovery presets, default 3);
   - **days and times:** weekday chips plus "evenings / daytime / weekends";
   - **formats:** 5, 6, 7, 8, 11-a-side (multi-select, from `Sport.playersPerTeam`);
   - **level** (optional, decision D-4): casual, regular, competitive;
   - **consent tick boxes, unticked:** "MatchTime may message me on WhatsApp about games near me,
     at most 2 a week" (required) and "I am 18 or over" (required, section 9).
2. On submit nothing is live yet. The page shows **"Confirm on WhatsApp"**, a `wa.me` link to
   MatchTime's number with a prefilled message: *"Hi MatchTime, sign me up to play. Code K7QP"*
   (TR: *"Merhaba MatchTime, oynamak için kaydet. Kod K7QP"*).
3. The person sends it. A new deterministic handler in `dm-reply/route.ts`, next to
   `handleConnectDm`, matches the code (a token, the same rule `connect-dm.ts` already uses), and
   only then: the `User` is created or found by phone, the pool profile turns **active**, consent
   is recorded with the version and the WhatsApp message id as evidence, and MatchTime replies once
   on the platform channel: what he signed up to, the cap, and his manage/stop link.
4. **A code sent from a different number than the page asked for** is not an error: the number
   that sent it is the one we record (it is the one that reached us). The page never asks for a
   phone number at all, so there is nothing to mistype.

**Why WhatsApp-first:** the June design and today's sign-up (`src/app/actions/phone-signup.ts`)
send a code TO a typed number, which is a cold message. Here the person always writes first, so
every number in the pool is one that chose to message us. It also verifies the phone for free.

**A plain DM from a stranger** ("can I play football?") is ignored today (`route.ts:509`). New
behaviour: an unknown number that sends any DM with no valid code gets **one** reply, at most once
per number per 30 days, with the `/play` link. That is a state rule (unknown sender, not answered
recently), not language reading. Its reply text is fixed copy, no model.

### 3.2 Existing members of any club

- **Profile card "Play elsewhere too"** on `/profile` (`src/app/profile/page.tsx`): the same fields
  and the same consent wording. The area defaults to his clubs' venues (derived, not asked), so most
  members only tick consent and the days.
- **No DM blast to members to opt in.** The invitation reaches them through the one organiser
  approved club post (section 11.3) and a line in the help menu.
- His membership's own DM switches (`subMatchInviteDm`) stay about his club. The pool switch is
  about him, so it lives on the pool profile, not on a membership.

### 3.3 Consent, GDPR and PECR

- **Lawful basis: consent** (UK GDPR art. 6(1)(a)), explicit, recorded (`consentAt`,
  `consentVersion`, the evidence message id), unticked by default, withdrawable as easily as given.
  Offers of a game are arguably a requested service, but MatchTime also gains from them, so we
  treat them as direct marketing under PECR and rely on consent, which covers both readings.
- **Unsubscribe in every pool message:** a short signed link (`magic-link.ts` and
  `short-link.ts`) to `/play/manage`, one tap to pause, stop or delete. A tap needs no reading of
  words, so it is the guaranteed path. A reply like "stop" or "no more of these" is read by the
  offer reply reader (section 5.4, answer `stop`), not by a phrase list.
- **Data held:** name, phone, postcode district and its centre point, chosen venues, travel
  distance, days, formats, optional level, consent record, offers and their outcomes. Never a full
  postcode, a GPS point or a date of birth.
- **Retention:** a profile with no activity (no reply, no game, no visit to the manage page) for
  **12 months** gets one "still want game offers?" DM; no answer in 30 days ends the profile and
  its personal fields are erased. Offer rows keep ids and outcomes only (for caps and abuse) and are
  anonymised after 24 months.
- **Delete on request:** the manage page button, or the reply reader's `stop` followed by "delete
  my details" on the manage page. Erasing a pool-only person removes his pool profile and, if he has
  no memberships and no match history, his `User` row. Match history at a club he played for as a
  guest stays with that club, as for any past guest (cross-club plan D10).
- **Privacy policy page** (new, EN and TR) must exist before launch and be linked from `/play`
  and from the first reply.

---

## 4. Matching: who is offered a place

### 4.1 Triggers (all existing)

| Trigger | Today | With the pool |
|---|---|---|
| Short-squad notice to organisers | `bot-scheduler.ts:1366-1410` ends with "you could ask X" | Adds "or ask nearby players from the MatchTime pool (about N near you)". N is a band (none, a few, 5+, 10+), never names. |
| Match page panel | `src/components/match/partner-ask-panel.tsx` | One more tick: "MatchTime player pool". |
| Automatic ask on match day | `sweepAutoPartnerAsks`, `autoAskDue` (own bench empty) | Same rule, pool asked **after** partners had their chance (decision D-2). |
| Organiser asks in words in HQ | `admin-group-understand.ts` `ask_group` / `admin_ops` recruit, `partner-ask-words.ts` | Later slice: the admin extractor learns "the pool" as a target. Prompt change, paid tests. |

The recruit blast to the club's own recent players (`inviteRecentPlayers`) and bench offers
always come first. The pool is the last resort.

### 4.2 Candidate rules (code, never the model)

Hard filters, in order:

1. Pool profile **active**, consent on, not paused, has a phone.
2. **Distance:** the match venue (`Activity.venueId`, geocoded) is within his travel distance of
   his area centre or of any venue he picked. No geocoded venue: the pool cannot be asked, and the
   organiser sees "Confirm your venue to ask nearby players" (the discovery prompt).
3. **Format** in his list, **day and time** in his availability.
4. **Not already linked to the club:** no live membership there, not on this match, not blocked
   by this club or blocking it.
5. **Not busy:** no CONFIRMED or BENCH row on an overlapping game anywhere (`gamesOverlap`,
   `partner-ask-rules.ts:285`).
6. **Caps not reached** (4.3).

Rank the rest by: has played a MatchTime game before and turned up (reliability first), then
distance, then least recently offered. Take at most `min(places x 3, 8)` for one round.
**Level** (if D-4 keeps it) is a filter only when the club set one; it never ranks.

### 4.3 Caps (anti-spam and ban risk)

| Cap | Value (recommended) |
|---|---|
| Offers to one person | **2 per rolling 7 days, 1 per London day, 1 per match**, across all clubs |
| After a decline from a club | that club cannot offer him again for 14 days |
| Ignored offers | **3 in a row with no reply: profile pauses itself**, one DM says so with the resume link |
| Offers per round | at most 8, sent in two waves (first half, then the rest 30 minutes later only if still short) |
| Pool rounds per club | 1 open per match, 3 per club per 7 days |
| Platform-wide pool DMs | at most 20 per hour and 100 per London day, on top of the Pi's 1 DM a minute |
| Cut-off | the partner cut-off (`askWindows`, default 4 hours before kickoff); an offer expires at the cut-off or 6 hours after sending, whichever is first |
| Quiet hours | no pool DM between 21:30 and 08:30 London (`club-quiet-hours.ts` pattern) |

### 4.4 WhatsApp ban risk, how the design keeps it low

- **Only numbers that messaged MatchTime first** (the sign-up code, or a club member). No pool
  message is ever the first contact. This is the platform channel's existing rule
  (`platform-jobs.ts` header), kept.
- **Low volume by construction:** per-person and platform caps, waves, quiet hours, and the Pi's
  one-a-minute pacing.
- **Every message is personal and answerable** (his name, one game, a clear yes/no) with the stop
  link, which lowers "report spam" taps, the main ban signal.
- **Auto-pause on silence** removes people who no longer want them before they block us.
- **A kill switch:** a platform flag `POOL_OFFERS_ENABLED` that stops every pool DM at queue and at
  dispatch, as the self-join flag does.
- Watch block and failure rates on the owner dashboard (no DM to Kemal for routine health).

---

## 5. The offer flow

### 5.1 Who approves

**Recommendation: the organiser approves the round, once, before anyone is contacted** (decision
D-1). The approval is the tap on the match page, the YES to the short-squad notice, or the club's
choice of "ask the pool automatically" (off by default). The organiser never picks individuals:
he cannot see them before they accept.

### 5.2 The DM (platform channel, purpose `pool-offer`)

**The offer sells the game (Kemal, 2026-10-24).** It carries every fact that helps someone say
yes, each from data MatchTime already has, and a line is simply left out when its fact is unknown:

| Fact | Source |
|---|---|
| Club name | `Organisation.name` |
| Venue name, address and map link | `Activity.venueRef` (`Venue.name`, `formattedAddress`, `lat`/`lng`); falls back to `Activity.venue` text |
| Distance from them | venue lat/lng against the person's postcode district |
| Day, date, kickoff, length | `Match.date`, `Activity.matchDurationMins` |
| Format (5, 7 or 11-a-side) | `Sport.playersPerTeam` |
| Casual or competitive | **new** optional club setting `Organisation.playStyle` (`casual` / `competitive` / `mixed`), set by the organiser in club settings; omitted when unset |
| How big and how regular the club is | active members, and games played in the last 8 weeks (counts only, never names) |
| Match fee | the club's per-player fee; "free" when it takes none |
| Places needed | the round's number |

EN:
> ⚽ **FNF** needs 1 player for a 7-a-side game
> 📅 **Friday 30 Oct, 20:30** (60 mins)
> 📍 **Goals North Cheam**, 1.8 miles from you. Map: <link>
> 🤝 Casual, friendly game. A regular group of 30 players, playing every week
> 💷 £6 match fee
> Would you like the place? Reply here, or tap <link> to say yes.
> You get these because you joined the MatchTime player pool. Stop or change them: <link>

TR:
> ⚽ **FNF** 7'li bir maç için 1 oyuncu arıyor
> 📅 **30 Ekim Cuma, 20:30** (60 dk)
> 📍 **Goals North Cheam**, sana 1,8 mil. Harita: <link>
> 🤝 Keyifli, dostane bir maç. Her hafta oynayan 30 kişilik düzenli bir grup
> 💷 Maç ücreti £6
> Yeri ister misin? Buradan cevap ver ya da evet demek için <link> bağlantısına dokun.
> Bu mesajları MatchTime oyuncu havuzuna katıldığın için alıyorsun. Durdur ya da değiştir: <link>

The tap link opens an offer page with the same facts plus a map, so a WhatsApp preview is not the
only place to read them. The group name, organiser names, member names and phone numbers are never
shown. Language: the person's own choice at sign-up (`/play` detects it with `browser-lang.ts`, he
can change it). `playStyle` is a schema plus settings-UI change in the offer slice; a club that
never sets it simply has no style line.

### 5.3 Accepting

Two ways, both feeding one writer:

- **Tap the yes link** (`/play/offer/<token>`): deterministic, the most reliable path.
- **Reply in words**, read by a new small closed-answer reader shaped like `pairing-reply.ts`:
  answers `accept`, `decline`, `stop`, `question`, `neither`, with a confidence floor. It runs
  **only** when the sender has an open pool offer (the state prior), and reads the reply against
  the offer text. Below the floor, one short re-ask with the link. A `question` ("is there
  parking?") gets the offer's facts and the link, nothing invented. **This is a new prompt** and
  needs the paid test plan (section 8).

### 5.4 What accepting does

1. Re-check under the existing per-match lock (`partner-guest.ts`, partner discovery P4): the
   round is below its number and the match has a place. Lost the race: "That place has just gone,
   I'll keep you in mind" and outcome `filled`.
2. **A one-off guest place, not a group invite** (decision D-5). A guest membership in the club
   (`guestVia = "pool"`, `guestMatchId` set), then `registerAttendance` with cause `pool-ask`. The
   club's own rule decides: first-come confirms while there is room; organiser-pick puts him on the
   **bench** labelled "(MatchTime pool)" for the organisers to pick, exactly as partner guests
   (`normaliseBenchPickMode`). "Bench", never "waiting list".
3. The organisers are told (admin channel, `sendAdminNotice`): *"Ali K from the MatchTime player
   pool took a place for Tuesday. Played 6 MatchTime games, turned up to all 6."* For a person with
   no MatchTime history: *"New to MatchTime."* No phone number, no ratings from anywhere else.
4. Ali gets the match details DM (venue, time, fee, how to pull out) on the platform channel. He
   pulls out by replying (the same reader, `decline`) or the link; the place goes back through the
   normal drop flow and the bench offer.
5. **Payment:** nothing special (cross-club D15). He is on the match, so he gets the club's pay
   link after it, the reminders and the chase, in the match club's language.
6. **Ratings and MoM:** rated in that club only, like a partner guest (cross-club D13). Club-scoped
   ratings stay club-scoped.
7. **Afterwards:** he becomes a past guest the morning after (`retirePastGuests`). The organiser
   sees **"Add to club"** (`keepGuestAsMember`) and, separately, **"Invite to our WhatsApp group"**:
   MatchTime DMs Ali the invite link the organiser pastes (no invite link is stored today; v1 asks
   for it at that moment). Ali chooses to join or not. Until he joins, the club has no way to reach
   him except through MatchTime.

### 5.5 No-shows and reliability

- The organiser marks a no-show on the match page after the game (new small action; the existing
  attendance rows say who was CONFIRMED). Reliability = games turned up / games confirmed as a pool
  guest, shown only as the line in 5.4 step 3.
- **2 no-shows in his last 5 pool games: pool offers pause** and he is told why, with a resume link
  after 30 days.
- A club that marks more than 3 no-shows against different pool players in a month is flagged on
  the owner dashboard (a club abusing the marker).

---

## 6. Privacy between clubs

| Stage | The club sees | Never |
|---|---|---|
| Before asking | a band of how many pool players are near ("a few", "5+") | names, numbers, areas, any list |
| Offers out | "Asked 6 nearby players" and the count who declined | who was asked |
| After accept | first name and last initial, "MatchTime pool", the reliability line | phone number, area, other clubs he plays for, ratings elsewhere |
| After he joins the group | what WhatsApp shows any member | nothing more from MatchTime |

- A pool person sees the club name, venue, day, time, format, fee. Never member names.
- Numbers cross only when the person joins the group himself. MatchTime never hands an organiser a
  pool number.
- **No pool data in any model context** except the person's own reply and his own offer (the
  reader in 5.3). The Q&A (`dm-qa.ts`, group and HQ questions) must refuse "who is in the pool?"
  and similar: a guard test on every Q&A loader that it never selects pool tables.
- Pool tables are readable only by the pool code and the superadmin dashboard (source guard test,
  as `platform-jobs-source-guard.test.ts` does today).

---

## 7. Data model (all additive)

```prisma
/// One person's wish to be offered local games. 1:1 with User.
model PoolProfile {
  id               String    @id @default(cuid())
  userId           String    @unique
  status           String    @default("pending") // pending | active | paused | ended
  pausedReason     String?   // self | ignored | no-shows | admin
  signupCode       String?   @unique             // the WhatsApp confirm code, cleared once used
  consentAt        DateTime?
  consentVersion   Int?
  consentEvidence  String?   // waMessageId of the confirm DM
  language         String    @default("en")
  displayName      String
  areaDistrict     String?   // "SM1", never a full postcode
  areaLat          Float?
  areaLng          Float?
  venueIds         String[]
  maxMiles         Int       @default(3)          // 1 | 3 | 5 | 10
  days             Int[]                          // 0..6
  timeBands        String[]                       // daytime | evening | weekend
  formats          Int[]                          // players per side
  level            String?                        // D-4
  source           String?                        // web | profile | referral | leaflet | linkedin | ...
  referrerUserId   String?
  lastActiveAt     DateTime?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  @@index([status])
  @@index([areaLat, areaLng])
}

/// One club's ask to the pool for one match. Shares PartnerAsk.roundId so a round can span
/// partner clubs and the pool and the fill check counts both.
model PoolAsk {
  id                String    @id @default(cuid())
  matchId           String
  orgId             String
  roundId           String?
  places            Int
  requestedByUserId String?   // null for the automatic ask
  via               String    // page | notice | auto | words
  status            String    @default("open") // open | filled | closed | cancelled
  closeReason       String?
  createdAt         DateTime  @default(now())
  closedAt          DateTime?
  @@unique([matchId, orgId])
  @@index([roundId])
}

/// One offer to one person. The cap ledger and the audit trail.
model PoolOffer {
  id            String    @id @default(cuid())
  poolAskId     String
  matchId       String
  orgId         String
  userId        String
  distanceMiles Float
  wave          Int       @default(1)
  platformJobId String?
  sentAt        DateTime?
  expiresAt     DateTime
  respondedAt   DateTime?
  outcome       String?   // accepted | declined | expired | filled | stopped | cancelled
  @@unique([matchId, userId])
  @@index([userId, sentAt])
  @@index([orgId, userId, sentAt])
}

model PoolBlock {          // a club blocks a person, or a person blocks a club
  id        String   @id @default(cuid())
  orgId     String
  userId    String
  by        String   // club | player
  createdAt DateTime @default(now())
  @@unique([orgId, userId])
}

model Membership {
  guestVia  String?   // "partner" | "pool"; CHECK: guestMatchId set => (guestVia = 'pool') or guestFromOrgId set
  noShowAt  DateTime? // later slice; or on Attendance, decided in the build
}

model Organisation {
  featurePlayerPool Boolean @default(false) // per-club flag, shown in Partner clubs settings
  poolAutoAsk       Boolean @default(false) // include the pool in the automatic ask
}
```

- The 7 unused `User.discoverableNearby*` / `homeArea*` / `nearbyRadiusKm` columns are dropped in a
  later cleanup migration once `PoolProfile` is live (0 rows use them). A guard test keeps them
  from being read in the meantime.
- `prisma/sql/partner-ask-check.sql` gets the changed guest CHECK and CHECKs on the new status and
  outcome strings.

### Modules

| Reused as is | Reused with a change | New |
|---|---|---|
| `geo.ts`, `club-discovery-rules.ts` box and distance, `venue-suggest-*`, `magic-link.ts`, `short-link.ts`, `platform-jobs.ts`, `registerAttendance`, `sendAdminNotice`, `retirePastGuests`, `keepGuestAsMember`, pay links, ratings | `partner-ask-round.ts` (round fill counts pool guests), `partner-ask-rules.ts` `closeReason`, `partner-guest.ts` (one writer gains a pool entry point, keeps the lock), `bot-scheduler.ts` notice line, `partner-ask-panel.tsx`, `dm-reply/route.ts` (code handler, stranger reply, offer reply slot), `public-paths.ts` | `pool-rules.ts` (pure: filters, ranking, caps, waves, expiry), `pool.ts` (loader and round runner), `pool-offer-reply.ts` (the reader), `pool-signup.ts` (code handler), `/play`, `/play/manage`, `/play/offer/[token]`, privacy page, pool settings section, owner funnel page |

**One architecture:** the pool is asked through the same round, the same lock, the same guest
writer and the same notices as partner clubs. The offer reply is the only new model reader, and it
sits in the DM route's existing slot order (a specific pending prompt, so it goes with the other
"answer to my question" handlers, before Q&A).

### Crons (riding the existing due-posts and platform-jobs polls)

- Send waves and expire offers (every poll).
- Close pool asks with their rounds (`sweepPartnerAsks` already runs per poll).
- Auto-pause after 3 ignored offers (on expiry).
- Retention: daily, the 12-month reconfirm and the 30-day erase.

---

## 8. Slices, in order (TDD in every slice: failing unit tests first, then Playwright)

| # | Slice | Prompt? | Tests |
|---|---|---|---|
| L0 | Privacy policy page, EN and TR | no | Playwright: page renders, linked from footer |
| L1 | Schema (`PoolProfile`, `PoolAsk`, `PoolOffer`, `PoolBlock`, `guestVia`, flags) and CHECKs | no | Unit: CHECKs, guard that pool tables are read only by pool modules |
| L2 | `/play` form, code issue, WhatsApp confirm handler, stranger one-time reply, manage page (pause, edit, stop, delete) | no | Unit: code matching, consent record, stranger reply once per 30 days, delete erases. Playwright: sign up in EN and TR, open the `wa.me` link, simulate the DM, profile goes active; manage page pause and delete |
| L3 | Profile card for existing members | no | Playwright: member opts in with defaults from his venues |
| L4 | Matching rules and caps (pure) and the "N near you" band | no | Unit: every filter and cap, ranking, waves, quiet hours, platform cap under concurrency |
| L5 | Asking the pool: match page tick, notice line, organiser approval, offers sent as platform DMs with the tap-yes link only (no reply reading yet; a reply gets "tap the link") | no | Unit: round across partners and pool, fill and close. Playwright: organiser asks, offers queued, tap yes, guest on the match, organiser notified, first-come and organiser-pick |
| L6 | The offer reply reader | **yes** | Unit with the stub seam. Paid: new prompt, so per the 2026-10-18 rule one pass of a small EN/TR case set (about 40 replies) and an end-to-end path. Rough: 40 to 60 Haiku calls, well under $0.50 |
| L7 | No-shows, reliability line, auto-pause, block and report | no | Unit and Playwright |
| L8 | After the game: invite to group, add to club | no | Playwright |
| L9 | Automatic ask includes the pool (`poolAutoAsk`) | no | Unit: pool only after partners, own bench empty |
| L10 | Asking the pool in words in HQ | **yes** | Admin extractor prompt rewritten whole, old/new page; paid pass of every admin extractor case on the dev key. Rough: 150 to 250 calls, about $1. Ask Kemal if the estimate goes over $2 |
| G1 to G4 | Growth and referral (section 11) | no | Unit and Playwright |
| L11 | Drop the unused `User` columns | no | Unit guard |

L0 to L5 ship a working, model-free pool. Every DM's copy is in `strings.en.ts` and
`strings.tr.ts`, reported in both.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **WhatsApp number ban** | Inbound-first only, caps, waves, quiet hours, auto-pause, kill switch, block-rate watch (4.4). Worth a second WhatsApp number for the platform channel later, so a ban never silences club groups (decision D-6). |
| **Consent** | Unticked boxes, versioned record with message evidence, stop link in every DM, retention job, privacy page before launch. |
| **Fake sign-ups and abuse** | A sign-up only becomes active after the person messages from his own WhatsApp. Per-IP and per-day caps on `/play` (`signup-caps.ts` pattern). One profile per number (unique `userId`, unique phone). A club can only ask the pool once approved, live and with at least 3 completed games (stops a fake club harvesting people). Organisers never see a list. |
| **Safety: strangers joining** | 18+ declaration; reliability line; club blocks a person, person blocks a club; report reaches the owner dashboard; two reports from different clubs pause the profile pending review. A short safety line in the first reply ("play in public venues; tell us about any problem"). We do not verify identity, and the copy must not imply we do. |
| **Cold start** | An empty pool makes the feature look dead. Show the organiser line only when at least 3 pool players are near; launch in one area (Sutton) first; seed from existing members (33 already play in more than one club); then growth (section 11). |
| **Pi throughput** | One DM a minute shared with pay links; the waves and the 20-an-hour cap keep pool offers from delaying replies (reply priority already moves conversational replies first). |
| **Guest data creep into rosters** | Same as partner guests: every roster reader skips guests; a test per reader that a pool guest does not appear in lists, surveys or chases outside his match. |

---

## 10. Open decisions for Kemal

| # | Question | Recommendation | Trade-off |
|---|---|---|---|
| D-1 | Does the organiser approve before the pool is contacted? | **DECIDED yes (Kemal, 2026-10-24): one tap per round**, with an opt-in "ask the pool automatically" for clubs that want it. | Approval adds a step that can make the ask late, but no club is ever surprised by strangers arriving. |
| D-2 | Order when short: partners first, or partners and pool together? | **DECIDED (Kemal, 2026-10-24): partners first**, the pool after the partner ask had 1 hour or no partner exists. | Players from a known club are a safer fit; asking both at once fills faster but spends pool caps on games a partner would have filled. |
| D-3 | Name the club in the offer DM? | **DECIDED yes (Kemal, 2026-10-24)**, with every fact that helps a yes: club, venue with address and map, distance, date, time, length, format, casual or competitive (new `playStyle` setting), club size and regularity, fee, places needed. See 5.2. | Naming shows which clubs need players (a small competitive leak); accepted. |
| D-4 | Ask the person's level? | **Yes, optional, self-set (casual / regular / competitive), used only as a filter when a club sets one.** | Partner discovery rejected levels for clubs; for strangers a mismatch ruins a game, but a self-set level is unreliable. Dropping it is simpler. |
| D-5 | On accept: one-off guest place, or straight into the group? | **One-off guest place**, then "Invite to our group" after the game if both want. | The group invite grows clubs faster, but adds a stranger to a private group before anyone has played with him. |
| D-6 | One WhatsApp number for everything, or a separate number for the pool? | **DECIDED (Kemal, 2026-10-24): one number per town.** The current number serves Sutton; each new town gets its own WhatsApp number (and Pi session) before MatchTime goes live there. Clubs and pool players are served by their town's number. | Isolates ban risk per town; each number is another session and pairing to run. The data model needs a town (or number) on clubs and pool profiles from v1 so the split is a routing change, not a migration. |

---

## 11. Growth and referral (later slices, after L0 to L5 work)

Kemal's plan after launch: word of mouth (players share a sign-up link in their own groups and
with friends), LinkedIn posts and messages from him and friends, and leaflets around Sutton (print
and digital), maybe with a referral scheme. Leaflet and post design is out of scope; this section
is what the product must provide.

### 11.1 Links, codes and sources

- **Every person gets a short personal link**, `matchtime.ai/p/K7QP` (a `ShortLink`-style code,
  no expiry), shown on his manage page and in the first reply. It opens `/play` with the referrer
  stamped.
- **The WhatsApp-first sign-up fits sharing well:** the link can go straight to a `wa.me` chat
  with the prefilled message carrying the code, so a friend taps, sends, and is in; the web form
  then only asks what is missing by DM link. Default stays the web form first (consent ticks are
  clearer there); the direct WhatsApp link is used where the form would lose people (QR on a
  leaflet).
- **Campaign codes** for sources: `matchtime.ai/p/li-kemal` (LinkedIn), `/p/lf-sutton-goals`
  (a leaflet run), `/p/club-fnf` (a club's share post). Stored as `PoolProfile.source` plus the
  code; a small `PoolCampaign` table (code, source, label, createdAt, active).
- **QR codes** generated on the owner page for any campaign code (PNG and SVG download), so a
  leaflet run gets its own code and its own numbers.
- **A ready-to-forward WhatsApp message** on the manage page with a Copy and a Share button:
  - EN: *"I play local football through MatchTime. If you want games near you, sign up here and
    they'll message you when a team needs a player: matchtime.ai/p/K7QP"*
  - TR: *"Yakındaki maçlar için MatchTime kullanıyorum. Sen de kaydol, bir takıma oyuncu lazım
    olunca sana yazsınlar: matchtime.ai/p/K7QP"*

### 11.2 Referral reward

- **Recommend: a free game credit for the referrer, only when the referred person actually plays**
  (CONFIRMED on a completed match and not marked no-show), at most **1 credit per month and 3 in
  total per referrer**, and never for referring a number that was already a MatchTime user.
- **Who pays is the real question (a growth decision for later, not needed for the core):** match fees belong to
  clubs, so a "free game" costs the club unless MatchTime funds it. Cheapest honest option: MatchTime
  credits the referrer's next match fee at the club as a free place (the existing fee-waiver path,
  `fee-waiver.ts`) and offsets that club's next MatchTime club fee by the same amount. With no
  billed clubs yet (club fee billing live, none billed), v1 can use a non-cash reward: a
  "Recruiter" badge in the club badge set and the credit switched on later.
- Abuse limits: the referred person must confirm by WhatsApp from a new number, play at a club where
  the referrer is not an organiser of the asking club, and credits are reviewed on the owner page
  before they apply in v1.

### 11.3 Asking existing members to share, without spamming groups

- **One post per club, ever, approved by the organiser.** MatchTime asks the organisers in HQ (or
  by DM) once: "May I post one message in the players' group inviting players to bring friends to
  the MatchTime pool?" YES posts it once, with the club's campaign link. No reply, or no: nothing,
  never asked again for 90 days.
- No DMs to members about sharing. The help menu and the manage page carry the link for anyone who
  looks for it.

### 11.4 Funnel dashboard (owner only)

`/admin/pool` (superadmin): by source and by week, **sign-ups started, confirmed on WhatsApp,
active, offered, accepted, played, still active after 60 days**, plus pauses, stops, blocks and
reports (the ban-risk early warning). Counts only, no names. Each number is a query over
`PoolProfile`, `PoolOffer` and attendance; nothing new is tracked for it beyond `source`.

### 11.5 Growth slices

| # | Slice |
|---|---|
| G1 | Personal links, campaign codes, source stamping, QR download |
| G2 | Funnel dashboard |
| G3 | One organiser-approved share post per club |
| G4 | Referral credit (after the funding decision) |

None of these touches a prompt (the share post's YES reuses HQ's safe-YES rule).
