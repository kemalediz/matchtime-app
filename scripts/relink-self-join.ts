/**
 * ONE-OFF: move a self-join request linked on weak evidence to the
 * organiser's own group (2026-10-15, the FNF incident).
 *
 * FNF's request (ref UYS5) was linked to the community's PARENT group
 * ("FNF ⚽️", 8 members, adderMatch other-organiser-present) instead of the
 * organiser's main chat ("Friday Night Football 🏟", 49 members). The live
 * code now moves such a request itself when the organiser's add arrives;
 * this corrects the one that happened before that code shipped, with the
 * SAME rule and the SAME move (src/lib/relink-self-join.ts ->
 * group-add.ts `relinkToOrganiserGroup` and `queueOwnerDmForLink`). No
 * hand-written SQL.
 *
 * It refuses unless the club is still pending, the request was linked on
 * weak evidence, the adder you name is the request's organiser, and
 * MatchTime is known to be in the target group since the request was
 * issued (a postability reading the Pi reported, or a recorded add).
 *
 * Dry run (prints what it would change, writes nothing):
 *   npx tsx --env-file=.env scripts/relink-self-join.ts \
 *     --connect cmv9nndt7000006jtuen9m0sc \
 *     --group 447961809174-1596025435@g.us \
 *     --subject "Friday Night Football 🏟" --members 49 \
 *     --adder-phone 447376548222
 *
 * Then the same with --apply. --allow-late lets a weak link older than the
 * 24-hour upgrade window be moved. Prints group ids, names, member counts
 * and the club ref; never message text.
 */
import { runRelinkSelfJoin, type RelinkArgs } from "../src/lib/relink-self-join.ts";
import { db } from "../src/lib/db.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

function usage(problem: string): never {
  console.error(`relink-self-join: ${problem}`);
  console.error(
    "usage: npx tsx --env-file=.env scripts/relink-self-join.ts --connect <id> --group <jid@g.us> " +
      '--subject "<group name>" --members <n> (--adder-phone <digits> | --adder-lid <digits>) [--allow-late] [--apply]',
  );
  process.exit(2);
}

async function main() {
  const connectId = arg("connect");
  const groupId = arg("group");
  const subject = arg("subject");
  const members = Number(arg("members"));
  const adderPhone = arg("adder-phone");
  const adderLid = arg("adder-lid");
  if (!connectId) usage("--connect is required");
  if (!groupId || !groupId.endsWith("@g.us")) usage("--group must be a group JID ending @g.us");
  if (!Number.isInteger(members) || members < 0) usage("--members must be a whole number");
  if (!adderPhone && !adderLid) usage("--adder-phone or --adder-lid is required: the organiser's add, as the log named them");

  const args: RelinkArgs = {
    connectId,
    groupId,
    subject: subject?.trim() || null,
    memberCount: members,
    adderPhone,
    adderLid,
    allowLate: process.argv.includes("--allow-late"),
  };
  const apply = process.argv.includes("--apply");
  const { plan } = await runRelinkSelfJoin(args, { apply });
  process.exitCode = plan.ok ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("relink-self-join failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
