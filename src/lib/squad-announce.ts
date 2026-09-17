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
import { getOrgFeatures } from "./org-features";
import { buildSquadCompleteBenchInvite } from "./bench-offer-copy";
import { buildSquadCompletePost } from "./group-copy";

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

  // Keep the INs flowing once the squad is full (Kemal 2026-09-16: "When
  // squad complete, MT should just show the squad and ask for benchers").
  // Only with the bench feature on: without it the scheduler never posts
  // the bench tag, so the promise would be false. Same message, never a
  // second post. A failed lookup means no invite, not no post: the claim
  // above is already taken and nothing retries this announcement.
  const benchOn = await getOrgFeatures(m.activity.orgId)
    .then((f) => f.bench)
    .catch((err) => {
      console.error("[squad-announce] feature lookup failed, posting without bench invite:", err);
      return false;
    });
  // The words live in `group-copy.ts` (pure) so the golden snapshot can
  // pin them; this module owns the claim and the job.
  await db.botJob.create({
    data: {
      orgId: m.activity.orgId,
      kind: "group",
      text: buildSquadCompletePost({
        maxPlayers: m.maxPlayers,
        activityName: m.activity.name,
        kickoffLabel: kickoffLondon,
        confirmed: confirmed.map((a) => a.user.name),
        bench: bench.map((a) => a.user.name),
        benchInvite: benchOn ? buildSquadCompleteBenchInvite() : null,
      }),
    },
  });
}
