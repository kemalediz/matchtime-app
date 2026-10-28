/**
 * THE ORGANISERS' LIST UPDATE (2026-10-14), pure, no Prisma.
 *
 * A club whose organisers announce the list and teams themselves
 * (`Organisation.listAnnouncer = "organisers"`, list-announcer.ts) gets
 * no squad post in its players' group. Every scheduled post that would
 * have listed the squad there is sent to the club's admin channel as THIS
 * message instead: written for the admins, built from the rows, never
 * from a model.
 *
 *   📋 *Squad for FNF, Fri 16 Oct at 20:30*: 16 of 18 in, 2 spaces.
 *   <why this went out now, when there is a reason worth saying>
 *
 *   <the roster block the group posts use>
 *
 *   💷 2 still to pay for the last match.      (only with a count)
 *
 *   MatchTime has not posted this in the players' group: ...
 */
import { VENUE_WORDS_OUTCOMES } from "./venue-from-words-rules";
import { buildSquadRosterBlock } from "./scheduler-copy";
import { ORGANISERS_SPACE_INTENT, displaysSquadState, stripSquadPostMarker, wantsSquadPost } from "./group-copy";
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";

export type OrganiserListReason =
  | "announce"
  | "evening"
  | "dropout-reminder"
  | "list-published"
  | "chase"
  | "squad-complete";

export function buildOrganiserListUpdate(args: {
  reason: OrganiserListReason;
  activityName: string;
  whenLabel: string;
  confirmed: Array<{ name: string | null }>;
  bench: Array<{ name: string | null }>;
  maxPlayers: number;
  /** The drop-out deadline's time ("21:00"), for "dropout-reminder". */
  dropOutTime?: string | null;
  /** Players still to pay for the last match, or null for no line. */
  unpaid?: number | null;
  /** The rolling announcement after a cancelled week (2026-10-24): the
   *  players left out because they said OUT for it. Empty, no line. */
  leftOut?: Array<{ name: string | null }> | null;
  lang: Lang | string | null | undefined;
}): string {
  const s = t(args.lang);
  const reasonLine = (() => {
    switch (args.reason) {
      case "announce":
        return s.oa_reason_announce;
      case "dropout-reminder":
        return args.dropOutTime ? s.oa_reason_dropout({ time: args.dropOutTime }) : null;
      case "list-published":
        return s.oa_reason_list_published;
      case "chase":
        return s.oa_reason_chase;
      case "squad-complete":
        return s.oa_reason_squad_complete;
      case "evening":
        return null;
    }
  })();
  const header = s.oa_header({
    activityName: args.activityName,
    whenLabel: args.whenLabel,
    confirmed: args.confirmed.length,
    maxPlayers: args.maxPlayers,
  });
  const parts = [reasonLine ? `${header}\n${reasonLine}` : header];
  parts.push(
    buildSquadRosterBlock({
      confirmed: args.confirmed,
      bench: args.bench,
      maxPlayers: args.maxPlayers,
      lang: args.lang as Lang,
    }),
  );
  if (args.leftOut && args.leftOut.length > 0) {
    parts.push(leftOutBlock(args.leftOut, args.lang));
  }
  if (args.unpaid != null && args.unpaid > 0) parts.push(s.oa_unpaid({ count: args.unpaid }));
  parts.push(s.oa_footer);
  return parts.join("\n\n");
}

function leftOutBlock(leftOut: Array<{ name: string | null }>, lang: Lang | string | null | undefined): string {
  const s = t(lang);
  return s.rolling_left_out_organisers({ names: leftOut.map((r) => r.name?.trim() || s.unnamed) });
}

/**
 * THE ORGANISERS' NOTICE OF WHO WAS LEFT OUT (2026-10-24, Kemal), on its
 * own, for a club where MatchTime posts the carried squad in the players'
 * group: the names are for the organisers only, never the group.
 */
export function buildRollingLeftOutNotice(args: {
  activityName: string;
  whenLabel: string;
  leftOut: Array<{ name: string | null }>;
  lang: Lang | string | null | undefined;
}): string {
  return `${t(args.lang).rolling_left_out_notice_lead(args)}\n\n${leftOutBlock(args.leftOut, args.lang)}`;
}

/**
 * A player-facing post that names who is in (a pick, a claimed place, a
 * format switch), relayed to the organisers instead of the group, with a
 * lead that says so. The post's own words are kept: they are already in
 * the club's language and already correct.
 */
export function buildOrganiserRelay(text: string, lang: Lang | string | null | undefined): string {
  return `${t(lang).oa_relay_lead}\n\n${text}`;
}

/**
 * THE LAST PASS OVER A REPLY TO THE PLAYERS' GROUP when the organisers
 * announce. The composer already says nothing about the squad in this
 * mode (pipeline/compose.ts); this is the net under every other path that
 * can still ask for the squad post (the `[SQUAD]` marker a pasted roster's
 * ack carries) or write one:
 *
 *   the marker alone        -> null (say nothing; the reaction stands);
 *   a lead plus the marker  -> the lead;
 *   a reply showing squad state -> "The organisers will post the list.";
 *   anything else           -> unchanged.
 */
export function organisersGroupReply(reply: string | null, lang: Lang | string | null | undefined): string | null {
  if (!reply) return reply;
  const wanted = wantsSquadPost(reply);
  const lead = wanted ? stripSquadPostMarker(reply) : reply;
  if (!lead) return null;
  if (displaysSquadState(lead, lang)) return t(lang).oa_list_by_organisers;
  return lead;
}

/**
 * PURE. Does the analyze route's organisers-mode pass leave a reply with
 * this intent alone? Decided by what composed the reply, never by reading
 * its words:
 *
 *   `help`                    the explainer, already written for this mode,
 *                             whose "Squad & availability" heading reads
 *                             like a squad post (2026-10-15);
 *   `ORGANISERS_SPACE_INTENT` "is there still space?": the open places and
 *                             how to ask for one, no names (2026-10-20);
 *   the pitch set by words    its numbered list of places is not a squad
 *                             (`VENUE_WORDS_OUTCOMES`, 2026-10-28).
 *
 * Everything else, the list answers included, still goes through
 * `organisersGroupReply`.
 */
export function passesOrganisersNet(intent: string | null | undefined): boolean {
  return intent === "help" || intent === ORGANISERS_SPACE_INTENT || (VENUE_WORDS_OUTCOMES as readonly string[]).includes(intent ?? "");
}
