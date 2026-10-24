# Pool scenarios: sandboxed WhatsApp conversations for the local player pool

Every pool flow gets a scenario here: one real-life conversation between
people and MatchTime, played through the real routes against the isolated
e2e database, asserting **exactly what MatchTime sends, to whom, and what
the database holds**. Built in slice L1 (2026-10-24) as the foundation every
later slice (L2 to L10, G1 to G4) fills in.

Specs: `MDs/local-player-pool-approved-spec-2026-10-24.md` (wins) and
`MDs/local-player-pool-plan-2026-10-23.md`.

```bash
npx tsx e2e/run.ts sim/pool/                    # every pool scenario, stubbed, $0
npx tsx e2e/run.ts sim/pool/stranger-dm.spec.ts # one file
npx vitest run e2e/sim/pool                     # the DSL's pure half (unit)
MT_SIM_LIVE_LLM=1 npx tsx e2e/run.ts sim/pool/<x>-live.spec.ts   # PAID, see "The model"
```

## The DSL

| File | What it is |
| --- | --- |
| `fixtures.ts` | `scenario`, `scenarios`, `stubbedOnly`, `liveOnly`: Playwright on the shared e2e fixtures, a fresh `pool` world per scenario, the transcript attached to every failure |
| `world.ts` | The I/O half: `PoolWorld`, `PoolClub`, `PoolPerson` |
| `transcript.ts` | The pure half: queued rows to `SentMessage`, `matchSent`, `findLeaks`, `phoneVariants`, `renderTranscript` (unit-tested in `transcript.test.ts`) |

Clubs are built by the group simulator's own `createGroup` (`../group.ts`),
not a copy of it, so a pool scenario's club behaves exactly as every other
sim club.

```ts
import { scenario, scenarios, expect } from "./fixtures";

scenarios("a stranger signs up", () => {
  scenario("the confirm message turns the profile active", async ({ pool }) => {
    // The cast
    const fnf = await pool.club("fnf", { name: "FNF", hq: true, pool: { featurePlayerPool: true, playStyle: "casual" } });
    const ali = await pool.stranger("ali", { name: "Ali Kaya" });     // a number MatchTime never saw

    // What they send
    const ex = await ali.dm("Hi MatchTime, sign me up to play. Code K7QP2");

    // Exactly what MatchTime queued, in order, by name ([] = nothing at all)
    pool.expectSent(ex.sent, [{ to: "ali", channel: "dm", purpose: "pool-welcome", text: /signed up/ }]);
    // Nothing private reached him: members' names and numbers
    pool.expectNoLeaks(fnf.secrets(), { to: ["ali"] });
    // What the database holds
    expect(await pool.profileOf(ali)).toMatchObject({ status: "active", consentVersion: 1 });
  });
});
```

### The cast

| Call | Gives |
| --- | --- |
| `pool.club(key, opts)` | A club (`createGroup` options, plus `hq: true` for an admin group, plus `pool: { featurePlayerPool, poolAutoAsk, playStyle, town }`, every one OFF/NULL by default as in production). Its roster's members are registered as `<club>.<member>` ("fnf.owner", "fnf.pete") |
| `pool.stranger(key, { name?, phone? })` | A number MatchTime has never seen: no User, no club. Refuses a number that is already known |
| `pool.person(key)`, `club.member(memberKey)` | Anyone registered |

### What they do

| Call | Route |
| --- | --- |
| `person.dm(text, { quote? })` | `POST /api/whatsapp/dm-reply`, with a swipe-reply quote when given |
| `club.hq.say(memberKey, text, { tag? })` | `POST /api/whatsapp/admin-group` |
| `club.post(memberKey, text, simOpts)` | the players' group, `POST /api/whatsapp/analyze` (the sim's `post`) |
| `club.group` | the underlying `SimGroup`, for anything else the group sim does |
| `pool.signUp(body?, { poolOpen? })` | the /play form: `POST /api/play/signup`, the route the page posts to; returns the code, the prefilled message and the wa.me link |
| `person.dm(text, { messageId?, envelope? })` | also: the same message again (a Pi retry), or a LID on the envelope |
| `pool.dispatchPlatform()` | the Pi's platform poll: claims the due `PlatformJob`s, as the Pi would |
| `pool.note(text)` | a line of commentary in the transcript |

Every action returns `{ json, sent }`: the route's JSON and everything queued
meanwhile. `pool.sent` is everything so far; `pool.collect()` takes what was
queued since the last look (for jobs a scenario wrote or a cron made).

