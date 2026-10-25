# Local player pool: approved spec (Kemal, 24 Oct 2026)

Kemal approved the whole plan on 24 Oct 2026. The source of truth is the Claude Doc
"MatchTime Local Player Pool: Plan" (https://claude.ai/artifact/LkskjZmYUyXvJB6MWKZNPN).
The engineering detail is in `MDs/local-player-pool-plan-2026-10-23.md`. Where the two
differ, THIS file and the doc win. Overnight decisions taken without Kemal are logged in
`MDs/local-player-pool-decisions-log.md`.

## What changed or was added on top of the 23 Oct engineering plan

### Sign-up (`/play`)
- Fields: name, area (postcode district or chosen pitches), travel distance (1, 3, 5 or 10
  miles), days, **available hours per chosen day as a from-to range** (e.g. Tue 19:00-22:00,
  Sat 09:00-13:00), **sports**, **level per sport (optional)**, format, consent (unticked by
  default). Last step opens WhatsApp with a prefilled message carrying a code; the person's
  own message verifies the number. MatchTime never cold-messages anyone.
- **Sports** are multiple choice, football ticked by default. Any sport played by hiring a
  venue with mates; "Other" lets the player type one in.

  | Sport | Format choices |
  | --- | --- |
  | Football (default) | 5, 7, 8, 9 or 11-a-side |
  | Basketball | 3 or 5-a-side |
  | Tennis, badminton, squash, padel, table tennis | disabled |
  | Billiards, snooker, pool | disabled |
  | Other (typed in) | disabled |

- **Level per sport**: Novice, Intermediate, Advanced or Pro, or the player's own words;
  optional; editable on the manage page; used only when a club asks for it.
- **Minimum age 18**, stated at sign-up and in the policy.

### Matching
Plain code: sport, distance, format where it applies, day AND hours, not already in that
club, turn-up record ranks first.

### Limits (the doc's plain wording)
At most 2 offers a week and 1 a day per player, none 21:30-08:30. A round asks up to 8 pool
players, about 4 first, the rest only if places are still open. 3 ignored offers in a row
pause the player until they say they want more. One master switch pauses all pool offers.

### Offer
Club, venue with address and map link, distance, day/date/kickoff/length, sport and format,
casual/competitive/mixed (new optional `playStyle` club setting, omitted when unset), club size
and how often it plays (counts only), fee ("free" when none), places needed. Never: group
name, organiser/member names, phone numbers. EN+TR examples are in the doc.

### Guest players in the app (organisers)
Each club's admin area gets a **Guest players** page with three tabs:
- **Upcoming**: accepted guests grouped by match (date, kickoff, venue), name, source (pool or
  partner club), turn-up record.
- **History**: every past guest with their matches for this club, each played / no-show /
  late cancel, and whether they joined. Guests who have not joined can be invited from here.
- **Report**: by month or season: asked, accepted, played, no-shows, became members, fill rate
  (short games rescued). Filters by sport and venue; CSV export.
Match pages list guests tagged Guest. A guest card: first name, last initial, sports, optional
level, turn-up record, games with this club. Phone, area and other clubs hidden.
**Invite to club** button on the card for any guest with at least one game with this club,
however long ago, not yet a member; greyed out if they stopped messages or deleted their
profile. The organiser's tap counts as the admins' yes; MatchTime privately asks the guest and
sends the invite link only on their yes.

### My invitations (players)
A page in the player's own dashboard: open club invitations (club, sport, venue, how often they
play, the games the player had there) with Join / No thanks, plus open game offers. The DM
links straight to it; an invitation stays until answered; Join sends the same invite link.

### Joining the group
After the game both sides are asked (guest privately; admins in HQ, or in the main group with a
tag when there is no HQ). Only on both yeses the guest gets the invite link. Link source:
MatchTime as group admin creates it (preferred); clubs that prefer not paste their link once.
As admin MatchTime never removes anyone.

### Referrals (no money)
Count only once the friend has played. Recruiter (1), Scout (3), Talent Spotter (10) badges
announced in the referrer's club group; "Brought by X" on the friend's first game; "Players
brought to the game: N" on the stats page; top recruiter of the season later; optional per
club: referrers offered free places first. The manage page gets a switch to keep badges and
"Brought by" private.

