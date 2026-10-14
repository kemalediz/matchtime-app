# Club rehearsal: simulating a real customer before they go live

Written 2026-10-14 for MatchTime, as a reference for other projects (HomeTenant first). It explains what we built, why, how it works and what we learned, so another codebase can build its own version. The code is in `e2e/rehearsal/` (PR #264). Fixes it found are in PRs #265 and #266.

## 1. The problem it solves

A new club (FNF) was about to start using MatchTime. They have four WhatsApp groups (announcements, main chat, an organisers' HQ group, a captains' group), about 25 players, nicknames and their own habits. Kemal wanted to see exactly what MatchTime would do in their groups before going live, without:

- creating real WhatsApp groups,
- finding 25 real phones or people,
- writing fake conversations by hand.

The answer: take the club's real **WhatsApp chat exports**, turn them into a scenario file, and replay them against the **real server code** on an isolated test database, with a **simulated clock** that runs a fortnight in about 5 minutes. Then read one page showing every message in and everything the bot did.

## 2. What it found (why it is worth building)

On its first free run it found five real bugs the club would have hit in week one, all traced in the code and fixed the same day:

1. The bot posted "X is out, one slot open, say IN" in the main chat, although the club had asked for silence there (only ticks).
2. A two-letter name in a pasted list was promised as "I'll add them" in the preview, then refused on YES (a 3-character guard meant for truncated WhatsApp names).
3. A player the organisers added by name was silently dropped from the next week's carried-over squad (treated as a one-off guest because he had no phone number).
4. When the squad was short at team time, the organisers' group was told nothing.
5. Uneven sides (8 v 10) were accepted without a warning; one notice had wrong wording.

It also listed every post the bot makes in the players' group in one place, which let Kemal decide, post by post, what stays there and what moves to the organisers' group. In a live group each of these would have been found one complaint at a time.

## 3. Design principles (carry these over)

1. **Real server, fake world.** Everything after "a message arrives" is the real production code path: the same HTTP routes the WhatsApp bot (the Pi) calls, the same crons, the same database writes. Only the edges are simulated: WhatsApp, the people, the clock, and (in the free mode) the AI model.
2. **Isolated database.** It runs on the embedded Postgres the e2e suite already uses, never production. Nothing touches the live bot, the Pi, Vercel or real WhatsApp.
3. **Generic harness in the repo, customer data never.** The repo holds a generic runner that reads a scenario file, plus a fictional example scenario. The real customer's scenario, the export parser for their chats, and all outputs live in a private scratch folder. Real names, phone numbers, message text and images are never committed. Grep the diff before every PR.
4. **Move the clock, not the code.** Most routes read `new Date()` directly, so a per-route "pretend time" header is not enough. A small preload script replaces the global `Date` inside the test server so "now" = real now + an offset read from a file. The runner writes the offset before each step. Unset, it is exactly the real clock. Timers are untouched.
5. **Two modes, and say which one ran.**
   - **Stubbed (default, free):** the AI router/extractor answers come from stubs. The honest stub for replayed real chat is "no route" (the bot stays silent); only plain "in"/"out" get the obvious route; scripted steps say what the model would answer. The transcript states in bold that this mode does NOT prove the model's behaviour.
   - **Live (opt-in, paid):** real model calls, on the **development API key only**, refusing to run without it, never the production key. Needs Kemal's approval for each run (estate rule). The stubbed run measures how many model calls a live pass would make, so the cost is known before asking (FNF: about 164 calls, about $0.64).
6. **Stand-ins are labelled.** Anything the harness cannot drive through a real route (the website sign-up, the settings page) is a direct DB write, and every one is marked STAND-IN in the transcript, so nobody mistakes it for tested behaviour.
7. **Findings are reported, not fixed, in the harness branch.** The harness PR only adds the harness. Each bug it finds is listed with the exact reproduction and the traced code path, then fixed in its own PR with a failing test first.

## 4. How it is built (MatchTime specifics)

```
e2e/rehearsal/
  scenario.ts        scenario file format v1: parse + validate, time zones (pure)
  clock.ts           turns the timeline into ticks, fires crons on their vercel.json schedule (pure)
  clock-shim.cjs     the Date replacement preloaded into the test server
  driver.ts          plays the WhatsApp side against the real routes
  stub-routes.ts     what the stubs answer, and the live-cost estimate (pure)
  transcript.ts      builds transcript.md + transcript.html (pure)
  rehearsal.spec.ts  the Playwright spec that runs one scenario (skipped unless a scenario is given)
  examples/riverside.scenario.json   fictional example, committed
```

Wiring changes outside the folder: `e2e/helpers/env.ts` (server-only env that preloads the shim when `MT_REHEARSAL_SCENARIO` is set), `playwright.config.ts` (picks up `rehearsal/`), `e2e/run.ts` (`REHEARSAL_LIVE=1` requires the dev key), `vitest.config.ts` (unit tests for the pure parts).

### The scenario file

Plain JSON: the club and its settings, the groups (role: players / admin / other; is the bot a member; admins-only posting), the members (name, WhatsApp display name, fake phone, role, groups), and a timeline of steps. Step types:

| step | meaning |
|---|---|
| `message` | someone writes in a group; optional stub `route`/`facts`, `tag` (@bot), `media` |
| `dm` | someone writes to the bot directly |
| `vote` | someone votes in the latest bot poll matching a regex |
| `react` | someone reacts to a bot message |
| `rate` | someone opens their rating link and submits the real page in a browser |
| `club-signup`, `approve`, `settings`, `link-admin-group`, `go-live`, `bot-added` | the onboarding path |
| `cron`, `pi-poll` | fire a scheduled job or an extra poll at this instant |
| `note` | a heading in the transcript |

### The driver (what "the Pi" does)

- **Players' group:** messages are buffered and sent to the analyze route in batches (as the Pi does, every ten minutes) with recent history; reactions and replies are recorded; replies pass the same "can the bot post here" gate as on the Pi.
- **Admin group:** each message goes straight to the admin-group route.
- **Due posts:** polls the due-posts route like the Pi, records every instruction, acks it with a made-up WhatsApp id, and downloads generated images (posters, team sheets) to files.
- **Platform jobs:** sign-up and approval DMs.
- **Crons:** fired on their real schedule as the clock passes them.
- After each step it snapshots the relevant DB state and records the diff (attendance changes, team assignments, match status) in the transcript.

### The private part (per customer, never committed)

A small script in the scratch folder parses the WhatsApp `_chat.txt` exports (one per group) into a scenario:

- real display names allowed locally, **phones replaced with fake numbers**;
- the real messages replayed with their **real relative timing**, shifted onto an upcoming fortnight;
- scripted steps added for what could not be in the exports because the bot was not there yet: approval and settings, the organisers pasting the list and saying YES, drop-outs and replacements, team proposal and changes, the game, the score, votes, ratings, payments, then week two.

### The output

`transcript.html` (WhatsApp-like, per group, time-ordered, images embedded) and `transcript.md`, with a summary at the top:

- what the bot posted per group, DM counts per person;
- a **violation check** for the club's hard rules (here: the squad or teams must never be listed in the players' group), shouted if broken;
- every other post in the players' group, each needing a decision;
- errors, unknown names, final squad and teams per match, votes and ratings, payment state;
- the measured number of model calls and the live-mode cost estimate.

