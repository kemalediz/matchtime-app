/**
 * STAGE 2 — EXTRACTORS. They return FACTS. They never return decisions.
 *
 * This is the heart of "the model extracts, code decides". §6.2:
 *
 *   "Note what is ABSENT: no `intent`, no `registerAttendance`, no
 *    `registerFor`, no `react`, no `reply`, no `reasoning`. There is no
 *    field in which the model can express a decision, and no prose for a
 *    regex to parse."
 *
 * Two consequences fall straight out of that:
 *
 *   • The OUT safety net (`route.ts:1012-1056`) has nothing to do. It
 *     exists only to reconcile `intent` against `registerAttendance`
 *     when the model decides them independently and they disagree —
 *     eleven regexes over the model's English prose. One `polarity`
 *     cannot contradict itself, and there is no prose here at all.
 *   • The bench-demote net (`route.ts:1060-1111`) has nothing to read.
 *     It reverse-engineers a write from `verdict.reply`; the model no
 *     longer writes replies.
 *
 * THE SQUAD STATE IS NOT PASSED, BUT IT CAN STILL BE SEEN: recent chat
 * and MatchTime's last post can show a full squad, so the prompt forbids
 * using either for `polarity` (a "bench" inferred from capacity breaks
 * PR #27's invariant, "a BENCH row means FULL or ASKED, never inferred").
 * Capacity is arithmetic; arithmetic is the engine's job.
 */
import { renderGroupReplyContext, type ContextMessage } from "../reply-context";
import { anthropicModel, degradation, extractJson, EXTRACTOR_MODEL, type ModelRequest, type PipelineModel } from "./llm";
import { isAiBudgetExceeded } from "../ai-budget-context";
import { parsePeriodFields } from "./stats-period";
import { HELP_FEATURES } from "./types";
import type {
  AdminFacts,
  AttendanceFacts,
  Claim,
  ClaimBasis,
  ConditionOn,
  Degradation,
  Facts,
  Polarity,
  QuestionFacts,
  QuestionTopic,
  Route,
  ScoreFacts,
  SideRequest,
  StatsTable,
  TeamFacts,
  Tense,
} from "./types";

const EXTRACTOR_MAX_TOKENS = 1_024;

/**
 * The routes whose extraction is retried once. See the essay in
 * `extractForRoute`.
 *
 * Deliberately spelled out here rather than derived from
 * `gate.ts:ENGINE_ROUTES`, even though the two lists are identical
 * today. They mean different things — that one is "who decides this
 * route", this one is "where is silence expensive enough to pay for a
 * second call" — and a future route could join one without joining the
 * other. `__tests__/extractors.test.ts` asserts both halves by name, so
 * a drift shows up as a named failure rather than as a silent change of
 * policy on the write path.
 */
const RETRYING_ROUTES: readonly Route[] = ["self_att", "other_att", "offer", "unsure"];

/** Which specialist a route reaches. Four routes share the attendance
 *  extractor because they are four ways of saying the same kind of
 *  thing; `unsure` is included because §11.1's asymmetry sends every
 *  doubt to the extractor rather than to silence. */
export type ExtractorKind = "attendance" | "question" | "teams" | "score" | "admin" | "none";

export function extractorFor(route: Route): ExtractorKind {
  switch (route) {
    case "self_att":
    case "other_att":
    case "offer":
    case "unsure":
      return "attendance";
    case "question":
      return "question";
    case "balancer":
      return "teams";
    case "score":
      return "score";
    case "admin_ops":
      return "admin";
    case "none":
    // The organisers' group's own routes have no extractor: code owns
    // them (`admin-group-understand.ts`).
    case "approve":
    case "poster":
    case "team_sheet":
    case "help":
    case "ask_group":
      return "none";
  }
}

// ── Prompts ────────────────────────────────────────────────────────────

