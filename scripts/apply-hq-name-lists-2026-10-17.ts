/**
 * ONE-OFF (owner decision, 2026-10-17): apply FNF HQ's two lists from this
 * morning through the SAME code path as #311, silently.
 *
 *   1. "Yaseen\nMo\nFeroz\nAli\n\nOut"  (09:02 London)
 *   2. "Imti\nRafi\nAH\n\nIn"           (09:01 London)
 *
 * Out first, so the places are free. Each goes through
 * `handleAdminSquadChange` (route other_att, Hamzah as the organiser, the
 * list's facts from `hqNameListFacts`, no model), exactly as the live HQ
 * path does since #311. The reply it composes is PRINTED, never sent.
 * A ✅ on each original message is queued as a `RetroReaction`, which the
 * Pi places as `update-reaction` (the same `sendReaction` as the live HQ
 * tick; group @lid ids are supported). Nothing is posted anywhere.
 *
 * Idempotency: the live `admin-group-msg:<id>` claims already exist and are
 * left alone (only the claim is bypassed, never a business rule). This
 * script claims `ops-hq-list-apply:<id>` before applying, so a re-run
 * applies nothing twice; the ✅ is queued once per message.
 *
 *   npx tsx --env-file=.env scripts/apply-hq-name-lists-2026-10-17.ts          # dry run, reads only
 *   npx tsx --env-file=.env scripts/apply-hq-name-lists-2026-10-17.ts --apply
 */
import { db } from "../src/lib/db";
import { handleAdminSquadChange } from "../src/lib/admin-group-squad-change";
import { hqNameListFacts } from "../src/lib/admin-group-name-list";
import { loadSquadState } from "../src/lib/pipeline/load-state";
import { resolvePerson } from "../src/lib/pipeline/identity";

const ORG_ID = "cmv9nmp81000006l2iau88fig";
const MATCH_ID = "cmva7bzrl000206jnguvb6x9d";
const HAMZAH = "cmttuc9da000004l7brad84ac";
const MESSAGES = [
  { waMessageId: "false_120363046757382958@g.us_3A7E34B540C4D7C0A204_156345466617992@lid" },
  { waMessageId: "false_120363046757382958@g.us_3AF521CC3D8CB06A0210_156345466617992@lid" },
];
const APPLY = process.argv.includes("--apply");

async function main() {
  const org = await db.organisation.findUniqueOrThrow({ where: { id: ORG_ID }, select: { language: true, benchPickMode: true } });
  const sender = await db.user.findUniqueOrThrow({ where: { id: HAMZAH }, select: { name: true } });
  console.log(`${APPLY ? "APPLY" : "DRY RUN"}: org ${ORG_ID}, match ${MATCH_ID}, actor ${sender.name}, benchPickMode ${org.benchPickMode}`);

  // Simulated squad for the dry run: confirmed ids on the target match.
  const now = new Date();
  const state = await loadSquadState(ORG_ID, now);
  if (state.matchId !== MATCH_ID) throw new Error(`the engine would pick ${state.matchId}, not ${MATCH_ID}: stopping`);
  const confirmed = new Set(state.rows.filter((r) => r.status === "CONFIRMED").map((r) => r.userId));
  const nameOf = new Map(state.roster.map((m) => [m.userId, m.name]));
  console.log(`squad now: ${confirmed.size} of ${state.maxPlayers} confirmed`);

  for (const m of MESSAGES) {
    const row = await db.adminGroupMessage.findUniqueOrThrow({ where: { waMessageId: m.waMessageId } });
    if (row.orgId !== ORG_ID || row.senderUserId !== HAMZAH) throw new Error(`${m.waMessageId}: not Hamzah's FNF HQ message`);
    const facts = hqNameListFacts(row.text);
    if (!facts || facts.kind !== "attendance") throw new Error(`${m.waMessageId}: not a name list`);
    console.log(`\n== ${JSON.stringify(row.text)} (sent ${row.createdAt.toISOString()})`);

    // What the engine will do, read only: its resolver, then the alias the
    // provisioning resolver checks for a name it does not place.
    for (const c of facts.claims) {
      const r = resolvePerson(c.personRef, state.roster);
      let who: string | null = r.kind === "resolved" ? r.member.userId : null;
      let via = r.kind;
      if (!who && r.kind === "unknown") {
        const alias = await db.userAlias.findUnique({ where: { orgId_alias: { orgId: ORG_ID, alias: c.personRef.trim().toLowerCase() } } });
        who = alias?.userId ?? null;
        via = alias ? ("alias" as typeof via) : via;
      }
      const label = who ? `${nameOf.get(who) ?? who} (${who}, by ${via})` : `NOBODY (${via}): would be added as a new player`;
      let predicted: string;
      if (c.polarity === "out") {
        predicted = who && confirmed.has(who) ? "CONFIRMED -> DROPPED" : "no change (not playing)";
        if (who) confirmed.delete(who);
      } else {
        const room = confirmed.size < state.maxPlayers;
        predicted = who && confirmed.has(who) ? "already CONFIRMED" : room ? "-> CONFIRMED (admin actor, room)" : "-> BENCH (full)";
        if (who && room) confirmed.add(who);
      }
      console.log(`  ${c.polarity.toUpperCase().padEnd(3)} ${c.personRef.padEnd(7)} ${label}: ${predicted}`);
    }
    console.log(`  predicted after: ${confirmed.size} of ${state.maxPlayers}`);

    if (!APPLY) continue;

    try {
      await db.sentNotification.create({ data: { key: `ops-hq-list-apply:${m.waMessageId}`, kind: "admin-notice" } });
    } catch {
      console.log("  already applied by this script: skipped");
      continue;
    }
    const r = await handleAdminSquadChange({
      orgId: ORG_ID,
      lang: org.language,
      messageId: m.waMessageId,
      text: row.text,
      namedBody: row.text,
      senderUserId: HAMZAH,
      senderName: sender.name,
      sentAt: row.createdAt,
      now: new Date(),
      route: "other_att",
      addressed: false,
    });
    console.log(`  applied: ${JSON.stringify(r)}  (reply NOT sent)`);

    const dup = await db.retroReaction.findFirst({ where: { waMessageId: m.waMessageId, emoji: "✅" }, select: { id: true } });
    if (dup) console.log(`  ✅ already queued (${dup.id})`);
    else {
      const rr = await db.retroReaction.create({
        data: { orgId: ORG_ID, waMessageId: m.waMessageId, emoji: "✅", reason: "HQ name list applied 2026-10-17 (#311 one-off)" },
      });
      console.log(`  ✅ queued: RetroReaction ${rr.id}`);
    }
  }
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
