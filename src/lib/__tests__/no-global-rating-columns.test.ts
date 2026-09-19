/**
 * THE GLOBAL RATING COLUMNS ARE GONE, AND MUST NOT COME BACK.
 *
 * Slice 7 of MDs/club-scoped-ratings-design-2026-09-18.md dropped
 * `User.seedRating` and `User.matchRating`. This file used to scan `src`
 * for `db.user.update({ data: { seedRating } })` and friends, because
 * while the columns still existed such a write type-checked, ran
 * cleanly, and silently handed one club's opinion to another.
 *
 * THAT SCAN IS RETIRED, not because the invariant stopped mattering but
 * because the compiler now enforces it strictly better. With the fields
 * off the model, `data: { seedRating: 6 }` on a user write is a tsc
 * error at the exact character, on every call site, including the ones
 * a regex window of 400 characters would have missed, and Prisma throws
 * at runtime on top of that. A hand-rolled scan that is weaker than
 * `npx tsc --noEmit` is not protection, it is a second thing to
 * maintain.
 *
 * What survives is the one step the compiler cannot take: it happily
 * type-checks a schema that has the columns back. So this now guards the
 * SCHEMA, which is the only door the columns can return through, plus
 * the `DEFAULT_SEED_RATING` constant that made a new member inherit
 * somebody else's number. Both are single lines somebody could write
 * without meaning the consequence, and neither fails any other gate.
 *
 * `Membership.seedRating` and `Membership.matchRating` are the correct
 * home and are deliberately NOT matched here. The test is about which
 * model the field hangs off, not about the field names.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../..");
const SCHEMA = path.resolve(SRC, "../prisma/schema.prisma");

/** Every `.ts`/`.tsx` under src, minus the generated Prisma client and
 *  the tests themselves (a test may legitimately name the old column in
 *  a fixture or a comment). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "generated" || entry === "__tests__" || entry === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The body of one `model X { ... }` block, or null if the model is not
 * in the file. Prisma blocks do not nest, so the first `}` at column
 * zero ends it.
 */
function modelBlock(schema: string, model: string): string | null {
  const start = schema.indexOf(`model ${model} {`);
  if (start === -1) return null;
  const end = schema.indexOf("\n}", start);
  return end === -1 ? schema.slice(start) : schema.slice(start, end);
}

/** Field declarations only. A `///` doc comment naming the old column is
 *  history, and history is the point of a tombstone. */
function declaredFields(block: string): string[] {
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("@@") && !l.startsWith("model "))
    .map((l) => l.split(/\s+/)[0]);
}

describe("the global rating columns stay dropped", () => {
  const schema = readFileSync(SCHEMA, "utf8");

  it("finds the User and Membership models (guards the parser itself)", () => {
    expect(modelBlock(schema, "User")).not.toBeNull();
    expect(modelBlock(schema, "Membership")).not.toBeNull();
  });

  it("has no seedRating or matchRating field on User", () => {
    const fields = declaredFields(modelBlock(schema, "User")!);
    expect(fields).not.toContain("seedRating");
    expect(fields).not.toContain("matchRating");
  });

  it("still has both of them on Membership, which is where they live now", () => {
    const fields = declaredFields(modelBlock(schema, "Membership")!);
    expect(fields).toContain("seedRating");
    expect(fields).toContain("matchRating");
  });
});

describe("no constant hands a new member somebody else's opinion", () => {
  const files = sourceFiles(SRC);

  it("scans a plausible number of source files (guards the walker itself)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no DEFAULT_SEED_RATING constant left", () => {
    const offenders = files.filter((f) => /DEFAULT_SEED_RATING/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
