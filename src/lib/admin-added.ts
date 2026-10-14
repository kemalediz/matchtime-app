/**
 * WHO DID AN ADMIN ADD TO A SQUAD? (2026-10-14.)
 *
 * The rolling squad carries last week's players, but not a phoneless
 * placeholder: that is usually a one-off guest a player registered ("my
 * mate Gary is in"), who cannot be DMed and was never asked. A phoneless
 * player an ADMIN added (a name pasted in the admin group and confirmed,
 * an admin-group squad change, an admin's edit on the match page) is a
 * deliberate member and is carried. The club rehearsal found "Uncle",
 * pasted by an admin in week 1, dropped from week 2 because nothing told
 * the two apart.
 *
 * The durable marker is the append-only AttendanceEvent log, not a new
 * column: an admin putting this player on a squad of THIS club at any
 * time, with an admin cause:
 *
 *   actorKind  "admin"
 *   cause      "admin-message" (admin group, or an admin's instruction in
 *              the players' group) or "admin-squad-edit" (an admin
 *              screen)
 *   toStatus   CONFIRMED or BENCH (an add, not a removal)
 *
 * NOT counted: "rolling-squad" with actorKind "admin" (the Carry over
 * button carries whoever it carries, guests included, so it says nothing
 * about who the player is), and "organiser-pick" (bringing in somebody
 * already on the waiting list, possibly a guest a player registered).
 * The log is never updated or deleted (a Postgres trigger), so once added
 * by an admin, always added by an admin, including the week after, when
 * last week's row was itself written by the seeding.
 */

/** The causes that mean "an admin put this player on the squad". */
export const ADMIN_ADD_CAUSES = ["admin-message", "admin-squad-edit"] as const;

/** The part of the Prisma client (or of a transaction) this reads through. */
export interface AdminAddedReadClient {
  attendanceEvent: {
    findMany(args: {
      where: {
        orgId: string;
        userId: { in: string[] };
        actorKind: "admin";
        cause: { in: string[] };
        toStatus: { in: Array<"CONFIRMED" | "BENCH"> };
      };
      select: { userId: true };
      distinct: ["userId"];
    }): Promise<Array<{ userId: string }>>;
  };
}

/** Of `userIds`, the ones an admin has added to a squad of `orgId`. */
export async function loadAdminAddedUserIds(
  client: AdminAddedReadClient,
  orgId: string,
  userIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Set();
  const rows = await client.attendanceEvent.findMany({
    where: {
      orgId,
      userId: { in: ids },
      actorKind: "admin",
      cause: { in: [...ADMIN_ADD_CAUSES] },
      toStatus: { in: ["CONFIRMED", "BENCH"] },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  return new Set(rows.map((r) => r.userId));
}
