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
import { readFileSync } from "node:fs";

const MODEL = "claude-haiku-4-5";

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
export type DmIntent = "recruit_blast" | "rating_progress" | "other";

const VALID: ReadonlySet<string> = new Set<DmIntent>(["recruit_blast", "rating_progress", "other"]);

export interface DmIntentClassification {
  intent: DmIntent;
  confidence: number;
  reasoning: string;
}

/**
 * The prompt. Note the NEGATIVE examples: they are the real failure
 * shape, taken from the live group, and they are messages that are ABOUT
 * DMs, players and ratings without instructing MatchTime to do anything.
 * That distinction is the whole job, and it is the one a conjunction of
 * keywords structurally cannot make — every negative example below
 * satisfies the regex that used to sit here.
 */
export const DM_INTENT_SYSTEM_PROMPT = `You read ONE private WhatsApp message sent directly to a football club's bot, MatchTime, by a club admin. You decide whether it is one of exactly two INSTRUCTIONS the bot can carry out. You never carry it out and you never answer it.

Return ONE intent:

- "recruit_blast": the sender is telling you to CONTACT players who are not yet signed up for the next match, and invite them. Examples: "DM the lads from the last few games", "message everyone who played recently and invite them", "can you invite the regulars for tuesday", "we're short, round some players up", "ask the last few weeks' players if they can play".

- "rating_progress": the sender is asking HOW MANY people have submitted their ratings or Man-of-the-Match votes for the match just played, or WHO has not. Examples: "who hasn't rated yet?", "how many have rated so far?", "who still needs to pick a MoM?", "any ratings outstanding from tuesday?", "is everyone done rating".

- "other": EVERYTHING else.

THE ONE DISTINCTION THAT MATTERS. Ask who is being told to do the work. If the sender is telling the PLAYERS to do something, describing what players have said or done, reporting a fact, thanking you, complaining, or chatting, it is "other" — however many times the message says players, ratings, DM, message, everyone or squad. A message can be ABOUT DMs and ratings without being an instruction to you.

  "DM everyone who played in the last 5 matches and invite them"          -> recruit_blast
  "we need a couple more for tuesday, can you message the recent lads"    -> recruit_blast
  "who hasn't rated yet?"                                                 -> rating_progress
  "how many have picked a MoM so far"                                     -> rating_progress
  "please do not forget to rate the players via the link from Matchtime DM'ed to you. the more accurate ratings, the more balanced teams next time" -> other, it instructs the PLAYERS
  "Najib is out. We need one more player."                                -> other, it reports a drop; it does not tell you to message anybody
  "the lads keep asking me to DM them the ratings link"                   -> other, it describes a situation
  "cheers for sorting the players out last week"                          -> other, it is thanks
  "I haven't rated yet, I'll do it tonight"                               -> other, it is about the sender
  "who's playing tuesday?"                                                -> other, that is the squad list, not the ratings
  "can you remind everyone to rate the players"                           -> other, that asks for a REMINDER, not for the rating tally
  "IN"                                                                    -> other
  "sorry can't make tuesday"                                              -> other

If you are not at least 80% sure, return "other" with a low confidence. A wrong "recruit_blast" sends an unwanted private message to up to 27 real people; a wrong "other" costs the admin one re-typed message.

Output STRICT JSON only — no markdown, no fences:

{
  "intent": "recruit_blast" | "rating_progress" | "other",
  "confidence": <number 0..1>,
  "reasoning": "<short justification, max 100 chars>"
}`;

/** The model, as one function, so a test can drive the real parse
 *  without a key and the e2e suite can drive the real route without one
 *  either. */
export type DmIntentCall = (system: string, user: string) => Promise<string>;

