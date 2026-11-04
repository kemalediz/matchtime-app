/**
 * GUARD: THE CLUB SUMMARY HOLDS FACTS, NOT DECISIONS (plan section 3.6, 1).
 *
 * The summary must not grow into a rules engine. Two rules, both checked
 * twice: on the TYPE (types.ts, read as text) and on every built summary
 * of the five club shapes (so `OrgFeatures`, which lives elsewhere, is
 * covered too):
 *   - no field is a function, and a built summary is plain data (it
 *     survives a JSON round trip unchanged: no Date, Map, Set or class);
 *   - no field names an action: `should*`, `skip*`, `send*`, `allow*`,
 *     `can*`. A special case lives in its consumer, deciding from a fact
 *     named in the summary.
 * Review question for every PR that touches types.ts: "can a person check
 * this on an admin screen?" If not, it belongs in a consumer.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClubSummary } from "../derive";
import { NOW, SHAPES } from "./fixtures";

const ACTION_NAME = /^(should|skip|send|allow|can)([A-Z_]|$)/;

/** Strip comments, then list `{ field, type }` for every property line. */
function fieldsOf(source: string): Array<{ field: string; type: string }> {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const out: Array<{ field: string; type: string }> = [];
  for (const m of code.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*(\(|:)\s*([^;\n]*)/gm)) {
    const [, field, , sep, type] = m;
    if (["import", "export", "type", "interface"].includes(field)) continue;
    out.push({ field, type: sep === "(" ? `(${type}` : type });
  }
  return out;
}

function violations(source: string): string[] {
  return fieldsOf(source).flatMap(({ field, type }) => {
    const v: string[] = [];
    if (ACTION_NAME.test(field)) v.push(`${field}: names an action`);
    if (type.startsWith("(") || /=>/.test(type) || /\bFunction\b/.test(type)) v.push(`${field}: is a function`);
    if (/\b(Date|Map|Set|Promise)\b/.test(type)) v.push(`${field}: is not plain data (${type.trim()})`);
    return v;
  });
}

/** Every key path of a built summary, and any value that is not plain data. */
function walk(value: unknown, at: string, out: { keys: string[]; bad: string[] }) {
  if (typeof value === "function") out.bad.push(`${at}: function`);
  else if (value instanceof Date || value instanceof Map || value instanceof Set) out.bad.push(`${at}: ${value.constructor.name}`);
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) out.bad.push(`${at}: class instance`);
    for (const [k, v] of Object.entries(value)) {
      out.keys.push(k);
      walk(v, `${at}.${k}`, out);
    }
  }
}

describe("the summary's type is facts", () => {
  const types = readFileSync(path.resolve(__dirname, "../types.ts"), "utf8");

  it("the scan is alive: it reads the type's fields and catches a decision", () => {
    const fields = fieldsOf(types).map((f) => f.field);
    for (const known of ["lifecycle", "botOn", "placesOpen", "short", "phase", "nextMatchId", "roster"]) expect(fields).toContain(known);
    expect(violations("interface X {\n  shouldSendSayIn: boolean;\n  skipChase?: boolean;\n  canTakeCard: boolean;\n  decide: (x: number) => boolean;\n  run(): void;\n  at: Date;\n}")).toEqual([
      "shouldSendSayIn: names an action",
      "skipChase: names an action",
      "canTakeCard: names an action",
      "decide: is a function",
      "run: is a function",
      "at: is not plain data (Date)",
    ]);
  });

  it("types.ts has no function field, no action name, no Date, Map or Set", () => {
    expect(violations(types)).toEqual([]);
  });
});

describe("a built summary is plain facts, for every club shape", () => {
  it.each(Object.entries(SHAPES))("%s", (_, rows) => {
    const summary = buildClubSummary(rows, NOW);
    const out = { keys: [] as string[], bad: [] as string[] };
    walk(summary, "summary", out);
    expect(out.bad).toEqual([]);
    expect(out.keys.filter((k) => ACTION_NAME.test(k))).toEqual([]);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });
});