export const EXTRACTOR_PROMPTS: Record<Exclude<ExtractorKind, "none">, string> = {
  attendance: `You read ONE message from a football club's WhatsApp group and report what it SAYS about who is playing. You report facts about the text. You never decide what happens next: code does that, from the club's records.

WHAT YOU ARE SHOWN
RECENT CHAT is the last few messages before this one. MATCHTIME'S LAST POST is the bot's most recent post in the group. NOW is the time at the club. When the message is a WhatsApp reply, a THEY ARE REPLYING TO line names the message it quotes: whose it is (MatchTime's or a member's), when, and its words. THE MESSAGE is the one message you report on, with the name of the person who typed it: the sender.
Report on THE MESSAGE only. Everything above it is context, for working out who and what the message refers to: who "he" is, which line a "same" or "ben de" answers (the quoted message, when there is one), what a bare "yes" agrees to. A claim made in the quoted message or the recent chat is never reported again: "same" under Ali's "IN" is one claim, the sender's. The context often shows the squad too: a count such as "13/14" or "14/14", a list of names, a bench. The squad they show is never a reason for any field: code holds the real squad and places every player.

EACH CLAIM
Return one claim for each person whose attendance the message speaks about:
  subject      "sender" if the claim is about the person who typed it, "other" for anyone else
  personRef    the words used for that person, VERBATIM. Never invent or expand a name. "" for the sender. One exception: a "he", "him" or "o" that points at the author of the message replied to is written as that author's name, as the THEY ARE REPLYING TO line gives it. When the line names no one ("a member (not identified)"), write the words as they are.
  personNamed  true when the words IDENTIFY A PARTICULAR PERSON: a name, a nickname, or an @mention. false ONLY for a relationship, a quantity or an indefinite: "my brother", "2 of my guys", "someone", "a mate", "another keeper"
  polarity     what the MESSAGE says that person is doing, read from its own words:
                 "in"     joining or staying in
                 "out"    leaving or not coming
                 "bench"  ONLY when the message explicitly asks for the bench: it names the bench, a reserve, sub, backup, spare, standby or waiting list place, "yedek" in any form, or 🪑
               Polarity describes the message, NEVER the squad's capacity. A plain "in" is "in" when the chat shows 14/14, when the list looks full, and when the sender is already on it. Code decides from the real squad whether an "in" goes into the team or onto the bench; an "in" turned into "bench" because the squad looked full takes a place away from someone who already had it.
               An offer to play if needed ("put me down if you're short") is "in" with contingent true, never "bench".
  contingent   true when the message states something the claim itself depends on: "in if my back holds up", "happy to drop if you find someone". Otherwise false.
                 Asking for cover is NOT a condition. "I'm out, anyone able to replace me?" is leaving either way: contingent false, plus the "recruit" side request.
                 An OFFER to give up a place is contingent even with no "if" in it: "I can drop out", "happy to pull out", "I'll step aside", "I can make room", "happy to drop for X". The offer depends on being taken up: polarity out, contingent true, conditionOn "squad".
                 The test is whether the message says the sender IS leaving or that they COULD. "I'm out", "can't make it", "I won't be there" state a decision already taken: contingent false.
                 A position is a note, not a condition: "I'll go in goal" / "kaleye geçerim" is in, contingent false.
  conditionOn  "squad" if the condition is about the squad or the team's needs, "self" if it is about the person themselves, otherwise "none"
  tense        "present" now, "future" a commitment about an upcoming match INCLUDING a standing one ("count me in whenever you are short"), "past" reporting something that already happened ("I was in last week"), "hypothetical" a counterfactual about something that is not the case ("if I WAS in the team it would not be ruined"). A condition attached to a real future commitment is NOT hypothetical: use future and set contingent
  basis        what the message DOES about the person's place. Read the VERB the message uses about that person, and nothing else:
                 the verb acts on the SQUAD, it asks for, claims or gives up a place: "I'm in", "put me down", "stick me down", "count me in", "add me", "I'll take a spot", "I'll be the 14th", "count me as the 14th", "consider me as the 14th", "happy to fill in", "I'll be there", "I'm out", "can't make it" -> "decision"
                 the verb acts on the PERSON, it describes their own state, whereabouts or ability and leaves their place unanswered: "I'm free", "I'm around", "I'm available", "I'm about", "I will be back Tuesday week", "I land Monday", "I'm away that week", "I'm free after the 5th" -> "availability"
               A courtesy on the END of a state description does not promote it into a decision. "if you need me", "if you're short", "if you're stuck", "let me know", "give me a shout" are offers of goodwill, not asks for a place: the person has told you where they will be, not asked to be put in. The verb in front decides; the courtesy behind never does. These four are settled, and they are settled this way:
                 "I'm free Tuesday if you need me"          -> availability, the verb is "I'm free"
                 "I'm around if you're short"               -> availability, the verb is "I'm around"
                 "put me down if you're short"              -> decision, "put me down" asks for the place
                 "count me as the 14th if you need one"     -> decision, "count me as the 14th" claims the place
               When a message carries BOTH, the place verb wins: "I'm free Tuesday, put me down" is a decision.
               Naming a day settles nothing either way: "I'm in for next Tuesday" names a day and is a decision; "I will be back Tuesday week" names a day and is not.
  reported     true when relaying what someone else said ("Najib said he's in")
  replaces     ONLY on an "in" claim, and only when the message SAYS this person is taking somebody else's place: the words used for that other person, VERBATIM ("Najib", "@Najib", "me"). "" everywhere else
  confidence   0 to 1

THE WHOLE MESSAGE
Also return, once:
  affirmation  "yes" or "no" when the message is a bare answer to MatchTime ("Confirmed", "yes", "no"): to the MatchTime message it replies to, else to MATCHTIME'S LAST POST. Otherwise "none"
  sideRequests any of: "recruit" (asks for a replacement or more players for a specific gap), "chase" (a general nudge for more players that says nothing about the sender's own place)

READING THE MESSAGE
It may be in English or Turkish, often mixed or misspelt. Report the same facts either way. Each group below is one thing to learn, English / Turkish side by side.

The sender's own place: subject sender, decision, contingent false.
  "I'm in", "count me in" / "varım", "ben varım", "geliyorum", "sayın beni", "var" -> in
  "I'm out", "can't make it" / "yokum", "ben yokum", "gelemiyorum", "yok", "bu hafta yokum" -> out
  "me too" / "ben de" after a neighbour's "I'm in" / "ben varım", or "same" replying to it -> the sender's own claim, same polarity as the line it answers

A reply about the person it quotes: subject other.
  "he's out" / "o yok" replying to Ali Khan's message -> personRef "Ali Khan", out

The bench comes only from the message's own words.
  "in, for bench", "In as a reserve", "put me on standby" / "yedekte kalayım", "yedeğe yaz beni" -> bench
  The chat shows 14/14 with the sender already on the list, and the sender types "in" -> polarity in, not bench. The same for "varım" at 14/14.

Other people: subject other, personRef as written.
  "Ali is coming too" / "Ali de geliyor" -> Ali, in, reported false
  "Ali said he's coming" / "Ali geliyorum dedi" -> Ali, in, reported true
  "Mehmet can't come" / "Mehmet gelemiyor" -> Mehmet, out

Guests. "+1", "+2" or "plus one", on its own or after the sender's own claim, is a GUEST the sender is bringing, never the sender: subject other, personRef the token verbatim ("+1"), personNamed false, polarity in. "ben de" is the sender; "+1" is not.

Several claims in one message. Report all of them, and any side request with them. "I'm in, and my brother can play too" is TWO claims.

Hedges are claims, not silence. A bare hedge says the sender might play and has not decided: subject sender, polarity in, contingent true, conditionOn "self", basis decision, tense future. That shape is what gets the person asked again nearer the match; an empty claims array for a hedge is a maybe nobody ever follows up.
  "maybe", "50/50", "not sure yet", "I'll see" / "belki", "bakarız", "kesin değil", "bakacağım" -> the hedge shape, contingent true

A REPLACEMENT IS TWO CLAIMS, AND WHICH WAY ROUND IT RUNS IS THE POINT. One person arrives and one leaves: report an "in" claim for the arriving person, with replaces set to the leaving person's words, and an "out" claim for the leaving one. Chatter around it changes nothing.
  "Mojib is replacing Najib", "Mojib replaces Najib", "Mojib in for Najib", "Mojib takes Najib's place", "Najib is out, Mojib is in", "swap Najib for Mojib" / "Mojib, Najib'in yerine geliyor", "Najib yerine Mojib", "Mojib, Najib'in yerini aliyor", "Najib cikiyor, Mojib giriyor", "Najib yok, Mojib var" -> Mojib in (replaces "Najib"), Najib out
  "Hi guys, Mojib is replacing Najib on the list. We can change" -> the same two claims
  "Mojib will play in my place" / "benim yerime Mojib oynayacak" -> Mojib in (replaces "me"), the sender out
  "Ali is coming, Mehmet can't make it" -> two ordinary claims with replaces "" on both: nobody said one was taking the other's place
IF YOU CANNOT TELL WHICH OF THE TWO IS ARRIVING AND WHICH IS LEAVING, REPORT NO CLAIMS AT ALL. Never guess a direction. A wrong guess takes a real player out of a real squad, and saying nothing costs one message somebody can retype.

Banter still contains claims. "Zeeshan is out lol vote him out" DOES claim Zeeshan is out. Report it as written; whether it is a joke is decided elsewhere, with information you do not have.

Return an empty claims array only when the message genuinely says nothing about anyone's attendance.`,

  question: `You classify ONE question from a football club's WhatsApp group: the players' group, or the organisers' own group. You never answer it. Code reads the club's records and writes every name, date and number the group sees; your fields only tell it which question was asked. A field the message does not state gets its empty value. Never fill one in from a guess.

Classify THE MESSAGE only. The recent chat, MatchTime's last post and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line: MatchTime's or a member's, with its words) are context for what it refers to; the topic is what THIS message asks for, not what an earlier message asked. NOW is the time at the club. A message that asks two things gets the topic whose answer covers both. Messages come in English and Turkish, often mixed, misspelt or unpunctuated.

FIELDS

topic
What the asker wants back. Exactly one of:
  squad            the names of who is playing the upcoming match, as the list. "The list" is this list.
  count            HOW MANY are in or still needed, whether that is enough, or a number to check
  bench            who is on the bench, when that is all the message asks
  person_status    whether one named person is playing
  phones           who has no phone number on record
  fixture          the upcoming match itself: whether it is on, kick-off time, venue
  score            RESULTS of matches already played: the score, who won, for one match or for several
  payments         who has or has not paid the match fee, or how many still owe
  rating_progress  who has or has not SUBMITTED ratings or Man of the Match votes for the last match, or how many have
  my_stats         the asker's OWN stats, ratings, form or season summary, which they are sent privately
  stats            a table or record about PLAYERS across matches (ratings, appearances, Man of the Match, Elo and the rest), about the club or about anyone but the asker's own numbers
  options          what to do about being short of players: a smaller format, alternatives
  how_it_works     how MatchTime itself works here: what the bench is, how signing in works, how the teams are made, and the rest
  club             how the club itself is run: who the admins or organisers are, who collects the money, the match fee, what time the teams are made
  other            anything else

personRef
The person the question is about, as the message names them, without a possessive or suffix: "Idris's" and "Idris'in" are "Idris". On a stats question about the asker ("my chemistry", "my nemesis"), "me". "" when it names nobody.

statedCount
A number the message ASSERTS about the squad, for checking: "we're 9/14 right?" is 9. -1 otherwise.

feature
For how_it_works only, the part of MatchTime it asks about:
  availability     signing in and out, the squad list, the bench or waiting list, saying maybe
  teams            how the two teams are made
  mom              Man of the Match
  ratings          player ratings
  reminders        reminders
  payments         the match fee and paying it
  none             MatchTime as a whole or none of these, and every other topic

The remaining fields describe a LIST. table and listEnd belong to stats only; listSize and period belong to stats and score. Every other topic leaves them all empty: table "none", listSize -1, listEnd "top", period "none", periodCount -1, periodUnit "none".

table
Which stats table:
  ratings          players' ratings. A bare "leaderboard", "the table", "rankings", "standings", "best players" or "top N" with no other measure named is ratings.
  appearances      who plays, turns up or attends the most. "Most consistent" on its own means turning up.
  mom              Man of the Match awards
  elo              Elo
  team_of_season   the team, XI or line-up of the season
  movers           whose rating or position is improving, climbing or in form
  chemistry        who a player plays best with, their best team-mates, their nemesis or toughest opponent
  mr_reliable      "Mr Reliable" or the most reliable player: the stats page badge for steady, strong ratings, never appearances
  other            a stats question no single table above answers, such as win rate or a comparison
  none             the question names no measure at all

listSize
How many were asked for, as written. On stats, rows of the table: "top 10" is 10, "top five" is 5. On score, how many results: "the last 5 matches" is 5, "son 3 maç" is 3. -1 when no number is named.

listEnd
"bottom" when the question asks for the worst, the lowest or the foot of a table; otherwise "top".

period
A stretch of time the question asks about, on stats or score, with periodCount and periodUnit:
  last             a rolling span back from today: "in the last year", "past 3 months", "last month", "son 1 yılda", "geçen ay". periodCount is the number written, 1 when none is ("last month" is 1). periodUnit is day, week, month or year.
  this             the current calendar week, month or year: "this month", "this year", "bu ay", "bu yıl". periodUnit is week, month or year; periodCount -1.
  season           "this season", "the season", "bu sezon". periodCount -1, periodUnit "none".
  all_time         "ever", "all-time", "of all time", "tüm zamanlar", "bugüne kadar". periodCount -1, periodUnit "none".
  none             no stretch of time stated
"Last" and "this" never swap: "last month", "last year", "geçen ay", "geçen yıl" are last, periodCount 1; "this month", "bu ay" are this.
"The last 3 matches" counts matches, not time: period "none" (on score it is listSize 3).
A score question that points at ONE match ("last night", "on Tuesday", "last week", "geçen hafta") names that match, not a stretch: period "none", listSize -1.

CLOSE CALLS
- squad or count: WHO is playing is squad, a list of names. HOW MANY is count, a number. Choose on what the asker wants back.
- squad or bench: a message that asks for the list, the squad or who is playing is squad, even beside a question about the bench, because the list shows the bench too. A message that asks only who is on the bench, or whether anyone is, is bench, however it says it.
- score or stats: scores, results and who won are score, for one match or several. Anything counted about players across matches is stats.
- one table or other: a question that needs two or more tables together ("is anyone in both the Elo top ten and the Man of the Match table?", a comparison across tables) is other, even when it names a table. Name a table only when that table alone answers it.
- my_stats or stats: my_stats only when the numbers are the asker's own and they ask to see them. Anyone else's numbers, a ranking of the group, and the asker's own pairings are stats.
- rating_progress or other: rating_progress asks who has submitted ratings. A message that tells the players to rate, thanks them, or remarks on ratings asks for nothing: other.
- payments, how_it_works or club: WHO owes is payments. HOW to pay is how_it_works, payments. WHO collects the money, and what the fee is, is club.
- bench or how_it_works: WHO is on the bench is bench. What the bench is, or whether there is one now, is how_it_works, availability.
- how_it_works or club: HOW the teams are made is how_it_works, teams. WHEN they are made, as a time, is club, and so is WHO runs the club.

EXAMPLES
Each line is a message, then the fields that are not empty.

The upcoming match:
  "@Match Time who's in?" / "@Match Time kimler var?" -> squad
  "@Match Time list the players" / "@Match Time show me the squad" -> squad
  "@Match Time how many spots left?" / "@Match Time kaç kişiyiz?" -> count
  "@Match Time do we have enough?" -> count
  "@Match Time we're 9/14 right?" -> count, statedCount 9
  "@Match Time what's the list?" / "@Match Time liste ne?" -> squad
  "@Match Time who's on the bench?" / "@Match Time yedekte kim var?" -> bench
  "@Match Time anyone on the bench? show me the list" / "@Match Time yedekte kimse var mı? listeyi atar mısın" -> squad: the list shows the bench
  "@Match Time is Zair in?" / "@Match Time Zair geliyor mu?" -> person_status, personRef "Zair"
  "@Match Time anyone in the squad without a number?" -> phones
  "@Match Time what time is kickoff?" / "@Match Time maç kaçta?" -> fixture
  "@Match Time where are we playing?" / "@Match Time is the game still on?" -> fixture
  "@Match Time we're short, what are our options?" / "@Match Time eksiğiz, ne yapabiliriz?" -> options

How MatchTime works:
  "Bench? We do bench now?" / "yedek ne demek?" -> how_it_works, feature availability
  "@Match Time how are the teams picked?" / "@Match Time takımları nasıl kuruyorsun?" -> how_it_works, feature teams
  "@Match Time what can you do?" / "@Match Time neler yapabiliyorsun?" -> how_it_works

The club itself:
  "@Match Time who runs this group?" / "@Match Time grubun yöneticisi kim?" -> club
  "@Match Time who do we pay?" / "@Match Time ücreti kime ödüyoruz?" -> club
  "@Match Time how much do we pay each?" / "@Match Time kişi başı ne kadar?" -> club
  "@Match Time what time do the teams come out?" / "@Match Time takımlar saat kaçta çıkıyor?" -> club

Results:
  "@Match Time did we win on tuesday?" / "@Match Time salı kim kazandı?" -> score
  "@Match Time how did we get on last night" / "@Match Time skor ne oldu?" -> score
  "@Match Time what was the score last week" / "@Match Time geçen hafta skor kaç kaçtı?" -> score: one match
  "@Match Time give us the scores of the last 5 matches" / "@Match Time son 5 maçın skorları" -> score, listSize 5
  "@Match Time last 3 results" / "@Match Time son 3 maçın sonuçları" -> score, listSize 3
  "@Match Time results this season" / "@Match Time bu sezonun sonuçları" -> score, period season
  "@Match Time scores this month" / "@Match Time bu ayki skorlar" -> score, period this, periodUnit month
  "@Match Time results from the last 2 months" / "@Match Time son 2 ayın sonuçları" -> score, period last, periodCount 2, periodUnit month

After a match:
  "@Match Time who hasn't paid?" / "@Match Time kim ödemedi?" -> payments
  "@Match Time has everyone paid for last week?" -> payments
  "@Match Time who hasn't rated yet?" / "@Match Time kimler puan vermedi?" -> rating_progress
  "@Match Time who still needs to pick a MoM?" -> rating_progress
  "please do not forget to rate the players via the link from Matchtime DM'ed to you" -> other: it tells the players to rate
  "@Match Time can you remind everyone to rate" -> other: a reminder, not the tally

The asker's own numbers:
  "@Match Time my stats" / "@Match Time istatistiklerim" -> my_stats
  "@Match Time can I see my ratings" / "@Match Time puanlarımı görebilir miyim" -> my_stats
  "@Match Time wrapped" / "@Match Time how am I doing this season?" -> my_stats
  "@Match Time what are Wasim's stats" / "@Match Time Ali'nin istatistikleri ne" -> stats, personRef "Wasim" / "Ali"

Which table:
  "@Match Time please share the leaderboard of ratings, top 10" -> stats, ratings, listSize 10
  "@Match Time leaderboard" / "@Match Time sıralama" -> stats, ratings
  "@Match Time top 5 players" / "@Match Time en iyi 10" -> stats, ratings, listSize 5 / 10
  "@Match Time top 20" -> stats, ratings, listSize 20
  "@Match Time what's Sait's rating" -> stats, ratings, personRef "Sait"
  "@Match Time who's the worst player" / "@Match Time en kötü oyuncu kim" -> stats, ratings, listEnd bottom
  "@Match Time bottom 5 on elo" -> stats, elo, listSize 5, listEnd bottom
  "@Match Time most appearances" / "@Match Time en çok maça gelen kim" -> stats, appearances
  "@Match Time who's been most consistent" -> stats, appearances
  "@Match Time who's got the most MoMs" / "@Match Time en çok maçın adamı kim" -> stats, mom
  "@Match Time what's the elo table" -> stats, elo
  "@Match Time what is the team of the season?" / "@Match Time sezonun takımı ne" -> stats, team_of_season
  "@Match Time whose performance is improving most based on the last 3 matches?" -> stats, movers
  "@Match Time son maçlarda en çok kim yükseldi" -> stats, movers
  "@Match Time who is the most Mr. Reliable?" / "@Match Time en güvenilir oyuncu kim?" -> stats, mr_reliable
  "@Match Time who does Wasim play best with" / "@Match Time Idris'in kimyası nasıl" -> stats, chemistry, personRef "Wasim" / "Idris"
  "@Match Time who's my nemesis" -> stats, chemistry, personRef "me"
  "@Match Time who has the best win rate" -> stats, other

Which period:
  "@Match Time who has played most matches in the last 1 year?" / "@Match Time son 1 yılda en çok maç oynayan kim?" -> stats, appearances, period last, periodCount 1, periodUnit year
  "@Match Time top 5 ratings in the last month" / "@Match Time geçen ay en iyi 5" -> stats, ratings, listSize 5, period last, periodCount 1, periodUnit month
  "@Match Time most appearances this season" / "@Match Time bu sezon en çok maç oynayanlar" -> stats, appearances, period season
  "@Match Time who has the best rating this season" -> stats, ratings, period season
  "@Match Time all-time most MoMs" / "@Match Time tüm zamanların en çok maçın adamı kim" -> stats, mom, period all_time
  "@Match Time who played most this month" / "@Match Time bu ay en çok kim oynadı" -> stats, appearances, period this, periodUnit month`,

  teams: `You read ONE message about the two team line-ups (red and yellow) and report what it asks for. You never pick the teams. Above THE MESSAGE you may see recent chat, MatchTime's last post, NOW (the time at the club) and, for a WhatsApp reply, the message it quotes: context for who "him" or "them" are, never a field of their own.

  action       what has to change:
               "show" re-post the teams that exist, unchanged ("teams?", "show me the teams", "takımları göster")
               "generate" work the line-ups out again ("generate the teams", "regenerate", "make the teams", "shuffle them again", "come up with an alternative", "takımları kur", "yeniden kur")
               "rename" keep the SAME two line-ups under different names
               "swap" move named players between the existing teams and leave everyone else where they are
  includeRefs  people the message says to include ("generate the teams, Ibrahim is playing"), verbatim
  teamNames    the two names the message SUPPLIES, in order, or an empty array
  swaps        people the message puts on a NAMED side, with that side: "put David in Red" -> {"personRef":"David","team":"RED"}
  moves        people to move to the OTHER team from wherever they are now, when no side is named: "swap Ali and Can" -> ["Ali","Can"], "move Tom to the other team" -> ["Tom"], "Ali ile Can'ı değiştir" -> ["Ali","Can"], "Tom'u diğer takıma al" -> ["Tom"]
  pairings     people who must be on the SAME team as each other, one array per group ("put me and David on the same team" -> [["me","David"]])

If the line-ups have to be worked out again it is "generate", even when the message also asks for new names or says "again", "once more" or "instead"; a message that asks you to invent names while generating leaves teamNames empty. "rename" is only for the same line-ups under new names. Write every name as the message writes it; when the sender means themselves ("me", "I", "beni", "bana", "ben") write "me". Any field the message says nothing about is empty.`,

  score: `You read ONE message from a football group's WhatsApp chat about the result of the group's own match and report what it SAYS. You never decide which team is which, who won, who a player is, or what gets recorded: code does that.

RECENT CHAT, MATCHTIME'S LAST POST, NOW (the time at the club) and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line) are context only: never take a number, team or name from them. THE MESSAGE is the one you report on, with its sender. A reply that disputes the result it quotes ("no, it was 7-5 to yellow" under MatchTime's result) is a correction. The message replied to never supplies a word about the outcome: "7-4 yellows" replying to "which team won?" is still a team beside a number (secondTeam), not a winner.

WHAT YOU RETURN
hasScore
true when THE MESSAGE states the two numbers of a result; false when it has none ("yellows won", "wrong way round", "MoM Naim"), and first and second are then 0.
first, second
the two numbers of the FINAL result, in written order. In a story ("it was 6-6 then it turned to 9-6") the final one.
A TEAM REFERENCE is the team's name as written ("yellows", "Reds", "Sarılar"); "us" for the sender's side ("we", "biz", "kazandık"), "them" for the other. "" when not said. Never guess or work out a team.
firstTeam, secondTeam
a team written directly beside the first or second number with no word about the outcome.
winner
only when a word says so: "to" or "for" a team, "won", "wins", "beat", "kazandı", "yendi". "" otherwise and for a draw.
loser
only when a word says so: "lost", "got beaten", "kaybetti", "yenildi". "" otherwise.
momRef
the player named Man of the Match ("MoM", "man of the match", "POTM", "maçın adamı"), as written, or a bare name answering MatchTime's question who it was. "" otherwise; praise alone ("Naim was class") is "".
correction
true only when it says a result ALREADY given for this match was wrong ("no, it was...", "yanlış", "hayır ... olacak"). A first report is false.
swapped
true when it says the teams are the wrong way round ("other way round", "tam tersi"); correction is then true too.
otherGame
true when it is plainly about a different game ("last week we lost 9-2", "geçen ay 5-0 yenmiştik"); correction is then false.

EXAMPLES, English and Turkish
A word names the winner:
  "5-3 to Yellows" / "sarılar 5-3 kazandı" -> hasScore true, first 5, second 3, winner "Yellows" / "sarılar"
  "4-6 to Yellows" -> first 4, second 6, winner "Yellows"
  "it was 6-6 then suddenly it turned to 9-6 to yellows" -> first 9, second 6, winner "yellows"
A team beside a number:
  "Yellow 9 - 6 Red" -> first 9, second 6, firstTeam "Yellow", secondTeam "Red"
  "kırmızı 6 sarı 9" -> first 6, second 9, firstTeam "kırmızı", secondTeam "sarı"
  "Reds 3-5" -> first 3, second 5, firstTeam "Reds", winner ""
  "9-6 yellow" -> first 9, second 6, secondTeam "yellow"
The sender's side:
  "we won 5-3" / "5-3 kazandık" -> first 5, second 3, winner "us"
  "lost 3-5" / "3-5 kaybettik" -> first 3, second 5, loser "us"
  "reds beat us 7-2" -> first 7, second 2, winner "reds", loser "us"
No team or no scoreline:
  "10-7" / "7-7 berabere" -> hasScore true, the two numbers, every team field ""
  "yellows won" / "sarılar kazandı" -> hasScore false, winner "yellows" / "sarılar"
  "Yellow", the whole message, after MatchTime asked which team won -> hasScore false, winner "Yellow"
Man of the Match:
  "Yellow won 7-4, MoM Naim" / "sarı 7-4 kazandı, maçın adamı Naim" -> first 7, second 4, winner "Yellow" / "sarı", momRef "Naim"
  "Naim", after MatchTime asked who was Man of the Match -> hasScore false, momRef "Naim"
A correction or another game:
  "no Yellow 9 - 6 Red" / "yanlış, kırmızı 6 sarı 9" -> correction true, numbers and teams as above
  "wrong way round, yellows won" / "tam tersi, sarılar kazandı" -> hasScore false, correction true, swapped true, winner "yellows" / "sarılar"
  "last week we lost 9-2" -> first 9, second 2, loser "us", otherGame true`,

  admin: `You read ONE instruction to the bot and report what it says. You report the words; code decides what happens. Messages may be in English or Turkish. Above THE MESSAGE you may see recent chat, MatchTime's last post, NOW (the time at the club) and, for a WhatsApp reply, the message it quotes (the THEY ARE REPLYING TO line): context only.

THE ACTION, exactly one:
  "bulk_payment"  someone paid for several players: "Amir paid for 4 players", "Amir paid for Faris and Adam".
  "fee_waiver"    the sender gives named players a free place, so they owe NOTHING for a game ("Bilal washed the bibs, he's free this week", "Tom plays free tonight", "Ali bu hafta ödemesin"), or takes a free place back ("Bilal isn't free after all, he pays"). Free meaning ABLE to play ("I'm free Tuesday") is not this. Nor is a question or a discussion about it ("should Bilal play free?", "is he free?"): that is "other".
  "reminder"      the sender wants to be reminded, at a time.
  "recruit"       the sender asks the bot to CONTACT or INVITE players who are not registered yet: "message the lads from the last few games", "DM everyone who played recently and invite them", "ask the regulars if they can play", "we need more players, can you round some up". It is about people OUTSIDE the squad: asking to SHOW, LIST or COUNT the registered players is "other".
  "stats_blast"   the sender tells YOU to send every player their own stats or ratings link: "send everyone their stats", "DM the squad their ratings", "share the stats links with the lads".
  "other"         anything else.

THE FIELDS. Fill the ones for the action; every other field is "", 0, false or [].
  payerRef         bulk_payment: who paid, verbatim.
  count            bulk_payment: how many players they paid for.
  coveredRefs      the people the action is about, verbatim, one entry each: for bulk_payment the people paid for, if named; for fee_waiver the people the free place is given to or taken from. "he" or "him" is the person the message named, else the author of the message it replies to when the reply line names them; otherwise the words as written.
  undo             fee_waiver: true when the message TAKES a free place back ("Bilal isn't free after all", "no, Tom pays this week", "Ali ücretsiz değil, ödesin"); false when it gives one.
  matchDay         fee_waiver: the day the message names for the game, verbatim ("tonight", "last night", "next Friday", "cuma"); "" when it names none or only "this week".
  phrase           reminder: the time phrase EXACTLY as written ("on Monday", "tomorrow at 6"). Never a date.
  note             reminder: WHAT to remind them about, in their own words ("bring the bibs"); "" when it names nothing.
  lookbackMatches  recruit: how many recent matches to draw players from ("the last 5 matches" -> 5, "the last couple of games" -> 2); 0 when no number is named.

WHO DOES THE WORK. "stats_blast" tells YOU to send something to every player. If the sender tells the PLAYERS to do something (rate each other, check a link, click the one they already have, not forget something), it is "other", however many times it says stats, ratings, players, DM or everyone. A message can be ABOUT the stats links without asking you to send them.

EXAMPLES
  "@Match Time send everyone their stats"                                      -> stats_blast
  "@Match Time can you DM the squad their ratings links"                       -> stats_blast
  "lads don't forget to rate the players via the link MatchTime DM'ed you"     -> other, it instructs the players
  "the more accurate the ratings, the more balanced the teams"                 -> other, it is a remark
  "did everyone get their stats link?"                                         -> other, it is a question
  "@Match Time what are my stats"                                              -> other, one person asking about themselves
  "Bilal washed the bibs, he's free this week"                                 -> fee_waiver, coveredRefs ["Bilal"], undo false, matchDay ""
  "Ali ve Can cuma günü ödemesin"                                              -> fee_waiver, coveredRefs ["Ali", "Can"], undo false, matchDay "cuma günü"
  "scrap that, Tom isn't free, he pays"                                        -> fee_waiver, coveredRefs ["Tom"], undo true`,
};

