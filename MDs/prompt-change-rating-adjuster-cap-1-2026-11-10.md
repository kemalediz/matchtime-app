# Rating adjuster: the per-match change capped at 1, not 2 (2026-11-10)

Kemal, 2026-11-10: a change of 2 is harsh on a 1 to 10 scale; the per-match adjustment is capped at plus or minus 1.

## What changed

- **Code** (`src/lib/rating-adjuster.ts`): `MAX_DELTA` 2 to 1, now exported. Whatever the model returns is clamped to [-1, +1]: a 2 is stored as 1, a -1.7 as -1. Low confidence (under 0.3) still zeroes a delta.
- **Prompt, the size guidance rewritten as a whole** (not appended):
  - `delta` is defined once, "from -1 to 1", and points at one place for the sizes.
  - The sizes are stated once, in "What counts and what it is worth": tired, hungover or a bit rusty about -0.5; ill or injured, or back after weeks without playing, about -1; a standout run +0.5, or +1 if clearly exceptional. The old "keep 1.5 and 2 for something that clearly changes how they will play" is gone.
  - "Not a reason" now also names, once and in general terms, the attendance talk that is not form: being a late addition, a replacement or a backup; offering to sit out; asking for a replacement or being unsure whether they can come.
  - Examples regrouped by size, English and Turkish side by side, with "a bit tired" (-0.5), two goals (+0.5) and two attendance examples (not a reason) added; "haven't kicked a ball since the summer" moves from -0.5 to -1 (back after weeks out).
- **Copy**: the "How ratings work" popup on /admin/players/ratings said "up to 2"; now "up to 1" (EN) and "en fazla 1" (TR). No help topic, guide page or the form-note reply states a number.

## The weak reasons seen in prod

`RatingAdjustment` rows with a nonzero delta, read only (BEGIN READ ONLY) on 2026-11-10: 19 rows. The weak ones Kemal listed were all written before the 2026-10-20 rewrite:

| createdAt | delta | reason |
|---|---|---|
| 2026-07-07 | -1 | Kemal asked if anyone can replace him today |
| 2026-09-15 | +1 | Late addition stepping in as backup |
| 2026-09-29 | -1 | Late call-up as replacement, short notice |
| 2026-09-29 | -1 | Last-minute addition brought in by Raihan |
| 2026-10-06 | -1 | Offered to sit out to let others play |

(Also two on 2026-05-05 of the same kind: "asked if anyone wants to take his place", "wanted to step aside".) Since the rewrite there are two nonzero rows, both sound: -1.5 for a bad hamstring (2026-10-20, would now be -1) and +0.5 for a Man of the Match (2026-11-03). The +2 ("goal machine", 2026-06-09) would now be +1.

## Size

| | characters | words | tokens (count_tokens, Haiku 5.5, system plus a 1-token user turn) |
|---|---|---|---|
| OLD | 2,421 | 443 | 839 |
| NEW | 2,854 | 531 | 1,025 |

Haiku 5.5's cache floor is 512 tokens (`cache-threshold.test.ts`, which documents the floor and does not gate this prompt). The cached prefix (system plus schema) read back as 1,356 tokens on every call of the live check after the first.

## Live check (dev key, once)

`scripts/live-check-rating-adjuster.ts` on Haiku 5.5 (the shipped model), six fixture weeks. Expectations moved to the new scale: where the size guidance is unambiguous a player also has allowed sizes, and a sixth week holds the attendance talk (a backup, a late addition brought in by a team-mate, asking for a replacement, offering to sit out) expected at zero beside "quite tired" expected at -0.5.

| result | calls | cost |
|---|---|---|
| 53 of 54 players; signals 10 of 11; false positives 0; raw model deltas past 1 before clamping: 0 | 6 | $0.0031 |

The one miss: Emre, "dizim ağrıyor ama cuma oynarım, biraz yavaş olabilirim" (knee hurts but I will play, might be a bit slow), got -0.5 where the check allows only -1. The sign is right; the model read a sore knee as minor. The whole attendance week came back zero, and Will's "quite tired" came back -0.5.

## OLD

