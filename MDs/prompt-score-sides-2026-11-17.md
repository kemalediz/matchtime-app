# Score: whatever the club calls its sides (2026-11-17)

## Why

Monday night vets, 16 Nov 2026 22:14: "@Match Time bibs 9, no bibs 4" after the game. The router sent it to admin_ops (stored trace), the admin extractor read action "other", and MatchTime replied with a "can't do that" line, twice. The organiser deleted the replies and entered the score by hand. `Match.teamLabels` was empty: in MatchTime's data the sides were "Red" and "Yellow", on the pitch they were the bibs and the no bibs.

## What changed in meaning

Router (players' group; the HQ "WAITING: the final score" line now also names the club's names when it has them):
- A new FACT line under NOW while the club's last game has finished and has no score (a day from the end of the game): "MATCHTIME IS WAITING for the score of the club's last game (Mon 16 Nov 20:15), which has finished. Its two sides are Red and Yellow; this club also calls Red "bibs" and Yellow "no bibs"." No route is forced.
- The prompt says what the line means, where it defines what the model is shown.
- score's definition names the ways people call the sides, says a scoreline after the game is a result and never an instruction, adds "which team a name was" to what MatchTime may be waiting for, and says chat about the game is none.
- The results example group is regrouped: the club's own names, a player's team, the answer to the name question, post-game praise as none, EN and TR side by side. The incident's own words are held out of the examples.

