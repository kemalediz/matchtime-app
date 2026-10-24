/**
 * ANSWERING THE PARTNER-CLUB PAIRING NOTICE IN WHATSAPP (Kemal,
 * 2026-10-21: "whatsapp reply like pressing 1 or 2 should also do the
 * same job").
 *
 * When one club sends another a partner request (`requestPartnerships`,
 * partner discovery P3, 2026-10-22), the other club's organisers get a
 * notice ending "Reply *1* to accept or *2* to decline, or open <link>"
 * (the platform owner's older pairing notice ended the same way). An owner
 * or an admin answers it (D-2).
 *
 * THE PATTERN REUSED: the money collector's fee confirm, which is how
 * MatchTime already understands a reply to one of its own closed
 * questions (`fee-confirm.ts`, `payment-flow.ts` `handleCollectorFeeReply`,
 * `fee-confirm-reaction.ts`):
 *
 *   1. the question is TAGGED when it is queued: each DM copy of the notice
 *      carries `BotJob.aboutKey = pairingNoticeKey(pairing, club)`, as the
 *      fee question carries `<matchId>:fee-confirm`; in an admin group the
 *      notice is logged with that key as its `askRef`, as a partner ask's
 *      approval notice is (`partner-ask.ts` `askPartnerToApprove`);
 *   2. a swipe-reply finds the notice BY ITS WHATSAPP ID
 *      (`resolveQuotedBotMessage`, then the job's `aboutKey`), never by its
 *      words, so an owner of both clubs answers each notice alone;
 *   3. the model reads the reply AGAINST THE CHAT CONTEXT (`reply-context.ts`:
 *      the message they replied to, or MatchTime's recent DMs) and returns a
 *      closed enum; every failure is `neither`, which does nothing. Unlike
 *      the fee confirm there is NO word list in front of it: "1" and "2"
 *      mean something only because the notice says so, and the model is
 *      shown the notice (CLAUDE.md: never understand people by exact
 *      phrases);
 *   4. a ✅ or 👍 REACTION on the notice is the owner's yes, found by the
 *      reacted-to message's id, exactly as `fee-confirm-reaction.ts` does;
 *   5. the action is `actOnPartnership`, the one writer (owners and admins,
 *      compare-and-set), and its refusal is what the person hears.
 *
 * In an admin group the shared router and the safe-YES rule run first
 * (`admin-group-understand.ts`); this file's `answerPairingInHq` is the
 * owner it hands a pairing to, so the group, the DM and the reaction all
 * end in the same reading and the same writer.
 *
 * Logs carry ids only.
 */
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { db } from "./db";
import { e164Digits } from "./phone";
import { t } from "./i18n/t";
import { HAIKU_MODEL, HAIKU_SHORT_ANSWER_MAX_TOKENS, HAIKU_THINKING } from "./models";
import { bodyUnderHeader, dmClassifierStubCall } from "./dm-classifier-stub";
import { botJobIdOfKey } from "./dispatch-claim";
import { REPLY_PRIORITY } from "./dm-reply-priority";
import { withOrgAiBudget } from "./ai-budget";
import { isFeeConfirmYesEmoji } from "./fee-confirm-reaction";
import { DM_LOOKBACK_MS, loadDmReplyContext, noReplyContext, renderReplyContext, type QuotedBotMessage, type ReplyContext } from "./reply-context";
import { actOnPartnership, askTooPath, type ActResult } from "./club-partnership";
import { buildAdminLink } from "./admin-link";
import { appUrl } from "./app-url";
import { pairingNoticeKey, parsePairingNoticeKey, waitingForSide, type ClubRole } from "./club-partnership-rules";

// ── The reading ──────────────────────────────────────────────────────

export type PairingIntent = "accept" | "decline" | "neither";

/** The fee confirm's floor: below it a reply changes nothing. */
export const PAIRING_REPLY_MIN_CONFIDENCE = 0.8;

const VALID: ReadonlySet<string> = new Set<PairingIntent>(["accept", "decline", "neither"]);

