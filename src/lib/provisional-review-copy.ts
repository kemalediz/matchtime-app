/**
 * THE DAILY "NEW PLAYERS TO REVIEW" NOTICE (bot-scheduler.ts), pure, no
 * Prisma.
 *
 * A provisional member (`Membership.provisionallyAddedAt`) is added one of
 * two ways, and the notice says which (2026-10-14, the FNF rehearsal: it
 * said "auto-added after posting in the group" of a player an organiser
 * had pasted into a list):
 *
 *   posted   they wrote in the club's WhatsApp group themselves;
 *   listed   they were added by name: from a pasted list, or from someone
 *            else's message naming them.
 *
 * The scheduler decides which from `AnalyzedMessage.authorUserId`. The DM
 * carries the admin's personal link and the plain URL; an admin-group post
 * the plain URL only (`admin-channel.ts` explains why).
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

/** Names per line before "(+N more)". */
const MAX_NAMES = 5;

export function buildProvisionalReviewNotice(args: {
  posted: string[];
  listed: string[];
  link: string;
  audience: "dm" | "group";
  /** The plain admin URL (`appUrl("/admin/players")`), for the DM's last line. */
  plainUrl: string;
  lang: Lang | string | null | undefined;
}): string {
  const s = t(args.lang);
  const names = (list: string[]) =>
    list.slice(0, MAX_NAMES).join(", ") + (list.length > MAX_NAMES ? s.pr_more({ count: list.length - MAX_NAMES }) : "");
  const lines: string[] = [];
  if (args.posted.length > 0) lines.push(s.pr_posted({ names: names(args.posted) }));
  if (args.listed.length > 0) lines.push(s.pr_listed({ names: names(args.listed) }));
  const header = s.pr_header({ count: args.posted.length + args.listed.length });
  const tail =
    args.audience === "dm" ? s.pr_tail_dm({ link: args.link, url: args.plainUrl }) : s.pr_tail_group({ link: args.link });
  return [header, lines.join("\n"), tail].join("\n\n");
}
