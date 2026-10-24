/**
 * The offer page's "last 4 digits" lock under concurrency (local player
 * pool L5a, second review of #400, item 1). Runs under tsx against the
 * e2e database (the libs import the Prisma client, which Playwright's
 * transpiler cannot load); invoked by e2e/api/pool-verify-concurrency.spec.ts.
 *
 * 50 wrong guesses at once on ONE offer: exactly 5 are recorded and
 * answered "wrong", the other 45 "locked"; the right digits after that are
 * "locked" too. Without the per-offer lock every guess was checked.
 */
import assert from "node:assert/strict";
import { assertSafeTestDbUrl, E2E_DB_URL } from "./env";
import { MATCH, ORG_ID } from "./constants";

async function main() {
  const url = process.env.MT_E2E_DATABASE_URL ?? E2E_DB_URL;
  assertSafeTestDbUrl(url);
  process.env.DATABASE_URL = url;
  const { db } = await import("@/lib/db");
  const { checkOfferDigits } = await import("@/lib/pool/accept");
  const { POOL_OFFER_PROOF } = await import("@/lib/pool/offer-proof-rules");

  const n = Date.now();
  const user = await db.user.create({ data: { name: "Lock Test", email: `lock-${n}@e2e-test.invalid`, phoneNumber: `+44770099${String(n).slice(-4)}` } });
  const ask = await db.poolAsk.create({ data: { matchId: MATCH.upcoming, orgId: ORG_ID, places: 1, via: "page", status: "closed", closedAt: new Date() } });
  const offer = await db.poolOffer.create({
    data: { poolAskId: ask.id, matchId: MATCH.upcoming, orgId: ORG_ID, userId: user.id, distanceMiles: 1, expiresAt: new Date(Date.now() + 3600_000), sentAt: new Date() },
  });
  const right = user.phoneNumber!.slice(-4);
  const wrong = right === "0000" ? "1111" : "0000";

  const answers = await Promise.all(Array.from({ length: 50 }, () => checkOfferDigits(offer.id, wrong)));
  const count = (a: string) => answers.filter((x) => x === a).length;
  assert.equal(count("wrong"), POOL_OFFER_PROOF.wrongPerOfferPerDay, `wrong answers: ${count("wrong")}`);
  assert.equal(count("locked"), 50 - POOL_OFFER_PROOF.wrongPerOfferPerDay);
  assert.equal(await db.poolAttempt.count({ where: { kind: "offer-verify", key: offer.id } }), POOL_OFFER_PROOF.wrongPerOfferPerDay);
  assert.equal(await checkOfferDigits(offer.id, right), "locked");
  console.log("OK pool verify lock: 5 wrong, 45 locked, then the right digits locked too");
  process.exit(0);
}

main().catch((err) => {
  console.error("POOL-VERIFY-LIB-TESTS FAILED:", err);
  process.exit(1);
});
