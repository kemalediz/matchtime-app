/**
 * ORGANISERS ASKING PARTNER CLUBS IN THEIR OWN WORDS (slice S6, 2026-10-21).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, section 5 (S6).
 *
 * "@MatchTime search for players from our partner groups", "ask Friday MT
 * Community if anyone can play", "Sutton'a sor bakalım oynayan var mı".
 * The router sends such a request to `admin_ops` (it is shown the club's
 * partner names, `partnerClubsLine` in `pipeline/router.ts`), the shared
 * admin extractor reports `action: "recruit"` with the facts `partnerClubs`
 * and `clubRef` (the other club's name as written, or nothing), and every
 * surface calls THIS one function:
 *
 *   the players' group   the batch-final pass in `analyze/route.ts`, after
 *                        the engine (`pipeline/engine.ts`, an admin, tagged)
 *                        proposed the `partner_ask` write
 *   the organisers' group `admin-group-understand.ts`, an organiser
 *   a DM                 `dm-intent.ts`'s `partner_ask` intent, an admin
 *
 * It resolves which partners are meant (`resolvePartnerRef`: no club named
 * is EVERY active partner, Kemal 2026-10-21; a named club is that partner
 * only), calls the existing `requestPartnerAsk` once per partner, so every
 * rule of the match page button holds (places open, the cut-off, one open
 * ask per pair, the daily cap, the requester's role, the partner's
 * approval), and composes ONE reply from what each call said. It never
 * writes a `PartnerAsk` row itself.
 */
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { loadPartnerAskSettings } from "./club-partnership";
import { requestPartnerAsk } from "./partner-ask";
import { loadSquadState } from "./pipeline/load-state";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "./club-partnership-rules";
import type { PartnerAskVia } from "./partner-ask-rules";
import {
  composePartnerAskReply,
  resolutionReply,
  resolvePartnerRef,
  type OpenPartnerAsk,
  type PartnerAskOutcome,
  type PartnerChoice,
} from "./partner-ask-words-rules";
import { t } from "./i18n/t";
import { dayCommaTimeLabel, dayMonthShortLabel } from "./i18n/dates";
import { appUrl } from "./app-url";
import { settingsAnchorPath } from "./help-links";
import { OPEN_ASK_STATUSES } from "./partner-ask-rules";
import { normaliseBenchPickMode } from "./squad-capacity";
import { extractForRoute } from "./pipeline/extractors";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";

export interface PartnerAskFromWordsResult {
  outcome:
    | "xask-words-asked"
    | "xask-words-not-asked"
    | "xask-words-no-partner"
    | "xask-words-asking-off"
    | "xask-words-no-match"
    | "xask-words-ambiguous"
    | "xask-words-no-game";
  replyText: string;
  /** How many partners were asked (posted or waiting for their OK). */
  asked: number;
}