// ── Schemas ────────────────────────────────────────────────────────────

export const ATTENDANCE_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string", enum: ["sender", "other"] },
          personRef: { type: "string" },
          personNamed: { type: "boolean" },
          polarity: { type: "string", enum: ["in", "out", "bench"] },
          contingent: { type: "boolean" },
          conditionOn: { type: "string", enum: ["squad", "self", "none"] },
          tense: { type: "string", enum: ["present", "future", "past", "hypothetical"] },
          basis: { type: "string", enum: ["decision", "availability"] },
          reported: { type: "boolean" },
          // "" rather than a nullable string, the same convention
          // `affirmation` and `statedCount` already use here: the API
          // rejects a nullable type outright, at request time.
          replaces: { type: "string" },
          confidence: { type: "number" },
        },
        required: [
          "subject",
          "personRef",
          "personNamed",
          "polarity",
          "contingent",
          "conditionOn",
          "tense",
          "basis",
          "reported",
          "replaces",
          "confidence",
        ],
        additionalProperties: false,
      },
    },
    // "none" rather than a nullable enum: the API rejects
    // `{type: ["string","null"], enum: ["yes","no",null]}` outright
    // ("Enum value 'yes' does not match declared type"), and it rejects
    // it at request time, which the dry run surfaced as a loud
    // degradation on the very first live case. The parser maps "none"
    // back to null so the fact type stays honest.
    affirmation: { type: "string", enum: ["yes", "no", "none"] },
    sideRequests: { type: "array", items: { type: "string", enum: ["recruit", "chase"] } },
  },
  required: ["claims", "affirmation", "sideRequests"],
  additionalProperties: false,
} as const;

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      enum: [
        "squad",
        "bench",
        "count",
        "person_status",
        "phones",
        "fixture",
        "payments",
        "score",
        "rating_progress",
        "my_stats",
        "stats",
        "options",
        "how_it_works",
        "club",
        "other",
      ],
    },
    personRef: { type: "string" },
    statedCount: { type: "number" },
    // "none" and -1 are the stand-ins for null, as for `statedCount`:
    // the API rejects a nullable type at request time.
    table: {
      type: "string",
      enum: ["ratings", "appearances", "mom", "elo", "team_of_season", "movers", "chemistry", "mr_reliable", "other", "none"],
    },
    listSize: { type: "number" },
    listEnd: { type: "string", enum: ["top", "bottom"] },
    // The period (2026-09-23). Three flat fields rather than an object,
    // with "none" and -1 as the null stand-ins, like the fields above.
    period: { type: "string", enum: ["none", "last", "this", "season", "all_time"] },
    periodCount: { type: "number" },
    periodUnit: { type: "string", enum: ["none", "day", "week", "month", "year"] },
    // 2026-10-16: for `how_it_works` only, the help topic it asks about.
    feature: { type: "string", enum: [...HELP_FEATURES, "none"] },
  },
  required: ["topic", "personRef", "statedCount", "table", "listSize", "listEnd", "period", "periodCount", "periodUnit", "feature"],
  additionalProperties: false,
} as const;

