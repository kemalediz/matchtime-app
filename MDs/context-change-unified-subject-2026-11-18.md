# What the unified answer is shown about the asker: old vs new (2026-11-18)

The fixes from PR #604 that were still broken on main after #626. **No prompt
text changed** (`UNIFIED_ANSWER_SYSTEM` is byte for byte as on main). What
changed is the CONTEXT the answer is shown about who the question is about.
Made-up people: the asker is Alfie Brook, 12th in the club ratings.

## A private message (DM)

| | Old (main) | New |
|---|---|---|
| Subject block | `THE PLAYER THE QUESTION IS ABOUT: Alfie Brook`, on every DM question, whoever it names | none: a DM has no reading of who its question names |
| Asker's block heading | `THE ASKER'S OWN STATS (they asked about themselves):`, on every question | `THE ASKER'S OWN STATS:` |
| Asker's average | `- Average rating: 6.9 (squad avg 7.0)` | `- Average of all the ratings they received (their stats page): 6.9 (squad avg 7.0)` |
| Asker's club rating and rank | in the subject block, read from the top-10 table cut | `- Club rating (their row in the club ratings table): 6.8 from 7 rated matches, no. 12` (a guest: "not ranked, because they play for this club as a guest"; left out: the table's own rule) |
| Asker's pairings | `- Best partnership: Cosmo Finch`, `- Nemesis: Eli Brook` (names only), plus the tables' chemistry read | `- Their best team-mate by win rate: Cosmo Finch, 4 wins in 5 matches together (80%)`, `- Their best team-mate by rating: Dario Gill, 7.5 average alongside them`, `- Their nemesis: Eli Brook, they won 1 of 4 against them`, from the stats page's own source (`loadPlayerSeasonStats`) |
| Pool facts | always "closed" (an empty environment) | the real pool switch, resolved as the group and HQ resolve it |

Why: "what is Bruno's rating?" had the asker's numbers under "the player the
question is about". The rank and pairings lines replace what the subject block
used to carry for the asker's own questions.

## The players' group and HQ

| | Old (main) | New |
|---|---|---|
| A name that does not resolve to one member (two Alexes, nobody, a misspelling) | subject block = the asker, with the asker's numbers | no subject block; the tables carry everyone under their own names |
| The asker's words for themselves | only the literal `me` | `isSelfRef`'s closed list (`me`, `I`, `myself`, `beni`, `bana`, `kendim`...), never when the word is also a member's name or alias (`Bana`) |
| HQ own stats block | only when the extractor wrote `me` | the same self words |

## Paid check (dev key, each case once)

`scripts/live-check-unified-subject.ts`: 18 calls, $0.0040.

| Case | Reply |
|---|---|
| DM "what is Bruno's rating?" OLD | Bruno Carr's club rating is 7.9, from 5 rated matches. |
| DM same, NEW | Bruno Carr's club rating is 7.9, from 5 rated matches. |
| DM "Bruno'nun puanı kaç?" OLD / NEW | Bruno Carr'ın kulüp puanı 7,9 (5 puanlı maç üzerinden). / ... (5 puanlı maçtan). |
| DM "what's my rank?" (12th) | Your club rating is 6.8 from 7 rated matches, which puts you no. 12 in the club ratings. |
| DM "sıralamam kaç?" | Kulüp puan tablosunda 12. sıradasınız, puanınız 6,8 (7 puanlı maç). |
| DM "who do I play best with?" | Your best team-mate by win rate is Cosmo Finch: 4 wins in 5 matches together (80%). By rating, Dario Gill, with a 7.5 average alongside you. |
| DM "en iyi kiminle oynuyorum?" | Kazanma oranına göre en iyi takım arkadaşın Cosmo Finch: birlikte 5 maçta 4 galibiyet (%80). ... Dario Gill, ortalama 7,5. |
| Group "what is Alex's rating?" (two Alexes) | Two players are called Alex: Alex Dale is rated 7.8 ..., and Alex Ewing is rated 7.7 ... |
| Group "Alex'in puanı kaç?" | Alex Dale 7,8 ... Alex Ewing 7,7 ile ayrı bir oyuncu, ... hangisini sorduğunuzu belirtirseniz tekrar bakarım. |
| Group "who's my nemesis?" / "en zorlandığım rakip kim?" | extractor wrote `me` both times; the subject is the asker; says it has no rivalry on record |

What one pass cannot prove: the OLD DM context answered Bruno's rating
correctly in this pass too (the model read the table), so the old fault is a
risk the context carried, not a miss reproduced here. An occasional miss can
pass once and fail live.

Existing behaviours, one pass: `scripts/live-check-unified-cleanup.ts`, 16
calls, $0.0033, all 12 cases as their "good" lines say.

DM path end to end, one pass (real route, real model, dev key):
`e2e/sim/dm-qa-payments-live.spec.ts` (8, EN and TR) and
`e2e/sim/dm-context-live.spec.ts` (3): 11 of 11 passed. The server's per-call
usage is not printed in that harness, so its cost is estimated, not measured:
about 15 to 25 calls, under $0.05.

Stubbed gates ($0): every e2e/api and e2e/sim spec, 1756 passed and 1 failed
on a dev-server ECONNRESET (`sim/pool/ask-retry.spec.ts`), which passed 6 of 6
when rerun alone.

## Review of #628 (same day)

- **A member called Bana is the subject.** The name lookup (who-is-who) skipped
  every word on the self list, so "Bana" was never looked up. It now skips a
  self word only when no member has that name or alias (`isSelfRefAmong`), in
  `factRefs` and `identifyRefs`. "what is Bana's rating?" in a club with a
  Bana: `THE PLAYER THE QUESTION IS ABOUT: Bana Kaya`, in groups and HQ.
- **Self words the list did not know.** Since an unresolved name now has no
  subject, an unknown self word lost the asker. `my`, `mine`, `benim`, `kendi`
  join the self list; `ben` is the asker only when no member is called Ben.
  HQ's own stats block follows the same rule.
- **One team sheet.** A batch with any team post has no squad post carrier.
- **The cap in a DM** answers `ignored: "qa-capped"`.

Paid rerun, `scripts/live-check-unified-subject.ts` with two more Turkish
cases ("ben kaçıncıyım?", "benim nemesisim kim?"): 22 calls, $0.0050. The
extractor wrote `me` for both, so the new list words are the safety net, not
the live path. Every case answered as its "good" line says except one: "en
zorlandığım rakip kim?" read "rakip" as the opposing team this time (it
answered correctly in the first run). Its context is the same before and
after this round (personRef `me`, the asker), so this is the model varying,
not this change.