/** The club's active partners it may ask, oldest pairing first. */
export async function activePartnerChoices(orgId: string): Promise<PartnerChoice[]> {
  const rows = await db.clubPartnership.findMany({
    where: { askerOrgId: orgId, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { id: true, partnerOrgId: true, partnerOrg: { select: { name: true } } },
  });
  return (rows ?? []).map((r) => ({ partnershipId: r.id, partnerOrgId: r.partnerOrgId, name: r.partnerOrg.name }));
}

/**
 * The players' group router's partner line (`partnerClubsLine`): the
 * club's active partners' names, and which of these senders are its
 * owners or admins (only their messages are shown the line). Null when no
 * sender is known or the club has no active partner, so the router's turn
 * is byte for byte what it was for every club that never paired.
 */
export async function partnerClubsForRouter(
  orgId: string,
  senderUserIds: Array<string | null | undefined>,
): Promise<{ names: string[]; organiserIds: Set<string> } | null> {
  const ids = [...new Set(senderUserIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return null;
  const partners = await activePartnerChoices(orgId);
  if (partners.length === 0) return null;
  const rows = await db.membership.findMany({
    where: { orgId, userId: { in: ids }, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE },
    select: { userId: true },
  });
  return { names: partners.map((p) => p.name), organiserIds: new Set((rows ?? []).map((r) => r.userId)) };
}

export async function askPartnersFromWords(args: {
  orgId: string;
  requestedByUserId: string | null;
  via: Extract<PartnerAskVia, "hq" | "dm" | "group">;
  /** The other club's name as written; null or "" when none was named. */
  clubRef: string | null | undefined;
  /** The match the caller already knows (the players' group's state). */
  matchId?: string | null;
  lang: string | null;
  now: Date;
}): Promise<PartnerAskFromWordsResult> {
  const { orgId, lang, now } = args;
  const [partners, settings] = await Promise.all([activePartnerChoices(orgId), loadPartnerAskSettings(orgId)]);
  const resolved = resolvePartnerRef({ clubRef: args.clubRef, partners, askWhen: settings?.when ?? null });
  const settingsLink = appUrl(settingsAnchorPath("partner-clubs"));
  if (resolved.kind !== "ask") {
    console.log(`[partner-ask-words] ${orgId}: nothing asked (${resolved.kind}, ${partners.length} partner(s))`);
    return { outcome: `xask-words-${resolved.kind}`, replyText: resolutionReply(lang, resolved, settingsLink), asked: 0 };
  }
  const matchId = args.matchId !== undefined ? args.matchId : (await loadSquadState(orgId, now)).matchId;
  if (!matchId) return { outcome: "xask-words-no-game", replyText: t(lang).recruit_no_match, asked: 0 };

  // P4 (2026-10-22): the asks of one request are one round. Asking in
  // words names no number yet (D-7, slice P6), so each asks for every open
  // place, and the reply says how many.
  const roundId = randomUUID();
  let places = 0;
  const results: Array<{ partnerName: string; result: PartnerAskOutcome; open?: OpenPartnerAsk | null; partnershipId: string }> = [];
  for (const p of resolved.partners) {
    let result: PartnerAskOutcome;
    try {
      const r = await requestPartnerAsk({
        askerOrgId: orgId,
        matchId,
        partnershipId: p.partnershipId,
        requestedByUserId: args.requestedByUserId,
        via: args.via,
        roundId,
        now,
      });
      if (r.ok) places = Math.max(places, r.places);
      result = r.ok ? (r.status === "posted" ? "posted" : "awaiting") : r.refusal;
    } catch (err) {
      // One partner failing never loses what the others said.
      console.error(`[partner-ask-words] ${orgId}: asking ${p.partnerOrgId} failed:`, err instanceof Error ? err.message : "failed");
      result = "not-found";
    }
    results.push({ partnerName: p.name, result, partnershipId: p.partnershipId });
  }
  // An ask already open to a partner: the reply says when it was made and
  // whether it still waits for their organisers. Only read when one was
  // refused for that; a failed read leaves the reply without the date.
  let day: string | null = null;
  if (results.some((r) => r.result === "already-open")) {
    try {
      const match = await db.match.findUnique({ where: { id: matchId }, select: { date: true } });
      day = match ? dayCommaTimeLabel(lang, match.date) : null;
      for (const r of results) {
        if (r.result !== "already-open") continue;
        const ask = await db.partnerAsk.findFirst({
          where: { matchId, partnershipId: r.partnershipId, status: { in: [...OPEN_ASK_STATUSES] } },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true, status: true },
        });
        r.open = ask ? { askedOn: dayMonthShortLabel(lang, ask.createdAt), awaiting: ask.status === "awaiting-approval" } : null;
      }
    } catch (err) {
      console.error(`[partner-ask-words] ${orgId}: reading the open ask failed:`, err instanceof Error ? err.message : "failed");
    }
  }
  const asked = results.filter((r) => r.result === "posted" || r.result === "awaiting").length;
  // Where a volunteer goes is the club's own bench rule (partner-guest.ts).
  let pick: { benchPickMode: string | null } | null = null;
  if (asked > 0) {
    try {
      pick = await db.organisation.findUnique({ where: { id: orgId }, select: { benchPickMode: true } });
    } catch {
      pick = null; // the default rule, first come
    }
  }
  const firstCome = normaliseBenchPickMode(pick?.benchPickMode) === "first-come";
  console.log(`[partner-ask-words] ${orgId}: ${args.via} asked ${asked} of ${results.length} partner(s) for match ${matchId}`);
  return {
    outcome: asked > 0 ? "xask-words-asked" : "xask-words-not-asked",
    replyText: composePartnerAskReply(lang, results, { cutoffHours: settings?.cutoffHours ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS, places, day, settingsLink, firstCome }),
    asked,
  };
}

/**
 * A DM the DM classifier called `partner_ask` (`dm-intent.ts`): the shared
 * admin extractor reads the club named, exactly as in the groups, then the
 * shared door asks. When the extractor does not confirm it is an ask to
 * another club, nothing is asked and the admin hears one plain line: two
 * readings that disagree never trouble a partner club's organisers.
 */
export async function askPartnersFromDmText(args: {
  orgId: string;
  userId: string;
  text: string;
  senderName: string | null;
  lang: string | null;
  now: Date;
  /** Injected in tests only. */
  model?: PipelineModel;
}): Promise<string> {
  const model = args.model ?? extractorStubFromEnv() ?? anthropicModel();
  const extracted = await extractForRoute(model, "admin_ops", {
    id: `dm:${args.userId}`,
    body: args.text,
    authorName: args.senderName,
    tagged: true,
    history: [],
    lastBotPost: null,
    now: args.now,
  });
  const facts = extracted.facts;
  if (facts.kind !== "admin" || facts.action !== "recruit" || !facts.partnerClubs) {
    console.log(`[partner-ask-words] ${args.orgId}: a DM ask the admin extractor did not confirm (${facts.kind === "admin" ? facts.action : facts.kind})`);
    return t(args.lang).xaskw_not_sure;
  }
  const r = await askPartnersFromWords({
    orgId: args.orgId,
    requestedByUserId: args.userId,
    via: "dm",
    clubRef: facts.clubRef ?? null,
    lang: args.lang,
    now: args.now,
  });
  return r.replyText;
}
