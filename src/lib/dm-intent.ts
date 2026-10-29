/**
 * THE DM SURFACE'S ADMIN INTENT — one model call, two deterministic
 * actions, and the last two conjunction regexes in the product deleted.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACED (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `api/whatsapp/dm-reply/route.ts` asked two regex questions of every
 * DM that reached its fifth and sixth handlers:
 *
 *   looksLikeRecruitRequest         an explicit recruit verb ADJACENT to
 *                                   a people noun, OR a shortage phrase
 *                                   — with `inviteRecentPlayers` behind
 *                                   it, a mass DM to 13-27 real people
 *   looksLikeRatingProgressRequest  (a rating word) AND (a progress
 *                                   word), scattered anywhere in a body
 *
 * The first one's own doc comment said what it was: "⚠️ DEPRECATED FOR
 * GROUP MESSAGES — one caller left… It is the next conversion, not this
 * PR's." This is that conversion. It was deleted from the GROUP path on
 * 2026-09-01 after it matched the second sentence of "Najib is out. We
 * need one more player.", threw the rest away, and MatchTime told the
 * owner his squad was full one line after he said a player was out.
 *
 * The second is the same shape in front of a group post, and
 * `analyze/route.ts` called it "the WIDEST trigger of the six peels".
 *
 * And on 2026-09-10 the third member of the family — three keyword tests
 * ANDed — read an owner's reminder to his players as a bulk-DM command
 * and queued 69 personal stats-link DMs. `recruit-lookback.ts` names the
 * stake: "the bot runs on an UNOFFICIAL WhatsApp client; a mass DM risks
 * the account being banned, which takes the whole product down."
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE SPLIT IS `stats-blast.ts`'s, EXACTLY
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The model can only ever say "this looks like the ask". Every GATE and
 * the ACTION stay in code:
 *
 *   the model   classifies the whole DM into a closed enum, once
 *   the code    checks the sender is an admin (or superadmin) of an org
 *               — BEFORE the model is asked at all — then finds the
 *               upcoming / completed match, then performs the action and
 *               composes the reply from what actually happened
 *
 * There is no verdict pipeline on this route, so this module IS the
 * seam: `runDmAdminIntent` takes every piece of I/O as an injected
 * callback, which is what lets a unit test prove "nobody was DM'd"
 * without a database.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE IT SITS IN THE FALL-THROUGH, AND WHY THAT IS NOT A COST
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `dm-reply/route.ts`'s handler order is by SPECIFICITY and it is
 * unchanged: a bench-slot offer, a DM subscription command, a tentative
 * follow-up and a collector fee reply all run FIRST, because each knows
 * which question is being answered. This lands exactly where the two
 * regexes did — fifth — and the roster survey, the cold self-attendance
 * fallback and scoped Q&A still run after it.
 *
 * THE MODEL CALL IS NOT PAID FOR ON EVERY DM. `adminOrgIds` runs first
 * and is the dominant filter: a club has one or two admins and dozens of
 * players, and the overwhelming majority of DMs MatchTime receives are
 * players answering a prompt. A non-admin's DM costs one indexed
 * Membership query and reaches the classifier never. For the handful
 * that are from an admin, one Haiku call on a short body is roughly
 * £0.001 — the same price `classifyRosterReply` and
 * `classifyMatchAvailability` already pay on this very route, for the
 * same reason: these players write naturally and never type keywords.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * IT FAILS CLOSED, AND IT IS MEANT TO BE OBVIOUS THAT IT DOES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `other` is the value of EVERY failure: no API key, a thrown call, an
 * unparseable body, an intent outside the enum, a confidence below the
 * floor. `other` does nothing and DMs nobody. There is no path through
 * this file on which a broken model call produces a blast, and
 * `__tests__/dm-intent.test.ts` asserts that twice over.
 */
import Anthropic from "@anthropic-ai/sdk";
import { guardedAnthropicCall, systemBlock } from "@/lib/pipeline/llm";
import { bodyUnderHeader, dmClassifierStubCall } from "./dm-classifier-stub";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "./models";
import { noReplyContext, renderReplyContext, type ReplyContext } from "./reply-context";
import { introCategoriesToSend, type IntroCategory } from "./owner-intro-rules";

