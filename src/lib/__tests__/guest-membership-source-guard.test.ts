/**
 * "IS HE A GUEST?" HAS ONE ANSWER (local player pool, slice L5a, 2026-10-24).
 *
 * A POOL guest's membership has `guestMatchId` set and `guestFromOrgId`
 * NULL (no home club). So any reader that asks "ordinary member or guest?"
 * by testing `guestFromOrgId` counts a pool guest as a member: club access,
 * rosters, club size, an organiser seeing his phone. That question is
 * answered only by `src/lib/guest-membership.ts` (`guestMatchId`).
 *
 * This guard fails if a file outside the allowlist tests `guestFromOrgId`
 * for null-ness or truthiness, in a Prisma `where`, raw SQL or plain code.
 * Reading the home club's id as a VALUE (to look up its name, or
 * `=== orgId`) is fine anywhere: only a membership TEST is caught.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(SRC, "..");
const rel = (f: string) => path.relative(REPO, f);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Files that may still test `guestFromOrgId`, each because it needs a
 * PARTNER guest's home club, never to decide "member or guest":
 */
const ALLOWED = new Set([
  // The definition itself (its header comment names the old patterns).
  "src/lib/guest-membership.ts",
  // The partner-guest writer: creates, relabels and clears partner rows
  // and reads the home club to message him (owned by the pool slices).
  "src/lib/partner-guest.ts",
  // A partner guest's DM replies: finds the partner ask he answered and
  // his home club's name and language. A pool guest has no ask there and
  // is skipped (`continue`), never treated as a member.
  "src/lib/partner-guest-dm.ts",
]);

/**
 * PENDING, owned by another slice (L5b owns the match page's guest tags).
 * Each entry here is a known pool-guest gap, not an exemption: remove it in
 * the slice that moves the file onto guest-membership.ts.
 */
const PENDING = new Set(["src/app/matches/[matchId]/page.tsx"]);

/** A membership TEST on guestFromOrgId (not a value read). */
const PATTERNS: Array<[string, RegExp]> = [
  ["where null", /guestFromOrgId:\s*null\b/],
  ["where not null", /guestFromOrgId:\s*\{\s*not:\s*null/],
  ["raw SQL", /"guestFromOrgId"\s+IS\s+(NOT\s+)?NULL/i],
  ["negation", /!\s*[\w$.?\]\[]*\bguestFromOrgId\b/],
  ["ternary", /\bguestFromOrgId\s*\?(?![.?:])/],
  ["and/or", /\bguestFromOrgId\s*(&&|\|\|)|(&&|\|\|)\s*[\w$.?]*\.guestFromOrgId\b(?!\s*(===|!==|==|!=|\?\?))/],
  ["filter", /\.(filter|some|every|find)\(\s*\(?\w+\)?\s*=>\s*!*\s*[\w$.?]*\.guestFromOrgId\s*\)/],
  ["if", /\bif\s*\(\s*[\w$.?]*\.guestFromOrgId\s*\)/],
];

/** Only `src/lib/pool/**` is the pool slices' own (it reads guestMatchId). */
const files = [...walk(SRC), ...walk(path.join(REPO, "scripts"))];

export function offenders(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

describe("guest membership: one definition", () => {
  it("no file outside the allowlist tests guestFromOrgId to mean 'member or guest'", () => {
    const bad = files
      .filter((f) => !ALLOWED.has(rel(f)) && !PENDING.has(rel(f)))
      .map((f) => [rel(f), offenders(readFileSync(f, "utf8"))] as const)
      .filter(([, hits]) => hits.length > 0)
      .map(([f, hits]) => `${f}: ${hits.join(", ")}`);
    expect(bad).toEqual([]);
  });

  it("every allowlisted file exists", () => {
    for (const f of ALLOWED) expect(existsSync(path.join(REPO, f)), f).toBe(true);
  });

  it("the guard catches each shape it is meant to", () => {
    const hits = [
      "where: { orgId, leftAt: null, guestFromOrgId: null }",
      "where: { guestFromOrgId: { not: null } }",
      'AND ms."guestFromOrgId" IS NULL',
      "if (!m.guestFromOrgId) return",
      "if (!!membership?.guestFromOrgId) return",
      "email: m.guestFromOrgId ? null : m.user.email",
      "membership.leftAt === null && membership.guestFromOrgId && x",
      "all.filter((m) => m.guestFromOrgId)",
      "if (row.membership.guestFromOrgId) return",
    ];
    for (const h of hits) expect(offenders(h), h).not.toEqual([]);
    const fine = [
      "select: { userId: true, guestFromOrgId: true }",
      "m.guestFromOrgId === orgId",
      "clubName.get(m.guestFromOrgId ?? '')",
      "where: { ...ORDINARY_MEMBER_WHERE }",
      "guestMatchId: null",
      "guestFromOrgId?: string | null;",
      "memberships.map((m) => m.guestFromOrgId)",
    ];
    for (const f of fine) expect(offenders(f), f).toEqual([]);
  });
});
