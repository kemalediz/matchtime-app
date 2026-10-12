/**
 * CAPTURED CHAT AND DESCRIPTION ARE CLEARED TOGETHER (2026-10-12).
 *
 * A connect request keeps two things WhatsApp shared at the add: the chat
 * (`capturedHistory`) and the group description (`capturedDescription`).
 * Every deletion of one must delete the other, so every deletion lives in
 * src/lib/captured-chat.ts. Two halves here:
 *
 *   - the helper's own statements, against a mocked client;
 *   - a SOURCE GUARD: no other file under src/ sets either column to
 *     NULL, in SQL or through Prisma. A new clearing site has to call the
 *     helper, and so cannot clear one without the other.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clearCapturedChat, clearExpiredCapturedChat, clearExpiredSessionChat } from "../captured-chat";

function client(count = 1) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  return {
    calls,
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
      return count;
    }),
  };
}

describe("the helper", () => {
  it("clearCapturedChat: one statement, both columns, one request", async () => {
    const c = client();
    expect(await clearCapturedChat(c, "cc-1")).toBe(1);
    expect(c.calls).toEqual([
      {
        sql: `UPDATE "ClubConnect" SET "capturedHistory" = NULL, "capturedDescription" = NULL WHERE "id" = ?`,
        values: ["cc-1"],
      },
    ]);
  });

  it("clearExpiredCapturedChat: both columns, and a request holding ONLY a description expires too", async () => {
    const c = client(4);
    const n = await clearExpiredCapturedChat(c, { expireBefore: "2026-10-13 11:00:00.000", sweepReadsSince: "2026-10-17 11:00:00.000", limit: 200 });
    expect(n).toBe(4);
    const [q] = c.calls;
    expect(q.sql).toContain(`UPDATE "ClubConnect" SET "capturedHistory" = NULL, "capturedDescription" = NULL`);
    expect(q.sql).toContain(`(c."capturedHistory" IS NOT NULL OR c."capturedDescription" IS NOT NULL)`);
    expect(q.sql).toContain(`"linkedAt"`);
    expect(q.sql).toContain(`"approvedAt"`);
    expect(q.sql).toContain("LIMIT");
    expect(q.sql).not.toMatch(/RETURNING|SELECT\s+\*/i);
    expect(q.values).toEqual(["2026-10-13 11:00:00.000", "2026-10-17 11:00:00.000", 200]);
  });

  it("clearExpiredSessionChat: the legacy in-group setup's copy (it has no description)", async () => {
    const c = client(2);
    expect(await clearExpiredSessionChat(c, { expireBefore: "2026-10-13 11:00:00.000", limit: 200 })).toBe(2);
    expect(c.calls[0].sql).toContain(`UPDATE "OnboardingSession" SET "capturedHistory" = NULL`);
    expect(c.calls[0].sql).not.toContain("capturedDescription");
    expect(c.calls[0].values).toEqual(["2026-10-13 11:00:00.000", 200]);
  });
});

// ── The source guard ────────────────────────────────────────────────────

const SRC = path.resolve(__dirname, "..", "..");
const HELPER = path.join(SRC, "lib", "captured-chat.ts");

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

/**
 * Either column being set to nothing: `"capturedHistory" = NULL` in SQL
 * (but not `IS NULL`, which is a question), or `capturedHistory: null`,
 * `: Prisma.DbNull`, `: Prisma.JsonNull`, `: undefined as ...` is not a
 * clear and is not matched.
 */
const CLEARS = /\bcaptured(?:History|Description)"?\s*(?:=\s*NULL\b|:\s*(?:null\b|(?:Prisma\.)?(?:DbNull|JsonNull|NullTypes)))/i;

describe("nothing outside captured-chat.ts clears the captured chat or the description", () => {
  it("the pattern catches every way of clearing, and not a question or a write", () => {
    for (const clears of [
      `UPDATE "ClubConnect" SET "capturedHistory" = NULL WHERE "id" = $1`,
      `SET "capturedDescription"=NULL`,
      `set "capturedhistory" = null`,
      `data: { capturedHistory: Prisma.DbNull }`,
      `data: { capturedHistory: Prisma.JsonNull }`,
      `data: { capturedHistory: DbNull }`,
      `data: { capturedDescription: null }`,
      `capturedDescription : null,`,
    ]) {
      expect(clears, clears).toMatch(CLEARS);
    }
    for (const fine of [
      `WHERE "id" = $1 AND "capturedHistory" IS NULL`,
      `WHERE c."capturedDescription" IS NOT NULL`,
      `SET "capturedDescription" = $1`,
      `capturedDescription: description ?? undefined,`,
      `select: { capturedHistory: true }`,
      `capturedHistory: history.length > 0 ? (history as unknown as object) : undefined,`,
      `if (active.capturedHistory == null) {`,
      `capturedDescription?: string | null;`,
    ]) {
      expect(fine, fine).not.toMatch(CLEARS);
    }
  });

  it("no source file but the helper matches it", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === HELPER) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (CLEARS.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("in the helper, every statement that clears a connect request's chat clears its description too", () => {
    const source = readFileSync(HELPER, "utf8");
    const statements = source.match(/UPDATE "ClubConnect"[\s\S]*?`/g) ?? [];
    expect(statements.length).toBeGreaterThanOrEqual(2);
    for (const s of statements) {
      expect(s, s).toMatch(/SET "capturedHistory" = NULL, "capturedDescription" = NULL/);
    }
    // And nothing there clears one of the two on its own.
    const lone = source
      .split("\n")
      .filter((l) => /"ClubConnect"/.test(l) && CLEARS.test(l) && !/"capturedHistory" = NULL, "capturedDescription" = NULL/.test(l));
    expect(lone).toEqual([]);
  });

  it("the scan can see the files that clear (so the guard is not vacuous)", () => {
    const files = walk(SRC);
    for (const f of ["lib/captured-chat.ts", "lib/group-add.ts", "lib/club-approval.ts", "lib/setup-learning/run.ts", "lib/captured-history-expiry.ts"]) {
      expect(files).toContain(path.join(SRC, f));
    }
  });

  it("each known clearing site calls the helper", () => {
    const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");
    expect(read("lib/group-add.ts")).toMatch(/clearCapturedChat\(tx, /);
    expect(read("lib/club-approval.ts")).toMatch(/clearCapturedChat\(tx, /);
    expect(read("lib/setup-learning/run.ts")).toMatch(/clearCapturedChat\(db, /);
    expect(read("lib/captured-history-expiry.ts")).toMatch(/clearExpiredCapturedChat\(db, /);
    expect(read("lib/captured-history-expiry.ts")).toMatch(/clearExpiredSessionChat\(db, /);
  });
});
