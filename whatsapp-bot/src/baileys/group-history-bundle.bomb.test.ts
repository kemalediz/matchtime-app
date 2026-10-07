/**
 * A hostile bundle. Anyone who can add the bot to a group can send one,
 * and it is read in the process that serves the live club: a 49 KB
 * download that inflated to 1.8 million entries took that process past
 * 1.6 GB (the adversarial review of PR #217). These pin that the WORK is
 * bounded, not just the bytes: how many entries are ever decoded, how long
 * it takes, and that the event loop gets a turn while it happens.
 */
import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import {
  BUNDLE_DECODE_BUDGET_MS,
  DECODE_CHUNK,
  MAX_BUNDLE_ENC_BYTES,
  MAX_BUNDLE_ENTRIES,
  MAX_BUNDLE_ENTRY_BYTES,
  MAX_BUNDLE_MESSAGES,
  MAX_BUNDLE_PLAIN_BYTES,
  describeProtoShape,
  formatBundleReport,
  readGroupHistoryBundle,
  unpackBundle,
} from "./group-history-bundle.js";
import { encodeWebMessageInfo, encryptBundle, lenField, servingFetch } from "./group-history-fixture.js";

const GROUP = "120363000000000000@g.us";

/** `count` copies of one entry: what a bomb is, and it compresses to almost nothing. */
function repeated(entry: Buffer, count: number): Buffer {
  const one = lenField(1, entry);
  const out = Buffer.alloc(one.length * count);
  for (let i = 0; i < count; i++) one.copy(out, i * one.length);
  return out;
}

const VALID_NO_TEXT = encodeWebMessageInfo({ key: { id: "3EB0AAAAAAAAAAAA" } });
const ID_TOO_SHORT = encodeWebMessageInfo({ key: { id: "AB" } });

function withText(count: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      lenField(
        1,
        encodeWebMessageInfo({
          key: { remoteJid: GROUP, id: `3EB0${String(i).padStart(12, "0")}`, participant: "111111111111111@lid" },
          message: { conversation: `message ${i}` },
          messageTimestamp: 1_759_000_000 + i,
        }),
      ),
    );
  }
  return Buffer.concat(parts);
}

/** Runs `fn` and reports how long it took and how many turns the event loop got meanwhile. */
async function watched<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; ticks: number }> {
  let ticks = 0;
  let running = true;
  const spin = () => {
    if (!running) return;
    ticks++;
    setImmediate(spin);
  };
  setImmediate(spin);
  const started = performance.now();
  const result = await fn();
  const ms = performance.now() - started;
  running = false;
  return { result, ms, ticks };
}

