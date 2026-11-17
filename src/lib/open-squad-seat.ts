/**
 * AN OPEN SQUAD'S LATE IN, SEATED AND ANNOUNCED (review of #623,
 * open-squad.ts). For every IN that does not come through the engine (the
 * match page, a friend link, the pool, a guest card, a pasted list): once
 * the teams are made, he takes a slot a player who is out still holds,
 * else joins the smaller side (`seatOpenSquadArrivals`, under the slot
 * lock), and the group gets ONE post: who joined which side, then the
 * whole sheet again with him marked, the replacement post's shape. A club
 * whose organisers announce the list hears it in the admin channel.
 *
 * The engine's own path seats and announces in its own writes and post
 * (`team_slot_join`), and calls the write with `seatOnTeams: false`.
 * A drop seats nobody and moves nobody: no rebalance.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { formatTeamsPost, teamSheetNames } from "./group-copy";
import { resolveTeamLabels } from "./team-labels";
import { formatLondon } from "./london-time";
import { loadPlayerNames } from "./player-display-name";
import { organisersAnnounce } from "./list-announcer";
import { DEFAULT_SEED_RATING } from "./default-seed";
import { seatOpenSquadArrivals, type SlotFillTx } from "./team-slot-fill";

export async function seatOpenSquadLateIns(matchId: string): Promise<{ seated: number }> {
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      teamLabels: true,
      _count: { select: { teamAssignments: true } },
      activity: {
        select: {
          orgId: true,
          venue: true,
          sport: { select: { teamLabels: true } },
          org: { select: { openSquad: true, language: true, listAnnouncer: true, teamLabels: true } },
        },
      },
    },
  });
  if (!match || match.activity.org?.openSquad !== true || match._count.teamAssignments === 0) return { seated: 0 };
  const orgId = match.activity.orgId;
  const confirmed = await db.attendance.findMany({ where: { matchId, status: "CONFIRMED" }, select: { userId: true } });
  const { clubRatingsFor } = await import("./team-generation");
  const ratings = await clubRatingsFor(orgId, confirmed.map((c) => c.userId));
  const done = await db.$transaction((tx) =>
    seatOpenSquadArrivals(tx as unknown as SlotFillTx, matchId, (id) => ratings.get(id) ?? DEFAULT_SEED_RATING),
  );
  const seated = done.moves.length + done.joins.length;
  if (seated === 0) return { seated: 0 };
  console.log(`[open-squad] match=${matchId} seated ${done.joins.map((j) => `${j.userId}:${j.team}`).concat(done.moves.map((m) => `${m.toUserId}<-${m.fromUserId}`)).join(",")}`);

  // The post: the lead, then the sheet as it now stands, with each new
  // name marked.
  const org = match.activity.org;
  const lang = org?.language ?? null;
  const s = t(lang);
  const sheet = await db.teamAssignment.findMany({ where: { matchId }, orderBy: { id: "asc" }, select: { userId: true, team: true } });
  const playing = new Set((await db.attendance.findMany({ where: { matchId, status: "CONFIRMED" }, select: { userId: true } })).map((r) => r.userId));
  const ids = [...new Set([...sheet.map((r) => r.userId), ...done.moves.map((m) => m.fromUserId)])];
  const names = await loadPlayerNames(orgId, ids, lang);
  const nameOf = (id: string) => names.get(id)?.display ?? names.get(id)?.name ?? s.unnamed;
  const first = (id: string) => nameOf(id).split(" ")[0];
  const [redLabel, yellowLabel] = resolveTeamLabels(match, org, match.activity.sport, lang);
  const label = (team: string) => (team === "RED" ? redLabel : yellowLabel);
  const noteFor = new Map<string, string>([
    ...done.moves.map((m) => [nameOf(m.toUserId), s.replacement_note({ from: first(m.fromUserId) })] as [string, string]),
    ...done.joins.map((j) => [nameOf(j.userId), s.os_join_note] as [string, string]),
  ]);
  const sides = teamSheetNames(sheet.map((r) => ({ userId: r.userId, team: r.team, name: nameOf(r.userId) })), playing, lang);
  const withNotes = (list: string[]) => list.map((n) => ({ name: n, note: noteFor.get(n) }));
  const leads: string[] = [];
  if (done.moves.length > 0) {
    leads.push(
      s.replacement_lead({
        outNames: done.moves.filter((m) => !playing.has(m.fromUserId)).map((m) => first(m.fromUserId)),
        swaps: done.moves.map((m) => ({ inName: first(m.toUserId), outName: first(m.fromUserId), teamLabel: label(m.team) })),
      }),
    );
  }
  if (done.joins.length > 0) leads.push(s.os_join_lead({ joins: done.joins.map((j) => ({ name: first(j.userId), teamLabel: label(j.team) })) }));
  const text =
    `${leads.join("\n")}\n\n` +
    formatTeamsPost({
      redLabel,
      yellowLabel,
      red: withNotes(sides.red),
      yellow: withNotes(sides.yellow),
      kickoff: formatLondon(match.date, "HH:mm"),
      venue: match.activity.venue,
      lang,
      footer: s.teams_post_footer_after_replacement,
    });

  if (organisersAnnounce(org)) {
    const { sendAdminNotice } = await import("./admin-channel");
    await sendAdminNotice({ orgId, text, now: new Date() });
  } else {
    await db.botJob.create({ data: { orgId, kind: "group", matchId, text } });
  }
  return { seated };
}
