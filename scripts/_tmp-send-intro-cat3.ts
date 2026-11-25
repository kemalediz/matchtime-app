/**
 * ONE-OFF (not committed): DM Kemal his six intro messages through the
 * owner DM door (queueOwnerDm, PlatformJob kind "dm"), which only ever
 * writes to the SELF_JOIN_APPROVER_PHONES numbers.
 *
 *   npx tsx scripts/_tmp-send-intro-messages.ts           # dry run, prints
 *   npx tsx scripts/_tmp-send-intro-messages.ts --send    # queues
 */
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { parseApproverPhones, queueOwnerDm } from "../src/lib/owner-dm";

const COPY =
  "/private/tmp/claude-501/-Users-kemal-Projects-Cressoft-Sports-matchtime/53efc5e1-1f7c-48ce-a74b-cc3c6361bf47/scratchpad/intro-cat3-v2.md";

function messages(): string[] {
  const src = readFileSync(COPY, "utf8");
  const parts = src.split(/^=====$/m);
  // parts: [pre, msg, between, msg, between, ...]
  const out: string[] = [];
  for (let i = 1; i < parts.length; i += 2) out.push(parts[i].replace(/^\n/, "").replace(/\n$/, ""));
  if (out.length !== 4) throw new Error(`expected 4 messages, got ${out.length}`);
  return out;
}

async function main() {
  const send = process.argv.includes("--send");
  const phones = parseApproverPhones(process.env.SELF_JOIN_APPROVER_PHONES);
  if (phones.length !== 1 || phones[0] !== "447525334985") throw new Error(`unexpected approvers ${JSON.stringify(phones)}`);
  const user = await db.user.findFirst({ where: { phoneNumber: `+${phones[0]}` }, select: { id: true, name: true, phoneNumber: true } });
  console.log("recipient:", user, "jid:", `${phones[0]}@c.us`);
  const first =
    "Your MatchTime intro messages: 1 football groups that don't know MatchTime, 2 non-football groups, 3 clubs already using MatchTime";
  const texts = messages();
  console.log(`jobs: ${texts.length}`);
  texts.forEach((t, i) => console.log(`--- ${i} (${t.length} chars)\n${t}\n`));
  if (!send) return;
  for (let i = 0; i < texts.length; i++) {
    const r = await queueOwnerDm(texts[i], "owner-ack", `intro-cat3v2:2026-10-29:${i}`);
    console.log(i, r);
    await new Promise((res) => setTimeout(res, 50));
  }
  const rows = await db.platformJob.findMany({
    where: { refId: { startsWith: "intro-cat3v2:2026-10-29:" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, phone: true, refId: true, status: true, createdAt: true },
  });
  console.table(rows);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
