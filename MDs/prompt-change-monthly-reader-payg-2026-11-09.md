# Prompt change: the monthly reader, pay as you go and the bench (2026-11-09)

The live check for #571 (the month's list with pay as you go straight after the squad) found that the real monthly reader filed every line under a "*Pay as you go:*" heading in section `"other"`, **in the old layout and the new one alike**. `"other"` lines are never acted on, so:

- a member pasting the list unchanged did not match the list MatchTime has, so the "the group has just seen this list" marker was not recorded and the list could be posted again;
- a member adding himself under pay as you go was not registered.

The old prompt defined `"playing"` as "the main list" and `"other"` as "any other part", and never mentioned a pay-as-you-go part.

One prompt changes: the **monthly reader** (`MONTHLY_READER_SYSTEM`, `src/lib/monthly-reader-prompt.ts`). The "WHO A NAME IS" person-ref rules are untouched.

## Size

| | Characters |
|---|---|
| Before | 8,918 |
| After | 10,317 (+1,399) |

Still above Haiku 5.5's cache floor (`monthly-reader.test.ts` asserts it). The JSON schema gains one required boolean, `benchPart`, so the cached prefix changes once.

## What changed in meaning

1. **A list is in parts.** One short paragraph says that a line belongs to the part it sits under. It describes MatchTime's own post (squad, a "Pay as you go" part numbered on from it, the "everybody is in" line, Can't play, Bench), and says people also reorder parts, leave some out, or write one list with no headings (all of it playing).
2. **`section` is defined once, one part per line.** `"playing"` is now the main list **and a part headed "Pay as you go", "PAYG" or "Maç başı ödeyenler", whose numbers carry on from it**. `"reserves"` gains "Bench" and "Waiting list". `"other"` changes from "any other part" to "a part that is not about who plays (kit, teams, who owes money)".
3. **`benchPart` (new):** whether the list has a bench part, even one with no names left under it. Code uses it to take somebody off the bench when the last name under it is removed. A list with no bench part never takes anybody off it.
4. **`choice` (sign-ups) made explicit.** "in" covers a number of games ("4 games" is in); "payg" applies only when the message says pay as you go. Without this, the stronger pay-as-you-go wording above turned "add Zak to the November list, 2 games" into a PAYG sign-up in 3 of 5 live runs (main: 0 of 3). After it: 8 of 8.
5. **Examples, grouped, EN | TR:** one full-list example with all four parts (squad, pay as you go, can't play, bench), and one for a bench with no name left under it. The existing "Paid but can't play" example stays. Nothing else reworded; no example removed.

## Side by side (only the lines that changed)

### The sign-up's `choice`

| Before | After |
|---|---|
| `- choice: "in" (a regular for the month), "out" (not playing the month), "payg" (single games).` | `- choice: "in" (a regular for the month, for all its games or for a number of them: "4 games" is in), "out" (not playing the month), "payg" (only when it says pay as you go: "PAYG", "pay as you go", "maç başı").` |

### A LIST: the opening paragraph (new)

| Before | After |
|---|---|
| (none) | `A list is in parts, each under its heading, and a line belongs to the part it sits in. MatchTime's own post, and the copies people paste back, run: the month's squad; a "Pay as you go" part numbered on from it; a line saying everybody is in; "Can't play"; "Bench". People also write the parts in another order, leave some out, or write one list with no headings (all of it playing).` |

### `benchPart` (new field)

| Before | After |
|---|---|
| (none) | `- benchPart: true when the list has a bench part (as for "reserves" below), even one with no names left under it; false otherwise.` |

### `section`

| Before | After |
|---|---|
| `section: "playing" for the main list; "cant_play" under a part such as "Paid but can't play", "Can't play", "Out", "Injured", "Gelemeyenler", "Ödedi gelemiyor"; "reserves" under "Reserves", "Subs", "Yedekler"; "other" under any other part.` | `section: the part the line sits in.`<br>`"playing": who plays the game: the main list, and a part headed "Pay as you go", "PAYG" or "Maç başı ödeyenler", whose numbers carry on from the main list.`<br>`"cant_play": who is not playing: "Can't play", "Paid but can't play", "Out", "Injured", "Gelemeyenler", "Ödedi gelemiyor".`<br>`"reserves": who waits for a place: "Bench", "Reserves", "Subs", "Waiting list", "Yedekler".`<br>`"other": a part that is not about who plays (kit, teams, who owes money).` |

### Examples (Lists group)

| Before | After |
|---|---|
| (none) | `"November squad:\n1. Davide\n2. Dan\n\nPay as you go:\n3. Stuart\n\nCan't play:\n1. Jon\n\nBench:\n1. David" \| "Kasım kadrosu:\n1. Erdal\n\nMaç başı ödeyenler:\n2. Burak\n\nGelemeyenler:\n1. Volkan\n\nYedekler:\n1. Emre": Davide, Dan and Stuart playing, Jon cant_play, David reserves, benchPart true \| Erdal and Burak playing, Volkan cant_play, Emre reserves, benchPart true.` |
| `"Paid but can't play\n1. Serg" \| "Ödedi gelemiyor\n1. Volkan": section cant_play.` | unchanged |
| (none) | `"Bench:" with no name left under it \| "Yedekler:" altında isim kalmamış: benchPart true, and no reserves line.` |

## What lands in "other" now

Only a part that is not about who plays: a kit list, teams, who owes money. In every live run below, MatchTime's own post put nothing in `"other"`. Code still never acts on `"other"` lines. A name there counts as "on the paste" (so it is not read as missing), but it is never registered.

## Live checks (dev key, Haiku 5.5)

**The five paste cases** (tonight's Vets state; the new layout as #571 renders it), final prompt, one run each: 5 of 5 pass.

| Case | Read as | Result |
|---|---|---|
| 1. New layout pasted unchanged | 1 to 14 playing (Stuart, Mustafa, BH included), Jon and Shane can't play, David bench | Matches the list, no change |
| 2. Rory adds "15. Rory" under pay as you go | 15. Rory playing | Rory IN |
| 3. Steve blanks "6." | Line 6 blank | Steve OUT |
| 4. Rory adds "2. Rory" under Bench | Rory reserves | Rory on the bench |
| 5. Old layout pasted unchanged | The same as case 1 | Matches the list, no change |

**The reader's existing live suite** (`scripts/dryrun-monthly-reader.ts`, 40 cases), one full pass on the final prompt: 39 of 40. The miss was N6 ("steff", a member with no name yet at number 3, read as a guest in that run). It passed in the two earlier full passes and in 4 of 4 reruns, and passes 4 of 4 on main, so it is an occasional miss, not a pattern.

**Found on the way: the reader's 8,192-token budget never applied.** `pipeline/llm.ts` clamped every call to `PIPELINE_MAX_TOKENS_CEILING = 4,096`. On the 22-line October list ("a blank line and a name moved to can't play") the reader's output runs 3,400 to 4,100 tokens with thinking, on main and on this prompt. It was cut off in 2 of 4 runs here, but in 0 of 3 on main. The ceiling is now 8,192. The monthly reader is the only caller that asks for more than 4,096, so nothing else changes.
