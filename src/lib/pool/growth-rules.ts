/**
 * THE POOL'S GROWTH RULES (slice G1, 2026-10-24). PURE: no database, no
 * clock of its own, NO MODEL. The thin I/O halves are `growth.ts` (his
 * share code, the referral settled when a sign-up goes live, the "invited
 * you" line) and `campaigns.ts` (the owner's codes and their counts).
 *
 * Plan: MDs/local-player-pool-plan-2026-10-23.md section 11.1; spec
 * "Referrals" and "Marketing support". Decisions G1.x in the decisions log.
 *
 * ATTRIBUTION IS FIRST TOUCH. The source written on a sign-up (a friend's
 * `?ref=`, else a live campaign's `?src=`, else the web: `signup.ts`) is the
 * one that stays when that sign-up goes live, and nothing rewrites it: a
 * live player who later opens another link changes nothing. A referral is
 * then SETTLED once, as the profile goes live (`settleReferral`), when the
 * friend's account is known for the first time.
 */
import { randomInt } from "node:crypto";
import { waMeLink } from "../club-connect-rules";
import { poolShareCopy } from "../i18n/pool-share";
import type { Lang } from "../i18n/lang";
import { POOL_CONFIRM_CODE_ALPHABET } from "./rules";
import { POOL_CAMPAIGN_SOURCES, type PoolCampaignSource, type PoolProfileStatus } from "./vocab";
import { POOL_PLAY_PATH } from "./paths";

export const POOL_ATTRIBUTION = "first-touch" as const;

// ── His share code ─────────────────────────────────────────────────────

/** Six characters: never the five of a /play confirm code, nor the four of
 *  a self-join connect code, so no code reader can take it for its own. */
export const POOL_SHARE_CODE_LENGTH = 6;

export function generatePoolShareCode(rand: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < POOL_SHARE_CODE_LENGTH; i++) code += POOL_CONFIRM_CODE_ALPHABET[rand(POOL_CONFIRM_CODE_ALPHABET.length)];
  return code;
}

/** The card is for a live profile: not a waiting sign-up, not a stopped one. */
export function shareCardShown(status: PoolProfileStatus | string): boolean {
  return status === "active" || status === "paused";
}

// ── Links and the message ──────────────────────────────────────────────

const trimBase = (base: string) => base.replace(/\/+$/, "");

export function poolShareUrl(base: string, shareCode: string): string {
  return `${trimBase(base)}${POOL_PLAY_PATH}?ref=${encodeURIComponent(shareCode)}`;
}

export function poolCampaignUrl(base: string, campaignCode: string): string {
  return `${trimBase(base)}${POOL_PLAY_PATH}?src=${encodeURIComponent(campaignCode)}`;
}

/** The ready-to-forward message: the words and his link, nothing else. */
export function poolShareMessage(lang: Lang, url: string): string {
  return poolShareCopy(lang).message(url);
}

/** WhatsApp's own chat picker with the message filled in (no number). */
export function poolShareWhatsAppLink(lang: Lang, url: string): string {
  return waMeLink("", poolShareMessage(lang, url));
}

/** The name people who open his link see: first name and last initial,
 *  and only while his privacy switch ("badges and Brought by") shows it. */