export interface DmIntentContext {
  senderName?: string | null;
  clubName?: string | null;
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
 * for real behind it. `e2e/helpers/live-llm.ts` refuses a "live" run
 * that can still see this seam.
 */
export const DM_INTENT_STUB_FILE_ENV = "MT_TEST_DM_INTENT_STUB_FILE";

/** What separates the context lines from the message itself. */
const MESSAGE_HEADER = "THE DM:";

/** Everything after the header, trimmed — so a multi-line message is
 *  matched whole rather than by its last line. */
export function dmBodyOf(user: string): string {
  const i = user.indexOf(`${MESSAGE_HEADER}\n`);
  return (i === -1 ? user : user.slice(i + MESSAGE_HEADER.length + 1)).trim();
}

interface DmIntentStub {
  /** Trimmed message body → the intent the model would have returned. */
  bodies?: Record<string, string>;
  /** Bodies whose model CALL throws, the way an overloaded API does. */
  fail?: string[];
}

function stubCall(env: NodeJS.ProcessEnv): DmIntentCall | null {
  const file = env[DM_INTENT_STUB_FILE_ENV];
  if (!file) return null;
  return async (_system, user) => {
    let cfg: DmIntentStub = {};
    try {
      cfg = JSON.parse(readFileSync(file, "utf8")) as DmIntentStub;
    } catch {
      // Missing or garbled → behave as if there were no mapping at all,
      // which is the direction that cannot invent a mass DM.
      cfg = {};
    }
    const body = dmBodyOf(user);
    if ((cfg.fail ?? []).includes(body)) throw new Error("dm-intent stub: forced failure");
    const intent = cfg.bodies?.[body] ?? "other";
    return JSON.stringify({ intent, confidence: 1, reasoning: "dm-intent stub" });
  };
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
  const user = [
    context.clubName ? `Club: ${context.clubName}` : null,
    context.senderName ? `Admin: ${context.senderName}` : null,
    // A HEADER, not a last line, and `extractors.ts` does the same for
    // the same reason: a real WhatsApp message is routinely several
    // lines long — the 2026-09-01 incident message is — so a stub seam
    // that read only the last line would silently classify a fragment.
    `${MESSAGE_HEADER}\n${text.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    return parseDmIntent(await fn(DM_INTENT_SYSTEM_PROMPT, user));
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
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content: user }],
    });
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
  return { intent, confidence, reasoning };
}

// ── THE ACTION, WITH EVERY PIECE OF I/O INJECTED ─────────────────────

export interface DmAdminIntentDeps {
  /**
   * The model's read of the DM. Injected rather than called inline so a
   * test can prove that a THROW here fires nothing, and so the admin
   * lookup below can decide whether it is worth asking at all.
   */
  classify: () => Promise<DmIntent>;
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
  /** The ONE private reply, to the admin who asked. */
  reply: (args: { orgId: string; text: string }) => Promise<void>;
}

export type DmAdminIntentResult =
  | { handled: "recruit-dm"; orgId: string; invited: number }
  | { handled: "rating-progress-dm"; orgId: string }
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
  if (orgIds.length === 0) return NOT_HANDLED;

  let intent: DmIntent;
  try {
    intent = await deps.classify();
  } catch (err) {
    // FAIL CLOSED, in the second place it can matter. `classifyDmIntent`
    // already swallows its own failures; this covers a caller that wires
    // in something else. Nothing is DM'd on a classifier that threw.
    console.error("[dm-intent] classification threw; treating the DM as `other`:", err);
    return NOT_HANDLED;
  }

  if (intent === "recruit_blast") {
    const orgId = await deps.orgWithUpcomingMatch(orgIds);
    // No upcoming match → nothing to recruit for. Falls through rather
    // than answering, exactly as the deleted handler did.
    if (!orgId) return NOT_HANDLED;
    const r = await deps.invite(orgId);
    await deps.reply({ orgId, text: r.reply });
    return { handled: "recruit-dm", orgId, invited: r.invited };
  }

  if (intent === "rating_progress") {
    const orgId = await deps.orgWithCompletedMatch(orgIds);
    if (!orgId) return NOT_HANDLED;
    await deps.reply({ orgId, text: await deps.ratingProgress(orgId) });
    return { handled: "rating-progress-dm", orgId };
  }

  return NOT_HANDLED;
}
