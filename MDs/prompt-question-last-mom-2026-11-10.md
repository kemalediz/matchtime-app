# Question extractor: one match's Man of the Match (2026-11-10)

Incident, Sutton FC players' group, Tue 10 Nov 19:25: "@Match Time who was the last MoM and for which game it was? How many votes did he get out of how many votes?" The extractor read `stats`, table `mom`, and the group got the all-time top 10. The question was about ONE match.

Full prompts: `prompt-question-last-mom-old-2026-11-10.txt` (15,222 characters) and `prompt-question-last-mom-new-2026-11-10.txt` (15,589 characters, +367). Same model (Haiku 5.5), still far above its 512-token cache floor.

## What changed in meaning

No new topic and no new table. A question about one match's Man of the Match (who won it, the votes, who else got votes) is the stats table `other`, whose grounded answer is now given that match's facts (`src/lib/pipeline/last-mom.ts`). The `mom` table is the ranking across matches only. The period rule for ONE match now covers its Man of the Match as well as its score.

## Old and new, line by line

| Section | Old | New |
|---|---|---|
| topic `stats` | numbers about players across matches (ratings, appearances, Man of the Match, Elo and the rest): a table, a ranking, another player's numbers, or the asker's own pairings | numbers about players (ratings, appearances, Man of the Match, Elo and the rest): a table or ranking across matches, another player's numbers, the asker's own pairings, or who was Man of the Match in one match and with how many votes |
| table `mom` | Man of the Match awards | who has won Man of the Match the most: the awards counted across matches |
| table `other` | a question no single table answers: a win rate, or two or more tables together ("...") | a question no single table answers: a win rate, two or more tables together ("..."), or one match's Man of the Match (who won it, the votes they got, who else got votes) |
| period `none` | ... A score question about ONE match ("last night", "on Tuesday", "last week", "geçen hafta") is period "none", listSize -1. | ... A question about ONE match ("last night", "on Tuesday", "last week", "geçen hafta"), its score or its Man of the Match, is period "none", listSize -1. |
| Stats examples | (none) | "@Match Time who won Man of the Match on Tuesday, with how many votes?" \| "@Match Time son maçın adamı kimdi, kaç oy aldı?" -> stats, other (placed under "who's got the most MoMs" -> stats, mom) |

## Paid checks (dev key, each case once)

- `scripts/live-check-question-extractor.ts`, one full pass: 86/86 (78 existing cases plus V1 to V8 for this change), 86 calls, $0.0122.
- `scripts/live-check-last-mom.ts`, router + `runAnswerBatch` + real models, final pass: 10/10 judged good, 29 calls, $0.0055.
