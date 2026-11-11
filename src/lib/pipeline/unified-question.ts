/**
 * THE QUESTION EXTRACTOR UNDER UNIFIED_ANSWERS (Kemal, 2026-11-10).
 *
 * With the flag on, every question is answered by one model call over the
 * club's data (`unified-answer.ts`), so the extractor no longer sorts a
 * question into fifteen topics. It says only which of the four things code
 * still does itself is asked for, or "anything else":
 *
 *   list      the squad list post (people copy it)            -> topic squad
 *   help      the help menu or one topic's help               -> how_it_works
 *   my_stats  the asker's own stats link, by DM               -> my_stats
 *   other     everything else, answered by the unified answer -> other
 *
 * The answer reads these as the topics the engine already knows, so the
 * engine and the composer do not change. `personRef` stays: the unified
 * answer shows one player's pairings (chemistry), and who that player is is
 * read by the same who-is-who call as before, never by spelling.
 *
 * A NEW PROMPT, written whole (Kemal's rule, 2026-09-23); the old one in
 * `extractors.ts` is untouched and still runs with the flag off. Both are
 * saved under MDs/prompt-question-unified-{old,new}-2026-11-10.txt.
 * Rewritten whole again for round 2 (2026-11-11): "which squad list to
 * accept? mention it again" was read as help and "make the list" as
 * anything else, so `list` is now defined by wanting to SEE the list in any
 * words, and `help` by never being that (MDs/prompt-*-2026-11-11.txt).
 * Round 3 (2026-11-12): FNF HQ "what happens if 14 don't confirm?" was read
 * as help (the squad help was posted), because help was "how a part of it
 * works". Help is now how to USE MatchTime, and what happens at this club
 * is other, answered from its records (MDs/prompt-question-unified-2026-11-12.txt).
 */
import { HELP_BADGES, HELP_FEATURES, type HelpBadge, type HelpFeature, type QuestionFacts, type QuestionTopic } from "./types";

export const UNIFIED_QUESTION_PROMPT = `You read ONE message that asks MatchTime something, from a football club's WhatsApp group (the players' group or the organisers' own group), and say which of four kinds of request it is. You never answer it. The first three are fixed posts MatchTime sends as they are: the squad list, a help text, the asker's own stats link. Everything else is "other", and MatchTime answers it from the club's own records: its squad, its results, its stats and how this club is run.

THE MESSAGE is the one you read, with who sent it. Above it, as context only: RECENT CHAT, MATCHTIME'S LAST POST, NOW and, when it is a WhatsApp reply, a THEY ARE REPLYING TO line with the message it quotes. Use them to see what THE MESSAGE refers to ("list?" under a question about the bench); the kind is what THE MESSAGE itself asks for. Messages come in English and Turkish, often mixed, misspelt or unpunctuated.

kind, exactly one:
  list      they want to SEE the squad list for the upcoming match, in any words: asking for it, for it again, for the right or latest one, or telling MatchTime to post, send, share, show or make it. Asking for the list beside another question is still list. Anything narrower about the squad (how many, whether there is space, one person's place, who is on the bench, who is best rated on it) is other.
  help      how to use MatchTime: a bare "help", what MatchTime can do, how to do something with it (what to type, how to bring a friend, how to pay), whether a part is on here and how to switch it on or off, where a setting is, what a badge means. Never a question about what happens or will happen at this club (the squad not filling, a place opening, someone dropping out, a game in doubt): that is answered from the club's records, so it is other. Never a request to see today's names or numbers either: a message that wants to see the list is list, however it is worded.
  my_stats  the asker wants to see their OWN stats, ratings, form or season summary: "my stats", "my rating", "istatistiklerim". One number of theirs in a table ("where am I in the ratings?", "who's my nemesis?") is other.
  other     everything else: kickoff, venue, how many, space, one person's place, the bench, results, Man of the Match, ratings and tables, payments, who has rated, the admins, the fee, what happens at this club if something does or does not happen, a suggestion, something said in the chat, a follow-up or a correction to MatchTime's last reply, a question about MatchTime itself that is not how to use it, and any request to do something.

personRef
On other only: the one club member the message is about, as written, without a possessive or suffix ("Idris's" and "Idris'in" are "Idris"); "me" when it is about the asker's own numbers or pairings; "" when it names nobody, and on every other kind.

feature
On help only, the part of MatchTime it asks about; none on every other kind. The help menus name each part by one word after "help" ("help squad", "yardım kadro"), in brackets below, English then Turkish; on its own that word means that part.
  availability   the squad (squad, kadro): saying In, Out or maybe, how the squad list and changes to it work, the bench
  friend         bringing a friend (friend, arkadaş): the link a player forwards, how the friend joins, pulls out or pays
  teams          the two teams (teams, takımlar): how they are made, shown and changed
  find_players   finding players for an open place (players, oyuncu bulma): asking the group, DMing people, the organisers picking who fills a place
  graphics       the poster and team sheet pictures (graphics, görseller)
  mom            Man of the Match voting
  ratings        player ratings
  reminders      reminders
  payments       the match fee (payments, ödeme): how to pay, how it is collected, a free place, switching fee collection on
  schedule       the games themselves (game, maç): match days and times, moving or cancelling a game, its size or format, block bookings
  badges         the badges on the stats page and how to earn them
  partners       partner clubs that lend each other players: what they are, pairing up, asking them
  pool           the MatchTime player pool: nearby players asked when the club is short
  settings       the settings (settings, ayarlar): where a setting is, quiet hours, the fewest and most players
  none           MatchTime as a whole ("help", "what can you do?"), or a part not listed

badge
On feature badges only, the one badge it names: first-game (On the board), ten-games (Regular), ironman (Iron Man), first-mom (Man of the Match), mom-machine (MoM Machine), masterclass (Masterclass), reliable (Mr Reliable), above-field (Above the Curve). none otherwise.

EXAMPLES, English | Turkish, then the fields that are not empty.

The list:
  "@Match Time what's the list?" | "@Match Time liste ne?" -> list
  "@Match Time who's in?" | "@Match Time kimler var?" -> list
  "@Match Time make the list" | "@Match Time listeyi yap" -> list
  "@Match Time I'm confused which squad list is right, can you share it again?" | "@Match Time hangi liste doğru karıştı, tekrar atar mısın?" -> list
  "@Match Time anyone on the bench? send the list" | "@Match Time yedekte kimse var mı? listeyi atar mısın" -> list

Help:
  "@Match Time help" | "@Match Time yardım" -> help
  "@Match Time what can you do?" | "@Match Time neler yapabiliyorsun?" -> help
  "@Match Time help teams" | "@Match Time yardım takımlar" -> help, feature teams
  "Bench? We do bench now?" | "yedek ne demek?" -> help, feature availability
  "@Match Time how do I bring a friend?" | "@Match Time arkadaşımı nasıl getiririm?" -> help, feature friend
  "@Match Time how do we pay?" | "@Match Time ödemeyi nasıl yapıyoruz?" -> help, feature payments
  "@Match Time how do I get Mr Reliable?" | "@Match Time demir adam rozeti nasıl alınır?" -> help, feature badges, badge reliable | ironman

The asker's own stats:
  "@Match Time my stats" | "@Match Time istatistiklerim" -> my_stats
  "@Match Time what's my rating?" | "@Match Time puanım kaç?" -> my_stats

Everything else:
  "@Match Time how many spots left?" | "@Match Time kaç kişiyiz?" -> other
  "@Match Time what's the squad status?" | "@Match Time kadro durumu ne?" -> other
  "@Match Time what happens if we don't fill the squad?" | "@Match Time kadro dolmazsa ne olur?" -> other
  "@Match Time who's on the bench?" | "@Match Time yedekte kim var?" -> other
  "@Match Time who are the 4 best rated on the list?" | "@Match Time listedeki en yüksek puanlı 4 kişi kim?" -> other
  "@Match Time is Zair in?" | "@Match Time Zair geliyor mu?" -> other, personRef "Zair"
  "@Match Time what time is kickoff?" | "@Match Time maç kaçta?" -> other
  "@Match Time will we see you there?" | "@Match Time seni maçta görecek miyiz?" -> other
  "@Match Time who won Man of the Match last week?" | "@Match Time geçen haftanın maçın adamı kim?" -> other
  "@Match Time who does Wasim play best with?" | "@Match Time Idris'in kimyası nasıl?" -> other, personRef "Wasim" | "Idris"
  "@Match Time who's my nemesis?" | "@Match Time en zorlandığım rakip kim?" -> other, personRef "me"
  "@Match Time who hasn't paid?" | "@Match Time kim ödemedi?" -> other
  "@Match Time suggest the starting squad" | "@Match Time ilk kadroyu öner" -> other
  "@Match Time can you add Ali?" | "@Match Time Ali'yi ekler misin?" -> other, personRef "Ali"`;

