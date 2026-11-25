// One-off (2026-11-17, Kemal: "get this fixed yes"): add Abu Ayoub as a new
// player of Sutton Football Club and confirm him for tonight's match, the way
// the admin "add player to match" action does. Dry run unless --apply.
import { db } from "../src/lib/db.ts";
import { recordAttendanceEvent } from "../src/lib/attendance-events.ts";

const ORG = "cmnnwhdx30000zfr85q18lyy9"; // Sutton Football Club
const MATCH = "cmtbrqkro0002009k6zyrwdmg"; // Tue 17 Nov 21:15
const KEMAL = "cmn5vhtp2000004ifh4dqbsym";
const NAME = "Abu Ayoub";
const PHONE = "+447596951851";

async function main() {
  const match = await db.match.findUnique({ where: { id: MATCH }, select: { maxPlayers: true, status: true } });
  const confirmed = await db.attendance.count({ where: { matchId: MATCH, status: "CONFIRMED" } });
  const existing = await db.user.findUnique({ where: { phoneNumber: PHONE }, select: { id: true, name: true } });
  const status = confirmed < (match?.maxPlayers ?? 0) ? "CONFIRMED" : "BENCH";
  console.log({ match, confirmed, existing, status });
  if (existing) throw new Error("a user with this phone already exists; stopping");
  if (match?.status !== "UPCOMING") throw new Error("match is not UPCOMING; stopping");
  if (!process.argv.includes("--apply")) return console.log("dry run");

  const out = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name: NAME, email: `wa-${PHONE.replace(/^\+/, "")}@placeholder.matchtime`, phoneNumber: PHONE, onboarded: false, isActive: true },
      select: { id: true },
    });
    await tx.membership.create({ data: { userId: user.id, orgId: ORG, role: "PLAYER" } });
    const last = await tx.attendance.findFirst({ where: { matchId: MATCH, status }, orderBy: { position: "desc" }, select: { position: true } });
    const row = await tx.attendance.create({ data: { matchId: MATCH, userId: user.id, status, position: (last?.position ?? 0) + 1 } });
    await recordAttendanceEvent(
      tx,
      { matchId: MATCH, userId: user.id, orgId: ORG, fromStatus: null, toStatus: row.status, fromPosition: null, toPosition: row.position },
      { cause: "admin-squad-edit", actorKind: "admin", actorUserId: KEMAL, sourceRef: "script:_tmp-add-abu-ayoub", note: "Kemal asked in chat; MatchTime's name check stalled on an unsure match" },
    );
    return { userId: user.id, status: row.status, position: row.position };
  });
  console.log("done", out);
}
main().finally(() => db.$disconnect());
