/**
 * THE POOL'S SHARING, the thin I/O half of `growth-rules.ts` (slice G1,
 * 2026-10-24):
 *
 *   ensurePoolShareCode   his stable personal code, given the first time
 *                         his card is shown (profiles live before G1 have
 *                         none), and never changed after
 *   loadPoolShare         the "Bring a friend" card: his link, the
 *                         ready-to-forward message in both languages, and
 *                         the name people who open it see (privacy switch)
 *   poolInvitedByName     the "Ali K. invited you" line on /play
 *   settlePoolReferral    a friend's referral settled once, as his sign-up
 *                         goes live on his WhatsApp message (`confirm.ts`)
 *
 * The link is plain `/play?ref=CODE`: it signs nobody in and carries no
 * number. The code only says who shared it.
 */
import { appBaseUrl } from "../app-url";
import { db } from "../db";
import type { Lang } from "../i18n/lang";
import { LANGS, normaliseLang } from "../i18n/lang";
import { generatePoolShareCode, poolShareMessage, poolShareUrl, poolShareWhatsAppLink, referrerShownName, settleReferral, shareCardShown } from "./growth-rules";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** How far up a referrer's own chain the loop check looks. */
const REFERRAL_CHAIN_MAX = 10;

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "P2002";

export async function ensurePoolShareCode(profileId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const row = await db.poolProfile.findUnique({ where: { id: profileId }, select: { shareCode: true } });
    if (!row) return null;
    if (row.shareCode) return row.shareCode;
    try {
      // Compare-and-set: two tabs at once give him ONE code.
      await db.poolProfile.updateMany({ where: { id: profileId, shareCode: null }, data: { shareCode: generatePoolShareCode() } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return null;
}

export interface PoolShareView {
  url: string;
  /** The message and its WhatsApp link, per language (the page switches). */
  messages: Record<Lang, { text: string; whatsApp: string }>;
  /** The name people who open his link see; null while he keeps it private. */
  shownName: string | null;
  language: Lang;
}

export async function loadPoolShare(userId: string): Promise<PoolShareView | null> {
  const p = await db.poolProfile.findUnique({
    where: { userId },
    select: { id: true, status: true, displayName: true, showRecognition: true, language: true },
  });
  if (!p || !shareCardShown(p.status)) return null;
  const code = await ensurePoolShareCode(p.id);
  if (!code) return null;
  const url = poolShareUrl(appBaseUrl(), code);
  const messages = Object.fromEntries(LANGS.map((l) => [l, { text: poolShareMessage(l, url), whatsApp: poolShareWhatsAppLink(l, url) }])) as PoolShareView["messages"];
  return { url, messages, shownName: referrerShownName(p), language: normaliseLang(p.language) };
}

/** The sharer's name for /play, only for a live profile whose switch shows it. */
export async function poolInvitedByName(shareCode: string | null): Promise<string | null> {
  if (!shareCode) return null;
  const p = await db.poolProfile.findUnique({ where: { shareCode }, select: { status: true, displayName: true, showRecognition: true } });
  return p && shareCardShown(p.status) ? referrerShownName(p) : null;
}

/**
 * Settle the referral on a sign-up that has just gone live, in its
 * transaction. `friendAccountExisted`: the number that confirmed already
 * had a MatchTime account (the confirm knows; timestamps written by
 * different writers are not compared). A dropped referral clears only
 * `referrerUserId`: the source and code stay, so the funnel still counts
 * the link.
 */
export async function settlePoolReferral(tx: Tx, profileId: string, a: { friendAccountExisted: boolean }): Promise<void> {
  const p = await tx.poolProfile.findUnique({ where: { id: profileId }, select: { userId: true, referrerUserId: true } });
  if (!p?.userId || !p.referrerUserId) return;

  const referrer = await tx.poolProfile.findUnique({ where: { userId: p.referrerUserId }, select: { status: true, referrerUserId: true } });
  const chain: string[] = [];
  for (let next = referrer?.referrerUserId ?? null; next && chain.length < REFERRAL_CHAIN_MAX && !chain.includes(next); ) {
    chain.push(next);
    next = (await tx.poolProfile.findUnique({ where: { userId: next }, select: { referrerUserId: true } }))?.referrerUserId ?? null;
  }

  const verdict = settleReferral({
    friendUserId: p.userId,
    friendAccountExisted: a.friendAccountExisted,
    referrer: referrer ? { userId: p.referrerUserId, status: referrer.status, chain } : null,
  });
  if (verdict.keep) return;
  await tx.poolProfile.update({ where: { id: profileId }, data: { referrerUserId: null } });
  console.log(`[pool-referral] referral not kept profile=${profileId} reason=${verdict.reason}`);
}
