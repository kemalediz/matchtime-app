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
    },
  });
  if (!m) return;
  const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED");
  const bench = m.attendances.filter((a) => a.status === "BENCH");
  if (confirmed.length < m.maxPlayers) return;

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