/**
 * The prompt. One plain task: is this reply the club owner's answer to
 * the pairing question, and which way. The CONTEXT (the notice itself, or
 * MatchTime's recent messages) is what makes a bare "1" an acceptance;
 * the prompt explains that once and gives a few grouped examples.
 */
export function buildPairingReplySystemPrompt(): string {
  return `A football club's owner or organiser sent MatchTime, the club's WhatsApp bot, the private reply under "THEIR REPLY". MatchTime had told them it has paired their club with another club as partner clubs (when one is short of players, MatchTime can ask the other's group for one), and asked the club's owner to reply 1 (or yes) to accept the pairing, or 2 (or no) to decline it. Above the reply you get the pairing or pairings waiting for an answer, the time now, and what MatchTime said to them: the message they swipe-replied to, or else MatchTime's recent messages to them, each with when it was sent.

Is the reply a direct answer to that pairing question? Pick one:
- "accept": they accept the pairing. 1, yes, accept, ok, a thumbs up, or any plain go-ahead.
- "decline": they decline it. 2, no, decline, not interested, or any plain refusal.
- "neither": anything else. A question about it (what it means, who the other club is), a plan to decide later, thanks, chat, or an answer to a different message. A 👍, "ok" or "yes" inside a sentence about something else is not an answer, and the "no" in "no worries" is not a refusal.

Which message the reply answers: the one they swipe-replied to; otherwise the newest of MatchTime's recent messages, unless their words plainly answer the pairing question ("accept the partner club"). A bare number answers the pairing question only when that is the message it replies to, or the newest one. If none of MatchTime's messages is known, read the reply against the pairing question.

Examples (English | Turkish):
accept: "1" | "1"; "yes" | "evet"; "accept" | "kabul"; "yes, happy to pair with them" | "tamam, kabul ediyorum"; "go for it 👍" | "olur"
decline: "2" | "2"; "no" | "hayır"; "decline" | "reddet"; "no thanks, not for us" | "istemiyoruz, sağ ol"
neither: "what does this mean?" | "bu ne demek?"; "who are they?" | "onlar kim?"; "let me think about it" | "bir düşüneyim"; "no worries, thanks" | "sorun yok, teşekkürler"; "I'm in for Friday" | "cuma varım"; "1" when the newest message asked something else; "yes" answering a request to rate teammates

If you are not at least 80% sure, choose "neither". A wrong "accept" or "decline" changes the club's partner clubs without the owner meaning it; a wrong "neither" costs them one more message, the cheapest of the three.

Output STRICT JSON only, no markdown, no fences:
{"intent": "accept" | "decline" | "neither", "confidence": <number 0..1>, "reasoning": "<max 100 chars>"}`;
}

export const PAIRING_REPLY_SYSTEM_PROMPT = buildPairingReplySystemPrompt();

export type PairingReplyCall = (system: string, user: string) => Promise<string>;

export interface PairingReplyContext {
  /** The pairings waiting for this person's answer, as their club sees them. */
  pairings: Array<{ club: string; other: string }>;
  replyContext?: ReplyContext | null;
}

export interface PairingReplyClassification {
  intent: PairingIntent;
  confidence: number;
  reasoning: string;
}

const NEITHER = (reasoning: string): PairingReplyClassification => ({ intent: "neither", confidence: 0, reasoning });

/** Exported for unit tests: the JSON contract is load-bearing. */
export function parsePairingReplyIntent(rawText: string): PairingReplyClassification {
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return NEITHER("parse failed");
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return NEITHER("parse failed");
    }
  }
  if (!parsed || typeof parsed !== "object") return NEITHER("not an object");
  const obj = parsed as Record<string, unknown>;
  const intent = typeof obj.intent === "string" && VALID.has(obj.intent) ? (obj.intent as PairingIntent) : "neither";
  const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0;
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 200) : "";
  if (intent !== "neither" && confidence < PAIRING_REPLY_MIN_CONFIDENCE) {
    return { intent: "neither", confidence, reasoning: `[low-confidence forced] ${reasoning}` };
  }
  return { intent, confidence, reasoning };
}

