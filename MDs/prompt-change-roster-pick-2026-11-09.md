# Who is who: the model picks the member, code never matches names (2026-11-09)

Kemal chose option B after the Vets MNF incident at 14:42 ("David - Kemal's son, is on the bench" benched the member Davide De Sousa), then widened it: "never use string matching". This page is the old and new side by side for review.

## What changed in meaning

- **Who a name is, is now the model's.** Code used to decide it by spelling: exact name, alias, first name, a whole word of the name, and a first name one or two letters off (the near miss that read "David" as Davide). Now one model call, `who-is-who`, is shown the club's members (each with a short ref and its aliases) and the message, and says for each quoted name: one member it is sure of, nobody in the club, or several possible members.
- **Code only checks and acts.** A ref the model was not shown is no member. A member is moved only on a sure pick. "Not sure, probably X" comes back as ambiguous with one candidate and moves nobody, exactly like two members with the same name.
- **The useful guesses PR #570 removed are back, through the model:** "habibi" is Habib, "Moham" is Mohammed, "Davdie" is Davide. The harmful ones stay gone: "David" is not Davide, "Sami" is not Samir.
- **A failed call moves nobody and provisions nobody** (the name is unidentified, read as an ambiguity).
- **One call per batch or pasted list, never per name.** A batch that names nobody (most traffic: "IN", "out" about the sender) makes no call.
- **Extractor prompts are unchanged.** They still quote names verbatim; only what happens to the quoted name changed.

## Old vs new

| | OLD: code rules (`identity.ts` `resolvePerson`, `resolve-or-provision-name.ts`, `admin-group-squad-rules.ts` `nameCandidates`, `squad-from-list.ts`, `mention-names.ts`) | NEW: one prompt, `WHO_IS_WHO_SYSTEM` in `src/lib/pipeline/who-is-who.ts` |
|---|---|---|
| Who decides | Spelling, in this order: 1. exact full name; 1b. alias; 2. exact first name; 3. a whole token of the name ("Ul Haq"); 4. a first name one or two letters off, if the surname agreed; 5. any token of the reference against first names ("my dad Najib"). Elsewhere: a first-name prefix of 3+ letters (pasted lists, team commands, provisioning, squad lists); mentions by alias, then the same resolver. | The model, reading the whole message: "Read each name the way a member of the group would, with the whole message in mind." |
| What it is shown | The quoted string and the roster names. Never the message. | WHERE; MEMBERS (p1, p2 ..., full name, `also:` aliases, `(former)`); each message with its sender (and their ref) and NAMES TO IDENTIFY (n1, n2 ..., verbatim). |
| A member | Any of the five spelling rules matched exactly one member. | "member": "you are sure it is one particular member ... full name, first name or surname, a nickname listed for them, an obvious nickname or shortening of their name ("habibi" for Habib, "Moham" for Mohammed), or a plain misspelling of it ("Davdie" for Davide), and the message gives no sign it means somebody else." |
| Nobody | No rule matched. | "none": "a different name that only looks like a member's: David is not Davide, Sami is not Samir, Daniel is not Daniela, unless a nickname listed or the message itself says it is that member ... somebody the message describes as an outsider ("David, Kemal's son", "my brother Ali", "a mate from work, Tom") when no member has that name." |
| Ambiguous | Two members matched the same rule. | "ambiguous": "more than one member could be meant and the message does not say which ... or one member is probably meant but you are not sure. Put every member it could be in candidates." |
| David vs Davide | Step 4 near miss: benched Davide (before #570); after #570, unknown. | none (the message says he is Kemal's son, and no member is called David). |
| "habibi", "Moham", "Davdie" | Before #570: near miss/prefix sometimes; after #570: unknown (a guest or nothing). | The member. |
| Examples | None (code). | Grouped by meaning, English and Turkish side by side: 7 member, 3 none, 2 ambiguous. |
| Output | n/a | `{people: [{id, verdict: member|none|ambiguous, member: "pN" or "", candidates: [...]}]}`, structured output. |

The full new prompt is `WHO_IS_WHO_SYSTEM` in `src/lib/pipeline/who-is-who.ts`.

## Size and caching

- System prompt: 3,354 characters. Measured on the dev key: the cached prefix (system plus schema) is **1,730 tokens**, well above Haiku 5.5's 512-token cache floor; it was written once and read on every later call.
- The per-club part (the roster) is in the user turn, after the cached prefix, so it never breaks the cache. Vets (29 members) is about 350 uncached input tokens per call; FNF or Sutton (about 80) about 900.
- Model: Haiku 5.5 with adaptive thinking (`HAIKU_CALL`), like the extractors.
- Measured cost: about **$0.0001 per call** once the cache is warm ($0.0004 on the first call, which writes the cache).

## Where it runs (every path that turned a name in a WhatsApp message into a member)

| Path | Before | Now |
|---|---|---|
| Players' group attendance (third parties, replacements, a bare "Confirmed" to MatchTime's pending list) | `resolvePerson` | `attendance-engine-batch.ts` asks who-is-who once per batch, after extraction, before the engine and HQ's vetting |
| Questions ("is Ali in?"), stats about a player | `resolvePerson`, stats aliases | `answer-batch.ts`, once per batch |
| Teams (includes, pins, pairings) | `resolvePerson` | `team-ops-engine-batch.ts`, once |
| Payments (payer, who it covers) | `resolvePerson` | `admin-ops-engine-batch.ts`, once |
| HQ squad changes | the HQ squad reader picked members, then `resolvePerson` re-matched the names | the reader's own picks are used as they are; only names it could not place are asked |
| HQ pasted list (preview and YES) | `matchPastedName` / `nameCandidates`, then `resolveOrProvisionByName` per name | one who-is-who call for the list's unplaced names; one call for the new names at YES |
| HQ team commands (swap, move, set) | `nameCandidates` (prefix match) | one call per command, roster = players on the teams and in the squad |
| HQ Man of the Match, fee waiver | `resolvePerson` | one call per message |
| @mentions whose phone is unknown | alias, then `resolvePerson` on the pushname | one call per batch for the leftover pushnames |
| Provisioning a guest / a pasted list's new names | exact, first name, alias over all memberships | one call over all memberships, former ones marked; a former member is brought back |
| Players'-group squad lists (`extract-squads` cron) | alias, exact, first-name prefix per name | one call per list |
| Dry run (`pipeline/run.ts`) | `resolvePerson` | same step as production |