const MODEL = HAIKU_MODEL;

/**
 * Below this the model is not sure enough to DM 13-27 people, or to
 * read the club's ratings out in a reply.
 *
 * ONE number for both intents, deliberately. The recruit blast is the
 * dangerous one and sets the bar; making `rating_progress` cheaper to
 * trigger would buy one extra answered question at the cost of a second
 * threshold nobody would remember to re-argue. `match-availability-
 * classifier.ts` uses 0.75 for a single player's attendance; this is a
 * mass DM, so it is higher.
 */
export const DM_INTENT_MIN_CONFIDENCE = 0.8;

/** The closed enum. Anything else the model returns becomes `other`. */
export type DmIntent = "recruit_blast" | "partner_ask" | "rating_progress" | "intro_messages" | "other";

const VALID: ReadonlySet<string> = new Set<DmIntent>(["recruit_blast", "partner_ask", "rating_progress", "intro_messages", "other"]);

export interface DmIntentClassification {
  intent: DmIntent;
  confidence: number;
  reasoning: string;
  /** For `intro_messages` (2026-10-29): the category numbers the model
   *  listed, numbers only. Which are sent is the code's call
   *  (`introCategoriesToSend`, owner-intro.ts). Absent otherwise. */
  intro?: number[];
}

/**
 * The prompt. Note the NEGATIVE examples: they are the real failure
 * shape, taken from the live group, and they are messages that are ABOUT
 * DMs, players and ratings without instructing MatchTime to do anything.
 * That distinction is the whole job, and it is the one a conjunction of
 * keywords structurally cannot make — every negative example below
 * satisfies the regex that used to sit here.
 *
 * REWRITTEN WHOLE on 2026-10-20 (quoted-reply context, slice S3). The
 * model was shown the admin's name and the message only, so a follow-up
 * ("who's left?" after MatchTime's rating update) had nothing to be read
 * against, and an admin's "done 👍" to the rating request he got as a
 * player had no request beside it. The user turn now carries the shared
 * chat-context block (`reply-context.ts`). English and Turkish examples
 * side by side; each intent defined once; the "who does the work" rule
 * stated once.
 *
 * REWRITTEN WHOLE again on 2026-10-29 for a fourth instruction,
 * `intro_messages`: the platform owner asking for his ready-made intro
 * messages, with the categories he picked in "intro". The model reads the
 * words for anyone; only the code knows who the owner is
 * (`runDmAdminIntent`, `isOwner`), so nobody else gets them.
 */
