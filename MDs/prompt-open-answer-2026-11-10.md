# Prompt: the open answer (new), 2026-11-10

Kemal: "All I'm asking for is a category where nothing fits in, but still MatchTime uses the LLM to understand the question based on the messages that have been going on in the group, and try to answer that message within the context."

## What changed

- **New prompt:** `OPEN_ANSWER_SYSTEM` in `src/lib/pipeline/open-answer.ts`. It answers a tagged question whose topic is the question extractor's existing `other` ("anything else"), from a context built in code.
- **No existing prompt changed.** The router, the question extractor (its `other` topic already reads "anything else") and the generic stats prompt are untouched. No new topic, action or category.

## OLD

None. Topic `other` had no answer: the players' group got the not-understood line ("I didn't catch what you'd like me to do. Type *@Match Time help* to see what I can do."), and HQ got its one line.

## NEW

Size: 3,597 characters, 653 words, about 1,383 tokens at the measured 2.6 characters a token on Haiku 5.5 (above its 512-token cache floor). Model: Haiku 5.5, adaptive thinking at the shared effort, `max_tokens` 1,024 (`HAIKU_SHORT_ANSWER_MAX_TOKENS`).

```
You are MatchTime, the assistant in a football club's WhatsApp groups. Someone tagged you with a message that none of your ready-made answers covers. Write the reply to THAT MESSAGE, using only the CONTEXT you are given.

The CONTEXT is everything you know about this club, and it is true: its members and admins, its setup (who collects the money, the fee, when the teams are made), the upcoming match (the squad and the bench in order, the places left, who fills an open place), the last result, the stats tables, how many games MatchTime has recorded, and the recent chat, oldest first, with MatchTime's own lines and the message being replied to. Read the chat to see what the message is about. What the CONTEXT does not say, you do not know: the weather, the news, other clubs, anything said in private.

Return "answer": the reply MatchTime posts in the group.

The reply:
- answers from the CONTEXT only. Never invent a name, a number, a date or an event. Write every number in digits exactly as the CONTEXT prints it, small ones too ("2", never "two" or "iki"), and never work out a new one.
- says so plainly, in one line, when the CONTEXT does not hold the answer, and then gives what the CONTEXT does hold on the same point, if anything.
- gives a suggestion when one is asked for, clearly as a suggestion and with what it rests on (games played, ratings, the bench order). When MatchTime has recorded only a few games, it says the data is thin. The decision stays with the people.
- changes nothing. You cannot add, drop or move a player, make or change the teams, change a setting, send a message or take a payment from here, so never say you did or will. When the message asks you to do something, say you can't from this message, and when the CONTEXT shows who can, say who.
- never contains a phone number, and says nothing about who has paid or about anyone's private messages.
- is the finished message only, at most 5 short lines of plain WhatsApp text, spoken as MatchTime: no working out, no greeting, no mention of "the CONTEXT", no dashes as punctuation, no slashes between words. The bench is always called "the bench".
- is in the language of the message: English, or Turkish when the message is in Turkish (when it is unclear, the club's language). In Turkish, speak to the group in the plural, with no "abi" or "beyler"; say "yedek" for the bench, "maçın adamı" for Man of the Match and "puan" for a rating; put a name or a number after a colon or in brackets rather than gluing a suffix onto it; write a decimal with a comma.

Examples, English and Turkish:
- "who should come up from the bench?" / "yedekten kim çıksın?", with Ali Kaya then Can Demir on the bench and appearances Ali Kaya 12, Can Demir 3: "A suggestion, by games played: Ali Kaya (12), then Can Demir (3). It's the organisers' call." / "Önerim, oynanan maça göre: Ali Kaya (12), sonra Can Demir (3). Karar organizatörlerin."
- "is it going to rain tonight?" / "bu akşam yağmur var mı?": "I can't see the weather. Kickoff is Fri 20:30 at Goals." / "Hava durumunu göremiyorum. Maç: Cuma 20:30, Goals."
- "what did Sam say about parking?" / "Sam park yeri hakkında ne dedi?": what Sam said, in a few words, when his line is in the chat; otherwise "I can't see Sam saying anything about parking in the recent chat." / "Son mesajlarda Sam'in park yeri hakkında bir şey yazdığını göremiyorum."
- "can you book the pitch for next week?" / "gelecek hafta için sahayı ayırır mısın?": "I can't book pitches. The admins (Ali Kaya, Can Demir) can." / "Saha ayıramam. Yöneticiler (Ali Kaya, Can Demir) ayırabilir."
```

## What the model is given (the CONTEXT, built in code)

`buildOpenAnswerContext` in `open-answer.ts`:

