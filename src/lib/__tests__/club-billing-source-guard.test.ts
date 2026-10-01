/**
 * ONE WRITER FOR `billingStatus` (club fee billing, plan section 4.2).
 *
 * `Organisation.billingStatus` is a GATE: "paused" makes MatchTime quiet
 * for a club. It is written only by `setBillingState` in
 * src/lib/club-billing.ts, and read as a filter only through the gate
 * helpers (club-billing-rules.ts, club-approval-state.ts, club-approval.ts).
 * Anywhere else the only legal mentions as a key are `billingStatus: true`
 * in a Prisma `select` and a type annotation. A `data: { billingStatus }`
 * in some route would be a second writer racing the compare-and-set, and
 * an ad-hoc `where: { billingStatus: ... }` a second idea of "paused" that
 * ignores the BILLING_ENABLED kill switch.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const ALLOWED = new Set([
  path.join(SRC, "lib", "club-billing.ts"),
  path.join(SRC, "lib", "club-billing-rules.ts"),
  path.join(SRC, "lib", "club-approval-state.ts"),
  path.join(SRC, "lib", "club-approval.ts"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("billingStatus has one writer", () => {
  it("no source file outside the billing gate uses billingStatus as a key, except a select or a type", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (ALLOWED.has(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const keyed = /\bbillingStatus\??\s*:/.test(line) && !/\bbillingStatus\??\s*:\s*(true|string)\b/.test(line);
        // Shorthand in an object literal: `{ billingStatus }` or `{ ..., billingStatus, ... }`.
        const shorthand = /[{,]\s*billingStatus\s*[,}]/.test(line);
        // Raw SQL naming the column.
        const rawSql = /"billingStatus"/.test(line);
        if (keyed || shorthand || rawSql) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("only club-billing.ts writes it (data: { billingStatus ... })", () => {
    const writers = [...ALLOWED].filter((f) => /data:\s*\{\s*billingStatus\b/.test(readFileSync(f, "utf8")));
    expect(writers).toEqual([path.join(SRC, "lib", "club-billing.ts")]);
  });

  it("the scan can see club-billing.ts (so the test is not vacuous)", () => {
    expect(walk(SRC)).toContain(path.join(SRC, "lib", "club-billing.ts"));
  });
});

describe("slice B3: billing DMs have one queuer, and the club fee never touches Connect", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it('only club-billing.ts queues a purpose "billing" DM (through queueBillingDm)', () => {
    const queuers = walk(SRC).filter((f) => /purpose:\s*["']billing["']/.test(strip(readFileSync(f, "utf8"))));
    expect(queuers.map((f) => path.relative(SRC, f))).toEqual([path.join("lib", "club-billing.ts")]);
  });

  it("the club fee Stripe code never passes a Connect account, an application fee or a transfer", () => {
    for (const rel of ["lib/stripe-billing.ts", "lib/stripe-billing-fake.ts", "lib/club-billing-stripe.ts", "app/api/stripe/billing-webhook/route.ts"]) {
      const src = strip(readFileSync(path.join(SRC, rel), "utf8"));
      expect(src, rel).not.toMatch(/stripeAccount|application_fee|transfer_data|on_behalf_of/);
    }
  });

  it("the club fee Stripe code never puts matchId or userId in metadata", () => {
    for (const rel of ["lib/stripe-billing.ts", "lib/club-billing-stripe.ts"]) {
      const src = strip(readFileSync(path.join(SRC, rel), "utf8"));
      expect(src, rel).not.toMatch(/\bmatchId\b/);
      expect(src, rel).not.toMatch(/metadata:\s*\{[^}]*\buserId\b/);
    }
  });

  it("the billing webhook route verifies with its own secret, never the Connect helper", () => {
    const src = strip(readFileSync(path.join(SRC, "app/api/stripe/billing-webhook/route.ts"), "utf8"));
    expect(src).toMatch(/verifyBillingWebhook/);
    expect(src).not.toMatch(/constructWebhookEvent|STRIPE_WEBHOOK_SECRET\b/);
  });
});
