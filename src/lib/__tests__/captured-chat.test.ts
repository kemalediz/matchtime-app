/**
 * CAPTURED CHAT AND DESCRIPTION: ONE FILE WRITES THEM (2026-10-12).
 *
 * A connect request keeps two things WhatsApp shared at the add: the chat
 * (`capturedHistory`) and the group description (`capturedDescription`).
 * Every deletion of one must delete the other, and a late write must
 * never land on a request that was cleared a moment before. So every
 * statement that writes either column lives in src/lib/captured-chat.ts.
 * Two halves here:
 *
 *   - the helper's own statements, against a mocked client;
 *   - a SOURCE GUARD over src/ and scripts/: outside the helper, the two
 *     names may only be READ (a property read, a Prisma `select`, a type).
 *     Any other mention fails, whatever its shape: a `data:` key, an SQL
 *     SET on one line or several, a ternary, `{ set: null }`, a value in a
 *     variable.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  capturedAtLink,
  capturedSessionChat,
  clearCapturedChat,
  clearCapturedChatForClub,
  clearExpiredCapturedChat,
  clearExpiredSessionChat,
  fillCapturedChatOnReAdd,
} from "../captured-chat";

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

const BOTH_NULL = `SET "capturedHistory" = NULL, "capturedDescription" = NULL`;
const STILL_LIVE = `"status" = 'group_linked' AND "botRemovedAt" IS NULL`;

describe("the helper: deleting", () => {
  it("clearCapturedChat: one statement, both columns, one request", async () => {
    const c = client();
    expect(await clearCapturedChat(c, "cc-1")).toBe(1);
    expect(c.calls).toEqual([{ sql: `UPDATE "ClubConnect" ${BOTH_NULL} WHERE "id" = ?`, values: ["cc-1"] }]);
  });

  it("clearCapturedChatForClub: both columns, every request of the club", async () => {
    const c = client(2);
    expect(await clearCapturedChatForClub(c, "org-1")).toBe(2);
    expect(c.calls).toEqual([{ sql: `UPDATE "ClubConnect" ${BOTH_NULL} WHERE "orgId" = ?`, values: ["org-1"] }]);
  });

  it("clearExpiredCapturedChat: both columns, and a request holding ONLY a description expires too", async () => {
    const c = client(4);
    const n = await clearExpiredCapturedChat(c, { expireBefore: "2026-10-13 11:00:00.000", sweepReadsSince: "2026-10-17 11:00:00.000", limit: 200 });
    expect(n).toBe(4);
    const [q] = c.calls;
    expect(q.sql).toContain(`UPDATE "ClubConnect" ${BOTH_NULL}`);
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

describe("the helper: storing", () => {
  const CHAT = [{ author: "Ali", text: "in" }];

  it("capturedAtLink: what a link writes; nothing where there is nothing", () => {
    expect(capturedAtLink({ history: CHAT, description: "Mondays 9pm" })).toEqual({
      capturedHistory: CHAT,
      capturedDescription: "Mondays 9pm",
    });
    expect(capturedAtLink({ history: [], description: null })).toEqual({});
    expect(capturedAtLink({ history: [], description: "" })).toEqual({});
  });

  it("capturedSessionChat: the legacy in-group setup's chat, or nothing", () => {
    expect(capturedSessionChat(CHAT)).toEqual({ capturedHistory: CHAT });
    expect(capturedSessionChat(undefined)).toEqual({});
  });

  it("fillCapturedChatOnReAdd: each only where none is stored, and only while the request is still linked and MatchTime is still in the group", async () => {
    const c = client();
    expect(await fillCapturedChatOnReAdd(c, "cc-1", { history: CHAT, description: "Mondays 9pm" })).toEqual({ history: 1, description: 1 });
    expect(c.calls).toEqual([
      {
        sql: `UPDATE "ClubConnect" SET "capturedHistory" = ?::jsonb WHERE "id" = ? AND "capturedHistory" IS NULL AND ${STILL_LIVE}`,
        values: [JSON.stringify(CHAT), "cc-1"],
      },
      {
        sql: `UPDATE "ClubConnect" SET "capturedDescription" = ? WHERE "id" = ? AND "capturedDescription" IS NULL AND ${STILL_LIVE}`,
        values: ["Mondays 9pm", "cc-1"],
      },
    ]);
  });

  it("fillCapturedChatOnReAdd: nothing brought, nothing run", async () => {
    const c = client();
    expect(await fillCapturedChatOnReAdd(c, "cc-1", { history: [], description: null })).toEqual({ history: 0, description: 0 });
    expect(c.$executeRaw).not.toHaveBeenCalled();
  });
});

// ── The source guard ────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..", "..", "..");
const HELPER = path.join(ROOT, "src", "lib", "captured-chat.ts");
/** The ONLY files that may write either column. */
const MAY_WRITE = new Set([HELPER]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "generated" || name === "node_modules" || name === "__tests__") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const NAME = /captured(?:History|Description)(?![A-Za-z0-9_])/;
/** The ways the names may appear outside the helper. All are reads. */
const READS = [
  // A property read: `row.capturedHistory`, never `row.capturedHistory = x`.
  /\.captured(?:History|Description)(?![A-Za-z0-9_])(?!\s*(?:=(?!=)|\+=|\?\?=|\|\|=|&&=))/g,
  // A Prisma select.
  /(?<![A-Za-z0-9_.])captured(?:History|Description)\s*:\s*true(?![A-Za-z0-9_])/g,
  // A member of a type: it ends with a semicolon, which no object literal key does.
  /(?<![A-Za-z0-9_.])captured(?:History|Description)\??\s*:\s*[A-Za-z_][A-Za-z0-9_<>[\] |]*;/g,
];