### Marketing support
- **G0 (ships with L2)**: a "Join the MatchTime player pool" invitation on the matchtime.ai
  home page with a pulsing button (under 3 flashes a second, stops under
  prefers-reduced-motion). Until the pool opens it adds players to an early sign-up list;
  sign-up still ends with the player's own WhatsApp message.
- Website pages updated for: the player pool, guest players for clubs, My invitations,
  referral badges, AND recent features the site does not show yet: partner clubs (clubs
  helping each other fill missing places across groups), the admin group (HQ) for organisers,
  and how the pool fills a place when no partner club can.
- Later: share links per player, EN+TR forwardable message, QR codes, per-source codes, one
  organiser-approved share post per club, funnel dashboard.

### Privacy policy (L0) must cover
Who we are (company, privacy contact email, ICO registration number); what we hold (the data
held list plus turn-up record and no-shows, blocks and reports, referral and source codes,
invitation answers, early sign-ups, messages players send us); why (consent for offers;
legitimate interest for turn-up record, blocks, reports; service for the profile); who sees it
(clubs only per the privacy table; badges and "Brought by" name a player in a club group);
service providers by type only (messaging, hosting, AI that reads a player's reply to their
own offer), UK transfer safeguards; automatic choices (offers chosen automatically; a pause can
be reviewed by a person on request); retention (12-month rule; how long block/report/consent
records are kept after deletion); rights (access, correct, delete, restrict, object,
portability, withdraw consent, complain to the ICO; reply within one month); age 18; cookies;
security, version and date matching the consent record, notice of big changes.
**Kept out**: how MatchTime is built or sends messages (no systems, tools, matching rules,
sending limits, numbers per town, group admin set-up). A UK data protection adviser should
check the wording before launch.

### Private message pacing (global bot setting)
About 10 seconds between private messages (up to six a minute, up from one), with a small
random spread. One global setting for every DM. A new town number starts at one a minute for
its first two weeks; the setting drops back to one a minute at once if WhatsApp shows any
warning.

### Build steps
L0 privacy page; L1 schema (profiles with sports, levels, availability ranges, town; asks,
offers, blocks, early sign-ups, source/referral codes; `playStyle`, town on clubs); L2 `/play`
sign-up, WhatsApp confirmation, manage page; G0 home page + website pages; L3 existing members
opt in; L4 matching rules and limits (pure) and the "players near you" band; L5 organiser
approval, offers, tap-yes guest place, Guest players page, `playStyle`; L6 offer replies in own
words (paid tests, about $0.50); L7 no-shows, turn-up record, auto-pause, block and report;
L8 join the group, Invite to club, My invitations; L9 automatic asking includes the pool;
L10 asking the pool in words in HQ (paid tests, about $1); L11 drop unused `discoverableNearby`
columns; G1 to G4 growth.

## Quality bar (Kemal, 24 Oct, repeated: "do not miss my comment")
1. Code quality and the right architectural patterns: pure rules modules with no I/O, thin
   I/O adapters around them, one source of truth per concept (sport catalogue, caps, quiet
   hours, copy), reuse existing modules, no duplicated logic, small files with clear owners.
2. A sandboxed WhatsApp conversation test (`e2e/sim/pool/` DSL from L1) for EVERY scenario:
   happy paths, edge cases, abuse, privacy leaks, caps, quiet hours, EN and TR.
3. Playwright tests for every page and flow, phone and desktop width.
4. TDD: red, green, refactor, in that order.
5. The main session reviews every diff and re-runs the gates; risky slices (privacy, DMs to
   strangers, money, concurrency: L2, L5, L7, L8) also get a second adversarial review.

## How it is built (Kemal, 24 Oct)
Modular, no duplicated logic (reuse partner-ask rounds, guest writer, notices, pay links,
ratings, badges, platform jobs, magic/short links, i18n); TDD (red, green, refactor); unit and
Playwright end-to-end tests on every slice; **sandboxed WhatsApp conversations** (the group/DM
simulator under `e2e/sim`) replaying real-life scenarios for every flow, covering happy paths,
edge cases and abuse; real model runs on the dev key only where a slice changes what the model
reads, cheap plan, reported. Budget (Kemal, 24 Oct): **$20 in total for paid AI tests across
the whole pool build**, every spend reported (calls and $). Each agent still stops and reports
before its own runs pass $2, so the main session keeps the running total. Every pool feature sits behind a
per-club flag that is OFF, so shipping a slice never changes a live club.
