/**
 * SOURCE GUARDS: ONE PLACE PICKS THE CHANNEL (WhatsApp Cloud API plan,
 * PR C1; MDs/whatsapp-cloud-api-plan-2026-11-04.md section 5.1).
 *
 * Kemal (4 Nov 2026): the club number (Baileys on the Pi) keeps the club
 * groups, HQ and DMs to members; the official number (Cloud API) gets the
 * first contact with strangers and the codes. One ban of the club number
 * takes down every club at once, so which number a message uses must be
 * decided in exactly one place, where a review can see it:
 *
 *   1. the flags `CLOUD_API_ENABLED` and `CLOUD_API_PURPOSES` are read
 *      only by src/lib/send-channel.ts;
 *   2. the official number `WA_CLOUD_NUMBER` is read only by
 *      src/lib/club-connect.ts, the server only reader of the club number
 *      (wa-number-server-only.test.ts covers both);
 *   3. `channelFor`, `waLinkChannelFor` and `waNumberFor` are called only
 *      from an allowlist. Adding a caller means editing this file, on
 *      purpose, in review (PR C2 adds queuePlatformDm, PR C7b the wa.me
 *      links);
 *   4. send-channel.ts stays pure: type imports only, no database, no
 *      network, nothing awaited;
 *   5. a BotJob (club DMs, HQ, group posts) never asks: no file that
 *      writes a BotJob imports send-channel.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..", "..");
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

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

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FILES = walk(SRC);
const code = (f: string) => stripComments(readFileSync(f, "utf8"));
const CHANNEL_MODULE = "lib/send-channel.ts";
const NUMBER_READER = "lib/club-connect.ts";
const PLATFORM_JOBS = "lib/platform-jobs.ts";

const SEND_CHANNEL_IMPORT = /from\s+["'](?:@\/lib\/send-channel|\.{1,2}\/(?:[\w-]+\/)*send-channel)["']|import\(\s*["'][^"']*send-channel["']\s*\)/;

/** Files that may call the deciding functions. Extend deliberately. */
const CHANNEL_CALLERS = new Set<string>([
  // waNumberFor lives here, next to the club number's reader, and asks
  // nothing: it turns a decided channel into digits.
  NUMBER_READER,
  // PR C2: queuePlatformDm asks once and stores the answer on the job.
  PLATFORM_JOBS,
]);

/** PR C4: the Cloud dispatcher. It asks the master switch (`cloudApiEnabled`)
 *  and, for a send that failed, `fallbackWhenCloudDown`; its pure rules read
 *  `ANSWER_PURPOSES` to put answers first. Neither picks a job's channel. */
const CLOUD_DISPATCH = "lib/cloud-api/dispatch.ts";
const CLOUD_DISPATCH_RULES = "lib/cloud-api/dispatch-rules.ts";

/** PR C5: the Cloud webhook. It asks the master switch (`cloudApiEnabled`)
 *  and labels what came in on the official number; it picks no channel
 *  for anything sent. */
const CLOUD_WEBHOOK = "lib/cloud-api/webhook.ts";

/** Review of #556, S1: Meta's status rules. They hand a failed live code
 *  to the club number with `codeHandoverChannel`'s answer, and import
 *  nothing from send-channel. */
const CLOUD_STATUS_RULES = "lib/cloud-api/status-rules.ts";

/** Files that may import send-channel (types included). Extend deliberately. */
const CHANNEL_IMPORTERS = new Set<string>([NUMBER_READER, PLATFORM_JOBS, CLOUD_DISPATCH, CLOUD_DISPATCH_RULES, CLOUD_WEBHOOK]);

describe("the flags are read in one place", () => {
  it("only send-channel.ts reads CLOUD_API_ENABLED or CLOUD_API_PURPOSES", () => {
    const readers = FILES.filter((f) => /CLOUD_API_(ENABLED|PURPOSES)/.test(code(f))).map(rel);
    expect(readers).toEqual([CHANNEL_MODULE]);
  });

  it("only club-connect.ts reads WA_CLOUD_NUMBER", () => {
    const readers = FILES.filter((f) => /WA_CLOUD_NUMBER/.test(code(f))).map(rel);
    expect(readers).toEqual([NUMBER_READER]);
  });
});