/** Comments say what they like; only code is judged. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => {
      // A `//` that is not inside a string: an even number of quotes before it.
      for (let at = line.indexOf("//"); at !== -1; at = line.indexOf("//", at + 2)) {
        const before = line.slice(0, at);
        const quotes = (before.match(/["'`]/g) ?? []).length;
        if (quotes % 2 === 0 && !before.endsWith(":")) return before;
      }
      return line;
    })
    .join("\n");
}

/** The lines of `source` that mention either name other than to read it. */
function writesIn(source: string): string[] {
  const out: string[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, i) => {
      if (!NAME.test(line)) return;
      let rest = line;
      for (const read of READS) rest = rest.replace(read, "");
      if (NAME.test(rest)) out.push(`${i + 1}: ${line.trim()}`);
    });
  return out;
}

describe("nothing outside captured-chat.ts writes the captured chat or the description", () => {
  it("the scan flags every way of writing", () => {
    const writes = [
      `await tx.$executeRaw\`UPDATE "ClubConnect" SET "capturedHistory" = NULL WHERE "id" = \${id}\`;`,
      // SQL over several lines.
      `await tx.$executeRaw\`UPDATE "ClubConnect"\n  SET\n    "capturedHistory"\n      = NULL\n  WHERE "id" = \${id}\`;`,
      `SET "capturedDescription"=NULL`,
      `SET "capturedDescription" = \${text}`,
      `data: { capturedHistory: Prisma.DbNull }`,
      `data: { capturedHistory: Prisma.JsonNull }`,
      `data: { capturedDescription: null }`,
      `data: { capturedDescription: cond ? text : null }`,
      `data: { capturedHistory: { set: null } }`,
      `const cleared = null;\nawait db.clubConnect.update({ where: { id }, data: { capturedDescription: cleared } });`,
      `const data = {\n  capturedHistory:\n    value,\n};`,
      `data: { capturedHistory }`,
      `const key = "capturedHistory";`,
      `row.capturedHistory = null;`,
      `row.capturedDescription ??= "";`,
      `data: { capturedHistory: history.length > 0 ? (history as unknown as object) : undefined }`,
      // A read through raw SQL is refused too: reads go through a select.
      `SELECT "capturedDescription" FROM "ClubConnect"`,
    ];
    for (const w of writes) expect(writesIn(w), w).not.toEqual([]);
  });

  it("the scan lets every read through, and comments", () => {
    const reads = [
      `select: { id: true, capturedHistory: true, capturedDescription: true },`,
      `const history = coerceHistoryMessages(connect.capturedHistory);`,
      `if (capturedJson && active.capturedHistory == null) {`,
      `if (row.capturedDescription === null) return;`,
      `capturedHistory?: unknown;`,
      `capturedDescription: string | null;`,
      `export function capturedHistoryCutoffs(now: Date) {`,
      `// SET "capturedHistory" = NULL would be a write`,
      `/**\n * ClubConnect.capturedHistory is deleted when\n * "capturedDescription" = NULL\n */`,
      `const url = "https://example.com"; // capturedHistory: null`,
    ];
    for (const r of reads) expect(writesIn(r), r).toEqual([]);
  });

  it("no file under src/ or scripts/ writes either column, except the helper", () => {
    const offenders: string[] = [];
    const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))];
    for (const file of files) {
      if (MAY_WRITE.has(file)) continue;
      for (const hit of writesIn(readFileSync(file, "utf8"))) offenders.push(`${path.relative(ROOT, file)}:${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the allow-list is one file", () => {
    expect([...MAY_WRITE].map((f) => path.relative(ROOT, f))).toEqual(["src/lib/captured-chat.ts"]);
  });

  it("in the helper, every statement that deletes a connect request's chat deletes its description too", () => {
    const source = stripComments(readFileSync(HELPER, "utf8"));
    const statements = (source.match(/UPDATE "ClubConnect"[\s\S]*?`/g) ?? []).map((s) => s.replace(/\s+/g, " "));
    const deleting = statements.filter((s) => /= NULL/.test(s));
    expect(deleting.length).toBeGreaterThanOrEqual(3);
    for (const s of deleting) expect(s, s).toContain(BOTH_NULL);
    // And every statement that stores one checks the request is still live.
    const storing = statements.filter((s) => !/= NULL/.test(s));
    expect(storing).toHaveLength(2);
    for (const s of storing) {
      expect(s, s).toContain(STILL_LIVE);
      expect(s, s).toMatch(/"captured(History|Description)" IS NULL/);
    }
  });

  it("the scan can see the files that matter (so the guard is not vacuous)", () => {
    const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))].map((f) => path.relative(ROOT, f));
    for (const f of [
      "src/lib/captured-chat.ts",
      "src/lib/group-add.ts",
      "src/lib/club-approval.ts",
      "src/lib/club-setup.ts",
      "src/lib/setup-learning/run.ts",
      "src/lib/captured-history-expiry.ts",
      "src/app/api/whatsapp/bot-added/route.ts",
      "scripts/peek-self-setup.ts",
    ]) {
      expect(files).toContain(f);
    }
  });

  it("each known site calls the helper", () => {
    const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
    expect(read("src/lib/group-add.ts")).toMatch(/clearCapturedChat\(tx, /);
    expect(read("src/lib/group-add.ts")).toMatch(/fillCapturedChatOnReAdd\(db, /);
    expect(read("src/lib/group-add.ts")).toMatch(/\.\.\.capturedAtLink\(/);
    expect(read("src/lib/club-approval.ts")).toMatch(/clearCapturedChat\(tx, /);
    expect(read("src/lib/club-setup.ts")).toMatch(/clearCapturedChatForClub\(tx, /);
    expect(read("src/lib/setup-learning/run.ts")).toMatch(/clearCapturedChat\(db, /);
    expect(read("src/lib/captured-history-expiry.ts")).toMatch(/clearExpiredCapturedChat\(db, /);
    expect(read("src/lib/captured-history-expiry.ts")).toMatch(/clearExpiredSessionChat\(db, /);
    expect(read("src/app/api/whatsapp/bot-added/route.ts")).toMatch(/capturedSessionChat\(/);
  });
});
