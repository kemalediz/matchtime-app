# Prompt change: "@Match Time DM these people" (2026-11-09)

The Vets MNF case: Shane posted "@~BH @+44 7747 410069 @Matt Afc Walcountians Vets @~Stuart Belcher @+44 7594 772036 @~Troy 'Trojan' Dyall - Any of you boys fancy it?" with three places open. The owner wants to answer "@Match Time DM these people", "@Match Time DM the people above", or quote Shane and say "@Match Time DM them", and have MatchTime DM each of them the club's usual invite for the game.

One prompt changes: the **admin extractor** (`EXTRACTOR_PROMPTS.admin`, `src/lib/pipeline/extractors.ts`). The **router is unchanged**: measured on the dev key before any change, it already routed every new phrasing to `admin_ops` (4 of 4), and after the change the live check routed all 11 cases as expected.

The model only says that the people TAGGED are meant (`playersFrom: ["named"]`). It never names them. Code finds who they are from WhatsApp's own mention data (`src/lib/named-invite-rules.ts`).

## Size

| | Characters |
|---|---|
| Before | 17,980 |
| After | 18,839 (+859) |

Still above the cache floor (`src/lib/pipeline/__tests__/cache-threshold.test.ts` passes). The JSON schema's `playersFrom` enum gains `"named"`, so the cached prefix changes once.

## What changed in meaning

1. `recruit` now covers inviting particular people, not only finding players from somewhere: `playersFrom` says **who or from where**.
2. A new `playersFrom` value, `"named"`: the people tagged with @ in the message itself, in the message it replies to, or in the message just above. It stands alone, never beside a place. Code enforces that too: with `"named"` in the list, no place, club or "unsaid" is carried, so nothing but those people can be asked or DM'd.
3. "everywhere" is now "the three places" (there are four values, one of them not a place). Same meaning.
4. One new example group, EN and TR side by side, placed before the places. Nothing else reworded; no example removed.

## Side by side (only the lines that changed)

| OLD | NEW |
|---|---|
| `"recruit" find players who are not in the squad yet; playersFrom says from where. Showing, listing or counting the squad is "other", and so is talking about another club or the player pool.` | `"recruit" find players who are not in the squad yet, or invite particular people to play; playersFrom says who or from where. Showing, listing or counting the squad is "other", and so is talking about another club or the player pool.` |
| `playersFrom (recruit): every place the message means the players are to come from, never guessed; [] when it names none (MatchTime then asks).` | `playersFrom (recruit): who is to be invited, never guessed: the people tagged, or every place the message means the players are to come from; [] when it says neither (MatchTime then asks).` |
| (none) | `"named" the particular people tagged with @ in THE MESSAGE, in the message it replies to, or in the message just above it ("DM these people", "message the people above", "invite them"). Code finds who they are; you only say they are meant. MatchTime invites exactly those people, so "named" stands alone, never beside a place.` |
| `"everywhere" or "wherever you can" ("her yerden", "nereden olursa") is all three. An answer ...` | `"everywhere" or "wherever you can" ("her yerden", "nereden olursa") is the three places. An answer ...` (rest unchanged) |
| (none) | `The people tagged, not a place:` |
| (none) | `"@Match Time DM these people", replying to a message that tags people / "@Match Time bu kişilere özelden yaz" -> recruit, playersFrom ["named"]` |
| (none) | `"@Match Time DM the people above" / "@Match Time yukarıda etiketlenenlere mesaj at" -> recruit, playersFrom ["named"]` |
| (none) | `"@Match Time invite @Ali and @Sam for tonight" / "@Match Time @Ali ve @Sam'i bu akşama davet et" -> recruit, playersFrom ["named"]` |

Schema: `playersFrom: { type: "array", items: { type: "string", enum: ["club", "partners", "pool"] } }` becomes `enum: ["named", "club", "partners", "pool"]`.

## Paid tests (dev key, Haiku 5.5)

