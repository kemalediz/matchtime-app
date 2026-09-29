/**
 * Pieces of /admin/players, split out so they can be rendered in a unit
 * test (`__tests__/banner-and-rating-cell.test.ts`,
 * `__tests__/duplicate-suggestions-banner.test.ts`).
 *
 * Both take their copy from the string table, so they follow the club's
 * language like the seed editor's hint does.
 */
import { Sparkles, GitMerge } from "lucide-react";
import { t } from "@/lib/i18n/t";
import type { Lang } from "@/lib/i18n/lang";
import type { DuplicateSuggestion } from "@/lib/placeholder-link-rules";

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

/**
 * Possible duplicates (2026-09-29): a placeholder a third party's "X in"
 * created, beside a member with a phone and a matching name. group-join
 * merges the unambiguous case itself; these are the ones it left for the
 * admin. One tap merges the placeholder INTO the phone member.
 */
export function DuplicateSuggestionsBanner({
  suggestions,
  lang,
  onMerge,
}: {
  suggestions: DuplicateSuggestion[];
  lang: Lang;
  onMerge: (dropId: string, keepId: string) => void;
}) {
  if (suggestions.length === 0) return null;
  const s = t(lang);
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <GitMerge className="w-4 h-4 text-blue-600" />
        <p className="font-semibold text-blue-900">{s.admin_players_duplicates_heading}</p>
      </div>
      <ul className="space-y-2">
        {suggestions.map((d) => {
          const placeholder = d.placeholderName ?? "?";
          const keeper = d.keepName ?? "?";
          return (
            <li key={`${d.placeholderId}-${d.keepId}`} className="flex flex-wrap items-center gap-2 text-sm text-blue-900">
              <span className="min-w-0">{s.admin_players_duplicate_row({ placeholder, keeper })}</span>
              <button
                onClick={() => onMerge(d.placeholderId, d.keepId)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
              >
                <GitMerge className="w-3 h-3" /> {s.admin_players_duplicate_merge({ keeper })}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