export const DM_INTENT_SYSTEM_PROMPT = `A club admin sent MatchTime, their football club's WhatsApp bot, the private message under "THE DM". Above it you get the club, its partner clubs when it has any, the admin, the time now, and what MatchTime said to them: the message they swipe-replied to, or else MatchTime's recent messages to them, each with when it was sent and what it was about.

Is the message one of the four instructions MatchTime can carry out? You never carry it out and never answer it. Pick one:
- "recruit_blast": they tell MatchTime to CONTACT the club's own players who are not signed up for the next match and invite them.
- "partner_ask": they tell MatchTime to ask ANOTHER club, a partner club or the other groups whether anyone can play, whether a club is named or not.
- "rating_progress": they ask HOW MANY have sent their ratings or Man of the Match votes for the match just played, or WHO has not.
- "intro_messages": they ask MatchTime to send THEM its ready-made introduction messages, the ones they paste into other WhatsApp groups to introduce MatchTime. There are three: 1 for football groups that do not know MatchTime, 2 for groups that are not about football (inviting people to the player pool), 3 for clubs already using MatchTime (its new features). "intro" lists the ones they picked, by number or by description; when they want all of them, or pick none, it is [].
- "other": everything else.

Who is told to do the work decides it. Telling the PLAYERS to do something, describing what players said or did, reporting a fact (a drop-out, a shortage), talking about another club, thanking, complaining or chatting is "other", however often the message says players, ratings, DM, message, everyone, squad, intro or a club's name. Asking MatchTime to REMIND players is not asking for the rating tally, and asking it to post or say something to the group is not asking for the intro messages.

Read the message against what MatchTime said to them: the message they swipe-replied to, or else the newest recent one. A short follow-up such as "who's left?" or "and the MoM?" answering MatchTime's rating update is "rating_progress". An admin plays too, so a bare answer ("done", "ok", "👍") to a message MatchTime sent them as a player (a pay link, a request to rate teammates, a match invite) is about themselves: "other". A message that is itself one of the four instructions stays one, whatever it replies to.

Examples (English | Turkish):
recruit_blast: "DM everyone who played in the last 5 matches and invite them" | "son 5 maçta oynayan herkese yaz, davet et"; "we need a couple more for tuesday, can you message the recent lads" | "salıya iki kişi eksik, son gelenlere mesaj atar mısın"; "we're short, round some players up" | "eksiğimiz var, birkaç oyuncu topla"; "ask the last few weeks' players if they can play" | "son haftalarda oynayanlara gelebilirler mi diye sor"
partner_ask: "ask Sutton if anyone can play tonight" | "Sutton'a sor bakalım oynayan var mı"; "can you ask the partner clubs for a player" | "partner kulüplere sorar mısın, bir oyuncu lazım"; "try the other groups for one more" | "diğer gruplara sor, oynayacak biri var mı"
rating_progress: "who hasn't rated yet?" | "kim daha puan vermedi?"; "how many have picked a MoM so far" | "kaç kişi maçın adamını seçti"; "is everyone done rating" | "herkes puanladı mı"; "any ratings outstanding from tuesday?" | "salı maçından eksik puan var mı?"
intro_messages: "send me the category 1 intro message" | "kategori 1 tanıtım mesajını gönder" (intro [1]); "intro for football groups that don't know MatchTime" | "MatchTime'ı bilmeyen futbol grupları için tanıtım" (intro [1]); "the player pool invite for my running group" | "koşu grubum için oyuncu havuzu daveti" (intro [2]); "the new features message for clubs on MatchTime" | "kategori 3 tanıtım mesajını gönder" (intro [3]); "send me all the intro messages" | "tüm tanıtım mesajlarını gönder" (intro [])
other: "please do not forget to rate the players via the link from Matchtime DM'ed to you. the more accurate ratings, the more balanced teams next time" (it tells the players); "Najib is out. We need one more player." | "Ahmet yok. Bir kişi lazım." (it reports a drop); "the lads keep asking me to DM them the ratings link" (it describes a situation); "Sutton were great last week" | "Sutton geçen hafta çok iyi oynadı" (talk about another club); "cheers for sorting the players out last week" | "geçen hafta oyuncuları ayarladığın için sağ ol"; "I haven't rated yet, I'll do it tonight" | "ben daha puanlamadım, akşam yaparım"; "who's playing tuesday?" | "salı kimler var?" (the squad, not the ratings); "can you remind everyone to rate the players" | "herkese puan vermeyi hatırlat" (a reminder); "I shared the intro in my work group" | "tanıtımı iş grubunda paylaştım" (it reports); "introduce yourself to the group" | "gruba kendini tanıt" (a post to the group); "IN" | "varım"; "sorry can't make tuesday" | "salı gelemiyorum"; "done 👍" answering a request to rate teammates

If you are not at least 80% sure, choose "other". A wrong "recruit_blast" sends an unwanted private message to up to 27 real people; a wrong "partner_ask" troubles another club's organisers; a wrong "other" costs the admin one re-typed message.

Output STRICT JSON only, no markdown, no fences:
{"intent": "recruit_blast" | "partner_ask" | "rating_progress" | "intro_messages" | "other", "intro": [<1, 2 or 3>, ...], "confidence": <number 0..1>, "reasoning": "<max 100 chars>"}
"intro" is [] for every intent but "intro_messages".`;

