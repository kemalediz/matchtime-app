/**
 * Put back a player's number that a blank /welcome or /profile field wiped
 * (FNF 2026-10-18: Feroz). The number is read from the user's own
 * `wa-<digits>@placeholder.matchtime` email, which the bot stamped when it
 * created him from the group.
 *
 * DRY RUN by default. Pass --apply to write.
 *
 *   node --env-file=.env --import tsx scripts/restore-phone-from-placeholder.ts --user <id>
 *   node --env-file=.env --import tsx scripts/restore-phone-from-placeholder.ts --user <id> --apply
 *
 * Writes ONLY when all hold (src/lib/own-phone-rules.ts decidePhoneRestore):
 *   - the user's phoneNumber is NULL now;
 *   - the email's digits normalise to a valid E.164 number;
 *   - no other user holds that number.
 * The write is conditional on phoneNumber still being NULL, so a sign-in
 * or an admin edit in between is never overwritten. Numbers are masked in
 * the output.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { decidePhoneRestore, maskPhone } from "../src/lib/own-phone-rules.ts";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const i = args.indexOf("--user");
  const userId = i >= 0 ? args[i + 1] : undefined;
  if (!userId || userId.startsWith("--")) {
    console.error("usage: restore-phone-from-placeholder.ts --user <id> [--apply]");
    process.exit(1);
  }
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  } as never);

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phoneNumber: true },
    });
    if (!user) {
      console.error(`no user ${userId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${apply ? "APPLY" : "DRY RUN"}: user ${user.id} (${user.name ?? "no name"})`);

    const first = decidePhoneRestore({ user, holderId: null });
    if (first.kind === "skip") {
      console.log(`  skip: ${first.reason}${user.phoneNumber ? ` (has ${maskPhone(user.phoneNumber)})` : ""}`);
      return;
    }
    const holder = await db.user.findUnique({ where: { phoneNumber: first.phone }, select: { id: true } });
    const decision = decidePhoneRestore({ user, holderId: holder?.id ?? null });
    if (decision.kind === "skip") {
      console.log(`  skip: ${decision.reason} (${maskPhone(first.phone)} is held by another user)`);
      return;
    }

    console.log(`  would restore phoneNumber NULL -> ${maskPhone(decision.phone)}`);
    if (!apply) {
      console.log("  nothing written (pass --apply)");
      return;
    }
    const res = await db.user.updateMany({
      where: { id: user.id, phoneNumber: null },
      data: { phoneNumber: decision.phone },
    });
    console.log(res.count === 1 ? "  restored" : "  not written: the number changed since it was read");
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