const REPLY_HEADER = "THEIR REPLY:";

export function pairingReplyBodyOf(user: string): string {
  return bodyUnderHeader(user, REPLY_HEADER);
}

export function buildPairingReplyUserTurn(text: string, ctx: PairingReplyContext): string {
  const waiting = ctx.pairings.length
    ? ctx.pairings.map((p) => `- ${p.club} paired with ${p.other}`).join("\n")
    : "- (none known)";
  return [
    `Pairings waiting for the club owner's answer:\n${waiting}`,
    renderReplyContext(ctx.replyContext ?? noReplyContext()),
    `${REPLY_HEADER}\n${text.trim()}`,
  ].join("\n");
}

/** TEST-ONLY seam, like `MT_TEST_FEE_REPLY_STUB_FILE`: stubs what the model
 *  said, keyed by the reply; the gates, the write and the reply run for real. */
export const PAIRING_REPLY_STUB_FILE_ENV = "MT_TEST_PAIRING_REPLY_STUB_FILE";

function stubCall(env: NodeJS.ProcessEnv): PairingReplyCall | null {
  return dmClassifierStubCall(env[PAIRING_REPLY_STUB_FILE_ENV], {
    label: "pairing-reply",
    header: REPLY_HEADER,
    answer: (intent) => JSON.stringify({ intent: intent ?? "neither", confidence: 1, reasoning: "pairing-reply stub" }),
  });
}

function liveCall(): PairingReplyCall | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return async (system, user) => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { guardedAnthropicCall, systemBlock } = await import("./pipeline/llm");
    const anthropic = new Anthropic({ apiKey: key });
    const response = await guardedAnthropicCall("pairing-reply", () =>
      anthropic.messages.create({
        model: HAIKU_MODEL,
        max_tokens: HAIKU_SHORT_ANSWER_MAX_TOKENS,
        ...HAIKU_THINKING,
        system: systemBlock(system),
        messages: [{ role: "user", content: user }],
      }),
    );
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  };
}

/** `call`: undefined for the real (or stubbed) model, null to assert none. */
export async function classifyPairingReplyDetailed(
  text: string,
  ctx: PairingReplyContext,
  call?: PairingReplyCall | null,
): Promise<PairingReplyClassification> {
  if (!text || !text.trim()) return NEITHER("empty reply");
  const fn = call === undefined ? (stubCall(process.env) ?? liveCall()) : call;
  if (!fn) return NEITHER("classifier unavailable");
  try {
    return parsePairingReplyIntent(await fn(PAIRING_REPLY_SYSTEM_PROMPT, buildPairingReplyUserTurn(text, ctx)));
  } catch (err) {
    // FAIL CLOSED: a reply MatchTime did not understand changes nothing.
    console.error("[pairing-reply] classifier call failed:", err instanceof Error ? err.message : "failed");
    return NEITHER("classifier error");
  }
}

export async function classifyPairingReply(text: string, ctx: PairingReplyContext, call?: PairingReplyCall | null): Promise<PairingIntent> {
  return (await classifyPairingReplyDetailed(text, ctx, call)).intent;
}

// ── What the person hears ────────────────────────────────────────────

/** One pairing as one club's notice named it. */
export interface PairingNotice {
  partnershipId: string;
  /** The club the notice was about (whose owner answers). */
  orgId: string;
  club: string;
  other: string;
  lang: string | null;
}

export interface PairingAnswer {
  outcome: string;
  reply: string;
}

/** The line for `actOnPartnership`'s result, in the club's language.
 *  `askTooLink`: a request this club just accepted, whose asking club it
 *  cannot ask yet, gets the one-tap "ask them too" (D-1, P3). */