/** The model, as one function, so a test can drive the real parse
 *  without a key and the e2e suite can drive the real route without one
 *  either. */
export type DmIntentCall = (system: string, user: string) => Promise<string>;

export interface DmIntentContext {
  senderName?: string | null;
  clubName?: string | null;
  /** The club's active partner clubs (slice S6), shown so "ask Sutton" is
   *  read against them. Absent or empty: no line, as before. */
  partnerClubs?: string[] | null;
  /** The chat context (`loadDmReplyContext`): the time now, and the
   *  message they swipe-replied to or MatchTime's recent DMs to them.
   *  Absent: the time now, nothing known. */
  replyContext?: ReplyContext | null;
}

const OTHER = (reasoning: string): DmIntentClassification => ({
  intent: "other",
  confidence: 0,
  reasoning,
});

/**
 * TEST-ONLY seam, mirroring `MT_TEST_EXTRACTOR_STUB_FILE`
 * (`pipeline/extractor-stub.ts`). The DM route's admin path is a write
 * path — one branch of it DMs the whole recent squad — and a write path
 * that can only be exercised by spending money is a write path nobody
 * exercises.
 *
 * It stubs what ENTERS the system (what the model said), never what the
 * system concludes: every gate, the match lookup and the action all run
 * for real behind it. Since S3 it is the shared DM-classifier seam
 * (`dm-classifier-stub.ts`), which also records each user turn it is
 * asked about in `<file>.calls`. `e2e/helpers/live-llm.ts` refuses a
 * "live" run that can still see this seam.
 */
export const DM_INTENT_STUB_FILE_ENV = "MT_TEST_DM_INTENT_STUB_FILE";

/** What separates the context lines from the message itself. */
const MESSAGE_HEADER = "THE DM:";

/** Everything after the header, trimmed — so a multi-line message is
 *  matched whole rather than by its last line. */
export function dmBodyOf(user: string): string {
  return bodyUnderHeader(user, MESSAGE_HEADER);
}

function stubCall(env: NodeJS.ProcessEnv): DmIntentCall | null {
  // Missing or garbled file, or a body it does not map: `other`, the
  // direction that cannot invent a mass DM.
  return dmClassifierStubCall(env[DM_INTENT_STUB_FILE_ENV], {
    label: "dm-intent",
    header: MESSAGE_HEADER,
    // "intro_messages:1,3" carries the categories the model would list.
    answer: (label) => {
      const [intent, cats] = (label ?? "other").split(":");
      const intro = cats ? cats.split(",").map(Number) : [];
      return JSON.stringify({ intent, intro, confidence: 1, reasoning: "dm-intent stub" });
    },
  });
}

/** The user turn: club, admin, the chat context, then the message under a
 *  HEADER, not a last line, and `extractors.ts` does the same for the same
 *  reason: a real WhatsApp message is routinely several lines long (the
 *  2026-09-01 incident message is), so a stub seam that read only the last
 *  line would silently classify a fragment. */
