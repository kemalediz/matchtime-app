/**
 * THE SEED-RATING NUDGE'S TEXT (seed-nudge-rules.ts says when), pure, no
 * Prisma, no model. Words in the string table (`sn_*`), English and
 * Turkish. The link is the admin's signed-in link by DM, the plain URL in
 * the admin group (admin-channel.ts).
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import { weekdayLabel } from "./i18n/dates";
import { joinAdminNames, ratingMinutes } from "./seed-nudge-rules";

export function buildSeedNudgeNotice(args: {
  lang: Lang | string | null | undefined;
  matchDate: Date;
  /** The club's owners and admins, full names; first names are used. */
  adminNames: ReadonlyArray<string | null | undefined>;
  pool: "confirmed" | "members";
  total: number;
  unseeded: number;
  /** Some players in the pool already have a seed. */
  anySeeded: boolean;
  /** Post-match peer ratings are on, so the seeds are needed only once. */
  peerRatingsOn: boolean;
  link: string;
}): string {
  const s = t(args.lang);
  const names = joinAdminNames(args.adminNames, args.lang);
  const minutes = ratingMinutes(args.unseeded);
  const weekday = weekdayLabel(args.lang, args.matchDate);
  const size =
    args.pool === "confirmed"
      ? s.sn_size_week({ count: args.total, minutes, weekday })
      : s.sn_size_club({ count: args.unseeded, minutes });
  return [
    s.sn_title({ weekday }),
    args.anySeeded ? s.sn_unknown_most : s.sn_unknown_all,
    names ? s.sn_ask_named({ names, link: args.link }) : s.sn_ask({ link: args.link }),
    `${s.sn_never_seen} ${size}`,
    args.peerRatingsOn ? s.sn_learn : s.sn_change_any_time,
  ].join("\n\n");
}
