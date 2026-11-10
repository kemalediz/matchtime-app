# Router: "help &lt;topic&gt;" is help, whatever the topic (2026-11-10)

The short help menus (#591) end "tag me with *help* and the topic" and list the topic words. #591's paid checks found the router sending "@Match Time help teams" in the players' group to the team builder. Every word the menus advertise must reach the help, in both groups and by DM, English and Turkish.

Full texts: `MDs/prompt-router-help-topics-old-2026-11-10.txt` and `MDs/prompt-router-help-topics-new-2026-11-10.txt`.

## What happened before (measured on main, dev key, each once)

| message (players' group) | router | then |
|---|---|---|
| "@Match Time help teams" | `balancer` | teams extractor read `show`: the teams path re-posts the current team sheet, or says "No teams generated yet. Tag me and ask for them..." with 🤔. Nothing is built or written (show is read-only). |
| "@Match Time yardım takımlar" | `balancer` | the same, `show` |
| "@Match Time help pool" | `admin_ops` once, `question` on a rerun | admin extractor read `other` (2 of 2): "Sorry, I can't do that one yet." (an admin gets the settings page line) |

Every other advertised word, in the players' group, HQ and DM, reached the help with the right topic (75 of 78).

Code path for the balancer case: `team-ops-engine-batch.ts:619` leaves `show` to `answer-batch.ts` (`balancer` branch at `:1386`, `ANSWER_TEAM_ACTIONS = ["show"]` in `route-flags.ts:283`), then `engine.ts:1989` (`handleTeams`, show): no teams, `teams_not_generated` (`strings.en.ts:614`); teams made, `teams_post`. React 🤔 or 👀 at `answer-batch.ts:1977`. Admin `other`: `admin-ops-engine-batch.ts:787`, reply at `:1065`.

## Why

`help` was defined only in the organisers' section, as "asks MatchTime what it can do here, or how to get it to do something". In the players' group how-it-works sat inside `question` ("how MatchTime works here (the bench, signing in, how the teams are picked)"), and nothing said that a part named after "help" is not being asked for. "help teams" read as a request about the teams.

## What changed in meaning

- `help` is now ONE route for both groups, defined once among the routes: what MatchTime can do, a bare help, how one part works, what it is, how to use or switch it on. "help X" / "yardım X", "how does X work?" and "what is X?" ask how X works, whatever X names, and never ask for X to be done, shown or changed; help settles nobody's place. Telling the others what MatchTime does stays `none`.
- `question` keeps what the bot holds (squad, stats, the club's setup, when the teams come out); "how MatchTime works here" moved to `help`.
- The teams ruling: WHEN they come out is `question`, HOW they are picked is `help`.
- The organisers' section: help's own line and its examples went (now shared); a message there is for the bot also when it "asks it for help".
- Examples: one shared group, bare help, an action word after help beside the action itself ("help swap" vs "swap Tom and Ali"), "help bench", "how does the player pool work?", and the two telling-the-others `none` lines, EN and TR side by side. The two "Bench? We do bench now?" reply examples are `help`. The menus' own topic words are kept OUT of the examples, so the live check is held out.
- Code: in the players' group `help` is still read as `question` (the question extractor answers it), now without a degradation note, and `help` left `ORGANISER_ONLY_ROUTES`.

## Size

| | characters | tokens (count_tokens, claude-haiku-5-5, one-token message) |
|---|---|---|
| OLD | 21,689 | 8,214 |
| NEW | 22,377 | 8,496 |

Above the cache floor (`cache-threshold.test.ts`, router test).

## Live checks (dev key, each case once)

| check | before (main) | after |
|---|---|---|
| `scripts/live-check-help-topics.ts`: every menu word with help, EN and TR, players' group (router + question extractor), HQ (router + question extractor), DM (question extractor), plus bare help | 75/78 | 78/78 |
| same script: "make the teams", "takımları kur", "show the teams", "ask the group if anyone can play", players' group and HQ (router, teams extractor action) | 8/8 | 8/8 |
| `scripts/live-check-help-routing.ts` (#591's help routing) | | 37/37 |
| `scripts/live-check-router-teams-time.ts` (REPEAT=1, BOUNDARY_REPEAT=1) | | 26/26 |
| `scripts/live-check-router-find-players.ts` (REPEAT=1, BOUNDARY_REPEAT=1) | | 26/26 |
| `e2e/replay/router-regressions-live.ts` (1 run) | | attendance lost to none 0/20; 19/20 reached an allowed owner (one N case, "@Zeeshan they asked can anyone step in...", routed `unsure`: reported, not failed on) |
| `scripts/live-check-form-note.ts` | | router 23/23, teams extractor 17/17, end to end ok |
| `scripts/live-check-hq-questions.ts` | | 71/71 |
| `scripts/live-check-players-teams-2026-10-30.ts` | | 10/10 |

All runs together, including the before run and two small traces: 575 model calls, about $0.09.
