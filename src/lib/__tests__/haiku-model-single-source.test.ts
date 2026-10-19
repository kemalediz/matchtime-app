/**
 * THE HAIKU MODEL ID IS NAMED IN ONE PLACE: `src/lib/models.ts`.
 *
 * Before 2026-10-19 the same literal was typed out at eight call sites
 * (the router, five DM-surface classifiers, the setup reading) plus the
 * probe list and a dry run, so trying a new Haiku meant a ten-file edit
 * and a missed site would quietly keep running the old model. Now every
 * site names `HAIKU_MODEL`, and this scan keeps it that way.
 *
 * Allowed: comments, and lookup tables keyed BY a model id (rate and
 * cache-minimum tables, `"claude-haiku-…": { … }` or `: 4_096`), which
 * price or measure a model rather than pin a call to it.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HAIKU_MODEL } from "../models";
import { ROUTER_MODEL } from "../pipeline/llm";
import { PAYMENT_CLAIM_MODEL } from "../payment-claim-classifier";
import { SETUP_LEARNING_MODEL } from "../setup-learning/prompt";
import { PICTURE_READING_MODEL } from "../picture-prompt";

const REPO = path.resolve(__dirname, "../../..");
const ROOTS = ["src", "scripts", "e2e", "whatsapp-bot/src"].map((d) => path.join(REPO, d));
const SOURCE = path.join(REPO, "src/lib/models.ts");

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "__fixtures__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);
const isLookupTableEntry = (line: string) => /^\s*"claude-haiku-[^"]+"\s*:/.test(line);

describe("the Haiku model id has one source", () => {
  it("no file but src/lib/models.ts puts a claude-haiku id in a model position", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap((r) => walk(r))) {
      if (file === SOURCE) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!/"claude-haiku-/.test(line)) return;
          if (isComment(line) || isLookupTableEntry(line)) return;
          offenders.push(`${path.relative(REPO, file)}:${i + 1}  ${line.trim()}`);
        });
    }
    expect(
      offenders,
      `name the Haiku model through HAIKU_MODEL (src/lib/models.ts), so a model ` +
        `change is one line:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every exported Haiku pin is the shared id", () => {
    expect(ROUTER_MODEL).toBe(HAIKU_MODEL);
    expect(PAYMENT_CLAIM_MODEL).toBe(HAIKU_MODEL);
    expect(SETUP_LEARNING_MODEL).toBe(HAIKU_MODEL);
    expect(PICTURE_READING_MODEL).toBe(HAIKU_MODEL);
  });
});
