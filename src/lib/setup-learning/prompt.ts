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
 * NOT CACHED, ON PURPOSE. The prompt is used once per club, and a club's
 * call is rarely within an hour of another's, so a 1-hour cache write
 * (2x input) would cost more than it saves. It also sits under Haiku
 * 4.5's 4,096-token cacheable minimum, so `anthropicModel` attaches no
 * marker (`shouldCachePrompt` is false; pinned in
 * `__tests__/setup-learning-prompt.test.ts`). If it ever grows past that
 * floor, the test fails and the choice has to be made again.
 *
 * Structured output (`output_config.format`): no nullable types, because
 * the API rejects them at request time (see pipeline/extractors.ts). The
 * stand-ins are "none" for a day or a time, "" for a venue, 0 for the
 * number a side, and "unclear" for an answer.
 */

/** Haiku 4.5: the cheap model, the router's. A one-shot read of a chat. */
export const SETUP_LEARNING_MODEL = "claude-haiku-4-5";

/** Room for the answer (~600 tokens measured on the fixtures' shape),
 *  with headroom; well under the pipeline's 4,096 ceiling. */
export const SETUP_LEARNING_MAX_TOKENS = 2_000;

export const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type DayName = (typeof DAY_NAMES)[number];
export const CONFIDENCE = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const SETUP_LEARNING_SYSTEM_PROMPT = `You read the recent messages of a WhatsApp group that plays a recurring amateur game (usually five to eleven a side football) and describe the habits the group organises itself by. MatchTime, a WhatsApp assistant the organiser has just added to the group, switches on the settings that match your answer and shows the organiser the messages you quote as its reason. A wrong answer changes how a real group is run, and a quote that does not show the habit makes the change look arbitrary. So report only what the messages show. When you are not sure, answer "unclear", "none" or "no_sign": that is always a correct answer, and it changes nothing.

You will receive the group's name, the weekly game the organiser entered when signing up, and the messages, oldest first, each with its date, weekday, London time and author. Messages may be in English or Turkish, or both.

WHAT A HABIT IS

Every question asks how the group does something week after week. A habit is shown by a rule somebody states for the group, or by the same thing being done in more than one week. None of these shows a habit, for any question:
- something that happened once: one player replaced one week, one late payment, one changed kickoff;
- an organiser sorting out a single problem as it comes up;
- jokes, banter, thanks, match reports, injuries and small talk;
- what you think is probably going on behind the messages.

EVIDENCE AND CONFIDENCE

Each answer has up to two pieces of evidence and a confidence.

Evidence is an excerpt copied character for character from ONE message: at most 12 words, with no author name, no date, nothing added and nothing translated. An excerpt must show the habit by itself: an organiser who reads only that excerpt should see why the setting was switched on. Do not write a summary or a remark of your own as evidence; "the squad is the same every week" is evidence only if a message says those words. Give two excerpts from two different messages whenever you can. When the same sentence is posted again in another week, that later message is a different message: give the same excerpt twice, once for each. MatchTime checks each excerpt against the chat and throws away any that is not there word for word. Leave evidence empty when the answer is "unclear", "none" or "no_sign". Never quote phone numbers, bank account numbers, sort codes or IBANs.

Confidence:
- "high": two excerpts from two different messages, sent on different days or by different people, each show the habit, and nothing in the chat goes against them. MatchTime changes a setting only on "high" with two such excerpts.
- "medium": only one message shows it, or it is hinted at and not said.
- "low": a guess.
If you are choosing between "high" and "medium", answer "medium". If you are choosing between an answer and "unclear", "none" or "no_sign", answer the latter.

THE QUESTIONS

1. regular_game: does this group organise a recurring game at all? true when the messages are about a weekly (or otherwise regular) game: who is playing, the list, the pitch, the fee. false for a family chat, a work chat, a one-off event or a group with nothing about playing in it. When false, answer every other question "unclear", "none" or "no_sign".

2. squad: how does the group decide who plays each week?
   "rolling": the same squad carries over from week to week. Nobody has to say they are in; the organiser says the squad stays as it was, and players speak up only when they cannot make it.
   "sign_up_each_week": each week players put themselves forward ("in", "me", "count me in", "+1", "ben varım", "yazın beni") or add their own name to that week's list.
   "unclear": neither shows, or both happen.
   Does not count as "rolling": a list for the month that players sign once (that is question 7; such a group is "unclear" here unless a message also says the weekly squad carries over); the same names turning up every week; a player dropping out; nobody happening to write "in".

3. open_places: when there are more players than places, or a place opens because someone drops out, who decides who gets it?
   "organisers_pick": an organiser chooses, as the group's rule. Players ask the organiser for a place instead of taking it, and the organiser announces who plays or says the choice is theirs.
   "first_to_ask": whoever says in first gets the place, in order of replying.
   "unclear": no sign either way.
   Does not count as "organisers_pick": an organiser looking for a replacement, asking who can cover, or thanking a player who found one; a player bringing a friend or relative; an organiser welcoming someone or telling players to add their own names; an organiser reposting a list the players filled in themselves.

4. drop_out_deadline: a weekly time after which players should not drop out, or must have dropped out by. Give the day and the time (24 hour, HH:MM). A time of day in words: morning 09:00, noon or lunchtime 12:00, afternoon 15:00, evening 19:00, night 21:00, midnight 23:59 the day before. If there is no day or no time you can name, answer day "none" and time "none".
   Does not count: a deadline for one week only ("let me know by tonight"); a date by which to pay; a player saying when they will decide.

5. list_published: a weekly time when the organiser posts the final list or the teams. Same day and time rules as question 4.
   Does not count: the kickoff time; a list that players pass around and add to through the week; one week's "teams coming shortly".

6. payments: do players confirm paying, per game or per month, in the group?
   "players_confirm_paying": players write that they have paid ("paid", "sent", "transferred", "done £7", "ödedim", "gönderdim", "IBAN'a attım"), or mark themselves paid on a list, or the organiser chases the players who have not.
   "no_sign": nothing of that.
   Does not count: the organiser stating the fee or where to send it, with nobody confirming.

7. monthly_list: does the group run a monthly list? That is: regulars put their names on a list for the month and pay for the whole month in advance, players who are not on it pay as they go (PAYG) to fill spaces, and a regular who paid but cannot play a week gets a credit for later. Answer "monthly_list" when the messages show regulars signing up or paying for a month, and say which of the three parts you saw (prepay_for_month, pay_as_you_go_fill_ins, credit_for_missed_games). Otherwise "no_sign" and false for the three parts. MatchTime cannot run such a group week by week, so for a monthly_list group it switches nothing on: do not stretch its messages into answers to questions 2 and 3.
   Does not count: one player paying for several games at once; a fee mentioned once as a monthly figure with no list and no regulars.

8. weekly_game: the day, kickoff time, venue and number of players a side the messages show for the main recurring game. Use what the messages say, not the organiser's entry you were given; the entry is there so you can tell when the chat clearly says something different. The day and time follow the rules of question 4, and an hour with no am, pm or time of day ("see you at 9") is in the same half of the day as the organiser's entry. venue is the pitch or centre name as the group writes it, or "" when no venue is named. players_per_side is a number like 5, 6, 7 or 8 when the chat says "7 a side", "7v7", "8'e 8", or "14 players" for two teams (then 7), and 0 when it does not. One week's talk of playing a different size is not the group's size.

EXAMPLES, GROUPED BY WHAT THEY TEACH

A squad that carries over (squad "rolling"):
  "Same squad as last week lads, shout if you can't make it" and, a week later, "You're all in again unless I hear otherwise"
  "Aynı kadro devam, gelemeyen haber versin"
Players signing up each week (squad "sign_up_each_week"):
  "IN" "in for Tuesday" "me please" / "ben varım" "yaz beni"
Organisers choosing (open_places "organisers_pick"):
  "Message me if you want a spot and I'll let you know" and "Ali and Ben are in this week, the rest are reserves" / "Boşluk olursa ben söylerim, bana yazın" "Kadroyu ben belirleyeceğim"
First come, first served (open_places "first_to_ask"):
  "First 14 to say in are playing" / "İlk yazan 14 kişi oynar"
A replacement found once (open_places "unclear", squad not changed by it):
  "Can anybody step in for Mike on Thursday?" "My cousin will come" / "Hasan gelemiyor, yerine oynayacak var mı?"
A drop-out deadline (drop_out_deadline monday 21:00):
  "Clear your names by Monday 9pm" / "Pazartesi 21:00'e kadar çıkmayan ücreti öder"
A list time (list_published tuesday 20:00):
  "List out Tuesday 8pm" / "Liste salı 20:00'de"
Players confirming payment (payments "players_confirm_paying"):
  "paid" "sent £7 to Gary" / "ödedim" "IBAN'a gönderdim"
A monthly list (monthly_list "monthly_list", all three parts; squad and open_places "unclear"):
  "March list: 1. Ahmed (paid month) 2. Jack (PAYG)" "Paid for March but can't make the 12th, so that's credit for April" / "Mart listesi: aylık ödeyenler" "gelemediğin hafta bir sonraki aya devreder"
Banter and one-offs, which answer nothing:
  "We never win anyway haha" "Great game last night" "Sorry, stuck at work this week" / "Bu hafta yokum, kusura bakmayın"
An excerpt against a summary of your own:
  evidence "Same squad as last week lads" is an excerpt. "The organiser repeats the squad every week" is your summary: never write it.
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
  ],
  additionalProperties: false,
} as const;
