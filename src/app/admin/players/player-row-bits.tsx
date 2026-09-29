/**
 * Two pieces of /admin/players, split out so they can be rendered in a
 * unit test (`__tests__/banner-and-rating-cell.test.ts`).
 *
 * Both take their copy from the string table, so they follow the club's
 * language like the seed editor's hint does.
 */
import { Sparkles } from "lucide-react";
import { t } from "@/lib/i18n/t";
import type { Lang } from "@/lib/i18n/lang";

/**
 * The banner over members the bot auto-added from the group.
 *
 * The body is one string from the table with the names inside it. It
 * used to be `{names.join(", ")}` followed by the rest of the sentence
 * in JSX, and Kemal saw it render as "Hamzahposted in the group".
 */
export function ProvisionalPlayersBanner({
  names,
  count,
  lang,
}: {
  /** The named ones; a member with no name yet is counted but not listed. */
  names: string[];
  /** How many new members there are. Defaults to the number of names. */
  count?: number;
  lang: Lang;
}) {
  const n = count ?? names.length;
  if (n === 0) return null;
  const s = t(lang);
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-amber-600" />
        <p className="font-semibold text-amber-900">{s.admin_players_new_heading({ count: n })}</p>
      </div>
      <p className="text-sm text-amber-800">{s.admin_players_new_body({ names })}</p>
    </div>
  );
}

/**
 * The club's rating of one player: the number the player sees on their
 * own page (`clubDisplayRating`), or "Not rated yet". Never the seed,
 * which has its own editable column beside this one.
 */
export function ClubRatingCell({
  rating,
  ratedGames,
  lang,
}: {
  rating: number | null;
  ratedGames: number;
  lang: Lang;
}) {
  const s = t(lang);
  if (rating === null) {
    return (
      <span className="text-xs text-slate-400 text-center leading-tight" title={s.admin_players_club_rating_hint}>
        {s.admin_players_not_rated_yet}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-center leading-tight" title={s.admin_players_club_rating_hint}>
      <span className="text-sm font-semibold text-slate-800">{rating.toFixed(1)}</span>
      <span className="text-[10px] text-slate-500">{s.admin_players_rated_games({ count: ratedGames })}</span>
    </span>
  );
}
