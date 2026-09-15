/**
 * "Squad full" announcement — one shared, idempotent helper called
 * from EVERY path that can confirm a player (a plain IN, a bench
 * claim, a promotion, a third-party registerFor). The moment the
 * confirmed count reaches the cap it posts ONE group message with
 * the full numbered line-up. Kemal 2026-05-19: "as soon as the squad
 * is full, MatchTime should announce it and display the players".
 *
 * Idempotency is atomic: we create the SentNotification (key is
 * @unique) FIRST — if that throws the row already exists, so another
 * concurrent confirm already announced and we skip. Only the winner
 * queues the BotJob. The dedupe is cleared on a confirmed-drop
 * (cancelAttendance) so each fill CYCLE announces once, not once per
 * match lifetime.
 */
import { db } from "./db";

export async function announceSquadFullIfJustFilled(
  matchId: string,
): Promise<void> {
  const m = await db.match.findUnique({
    where: { id: matchId },
    include: {
      activity: { select: { name: true, orgId: true } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        include: { user: { select: { name: true } } },
        orderBy: { position: "asc" },
      },
      teamAssignments: { select: { id: true }, take: 1 },
    },
  });
  if (!m) return;
  const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = m.attendances.filter((a) => a.status === "BENCH");
  if (confirmed.length < m.maxPlayers) return;

  // ── ONCE THE TEAMS ARE OUT, THE ROSTER IS NOT THE NEWS ─────────────
  //
  // 2026-09-15, Sutton FC. Teams were generated at 16:41 and announced.
  // At 19:14 Wasim dropped out — which cleared this function's dedupe key
  // (`attendance.ts`'s cancel path re-arms each fill CYCLE) — and at
  // 19:15 Shahrokh came in, putting the count back to 14 and firing this.
  // The group got the fourteen-name roster as a group post, one line
  // after the same fourteen names had gone out as a reply, an hour after
  // the line-ups.
  //
  // Kemal: "I agree there shouldn't be two messages, one after another,
  // saying the same information about the squad. And I don't think we
  // should even mention the squad because if the teams are generated, all
  // match time need to do is to declare the teams again."
  //
  // So with a sheet on the table this says nothing, and the replacement
  // post (`pipeline/compose.ts`'s `replacement_teams_post`) is the one
  // message. THE DEDUPE KEY IS NOT CLAIMED on this branch, deliberately:
  // a format switch deletes every assignment, and the squad that fills
  // again afterwards should still get its announcement.
  if (m.teamAssignments.length > 0) return;

  const key = `${matchId}:squad-locked`;
  // Atomic claim of the announcement — first writer wins.
  try {
    await db.sentNotification.create({
      data: { matchId, kind: "group-message", key },
    });
  } catch {
    return; // already announced this fill cycle
  }

  const kickoffLondon = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(m.date)
    .replace(/,/g, "");

  const roster = confirmed
    .map((a, i) => `${i + 1}. ${a.user.name ?? "(unnamed)"}`)
    .join("\n");
  // Bench shown in EVERY squad display, all orgs (Kemal 2026-06-12) —
  // a benched player scanning the "squad complete" post must see their
  // name rather than wonder if they were dropped.
  const benchBlock =
    bench.length > 0
      ? `\n\n*Bench (${bench.length}):*\n${bench
          .map((a, i) => `${i + 1}. ${a.user.name ?? "(unnamed)"}`)
          .join("\n")}`
      : "";

  await db.botJob.create({
    data: {
      orgId: m.activity.orgId,
      kind: "group",
      text:
        `✅ *Squad complete — ${m.maxPlayers}/${m.maxPlayers}* for *${m.activity.name}* on ${kickoffLondon} 🙌\n\n` +
        `*Playing:*\n${roster}${benchBlock}\n\nSee you all there ⚽`,
    },
  });
}