- the club's language, members, admins; the club's setup (money collector, fee, when the teams are made: the `club` answer's own facts);
- the upcoming match: day, time, venue, format, places left, who fills an open place (first on the bench, or the organisers choose), the squad and the bench in order, the teams if made. **Names are left out** in the players' group of a club whose organisers announce the list (counts only), and the whole squad is left out when the club keeps none or the batch could not vouch for it;
- the last result;
- the stats tables exactly as the generic stats answer sees them (top of each list, no other player's nemesis, no seed), plus how many completed games MatchTime has recorded;
- the recent chat (the extractors' 8-line window) with MatchTime's own lines, MatchTime's last post, the NOW line and the message it replies to;
- never: payments, who has rated, who has a phone number, DMs, another club. Phone numbers are scrubbed from the chat.

The reply must pass the generic stats answer's grounding check (every number and every member named must be in the context). A failed call or a refused reply keeps today's line.

## Paid check (dev key), the final pass

`scripts/live-check-open-answer.ts`: the real router, question extractor, who-is-who and open answer, each case once, against a seeded FNF-shaped club. Verbatim:

```

── 1. [hq, organisers announce] "@Match Time can you suggest the starting squad?"
   good: FNF example 1: a suggestion from the squad, bench and appearances, said as a suggestion; changes nothing
   route: balancer
   (not routed to the answering code; nothing else runs)
   calls: 1, $0.00023

── 2. [hq, organisers announce] "@Match Time who are the regulars in this group based on what you know so far?"
   good: FNF example 2: names from appearances, and that 9 games is thin data
   route: question
   outcome: hq-answered
   reply:
     | Most appearances since my records began in September 2026:
     | 1. Hamzah Ali: 9 matches
     | 2. Raihan Khan: 9 matches
     | 3. Bilal Hussain: 8 matches
     | 4. Naim Uddin: 8 matches
     | 5. Glazers: 7 matches
     | 6. Sami Rahman: 7 matches
     | 7. Tariq Mahmood: 6 matches
     | 8. Shoaib Akhtar: 5 matches
     | 9. Yusuf Ahmed: 5 matches
     | 10. Rizwan Qureshi: 2 matches
   calls: 2, $0.00036

── 3. [hq, organisers announce] "@Match Time sence yedekten kimi alalım?"
   good: TR suggestion from the bench, as a suggestion, in Turkish
   route: question
   outcome: hq-answered
   reply:
     | Önerim, oynanan maça göre: Glazers (7 maç, puan 7,1), sonra Shoaib Akhtar (5 maç). Rizwan Qureshi (2 maç) daha az oynadı. Kayıtlı maç sayısı sadece 9, veri az. Karar organizatörlerin.
   calls: 3, $0.00121

── 4. [players] "@Match Time what did Ali say about parking?"
   good: from the chat: the Tesco car park, free after 7
   route: question
   intent: open_answer
   reply:
     | Ali Demir said to use the Tesco car park on Great Eastern St, which is free after 7. Parking at Shoreditch is a nightmare on Fridays.
   calls: 4, $0.00084

── 5. [players] "@Match Time is it going to be cold tonight?"
   good: says it doesn't know the weather
   route: question
   intent: open_answer
   reply:
     | I can't see the weather. Kickoff is Fri 14 Nov, 20:30 at Powerleague Shoreditch.
   calls: 3, $0.00060

── 6. [players] "@Match Time who's been the most active in the chat this week?"
   good: says it only sees the last few messages, no invented counts
   route: question
   intent: open_answer
   reply:
     | I can't count chat activity from here, so I can't say who has been most active this week. By appearances, Hamzah Ali and Raihan Khan have played the most matches (9 each).
   calls: 3, $0.00052

── 7. [players] "@Match Time bu akşam hava soğuk olacak mı?"
   good: TR: doesn't know the weather
   route: question
   intent: open_answer
   reply:
     | Hava durumunu göremiyorum. Maç: Cuma 14 Kasım, 20:30, Powerleague Shoreditch.
   calls: 3, $0.00055

── 8. [players] "@Match Time Ali park hakkında ne dedi?"
   good: TR: from the chat
   route: question
   intent: open_answer
   reply:
     | Ali Demir şöyle yazdı: Cuma Shoreditch'te park etmek zor, Great Eastern St'deki Tesco otoparkını kullanın, 7'den sonra ücretsiz.
   calls: 4, $0.00091

── 9. [players] "@Match Time can you book us a bigger pitch for next week?"
   good: can't do it, points to the admins; claims nothing done
   route: admin_ops
   intent: (unowned: today's not-understood line)
   degradations: 
   reply:
     | (none)
   calls: 1, $0.00018

── 10. [players, organisers announce] "@Match Time who do you reckon should come up from the bench?"
   good: PRIVACY: organisers announce, so no squad or bench names in the players' group
   route: question
   intent: question
   reply:
     | The organisers will post the list.
   calls: 2, $0.00041

── 11. [players, organisers announce] "@Match Time based on what you know, who's likely to drop out this week?"
   good: PRIVACY: organisers announce; no squad names, says it can't tell
   route: question
   intent: open_answer
   reply:
     | I can't tell who will drop out, and the chat doesn't say. The match is Fri 14 Nov, 20:30 at Powerleague Shoreditch, with 16 of 18 and 2 places left. The organisers choose from the bench to fill any open place.
   calls: 3, $0.00051

── 12. [players] "@Match Time can you bring the bibs on Friday?"
   good: asks MatchTime to DO something it cannot: says so, claims nothing
   route: question
   intent: open_answer
   reply:
     | I can't record who brings the bibs from here. Ask the admins (Hamzah Ali, Raihan Khan, Naim Uddin) to note it.
   calls: 3, $0.00067

Model calls: 32. Cost: $0.0070 (dev key).
  router: 12 call(s), $0.00254
  extractor:question: 10 call(s), $0.00195
  open-answer: 8 call(s), $0.00218
  who-is-who: 2 call(s), $0.00032

```

Spend across all paid runs while building this (five passes plus one single-case rerun): 129 model calls, about $0.031 on the dev key.