## Paid check (dev key, `scripts/live-check-who-is-who.ts`, each case once)

The real extractor for each case's route, then the real who-is-who call, then the engine's resolver. 26 cases, **26 passed**, 52 model calls, **$0.0110** (extractor 26 calls $0.0086, who-is-who 26 calls $0.0025).

New cases (EN and TR each):

| Case | Result |
|---|---|
| "David - Kemal's son, is on the bench" / "David, Kemal'in oğlu, yedekte" (Davide on the roster) | not a member, both |
| "habibi is in" / "habibi bu hafta geliyor" (Habib Rahimi) | Habib, both |
| "Moham can't make it" / "Moham gelemiyor" (Mohammed Iqbal) | Mohammed, both |
| "Davdie is out" / "Davdie bu hafta yok" | Davide, both |
| "David is in" / "David geliyor" (David Aksoy and David Russo) | ambiguous, both: nothing written, asked |
| "my brother Ali is coming" / "kardeşim Ali de geliyor" (no Ali) | not a member, both |

Existing live suites, one pass each on this branch, every failure compared with origin/main:

| Suite | Branch | Same on main? |
|---|---|---|
| third-party offer, guest-name ask, auto-register adds, HQ paste, HQ attendance (one run of 26 tests, 315 calls, $0.0531) | 17 passed, 9 failed | 7 of the 9 fail on main too (friend-link era expectations: "asks for the name" now gets a friend link; "Kieran" routes as noise). HQ paste "real squad list" passed on a rerun (the HQ squad reader read it as chatter once; no who-is-who call was made). COMBINED "I'm in, and my brother can play too" saw a member called "my brother Shahrokh" left in the shared test database by an earlier test in that run; a targeted 5-run rerun of it and its CONTROL passed 5/5 with no such member, as on main. |
| Vets sandbox (138 calls, $0.0372) | 29 passed, 3 failed | A and N fail on main (known); H fails on main too ("Rating window has closed", a date in the scenario). |

Regression cases (names the old code resolved): "Tom OUT", "Glazers OUT", "AH out" (alias), "my dad Najib is also in", "Ul Haq is out", "C1, C2 OUT", "Mojib is replacing Najib", "Aydın bu hafta yok", "Sami is out" (not Samir), a payment ("Amir paid for 3: him, Adam and me"), a team pairing ("put me and Sait on the same team"), a stats question ("what's Sait's rating?"), Man of the Match ("MoM Naim"), a fee waiver ("Bilal washed the bibs, he's free this week"): all passed.