### What MatchTime sent

`SentMessage` is one shape for a `BotJob` (club DM, group post, admin group
post), a `PlatformJob` (a DM that belongs to no club: every pool DM) and an
inline reply the Pi posts (the admin group's `replyText`, the players' group
reply). `to` is the scenario's own name for the recipient: `"ali"`,
`"fnf.pete"`, `"fnf.group"`, `"fnf.hq"`. A number or club the world does not
know is named (`"unknown:+4477..."`, `"org:<id>.group"`), never dropped, so a
message to the wrong person fails the scenario.

| Assertion | Means |
| --- | --- |
| `pool.expectSent(sent, [...])` | exactly these, in order; each `{ to, channel?, text? (contains or RegExp), purpose?, sendAfter? }` |
| `pool.expectSent(sent, [])` | nothing at all |
| `pool.expectNoLeaks(terms, { to?, in? })` | no message (to those recipients, in those messages) contains any term |
| `club.secrets()` | the club members' names and every way their numbers are written |
| `person.phoneVariants()` | +44..., 44..., 07..., "07700 9...", 7700... |

### The database

Plain SQL through `pool.db` (e2e code sits outside the `src/` pool-table
guard). Helpers: `pool.userOf(person)`, `pool.profileOf(person)`,
`pool.pendingByCode(code)`, `pool.failedAttempts(person)`,
`pool.poolRowCounts()`. Scenarios in one file share a database, so count
deltas, not totals. Google is stubbed per scenario (a UK point for every
district). Add a helper here when two slices need the same
query.

### The model

| Kind | How | Cost |
| --- | --- | --- |
| model-free | the default | $0 |
| stubbed | `pool.arm(() => setRouterStub(...))` (any `helpers/stub.ts` seam); `stubbedOnly()` first in the body when the stub is what the scenario tests | $0 |
| live | `liveOnly()` first in the body; run with `MT_SIM_LIVE_LLM=1`; file name ends `-live.spec.ts` | PAID |

A live run spends **`ANTHROPIC_API_KEY_DEV` only**: `e2e/run.ts` drops the
production key and refuses a live run without the developer key, and
`liveOnly()` fails the scenario without it rather than skip or fall back.
In a live run `pool.arm` does nothing, so the real model answers. Live
scenarios are for slices that change what a model reads (L6 offer replies,
L10 asking the pool in words): the cheap plan (failing cases once, one pass
of the affected suite), calls and cost reported, Kemal's yes above $2.

## The scenario catalogue later slices must fill

One scenario per behaviour, in a file per area. Each row is a scenario to
write; "today" rows exist now. EN and TR wherever MatchTime speaks.

### Sign-up and confirmation (L2, G0): BUILT

| Scenario | File |
| --- | --- |
| happy path EN (pool not open: early sign-up list), consent version, time, channel and message id, ONE welcome with the manage and privacy links, nothing to anyone else | `signup-confirm.spec.ts` |
| happy path TR (pool open: not the early list), sports, formats and levels stored | `signup-confirm.spec.ts` |
| 18+ or consent not ticked, a full postcode: nothing is created | `signup-confirm.spec.ts` |
| a campaign code on the URL stamped as the source; an unknown one is the web | `signup-confirm.spec.ts` |
| an unknown code: ONE reply with the /play link (EN, and TR for a Turkish message), then throttled | `confirm-edges.spec.ts`, `stranger-dm.spec.ts` |
| an expired code: told to sign up again; the sign-up stays waiting | `confirm-edges.spec.ts` |
| the code twice (a Pi retry, then the same text again): one profile, one welcome | `confirm-edges.spec.ts` |
| someone forwards another person's code: the number that wrote is recorded; the other gets nothing until he writes | `confirm-edges.spec.ts` |
| a club member signs up: his User reused, his club untouched | `confirm-edges.spec.ts` |
| a LID resolved to his number confirms; a LID alone is neither recorded nor answered | `confirm-edges.spec.ts` |
| a confirmed pool player chatting on; a member asking "what's the code then"; the connect message with a pool code in it | `confirm-edges.spec.ts` |
| a number that never messaged gets nothing | `confirm-edges.spec.ts` |
| a stranger spamming codes: one reply, then locked out (a right code too); reply throttle over time; the per-address sign-up cap; a number or link typed as a name | `confirm-abuse.spec.ts` |
| a stranger's plain DM with no code: still ignored (the brief keeps today's behaviour) | `stranger-dm.spec.ts` |
| a bare self-join connect code ("Code 7KQ2", "Kod", "kodu") reaches the connect handler; the pool neither answers nor counts it (codes are 5 characters, connect codes 4) | `connect-code-untouched.spec.ts` |
| someone already in the pool guessing: counted and locked like anyone; a hit never attaches the other person's sign-up | `confirm-abuse.spec.ts` |
| two wrong codes at once: one reply; two first messages at once from a new number: one User, one welcome, no error | `confirm-abuse.spec.ts` |
| failed sign-ups (a district placed only at the country) count against the address | `confirm-abuse.spec.ts` |
| the consent record: one row per consent and withdrawal, kept after the profile and the User are deleted | `signup-confirm.spec.ts`, `manage-then-message.spec.ts` |
| the daily housekeeping: unconfirmed sign-ups after 7 days, old attempts; the consent record stays | `housekeeping.spec.ts` |

