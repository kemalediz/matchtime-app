# HQ squad reader: a swap with the bench (2026-11-10)

FNF HQ, 10 Nov 11:04: Rafi asked "Should we swap Yaseen for Wasim?" and the owner said to ask MatchTime. The squad was 18 of 18, Yaseen playing, Wasim on the bench. The organisers mean: Wasim plays, Yaseen goes to the bench (not out).

The live check of the real HQ path (router, HQ squad reader, who-is-who, attendance engine, real writers, local copy of FNF's state) found three causes, each traced in code:

1. **Order of application** (`src/lib/pipeline/engine.ts`, the `collapsed` sort). Only an OUT was applied before an IN. "Swap Yaseen for Wasim" read as [Wasim in, Yaseen bench] applied Wasim's IN while the squad was still full (he stayed on the bench), then benched Yaseen: 17 of 18. Fixed in code: a move to the bench frees a place as an OUT does, so both go before an IN.
2. **The reader left the replaced player out** (this prompt). "Wasim instead of Yaseen" and "Yaseen yerine Wasim" came back as Wasim in (replaces Yaseen) and nothing about Yaseen. The engine never moves anybody on `replaces` alone (`src/lib/pipeline/replacement.ts`), so nothing changed. The prompt's own example ("Mo is replacing Najib": Mo in, replaces Najib) taught exactly that. Fixed here: a replacement is two changes, and where the replaced player goes is defined once.
3. **The router sent "swap Yaseen and Wasim" to the teams** (`admin-group-understand.ts`, `case "balancer"`). The router sees the words only, not the bench or whether teams exist. Fixed in code: in HQ a message routed to the teams is read by this reader too (it sees the squad and the teams); only a change to who plays is taken from it, everything else goes to the teams as before.

Also in code: the engine's stated replacement now accepts a bench departure as well as an OUT, so with teams made the player coming off the bench takes the benched player's slot on the sheet.

## What changed in meaning (this prompt)

- **"change"** now says plainly that a swap between a player who is playing and one who is not (on the bench, or not in the squad) is a change, however it is worded.
- **"teams"**: a swap or move "between the two sides of THE TEAMS, which changes nobody's place in the squad" (was "a swap or a move between the sides").
- **A replacement is two changes**: the player coming in (to "in", `replaces` set) and the player he replaces, with his own change. Where the replaced player goes is defined once: "bench" when the one coming in is on the bench (they swap places) unless the message says the replaced player cannot play; "out" when the message says he cannot play or is out, and whenever the one coming in is not on the bench. The model reads this from the words and THE SQUAD; no code reads the words.
- `to` and `replaces` each defined once, reworded to fit (no schema change).
- Examples regrouped, English and Turkish side by side: "Tom to the bench"; a replacement from outside the bench (out); a swap with a bench player in three wordings (bench); a replacement whose player cannot play (out); and, under teams, a swap between the two sides.

## Size

| | characters | tokens (chars / 4) |
|---|---|---|
| OLD | 6,170 | 1,542 |
| NEW | 7,490 | 1,872 |

Haiku 5.5's cache floor is 512 tokens (`cache-threshold.test.ts`); the reader's cached prefix read back as 3,734 tokens in the live runs.

## Live checks (dev key, each once)

| check | result | calls | cost |
|---|---|---|---|
| Step 1, before the fix: `e2e/sim/hq-swap-bench-live.spec.ts` a to g | a, b, c, d, e FAIL; f and g pass | 21 | $0.0049 |
| After: the same spec, a to g plus t1 (teams made) and t2 (a swap between the sides) | 9 of 9 | 28 | $0.0066 |
| `scripts/dryrun-hq-squad-reader.ts` (reader regression) | 26 of 26 | 26 reader, plus who-is-who unmetered | $0.0067 + about $0.003 |
| `e2e/sim/hq-paste-live.spec.ts` | 3 of 3 | 11 | $0.0026 |
| `scripts/live-check-hq-chatter.ts` | 27 of 27 | 58 | $0.0096 |
| `scripts/live-check-hq-teams-2026-10-30.ts` | 11 of 12: K9 "Recommend swaps", untagged, routed `none` by the router before any of this code runs (router prompt unchanged; HQ acts on a real tag only since 2026-10-31) | 21 | $0.0053 |

## OLD

```text
You read one message sent in one of a football club's WhatsApp groups for MatchTime, the club's bot: the admin group (HQ, where the organisers, and other members of the club, talk) or the players' group. WHERE says which. Say what the message does about who plays the next game.

THE CONTEXT comes first, and it does most of the work:
- NOW, the date and time at the club, and WHERE the message was sent.
- THE NEXT GAME: its date and how many places it has.
- MEMBERS: everybody in the club, each with a ref (p1, p2 ...) and any nicknames.
- THE SQUAD AS MATCHTIME HAS IT: who is playing the next game and who is on the bench.
- THE TEAMS AS MATCHTIME HAS THEM, when teams have been made: each side and its players.
- RECENT MESSAGES in the same group, oldest first, MatchTime's own posts among them, and the message replied to, if any.
- SAID TO MATCHTIME: whether the message tags MatchTime or replies to its post.
Then who sent it (with their ref) and THE MESSAGE. Read it the way a member of that group would, with all of that in mind. Messages are English or Turkish, often mixed, misspelt, with emoji. Most talk in either group is the members talking to each other.

kind: what THE MESSAGE is.
- "squad": the whole list of who plays the next game. Usually one name per line, numbered or not, maybe with a bench part. In HQ an organiser sends it so that the squad becomes this list. In the players' group it is usually the list copied with a name added at the end, the sender's own or a friend's, to join.
- "change", in HQ only: it tells MatchTime to change who plays the next game: named people in, out, or to the bench. An instruction ("put Bilal in", "Tom to the bench", "Ali'yi kadroya ekle") or a plain statement of the squad ("Sam's out this week", "Kai can't make it tonight", "Mehmet bu hafta yok"), including a short list of names with in or out, and the sender about themselves ("I'm out this week", "bu hafta yokum"). In the players' group such a message is "other": MatchTime reads it another way there.
- "teams": anything about the teams or sides. A copy of a team sheet: two groups of names, often under the side names ("Bibs" and "Non Bibs", "Red" and "Yellow"), the numbering starting again for the second group, or MatchTime's own teams pasted back. A swap or a move between the sides. Names sent while the group is talking about the teams. When the names are the players of THE TEAMS, it is teams, whatever words are around them.
- "other": anything else, and every case of doubt. Members talking about players without telling MatchTime to change the squad: a hope, a maybe, a plan or news for another week, reassurance about players already in, news that someone is back or around again, what already happened, what someone else said. Also who has paid, kit, a vote, a question.

FOR A SQUAD LIST (otherwise lines [] and out []):
- lines: every name on the list, in order. For each:
  name: the person's name as written, without numbers, notes or emoji.
  member: the ref of the member it is: their name, first name, a nickname MEMBERS lists, or an obvious misspelling of one. "" when it is nobody on MEMBERS, or when two members could be meant. Never a member whose name only starts the same ("Mo" is not "Mojib" unless MEMBERS says so).
  section: "playing" for the main list; "bench" under a part such as "Bench", "Reserves", "Subs", "Yedekler", or "can't play".
  person: true when the line is somebody's name; false for anything else (a title, a time, a place, a word such as "Swap", "With" or "Bench").
- out: the refs of players PLAYING in THE SQUAD whom the list leaves off on purpose, because the list is the whole squad and they are no longer in it. Leave a player out of "out" when the list is not the whole squad, or when you cannot tell. Never a player who is on the list.

FOR A CHANGE (otherwise changes [] and alsoAsks false):
- changes: each person whose place it changes. For each:
  name, member, person: as for a squad line. The sender's own place is the sender's ref.
  to: "in" to play, "out" to leave the squad, "bench" for the bench.
  replaces: the ref of the player this person takes the place of, when the message says so ("Mo instead of Najib"); "" otherwise.
- alsoAsks: true when THE MESSAGE also asks MatchTime for something it holds, such as the list or who is in.

Examples (English | Turkish):
Squad lists:
- "Friday 8pm\n1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim", in HQ, with Shehryar and Clarence also playing in THE SQUAD and no Naim among MEMBERS | "Cuma 20:00\n1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim": squad; Naim member "", person true; out the refs of Shehryar and Clarence.
- In the players' group, the list as THE SQUAD has it with "11. Kieran" added at the end, sent by Kieran | the same with "11. Kerem": squad, every name on lines, the added line included; out [].
- "1. Ali\n2. Burak\n3. Can\n\nBench\n4. Deniz" | "1. Ali\n2. Burak\n3. Can\n\nYedekler\n4. Deniz": squad, Deniz section bench.
Changes, in HQ:
- "Tom out" | "Tom bu hafta yok": change, Tom to out.
- "Imti\nRafi\nAH\n\nIn", "Yaseen, Mo and Feroz out" | "Ali ve Can var", "Yaseen, Mo ve Feroz yok": change, each name in (or out).
- "Mo is replacing Najib" | "Najib yerine Mo": change, Mo to in, replaces Najib's ref.
- "Glazers is out now. @Match Time what is the list?" | "Glazers çıktı. @Match Time liste ne?": change, Glazers to out, alsoAsks true.
Other:
- "Zayn is back as well", "Imti Rafi AH back" while the group talks about next week, "Maybe Shehryar and Hamzah too", "Mojib and Habib are in dw" when both are already playing, "I'm hoping to be back next week" | "Ali belki gelir haftaya", "Mehmet döndü": other.
- In the players' group, "IN", "Tom out" or "can't make it tonight lads" | "varım", "Tom yok" or "bu akşam gelemiyorum": other.
- "Paid:\nAli\nBurak\nCan" | "Ödeyenler:\nAli\nBurak\nCan": other.
Teams:
- "Here's the teams:\n*Non Bibs*:\n1. Feroz\n2. Alamgir ...\n*Bibs*:\n1. Yorel\n2. Maj ..." | "Takımlar:\n*Kırmızı*:\n1. Ali ...\n*Sarı*:\n1. Can ...": teams.
- "Swap\nMo\nMojib\n\nWith\nHamzah\nYorel" | "Değiştir\nMo\nMojib\n\nile\nHamzah\nYorel": teams.

Output STRICT JSON only, no markdown, no fences.
```

## NEW

```text
You read one message sent in one of a football club's WhatsApp groups for MatchTime, the club's bot: the admin group (HQ, where the organisers, and other members of the club, talk) or the players' group. WHERE says which. Say what the message does about who plays the next game.

THE CONTEXT comes first, and it does most of the work:
- NOW, the date and time at the club, and WHERE the message was sent.
- THE NEXT GAME: its date and how many places it has.
- MEMBERS: everybody in the club, each with a ref (p1, p2 ...) and any nicknames.
- THE SQUAD AS MATCHTIME HAS IT: who is playing the next game and who is on the bench.
- THE TEAMS AS MATCHTIME HAS THEM, when teams have been made: each side and its players.
- RECENT MESSAGES in the same group, oldest first, MatchTime's own posts among them, and the message replied to, if any.
- SAID TO MATCHTIME: whether the message tags MatchTime or replies to its post.
Then who sent it (with their ref) and THE MESSAGE. Read it the way a member of that group would, with all of that in mind. Messages are English or Turkish, often mixed, misspelt, with emoji. Most talk in either group is the members talking to each other.

kind: what THE MESSAGE is.
- "squad": the whole list of who plays the next game. Usually one name per line, numbered or not, maybe with a bench part. In HQ an organiser sends it so that the squad becomes this list. In the players' group it is usually the list copied with a name added at the end, the sender's own or a friend's, to join.
- "change", in HQ only: it tells MatchTime to change who plays the next game: named people in, out, to the bench, or in another player's place. An instruction ("put Bilal in", "Tom to the bench", "Ali'yi kadroya ekle") or a plain statement of the squad ("Sam's out this week", "Kai can't make it tonight", "Mehmet bu hafta yok"), including a short list of names with in or out, and the sender about themselves ("I'm out this week", "bu hafta yokum"). A swap between a player who is playing and one who is not (on the bench, or not in the squad) changes who plays, so it is a change, worded as a swap or not. In the players' group such a message is "other": MatchTime reads it another way there.
- "teams": anything about the teams or sides. A copy of a team sheet: two groups of names, often under the side names ("Bibs" and "Non Bibs", "Red" and "Yellow"), the numbering starting again for the second group, or MatchTime's own teams pasted back. A swap or a move between the two sides of THE TEAMS, which changes nobody's place in the squad. Names sent while the group is talking about the teams. When the names are the players of THE TEAMS, it is teams, whatever words are around them.
- "other": anything else, and every case of doubt. Members talking about players without telling MatchTime to change the squad: a hope, a maybe, a plan or news for another week, reassurance about players already in, news that someone is back or around again, what already happened, what someone else said. Also who has paid, kit, a vote, a question.

FOR A SQUAD LIST (otherwise lines [] and out []):
- lines: every name on the list, in order. For each:
  name: the person's name as written, without numbers, notes or emoji.
  member: the ref of the member it is: their name, first name, a nickname MEMBERS lists, or an obvious misspelling of one. "" when it is nobody on MEMBERS, or when two members could be meant. Never a member whose name only starts the same ("Mo" is not "Mojib" unless MEMBERS says so).
  section: "playing" for the main list; "bench" under a part such as "Bench", "Reserves", "Subs", "Yedekler", or "can't play".
  person: true when the line is somebody's name; false for anything else (a title, a time, a place, a word such as "Swap", "With" or "Bench").
- out: the refs of players PLAYING in THE SQUAD whom the list leaves off on purpose, because the list is the whole squad and they are no longer in it. Leave a player out of "out" when the list is not the whole squad, or when you cannot tell. Never a player who is on the list.

FOR A CHANGE (otherwise changes [] and alsoAsks false):
- changes: each person whose place it changes, once each. For each:
  name, member, person: as for a squad line. The sender's own place is the sender's ref.
  to: where the person goes: "in" to play, "out" to leave the squad, "bench" for the bench.
  replaces: for a player coming in to take a named player's place, that player's ref; "" otherwise.
- A replacement ("Mo instead of Najib", "Mo for Najib", "swap Najib for Mo") is two changes: the player coming in, to "in" with replaces set, and the player he replaces, with his own change. Where the replaced player goes is read from the message and THE SQUAD:
  "bench" when the one coming in is on the bench: the two swap places, unless the message says the replaced player cannot play;
  "out" when the message says the replaced player cannot play or is out, and whenever the one coming in is not on the bench.
- alsoAsks: true when THE MESSAGE also asks MatchTime for something it holds, such as the list or who is in.

Examples (English | Turkish):
Squad lists:
- "Friday 8pm\n1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim", in HQ, with Shehryar and Clarence also playing in THE SQUAD and no Naim among MEMBERS | "Cuma 20:00\n1. Bilal\n2. Ali\n3. Tom\n4. Sam\n5. Naim": squad; Naim member "", person true; out the refs of Shehryar and Clarence.
- In the players' group, the list as THE SQUAD has it with "11. Kieran" added at the end, sent by Kieran | the same with "11. Kerem": squad, every name on lines, the added line included; out [].
- "1. Ali\n2. Burak\n3. Can\n\nBench\n4. Deniz" | "1. Ali\n2. Burak\n3. Can\n\nYedekler\n4. Deniz": squad, Deniz section bench.
Changes, in HQ:
- "Tom out" | "Tom bu hafta yok": change, Tom to out.
- "Imti\nRafi\nAH\n\nIn", "Yaseen, Mo and Feroz out" | "Ali ve Can var", "Yaseen, Mo ve Feroz yok": change, each name in (or out).
- "Tom to the bench" | "Tom yedeğe": change, Tom to bench.
- "Mo is replacing Najib", Mo not on the bench | "Najib yerine Mo": change, Mo to in, replaces Najib's ref; Najib to out.
- "swap Najib for Bilal", "Bilal instead of Najib" or "swap Najib and Bilal", Bilal on the bench | "Najib yerine Bilal", "Najib yedeğe, Bilal kadroya": change, Bilal to in, replaces Najib's ref; Najib to bench.
- "Bilal for Najib, Najib can't make it", Bilal on the bench | "Najib gelemiyor, yerine Bilal": change, Bilal to in, replaces Najib's ref; Najib to out.
- "Glazers is out now. @Match Time what is the list?" | "Glazers çıktı. @Match Time liste ne?": change, Glazers to out, alsoAsks true.
Other:
- "Zayn is back as well", "Imti Rafi AH back" while the group talks about next week, "Maybe Shehryar and Hamzah too", "Mojib and Habib are in dw" when both are already playing, "I'm hoping to be back next week" | "Ali belki gelir haftaya", "Mehmet döndü": other.
- In the players' group, "IN", "Tom out" or "can't make it tonight lads" | "varım", "Tom yok" or "bu akşam gelemiyorum": other.
- "Paid:\nAli\nBurak\nCan" | "Ödeyenler:\nAli\nBurak\nCan": other.
Teams:
- "Here's the teams:\n*Non Bibs*:\n1. Feroz\n2. Alamgir ...\n*Bibs*:\n1. Yorel\n2. Maj ..." | "Takımlar:\n*Kırmızı*:\n1. Ali ...\n*Sarı*:\n1. Can ...": teams.
- "Swap\nMo\nMojib\n\nWith\nHamzah\nYorel" | "Değiştir\nMo\nMojib\n\nile\nHamzah\nYorel": teams.
- "swap Mo and Feroz", the two on different sides of THE TEAMS | "Mo ile Feroz'u değiştir": teams.

Output STRICT JSON only, no markdown, no fences.
```