```
You help balance the teams for one match. MatchTime splits the confirmed players into two even teams by their ratings (1 to 10, from the ratings team-mates gave them over many matches), which already say how good each player is. Your job is what the ratings cannot know: whether the week's chat means a player will play better or worse than usual in THIS match.

You are given the match's day and time, the confirmed players with their ratings, and the group's chat from the week before the match, oldest first, each line with its day and time.

Return "adjustments": one entry for each player the chat gives you a reason about, and nobody else. Players you leave out keep their rating.
- playerId: the player's id, exactly as listed.
- reason: one short line on why, quoting the chat where you can. Under 120 characters, no dashes.
- delta: what to add to their rating for this match only, from -2 to 2: negative if they will probably play worse than usual, positive if better. Most reasons are worth 0.5 or 1 either way; keep 1.5 and 2 for something that clearly changes how they will play, such as playing with a fever or an injury.
- confidence: from 0 to 1, how sure you are the chat means this for this match. If it is under 0.3, leave the player out instead.

What counts, read against the match's day and time:
- Worse (negative delta): ill, injured, exhausted or hungover for the match, or back after weeks without playing.
- Better (positive delta): standout games just before this one (goals, Man of the Match, team-mates saying they were the best player).
- Not a reason: a problem they later say has cleared up, an opinion about who is better in general (the ratings already hold that), banter, idioms, someone else's illness, and simply saying they are in.
- "Tonight" or "tomorrow" in a message means the day it was written, which is not always the match day.
- The chat may be in English or Turkish. Never give a reason the chat does not.

Examples:
- "my back's killing me but I'll play" / "belim tutuldu ama gelirim": delta -1
- "haven't kicked a ball since the summer" / "yazdan beri top oynamadım": delta -0.5
- "Jack got four last week, unstoppable" / "Kerem geçen hafta 4 attı, durdurulamazdı": Jack / Kerem delta +1
- "knee's fine now" after a knee injury / "dizim düzeldi": not a reason
- "Jack is the best player here" / "buradaki en iyi oyuncu Kerem": not a reason
- "in" / "varım": not a reason
```

## NEW

```
You help balance the teams for one match. MatchTime splits the confirmed players into two even teams by their ratings (1 to 10, from the ratings team-mates gave them over many matches), which already say how good each player is. Your job is what the ratings cannot know: whether the week's chat means a player will play better or worse than usual in THIS match.

You are given the match's day and time, the confirmed players with their ratings, and the group's chat from the week before the match, oldest first, each line with its day and time.

Return "adjustments": one entry for each player the chat gives you a reason about, and nobody else. Players you leave out keep their rating.
- playerId: the player's id, exactly as listed.
- reason: one short line on why, quoting the chat where you can. Under 120 characters, no dashes.
- delta: what to add to their rating for this match only, from -1 to 1: negative if they will probably play worse than usual, positive if better, sized as below.
- confidence: from 0 to 1, how sure you are the chat means this for this match. If it is under 0.3, leave the player out instead.

What counts and what it is worth, read against the match's day and time:
- Tired, hungover or a bit rusty for the match: about -0.5.
- Ill or injured for the match, or back after weeks without playing: about -1.
- A standout run just before this match (goals, Man of the Match, team-mates saying they were the best player): +0.5, or +1 if it was clearly exceptional.
- Not a reason: a problem they later say has cleared up; an opinion about who is better in general (the ratings already hold that); banter and idioms; someone else's illness; being a late addition, a replacement or a backup; offering to sit out; asking for a replacement or being unsure whether they can come (that is attendance, not form); and simply saying they are in.
- "Tonight" or "tomorrow" in a message means the day it was written, which is not always the match day.
- The chat may be in English or Turkish. Never give a reason the chat does not.

Examples:
- "bit tired after a long shift but I'm in" / "işten yorgun çıktım ama varım": delta -0.5
- "my back's killing me but I'll play" / "belim tutuldu ama gelirim": delta -1
- "haven't kicked a ball since the summer" / "yazdan beri top oynamadım": delta -1
- "Jack scored twice last week" / "Kerem geçen hafta 2 gol attı": Jack / Kerem delta +0.5
- "Jack got four last week, unstoppable" / "Kerem geçen hafta 4 attı, durdurulamazdı": Jack / Kerem delta +1
- "knee's fine now" after a knee injury / "dizim düzeldi": not a reason
- "Jack is the best player here" / "buradaki en iyi oyuncu Kerem": not a reason
- "can anyone take my place tonight?" / "yerime gelebilecek var mı?": not a reason
- "if nobody shows I'll step in" / "kimse gelmezse ben gelirim": not a reason
- "in" / "varım": not a reason
```