Score extractor (rewritten whole):
- It reads THE GAME: whether the score is awaited and, per side, MatchTime's name, what this club also calls it and its players. A recorded result is NOT shown (see the live check).
- One new field, `teamSides`: which side each name means, from THE GAME only, "unknown" otherwise ("never guess which side wore the bibs or whose team a name was").
- "THE TWO SIDES" says once how people name the sides and what MatchTime asks ("Which team was bibs, Red or Yellow?", only ever about the winning side's name).
- One new example group (names unknown, names known, a player's team, the answer to the name question), EN and TR.

Sizes: router 24,563 to 25,643 characters (measured on top of #618); score extractor 4,539 to 6,808 characters.

## Router: old and new, the passages that changed

| Old | New |
|---|---|
| - A "MATCHTIME IS WAITING to hear ... which team won" or "MATCHTIME HAS RECORDED" line above a message: this sender may answer which team won the scoreline MatchTime asked about, or may correct the result it recorded. The line says what the sender MAY do; route on what the message does. | - A "MATCHTIME IS WAITING for the score" line under NOW: the club's last game has finished and its result is not in yet. It names the game's two sides as MatchTime calls them and what this club also calls them; people name the sides in many other ways too (a colour, "bibs" and "no bibs", a player's team, "we"). <br>- A "MATCHTIME IS WAITING to hear ... which team won" or "MATCHTIME HAS RECORDED" line above a message: this sender may answer what MatchTime asked about the score, or may correct the result it recorded. <br>Each of these lines says what MatchTime is waiting for or may accept; route on what the message does. |
| score: reports the final result of this group's own match (our team names, our colours or a bare scoreline), answers which team won or who was its Man of the Match while MatchTime is WAITING for that (a team named alone, "Yellow", "sarılar kazandı"; praise alone answers nothing), or says a recorded result is wrong (...). A professional scoreline somebody is watching is none. | score: reports the final result of this group's own match, however it names the two sides (MatchTime's names, colours, bibs and no bibs, a player's team, "we") or as a bare scoreline: a scoreline for the two sides after the game is a result, tagged or not, never an instruction to the bot; answers what MatchTime asked about the result while it is WAITING (which team won, which team a name was, or who was Man of the Match: a team named alone, "Yellow", "sarılar kazandı"; praise alone answers nothing); or says a recorded result is wrong (...). A professional scoreline somebody is watching is none, and so is chat about the game that gives no result ("great game lads"). |
| Results: "5-3 to Yellows" -> score; "10-10" -> score; "Arsenal 2 Spurs 1" -> none | Results, whatever the sides are called; chat about the game is not one: "5-3 to Yellows" -> score; "10-10" -> score; "@Match Time bibs won 7-5" / "@Match Time yelekliler 7-5 kazandı" -> score; "Sam's team 6, Leo's team 3" / "Sam'in takımı 6, Leo'nun takımı 3" -> score; "Red" replying to MatchTime's "Which team was bibs: Red or Yellow?" / "kırmızı" replying to its Turkish twin -> score; "what a game, well played all" / "harika maçtı, eline sağlık herkesin" (MatchTime waiting for the score) -> none; "Arsenal 2 Spurs 1" -> none |

## Score extractor: old (whole)

```
You read ONE message from a football group's WhatsApp chat about the result of the group's own match and report what it SAYS. You never decide which team is which, who won, who a player is, or what gets recorded: code does that.

THE MESSAGE is the one you report on, with its sender. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST, NOW (the time at the club) and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line). They tell you what THE MESSAGE answers or disputes; never take a number, team or name from them. The group's own match is its latest game: "tonight", "today", "last night", "yesterday", "dün akşam" and "earlier" all mean that latest game.

A TEAM REFERENCE below is the team's name as written ("yellows", "Reds", "Sarılar"), "us" for the sender's own side ("we", "biz", "kazandık"), "them" for the other side, or "" when not said. Never work a team out.

WHAT YOU RETURN
hasScore
true when THE MESSAGE states the two numbers of a result; false when it has none ("yellows won", "wrong way round", "MoM Naim"), and first and second are then 0.
first, second
the two numbers of the final result, in the order written. In a story ("it was 6-6 then it turned to 9-6") the last one.
firstTeam, secondTeam
the team written directly beside the first or the second number, with no word about who won or lost. It stays there when THE MESSAGE answers MatchTime's "which team won?" with a scoreline.
winner
the team a word names as the winner: "to" or "for" a team, "won", "wins", "beat", "kazandı", "yendi". A bare team name, the whole message, answering MatchTime's "which team won?" is the winner too. "" otherwise: for a draw, for a question ("Yellow?", "sarılar mı?"), and for chat that only mentions a team.
loser
the team a word names as the loser: "lost", "got beaten", "kaybetti", "yenildi". "" otherwise.
momRef
the player named Man of the Match ("MoM", "man of the match", "POTM", "maçın adamı"), as written, or a bare name answering MatchTime's question who it was. "" otherwise; praise alone ("Naim was class") is "".
correction
true only when THE MESSAGE says a result already given for this match was wrong ("no, it was...", "yanlış", "hayır ... olacak"), as when it disputes the result it quotes. A first report is false, even straight after MatchTime asked for the score.
swapped
true when it says the teams are the wrong way round ("other way round", "tam tersi"); correction is then true too.
otherGame
true only when THE MESSAGE is plainly about a game before the latest one ("last week", "geçen ay"); correction is then false.

EXAMPLES, English and Turkish
A word names the winner:
  "5-3 to Yellows" / "sarılar 5-3 kazandı" -> hasScore true, first 5, second 3, winner "Yellows" / "sarılar"
  "4-6 to Yellows" -> first 4, second 6, winner "Yellows"
  "it was 6-6 then suddenly it turned to 9-6 to yellows" -> first 9, second 6, winner "yellows"
A team beside a number:
  "Yellow 9 - 6 Red" -> first 9, second 6, firstTeam "Yellow", secondTeam "Red"
  "kırmızı 6 sarı 9" -> first 6, second 9, firstTeam "kırmızı", secondTeam "sarı"
  "Reds 3-5" -> first 3, second 5, firstTeam "Reds", winner ""
  "7-4 yellows", answering MatchTime's "which team won?" -> first 7, second 4, secondTeam "yellows", winner ""
The sender's side:
  "we won 5-3" / "5-3 kazandık" -> first 5, second 3, winner "us"
  "lost 3-5" / "3-5 kaybettik" -> first 3, second 5, loser "us"
  "reds beat us 7-2" -> first 7, second 2, winner "reds", loser "us"
No team, or no numbers:
  "10-7" / "7-7 berabere" -> hasScore true, the two numbers, every team field ""
  "yellows won" / "sarılar kazandı" -> hasScore false, winner "yellows" / "sarılar"
  "Yellow", the whole message, answering MatchTime's "which team won?" -> hasScore false, winner "Yellow"
Man of the Match:
  "Yellow won 7-4, MoM Naim" / "sarı 7-4 kazandı, maçın adamı Naim" -> first 7, second 4, winner "Yellow" / "sarı", momRef "Naim"
  "Naim", answering MatchTime's question who was Man of the Match -> hasScore false, momRef "Naim"
A correction:
  "no Yellow 9 - 6 Red" / "yanlış, kırmızı 6 sarı 9" -> correction true, numbers and teams as above
  "wrong way round, yellows won" / "tam tersi, sarılar kazandı" -> hasScore false, correction true, swapped true, winner "yellows" / "sarılar"
The latest game or an earlier one:
  "Red won 4-2 last night" / "dün akşam kırmızı 4-2 kazandı" -> first 4, second 2, winner "Red" / "kırmızı", otherGame false
  "last week we lost 9-2" / "geçen ay 5-0 yenmiştik" -> loser "us" / winner "us", otherGame true
```

## Score extractor: new (whole)

```
You read ONE message from a football group's WhatsApp chat about the result of the group's own match and report what it SAYS. You never decide who won, who a player is, or what gets recorded: code does that.

WHAT YOU ARE SHOWN. THE MESSAGE is the one you report on, with its sender. Above it you may see RECENT CHAT, MATCHTIME'S LAST POST, NOW (the time at the club), the message it quotes when it is a WhatsApp reply (the THEY ARE REPLYING TO line), and THE GAME: the group's latest game, whether MatchTime is waiting for its score, and its two sides, red and yellow, each with the name MatchTime calls it, what this club also calls it, and the players on it. They tell you what THE MESSAGE answers or disputes and which side a name means; never take a number from them. The group's own match is its latest game: "tonight", "today", "last night", "yesterday", "dün akşam" and "earlier" all mean that latest game.

THE TWO SIDES. People call the sides many things: MatchTime's names ("Red", "Sarılar"), colours, "bibs" and "no bibs", a player's team ("Dan's team"), "we" and "they". A TEAM REFERENCE below is a side as written ("yellows", "Reds", "bibs", "Dan's team"), "us" for the sender's own side ("we", "biz", "kazandık"), "them" for the other side, or "" when not said. When MatchTime cannot tell a side, it asks which team won, or which team a name was ("Which team was bibs, Red or Yellow?"); it only ever asks that about the name of the side with the bigger number.

WHAT YOU RETURN
hasScore
true when THE MESSAGE states the two numbers of a result; false when it has none ("yellows won", "wrong way round", "MoM Naim", "red"), and first and second are then 0.
first, second
the two numbers of the final result, in the order written. In a story ("it was 6-6 then it turned to 9-6") the last one.
firstTeam, secondTeam
the team reference written directly beside the first or the second number, with no word about who won or lost. It stays there when THE MESSAGE answers MatchTime's question with a scoreline.
winner
the team reference a word names as the winner: "to" or "for" a team, "won", "wins", "beat", "kazandı", "yendi". A bare team name, the whole message, answering MatchTime's "which team won?" is the winner too. "" otherwise: for a draw, for chat that only mentions a team, and for a question ("Yellow?", "sarılar mı?", "was it the bibs?"), which asks and answers nothing.
loser
the team reference a word names as the loser: "lost", "got beaten", "kaybetti", "yenildi". "" otherwise.
teamSides
which side each name means, by THE GAME: one entry for every team reference you return other than "us" and "them", and, when THE MESSAGE answers MatchTime's "which team was X?", one for X with the side the answer gives. side is "red" or "yellow" when THE GAME places the name: it is the name MatchTime calls that side, a name this club also calls it, its colour while MatchTime calls it by its colour, or the team of a player listed on it ("Dan's team" is Dan's side). Otherwise "unknown": never guess which side wore the bibs or whose team a name was. [] when THE MESSAGE names no side.
momRef
the player named Man of the Match ("MoM", "man of the match", "POTM", "maçın adamı"), as written, or a bare name answering MatchTime's question who it was. "" otherwise; praise alone ("Naim was class") is "".
correction
true only when THE MESSAGE says a result already given for this match was wrong ("no, it was...", "yanlış", "hayır ... olacak"), as when it disputes the result it quotes. A first report is false, even straight after MatchTime asked for the score.
swapped
true when it says the teams are the wrong way round ("other way round", "tam tersi"); correction is then true too.
otherGame
true only when THE MESSAGE is plainly about a game before the latest one ("last week", "geçen ay"); correction is then false.

EXAMPLES, English and Turkish side by side. Fields not shown are "", false or [].
A word names the winner:
  "5-3 to Yellows" / "sarılar 5-3 kazandı" -> hasScore true, first 5, second 3, winner "Yellows" / "sarılar", teamSides [{"team":"Yellows","side":"yellow"}] / [{"team":"sarılar","side":"yellow"}]
  "4-6 to Yellows" -> first 4, second 6, winner "Yellows"
  "it was 6-6 then suddenly it turned to 9-6 to yellows" -> first 9, second 6, winner "yellows"
A team beside a number:
  "Yellow 9 - 6 Red" -> first 9, second 6, firstTeam "Yellow", secondTeam "Red"
  "kırmızı 6 sarı 9" -> first 6, second 9, firstTeam "kırmızı", secondTeam "sarı"
  "Reds 3-5" -> first 3, second 5, firstTeam "Reds", winner ""
  "7-4 yellows", answering MatchTime's "which team won?" -> first 7, second 4, secondTeam "yellows", winner ""
The club's own names for its sides, placed only by THE GAME:
  "bibs 7, no bibs 5" / "yelekliler 7 yeleksizler 5", THE GAME giving neither name -> first 7, second 5, firstTeam "bibs" / "yelekliler", secondTeam "no bibs" / "yeleksizler", teamSides both "unknown"
  the same, THE GAME saying this club calls red "bibs" and yellow "no bibs" -> teamSides [{"team":"bibs","side":"red"},{"team":"no bibs","side":"yellow"}]
  "Sam's team won 6-2" / "Sam'in takımı 6-2 kazandı", THE GAME listing Sam on yellow -> first 6, second 2, winner "Sam's team" / "Sam'in takımı", teamSides [{"team":"Sam's team","side":"yellow"}] / [{"team":"Sam'in takımı","side":"yellow"}]
  "Red", the whole message, answering MatchTime's "Which team was bibs?" / "kırmızı", answering "yelekliler hangi takımdı?" -> hasScore false, teamSides [{"team":"bibs","side":"red"}] / [{"team":"yelekliler","side":"red"}]
The sender's side:
  "we won 5-3" / "5-3 kazandık" -> first 5, second 3, winner "us"
  "lost 3-5" / "3-5 kaybettik" -> first 3, second 5, loser "us"
  "reds beat us 7-2" -> first 7, second 2, winner "reds", loser "us"
No team, or no numbers:
  "10-7" / "7-7 berabere" -> hasScore true, the two numbers, every team field ""
  "yellows won" / "sarılar kazandı" -> hasScore false, winner "yellows" / "sarılar"
  "Yellow", the whole message, answering MatchTime's "which team won?" -> hasScore false, winner "Yellow"
Man of the Match:
  "Yellow won 7-4, MoM Naim" / "sarı 7-4 kazandı, maçın adamı Naim" -> first 7, second 4, winner "Yellow" / "sarı", momRef "Naim"
  "Naim", answering MatchTime's question who was Man of the Match -> hasScore false, momRef "Naim"
A correction:
  "no Yellow 9 - 6 Red" / "yanlış, kırmızı 6 sarı 9" -> correction true, numbers and teams as above
  "wrong way round, yellows won" / "tam tersi, sarılar kazandı" -> hasScore false, correction true, swapped true, winner "yellows" / "sarılar"
The latest game or an earlier one:
  "Red won 4-2 last night" / "dün akşam kırmızı 4-2 kazandı" -> first 4, second 2, winner "Red" / "kırmızı", otherGame false
  "last week we lost 9-2" / "geçen ay 5-0 yenmiştik" -> loser "us" / winner "us", otherGame true
```

## Live check (dev key, made-up names, once)

`scripts/live-check-score-sides.ts`. First pass: 88 calls, $0.0172, router 23/23, batch 16/16, existing score cases 47/49. The two misses were regressions of the new prompt, confirmed against the old prompt on the same cases (3 runs each, 12 calls, $0.0023):
- G1 "@Match Time it was 9-2 to yellow" with a result recorded: read as a correction 3/3 (old prompt 0/3), because THE GAME stated the recorded result. Fixed by not showing a recorded result.
- A4 "Yellow?" answering "which team won?": read as the winner 2/3 (old 0/3). Fixed by saying once more that a question names no winner.
After the fix the two cases 3/3 each (12 calls, $0.0019), then the full check again: 88 calls, $0.0147, all pass. Also `scripts/live-check-multi-instruction.ts` once on the changed router prompt: 25/25 groups (1/1, 8/8, 13/13), 25 calls, $0.0092.

After rebasing onto #618 (which rewrote the router's MATCHTIME ASKED bullet), the full check once more on the merged prompts: 88 calls, $0.0166, router 23/23, batch 16/16, existing 49/49. The table below is that pass.

Total: 313 model calls, $0.0619.

| Set | Case | Result | Message, outcome |
|---|---|---|---|
| router | R1 | PASS | "@Match Time bibs 9, no bibs 4"                  -> score     (want score) |
| router | R2 | PASS | "bibs 9, no bibs 4"                              -> score     (want score) |
| router | R3 | PASS | "@Match Time no bibs 9,  bibs 4"                 -> score     (want score) |
| router | R4 | PASS | "@Match Time we won 5-3"                         -> score     (want score) |
| router | R5 | PASS | "9-4 to Dan's team"                              -> score     (want score) |
| router | R6 | PASS | "Red 9 Yellow 4"                                 -> score     (want score) |
| router | R7 | PASS | "@Match Time yelekliler 9 yeleksizler 4"         -> score     (want score) |
| router | R8 | PASS | "@Match Time bibs 9, no bibs 4"                  -> score     (want score, line names) |
| router | R9 | PASS | "@Match Time red"                                -> score     (want score) |
| router | R10 | PASS | "great game lads"                                -> none      (want none) |
| router | R11 | PASS | "enjoyed that, see you all next week 💪"         -> none      (want none) |
| router | R12 | PASS | "@Match Time cheers for sorting tonight 👍"      -> none      (want none) |
| router | R13 | PASS | "Arsenal 2 Spurs 1"                              -> none      (want none) |
| router | R14 | PASS | "In"                                             -> self_att  (want self_att) |
| router | R15 | PASS | "Rory OUT"                                       -> other_att (want other_att) |
| router | R16 | PASS | "@Match Time make it 8 aside"                    -> admin_ops (want admin_ops) |
| router | R17 | PASS | "@Match Time make it 6 v 6 next week"            -> admin_ops (want admin_ops) |
| router | R18 | PASS | "@Match Time how many are in so far?"            -> question  (want question) |
| router | R19 | PASS | "@Match Time make the teams please"              -> balancer  (want balancer) |
| router | R20 | PASS | "@Match Time what was the score last week?"      -> question  (want question) |
| router | R21 | PASS | "bibs 9 no bibs 4"                               -> score     (want score, HQ) |
| router | R22 | PASS | "5-3 to Yellows"                                 -> score     (want score, line off) |
| router | R23 | PASS | "great game lads"                                -> none      (want none, line off) |
| batch | B1 | PASS | "@Match Time bibs 9, no bibs 4"                  -> asked about "bibs" (want asked about "bibs") |
| batch | B2 | PASS | "@Match Time red"                                -> Red 9, Yellow 4 (want Red 9, Yellow 4); learned {"red":["bibs"],"yellow":["no bibs"]} |
| batch | B3 | PASS | "@Match Time bibs were red"                      -> Red 9, Yellow 4 (want Red 9, Yellow 4); learned {"red":["bibs"],"yellow":["no bibs"]} |
| batch | B4 | PASS | "@Match Time yellow"                             -> Red 4, Yellow 9 (want Red 4, Yellow 9); learned {"red":["no bibs"],"yellow":["bibs"]} |
| batch | B5 | PASS | "@Match Time bibs 9, no bibs 4"                  -> Red 9, Yellow 4 (want Red 9, Yellow 4) |
| batch | B6 | PASS | "bibs 9, no bibs 4"                              -> Red 9, Yellow 4 (want Red 9, Yellow 4) |
| batch | B7 | PASS | "@Match Time non bibs won 6-2"                   -> Red 2, Yellow 6 (want Red 2, Yellow 6) |
| batch | B8 | PASS | "@Match Time no bibs 9,  bibs 4"                 -> asked about "no bibs" (want asked about "no bibs") |
| batch | B9 | PASS | "@Match Time Dan's team won 5-3"                 -> Red 3, Yellow 5 (want Red 3, Yellow 5) |
| batch | B10 | PASS | "9-4 to Dan's team"                              -> Red 4, Yellow 9 (want Red 4, Yellow 9) |
| batch | B11 | PASS | "@Match Time we won 5-3"                         -> Red 5, Yellow 3 (want Red 5, Yellow 3) |
| batch | B12 | PASS | "@Match Time Red 9 Yellow 4"                     -> Red 9, Yellow 4 (want Red 9, Yellow 4) |
| batch | B13 | PASS | "10-7"                                           -> asked which team won (want asked which team won) |
| batch | B14 | PASS | "@Match Time bibs won 7-2"                       -> asked about "bibs" (want asked about "bibs") |
| batch | B15 | PASS | "@Match Time yellows won 5-3"                    -> asked about "yellows" (want asked about "yellows") |
| batch | B16 | PASS | "@Match Time yelekliler 9 yeleksizler 4"         -> asked about "yelekliler" (want asked about "yelekliler") |
| existing | H1 | PASS | "5-3 to Yellows"                                               -> Red 3, Yellow 5 (want Red 3, Yellow 5) |
| existing | H2 | PASS | "5-4 to reds"                                                  -> Red 5, Yellow 4 (want Red 5, Yellow 4) |
| existing | H3 | PASS | "15-12 to Reds @Match Time"                                    -> Red 15, Yellow 12 (want Red 15, Yellow 12) |
| existing | H4 | PASS | "4-6 to Yellows"                                               -> Red 4, Yellow 6 (want Red 4, Yellow 6) |
| existing | H5 | PASS | "6-5 Yellow wins"                                              -> Red 5, Yellow 6 (want Red 5, Yellow 6) |
| existing | H6 | PASS | "9-6 to yellow"                                                -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | H7 | PASS | "7-7"                                                          -> Red 7, Yellow 7 (want Red 7, Yellow 7) |
| existing | H8 | PASS | "Final score was 8-8"                                          -> Red 8, Yellow 8 (want Red 8, Yellow 8) |
| existing | H9 | PASS | "10-7 :))"                                                     -> ask (want ask) |
| existing | H10 | PASS | "Red won 5-3"                                                  -> Red 5, Yellow 3 (want Red 5, Yellow 3) |
| existing | I1 | PASS | "it was 6-6 until 15 minutes then suddenly it turned to 9-6    -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | I2 | PASS | "@Match Time no Yellow 9 - 6 Red"                              -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | N1 | PASS | "Red 6 Yellow 9"                                               -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | N2 | PASS | "we won 5-3"                                                   -> Red 3, Yellow 5 (want Red 3, Yellow 5) |
| existing | N3 | PASS | "lost 3-5"                                                     -> Red 3, Yellow 5 (want Red 3, Yellow 5) |
| existing | N4 | PASS | "reds battered us 7-2"                                         -> Red 7, Yellow 2 (want Red 7, Yellow 2) |
| existing | N5 | PASS | "4-2 to the Tigers"                                            -> Red 2, Yellow 4 (want Red 2, Yellow 4) |
| existing | L1 | PASS | "Reds 3-5"                                                     -> ask (want ask) |
| existing | L2 | PASS | "yellow 9-6"                                                   -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | C1 | PASS | "@Match Time no it was 9-7"                                    -> told (want told) |
| existing | C4 | PASS | "no Yellow 9 - 6 Red"                                          -> silent (want silent) |
| existing | C5 | PASS | "no, reds won 3-1"                                             -> silent (want silent) |
| existing | C2 | PASS | "@Match Time wrong, it finished 9-9"                           -> Red 9, Yellow 9 (want Red 9, Yellow 9) |
| existing | C3 | PASS | "9-6 to yellows"                                               -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | X1 | PASS | "@Match Time wrong way round, yellows won"                     -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | X2 | PASS | "@Match Time other way round"                                  -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | X3 | PASS | "yellows won"                                                  -> silent (want silent) |
| existing | X4 | PASS | "@Match Time yellows won"                                      -> told (want told) |
| existing | X5 | PASS | "good game lads, well played"                                  -> silent (want silent) |
| existing | G1 | PASS | "@Match Time it was 9-2 to yellow"                             -> told (want told) |
| existing | G2 | PASS | "@Match Time last week we lost 9-2"                            -> silent (want silent) |
| existing | G3 | PASS | "@Match Time last week we lost 9-2"                            -> silent (want silent) |
| existing | G4 | PASS | "Red won 4-2 last night"                                       -> Red 4, Yellow 2 (want Red 4, Yellow 2) |
| existing | A1 | PASS | "Yellow"                                                       -> Red 7, Yellow 10 (want Red 7, Yellow 10) |
| existing | A2 | PASS | "reds won"                                                     -> Red 10, Yellow 7 (want Red 10, Yellow 7) |
| existing | A3 | PASS | "reds won"                                                     -> silent (want silent) |
| existing | A5 | PASS | "yellow bibs stink mate, reds deserved it anyway"              -> silent (want silent) |
| existing | A6 | PASS | "Yellow 7-10"                                                  -> Red 7, Yellow 10 (want Red 7, Yellow 10) |
| existing | M1 | PASS | "good game lads, same time next week 21:30"                    -> silent (want silent) |
| existing | A4 | PASS | "Yellow?"                                                      -> silent (want silent) |
| existing | T1 | PASS | "sarılar 9-6 kazandı"                                          -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | T2 | PASS | "kırmızı 6 sarı 9"                                             -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | T3 | PASS | "5-3 kazandık"                                                 -> Red 5, Yellow 3 (want Red 5, Yellow 3) |
| existing | T4 | PASS | "3-5 kaybettik"                                                -> Red 5, Yellow 3 (want Red 5, Yellow 3) |
| existing | T5 | PASS | "7-7 berabere"                                                 -> Red 7, Yellow 7 (want Red 7, Yellow 7) |
| existing | T6 | PASS | "@Match Time yanlış, kırmızı 6 sarı 9"                         -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | T7 | PASS | "@Match Time tam tersi, sarılar kazandı"                       -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | T8 | PASS | "9-6 sarıların lehine bitti"                                   -> Red 6, Yellow 9 (want Red 6, Yellow 9) |
| existing | T9 | PASS | "dün akşam sarılar 5-2 kazandı"                                -> Red 2, Yellow 5 (want Red 2, Yellow 5) |

What one pass cannot prove: an occasional miss (a case right nine times in ten) can pass once and fail live; in the group it would show as a question or a result stated winner first, where it can be corrected.
