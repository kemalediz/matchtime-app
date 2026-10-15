/**
 * MATCHTIME'S INTRODUCTION FOR AN ADMIN GROUP LINKED BEFORE IT EXISTED
 * (2026-10-15). A group linked from now on gets it as the link command's
 * reply. One linked earlier (FNF HQ got only "✅ Linked as the admin group
 * for FNF.") gets the SAME text, built by the same builder
 * (`buildAdminGroupIntro`), from this script.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/send-hq-intro.ts --org <orgId>           # dry run
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/send-hq-intro.ts --org <orgId> --apply   # queue it
 *
 * DRY RUN BY DEFAULT: prints the exact text and the group it would go to,
 * writes nothing. With --apply it claims `hq-intro:<orgId>:<groupId>` (the
 * key the link command claims) and queues ONE `admin-group` BotJob, which
 * the next due-posts poll posts in the admin group between 09:00 and 22:59
 * London (admin-channel.ts `adminGroupJobInstruction`).
 *
 *   ... --org <orgId> --mark-sent            # dry run: would only claim the key
 *   ... --org <orgId> --mark-sent --apply    # claim the key, send nothing
 *
 * --mark-sent is for a group whose introduction was posted BY HAND (FNF HQ,
 * 2026-10-15): it claims the same key and queues no message, so neither
 * this script nor a re-link can ever send it.
 *
 * REFUSES (and sends nothing) when the club has no linked admin group, its
 * admin messages do not go to that group, MatchTime cannot post there, or
 * the club was already introduced in that group. See
 * src/lib/admin-group-intro.ts `sendHqIntro`.
 */
import { db } from "../src/lib/db.ts";
import { sendHqIntro } from "../src/lib/admin-group-intro.ts";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<number> {
  const orgId = argValue("--org");
  const apply = process.argv.includes("--apply");
  const markSent = process.argv.includes("--mark-sent");
  if (!orgId) {
    console.error("Usage: scripts/send-hq-intro.ts --org <orgId> [--mark-sent] [--apply]");
    return 2;
  }
  const r = await sendHqIntro({ orgId, apply, markSent });
  const what = markSent ? "claim the key only, no message" : "queue the intro";
  console.log(`mode:   ${apply ? `APPLY (${what})` : `dry run (nothing written; add --apply to ${what})`}`);
  console.log(`org:    ${r.orgId}${"club" in r ? ` (${r.club})` : ""}`);
  if ("groupId" in r) console.log(`group:  ${r.groupId}`);
  if ("key" in r) console.log(`key:    ${r.key}`);
  console.log(`status: ${r.status}${r.status === "refused" ? ` (${r.reason})` : ""}${r.status === "queued" ? ` as BotJob ${r.jobId}` : ""}${r.status === "marked" ? " (key claimed, nothing queued)" : ""}`);
  if (r.text) {
    console.log(`\n----- text${r.status === "refused" ? " (NOT sent)" : ""} -----\n${r.text}\n----- end -----`);
  }
  return r.status === "refused" ? 1 : 0;
}

main()
  .then(async (code) => {
    await db.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
