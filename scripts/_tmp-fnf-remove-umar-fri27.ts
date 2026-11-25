// One-off (2026-11-24, Kemal's instruction): take the existing Umar off FNF Fri 27 Nov's bench, exactly as
// the admin "remove from match" action does (row deleted + AttendanceEvent). Umar Noor stays. Dry run unless --apply.
import { db } from "../src/lib/db.ts";
import { recordAttendanceEvent } from "../src/lib/attendance-events.ts";

const ORG = "cmv9nmp81000006l2iau88fig";
const MATCH = "cmwo7qtr5003z08ktv7dcrtrh";
const UMAR = "cmva26474000006l9x0ave7yk";
const KEMAL = "cmn5vhtp2000004ifh4dqbsym";

async function main() {
  const row = await db.attendance.findUnique({ where: { matchId_userId: { matchId: MATCH, userId: UMAR } }, select: { status: true, position: true } });
  console.log("Umar row:", row);
  if (!row) return console.log("nothing to remove");
  if (!process.argv.includes("--apply")) return console.log("dry run");
  await db.$transaction(async (tx) => {
    await tx.attendance.deleteMany({ where: { matchId: MATCH, userId: UMAR } });
    await recordAttendanceEvent(
      tx,
      { matchId: MATCH, userId: UMAR, orgId: ORG, fromStatus: row.status, toStatus: null, fromPosition: row.position, toPosition: null },
      { cause: "admin-squad-edit", actorKind: "admin", actorUserId: KEMAL, sourceRef: "script:_tmp-fnf-remove-umar-fri27", note: "Kemal: Umar was booked by mistake for Umar Noor (2026-11-23)" },
    );
  });
  console.log("removed");
}
main().finally(() => db.$disconnect());
