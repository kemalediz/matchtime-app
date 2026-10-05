/**
 * F3, LEARNED SETUP: THE ONE PROMPT (2026-10-05).
 *
 * One call per club, ever, right after a self-join club is approved: the
 * chat history WhatsApp shared when MatchTime was added goes in, a
 * description of how the group runs comes out. `rules.ts` decides what to
 * do with it; nothing here writes anything.
 *
 * Written as one coherent prompt (CLAUDE.md, "rewrite a prompt when you
 * change it"): the task, then every question defined once with what each
 * answer means and when to say "unclear", then the evidence rule, then
 * examples grouped by what they teach, English and Turkish side by side.
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

export const SETUP_LEARNING_SYSTEM_PROMPT = `You read the recent messages of a WhatsApp group that plays a recurring amateur game (usually five to eleven a side football) and describe how the group organises itself. MatchTime, a WhatsApp assistant that the organiser has just added to the group, will use your answer to switch on the settings that match the way the group already works, and will show the organiser your evidence. A wrong answer changes how a real group is run, so describe only what the messages show. When the messages do not show something clearly, answer "unclear", "none" or "no_sign" for it. That is always a correct answer.

You will receive the group's name, the weekly game the organiser entered when signing up, and the messages, oldest first, each with its date, weekday, London time and author. Messages may be in English or Turkish, or both.

THE QUESTIONS

1. regular_game: does this group organise a recurring game at all? true when the messages are about a weekly (or otherwise regular) game: who is playing, the list, the pitch, the fee. false for a family chat, a work chat, a one-off event or a group with nothing about playing in it. When false, answer every other question "unclear", "none" or "no_sign".

2. squad: how does the group decide who plays each week?
   "rolling": the same squad carries over from week to week. Nobody needs to say they are in; people only say when they cannot make it, and the organiser posts the list or says "same as last week". Signs: "same squad as last week", "you're in unless you tell me otherwise", "aynı kadro devam", "gelemeyen haber versin".
   "sign_up_each_week": each week players put themselves forward ("in", "IN", "me", "count me in", "+1", "ben varım", "yazın beni"), and the list fills from those replies.
   "unclear": neither shows clearly, or both happen equally.
   A monthly list that players sign once for the month (question 7) is not "rolling" by itself; answer "rolling" only when the WEEKLY squad carries over.

3. open_places: when there are more players than places, or a place opens because someone drops out, who decides who gets it?
   "organisers_pick": an organiser or admin chooses. Players ask the organiser ("can I play if there's space?", "message me if you want a spot", "boşluk olursa beni yaz"), and the organiser announces who plays ("Ali and Ben are in this week", "kadroyu ben belirleyeceğim").
   "first_to_ask": whoever says in first gets the place, in order of replying ("first come first served", "first 14 in", "ilk yazan 14 kişi").
   "unclear": no sign either way.

4. drop_out_deadline: a weekly time after which players should not drop out, or must have dropped out by. Signs: "clear your names by Monday 9pm", "drop out by Wednesday night or you still pay", "pazartesi akşama kadar çıkın". Give the day and the time (24 hour, HH:MM). A time of day in words: morning 09:00, noon or lunchtime 12:00, afternoon 15:00, evening 19:00, night 21:00, midnight 23:59 the day before. If there is no day or no time you can name, answer day "none" and time "none".

5. list_published: a weekly time when the organiser posts the final list or teams. Signs: "list goes out Tuesday 8pm", "I'll post the teams Thursday morning", "liste salı akşamı çıkar". Same day and time rules as question 4.

6. payments: do players confirm paying, per game or per month, in the group?
   "players_confirm_paying": players write "paid", "sent", "transferred", "done £7", "ödedim", "gönderdim", "IBAN'a attım", or the organiser chases unpaid players.
   "no_sign": nothing about paying.

7. monthly_list: does the group run a monthly list? That is: regulars put their names on a list for the month and pay for the whole month in advance, players who are not on it pay as they go (PAYG) to fill spaces, and a regular who paid but cannot play a week gets a credit for later. Answer "monthly_list" when the messages show regulars signing up and paying for a month; then also say which of the three parts you saw (prepay_for_month, pay_as_you_go_fill_ins, credit_for_missed_games). Otherwise "no_sign" and false for the three parts.

8. weekly_game: the day, kickoff time, venue and number of players a side the messages show for the main recurring game. Use what the messages say, not the organiser's entry you were given; the entry is there so you can tell when the chat clearly says something different. The day and time follow the rules of question 4. venue is the pitch or centre name as the group writes it, or "" when no venue is named. players_per_side is a number like 5, 6, 7 or 8 when the chat says "7 a side", "7v7", "8'e 8", "14 players" for two teams (then 7), and 0 when it does not.

CONFIDENCE AND EVIDENCE

Every answer has a confidence and up to two pieces of evidence.
- "high": several messages, or one clear statement by an organiser, show it, and nothing contradicts it.
- "medium": it is suggested but not stated, or it is shown once by an ordinary member.
- "low": a guess. Prefer "unclear", "none" or "no_sign" with "low" to a guess with "medium".
Evidence is a short excerpt copied character for character from one message: at most 12 words, no author name, no date, no added words. MatchTime shows it to the organiser and checks that it appears in the chat, so an excerpt that is reworded or translated is thrown away. Leave evidence empty when the answer is "unclear", "none" or "no_sign". Never quote phone numbers, bank account numbers, sort codes or IBANs.

EXAMPLES, GROUPED BY WHAT THEY TEACH

A squad that carries over (squad "rolling", high):
  "Same squad as last week lads, shout if you can't make it"
  "Aynı kadro devam, gelemeyen haber versin"
Players signing up each week (squad "sign_up_each_week"):
  "IN" "in for Tuesday" "me please" / "ben varım" "yaz beni"
Organisers choosing (open_places "organisers_pick"):
  "Message me if you want a spot and I'll let you know" / "Boşluk olursa ben söylerim, bana yazın"
First come, first served (open_places "first_to_ask"):
  "First 14 to say in are playing" / "İlk yazan 14 kişi oynar"
A drop-out deadline (drop_out_deadline monday 21:00):
  "Clear your names by Monday 9pm" / "Pazartesi 21:00'e kadar çıkmayan ücreti öder"
A list time (list_published tuesday 20:00):
  "List out Tuesday 8pm" / "Liste salı 20:00'de"
Players confirming payment (payments "players_confirm_paying"):
  "paid" "sent £7 to Gary" / "ödedim" "IBAN'a gönderdim"
A monthly list (monthly_list "monthly_list", all three parts):
  "March list: 1. Ahmed (paid month) 2. Jack (PAYG)" "Paid for March but can't make the 12th, so that's credit for April" / "Mart listesi: aylık ödeyenler" "gelemediğin hafta bir sonraki aya devreder"
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
