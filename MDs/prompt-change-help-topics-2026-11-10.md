# Question extractor: the short help menus' topic words (2026-11-10)

Kemal, 2026-11-10: "why this long menu when we say @mt help". The admin group's help (22 lines) and the players' group's help (about 25 lines) became short menus of at most 12 lines. Each ends by teaching "tag me with *help* and the topic", with the topic words. The admin group's topics are squad, teams, players, game, settings, graphics (and payments). Which topic was asked is read by the question extractor's `feature` field, as every help topic has been since 2026-10-28; this prompt had no meaning for "players", "game" or "graphics".

Full texts: `MDs/prompt-question-help-topics-old-2026-11-10.txt` and `MDs/prompt-question-help-topics-new-2026-11-10.txt`.

## What changed in meaning

The `feature` section was rewritten as one list, not appended to:

- Each part now carries the word the menus use for it, English then Turkish, in brackets: squad (kadro), friend (arkadaş), teams (takımlar), players (oyuncu bulma), graphics (görseller), payments (ödeme), game (maç), settings (ayarlar). The word on its own means that part.
- Two new values: `find_players` (asking the players' group, DMing the people a message tagged, the organisers picking who fills a place) and `graphics` (the poster and the team sheet pictures).
- `schedule` is "the games themselves": now also moving or cancelling a game and a game's size, with match days, kick-off times and block bookings.
- `settings` now takes quiet hours and the fewest and most players a club plays with.
- `payments` names a free place; `partners` and `pool` name pairing up, asking and switching on, so asking the pool or partner clubs stays theirs, not `find_players`.
- The "Help with MatchTime" examples were regrouped with the menu words, English and Turkish side by side: help squad, help players, asking the group for a player, help graphics, help game, how quiet hours work.

The Turkish word for the players topic is "oyuncu bulma", not "oyuncu": the router read "@Match Time yardım oyuncu" in the admin group as `ask_group` (a request to find players) in a live check.

## Size

| | characters | tokens (chars / 4) |
|---|---|---|
| OLD | 13,849 | 3,462 |
| NEW | 15,222 | 3,806 |

Above the Haiku cache floor (`cache-threshold.test.ts`).

## Live checks (dev key, each once)

See the PR for the result tables, calls and cost.
