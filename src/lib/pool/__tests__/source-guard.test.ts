/**
 * SOURCE GUARDS for the local player pool (slice L1, 2026-10-24).
 * Plan: MDs/local-player-pool-plan-2026-10-23.md, section 6.
 *
 * 1. The pool's tables are read and written ONLY by the pool modules
 *    (`src/lib/pool/**`) and the superadmin pool dashboard
 *    (`src/app/admin/pool/**`). Everything else asks a pool module. So the
 *    privacy rules (who sees a pool player, when) live in one place and
 *    cannot be walked around with a bare `db.poolProfile.findMany`.
 *
 * 2. Nothing a model reads may come from the pool. Every file that calls
 *    the model, and every file that builds a model's context, is refused
 *    the pool's tables, the guest records, and any import of a pool
 *    module. A pool module that calls the model itself (the offer reply
 *    reader of slice L6, which reads only the person's own offer) must be
 *    named in `POOL_MODEL_READERS` below, on purpose, in review.
 *
 * 3. The seven unused `User.discoverableNearby*` / `homeArea*` /
 *    `nearbyRadiusKm` columns (added 2026-06-18, 0 users) stay unread until
 *    slice L11 drops them. The pool replaced them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..", "..");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__" || name === "__fixtures__") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
const FILES = walk(SRC).map((f) => ({ rel: rel(f), code: stripComments(readFileSync(f, "utf8")) }));

/** The pool's own tables (Prisma model names). */
const POOL_TABLES = [
  "PoolProfile",
  "PoolSport",
  "PoolAvailability",
  "PoolAsk",
  "PoolOffer",
  "PoolBlock",
  "PoolCampaign",
  "PoolAttempt",
  "PoolConsentRecord",
] as const;
/** Club-side records about guests: readable by club pages, never by a model. */
const GUEST_TABLES = ["GuestPlace", "ClubInvitation"] as const;

const accessorAlt = (tables: readonly string[]) =>
  tables.map((t) => t[0].toLowerCase() + t.slice(1)).flatMap((a) => [a, `${a}s`, a.replace(/y$/, "ies")]).join("|");
