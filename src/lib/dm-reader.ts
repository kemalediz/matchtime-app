/**
 * THE ONE DM READ, ONCE PER DM (2026-10-30, the no-string-parsing sweep).
 *
 * Kemal: "I don't want any string parsing at all." The DM route used to
 * decide four things from word lists: GO (take a club live), the STOP and
 * START commands for its messages, and whether a DM was a question worth
 * answering. Each is now one field of the model read in `dm-intent.ts`,
 * which already read an admin's instructions.
 *
 * This file is the I/O around that read:
 *   - the FACTS it is shown, loaded once: the sender's clubs (their role
 *     and whether each is setting up), the partner clubs of the clubs they
 *     organise, and what MatchTime said to them (`loadDmReplyContext`);
 *   - which daily AI allowance pays (their first live club's, else the
 *     pre-club allowance: an organiser whose club is setting up has $0 on
 *     the club's own);
 *   - THE MEMO: every step of the route that asks gets the same answer
 *     from ONE call. A DM costs one read however many steps consult it.
 *
 * It decides nothing. Each caller gates on facts (who organises which club,
 * which club is setting up, who is the owner) before acting on the answer,
 * and any failure is `other`, which acts on nothing.
 */
import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { APPROVED_CLUB_WHERE } from "./club-approval-state";
import { isClubSettingUp, SETUP_STAGE_SELECT } from "./club-setup-rules";
import { onboardingUserKey, withOrgAiBudget } from "./ai-budget";
import { loadDmReplyContext, quoteForClubs, type QuotedBotMessage } from "./reply-context";
import { classifyDmIntent, type DmIntentClassification, type DmIntentContext, type DmReaderClub } from "./dm-intent";

export interface DmReaderFacts {
  context: DmIntentContext;
  /** Whose daily AI allowance pays for the read. */
  budgetKey: string;
}

/** The facts for one sender. Never throws: a failed read is fewer facts. */
export async function loadDmReaderFacts(input: {
  userId: string;
  /** Where DMs to them are queued (digits, no "+"), for the chat context. */
  phone: string | null;
  quoted: QuotedBotMessage | null;
  senderName: string | null;
}): Promise<DmReaderFacts> {
  const rows = await db.membership
    .findMany({
      where: { userId: input.userId, leftAt: null, ...ORDINARY_MEMBER_WHERE, org: APPROVED_CLUB_WHERE },
      select: { orgId: true, role: true, org: { select: { name: true, ...SETUP_STAGE_SELECT } } },
      orderBy: { createdAt: "asc" },
    })
    .catch((err: unknown) => {
      console.error("[dm-reader] memberships read failed:", err instanceof Error ? err.message : "failed");
      return [];
    });
  const clubs: Array<DmReaderClub & { orgId: string }> = rows.map((r) => ({
    orgId: r.orgId,
    name: r.org.name,
    organiser: r.role === "OWNER" || r.role === "ADMIN",
    settingUp: isClubSettingUp(r.org),
  }));
  const organised = clubs.filter((c) => c.organiser && !c.settingUp).map((c) => c.orgId);
  let partnerClubs: string[] = [];
  if (organised.length > 0) {
    const { activePartnerChoices } = await import("./partner-ask-words");
    const lists = await Promise.all(organised.map((id) => activePartnerChoices(id).catch(() => [])));
    partnerClubs = [...new Set(lists.flat().map((p) => p.name))];
  }
  // Only MatchTime's DMs about the sender's own clubs (review of #339, M1):
  // a quote about another club's match is dropped, and so are that club's
  // DMs. Someone in no club yet (a pool player) is shown every DM.
  const orgIds = clubs.map((c) => c.orgId);
  const quotedOrgId = input.quoted?.matchId
    ? ((await db.match.findUnique({ where: { id: input.quoted.matchId }, select: { activity: { select: { orgId: true } } } }).catch(() => null))?.activity.orgId ?? null)
    : null;
  const replyContext = await loadDmReplyContext(db, {
    userId: input.userId,
    phone: input.phone,
    quoted: orgIds.length > 0 ? quoteForClubs(input.quoted, quotedOrgId, orgIds).quoted : input.quoted,
    ...(orgIds.length > 0 ? { orgIds } : {}),
  });
  const live = clubs.find((c) => !c.settingUp);
  return {
    context: {
      senderName: input.senderName,
      clubs: clubs.map(({ name, organiser, settingUp }) => ({ name, organiser, settingUp })),
      partnerClubs,
      replyContext,
    },
    budgetKey: live ? live.orgId : onboardingUserKey(input.userId),
  };
}

export interface DmReader {
  /** The read for this DM's sender. The first call asks the model; every
   *  later one gets the same answer. Never throws: a failure is `other`. */
  read: (userId: string) => Promise<DmIntentClassification>;
}

export interface DmReaderDeps {
  facts: (userId: string) => Promise<DmReaderFacts>;
  classify: (facts: DmReaderFacts) => Promise<DmIntentClassification>;
}

const OTHER = (reasoning: string): DmIntentClassification => ({ intent: "other", confidence: 0, reasoning });

/** The memo, with its I/O injected (the unit tests drive this). */
export function createDmReaderWith(deps: DmReaderDeps): DmReader {
  let once: Promise<DmIntentClassification> | null = null;
  let readFor: string | null = null;
  return {
    read(userId) {
      if (once) {
        // One sender per DM. A second user id (a sender who resolves to two
        // accounts) gets the read already made, which was about this text.
        if (readFor !== userId) console.log(`[dm-reader] read reused for ${userId} (made for ${readFor})`);
        return once;
      }
      readFor = userId;
      once = (async () => {
        try {
          const facts = await deps.facts(userId);
          return await deps.classify(facts);
        } catch (err) {
          console.error("[dm-reader] read failed; treating the DM as `other`:", err instanceof Error ? err.message : "failed");
          return OTHER("reader error");
        }
      })();
      return once;
    },
  };
}

/** The production reader for one inbound DM. */
export function createDmReader(input: {
  text: string;
  phone: (userId: string) => Promise<string | null>;
  quoted: QuotedBotMessage | null;
  senderName: string | null;
}): DmReader {
  return createDmReaderWith({
    facts: async (userId) =>
      loadDmReaderFacts({ userId, phone: await input.phone(userId), quoted: input.quoted, senderName: input.senderName }),
    classify: async (facts) => {
      const read = await withOrgAiBudget(facts.budgetKey, () => classifyDmIntent(input.text, facts.context));
      console.log(`[dm-reader] intent=${read.intent} confidence=${read.confidence.toFixed(2)} reasoning=${JSON.stringify(read.reasoning.slice(0, 120))}`);
      return read;
    },
  });
}