export function pairingReplyText(notice: PairingNotice, action: "accept" | "decline", result: ActResult, askTooLink?: string | null): string {
  const s = t(notice.lang);
  const names = { club: notice.club, other: notice.other };
  if (result.ok) {
    if (action === "decline") return s.pc_reply_declined(names);
    if (result.status === "active" && askTooLink) return s.pr_reply_accepted({ ...names, link: askTooLink });
    return result.status === "active" ? s.pc_reply_accepted_active(names) : s.pc_reply_accepted_waiting(names);
  }
  switch (result.refusal) {
    case "owner-only":
    case "admin-only":
      return s.pr_admin_only;
    case "already-accepted":
      return s.pc_reply_already_accepted(names);
    default:
      return s.pc_reply_not_waiting(names);
  }
}

function outcomeOf(action: "accept" | "decline", result: ActResult): string {
  return result.ok ? `pairing-${action === "accept" ? "accepted" : "declined"}` : `pairing-${result.refusal}`;
}

async function roleIn(userId: string, orgId: string): Promise<ClubRole> {
  const m = await db.membership.findFirst({ where: { userId, orgId, leftAt: null, ...ORDINARY_MEMBER_WHERE }, select: { role: true } });
  return m?.role === "OWNER" || m?.role === "ADMIN" ? m.role : "PLAYER";
}

/**
 * Accept or decline through the one writer. The role is the person's own
 * in that club: an owner or an admin answers (D-2), anyone else is
 * refused. A compare-and-set that lost to a concurrent acceptance is tried
 * once more on what it now reads. Accepting by reply keeps the request's
 * default per-ask choice, "post without asking" (plan 3.2).
 *
 * A request this club just accepted, whose asking club it cannot ask yet,
 * gets the one-tap "ask them too" link (D-1): the person's own signed-in
 * link in a DM, the plain page in the admin group (`audience`).
 */
export async function answerPairing(
  notice: PairingNotice,
  userId: string,
  action: "accept" | "decline",
  now: Date = new Date(),
  audience: "dm" | "group" = "dm",
): Promise<PairingAnswer> {
  const role = await roleIn(userId, notice.orgId);
  const act = () => actOnPartnership({ partnershipId: notice.partnershipId, orgId: notice.orgId, userId, role, action, now });
  let result = await act();
  if (!result.ok && result.refusal === "changed") result = await act();
  console.log(`[pairing-reply] pairing ${notice.partnershipId} for ${notice.orgId}: ${action} by ${userId}: ${outcomeOf(action, result)}`);
  const askToo = action === "accept" && result.ok && result.status === "active" ? await askTooLinkFor(notice, userId, audience) : null;
  return { outcome: outcomeOf(action, result), reply: pairingReplyText(notice, action, result, askToo) };
}

/** The "ask them too" link, or null when this club is not the partner side
 *  of a request, or already may ask (or has asked) the other club. Never
 *  throws: the answer goes out without the link instead. */
async function askTooLinkFor(notice: PairingNotice, userId: string, audience: "dm" | "group"): Promise<string | null> {
  try {
    const p = await db.clubPartnership.findUnique({
      where: { id: notice.partnershipId },
      select: { askerOrgId: true, partnerOrgId: true, origin: true },
    });
    if (!p || p.origin !== "request" || p.partnerOrgId !== notice.orgId) return null;
    const reverse = await db.clubPartnership.findFirst({
      where: { askerOrgId: notice.orgId, partnerOrgId: p.askerOrgId, status: { not: "ended" } },
      select: { id: true },
    });
    if (reverse) return null;
    const path = askTooPath(notice.partnershipId);
    return audience === "group" ? appUrl(path) : await buildAdminLink({ userId, orgId: notice.orgId, nextPath: path });
  } catch (err) {
    console.error(`[pairing-reply] pairing ${notice.partnershipId}: no ask-too link: ${(err as Error)?.name ?? "error"}`);
    return null;
  }
}

function whichText(notices: PairingNotice[]): string {
  const s = t(notices[0]?.lang ?? null);
  return s.pc_reply_which({ pairings: notices.map((n) => s.pc_reply_which_item({ club: n.club, other: n.other })).join("; ") });
}

// ── A DM reply ───────────────────────────────────────────────────────

