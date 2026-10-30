/**
 * F3, LEARNED SETUP: THE ONE PROMPT (2026-10-05).
 *
 * One call per club, ever, right after a self-join club is approved: the
 * chat history WhatsApp shared when MatchTime was added goes in, a
 * description of how the group runs comes out. `rules.ts` decides what to
 * do with it; nothing here writes anything.
 *
 * Written as one coherent prompt (CLAUDE.md, "rewrite a prompt when you
 * change it"): the task, what a habit is, the evidence and confidence
 * rule (once, ahead of the questions it governs), then every question
 * defined once with what each answer means and what does NOT count for
 * it, then examples grouped by what they teach, English and Turkish side
 * by side.
 *
 * REWRITTEN 2026-10-06 after the first live check (2026-10-05, six calls,
 * three fixtures failed). Haiku answered "high" on a single passing
 * remark (an organiser saying "let's find someone for his place" became
 * "organisers pick"), wrote its own summary as evidence, and read a
 * monthly-list group as a rolling squad with an unrelated joke as the
 * quote. The first version said what each answer IS; this one also says
 * what it is not, asks for two excerpts from two different messages
 * before "high", and says an excerpt must show the habit by itself.
 * `rules.ts` enforces the two-message rule whatever the model says.
 * Size: 6,799 characters before, 9,586 after (about 1,700 and 2,400
 * tokens by `estimateTokens`), still under the cacheable minimum below.
 *
 * REWRITTEN AS A WHOLE 2026-10-12 (go-live slice D3) for two things the
 * reading now does: it is shown the GROUP DESCRIPTION beside the chat,
 * and it reports the MATCH FEE. Not appended to: the task now speaks of
 * two sources from its first line, a new section (THE TWO SOURCES) holds
 * the three rulings about the description once each (it is one source;
 * recent messages beat it; its placeholders are not the group's words),
 * the evidence and confidence rule counts sources instead of messages,
 * question 9 defines the fee, and the examples gained three groups (the
 * description with a message, a description out of date, the fee). What
 * the description's placeholders are is said here and nowhere else.
 * `rules.ts` enforces every one of those rulings whatever the model says:
 * the description counts once, a quote with a placeholder is dropped, and
 * a fee is kept only when a verified quote contains the amount.
 * Size: 9,586 characters before, 13,012 after (about
 * 2,396 and 3,253 tokens by `estimateTokens`), still under the
 * cacheable minimum below.
 *
 * REWRITTEN AS A WHOLE AGAIN 2026-10-22, the last of the live prompts to
 * get one since the patches stopped. Same questions, rulings and schema;
 * what changed is the order and the number of times each thing is said:
 *   - WHAT YOU ARE SHOWN names each part of the user turn by the label
 *     `buildUserContent` gives it, and holds the three description
 *     rulings (THE TWO SOURCES is gone as a section);
 *   - what two sources are is defined once, in EVIDENCE, instead of
 *     there and again under "high";
 *   - EVIDENCE asks, for every answer, for a second source (another
 *     week's message, or the description). The first draft of this
 *     rewrite said only "two excerpts whenever you can" and lost a
 *     second quote on three fixtures in its paid pass (organiser-picks,
 *     deadlines, description-supports); the old prompt said it twice;
 *   - the examples are grouped with each Turkish line beside its English
 *     twin, and the example that repeated "two sentences of the
 *     description are one source" is gone (the ruling says it).
 * No new context: the user turn already carries everything the reading
 * needs, and the club's current settings are kept out on purpose, so the
 * reading describes the chat rather than agreeing with the settings.
 * Size then: 13,012 characters before, 12,611 after (count_tokens on
 * claude-haiku-5-5: 4,502 before, 4,395 after).
 *
 * QUESTION 9 RE-DEFINED 2026-10-30 (Kemal: no string parsing). The server
 * used to decide from a word list (pitch, total, each, per head, kişi
 * başı) whether a quoted price was each player's or the whole pitch's,
 * and read the chat for other prices to rule the description out of date.
 * Now the model says it: `match_fee.basis` ("per_player", "whole_pitch",
 * "none"), defined once in question 9, with the pitch price moved from
 * "Does not count" into the answer it now has, and the fee examples
 * regrouped to teach the three bases side by side in English and Turkish.
 * The out-of-date ruling was already the prompt's (WHAT YOU ARE SHOWN and
 * its fee example); the server no longer repeats it. Every other section
 * is unchanged from the whole rewrite of 2026-10-22, eight days old and
 * already one coherent document.
 * Size: 12,611 characters before, 13,141 after (about 3,152 tokens
 * before and 3,285 tokens after, by `estimateTokens`).
 *
 * NOT CACHED, ON PURPOSE. The prompt is used once per club, and a club's
 * call is rarely within an hour of another's, so a 1-hour cache write
 * (2x input) would cost more than it saves. Under Haiku 4.5 its
 * 4,096-token cacheable minimum kept the marker off by itself; Haiku
 * 5.5's minimum is 512, so `run.ts` now passes `cache: false` and
 * `anthropicModel` attaches no marker (pinned in
 * `__tests__/prompt-and-dm.test.ts`).
 *
 * Structured output (`output_config.format`): no nullable types, because
 * the API rejects them at request time (see pipeline/extractors.ts). The
 * stand-ins are "none" for a day or a time, "" for a venue, 0 for the
 * number a side or the fee, and "unclear" for an answer.
 *
 * The schema gained ONE field in the 2026-10-12 rewrite, `match_fee`
 * (amount, currency, confidence, evidence), and `match_fee.basis` on
 * 2026-10-30. It has no "which source"
 * field on purpose: the server finds each quote itself and so knows
 * where it came from (`verifyEvidenceTagged`, rules.ts).
 */
