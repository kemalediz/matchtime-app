/**
 * THE UNUSED "NEARBY PLAYERS" COLUMNS ARE RETIRED, AND MUST NOT COME BACK.
 *
 * Slice L11 of MDs/local-player-pool-plan-2026-10-23.md. Seven `User`
 * columns were added on 2026-06-18 for a cross-club "nearby players"
 * opt-in that was never built: `discoverableNearby`, `discoverableNearbyAt`,
 * `discoverableConsentVer`, `nearbyRadiusKm`, `homeAreaLabel`,
 * `homeAreaLat`, `homeAreaLng`. No code ever read or wrote them and no user
 * ever had one set (prod, read-only, 2026-10-24: 0 of 186). The local
 * player pool (`PoolProfile` and friends, with its own consent record)
 * replaced them.
 *
 * They are off the Prisma model, so the compiler refuses any read or write
 * of them through the client. What the compiler cannot catch is the model
 * growing them back, or raw SQL naming them. This guards both. The DB
 * columns themselves are dropped by the separate, hand-applied migration
 * `prisma/migrations/20261027090000_drop_discoverable_nearby/`, the one
 * file (with this test) allowed to name them.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SCHEMA = path.join(ROOT, "prisma/schema.prisma");
const THIS_FILE = path.relative(ROOT, __filename).split(path.sep).join("/");

const RETIRED_USER_COLUMNS = [
  "discoverableNearby",
  "discoverableNearbyAt",
  "discoverableConsentVer",
  "nearbyRadiusKm",
  "homeAreaLabel",
  "homeAreaLat",
  "homeAreaLng",
] as const;

const NAMES = new RegExp(`\\b(${RETIRED_USER_COLUMNS.join("|")})\\b`);

function modelBlock(schema: string, model: string): string | null {
  const start = schema.indexOf(`model ${model} {`);
  if (start === -1) return null;
  const end = schema.indexOf("\n}", start);
  return end === -1 ? schema.slice(start) : schema.slice(start, end);
}

function declaredFields(block: string): string[] {
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("@@") && !l.startsWith("model "))
    .map((l) => l.split(/\s+/)[0]);
}

/** Every code file under the given roots: src (tests included), e2e,
 *  scripts and the raw SQL. The generated client and node_modules are
 *  skipped; the generated client follows the schema, which is checked
 *  directly. */
function codeFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "generated" || entry === "node_modules" || entry === ".next") continue;
      codeFiles(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("the unused nearby-players columns stay retired (slice L11)", () => {
  const schema = readFileSync(SCHEMA, "utf8");

  it("finds the User model (guards the parser itself)", () => {
    const block = modelBlock(schema, "User");
    expect(block).not.toBeNull();
    expect(declaredFields(block!)).toContain("phoneNumber");
  });

  it("has none of the seven columns on User", () => {
    const fields = declaredFields(modelBlock(schema, "User")!);
    expect(fields.filter((f) => (RETIRED_USER_COLUMNS as readonly string[]).includes(f))).toEqual([]);
  });

  it("the schema does not name them anywhere, comments included", () => {
    expect(schema).not.toMatch(NAMES);
  });

  it("no code, test, script or SQL names them, except this guard", () => {
    const files = ["src", "e2e", "scripts", "prisma/sql"].flatMap((d) => codeFiles(path.join(ROOT, d)));
    expect(files.length).toBeGreaterThan(100); // guards the walker itself
    const offenders = files
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((rel) => rel !== THIS_FILE)
      .filter((rel) => NAMES.test(readFileSync(path.join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the name matcher is not vacuous", () => {
    expect(NAMES.test(`SELECT "discoverableNearby" FROM "User"`)).toBe(true);
    expect(NAMES.test(`data: { homeAreaLat: 51.3 }`)).toBe(true);
    expect(NAMES.test(`org.discoverable`)).toBe(false);
    expect(NAMES.test(`discoverableAt`)).toBe(false);
  });
});
