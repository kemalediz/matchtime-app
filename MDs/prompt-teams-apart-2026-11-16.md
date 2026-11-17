# Prompt change: the teams extractor reads "apart" (2026-11-16)

The Vets players' group, 16 Nov 2026. The organiser twice tagged "@Match Time generate the teams, put Dan and Craig in separate teams please". The teams extractor returned `action: "generate"` with empty `pairings`: it could say "together" and had no field for "apart", so the request was silently ignored. A player's "swap Dan and Kemal" then worked.

## What changes in meaning

1. **New field `apart`**, defined once beside `pairings`: people who must play on DIFFERENT teams, one array per group (two people on opposite teams; a bigger group spread across both). Nobody is moved by name: code decides who goes where.
2. **`pairings` said more plainly**: people who must play on the SAME team, with two examples, and the same "nobody is moved by name".
3. **`generate`** holds even when the message also puts people together or apart; **`swap`** names "together or apart" among the changes to the teams as they stand.
4. **Examples**: the together and apart examples sit in two groups (new teams; the teams as they stand), EN and TR side by side; the `toMatchTime` request example is now "keep Dan and Craig apart". Field order: the move fields, then `pairings`, `apart`, then `teamNames`. Nothing else changed.

## Size

| Prompt | Before | After |
|---|---|---|
| Teams extractor (`EXTRACTOR_PROMPTS.teams`) | 9,394 chars | 10,600 chars (+1,206) |

## Paid check

`scripts/live-check-teams-apart-2026-11-16.ts`, once, dev key: router 7/7 to `balancer`; teams extractor 12/12 (the incident, apart EN and TR on new teams and on the teams as they stand, together and apart in one message, plain generate EN and TR, two-player swap, together, colour swap); the incident end to end through the real balancer. 21 model calls, $0.0060.

## Old and new, the lines that changed

Opening line

- OLD: `You never pick the players: code builds, changes, brings back and clears the line-ups, and checks every name.`
- NEW: `You never pick the players: code builds, changes, brings back and clears the line-ups, keeps people together or apart, and checks every name.`

`generate`

- OLD: `... This holds even when the same message also asks for new names, or says "again", "once more" or "instead".`
- NEW: `... This holds even when the same message also asks for new names, puts people together or apart, or says "again", "once more" or "instead".`

`swap`

- OLD: `change the teams as they stand and leave everyone else where they are: people change team, go to a named team, end up together, or the two teams swap over, colours included. A message that only puts people on a team or together, without asking for new teams, is "swap".`
- NEW: `change the teams as they stand and leave everyone else where they are: people change team, go to a named team, end up together or apart, or the two teams swap over, colours included. A message that only says who goes where, or who plays with or apart from whom, without asking for new teams, is "swap".`

`pairings`

- OLD: `people who must end up on the same team as each other, one array per group.`
- NEW: `people who must play on the SAME team as each other, one array per group ("me and David on the same team", "Ali and Habib together"). Nobody is moved by name: code decides who goes where.`

`apart` (new)

- NEW: `people who must play on DIFFERENT teams, one array per group: two people end up on opposite teams, and a bigger group is spread across both ("keep Dan and Craig apart", "separate teams", "not on the same team", "ayrı takımlarda"). Nobody is moved by name: code decides who goes where.`

`toMatchTime`

- OLD: `... tagged or not ("swap Rafi and Yorel", "Ali and Habib on one team", "use these") ...`
- NEW: `... tagged or not ("swap Rafi and Yorel", "keep Dan and Craig apart", "use these") ...`

Examples

OLD (spread over "New teams" and "Changing the teams as they stand"):

```text
  "make the teams and put me and David on the same team" -> generate, pairings [["me","David"]]
  "Ali and Habib on one team" / "Stick keeper. Ali and Habib on one team" / "Ali ile Habib aynı takımda olsun" -> swap, pairings [["Ali","Habib"]]
```

NEW (two groups of their own):

```text
Who plays with whom, on new teams:
  "make the teams and put me and David on the same team" / "takımları kur, beni David ile aynı takıma koy" -> generate, pairings [["me","David"]]
  "generate the teams, put Dan and Craig in separate teams please" / "takımları kur, Dan ile Craig ayrı takımlarda olsun" -> generate, apart [["Dan","Craig"]]
  "regenerate the teams, Dan and Craig on different teams" / "takımları yeniden kur, Dan ile Craig aynı takımda olmasın" -> generate, apart [["Dan","Craig"]]
Who plays with whom, on the teams as they stand:
  "Ali and Habib on one team" / "Stick keeper. Ali and Habib on one team" / "Ali ile Habib aynı takımda olsun" -> swap, pairings [["Ali","Habib"]]
  "keep Dan and Craig apart" / "Dan and Craig shouldn't be on the same team" / "Dan ile Craig'i ayır" -> swap, apart [["Dan","Craig"]]
  "split Tom, Ali and Sam between the teams" / "Tom, Ali ve Sam'i takımlara dağıt" -> swap, apart [["Tom","Ali","Sam"]]
```

The whole prompt, before and after, is `EXTRACTOR_PROMPTS.teams` in `src/lib/pipeline/extractors.ts` at `origin/main` and on this branch.
