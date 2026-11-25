// One-off (2026-11-02): Kemal approved the Vets (Monday night vets) setup: monthly squad, PAYG £8, collector Davide.
// Same writes as setMonthlySquad + setPaymentHolder, without the web session. Dry run unless --apply.
import { db } from "../src/lib/db.ts";
import { prepareMonthlySquadPatch } from "../src/lib/squad-month-rules.ts";

const ORG = "cmvzlm8km000707iihou1ut9h";
const DAVIDE = "cmvzll43z000607iiszrhkjlj";

async function main() {
  const prepared = prepareMonthlySquadPatch({ squadMode: "monthly", paygPricePence: 800 });
  if (!prepared.ok) throw new Error(prepared.error);
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId: DAVIDE, orgId: ORG } }, select: { role: true, user: { select: { phoneNumber: true } } } });
  console.log({ data: prepared.data, keys: prepared.keys, davide: m });
  if (!m?.user.phoneNumber) throw new Error("Davide not a member with a phone");
  if (!process.argv.includes("--apply")) return console.log("dry run");
  const row = await db.organisation.update({
    where: { id: ORG },
    data: { ...prepared.data, paymentHolderId: DAVIDE, settingsSetByOrganiser: { push: prepared.keys } },
    select: { squadMode: true, rollingSquadEnabled: true, paygPricePence: true, paymentHolderId: true, monthCreditRule: true, billingStatus: true },
  });
  console.log(row);
}
main().finally(() => db.$disconnect());