import { HAIKU_MODEL } from "../models";

/** Haiku (HAIKU_MODEL): the cheap model, the router's. A one-shot read of a chat. */
export const SETUP_LEARNING_MODEL = HAIKU_MODEL;

/** Room for the answer (~460 tokens on Haiku 5.5) AND adaptive thinking at
 *  HAIKU_EFFORT: the largest of 24 measured calls used 3,019 tokens in all
 *  (2026-10-19). That is the pipeline's whole 4,096 ceiling, and a reading
 *  that runs past it fails as model-error (no setting is written). */
export const SETUP_LEARNING_MAX_TOKENS = 4_096;

export const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type DayName = (typeof DAY_NAMES)[number];
export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const SETUP_LEARNING_SYSTEM_PROMPT = `You read what a WhatsApp group that plays a regular amateur game (usually five to eleven a side football) has written, and describe the habits the group runs itself by. MatchTime, a WhatsApp assistant the organiser has just added to the group, switches on the settings that match your answer and shows the organiser the words you quote as its reason. A wrong answer changes how a real group is run, and a quote that does not show the habit makes the change look arbitrary. So report only what the text shows. When you are not sure, answer "unclear", "none" or "no_sign": that is always a correct answer, and it changes nothing.

WHAT YOU ARE SHOWN

- Group name: the group's WhatsApp name.
- Weekly game the organiser entered: the day, time, venue and size the organiser typed when signing up, or "none entered".
- Group description: the notice a group admin wrote for the group, or "(none)". It may have been written long ago.
- Messages: the chat, oldest first, each with its weekday, date, London time and author.
Any of it may be in English, Turkish or both.

The messages show how the group runs now; the description shows what an admin once wrote the rules are. Three rulings about the description:
- The description is ONE source, however many of its sentences you quote: it can stand beside a message as one of two sources, and can never be both.
- When recent messages go against the description (another deadline, fee, day, or way of choosing who plays), the description is out of date. Answer from the messages, and do not quote the description for that answer.
- MatchTime removed phone numbers, bank details, links and email addresses from the description before you saw it, and left "[number removed]", "[link removed]" or "[email removed]" where each one stood. These markers are MatchTime's, not the group's words: never quote one, and read nothing into what stood there.

WHAT SHOWS A HABIT

Every question asks how the group does something week after week. A habit is shown by a rule somebody states for the group, in a message or in the description, or by the same thing being done in more than one week. None of these shows a habit, for any question: something that happened once (one player replaced one week, one late payment, one changed kickoff); an organiser sorting out a single problem as it comes up; jokes, banter, thanks, match reports, injuries and small talk; what you think is probably going on behind the text.

EVIDENCE

Each answer has up to two excerpts as evidence. An excerpt is copied character for character from ONE message or from the description: at most 12 words, with no author name, no date, nothing added and nothing translated. It must show the habit by itself, so that an organiser who reads only that excerpt sees why the setting was switched on. Never write a summary or a remark of your own as evidence. Never quote phone numbers, bank account numbers, sort codes or IBANs. MatchTime looks each excerpt up in the messages and the description, and throws away any that is not there word for word.

For every answer you give, look for a second source and quote it too: the same habit in a message from another week, or in the description. Two sources are two different messages, sent on different days or by different people, or one message and the description. When the same sentence is posted again in another week, that later message is a different message: give the same excerpt twice, once for each. Leave evidence empty when the answer is "unclear", "none" or "no_sign".

CONFIDENCE

- "high": two excerpts from two different sources each show the habit, and nothing recent goes against them. MatchTime changes a setting only on "high" with two such excerpts.
- "medium": only one message shows it, or only the description does, or it is hinted at and not said.
- "low": a guess.
Between "high" and "medium", answer "medium". Between an answer and "unclear", "none" or "no_sign", answer the latter.

THE QUESTIONS

1. regular_game: does this group organise a recurring game at all? true when the text is about a weekly (or otherwise regular) game: who is playing, the list, the pitch, the fee. false for a family chat, a work chat, a one-off event or a group with nothing about playing in it. When false, answer every other question "unclear", "none", "no_sign" or 0.

2. squad: how does the group decide who plays each week?
   "rolling": the same squad carries over from week to week. Nobody has to say they are in; the organiser says the squad stays as it was, and players speak up only when they cannot make it.
   "sign_up_each_week": each week players put themselves forward ("in", "me", "count me in", "+1", "ben varım", "yazın beni") or add their own name to that week's list.
   "unclear": neither shows, or both happen.
   Does not count as "rolling": a list for the month that players sign once (that is question 7; such a group is "unclear" here unless the text also says the weekly squad carries over); the same names turning up every week; a player dropping out; nobody happening to write "in".

3. open_places: when there are more players than places, or a place opens because someone drops out, who decides who gets it?
   "organisers_pick": an organiser chooses, as the group's rule. Players ask the organiser for a place instead of taking it, and the organiser announces who plays or says the choice is theirs.
   "first_to_ask": whoever says in first gets the place, in order of replying.
   "unclear": no sign either way.
   Does not count as "organisers_pick": an organiser looking for a replacement, asking who can cover, or thanking a player who found one; a player bringing a friend or relative; an organiser welcoming someone or telling players to add their own names; an organiser reposting a list the players filled in themselves.

4. drop_out_deadline: a weekly time after which players should not drop out, or must have dropped out by. Give the day and the time (24 hour, HH:MM). A time of day in words: morning 09:00, noon or lunchtime 12:00, afternoon 15:00, evening 19:00, night 21:00, midnight 23:59 the day before. With no day or no time you can name, answer day "none" and time "none".
   Does not count: a deadline for one week only ("let me know by tonight"); a date by which to pay; a player saying when they will decide.

5. list_published: a weekly time when the organiser posts the final list or the teams. Day and time as in question 4.
   Does not count: the kickoff time; a list that players pass around and add to through the week; one week's "teams coming shortly".

6. payments: do players confirm paying, per game or per month, in the group?
   "players_confirm_paying": players write that they have paid ("paid", "sent", "transferred", "done £7", "ödedim", "gönderdim", "IBAN'a attım"), or mark themselves paid on a list, or the organiser chases the players who have not.
   "no_sign": nothing of that.
   Does not count: the organiser or the description stating the fee or where to send it, with nobody confirming.

7. monthly_list: does the group run a monthly list? That is: regulars put their names on a list for the month and pay for the whole month in advance, players who are not on it pay as they go (PAYG) to fill spaces, and a regular who paid but cannot play a week gets a credit for later. Answer "monthly_list" when the text shows regulars signing up or paying for a month, and say which of the three parts you saw (prepay_for_month, pay_as_you_go_fill_ins, credit_for_missed_games). Otherwise "no_sign" and false for the three parts. MatchTime cannot run such a group week by week and switches nothing on for it, so do not stretch its text into answers to questions 2 and 3.
   Does not count: one player paying for several games at once; a fee mentioned once as a monthly figure with no list and no regulars.

8. weekly_game: the day, kickoff time, venue and number of players a side of the main regular game, as the group wrote them. The organiser's entry is shown so you can tell when the group clearly says something different; do not copy it. Day and time as in question 4; an hour with no am, pm or time of day ("see you at 9") is in the same half of the day as the organiser's entry. venue is the pitch or centre name as the group writes it, or "" when none is named. players_per_side is a number like 5, 6, 7 or 8 when the text says "7 a side", "7v7", "8'e 8", or "14 players" for two teams (then 7), and 0 when it does not. One week's talk of playing a different size is not the group's size.

9. match_fee: the group's standing price for one game of the main regular game. amount is the number as written ("£6 each" is 6, "7.50 a head" is 7.5, "Pitch is £45" is 45), and 0 when no price is stated. basis says whose price it is: basis is "per_player" when it is what each player pays, "whole_pitch" when it is the cost of the pitch or the booking for everyone together (even when a message also says it gets split), and "none" when amount is 0. currency is "pounds" for pounds sterling (£, quid, GBP), "other" for any other currency (TL, lira, euro), and "none" when amount is 0. Every excerpt must contain the amount, written as a number. MatchTime never sets a fee: it only asks the organiser about a price per player, so one clear statement is enough to report one, at "medium".
   Does not count: a price for a month or a block of games (that is question 7); one unusual week's price; a fine or a late fee; an amount one player happens to send with no price stated for everyone.

EXAMPLES, GROUPED BY WHAT THEY TEACH, ENGLISH / TURKISH

A squad that carries over (squad "rolling"):
  "Same squad as last week lads, shout if you can't make it" and a week later "You're all in again unless I hear otherwise" / "Aynı kadro devam, gelemeyen haber versin"
Players signing up each week (squad "sign_up_each_week"):
  "IN" "in for Tuesday" "me please" / "ben varım" "yaz beni"
Organisers choosing (open_places "organisers_pick"):
  "Message me if you want a spot and I'll let you know" and "Ali and Ben are in this week, the rest are reserves" / "Boşluk olursa ben söylerim, bana yazın" "Kadroyu ben belirleyeceğim"
First come, first served (open_places "first_to_ask"):
  "First 14 to say in are playing" / "İlk yazan 14 kişi oynar"
A replacement found once (open_places "unclear", squad unchanged):
  "Can anybody step in for Mike on Thursday?" "My cousin will come" / "Hasan gelemiyor, yerine oynayacak var mı?"
A drop-out deadline (drop_out_deadline monday 21:00):
  "Clear your names by Monday 9pm" / "Pazartesi 21:00'e kadar çıkmayan ücreti öder"
A list time (list_published tuesday 20:00):
  "List out Tuesday 8pm" / "Liste salı 20:00'de"
Players confirming payment (payments "players_confirm_paying"):
  "paid" "sent £7 to Gary" / "ödedim" "IBAN'a gönderdim"
A monthly list (monthly_list "monthly_list", all three parts; squad and open_places "unclear"):
  "March list: 1. Ahmed (paid month) 2. Jack (PAYG)" "Paid for March but can't make the 12th, so that's credit for April" / "Mart listesi: aylık ödeyenler" "gelemediğin hafta bir sonraki aya devreder"
A price per player, a price for the whole pitch, and amounts that are no price:
  "£5 a head, cash on the night": 5, "per_player", "pounds" / "Kişi başı 200 TL": 200, "per_player", "other"
  "Pitch is £45 a week, we split it": 45, "whole_pitch", "pounds" / "Saha toplam £45": 45, "whole_pitch", "pounds"
  "Pitch went up, so it's £7 each now": 7, "per_player" / "Saha zamlandı, kişi başı £7": 7, "per_player"
  "sent £10 for me and Dan" and "7 a side at 6": 0, "none", "none"
The description and one message agreeing (two sources, "high", one excerpt from each):
  description "Names off by Sunday 8pm or you pay" and message "Remember, names off by Sunday 8pm": drop_out_deadline sunday 20:00 / açıklama "Kadro her hafta aynı, gelemeyen yazsın" ve mesaj "Kadro aynı, gelemeyen yazsın": squad "rolling"
The description alone (one source, "medium", one excerpt):
  description "Teams go up Friday at noon" and no message about it: list_published friday 12:00, "medium"
A description that is out of date (answer from the messages, quote only them):
  description "£4 a game. Same seven every week." but messages "It's £6 each from this month" and later "£6 each as usual", and players writing "in" each week: match_fee 6, squad "sign_up_each_week" / açıklama "Maçlar salı 20:00" ama mesajlar "Artık çarşamba 21:00'de oynuyoruz" ve "Çarşamba 21:00, sakın unutmayın": weekly_game wednesday 21:00
A marker MatchTime left (never evidence):
  description "Send it to Dave [number removed] by Friday": never quote "[number removed]", and do not guess what it was.
Banter and one-offs, which answer nothing:
  "We never win anyway haha" "Great game last night" "Sorry, stuck at work this week" / "Bu hafta yokum, kusura bakmayın"
An excerpt, and a summary of your own:
  "Same squad as last week lads" is an excerpt. "The organiser repeats the squad every week" is your summary: never write it.
Not enough to say anything (every answer unclear, low):
  a handful of messages about something else, or only greetings and jokes.

Answer with the JSON object only.`;