export function buildDmIntentUserTurn(text: string, context: DmIntentContext = {}): string {
  return [
    context.clubName ? `Club: ${context.clubName}` : null,
    context.partnerClubs && context.partnerClubs.length > 0 ? `Partner clubs: ${context.partnerClubs.join(", ")}` : null,
    context.senderName ? `Admin: ${context.senderName}` : null,
    renderReplyContext(context.replyContext ?? noReplyContext()),
    `${MESSAGE_HEADER}\n${text.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Ask the model, once, what this DM is.
 *
 * EVERY failure returns `other`. That is not a convention, it is the
 * safety property: `other` is the value that DMs nobody.
 */
export async function classifyDmIntent(
  text: string,
  context: DmIntentContext = {},
  call?: DmIntentCall,
): Promise<DmIntentClassification> {
  if (!text || !text.trim()) return OTHER("empty message");
  const fn = call ?? stubCall(process.env) ?? liveCall();
  if (!fn) return OTHER("classifier unavailable");
  try {
    return parseDmIntent(await fn(DM_INTENT_SYSTEM_PROMPT, buildDmIntentUserTurn(text, context)));
  } catch (err) {
    // FAIL CLOSED. An overloaded API, a network blip, a revoked key —
    // all of them are "we did not understand this message", and the
    // thing MatchTime does with a message it did not understand is
    // nothing at all.
    console.error("[dm-intent] classifier call failed:", err);
    return OTHER("classifier error");
  }
}

/** The real call. Null when there is no key — which is `other`. */
function liveCall(): DmIntentCall | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    const anthropic = new Anthropic({ apiKey: key });
    const response = await guardedAnthropicCall("dm-intent", () =>
      anthropic.messages.create({
        model: MODEL,
        max_tokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
        ...HAIKU_THINKING,
        system: systemBlock(system),
        messages: [{ role: "user", content: user }],
      }),
    );
    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return block?.text ?? "";
  };
}

/** Exported for unit tests — the JSON contract is load-bearing. */
export function parseDmIntent(rawText: string): DmIntentClassification {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return OTHER("parse failed");
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return OTHER("parse failed");
    }
  }
  if (!parsed || typeof parsed !== "object") return OTHER("not an object");
  const obj = parsed as Record<string, unknown>;
  // RE-VALIDATED against the enum rather than trusted: structured output
  // guarantees shape, never semantics (§11.3).
  const intent =
    typeof obj.intent === "string" && VALID.has(obj.intent) ? (obj.intent as DmIntent) : "other";
  const confidence =
    typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";
  if (intent !== "other" && confidence < DM_INTENT_MIN_CONFIDENCE) {
    return { intent: "other", confidence, reasoning: `[low-confidence forced] ${reasoning}` };
  }
  if (intent === "intro_messages") {
    const intro = Array.isArray(obj.intro) ? obj.intro.filter((n): n is number => typeof n === "number" && Number.isInteger(n)) : [];
    return { intent, confidence, reasoning, intro };
  }
  return { intent, confidence, reasoning };
}

// ── THE ACTION, WITH EVERY PIECE OF I/O INJECTED ─────────────────────

export interface DmAdminIntentDeps {
  /**
   * The model's read of the DM. Injected rather than called inline so a
   * test can prove that a THROW here fires nothing, and so the admin
   * lookup below can decide whether it is worth asking at all.
   */
  classify: () => Promise<DmIntent | { intent: DmIntent; intro?: number[] }>;
  /**
   * Org ids where this sender may run an admin command — OWNER/ADMIN
   * membership, or superadmin. EMPTY MEANS NOT AN ADMIN, and it is
   * checked BEFORE the model is asked anything.
   */
  adminOrgIds: () => Promise<string[]>;
  /** The org, among those, with the soonest upcoming match. Null when
   *  there is nothing to recruit for. */
  orgWithUpcomingMatch: (orgIds: string[]) => Promise<string | null>;
  /** The org, among those, whose most recently played match is freshest.
   *  Null when the club has not played yet. */
  orgWithCompletedMatch: (orgIds: string[]) => Promise<string | null>;
  /** ⚠️ THE MASS DM — 13-27 people on a live club. */
  invite: (orgId: string) => Promise<{ reply: string; invited: number }>;
  /** The grounded read. Sends nothing to anybody. */
  ratingProgress: (orgId: string) => Promise<string>;
  /** Ask the club's partner clubs for a player (slice S6): the shared
   *  door, `askPartnersFromWords`. DMs nobody; returns the ONE reply. */
  askPartners: (orgId: string) => Promise<string>;
  /** The ONE private reply, to the admin who asked. */
  reply: (args: { orgId: string; text: string }) => Promise<void>;
  /** Is the sender the platform owner (the self-join approver)? Only he
   *  gets the intro messages, and he is asked about them even when he
   *  runs no club (2026-10-29). Deterministic, no model. */
  isOwner: () => Promise<boolean>;
  /** Send the owner his intro messages, these categories, EN then TR. */
  sendIntro: (categories: IntroCategory[]) => Promise<void>;
}

export type DmAdminIntentResult =
  | { handled: "recruit-dm"; orgId: string; invited: number }
  | { handled: "rating-progress-dm"; orgId: string }
  | { handled: "partner-ask-dm"; orgId: string }
  | { handled: "owner-intro-dm"; categories: IntroCategory[] }
  | { handled: null };

const NOT_HANDLED: DmAdminIntentResult = { handled: null };

/**
 * The DM admin path, as a pure function of seven callbacks.
 *
 * Order is the contract and it is the cheap, deterministic gate first:
 *
 *   1. IS THIS SENDER AN ADMIN ANYWHERE? One indexed query. No → return,
 *      and the model is never asked. This is what keeps the classifier
 *      off the 95% of DMs that are players answering prompts, and it is
 *      the same gate the two deleted regex handlers applied (they just
 *      applied it second, after the pattern).
 *   2. WHAT IS THIS MESSAGE? One model call, failing closed to `other`.
 *   3. IS THERE ANYTHING TO ACT ON? The upcoming match for a blast, the
 *      last completed one for a progress read. Both are database facts,
 *      neither is the model's to supply.
 *   4. DO IT, and say what happened.
 *
 * A `handled: null` means "not ours" and the caller falls through to the
 * roster survey, the cold self-attendance fallback and scoped Q&A —
 * exactly as an unmatched regex did.
 */
export async function runDmAdminIntent(deps: DmAdminIntentDeps): Promise<DmAdminIntentResult> {
  const orgIds = await deps.adminOrgIds();
  // The platform owner is asked even when he runs no club: his intro
  // messages are not a club's. Everybody else still needs a club.
  const owner = orgIds.length === 0 ? await deps.isOwner() : null;
  if (orgIds.length === 0 && !owner) return NOT_HANDLED;

  let intent: DmIntent;
  let intro: number[] | undefined;
  try {
    const read = await deps.classify();
    intent = typeof read === "string" ? read : read.intent;
    intro = typeof read === "string" ? undefined : read.intro;
  } catch (err) {
    // FAIL CLOSED, in the second place it can matter. `classifyDmIntent`
    // already swallows its own failures; this covers a caller that wires
    // in something else. Nothing is DM'd on a classifier that threw.
    console.error("[dm-intent] classification threw; treating the DM as `other`:", err);
    return NOT_HANDLED;
  }

  if (intent === "intro_messages") {
    // Owner only, checked in code. Anybody else: not ours, and the DM
    // carries on to the normal handling, which knows nothing of this.
    if (!(owner ?? (await deps.isOwner()))) return NOT_HANDLED;
    const categories = introCategoriesToSend(intro);
    await deps.sendIntro(categories);
    return { handled: "owner-intro-dm", categories };
  }

  // Everything below acts on a club.
  if (orgIds.length === 0) return NOT_HANDLED;

  if (intent === "recruit_blast") {
    const orgId = await deps.orgWithUpcomingMatch(orgIds);
    // No upcoming match → nothing to recruit for. Falls through rather
    // than answering, exactly as the deleted handler did.
    if (!orgId) return NOT_HANDLED;
    const r = await deps.invite(orgId);
    await deps.reply({ orgId, text: r.reply });
    return { handled: "recruit-dm", orgId, invited: r.invited };
  }

  if (intent === "partner_ask") {
    // The club with the soonest match, else the admin's first club: with
    // no game to ask for, the shared door says so in one plain reply
    // rather than the DM going unanswered (slice S6).
    const orgId = (await deps.orgWithUpcomingMatch(orgIds)) ?? orgIds[0];
    await deps.reply({ orgId, text: await deps.askPartners(orgId) });
    return { handled: "partner-ask-dm", orgId };
  }

  if (intent === "rating_progress") {
    const orgId = await deps.orgWithCompletedMatch(orgIds);
    if (!orgId) return NOT_HANDLED;
    await deps.reply({ orgId, text: await deps.ratingProgress(orgId) });
    return { handled: "rating-progress-dm", orgId };
  }

  return NOT_HANDLED;
}