const TEAMS_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["show", "generate", "rename", "swap"] },
    includeRefs: { type: "array", items: { type: "string" } },
    teamNames: { type: "array", items: { type: "string" } },
    swaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          personRef: { type: "string" },
          team: { type: "string", enum: ["RED", "YELLOW"] },
        },
        required: ["personRef", "team"],
        additionalProperties: false,
      },
    },
    // An array OF arrays: one group per "these people together". A flat
    // list could not tell "A with B, C with D" from "A, B, C and D all
    // together", and those are different line-ups.
    pairings: { type: "array", items: { type: "array", items: { type: "string" } } },
    // 2026-10-16: "swap Ali and Can" / "move Tom" name no side, so they
    // cannot be `swaps` (absolute). Each person here goes to the other
    // team from where they stand now.
    moves: { type: "array", items: { type: "string" } },
  },
  required: ["action", "includeRefs", "teamNames", "swaps", "moves", "pairings"],
  additionalProperties: false,
} as const;

// Team-aware since 2026-10-07 (see `ScoreFacts`). The four team fields
// are VERBATIM text, or "us" / "them", or "": "" is the schema's
// stand-in for "not said", as elsewhere in this file, because the API
// rejects a nullable type at request time. `hasScore` is how the model
// says "this message has no numbers" (a nullable number is rejected the
// same way): the parser turns `false` into nulls, so a numberless
// message can never arrive as 0-0. No field admits a decision: which
// side is Red, and whether a lone team name is enough, are code's
// (`score-teams.ts`).
const SCORE_SCHEMA = {
  type: "object",
  properties: {
    hasScore: { type: "boolean" },
    first: { type: "number" },
    second: { type: "number" },
    firstTeam: { type: "string" },
    secondTeam: { type: "string" },
    winner: { type: "string" },
    loser: { type: "string" },
    // 2026-10-18: the Man of the Match the message names, verbatim, or "".
    // Read only where the organisers pick it (mom-chooser.ts).
    momRef: { type: "string" },
    correction: { type: "boolean" },
    swapped: { type: "boolean" },
    otherGame: { type: "boolean" },
  },
  required: [
    "hasScore",
    "first",
    "second",
    "firstTeam",
    "secondTeam",
    "winner",
    "loser",
    "momRef",
    "correction",
    "swapped",
    "otherGame",
  ],
  additionalProperties: false,
} as const;

