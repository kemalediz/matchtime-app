/**
 * ══════════════════════════════════════════════════════════════════════
 * A SEND ADDED TO THE INTERFACE CANNOT ESCAPE THE SHADOW GUARD.
 * ══════════════════════════════════════════════════════════════════════
 *
 * `shadow.test.ts` proves the guard refuses the seven sends that exist
 * today. That is worth nothing in six months, when somebody adds
 * `sendImage` to `WaDriver` and the guard simply passes it through: the
 * list would still be "complete", and the shadow bot would post into a
 * real group on its first use.
 *
 * So this file reads `driver.ts` itself. Every member declared under its
 * `Outbound` heading has to appear in `SHADOW_SEND_MEMBERS`, and nothing
 * else may. Add a send, and this test fails until the guard covers it.
 *
 * The second rule is the same idea on the server side: every write the bot
 * makes goes out through ONE function in `api.ts`, so a new endpoint is
 * gated by construction rather than by the author remembering.
 *
 * Source text, not imports: importing `index.ts` would build a WhatsApp
 * client, and no test in this repo may open a socket.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHADOW_SEND_MEMBERS } from "./shadow.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

/**
 * The member names declared between one `── <heading> ──` comment and the
 * next. Members are written as `name(args)` or `name<T>(args)` at one
 * level of indentation inside the interface.
 */
export function membersUnderHeading(src: string, heading: string): string[] {
  const start = src.indexOf(`── ${heading} ─`);
  if (start < 0) throw new Error(`driver.ts has no "${heading}" section any more`);
  const after = src.slice(start);
  const end = after.indexOf("── ", 4);
  const section = end > 0 ? after.slice(0, end) : after;
  const out = new Set<string>();
  for (const line of section.split("\n")) {
    const m = /^ {2}([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

describe("the section reader the rule below depends on", () => {
  it("finds members, and would not pass vacuously", () => {
    const found = membersUnderHeading(
      [
        "  // ── Outbound ────────",
        "  sendThing(a: string): Promise<void>;",
        "  // ── Groups ─────────",
        "  listThings(): Promise<void>;",
      ].join("\n"),
      "Outbound",
    );
    expect(found).toEqual(["sendThing"]);
  });

  it("throws rather than returning nothing when the heading is gone", () => {
    expect(() => membersUnderHeading("nothing here", "Outbound")).toThrow(/no "Outbound"/);
  });
});

describe("every outbound member of WaDriver is refused in shadow mode", () => {
  const declared = membersUnderHeading(read("driver.ts"), "Outbound");

  it("finds the outbound members at all", () => {
    expect(declared.length).toBeGreaterThanOrEqual(7);
    expect(declared).toContain("sendText");
    expect(declared).toContain("sendReaction");
  });

  it("matches SHADOW_SEND_MEMBERS exactly, in both directions", () => {
    expect([...declared].sort()).toEqual([...SHADOW_SEND_MEMBERS].sort());
  });
});

describe("every server write goes through one gated function", () => {
  const api = read("api.ts");

  /** Comments and template/quote bodies removed, so prose cannot satisfy a rule. */
  function code(src: string): string {
    return src
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, '""');
  }

  it("api.ts calls the global fetch in exactly one place", () => {
    const hits = code(api).match(/(?<![A-Za-z0-9_$.])fetch\s*\(/g) ?? [];
    expect(hits.length).toBe(1);
  });

  it("that place is apiFetch, and apiFetch consults shadow mode", () => {
    expect(api).toMatch(/function apiFetch\s*\(/);
    expect(api).toMatch(/refuseServerWriteInShadow/);
  });
});

describe("index.ts starts nothing that acts in shadow mode", () => {
  const index = read("index.ts");

  it("reads the switch once, at startup, and says so in the journal", () => {
    expect(index).toMatch(/resolveShadowMode\s*\(\s*process\.env\s*\)/);
    expect(index).toMatch(/shadowBanner\s*\(/);
  });

  it("gates the scheduler on the switch, verbatim, so a refactor cannot lose it", () => {
    expect(index).toMatch(/if\s*\(!shadow\.enabled\)\s*initScheduler\(/);
  });

  it("leaves the open handler BEFORE it starts the flush timer or the catch-up", () => {
    const gate = index.indexOf("shadowOpenNotice");
    expect(gate).toBeGreaterThan(0);
    for (const call of ["startBatchFlushTimer(driver", "recoverGroupMessages(driver", "postSyncParticipants("]) {
      expect(index.indexOf(call), call).toBeGreaterThan(gate);
    }
  });

  it("still awaits the driver, because createDriver is async now", () => {
    expect(index).toMatch(/await createDriver\(process\.env\)/);
  });

  it("makes exactly one read in shadow mode, and it is a read", () => {
    // WA_SHADOW_GROUP is how the restart-replay question gets an answer in
    // the shape the real catch-up would have seen. It must stay a read:
    // the call is fetchRecentGroupMessages and nothing follows it into
    // enqueueForAnalysis.
    const gate = index.indexOf("shadowGroup(process.env)");
    expect(gate).toBeGreaterThan(0);
    const block = index.slice(gate, gate + 1200);
    expect(block).toMatch(/fetchRecentGroupMessages\(watching, 50\)/);
    expect(block).not.toMatch(/enqueueForAnalysis|post[A-Z]/);
  });
});

describe("the Baileys driver is only reachable in shadow mode", () => {
  const select = read("driver-select.ts");

  it("driver-select refuses baileys unless the shadow switch is on", () => {
    // The guarantee Kemal asked for: nothing can post to Sutton's group
    // under Baileys until somebody deliberately changes this file.
    expect(select).toMatch(/resolveShadowMode|ShadowMode/);
    expect(select).toMatch(/shadow/i);
  });

  it("wraps whatever driver it builds in the guard when shadow mode is on", () => {
    expect(select).toMatch(/shadowGuard\s*\(/);
  });
});