export function referrerShownName(r: { displayName: string; showRecognition: boolean } | null): string | null {
  if (!r?.showRecognition) return null;
  const parts = r.displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// ── Campaign codes ─────────────────────────────────────────────────────

/** The DB CHECK's limit (prisma/sql/pool-check.sql). */
export const POOL_CAMPAIGN_CODE_MAX = 32;
export const POOL_CAMPAIGN_LABEL_MAX = 80;
const CAMPAIGN_CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The sources the owner page offers. A club's code comes with that club's
 *  share post (slice G3), which knows the club. */
export const POOL_CAMPAIGN_OWNER_SOURCES = POOL_CAMPAIGN_SOURCES.filter((s): s is Exclude<PoolCampaignSource, "club"> => s !== "club");
export type PoolCampaignOwnerSource = (typeof POOL_CAMPAIGN_OWNER_SOURCES)[number];

export interface CampaignInput {
  code: string;
  source: PoolCampaignOwnerSource;
  label: string;
}
export interface CampaignInputErrors {
  code?: "required" | "format" | "too-long";
  source?: "unknown";
  label?: "required" | "too-long";
}

export function validateCampaignInput(raw: unknown): { ok: true; value: CampaignInput } | { ok: false; errors: CampaignInputErrors } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const code = typeof r.code === "string" ? r.code.trim().toLowerCase() : "";
  const label = typeof r.label === "string" ? r.label.trim().replace(/\s+/g, " ") : "";
  const source = POOL_CAMPAIGN_OWNER_SOURCES.find((s) => s === r.source);
  const errors: CampaignInputErrors = {};
  if (!code) errors.code = "required";
  else if (code.length > POOL_CAMPAIGN_CODE_MAX) errors.code = "too-long";
  else if (!CAMPAIGN_CODE_RE.test(code)) errors.code = "format";
  if (!source) errors.source = "unknown";
  if (!label) errors.label = "required";
  else if (label.length > POOL_CAMPAIGN_LABEL_MAX) errors.label = "too-long";
  if (Object.keys(errors).length > 0 || !source) return { ok: false, errors };
  return { ok: true, value: { code, source, label } };
}

/** Sign-ups per campaign code: still waiting for their WhatsApp message,
 *  and confirmed (live, paused or stopped since). Deleted profiles and old
 *  waiting sign-ups the housekeeping removed are not counted. */
export function campaignSignupCounts(
  rows: ReadonlyArray<{ sourceCode: string | null; status: string; count?: number }>,
): Map<string, { waiting: number; confirmed: number }> {
  const out = new Map<string, { waiting: number; confirmed: number }>();
  for (const r of rows) {
    if (!r.sourceCode) continue;
    const c = out.get(r.sourceCode) ?? { waiting: 0, confirmed: 0 };
    const n = r.count ?? 1;
    if (r.status === "pending-verify") c.waiting += n;
    else c.confirmed += n;
    out.set(r.sourceCode, c);
  }
  return out;
}

// ── Referrals ──────────────────────────────────────────────────────────

export type ReferralSettlement =
  | { keep: true }
  | { keep: false; reason: "no-referrer" | "self" | "loop" | "referrer-stopped" | "existing-user" };

/**
 * Settled ONCE, as a sign-up that came through a friend's link goes live.
 * `referrer.chain` is who brought the referrer, nearest first (bounded by
 * the adapter). The order is the order of the reasons below:
 *   self              his own link, confirmed from his own number
 *   loop              the friend is already up the referrer's chain
 *   referrer-stopped  the referrer withdrew his consent
 *   existing-user     the number was on MatchTime before this sign-up
 *                     (plan 11.2: never a referral of an existing user)
 * A dropped referral keeps the profile's source and code (the funnel still
 * counts the link that brought him); only the referrer is cleared.
 */
export function settleReferral(a: {
  friendUserId: string;
  friendAccountExisted: boolean;
  referrer: { userId: string; status: string; chain: readonly string[] } | null;
}): ReferralSettlement {
  if (!a.referrer) return { keep: false, reason: "no-referrer" };
  if (a.referrer.userId === a.friendUserId) return { keep: false, reason: "self" };
  if (a.referrer.chain.includes(a.friendUserId)) return { keep: false, reason: "loop" };
  if (a.referrer.status === "stopped") return { keep: false, reason: "referrer-stopped" };
  if (a.friendAccountExisted) return { keep: false, reason: "existing-user" };
  return { keep: true };
}

/** For slice G4 (badges, credits): a stored referral counts once the friend
 *  has played, and is counted once (`referralCountedAt`). */
export function referralCountsForReward(a: { referrerUserId: string | null; referralCountedAt: Date | null; friendHasPlayed: boolean }): boolean {
  return !!a.referrerUserId && !a.referralCountedAt && a.friendHasPlayed;
}