const ADMIN_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "other"],
    },
    payerRef: { type: "string" },
    count: { type: "number" },
    coveredRefs: { type: "array", items: { type: "string" } },
    // fee_waiver (2026-10-16): taking a free place back, and the day named.
    undo: { type: "boolean" },
    matchDay: { type: "string" },
    phrase: { type: "string" },
    note: { type: "string" },
    // 0 is the schema's stand-in for null, the same convention
    // `statedCount` uses. A nullable number is rejected by the API.
    lookbackMatches: { type: "number" },
  },
  required: ["action", "payerRef", "count", "coveredRefs", "undo", "matchDay", "phrase", "note", "lookbackMatches"],
  additionalProperties: false,
} as const;

const SCHEMAS: Record<Exclude<ExtractorKind, "none">, Record<string, unknown>> = {
  attendance: ATTENDANCE_SCHEMA as unknown as Record<string, unknown>,
  question: QUESTION_SCHEMA as unknown as Record<string, unknown>,
  teams: TEAMS_SCHEMA as unknown as Record<string, unknown>,
  score: SCORE_SCHEMA as unknown as Record<string, unknown>,
  admin: ADMIN_SCHEMA as unknown as Record<string, unknown>,
};

/** Exposed so a test can assert that no schema admits a decision. */
export function factsSchemaFor(route: Route): Record<string, unknown> | null {
  const kind = extractorFor(route);
  return kind === "none" ? null : SCHEMAS[kind];
}