Cheap plan: the new cases once, then ONE pass of every suite that reads the admin extractor, plus the router's find-players check.

**The new cases** (`scripts/live-check-dm-named.ts`, real router then real admin extractor): **11 of 11**, 22 calls, $0.0075.

| Case | Shape | Routed | Read |
|---|---|---|---|
| "@Match Time DM these people" | reply quoting Shane | admin_ops | named |
| "@Match Time DM them" | reply | admin_ops | named |
| "@Match Time DM the people above" | same flush as Shane | admin_ops | named |
| "@Match Time DM the people above" | Shane in an earlier flush | admin_ops | named |
| "@Match Time can you message these lads and invite them" | reply | admin_ops | named |
| "@Match Time bu kişilere özelden yaz" | reply | admin_ops | named |
| "@Match Time yukarıda etiketlenenlere mesaj at" | above | admin_ops | named |
| "@Match Time message the lads from the last 5 matches and invite them" | alone | admin_ops | club (unchanged) |
| "@Match Time ask the regulars if they can play" | alone | admin_ops | club (unchanged) |
| "@Match Time ask the group" (tagged message above) | above | admin_ops | club (unchanged) |
| "Any of you boys fancy it?" | above | offer | no recruit |

Before the change (same router, old extractor), the first four came back `other`: nothing would have happened.

**Regression pass, one run each, the existing behaviours:**

| Suite | Result | Calls | Cost |
|---|---|---|---|
| ask-both | 28/28 | 43 | $0.0085 |
| ask-source | 26/26 | 41 | $0.0090 |
| hq-pool | 44/44 | 65 | $0.0145 |
| hq-outward | 12/12 | 18 | $0.0042 |
| partner-ask-words | 38/38 | 57 | $0.0140 |
| free-places | 46/47 (1 router miss) | 63 | $0.0148 |
| hq-cancel | 19/19 | 33 | $0.0066 |
| players-cancel | 13/13 | 22 | $0.0041 |
| admin-group | 56/57 (1 router miss) | 66 | $0.0124 |
| admin-retry-venue | 21/25, extractor misses 0 (4 router misses) | 41 | $0.0086 |
| quiet-hours | 14/14 | 28 | $0.0049 |
| flex-format | 34/34 | 68 | $0.0129 |
| season-break | 10/10 | 15 | $0.0032 |
| router-find-players (REPEAT=1) | 26/26 | 26 | $0.0042 |

**The admin extractor missed nothing in any suite.** Every miss was the ROUTER, whose prompt and code this change does not touch: "Sam and Ali both play free on Friday" in HQ routed other_att; a bare "yes" between organisers routed self_att; "@Match Time 2", "@Match Time ikincisi" and "@Match Time added the venue location" (HQ) routed away from admin_ops. These are single-pass router misses on an unchanged prompt; a single pass cannot tell an occasional miss from a steady one.

**Total paid spend for this change: 617 model calls, about $0.135**, including 9 calls ($0.0056) measuring the router and the old extractor on the new cases before any change.

## Review round (2026-11-09): no prompt change, one more paid check

The review of #566 changed code only; the prompts are as above. Its test gap, a tagged drop that asks for a replacement, was checked on the dev key with every case of `scripts/live-check-dm-named.ts` run once: **15 of 15**, 34 calls, $0.0075.

| Case | Routed | Read |
|---|---|---|
| "@Match Time @Najib Ahmadi is out, find a replacement" | other_att, side recruit | the ordinary recruit, not named |
| "Najib Ahmadi can't make it, @Match Time get someone" | other_att, side recruit | the ordinary recruit, not named |
| "@Match Time @Najib Ahmadi gelemiyor, yerine birini bul" | other_att, side recruit | the ordinary recruit, not named |
| "Najib Ahmadi yok, @Match Time birini bul" | other_att, side recruit | the ordinary recruit, not named |

The 11 named and unchanged cases above passed again, unchanged. Paid spend for the whole PR: 651 calls, about $0.143.
