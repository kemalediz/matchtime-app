# Router prompt: several instructions in one message (2026-11-16)

## Why

Vets, 16 Nov 2026 18:07 UTC: "@Match Time switch to 7aside, take Luca to bench, @<mention> is IN and then make the teams". The router gave one route per message (other_att), so only the attendance engine acted. The switch and the teams were dropped and the organiser was never told; the match stayed at 16 places and the team sheet said 2 places were still needed.

## What changed in meaning

- The answer gains `also`: the OTHER routes a message tells MatchTime to carry out. `route` keeps its meaning (the owner that answers), so a message with one instruction, and every stored trace, reads as before.
- "The place wins" now says where the rest goes: the place is still the route, the other parts go in `also`.
- One new paragraph, defined once after the three questions: what counts as another instruction (only an instruction or question to the bot; a request to a person, a reason, a condition or chat does not), and that more names in or out never add to `also`.
- One example group, English and Turkish side by side.
- Nothing appended at the end; the output contract line is where it was.

Size: 22,377 to 24,391 characters (+9%). Cached prefix (system plus schema) measured live: 9,842 tokens, above the cache floor.

Schema (review of #613): `also` offers every route but `none` and `unsure`, and `also` never changes `route`. The prompt text is unchanged by that review. Re-run on the dev key after it: the 25 cases 22/22 (25 calls, $0.0069); the 59-message made-up attendance stand-in, main's prompt vs this one, 58/59 vs 59/59, no attendance message lost (28 calls, $0.0082).

## Old and new, the passages that changed

| Old | New |
|---|---|
| For EVERY message id you are given, return exactly one route: the part of MatchTime that handles the message, or none when it is chat between people and not for the bot. | For EVERY message id you are given, return its route: the part of MatchTime that handles the message, or none when it is chat between people and not for the bot. When one message gives MatchTime more than one instruction, also name the parts that handle the others, so that none is dropped. |
| (question 1) When it also changes a setting, the place wins. Nothing below overrides this. | (question 1) When it also tells MatchTime to do something else (change a setting, make the teams), the place still wins the route and the rest goes in also. Nothing below overrides this. |
| (none) | SEVERAL INSTRUCTIONS IN ONE MESSAGE. An organiser often packs two, three or four instructions into one message ("@Match Time make it 6 aside, Ali is out, Musa is in, then do the teams"). The three questions give its route; then put in also every OTHER route the message tells or asks MatchTime to carry out, each once, so that every part is done. Only an instruction or a question to the bot counts: a reason, a condition, a joke, chat around it, or a request made to a person ("@Kemal can you switch it to 7 a side") is not one. Every place in the message is covered by its one attendance route, so more names in or out never add to also. A message with one instruction, as almost every message is, has an empty also. |
| (none) | Several instructions in one message: the route as above, every other part in also: "make it 6 aside, Ali is out and Musa is in, then do the teams" -> other_att, also admin_ops, balancer (and TR); "switch Thursday to 8 aside and generate the teams" -> admin_ops, also balancer (and TR); "I'm out, swap Tom with Ali" -> self_att, also balancer; "I'm out, what's the list now?" -> self_att, also question (and TR); "Ali is in, Musa is in, Jem is out" -> other_att, also nothing |
| THE ANSWER. For every id give its route and two facts about the message; neither changes the route. | THE ANSWER. For every id give its route, the other routes it also needs, and two facts about the message; neither fact changes the route. also: the OTHER routes the message tells MatchTime to carry out besides its route, each once, as SEVERAL INSTRUCTIONS says; [] for a message with one instruction. Never its route again, never none. |
| Return JSON only: {"routes":[{"id":"<id>","route":"<route>","to_bot":...,"pasted_list":...}]} | Return JSON only: {"routes":[{"id":"<id>","route":"<route>","also":[<the other routes; empty for one instruction>],"to_bot":...,"pasted_list":...}]} |

## Live check (dev key, once each, made-up names)

`scripts/live-check-multi-instruction.ts`: 25 calls, $0.011.

| Set | Result |
|---|---|
| The incident, router plus the three extractors (admin: switch_format 7; attendance: Luca bench, Zak in; teams: generate) | 1/1 |
| Other messages with two or three instructions, EN and TR, both groups | 8/8 |
| Single-instruction messages (IN, OUT, several names, a replacement, a request to a person, teams, swap, question, a switch alone, a score, banter, tagged thanks, HQ ask_group): route kept, `also` empty | 13/13 |

Not run: the 373-message attendance veto replay (`npm run replay:router-attendance`), which is this prompt's own certification gate.