// ── Parsing ────────────────────────────────────────────────────────────

const POLARITIES: Polarity[] = ["in", "out", "bench"];
const TENSES: Tense[] = ["present", "future", "past", "hypothetical"];
const CONDITIONS: ConditionOn[] = ["squad", "self", "none"];
const BASES: ClaimBasis[] = ["decision", "availability"];
const TOPICS: QuestionTopic[] = [
  "squad",
  "bench",
  "count",
  "person_status",
  "phones",
  "fixture",
  "payments",
  "score",
  // 2026-09-11, and it is a regex coming OUT of the product rather than
  // a topic going in. See `lib/rating-progress-answer.ts`.
  "rating_progress",
  // 2026-09-17, the same kind of change: `STATS_REQUEST` came out of
  // `analyze/route.ts`. See `QuestionTopic`.
  "my_stats",
  "stats",
  "options",
  // 2026-10-16: "Bench? We do bench now?" (FNF). See `QuestionFacts.feature`.
  "how_it_works",
  // 2026-10-16: "MatchTime who are the admins?" (FNF HQ). See `QuestionTopic`.
  "club",
  "other",
];

const STATS_TABLES: StatsTable[] = [
  "ratings",
  "appearances",
  "mom",
  "elo",
  "team_of_season",
  "movers",
  "chemistry",
  "mr_reliable",
  "other",
];

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clamp01(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(0, Math.min(1, n));
}

export interface ParsedFacts {
  facts: Facts;
  degradations: Degradation[];
}

/**
 * Structured output guarantees SHAPE, never SEMANTICS (§11.3). So every
 * field is re-validated here, a drifted enum value DROPS its claim
 * rather than being coerced into a plausible neighbour, and anything the
 * model smuggles in beyond the schema is discarded by construction —
 * the parser builds a new object rather than spreading the input.
 */