describe("the caps are sized for 600 text messages", () => {
  it("are what the review asked for", () => {
    expect(MAX_BUNDLE_MESSAGES).toBe(600);
    expect(MAX_BUNDLE_ENC_BYTES).toBeLessThanOrEqual(1024 * 1024);
    expect(MAX_BUNDLE_PLAIN_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(MAX_BUNDLE_ENTRIES).toBe(5000);
    expect(MAX_BUNDLE_ENTRY_BYTES).toBe(64 * 1024);
    expect(BUNDLE_DECODE_BUDGET_MS).toBe(2000);
  });
});

describe("millions of minimal entries with valid ids and no text", () => {
  const bomb = deflateSync(repeated(VALID_NO_TEXT, 1_800_000));

  it("is a small download", () => {
    expect(bomb.length).toBeLessThan(100_000);
  });

  it("is refused while inflating, with nothing decoded", async () => {
    const { result, ms } = await watched(() => unpackBundle(bomb, GROUP));
    expect(result).toEqual({
      ok: false,
      reason: `the payload inflates (zlib inflate) past the ${MAX_BUNDLE_PLAIN_BYTES} bytes this will read; nothing was decoded`,
      shapes: [],
    });
    expect(ms).toBeLessThan(1500);
  });

  it("is refused on its entry count even if it fits the byte cap, with nothing decoded", async () => {
    // 2 MB of 20-byte entries is about 100,000 of them.
    const fits = deflateSync(repeated(VALID_NO_TEXT, 90_000));
    let decodes = 0;
    const { result, ms } = await watched(() =>
      unpackBundle(fits, GROUP, {
        nowMs: () => {
          decodes++;
          return 0;
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(
      `the payload has more than ${MAX_BUNDLE_ENTRIES} entries (read as GroupHistory); nothing was decoded`,
    );
    // The decode loop (the only thing that reads the clock) never ran.
    expect(decodes).toBe(0);
    expect(ms).toBeLessThan(1500);
  });

  it("is refused the same way at any size the byte cap is raised to", async () => {
    const { result, ms } = await watched(() => unpackBundle(bomb, GROUP, { maxPlainBytes: 64 * 1024 * 1024 }));
    expect(!result.ok && result.reason).toContain(`more than ${MAX_BUNDLE_ENTRIES} entries`);
    expect(ms).toBeLessThan(1500);
  });

  it("end to end, the log line for a refused bomb names the cap and nothing else", async () => {
    const { enc, bundle } = encryptBundle(bomb, { messageCount: 35 });
    const r = await readGroupHistoryBundle(bundle, GROUP, { fetchBundle: servingFetch(enc).fetchBundle });
    expect(r.ok).toBe(false);
    expect(formatBundleReport(r.report)).toEqual([
      `FAILED at decode: the payload inflates (zlib inflate) past the ${MAX_BUNDLE_PLAIN_BYTES} bytes this will read; ` +
        `nothing was decoded (stated messageCount=35); before that: downloaded ${enc.length} bytes (http 200); ` +
        `decrypted with "Group History" (candidate 1 of 4, download hash ok, content hash ok) to ${bomb.length} bytes`,
    ]);
  });
});

describe("entries whose ids are too short, so no decoder recognises them", () => {
  it("fails on a sample, not by running every decoder over every entry", async () => {
    const payload = deflateSync(repeated(ID_TOO_SHORT, MAX_BUNDLE_ENTRIES));
    let clockReads = 0;
    const { result, ms } = await watched(() =>
      unpackBundle(payload, GROUP, {
        nowMs: () => {
          clockReads++;
          return 0;
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("no protobuf candidate found a message in the payload");
    expect(clockReads).toBe(0);
    expect(ms).toBeLessThan(1500);
  });

  it("describes the shape of a huge payload without counting all of it", () => {
    const huge = repeated(ID_TOO_SHORT, 400_000);
    const started = performance.now();
    expect(describeProtoShape(huge)).toBe("1:len x20000 (stopped counting after 20000 fields)");
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("valid ids with text", () => {
  it("decodes at most 600 entries, the last ones, and yields to the event loop while it does", async () => {
    const payload = deflateSync(withText(MAX_BUNDLE_ENTRIES));
    let yields = 0;
    const { result, ms, ticks } = await watched(() =>
      unpackBundle(payload, GROUP, {
        yieldToLoop: () => {
          yields++;
          return new Promise<void>((r) => setImmediate(r));
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toBe(MAX_BUNDLE_ENTRIES);
    expect(result.read).toBe(MAX_BUNDLE_MESSAGES);
    expect(result.rows).toHaveLength(MAX_BUNDLE_MESSAGES);
    expect(result.rows[0].text).toBe(`message ${MAX_BUNDLE_ENTRIES - MAX_BUNDLE_MESSAGES}`);
    expect(result.rows.at(-1)?.text).toBe(`message ${MAX_BUNDLE_ENTRIES - 1}`);
    expect(result.partial).toBe(false);
    expect(yields).toBe(MAX_BUNDLE_MESSAGES / DECODE_CHUNK - 1);
    expect(ticks).toBeGreaterThanOrEqual(yields);
    expect(ms).toBeLessThan(BUNDLE_DECODE_BUDGET_MS + 1000);
  });

  it("one entry over the ceiling refuses the whole payload", async () => {
    const r = await unpackBundle(deflateSync(withText(MAX_BUNDLE_ENTRIES + 1)), GROUP, { maxPlainBytes: 8 * 1024 * 1024 });
    expect(!r.ok && r.reason).toContain(`more than ${MAX_BUNDLE_ENTRIES} entries`);
  });

  it("stops when the time budget is spent and keeps the newest it had read", async () => {
    let clock = 0;
    const r = await unpackBundle(deflateSync(withText(600)), GROUP, {
      // Every chunk "takes" 900 ms: the budget is gone after the third.
      nowMs: () => (clock += 900),
      yieldToLoop: async () => {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.partial).toBe(true);
    expect(r.read).toBe(3 * DECODE_CHUNK);
    expect(r.rows.map((x) => x.text)).toEqual(
      Array.from({ length: 3 * DECODE_CHUNK }, (_, i) => `message ${600 - 3 * DECODE_CHUNK + i}`),
    );
  });

  it("counts an oversized entry and never decodes it", async () => {
    const big = lenField(
      1,
      encodeWebMessageInfo({
        key: { remoteJid: GROUP, id: "3EB0BBBBBBBBBBBB", participant: "111111111111111@lid" },
        message: { conversation: "x".repeat(MAX_BUNDLE_ENTRY_BYTES + 1) },
      }),
    );
    const r = await unpackBundle(deflateSync(Buffer.concat([withText(3), big])), GROUP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries).toBe(4);
    expect(r.tooLarge).toBe(1);
    expect(r.read).toBe(3);
    expect(r.rows).toHaveLength(3);
  });

  it("the caller cannot raise the number of entries decoded past 600", async () => {
    const r = await unpackBundle(deflateSync(withText(900)), GROUP, { limit: 100_000 });
    expect(r.ok && r.read).toBe(MAX_BUNDLE_MESSAGES);
  });
});