/** A Prisma accessor or relation key (`db.poolOffer`, `poolAsks: true`) or a raw SQL name (`"PoolOffer"`). */
const tableRef = (tables: readonly string[]) => new RegExp(`\\b(?:${accessorAlt(tables)})\\b|"(?:${tables.join("|")})"`);
const POOL_REF = tableRef(POOL_TABLES);
const GUEST_REF = tableRef(GUEST_TABLES);
const POOL_IMPORT = /from\s+["'](?:@\/lib\/pool\/|(?:\.{1,2}\/)+(?:lib\/)?pool\/)[^"']*["']|import\(\s*["'][^"']*\/pool\/[^"']*["']\s*\)/;

const isPoolHome = (r: string) => r.startsWith("lib/pool/") || r.startsWith("app/admin/pool/");

describe("the pool's tables are read only by the pool's own code", () => {
  it("no file outside src/lib/pool and the superadmin pool page names a pool table", () => {
    const offenders = FILES.filter((f) => !isPoolHome(f.rel) && POOL_REF.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the matcher is not vacuous", () => {
    expect(POOL_REF.test(`await db.poolProfile.findMany({})`)).toBe(true);
    expect(POOL_REF.test(`tx.poolOffer.create({ data })`)).toBe(true);
    expect(POOL_REF.test(`include: { poolAsks: true }`)).toBe(true);
    expect(POOL_REF.test(`db.poolAvailability.findMany()`)).toBe(true);
    expect(POOL_REF.test(`include: { availabilities: true, poolAvailabilities: true }`)).toBe(true);
    expect(POOL_REF.test(`SELECT * FROM "PoolOffer" WHERE 1`)).toBe(true);
    expect(POOL_REF.test(`org.featurePlayerPool && org.poolAutoAsk`)).toBe(false);
    expect(POOL_REF.test(`const pool = new Pool({ max: 2 })`)).toBe(false);
    expect(GUEST_REF.test(`db.guestPlace.findMany()`)).toBe(true);
    expect(GUEST_REF.test(`include: { clubInvitations: true }`)).toBe(true);
  });

  it("the scan reaches the pool's own modules (so it would see a reader there)", () => {
    expect(FILES.some((f) => f.rel === "lib/pool/sports.ts")).toBe(true);
  });
});

/** Files that build what a model reads, by name. Each must exist. */
const MODEL_CONTEXT_LOADERS = [
  "lib/dm-qa.ts",
  "lib/reply-context.ts",
  "lib/match-context.ts",
  "lib/match-history.ts",
  "lib/match-availability-context.ts",
  "lib/group-chat-history.ts",
  "lib/admin-group-context.ts",
  "lib/admin-group-question.ts",
  "lib/analyze-batch-context.ts",
];

/** Pool modules allowed to call the model. Empty until slice L6. */
const POOL_MODEL_READERS = new Set<string>([]);

const CALLS_MODEL = /getAnthropic\s*\(|from\s+["']@anthropic-ai\/sdk["']|from\s+["'](?:@\/lib\/pipeline\/llm|(?:\.{1,2}\/)+(?:pipeline\/)?llm)["']/;

const modelFacing = FILES.filter(
  (f) => MODEL_CONTEXT_LOADERS.includes(f.rel) || f.rel.startsWith("lib/pipeline/") || CALLS_MODEL.test(f.code),
);

describe("nothing a model reads comes from the pool", () => {
  it("every named context loader exists (so the list cannot rot into a vacuous pass)", () => {
    const missing = MODEL_CONTEXT_LOADERS.filter((r) => !FILES.some((f) => f.rel === r));
    expect(missing).toEqual([]);
  });

  it("finds the model-calling files", () => {
    expect(modelFacing.filter((f) => CALLS_MODEL.test(f.code)).length).toBeGreaterThan(5);
  });

  it("no model-facing file outside the pool names a pool or guest table, or imports a pool module", () => {
    const offenders = modelFacing
      .filter((f) => !f.rel.startsWith("lib/pool/"))
      .filter((f) => POOL_REF.test(f.code) || GUEST_REF.test(f.code) || POOL_IMPORT.test(f.code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("a pool module that calls the model is named in POOL_MODEL_READERS", () => {
    const readers = FILES.filter((f) => f.rel.startsWith("lib/pool/") && CALLS_MODEL.test(f.code)).map((f) => f.rel);
    expect(readers.filter((r) => !POOL_MODEL_READERS.has(r))).toEqual([]);
  });

  it("the pool import matcher is not vacuous", () => {
    expect(POOL_IMPORT.test(`import { x } from "@/lib/pool/rules";`)).toBe(true);
    expect(POOL_IMPORT.test(`import { x } from "./pool/rules";`)).toBe(true);
    expect(POOL_IMPORT.test(`import { x } from "../pool/sports";`)).toBe(true);
    expect(POOL_IMPORT.test(`const m = await import("@/lib/pool/offers");`)).toBe(true);
    expect(POOL_IMPORT.test(`import { x } from "@/lib/pooled-thing";`)).toBe(false);
  });
});

describe("the unused discoverable-nearby columns stay unread", () => {
  it("no file names them", () => {
    const re = /\b(discoverableNearby|discoverableNearbyAt|discoverableConsentVer|nearbyRadiusKm|homeAreaLabel|homeAreaLat|homeAreaLng)\b/;
    expect(FILES.filter((f) => re.test(f.code)).map((f) => f.rel)).toEqual([]);
  });
});

describe("the reply that may go to a number no User has (slice L2)", () => {
  // "pool-code-reply" is, with "otp", the only platform DM that skips the
  // known-number rule, because it only ever answers the number that just
  // sent a /play code. One queuer, which rate-limits it.
  it("is queued only by the confirm handler", () => {
    const users = FILES.filter((f) => /["']pool-code-reply["']/.test(f.code)).map((f) => f.rel);
    expect(users.sort()).toEqual(["lib/platform-jobs.ts", "lib/pool/confirm.ts"]);
  });
});
