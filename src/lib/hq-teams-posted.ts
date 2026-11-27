/**
 * THE ORGANISERS' OWN TEAMS, POSTED UNTAGGED IN HQ (Kemal, 2026-11-27).
 *
 * FNF HQ, Fri 27 Nov 2026: an admin wrote the night's two teams to the
 * other admins ("Captains:\n\nAlamgir, Yorel, ...\n\nImti, Mo, ..."),
 * untagged, then asked a human for the graphic. HQ is quiet unless tagged
 * (2026-10-31), so no model read it and MatchTime's TeamAssignment rows
 * stayed on its own earlier split. Kemal: "examine the messages going
 * forward to setup teams, this group is manually doing the teams, not
 * using MT".
 *
 * So an ORGANISER's untagged HQ message of a WEEKLY club whose ORGANISERS
 * announce the teams is read by the shared teams extractor (the one the
 * players' group and a tagged HQ message use, Haiku, cheap). Facts first,
 * and no model call unless they hold: a game for it (`postedTeamsGame`:
 * kicking off within 48 hours, not completed or cancelled, confirmed
 * players), and a message naming at least 4 different club members (the
 * name scan the CLUB MEMBERS NAMED line is built from, read once). Only
 * its "set" reading, both teams written out in the message, does
 * anything: `setPostedTeams` (team-proposal.ts) places every name on one
 * confirmed player by who-is-who and makes them the teams, final, if every
 * fact holds, and writes nothing otherwise. Every other reading ("swap
 * them", "show the teams", chat about the teams) is the organisers' own
 * conversation, as before: nothing done.
 *
 * SILENT, always: no reply, no tick, no poster, no team sheet, nothing in
 * the players' group. The outcome goes on the HQ row and the log (ids and
 * counts only).
 */
import { extractForRouteTraced } from "./pipeline/trace";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import { teamCommandFromFacts } from "./team-proposal-rules";
import { postedTeamsGame, setPostedTeams, type TeamProposalDeps } from "./team-proposal";
import { HQ_TEAMS_POSTED, HQ_TEAMS_POSTED_NOT_APPLIED, HQ_TEAMS_POSTED_SAME } from "./hq-teams-posted-rules";

/** The fewest different club members a posted sheet names before it is read. */
export const MIN_MEMBERS_NAMED = 4;

export interface PostedTeamsInput {
  orgId: string;
  messageId: string;
  /** The message as the readers see it (tags named, `nameMentions`). */
  body: () => Promise<string>;
  senderUserId: string;
  senderName: string | null;
  now: Date;
  /** The club members the message names (`membersNamedIn`): the cheap
   *  check before the model, and the CLUB MEMBERS NAMED line. */
  members: (body: string) => Promise<string[]>;
  deps?: { extractorModel?: PipelineModel; teams?: TeamProposalDeps };
}

/**
 * An organiser's untagged HQ message, read for the two teams. Null when it
 * is not the teams written out (or there is no game for them): nothing was
 * done and the message stays the organisers' own. Otherwise the outcome,
 * applied or not; never anything to say.
 */
export async function readPostedTeams(input: PostedTeamsInput): Promise<{ outcome: string } | null> {
  const { orgId, messageId, now } = input;
  const matchId = await postedTeamsGame(orgId, now, input.deps?.teams).catch(() => null);
  if (!matchId) return null;
  const body = await input.body();
  // Two teams name many players; "lol" or "who has the bibs" names few.
  // Fewer than 4 different members named: no model call (review of #638).
  const members = await input.members(body).catch(() => [] as string[]);
  if (new Set(members).size < MIN_MEMBERS_NAMED) return null;
  const model = input.deps?.extractorModel ?? extractorStubFromEnv() ?? anthropicModel();
  const extracted = await extractForRouteTraced("balancer", model, "balancer", {
    id: messageId,
    body,
    authorName: input.senderName,
    // Told truly: the organisers wrote it to each other.
    tagged: false,
    history: [],
    lastBotPost: null,
    members,
    now,
  }).catch(() => null);
  if (!extracted || extracted.facts.kind !== "teams") return null;
  const command = teamCommandFromFacts(extracted.facts);
  if (command.kind !== "set") return null;
  const r = await setPostedTeams({
    orgId,
    red: command.red,
    yellow: command.yellow,
    senderUserId: input.senderUserId,
    messageId,
    now,
    body,
    senderName: input.senderName,
    ...(input.deps?.teams ? { deps: input.deps.teams } : {}),
  });
  const outcome = !r.applied ? HQ_TEAMS_POSTED_NOT_APPLIED : r.outcome === "teams-posted-same" ? HQ_TEAMS_POSTED_SAME : HQ_TEAMS_POSTED;
  console.log(
    `[admin-group] ${messageId}: the organisers' own teams, untagged, on match ${matchId} (${command.red.length} v ${command.yellow.length}): ${outcome}${r.applied ? "" : ` (${r.outcome})`}, silent`,
  );
  return { outcome };
}