Run it (from a git worktree if the main checkout's dev server misbehaves):

```bash
MT_REHEARSAL_SCENARIO=e2e/rehearsal/examples/riverside.scenario.json npx tsx e2e/run.ts rehearsal/
MT_REHEARSAL_SCENARIO=<private>/club.scenario.json MT_REHEARSAL_OUT=<private>/out npx tsx e2e/run.ts rehearsal/
```

## 5. Gotchas we hit

- **The DB clock is real, only the server's moves.** Any timestamp the driver writes itself must be the simulated time, never the database's `now()`.
- **Stale local test DB.** After schema changes, `prisma db push` may refuse ("data loss" on new unique constraints). Delete the local embedded Postgres data dir (`.e2e/pgdata`) and rerun.
- **Scripted steps can create their own oddities.** One "bug" (8 v 10 teams) was the script typing "move" instead of "swap". Trace before calling something a product bug; here it still led to a real improvement (warn on uneven sides).
- **A filter in the summary can hide things.** Read the transcript, not just a grep of it.
- **Count posts, not just errors.** The most valuable output was the plain list of everything the bot said in the customer-facing group.

## 6. Adapting it to another product (e.g. HomeTenant)

What carries over unchanged: the principles in section 3, the scenario-file idea, the clock shim (it is framework-independent Node), the stubbed/live split with a dev-key guard, the transcript-with-summary output, and the "generic harness in repo, customer data private" rule.

What must be rebuilt for the other product:

1. **The driver:** it must call that product's own inbound routes the way its WhatsApp bot does (batching, history, gates), and poll its own outbound queue.
2. **The step types:** whatever the product's real events are (e.g. a tenant message, a landlord reply, a payment, a scheduled reminder).
3. **The export parser:** turn that product's real past conversations into a scenario, anonymising phones (and anything else sensitive, such as bank details) locally.
4. **The violation checks:** that product's hard rules (things the bot must never say or do in a given place), checked automatically in the summary.
5. **The cost estimate:** count the model calls a live pass would make from the stubbed run, and ask before running live.

Suggested order: build the generic runner with one fictional scenario and unit tests (TDD) first; then one private replay of a real customer's history, free mode; review the transcript; fix what it finds in separate PRs; only then ask for one approved live pass.
