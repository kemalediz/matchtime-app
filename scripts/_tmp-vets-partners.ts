// One-off (2026-11-08): Kemal asked to pair Monday night vets with Sutton FC and FNF, both ways,
// written directly as approved (no requests, no notices). FNF approves each Vets ask. Dry run unless --apply.
import { db } from "../src/lib/db.ts";

const KEMAL = "cmn5vhtp2000004ifh4dqbsym";
const VETS = "cmvzlm8km000707iihou1ut9h";
const SUTTON = "cmnnwhdx30000zfr85q18lyy9";
const FNF = "cmv9nmp81000006l2iau88fig";
const ROWS = [
  { askerOrgId: VETS, partnerOrgId: SUTTON, partnerApproval: "standing" },
  { askerOrgId: SUTTON, partnerOrgId: VETS, partnerApproval: "standing" },
  { askerOrgId: VETS, partnerOrgId: FNF, partnerApproval: "each-ask" },
  { askerOrgId: FNF, partnerOrgId: VETS, partnerApproval: "standing" },
];

async function main() {
  const now = new Date();
  const data = ROWS.map((r) => ({
    ...r,
    status: "active",
    origin: "owner",
    createdByUserId: KEMAL,
    askerAcceptedAt: now,
    askerAcceptedBy: KEMAL,
    partnerAcceptedAt: now,
    partnerAcceptedBy: KEMAL,
  }));
  console.log(data);
  if (!process.argv.includes("--apply")) return console.log("dry run");
  const r = await db.clubPartnership.createMany({ data, skipDuplicates: true });
  console.log(`created ${r.count}`);
}
main().finally(() => db.$disconnect());