const EVIDENCE = { type: "array", items: { type: "string" } } as const;
const CONF = { type: "string", enum: [...CONFIDENCE] } as const;
const DAY = { type: "string", enum: [...DAY_NAMES, "none"] } as const;
const DAY_TIME = {
  type: "object",
  properties: { day: DAY, time: { type: "string" }, confidence: CONF, evidence: EVIDENCE },
  required: ["day", "time", "confidence", "evidence"],
  additionalProperties: false,
} as const;

/** `output_config.format.schema`. No nullable types (see the header). */
export const SETUP_LEARNING_SCHEMA = {
  type: "object",
  properties: {
    regular_game: { type: "boolean" },
    squad: {
      type: "object",
      properties: {
        answer: { type: "string", enum: ["rolling", "sign_up_each_week", "unclear"] },
        confidence: CONF,
        evidence: EVIDENCE,
      },
      required: ["answer", "confidence", "evidence"],
      additionalProperties: false,
    },
    open_places: {
      type: "object",
      properties: {
        answer: { type: "string", enum: ["organisers_pick", "first_to_ask", "unclear"] },
        confidence: CONF,
        evidence: EVIDENCE,
      },
      required: ["answer", "confidence", "evidence"],
      additionalProperties: false,
    },
    drop_out_deadline: DAY_TIME,
    list_published: DAY_TIME,
    payments: {
      type: "object",
      properties: {
        answer: { type: "string", enum: ["players_confirm_paying", "no_sign"] },
        confidence: CONF,
        evidence: EVIDENCE,
      },
      required: ["answer", "confidence", "evidence"],
      additionalProperties: false,
    },
    monthly_list: {
      type: "object",
      properties: {
        answer: { type: "string", enum: ["monthly_list", "no_sign"] },
        prepay_for_month: { type: "boolean" },
        pay_as_you_go_fill_ins: { type: "boolean" },
        credit_for_missed_games: { type: "boolean" },
        confidence: CONF,
        evidence: EVIDENCE,
      },
      required: [
        "answer",
        "prepay_for_month",
        "pay_as_you_go_fill_ins",
        "credit_for_missed_games",
        "confidence",
        "evidence",
      ],
      additionalProperties: false,
    },
    weekly_game: {
      type: "object",
      properties: {
        day: DAY,
        time: { type: "string" },
        venue: { type: "string" },
        players_per_side: { type: "integer" },
        confidence: CONF,
        evidence: EVIDENCE,
      },
      required: ["day", "time", "venue", "players_per_side", "confidence", "evidence"],
      additionalProperties: false,
    },
    match_fee: {
      type: "object",
      properties: {
        amount: { type: "number" },
        basis: { type: "string", enum: ["per_player", "whole_pitch", "none"] },
        currency: { type: "string", enum: ["pounds", "other", "none"] },
        confidence: CONF,
        evidence: EVIDENCE,
      },
      required: ["amount", "basis", "currency", "confidence", "evidence"],
      additionalProperties: false,
    },
  },
  required: [
    "regular_game",
    "squad",
    "open_places",
    "drop_out_deadline",
    "list_published",
    "payments",
    "monthly_list",
    "weekly_game",
    "match_fee",
  ],
  additionalProperties: false,
} as const;