export function parseFacts(
  kind: Exclude<ExtractorKind, "none">,
  text: string,
  messageId: string,
): ParsedFacts {
  const degradations: Degradation[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = extractJson(text) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) throw new Error("not an object");
  } catch (err) {
    return {
      facts: { kind: "none" },
      degradations: [
        degradation(
          "extractor",
          messageId,
          `${kind} extractor output could not be parsed: ${(err as Error).message}`,
        ),
      ],
    };
  }

  const bad = (detail: string) => degradations.push(degradation("extractor", messageId, detail));

  switch (kind) {
    case "attendance": {
      const claims: Claim[] = [];
      const rows = Array.isArray(raw.claims) ? (raw.claims as Array<Record<string, unknown>>) : [];
      for (const r of rows) {
        const polarity = str(r.polarity).toLowerCase() as Polarity;
        if (!POLARITIES.includes(polarity)) {
          bad(`dropped a claim with an unknown polarity "${str(r.polarity)}"`);
          continue;
        }
        const tenseRaw = str(r.tense).toLowerCase() as Tense;
        const tense = TENSES.includes(tenseRaw) ? tenseRaw : "present";
        if (!TENSES.includes(tenseRaw) && str(r.tense)) {
          bad(`unknown tense "${str(r.tense)}" treated as present`);
        }
        const condRaw = str(r.conditionOn).toLowerCase() as ConditionOn;
        const conditionOn = CONDITIONS.includes(condRaw) ? condRaw : "none";
        // `decision` on drift, matching what `tense` and `conditionOn`
        // already do: the fallback is the value that preserves today's
        // behaviour, so an unreadable field can never silently start
        // SUPPRESSING writes the pipeline makes now. Loud when the model
        // sent something, silent when it sent nothing (an older stub).
        const basisRaw = str(r.basis).toLowerCase() as ClaimBasis;
        const basis = BASES.includes(basisRaw) ? basisRaw : "decision";
        if (!BASES.includes(basisRaw) && str(r.basis)) {
          bad(`unknown basis "${str(r.basis)}" treated as decision`);
        }
        const subject = str(r.subject).toLowerCase() === "other" ? "other" : "sender";
        claims.push({
          subject,
          personRef: str(r.personRef),
          personNamed: bool(r.personNamed),
          polarity,
          contingent: bool(r.contingent),
          conditionOn,
          tense,
          basis,
          reported: bool(r.reported),
          // Only ever meaningful on an arrival. A `replaces` on an out
          // or a bench claim is model drift and is dropped here rather
          // than travelling on to be misread: `replacement.ts` reads it
          // only from an `in` claim, and this keeps the FACTS honest for
          // everything else that reads a claim (the `none`-bucket
          // shadow, the dry run, the operator log).
          replaces: polarity === "in" ? str(r.replaces).trim() : "",
          confidence: clamp01(r.confidence),
        });
      }
      // "none" is the schema's stand-in for null (see ATTENDANCE_SCHEMA).
      const affRaw = str(raw.affirmation).toLowerCase();
      const affirmation = affRaw === "yes" ? "yes" : affRaw === "no" ? "no" : null;
      const sideRequests: SideRequest[] = (
        Array.isArray(raw.sideRequests) ? raw.sideRequests : []
      )
        .map((s) => str(s).toLowerCase())
        .filter((s): s is SideRequest => s === "recruit" || s === "chase");
      const facts: AttendanceFacts = { kind: "attendance", claims, affirmation, sideRequests };
      return { facts, degradations };
    }

    case "question": {
      const topicRaw = str(raw.topic).toLowerCase() as QuestionTopic;
      const topic = TOPICS.includes(topicRaw) ? topicRaw : "other";
      if (!TOPICS.includes(topicRaw)) bad(`unknown question topic "${str(raw.topic)}"`);
      const facts: QuestionFacts = {
        kind: "question",
        topic,
        // "" and -1 are the schema's stand-ins for null.
        personRef: typeof raw.personRef === "string" && raw.personRef ? raw.personRef : null,
        statedCount:
          typeof raw.statedCount === "number" &&
          Number.isFinite(raw.statedCount) &&
          raw.statedCount >= 0
            ? raw.statedCount
            : null,
      };
      // The table, the size and the end: for `stats` only, so every other
      // topic's facts keep exactly the shape they had (2026-09-23).
      if (topic === "stats") {
        const tableRaw = str(raw.table).toLowerCase();
        let table: StatsTable | null = null;
        if (STATS_TABLES.includes(tableRaw as StatsTable)) table = tableRaw as StatsTable;
        else if (tableRaw && tableRaw !== "none") bad(`unknown stats table "${str(raw.table)}"; answered as no table`);
        const size =
          typeof raw.listSize === "number" && Number.isFinite(raw.listSize) && raw.listSize >= 1
            ? Math.floor(raw.listSize)
            : null;
        facts.table = table;
        facts.listSize = size;
        facts.listEnd = str(raw.listEnd).toLowerCase() === "bottom" ? "bottom" : "top";
        // The period (2026-09-23): turned into a date by code, later, in
        // `stats-period.ts`. An unreadable one is dropped loudly and the
        // question is answered for the whole record, which it then says.
        const period = parsePeriodFields(raw);
        if (period.problem) bad(period.problem);
        facts.period = period.period;
      } else if (topic === "score") {
        // HOW MANY RESULTS and WHICH PERIOD (2026-09-29), in the same two
        // fields a stats question uses. Both null is the last match,
        // today's answer. No table: a result is not a stats table.
        facts.listSize =
          typeof raw.listSize === "number" && Number.isFinite(raw.listSize) && raw.listSize >= 1
            ? Math.floor(raw.listSize)
            : null;
        const period = parsePeriodFields(raw);
        if (period.problem) bad(period.problem);
        facts.period = period.period;
      } else if (topic === "how_it_works") {
        // Which help topic, or null for MatchTime as a whole (the help
        // menu). An unreadable one is read as the menu, loudly.
        const featureRaw = str(raw.feature).toLowerCase();
        const feature = HELP_FEATURES.find((f) => f === featureRaw) ?? null;
        if (!feature && featureRaw && featureRaw !== "none") bad(`unknown feature "${str(raw.feature)}"; answered with the help menu`);
        facts.feature = feature;
      }
      return { facts, degradations };
    }

    case "teams": {
      const action = str(raw.action).toLowerCase();
      if (!["show", "generate", "rename", "swap"].includes(action)) {
        bad(`unknown team action "${str(raw.action)}"`);
        return { facts: { kind: "none" }, degradations };
      }
      const names = Array.isArray(raw.teamNames) ? raw.teamNames.map(str).filter(Boolean) : [];
      const facts: TeamFacts = {
        kind: "teams",
        action: action as TeamFacts["action"],
        includeRefs: Array.isArray(raw.includeRefs) ? raw.includeRefs.map(str).filter(Boolean) : [],
        teamNames: names.length === 2 ? [names[0], names[1]] : null,
        swaps: (Array.isArray(raw.swaps) ? (raw.swaps as Array<Record<string, unknown>>) : [])
          .map((s) => ({
            personRef: str(s.personRef),
            team: str(s.team).toUpperCase() === "YELLOW" ? ("YELLOW" as const) : ("RED" as const),
          }))
          .filter((s) => s.personRef),
        moves: (Array.isArray(raw.moves) ? (raw.moves as unknown[]) : []).map((m) => str(m).trim()).filter(Boolean),
        // A "pairing" of one person constrains nothing, so a stray
        // single-element group is dropped here rather than pinning
        // somebody to an arbitrary colour on the strength of it.
        pairings: (Array.isArray(raw.pairings) ? (raw.pairings as unknown[]) : [])
          .map((g) => (Array.isArray(g) ? g.map(str).filter(Boolean) : []))
          .filter((g) => g.length >= 2),
      };
      return { facts, degradations };
    }

    case "score": {
      // NO NUMBERS IS NOT 0-0 (review of PR #214, item 3). The model
      // says so with `hasScore: false`, and the facts carry nulls. An
      // older stub with no `hasScore` at all is read by what it sent:
      // two numbers are a score, anything else is none.
      const numeric = typeof raw.first === "number" && typeof raw.second === "number";
      const hasScore = raw.hasScore === false ? false : numeric;
      if (raw.hasScore !== false && !numeric) {
        bad(`score extractor returned non-numeric values`);
        return { facts: { kind: "none" }, degradations };
      }
      // The team fields are optional on the FACTS: "" (not said) is
      // dropped, so "the message named no team" is one shape whether
      // the model sent "" or an older stub sent nothing. Clipped, since
      // they are free text on their way to a trace row.
      const team = (v: unknown): string | undefined => {
        const t = str(v).trim().slice(0, 60);
        return t ? t : undefined;
      };
      const facts: ScoreFacts = {
        kind: "score",
        first: hasScore ? (raw.first as number) : null,
        second: hasScore ? (raw.second as number) : null,
      };
      const firstTeam = team(raw.firstTeam);
      const secondTeam = team(raw.secondTeam);
      const winner = team(raw.winner);
      const loser = team(raw.loser);
      // A position needs a number to be beside.
      if (hasScore && firstTeam) facts.firstTeam = firstTeam;
      if (hasScore && secondTeam) facts.secondTeam = secondTeam;
      if (winner) facts.winner = winner;
      if (loser) facts.loser = loser;
      const momRef = team(raw.momRef);
      if (momRef) facts.momRef = momRef;
      if (raw.correction === true) facts.correction = true;
      if (raw.swapped === true) facts.swapped = true;
      if (raw.otherGame === true) facts.otherGame = true;
      return { facts, degradations };
    }

    case "admin": {
      const action = str(raw.action).toLowerCase();
      if (!["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "other"].includes(action)) {
        bad(`unknown admin action "${str(raw.action)}"`);
        return { facts: { kind: "none" }, degradations };
      }
      const facts: AdminFacts = {
        kind: "admin",
        action: action as AdminFacts["action"],
        ...(typeof raw.payerRef === "string" && raw.payerRef ? { payerRef: raw.payerRef } : {}),
        ...(typeof raw.count === "number" && raw.count > 0 ? { count: raw.count } : {}),
        ...(Array.isArray(raw.coveredRefs)
          ? { coveredRefs: raw.coveredRefs.map(str).filter(Boolean) }
          : {}),
        ...(action === "fee_waiver" && raw.undo === true ? { undo: true } : {}),
        ...(action === "fee_waiver" && typeof raw.matchDay === "string" && raw.matchDay.trim() ? { matchDay: raw.matchDay.trim() } : {}),
        ...(typeof raw.phrase === "string" && raw.phrase ? { phrase: raw.phrase } : {}),
        ...(typeof raw.note === "string" && raw.note ? { note: raw.note } : {}),
        // 0 (the schema's stand-in for "not stated") and anything
        // non-finite are DROPPED rather than carried through as a
        // number, so the engine's `lookbackMatches === undefined` means
        // exactly one thing: use the shipped default of 5.
        ...(typeof raw.lookbackMatches === "number" &&
        Number.isFinite(raw.lookbackMatches) &&
        raw.lookbackMatches > 0
          ? { lookbackMatches: raw.lookbackMatches }
          : {}),
      };
      return { facts, degradations };
    }
  }
}

// ── The call ───────────────────────────────────────────────────────────

