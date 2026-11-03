/**
 * Every column that can name a user is handled by the user merge, or is
 * listed as deliberately left alone with a reason (2026-11-03).
 *
 * A column added later that holds a user id, and that nobody taught the
 * merge about, would keep pointing at the deactivated source after a
 * merge. This test reads prisma/schema.prisma and fails until the new
 * column is classified in src/lib/user-merge-plan.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { delegateOf, pkOf, SPECIAL_COLUMNS, UNTOUCHED_COLUMNS, USER_REF_COLUMNS } from "../user-merge-plan";

const schema = readFileSync(path.resolve(__dirname, "../../../prisma/schema.prisma"), "utf8");

function fields(): Array<{ model: string; name: string; type: string }> {
  const out: Array<{ model: string; name: string; type: string }> = [];
  let model: string | null = null;
  for (const line of schema.split("\n")) {
    const mm = line.match(/^model (\w+) \{/);
    if (mm) {
      model = mm[1];
      continue;
    }
    if (line.startsWith("}")) model = null;
    if (!model) continue;
    const f = line.match(/^\s+(\w+)\s+(String\[\]|String\??|Json\??)(\s|$)/);
    if (f) out.push({ model, name: f[1], type: f[2] });
  }
  return out;
}

/** Names that hold, or may hold, a user id. */
const USERISH = /(^userId$|^userIds$|UserIds?$|^raterId$|^playerId$|^voterId$|^targetUser$|^paymentHolderId$|ById$|By$)/;

const classified = new Set([...USER_REF_COLUMNS.map((c) => `${c.model}.${c.column}`), ...SPECIAL_COLUMNS, ...Object.keys(UNTOUCHED_COLUMNS)]);

describe("user merge: schema coverage", () => {
  it("every user-like String column is handled or deliberately left", () => {
    const missing = fields()
      .filter((f) => f.type.startsWith("String") && USERISH.test(f.name) && !/ByOrgId$/.test(f.name))
      .map((f) => `${f.model}.${f.name}`)
      .filter((k) => !classified.has(k));
    expect(missing).toEqual([]);
  });

  it("every Json column is handled or deliberately left", () => {
    const missing = fields()
      .filter((f) => f.type.startsWith("Json"))
      .map((f) => `${f.model}.${f.name}`)
      .filter((k) => !classified.has(k));
    expect(missing).toEqual([]);
  });

  it("every column the merge names exists in the schema", () => {
    const all = new Set(fields().map((f) => `${f.model}.${f.name}`));
    const stale = [...classified].filter((k) => !all.has(k));
    expect(stale).toEqual([]);
  });

  it("every Prisma relation to User is covered by a handled column", () => {
    // `user User @relation(fields: [userId] ...)` style relations.
    const rel: string[] = [];
    let model: string | null = null;
    for (const line of schema.split("\n")) {
      const mm = line.match(/^model (\w+) \{/);
      if (mm) model = mm[1];
      const r = line.match(/^\s+\w+\s+User\??\s+@relation\((?:"\w+",\s*)?fields:\s*\[(\w+)\]/);
      if (r && model) rel.push(`${model}.${r[1]}`);
    }
    expect(rel.length).toBeGreaterThan(20);
    expect(rel.filter((k) => !classified.has(k) || k in UNTOUCHED_COLUMNS)).toEqual([]);
  });

  it("every model the merge rewrites is addressed by its real primary key", () => {
    const pkOfModel = (model: string) => {
      const body = schema.split(`model ${model} {`)[1]?.split("\n}")[0] ?? "";
      return body.match(/^\s+(\w+)\s+\w+.*@id/m)?.[1] ?? null;
    };
    const wrong = [...new Set(USER_REF_COLUMNS.map((c) => c.model))].filter((m) => pkOfModel(m) !== pkOf(delegateOf(m)));
    expect(wrong).toEqual([]);
  });
});