### Managing the profile (L2, L3)

- BUILT (L2, `manage-then-message.spec.ts`, through the real link in the welcome and the real page): stop, then his own message again (silent), then a NEW sign-up's code (never attached: he starts again from his link); delete a pool-only person (he is a stranger again); delete a club member (User and club stay); pause, then a message gets no pool reply. Edit, resume, start again, the badge switch: `e2e/web/play-manage.spec.ts`.
- "stop" in words to MatchTime (L6 reader): stopped, one ack, no more offers
- members opt in from their profile (L3), area defaulted from their clubs' venues

### Offers (L4, L5, L9)

- organiser approves on the match page, by YES to the short-squad notice, by the automatic ask (partners first, D-2); nobody is contacted before the approval
- the offer DM EN and TR: club, venue with address and map link, distance, day, date, kickoff, length, sport and format, play style (omitted when unset), club size and how often it plays, fee ("free" when none), places; NEVER the group name, members' names or numbers (`expectNoLeaks(fnf.secrets())`)
- matching: sport, distance, format where it applies, day AND hours, not already in that club, not blocked either way, turn-up record ranks first
- waves: about 4 first, the rest 30 minutes later only if places are still open, at most 8
- accept by link; accept by words (L6); first-come confirms, organiser-pick puts him on the bench labelled MatchTime pool; organisers told in HQ (or by DM with no HQ) with first name, last initial and turn-up line only
- lost the race: "that place has just gone", outcome `filled`
- decline, then that club cannot offer him again for 14 days
- he pulls out in time and late: the place goes back through the normal drop flow and bench offer

### Caps and quiet hours (L4, L5)

- 2 offers a week, 1 a day, 1 per match, across clubs
- an offer due at 21:45 is held to 08:30 (`sendAfter`), released by the platform poll then and not before
- 3 ignored offers in a row: paused, one DM with the resume link
- the global switch off: nothing queued and nothing dispatched; a club's flag off: the club cannot ask
- 3 pool rounds per club per week

### After the game (L7, L8)

- no-show marked by an organiser; 2 in his last 5 pause him; turn-up record updated
- both sides asked to join (guest privately, admins in HQ, or tagged in the main group with no HQ); only on both yeses the invite link goes to him; never to anyone else
- Invite to club from the Guest players page (organiser's tap is the club's yes); greyed out for a stopped or deleted profile; My invitations Join and No thanks
- an invitation stays open until answered; one open per club and person

### Abuse and safety

- a stranger floods MatchTime with DMs: one reply per 30 days, no model calls
- a club blocks a player, a player blocks a club: no more offers between them
- a report reaches the owner dashboard (no DM to Kemal)
- a stranger guessing codes; a stranger claiming to be a member by display name (pushname is never identity)
- an organiser asking in HQ "who is in the pool?", "give me Ali's number": refused, nothing about anyone

### Privacy leaks (every slice)

- no offer, reply or notice carries another person's number, a member's name to a pool player, a pool player's number or area to a club, or another club he plays for
- the Q&A and every model context never see pool data (`src/lib/pool/__tests__/source-guard.test.ts` holds the code side; scenarios hold the message side)

### Referrals and growth (G1 to G4)

- personal link and campaign code stamped as the source; the referral counts only once the friend has played; Recruiter (1), Scout (3), Talent Spotter (10) announced in the referrer's club group unless he keeps them private; "Brought by X" on the friend's first game