export interface PairingDmDeps {
  /** The pairing notice a resolved quote is (by the quoted job's
   *  `aboutKey`), whatever state its pairing is in now; null when the
   *  quote is another of MatchTime's messages. */
  quotedNotice: (quoted: QuotedBotMessage) => Promise<PairingNotice | null>;
  /** The pairings still waiting for a club whose notice was DMed to this
   *  person. */
  waitingNotices: () => Promise<PairingNotice[]>;
  /** The model, given the pairings in question and the quote (or null). */
  classify: (notices: PairingNotice[], quoted: QuotedBotMessage | null) => Promise<PairingIntent>;
  act: (notice: PairingNotice, action: "accept" | "decline") => Promise<PairingAnswer>;
}

export interface PairingDmResult {
  handled: "pairing-reply" | "pairing-which";
  outcome: string;
  reply: string;
  /** The club the reply is queued under. */
  orgId: string;
}

/**
 * Null when the DM is not an answer to a pairing notice: the route carries
 * on exactly as before. Costs one read (and no model) for anybody with no
 * pairing notice waiting.
 */
export async function runPairingReplyDm(input: { quoted: QuotedBotMessage | null }, deps: PairingDmDeps): Promise<PairingDmResult | null> {
  const quoted = input.quoted;
  if (quoted?.key) {
    // A swipe-reply to one of MatchTime's DMs we can name: it is about
    // that message and nothing else.
    const notice = await deps.quotedNotice(quoted);
    if (!notice) return null;
    const intent = await deps.classify([notice], quoted);
    if (intent === "neither") return null;
    const r = await deps.act(notice, intent);
    return { handled: "pairing-reply", ...r, orgId: notice.orgId };
  }

  const waiting = await deps.waitingNotices();
  if (waiting.length === 0) return null;
  const intent = await deps.classify(waiting, quoted ?? null);
  if (intent === "neither") return null;
  if (waiting.length > 1) {
    // Two notices waiting (one owner of both clubs): never guess which.
    return { handled: "pairing-which", outcome: "pairing-which", reply: whichText(waiting), orgId: waiting[0].orgId };
  }
  const r = await deps.act(waiting[0], intent);
  return { handled: "pairing-reply", ...r, orgId: waiting[0].orgId };
}

/** One notice, loaded: its pairing and the two clubs' names. */
async function loadNotice(partnershipId: string, orgId: string): Promise<(PairingNotice & { waiting: boolean }) | null> {
  const p = await db.clubPartnership.findUnique({
    where: { id: partnershipId },
    include: { askerOrg: { select: { name: true, language: true } }, partnerOrg: { select: { name: true, language: true } } },
  });
  if (!p) return null;
  const asker = p.askerOrgId === orgId;
  if (!asker && p.partnerOrgId !== orgId) return null;
  const mine = asker ? p.askerOrg : p.partnerOrg;
  const theirs = asker ? p.partnerOrg : p.askerOrg;
  return { partnershipId: p.id, orgId, club: mine.name, other: theirs.name, lang: mine.language, waiting: waitingForSide(p, orgId) };
}

const strip = (n: PairingNotice & { waiting: boolean }): PairingNotice => ({
  partnershipId: n.partnershipId,
  orgId: n.orgId,
  club: n.club,
  other: n.other,
  lang: n.lang,
});

/** The database wiring for `runPairingReplyDm`. Never throws: a failed
 *  read is logged and the DM carries on as if it were not about a pairing. */