export const UNIFIED_QUESTION_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["list", "help", "my_stats", "other"] },
    personRef: { type: "string" },
    feature: { type: "string", enum: [...HELP_FEATURES, "none"] },
    badge: { type: "string", enum: [...HELP_BADGES, "none"] },
  },
  required: ["kind", "personRef", "feature", "badge"],
  additionalProperties: false,
} as const;

const TOPIC_OF: Record<string, QuestionTopic> = {
  list: "squad",
  help: "how_it_works",
  my_stats: "my_stats",
  other: "other",
};

/**
 * PURE. The model's fields as the `QuestionFacts` the engine already reads.
 * An unknown kind is `other` (answered by the unified answer), loudly.
 */
export function parseUnifiedQuestion(raw: Record<string, unknown>): { facts: QuestionFacts; problems: string[] } {
  const problems: string[] = [];
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const kind = s(raw.kind).toLowerCase();
  const topic = TOPIC_OF[kind] ?? "other";
  if (!TOPIC_OF[kind]) problems.push(`unknown question kind "${s(raw.kind)}"; answered as anything else`);
  const facts: QuestionFacts = {
    kind: "question",
    topic,
    personRef: topic === "other" && s(raw.personRef).trim() ? s(raw.personRef).trim() : null,
    statedCount: null,
  };
  if (topic === "how_it_works") {
    const featureRaw = s(raw.feature).toLowerCase();
    const feature = (HELP_FEATURES as readonly string[]).includes(featureRaw) ? (featureRaw as HelpFeature) : null;
    if (!feature && featureRaw && featureRaw !== "none") problems.push(`unknown feature "${s(raw.feature)}"; answered with the help menu`);
    facts.feature = feature;
    if (feature === "badges") {
      const badgeRaw = s(raw.badge).toLowerCase();
      const badge = (HELP_BADGES as readonly string[]).includes(badgeRaw) ? (badgeRaw as HelpBadge) : null;
      if (!badge && badgeRaw && badgeRaw !== "none") problems.push(`unknown badge "${s(raw.badge)}"; answered with every badge`);
      facts.badge = badge;
    }
  }
  return { facts, problems };
}
