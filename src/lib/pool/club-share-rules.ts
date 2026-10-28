/**
 * A CLUB'S ONE SHARE POST (growth slice G3, 2026-10-24). PURE: no database,
 * no clock of its own, NO MODEL. The I/O half is `club-share.ts`.
 *
 * Approved spec, "Marketing support": one organiser-approved share post per
 * club, inviting members to share; no repeated group posts. Plan 11.3: one
 * post per club, ever, with the club's campaign link.
 *
 * The approval is a tap: the organiser reads the exact post on the "Tell
 * your players about the player pool" card in club settings and taps Send.
 * It is claimed ONCE per club, ever (`clubShareKey`, a `SentNotification`
 * key with nothing in it but the club), so a second tap, a double tap or a
 * second organiser in another tab sends nothing.
 *
 * The link is the club's own G1 campaign code, `/play?src=club-<slug>`, so
 * the owner's campaign page counts what the post brought.
 */
import { tr as trLocale } from "date-fns/locale";
import { poolClubShareCopy } from "../i18n/pool-club-share";
import { normaliseLang, type Lang } from "../i18n/lang";
import { formatLondon } from "../london-time";
import { POOL_CAMPAIGN_CODE_MAX, POOL_CAMPAIGN_LABEL_MAX } from "./growth-rules";
import { playStyleShown } from "./play-style";

export const CLUB_SHARE_KIND = "pool-club-share" as const;

/** The once-ever claim: the club and nothing else. */
export function clubShareKey(orgId: string): string {
  return `org-${orgId}:${CLUB_SHARE_KIND}`;
}

/** The card shows, and the post may be sent, only while the club has the
 *  player pool: the same rule as Style of play, one definition. */
export const clubShareShown = playStyleShown;

const CLUB_PREFIX = "club";

/**
 * The club's campaign code: "club-<slug>", made a valid campaign code
 * (lowercase letters, digits, single hyphens, at most 32). `attempt` 2 and
 * up adds "-2", "-3" for the rare code someone else already holds.
 */
export function clubShareCampaignCode(slug: string, attempt = 1): string {
  const tail = attempt > 1 ? `-${attempt}` : "";
  const room = POOL_CAMPAIGN_CODE_MAX - CLUB_PREFIX.length - 1 - tail.length;
  const clean = slug
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, Math.max(0, room))
    .replace(/-+$/g, "");
  return clean ? `${CLUB_PREFIX}-${clean}${tail}` : `${CLUB_PREFIX}${tail}`;
}

/** The code's label on the owner's campaign page: the club's name. */
export function clubShareCampaignLabel(clubName: string): string {
  const suffix = " share post";
  const name = clubName.trim().replace(/\s+/g, " ").slice(0, POOL_CAMPAIGN_LABEL_MAX - suffix.length).trim();
  return `${name}${suffix}`;
}

/** The post, in the club's language, with the club's link. */
export function clubSharePostText(lang: Lang | string | null | undefined, url: string): string {
  return poolClubShareCopy(lang).post(url);
}

/**
 *   hidden    the club has no player pool: no card.
 *   queued    claimed, but its players' group post has not gone out yet:
 *             held by the club's quiet hours until `sendAfter`, or waiting
 *             for the next send (`sendAfter` null). Never Send again.
 *   sent      the post went out (`sentAt`: when). A claim written before
 *             the post carried the claim's key has no post to find, and
 *             reads as sent on the claim's day, as it always did.
 *   no-group  no players' group (or the bot is off for it): the post is
 *             shown, Send is not.
 *   ready     Send is offered.
 */
export type ClubShareState =
  | { kind: "hidden" }
  | { kind: "queued"; sendAfter: Date | null }
  | { kind: "sent"; sentAt: Date }
  | { kind: "no-group" }
  | { kind: "ready" };

/** `sentAt`: the claim's time. `job`: the post written with the claim
 *  (found by the claim's key), null when none is. */
export function clubShareView(a: {
  shown: boolean;
  hasGroup: boolean;
  sentAt: Date | null;
  job?: { sendAfter: Date | null; sentAt: Date | null } | null;
}): ClubShareState {
  if (!a.shown) return { kind: "hidden" };
  if (a.sentAt) {
    if (a.job && !a.job.sentAt) return { kind: "queued", sendAfter: a.job.sendAfter };
    return { kind: "sent", sentAt: a.job?.sentAt ?? a.sentAt };
  }
  if (!a.hasGroup) return { kind: "no-group" };
  return { kind: "ready" };
}

/** "28 Oct 2026" / "28 Eki 2026", London. */
function shortDate(lang: Lang, d: Date): string {
  return formatLondon(d, "d MMM yyyy", lang === "tr" ? trLocale : undefined);
}

/**
 * The card's line about the post, London time, in the club's language:
 * "Queued: goes out at 09:00." (the date too when it is not today) or
 * "Sent to your players' group on 28 Oct 2026."; null for the other states.
 */
export function clubShareStatusLine(lang: Lang | string | null | undefined, state: ClubShareState, now: Date): string | null {
  const l = normaliseLang(lang);
  const c = poolClubShareCopy(l);
  if (state.kind === "sent") return c.sentOn(shortDate(l, state.sentAt));
  if (state.kind !== "queued") return null;
  const at = state.sendAfter;
  if (!at || at.getTime() <= now.getTime()) return c.queuedSoon;
  const time = formatLondon(at, "HH:mm");
  if (formatLondon(at, "yyyy-MM-dd") === formatLondon(now, "yyyy-MM-dd")) return c.queuedToday(time);
  return c.queuedOn(shortDate(l, at), time);
}
