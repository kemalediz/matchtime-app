/**
 * A FORM NOTE, FOR A DOOR THAT HAS NOT LOADED THE CLUB (2026-11-10).
 *
 * The teams extractor's `form`: a player tells MatchTime how they, or a
 * team-mate, will play in this match (tired, ill, injured, in form). Sutton
 * FC's "@Match Time reduce my strength for this match as I am quite tired."
 * was sent to the settings page. Nothing is written for it: the rating
 * adjuster (`rating-adjuster.ts`, run by `generateTeamsForMatch`) reads the
 * week's chat, this message included, when the teams are made.
 *
 * The players' group's team path already holds the club's features and
 * squad state and calls `formNoteReply` itself. This is the organisers'
 * group's way to the same line: it loads what the line depends on. Null
 * when MatchTime does not make this club's teams (`teamBalancing` off):
 * then nothing is said, as the players' group says nothing.
 */
import type { Lang } from "./i18n/lang";
import type { SquadState } from "./pipeline/types";
import { formNoteReply } from "./team-ops-engine";

export interface FormNoteDeps {
  loadFeatures?: (orgId: string) => Promise<{ teamBalancing: boolean }>;
  loadState?: (orgId: string, now: Date) => Promise<Pick<SquadState, "matchId" | "teams">>;
}

export async function formNoteReplyFor(args: {
  orgId: string;
  now: Date;
  lang?: Lang | string | null;
  deps?: FormNoteDeps;
}): Promise<string | null> {
  const loadFeatures =
    args.deps?.loadFeatures ?? (async (id: string) => (await import("./org-features")).getOrgFeatures(id));
  if (!(await loadFeatures(args.orgId)).teamBalancing) return null;
  const loadState =
    args.deps?.loadState ?? (async (id: string, now: Date) => (await import("./pipeline/load-state")).loadSquadState(id, now));
  const state = await loadState(args.orgId, args.now);
  return formNoteReply({ lang: args.lang, matchId: state.matchId, teamsMade: state.teams.length > 0 });
}