export interface ExtractorMessage {
  id: string;
  body: string;
  authorName: string | null;
  tagged: boolean;
  /** Recent chat, for pronoun and reference resolution ONLY. */
  history: Array<{ author: string | null; body: string }>;
  /** MatchTime's own last post, so a bare "Confirmed" has a referent. */
  lastBotPost: string | null;
  /**
   * The message this one is a WhatsApp reply to, whoever wrote it
   * (quoted-reply context, slice S4, 2026-10-20), already narrowed by the
   * caller to the match it acts on (`quoteForMatch`). Shown, with the
   * time now, in the block every reply reader shares
   * (`renderGroupReplyContext`). Absent: the NOW line alone.
   */
  reply?: ContextMessage | null;
  /** The time the NOW line states (club time). Defaults to now. */
  now?: Date;
}

export interface ExtractionResult {
  facts: Facts;
  degradations: Degradation[];
  usage?: { costUsd: number | null; ms: number; inputTokens: number; outputTokens: number };
  /**
   * The call was REFUSED by the club's daily AI cap (`ai-budget.ts`) and
   * never made. Not a failure of the model and not retried: a second
   * attempt would be refused the same way. The attendance engine reads
   * this to fall back to the floor's deterministic facts.
   */
  budgetRefused?: boolean;
}

export async function extractForRoute(
  model: PipelineModel,
  route: Route,
  msg: ExtractorMessage,
): Promise<ExtractionResult> {
  const kind = extractorFor(route);
  if (kind === "none") return { facts: { kind: "none" }, degradations: [] };

  // ── THE MESSAGE IS NOT ITS OWN CONTEXT (2026-09-09) ────────────────
  //
  // The Pi records every inbound message into its 15-message history
  // buffer BEFORE it buffers it for the flush (`index.ts`:
  // `recordHistory(...)` then `enqueueForAnalysis(...)`), and reads the
  // whole buffer at flush time. So the `history` that arrives here
  // ALREADY CONTAINS the messages in this batch, and every message was
  // being shown its own text under "RECENT CHAT" and then again under
  // "THE MESSAGE".
  //
  // That duplication is what made a bare "In" non-deterministic. A model
  // shown the same line twice reads the second as an ECHO of the first —
  // an acknowledgement of something already said rather than a fresh
  // claim — and returns `claims: []` with `affirmation: "yes"`.
  // MEASURED, `scripts/measure-claimless.ts`, 20 runs each: with the
  // message present in its own recent chat, "In" comes back claimless
  // 14 of 20 and "in" 11 of 20; with the same context and the echo
  // removed, both are 0 of 20. That is the 2026-09-09 incident, in which
  // Abid and Mojib typed "In" and were silently discarded while Wasim
  // and habib typed "In" one second later and were registered.
  //
  // The block's own header already says what it is for — "context only,
  // never extract from it". The message under extraction is not context;
  // it is the subject. Matching on author AND body, so a DIFFERENT
  // person who happened to type the same word keeps their line: their
  // message is real context, and it is the sender's own duplicate that
  // does the damage.
  const recent = msg.history.filter(
    (h) => !(h.body === msg.body && (h.author ?? null) === (msg.authorName ?? null)),
  );
  const context: string[] = [];
  if (recent.length > 0) {
    context.push("RECENT CHAT (context only, never extract from it):");
    for (const h of recent.slice(-8)) {
      context.push(`  ${h.author ?? "(unknown)"}: ${h.body}`);
    }
  }
  // A reply to MatchTime's last post shows it once, as the post replied to.
  const quotesLastPost =
    !!msg.reply && !msg.reply.author && !!msg.lastBotPost && (msg.reply.text ?? "").trim() === msg.lastBotPost.trim();
  if (msg.lastBotPost && !quotesLastPost) {
    context.push(`MATCHTIME'S LAST POST: ${msg.lastBotPost}`);
  }
  context.push(renderGroupReplyContext({ now: msg.now ?? new Date(), quoted: msg.reply ?? null }));
  context.push("");
  context.push(
    `THE MESSAGE (from ${msg.authorName ?? "(unknown)"}${msg.tagged ? ", who tagged the bot" : ""}):`,
  );
  context.push(msg.body);

  const req: ModelRequest = {
    model: EXTRACTOR_MODEL,
    system: EXTRACTOR_PROMPTS[kind],
    user: context.join("\n"),
    maxTokens: EXTRACTOR_MAX_TOKENS,
    schema: SCHEMAS[kind],
    label: `extractor:${kind}`,
    // THINKING OFF. Measured, not assumed — see `llm.ts`'s
    // `ModelRequest.thinking` and `__tests__/thinking-off.test.ts`. On a
    // self-contradictory message, adaptive thinking spent the whole
    // token budget and returned no JSON at all, 5 runs of 5, against the
    // live club. An extractor that deliberates would be the
    // mega-prompt's failure mode reappearing one layer down — the prompt
    // is deleted (§10 step 8), the failure mode is not — and §6.2's
    // contract is "FACTS about the text only".
    thinking: "off",
  };

  // ── ONE RETRY, AND ONLY WHERE SILENCE COSTS A SLOT (§10 step 8) ────
  //
  // `llm.ts` already raises the SDK's retries from 2 to 4, and its
  // comment says why and what it was relying on:
  //
  //   "§10 step 6 puts these calls on the WRITE path, and the failure
  //    mode of a call that gives up is a player who said IN not being in
  //    the squad… It is the FIRST of two defences:
  //    `attendance-engine-batch.ts` hands a message whose extraction
  //    still failed back to the ANALYZER rather than letting it go
  //    silent."
  //
  // Step 8 deletes the second defence. An extraction that fails now
  // means MatchTime says nothing, for a message the router already
  // decided was attendance-shaped.
  //
  // The SDK's four retries cover the transport class — 408, 409, 429,
  // 5xx — with exponential backoff. They do NOT cover the other half of
  // the failure surface: a response the strict schema rejects, or one
  // `parseFacts` cannot read. That half is non-deterministic in exactly
  // the way a fresh call fixes, and it is the half `TruncatedResponseError`
  // and `extractJson` throw on.
  //
  // So: ONE application-level retry, and only on the four routes that
  // end in an attendance write. §11.1 prices the asymmetry — "a false
  // positive costs one extractor call (~$0.002); a false negative costs
  // a player their slot" — and that asymmetry simply does not hold for
  // a question or a score, where a miss costs one answer and §13's rule
  // applies instead: "a missed add is recoverable in one message."
  // Retrying those would spend latency on the write path's worst minute
  // to buy nothing.
  //
  // NOT TWO retries. Past the second attempt the cause is far more
  // likely the message than the weather, and the honest answer is the
  // operator note rather than a third bill and another two seconds of a
  // ten-minute flush budget.
  const attempts = RETRYING_ROUTES.includes(route) ? 2 : 1;
  const failures: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await model.complete(req);
      const parsed = parseFacts(kind, resp.text, msg.id);
      return {
        ...parsed,
        usage: {
          costUsd: resp.costUsd,
          ms: resp.ms,
          inputTokens: resp.usage.inputTokens + resp.usage.cacheReadTokens,
          outputTokens: resp.usage.outputTokens,
        },
      };
    } catch (err) {
      if (isAiBudgetExceeded(err)) {
        return {
          facts: { kind: "none" },
          degradations: [degradation("extractor", msg.id, `${kind} extractor not called: ${(err as Error).message}`)],
          budgetRefused: true,
        };
      }
      failures.push((err as Error).message);
    }
  }

  // §11.4: on extractor failure, fail CLOSED — but say so. Until step 8
  // the surface was the partial-response admin DM matching one of six
  // free-text `reasoning` prefixes; it is now `lib/operator-note.ts`,
  // which selects on the typed fact that nobody owned the message.
  //
  // The wording distinguishes one failure from two. They are different
  // signals about the same minute: once is a message the model found
  // odd, twice in a row is the model having a bad time, and an operator
  // reading a DM at 22:00 acts differently on each.
  return {
    facts: { kind: "none" },
    degradations: [
      degradation(
        "extractor",
        msg.id,
        failures.length > 1
          ? `${kind} extractor failed TWICE: ${failures.join(" | ")}`
          : `${kind} extractor failed: ${failures[0]}`,
      ),
    ],
  };
}

export function defaultExtractorModel(): PipelineModel {
  return anthropicModel();
}