export async function handlePairingReplyDm(input: {
  userId: string;
  text: string;
  quoted: QuotedBotMessage | null;
  phone: string | null;
  now?: Date;
}): Promise<PairingDmResult | null> {
  try {
    return await pairingReplyDmFromDb(input);
  } catch (err) {
    console.error(`[pairing-reply] DM from ${input.userId} not read:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}

function pairingReplyDmFromDb(input: {
  userId: string;
  text: string;
  quoted: QuotedBotMessage | null;
  /** Where DMs to them are queued: digits, no "+". */
  phone: string | null;
  now?: Date;
}): Promise<PairingDmResult | null> {
  const now = input.now ?? new Date();
  return runPairingReplyDm(
    { quoted: input.quoted },
    {
      quotedNotice: async (quoted) => {
        const jobId = quoted.key ? botJobIdOfKey(quoted.key) : null;
        if (!jobId) return null;
        const job = await db.botJob.findUnique({ where: { id: jobId }, select: { aboutKey: true } });
        const key = parsePairingNoticeKey(job?.aboutKey);
        if (!key) return null;
        const n = await loadNotice(key.partnershipId, key.orgId);
        return n ? strip(n) : null;
      },
      waitingNotices: async () => {
        if (!input.phone) return [];
        const jobs = await db.botJob.findMany({
          where: {
            kind: "dm",
            phone: input.phone,
            aboutKey: { startsWith: "pairing:" },
            sentAt: { not: null },
            createdAt: { gte: new Date(now.getTime() - DM_LOOKBACK_MS) },
          },
          orderBy: { createdAt: "asc" },
          select: { aboutKey: true },
        });
        const keys = [...new Set(jobs.map((j) => j.aboutKey).filter((k): k is string => !!k))];
        const out: PairingNotice[] = [];
        for (const k of keys) {
          const key = parsePairingNoticeKey(k);
          const n = key ? await loadNotice(key.partnershipId, key.orgId) : null;
          if (n?.waiting) out.push(strip(n));
        }
        return out;
      },
      classify: async (notices, quoted) => {
        const orgIds = [...new Set(notices.map((n) => n.orgId))];
        const replyContext = await loadDmReplyContext(db, { userId: input.userId, phone: input.phone, quoted, orgIds, now });
        const ctx = { pairings: notices.map((n) => ({ club: n.club, other: n.other })), replyContext };
        return withOrgAiBudget(notices[0].orgId, () => classifyPairingReply(input.text, ctx));
      },
      act: (notice, action) => answerPairing(notice, input.userId, action, now),
    },
  );
}

// ── A reaction ───────────────────────────────────────────────────────

export interface PairingReactionDeps {
  /** The pairing notice DM a reaction is on, who it was sent to, and the
   *  user with that phone; null for every other message. */
  notice: (waMessageId: string) => Promise<{ notice: PairingNotice; phone: string; userId: string | null } | null>;
  act: (notice: PairingNotice, userId: string, action: "accept") => Promise<PairingAnswer>;
  queueAck: (ack: { orgId: string; phone: string; text: string }) => Promise<void>;
}

const samePhone = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = a ? e164Digits(a) : null;
  const y = b ? e164Digits(b) : null;
  return x !== null && x === y;
};

/**
 * A ✅ or 👍 on the pairing notice DM is the owner's yes, as on the fee
 * confirm prompt (`fee-confirm-reaction.ts`). Null when the reaction is not
 * on a pairing notice; otherwise what was done.
 */
export async function runPairingReaction(
  input: { waMessageId: string; emoji: string; fromPhone?: string | null },
  deps: PairingReactionDeps,
): Promise<Record<string, unknown> | null> {
  const found = await deps.notice(input.waMessageId);
  if (!found) return null;
  if (!isFeeConfirmYesEmoji(input.emoji)) return { ok: true, ignored: "not-yes" };
  if (input.fromPhone && input.fromPhone.trim() && !samePhone(input.fromPhone, found.phone)) {
    return { ok: true, ignored: "reactor-not-the-recipient" };
  }
  if (!found.userId) return { ok: true, ignored: "unknown-reactor" };
  const r = await deps.act(found.notice, found.userId, "accept");
  await deps.queueAck({ orgId: found.notice.orgId, phone: found.phone, text: r.reply });
  return { ok: true, handled: "pairing-reaction", outcome: r.outcome, partnershipId: found.notice.partnershipId };
}

/** The database wiring for `runPairingReaction`. Never throws. */
export function handlePairingReaction(input: { waMessageId: string; emoji: string; fromPhone?: string | null }): Promise<Record<string, unknown> | null> {
  return runPairingReaction(input, {
    notice: async (waMessageId) => {
      try {
        if (!waMessageId) return null;
        const sent = await db.sentNotification.findFirst({ where: { waMessageId, kind: "dm" }, select: { key: true } });
        const jobId = sent ? botJobIdOfKey(sent.key) : null;
        if (!jobId) return null;
        const job = await db.botJob.findUnique({ where: { id: jobId }, select: { kind: true, phone: true, aboutKey: true } });
        const key = parsePairingNoticeKey(job?.aboutKey);
        if (!job || job.kind !== "dm" || !job.phone || !key) return null;
        const n = await loadNotice(key.partnershipId, key.orgId);
        if (!n) return null;
        const user = await db.user.findFirst({ where: { phoneNumber: { in: [`+${job.phone}`, job.phone] } }, select: { id: true } });
        return { notice: strip(n), phone: job.phone, userId: user?.id ?? null };
      } catch (err) {
        console.error("[pairing-reply] could not resolve the reacted-to DM:", err instanceof Error ? err.message : "failed");
        return null;
      }
    },
    act: (notice, userId, action) => answerPairing(notice, userId, action),
    queueAck: async ({ orgId, phone, text }) => {
      await db.botJob.create({ data: { orgId, kind: "dm", phone, text, ...REPLY_PRIORITY } });
    },
  });
}

// ── The admin group (HQ) ─────────────────────────────────────────────

/** The pairings waiting for this club's owner, for HQ's "WAITING" lines. */
export async function pairingsAwaitingOwner(orgId: string): Promise<Array<{ ref: string; club: string; other: string; askedAt: Date }>> {
  const rows = await db.clubPartnership.findMany({
    where: { OR: [{ askerOrgId: orgId }, { partnerOrgId: orgId }], status: "proposed" },
    orderBy: { createdAt: "asc" },
    include: { askerOrg: { select: { name: true } }, partnerOrg: { select: { name: true } } },
  });
  return rows
    .filter((p) => waitingForSide(p, orgId))
    .map((p) => {
      const asker = p.askerOrgId === orgId;
      return {
        ref: pairingNoticeKey(p.id, orgId),
        club: asker ? p.askerOrg.name : p.partnerOrg.name,
        other: asker ? p.partnerOrg.name : p.askerOrg.name,
        askedAt: p.updatedAt ?? p.createdAt,
      };
    });
}

/**
 * An HQ message that is about one pairing notice (it quotes it, or the
 * safe-YES rule decided it answers it): read against the notice by the
 * same model, then acted on by the same writer, as the sender. Null when
 * the reply is not an answer (the organisers' own conversation).
 */
export async function answerPairingInHq(args: {
  ref: string;
  orgId: string;
  text: string;
  senderUserId: string | null;
  /** The notice's words as MatchTime posted them, when known. */
  noticeText: string | null;
  noticeAt: Date | null;
  quoted: boolean;
  now: Date;
}): Promise<{ outcome: string; replyText: string } | null> {
  const key = parsePairingNoticeKey(args.ref);
  if (!key || key.orgId !== args.orgId) return null;
  const n = await loadNotice(key.partnershipId, key.orgId);
  if (!n) return null;
  const notice = strip(n);
  const message = { at: args.noticeAt, text: args.noticeText, topic: null, match: null };
  const replyContext: ReplyContext = args.quoted
    ? { now: args.now, quoted: message, recent: [], earlier: null }
    : { now: args.now, quoted: null, recent: args.noticeAt ? [message] : [], earlier: null };
  const intent = await classifyPairingReply(args.text, { pairings: [{ club: notice.club, other: notice.other }], replyContext });
  if (intent === "neither") return null;
  if (!args.senderUserId) return { outcome: "pairing-admin-only", replyText: t(notice.lang).pr_admin_only };
  const r = await answerPairing(notice, args.senderUserId, intent, args.now, "group");
  return { outcome: r.outcome, replyText: r.reply };
}
