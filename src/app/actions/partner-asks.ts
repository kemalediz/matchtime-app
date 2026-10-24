"use server";

/**
 * Asking a partner club for a player (slice S2, 2026-10-16): the match
 * page's button, and the partner organiser's approve page. Each action
 * proves who is asking here (a server action is a public endpoint); the
 * rules and writes are `src/lib/partner-ask.ts`.
 */
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireOrgAdmin } from "@/lib/org";
import { t } from "@/lib/i18n/t";
import { loadPartnerAskSettings } from "@/lib/club-partnership";
import { approvePartnerAsk, askRefusalText, cancelPartnerRound, declinePartnerAsk } from "@/lib/partner-ask";
import { requestAskRound } from "@/lib/pool/ask-round";
import { poolAskRefusalText } from "@/lib/pool/offer-copy";
import { poolEnvForRequest } from "@/lib/pool/switch-env";
import { poolCopy } from "@/lib/i18n/pool-offer";
import { joinList } from "@/lib/i18n/text";
import { keepGuestAsMember } from "@/lib/partner-guest";

async function sessionUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  return session.user.id;
}

async function adminOfMatch(matchId: string): Promise<{ userId: string; orgId: string; lang: string }> {
  const userId = await sessionUserId();
  const match = await db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { orgId: true, org: { select: { language: true } } } } } });
  if (!match) throw new Error("Not found");
  await requireOrgAdmin(userId, match.activity.orgId);
  return { userId, orgId: match.activity.orgId, lang: match.activity.org.language };
}

/**
 * The match page's "Ask for N player(s)" (partner discovery P4,
 * 2026-10-22): the number the organiser picked (1 up to the open places)
 * and the partners ticked, one round. OWNER or ADMIN only. A paused
 * partner is never asked, and the reply says which.
 *
 * The MatchTime player pool (L5a, 2026-10-24) is one more tick: `pool`
 * true asks it in the SAME round (`pool/ask-round.ts`). The tap is the
 * organisers' approval; nobody is contacted before it.
 */
export async function requestPartnerRoundAction(
  matchId: string,
  partnershipIds: string[],
  places: number,
  pool = false,
): Promise<{ ok: boolean; message: string }> {
  const { userId, orgId, lang } = await adminOfMatch(matchId);
  const s = t(lang);
  const ids = Array.isArray(partnershipIds) ? partnershipIds.filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0 && pool !== true) return { ok: false, message: s.xask_round_none_ticked };
  const r = await requestAskRound({ orgId, matchId, partnershipIds: ids, pool: pool === true, places: Number(places), userId, poolEnv: await poolEnvForRequest() });
  revalidatePath(`/matches/${matchId}`);
  const parts: string[] = [];
  let asked = 0;
  if (r.partner) {
    const cutoff = (await loadPartnerAskSettings(orgId))?.cutoffHours ?? 4;
    const names = r.partner.results.filter((x) => x.result === "posted" || x.result === "awaiting").map((x) => x.partnerName);
    asked += names.length;
    if (names.length > 0) parts.push(s.xask_round_asked_toast({ partners: joinList(lang, names), places: Number(places) }));
    for (const x of r.partner.results) {
      if (x.result === "posted" || x.result === "awaiting") continue;
      parts.push(askRefusalText(lang, x.result, x.partnerName, cutoff, r.partner.placesOpen));
    }
    if (r.partner.skippedPaused.length > 0) parts.push(s.xask_round_skipped_paused({ partners: joinList(lang, r.partner.skippedPaused) }));
  }
  if (r.pool) {
    if (r.pool.ok) {
      asked++;
      parts.push(poolCopy(lang).toast_asked({ places: Number(places) }));
    } else {
      parts.push(poolAskRefusalText(lang, r.pool.refusal, r.partner?.placesOpen ?? Number(places)));
    }
  }
  return { ok: asked > 0, message: parts.join(" ") || s.xask_refused_generic };
}

/** The match page's "Cancel this ask" (Kemal, 2026-10-22): every open ask
 *  of the round closes, each partner group that saw it hears "no longer
 *  needed", volunteers are stood down. OWNER or ADMIN only. */
export async function cancelPartnerRoundAction(matchId: string, roundKey: string): Promise<{ ok: boolean; message: string }> {
  const { userId, orgId, lang } = await adminOfMatch(matchId);
  const s = t(lang);
  if (typeof roundKey !== "string" || !roundKey) return { ok: false, message: s.xask_round_cancel_failed };
  const r = await cancelPartnerRound({ askerOrgId: orgId, matchId, roundKey, userId });
  revalidatePath(`/matches/${matchId}`);
  return { ok: r.ok, message: r.ok ? s.xask_round_cancelled_toast : s.xask_round_cancel_failed };
}

/** The partner organiser's answer on the approve page. The writer checks
 *  they are an OWNER or ADMIN of the club that was asked. */
export async function answerPartnerAskAction(askId: string, answer: "yes" | "no"): Promise<{ ok: boolean; outcome: string }> {
  const userId = await sessionUserId();
  const r = answer === "yes" ? await approvePartnerAsk({ askId, userId }) : await declinePartnerAsk({ askId, userId });
  revalidatePath(`/partner-asks/${askId}`);
  return { ok: r.ok, outcome: r.outcome };
}

/** "Add to <club>" on the match page (slice S4): the asking club keeps a
 *  guest as an ordinary member. OWNER or ADMIN of the match's club only. */
export async function keepGuestAction(matchId: string, userId: string): Promise<{ ok: boolean }> {
  const actor = await sessionUserId();
  const match = await db.match.findUnique({ where: { id: matchId }, select: { activity: { select: { orgId: true } } } });
  if (!match) throw new Error("Not found");
  await requireOrgAdmin(actor, match.activity.orgId);
  const ok = await keepGuestAsMember(match.activity.orgId, userId);
  revalidatePath(`/matches/${matchId}`);
  return { ok };
}
