/**
 * WHERE THE ADMIN-GROUP ROUTE MEETS A MODEL (rewritten 2026-10-16).
 *
 * Until 2026-10-16 this file was `admin-group-no-model.source.test.ts`
 * and pinned "a message in an admin group never reaches a model", with
 * exact-string readers in front of one narrow door. That rule was ours,
 * not the owner's, and it is retired: Kemal, 2026-10-16, "there has to be
 * a general module which analyzes the messages coming from multiple groups
 * and then processes accordingly". An organiser's words in HQ now go
 * through the SAME router and extractors as the players' group.
 *
 * What is pinned now:
 *   - the link-command route still reaches no model at all (a code);
 *   - the admin-group route reaches a model through ONE door,
 *     `admin-group-understand.ts` (the shared pipeline), plus the shared
 *     writer and team generator every path has always reached: with those
 *     cut out of the graph, nothing reachable can call a model. Nothing
 *     in front of the door reads words with code any more: the PAID digest
 *     answer and the pasted list are read inside it (2026-10-29, 2026-10-30);
 *   - since 2026-10-30 a THIRD, narrow door: the pick reader
 *     (`organiser-pick-reader.ts`), the model that reads a reply to
 *     MatchTime's numbered bench list ("2 3", "all", "none", a name, an
 *     @tag, YES). Kemal, 2026-10-30: "I don't want any string parsing at
 *     all". It is imported by `organiser-pick.ts` alone, one call;
 *   - the HQ squad reader (`hq-squad-reader.ts`, 2026-10-29), the model
 *     that says whether a message is the squad, a change, the teams or
 *     something else, is INSIDE the shared door since 2026-10-30: the
 *     router first, then the reader. Nothing outside the door reaches it.
 *   - the door is imported by `admin-group.ts` alone, after the admin and
 *     club checks (`admin-group.test.ts` pins that a non-admin never gets
 *     there);
 *   - the door really is the shared pipeline: it reaches the gate, the
 *     router and the extractors, and no prompt of its own.
 *
 * Reads the sources and follows every relative `@/lib` import transitively.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const DOOR = "src/lib/admin-group-understand.ts";
const WRITER = "src/lib/attendance.ts";
const GENERATOR = "src/lib/team-generation.ts";
const PASTE_READER = "src/lib/hq-squad-reader.ts";
const PICK_READER = "src/lib/organiser-pick-reader.ts";

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(cand)) return cand;
  return null;
}

function importGraph(entry: string, stop: string[] = []) {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const importers = new Map<string, Set<string>>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)) {
      const next = resolveImport(f, m[1]);
      if (next) {
        const rel = path.relative(ROOT, next);
        importers.set(rel, (importers.get(rel) ?? new Set()).add(path.relative(ROOT, f)));
        if (!stop.includes(rel)) stack.push(next);
      } else if (!m[1].startsWith(".") && !m[1].startsWith("@/")) packages.add(m[1]);
    }
  }
  return { files: [...seen].map((f) => path.relative(ROOT, f)), packages: [...packages], importers };
}

const FORBIDDEN_FILES = /message-analyzer|\/pipeline\/|dm-intent|dm-qa|onboarding-analyzer|window-analyzer|payment-claim-classifier|roster-survey-classifier|match-availability-classifier|attendance-engine-batch/;

function expectModelFree(files: string[], packages: string[]) {
  expect(files.length).toBeGreaterThan(1);
  expect(packages.filter((p) => p.includes("anthropic"))).toEqual([]);
  expect(files.filter((f) => FORBIDDEN_FILES.test(f))).toEqual([]);
}

describe("admin-group paths and the model", () => {
  it("the link-command route never reaches a model", () => {
    const { files, packages } = importGraph(path.join(ROOT, "src/app/api/whatsapp/admin-group-link/route.ts"));
    expectModelFree(files, packages);
  });

  it("the admin-group route reaches one only through the shared-pipeline door, the HQ squad reader and the pick reader (and the shared writer and generator)", () => {
    const { files, packages, importers } = importGraph(path.join(ROOT, "src/app/api/whatsapp/admin-group/route.ts"), [DOOR, WRITER, GENERATOR, PASTE_READER, PICK_READER]);
    expectModelFree(files, packages);
    expect([...(importers.get(DOOR) ?? [])]).toEqual(["src/lib/admin-group.ts"]);
    // The HQ squad reader is reached only through the shared door since
    // 2026-10-30 (the router first, then the reader): nothing outside the
    // door imports the paste module any more.
    expect([...(importers.get(PASTE_READER) ?? [])]).toEqual([]);
    expect([...(importers.get(PICK_READER) ?? [])]).toEqual(["src/lib/organiser-pick.ts"]);
    // The pasted list's writer is behind the door now (2026-10-30): outside
    // it, nothing reaches the shared writer.
    expect([...(importers.get(WRITER) ?? [])]).toEqual([]);
    // Setting teams aside for a pasted list is the door's too (2026-10-30).
    expect([...(importers.get(GENERATOR) ?? [])]).toEqual([]);
  });

  it("the shared writer reaches the SDK only by the scheduler's old import", () => {
    const { files, packages } = importGraph(path.join(ROOT, WRITER), ["src/lib/bot-scheduler.ts"]);
    expectModelFree(files, packages);
  });

  it("the door is the shared pipeline: the gate, the router and the extractors, and no prompt of its own", () => {
    const { files } = importGraph(path.join(ROOT, DOOR));
    expect(files).toContain("src/lib/pipeline/gate.ts");
    expect(files).toContain("src/lib/pipeline/router.ts");
    expect(files).toContain("src/lib/pipeline/extractors.ts");
    expect(files).toContain("src/lib/attendance-engine-batch.ts");
    const src = readFileSync(path.join(ROOT, DOOR), "utf8");
    expect(src).not.toMatch(/messages\.create|system:\s*`/);
  });
});