describe("nothing else picks a channel", () => {
  it("channelFor, waLinkChannelFor and waNumberFor are called only from the allowlist", () => {
    const callers = FILES.filter((f) => rel(f) !== CHANNEL_MODULE && /\b(channelFor|waLinkChannelFor|waNumberFor)\s*\(/.test(code(f)))
      .map(rel)
      .filter((f) => !CHANNEL_CALLERS.has(f));
    expect(callers).toEqual([]);
  });

  it("send-channel is imported only from the allowlist", () => {
    const importers = FILES.filter((f) => SEND_CHANNEL_IMPORT.test(code(f)))
      .map(rel)
      .filter((f) => !CHANNEL_IMPORTERS.has(f));
    expect(importers).toEqual([]);
  });

  it("no file outside the two homes names the official number's channel switch in code", () => {
    // A hand rolled `channel: "cloud"` elsewhere would be a second decider.
    const offenders = FILES.filter((f) => ![CHANNEL_MODULE, NUMBER_READER].includes(rel(f)))
      .filter((f) => /\bchannel\s*[:=]{1,3}\s*["']cloud["']/.test(code(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the matchers are not vacuous", () => {
    expect(SEND_CHANNEL_IMPORT.test(`import { channelFor } from "@/lib/send-channel";`)).toBe(true);
    expect(SEND_CHANNEL_IMPORT.test(`import type { SendChannel } from "./send-channel";`)).toBe(true);
    expect(SEND_CHANNEL_IMPORT.test(`const m = await import("@/lib/send-channel");`)).toBe(true);
    expect(SEND_CHANNEL_IMPORT.test(`import { x } from "@/lib/club-connect";`)).toBe(false);
    expect(FILES.map(rel)).toContain(CHANNEL_MODULE);
    expect(FILES.filter((f) => /\bwaNumberFor\s*\(/.test(code(f))).map(rel)).toContain(NUMBER_READER);
  });
});

describe("send-channel.ts is pure", () => {
  const src = code(path.join(SRC, CHANNEL_MODULE));

  it("has type imports only", () => {
    const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l));
    expect(imports.filter((l) => !/^\s*import\s+type\s/.test(l))).toEqual([]);
  });

  it("touches no database, network or clock", () => {
    expect(src).not.toMatch(/\bdb\./);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bawait\b/);
    expect(src).not.toMatch(/\basync\b/);
    expect(src).not.toMatch(/new Date\(|Date\.now\(/);
  });
});

describe("a BotJob never asks for a channel", () => {
  it("no file that writes a BotJob imports send-channel", () => {
    const writers = FILES.filter((f) => /botJob\s*\.\s*(create|createMany|upsert)\s*\(/.test(code(f)));
    expect(writers.length).toBeGreaterThan(3);
    expect(writers.filter((f) => SEND_CHANNEL_IMPORT.test(code(f))).map(rel)).toEqual([]);
  });
});

describe("a PlatformJob's channel is decided once, in queuePlatformDm (PR C2)", () => {
  const src = code(path.join(SRC, PLATFORM_JOBS));

  it("platform-jobs.ts calls channelFor exactly once, and nothing else from send-channel", () => {
    expect(src.match(/\bchannelFor\s*\(/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/\b(waLinkChannelFor|waNumberFor|fallbackWhenCloudDown)\s*\(/);
  });

  it("that one call is inside queuePlatformDm, and its answer is what the job stores", () => {
    const start = src.indexOf("export async function queuePlatformDm(");
    const end = src.indexOf("\nexport ", start + 1);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    expect(body).toMatch(/\bchannelFor\s*\(/);
    expect(body).toMatch(/\bchannel,/);
  });

  it("only a handover changes a job's channel, and only the Cloud dispatcher asks for one, with codeHandoverChannel's answer (PR C4)", () => {
    // platform-jobs.ts writes `channel: result.channel` for a handover and
    // nowhere else after queuePlatformDm.
    expect(src.match(/\bchannel:\s*result\.channel\b/g) ?? []).toHaveLength(1);
    // Outside platform-jobs.ts itself, where the outcome is defined.
    const askers = FILES.filter((f) => rel(f) !== PLATFORM_JOBS && /outcome:\s*["']handover["']/.test(code(f))).map(rel);
    expect(askers).toEqual([CLOUD_DISPATCH]);
    const dispatch = code(path.join(SRC, CLOUD_DISPATCH));
    expect(dispatch).toMatch(/const fallback = codeHandoverChannel\(/);
    expect(dispatch).toMatch(/outcome:\s*"handover",\s*channel:\s*fallback\b/);
  });

  it("a handover's channel has one source: codeHandoverChannel, the only caller of fallbackWhenCloudDown (review of #556, S1)", () => {
    // The rule (only codes, only while alive, never to the channel the job
    // is on) lives once, in the dispatcher's pure rules.
    const askers = FILES.filter((f) => rel(f) !== CHANNEL_MODULE && /\bfallbackWhenCloudDown\s*\(/.test(code(f))).map(rel);
    expect(askers).toEqual([CLOUD_DISPATCH_RULES]);
    const rules = code(path.join(SRC, CLOUD_DISPATCH_RULES));
    expect(rules).toMatch(/export function codeHandoverChannel\(/);
    // Its two users: the dispatcher (the send failed) and the status rules
    // (Meta said failed after it accepted the send).
    const users = FILES.filter((f) => rel(f) !== CLOUD_DISPATCH_RULES && /\bcodeHandoverChannel\s*\(/.test(code(f))).map(rel);
    expect(users.sort()).toEqual([CLOUD_DISPATCH, CLOUD_STATUS_RULES].sort());
    // The status rules write a channel only as that answer.
    const status = code(path.join(SRC, CLOUD_STATUS_RULES));
    expect(status).toMatch(/const to = codeHandoverChannel\(/);
    // Its view's field, and the one value it ever writes.
    expect(status.match(/\bchannel:\s*[\w"']+/g) ?? []).toEqual(["channel: HandoverChannel", "channel: to"]);
  });

  it("the Cloud dispatcher names the official number once, as the channel it claims for", () => {
    const dispatch = code(path.join(SRC, CLOUD_DISPATCH));
    expect(dispatch.match(/["']cloud["']/g) ?? []).toHaveLength(1);
    expect(dispatch).toMatch(/const OFFICIAL_NUMBER: SendChannel = "cloud";/);
    expect(dispatch).not.toMatch(/\b(channelFor|waLinkChannelFor|waNumberFor)\s*\(/);
  });

  it("the Cloud webhook names the official number once, asks only the master switch, and decides no channel itself (PR C5; review of #556, S1: a code's handover is the status rules' answer)", () => {
    const hook = code(path.join(SRC, CLOUD_WEBHOOK));
    expect(hook.match(/["']cloud["']/g) ?? []).toHaveLength(1);
    expect(hook).toMatch(/const OFFICIAL_NUMBER: SendChannel = "cloud";/);
    expect(hook).not.toMatch(/\b(channelFor|waLinkChannelFor|waNumberFor|fallbackWhenCloudDown)\s*\(/);
    expect(hook).not.toMatch(/data:\s*\{[^}]*\bchannel\b/);
  });

  it("a code DM has one door, src/lib/code-dm.ts, which picks no channel (PR C7a)", () => {
    // Every code (sign-up, sign-in, claim) is queued by queueCodeDm, so
    // each one carries mt_code; nothing else writes purpose "otp".
    // `purpose: "otp"` in any form outside platform-jobs.ts (where
    // `purpose: "otp" | ...` is a type in its claim reader) is a queue call
    // or a hand rolled code (review of #556, N2: tightened from "followed
    // by a comma or brace", which missed `"otp" as const` and the like).
    const otpQueuers = FILES.filter((f) => rel(f) !== PLATFORM_JOBS && /\bpurpose\s*:\s*["']otp["']/.test(code(f))).map(rel);
    expect(otpQueuers).toEqual(["lib/code-dm.ts"]);
    const door = code(path.join(SRC, "lib/code-dm.ts"));
    expect(door).toMatch(/\bqueuePlatformDm\s*\(/);
    expect(door.match(/\bqueuePlatformDm\s*\(/g) ?? []).toHaveLength(1);
    expect(door).toMatch(/name:\s*"mt_code"/);
    expect(door).not.toMatch(SEND_CHANNEL_IMPORT);
    expect(door).not.toMatch(/\b(channelFor|waLinkChannelFor|waNumberFor)\s*\(/);
    // Review of #556, S2: codes are ISSUED there too (`issueCode`, every
    // cap in one place), and the DM is queued only by it.
    const queuers = FILES.filter((f) => rel(f) !== "lib/code-dm.ts" && /\bqueueCodeDm\s*\(/.test(code(f))).map(rel);
    expect(queuers).toEqual([]);
    // (auth.ts has an issueCode of its own, for email links: not this one.)
    const CODE_DOOR_IMPORT = /\bissueCode\b[^;]*from\s+["'](?:@\/lib|\.{1,2}(?:\/[\w-]+)*)\/code-dm["']/;
    const issuers = FILES.filter((f) => CODE_DOOR_IMPORT.test(code(f)) && /\bissueCode\s*\(/.test(code(f))).map(rel);
    expect(issuers.sort()).toEqual(["app/actions/claim.ts", "app/actions/phone-signup.ts"]);
    // A code is made (PhoneOtp written) only there.
    const makers = FILES.filter((f) => /\bphoneOtp\s*\.\s*(create|createMany|upsert)\s*\(/.test(code(f))).map(rel);
    expect(makers).toEqual(["lib/code-dm.ts"]);
  });

  it("the purpose \"otp\" is named only where codes are defined, queued, planned or sent (review of #556, N2)", () => {
    // Anything else naming it is a new code path to review here first. At
    // runtime `queuePlatformDm` refuses a code for the official number that
    // lacks mt_code, whoever queues it.
    const namers = FILES.filter((f) => /["']otp["']/.test(code(f))).map(rel);
    expect(namers.sort()).toEqual(
      [
        PLATFORM_JOBS, // the purpose list, the planner, the claim reader, the N2 refusal
        CHANNEL_MODULE, // the first contact list and fallbackWhenCloudDown
        "lib/code-dm.ts", // the one door
        CLOUD_DISPATCH, // stranded codes when not configured (S4), the expiry it gives Meta's errors
        CLOUD_DISPATCH_RULES, // codes first, always as their template
        "lib/cloud-api/templates.ts", // mt_code serves otp
      ].sort(),
    );
    expect(code(path.join(SRC, PLATFORM_JOBS))).toMatch(/"code-without-template"/);
  });

  it("the page's number for a code comes only through the code door (PR C7a)", () => {
    const callers = FILES.filter((f) => rel(f) !== NUMBER_READER && /\bcodeSenderNumber\s*\(/.test(code(f))).map(rel);
    expect(callers).toEqual(["lib/code-dm.ts"]);
  });

  it("every other PlatformJob writer leaves channel to the column default (baileys)", () => {
    const writers = FILES.filter((f) => /platformJob\s*\.\s*(create|createMany|upsert)\s*\(/.test(code(f))).map(rel);
    expect(writers.sort()).toEqual(["lib/owner-dm.ts", PLATFORM_JOBS].sort());
    expect(code(path.join(SRC, "lib/owner-dm.ts"))).not.toMatch(/\bchannel\b/);
  });
});
