/**
 * A DELETE THE SERVER HAS NOT TAKEN IS NEVER LOST (2026-11-15, round 2).
 *
 * The Pi keeps every delete and edit in a small file beside
 * `.dm-pacing.json` until the server has taken it, retries with backoff,
 * and reads it back after a restart, so a failed post (the server down, a
 * deploy, a Pi that came up first) is retried, not forgotten. Bounded in
 * count and in age. A fake clock and an in-memory file: no network, no
 * WhatsApp. Simulated numbers.
 */
import { describe, it, expect, vi } from "vitest";
import type { JsonIO } from "./baileys/json-file.js";
import { backoffMs, createMessageChangeOutbox, OUTBOX_MAX } from "./message-change-outbox.js";
import type { LocalMessageChange } from "./message-change.js";

const G = "120363000000000000@g.us";
const change = (messageId: string, kind: "revoke" | "edit" = "revoke", extra: Partial<LocalMessageChange> = {}): LocalMessageChange => ({
  kind,
  groupId: G,
  messageId,
  senderJids: ["447700900123@c.us"],
  senderPhone: "447700900123",
  byAdmin: false,
  ...extra,
});

function memoryFile(initial: unknown = null): JsonIO & { saved: unknown } {
  const f = {
    saved: initial,
    load: () => (f.saved === null ? null : JSON.parse(JSON.stringify(f.saved))),
    save: (v: unknown) => {
      f.saved = JSON.parse(JSON.stringify(v));
    },
  };
  return f;
}

function setup(opts: { file?: ReturnType<typeof memoryFile>; ok?: () => boolean; recheck?: () => Promise<boolean | null> } = {}) {
  let t = 1_763_200_000_000;
  const file = opts.file ?? memoryFile();
  const post = vi.fn(async (_c: LocalMessageChange) => (opts.ok ? opts.ok() : true));
  const resolved = vi.fn();
  const logs: string[] = [];
  const box = createMessageChangeOutbox({
    io: file,
    now: () => t,
    post,
    ...(opts.recheck ? { recheckAdmin: opts.recheck, onResolved: resolved } : {}),
    log: (l) => logs.push(l),
    error: (l) => logs.push(`ERR ${l}`),
  });
  return { box, file, post, resolved, logs, advance: (ms: number) => (t += ms), now: () => t };
}

describe("the outbox", () => {
  it("is written to its file BEFORE the first post, so a crash mid-post loses nothing", async () => {
    const t = setup();
    const key = t.box.record(change("MSG000000001"));
    expect(JSON.stringify(t.file.saved)).toContain("MSG000000001");
    expect(t.post).not.toHaveBeenCalled();
    expect(await t.box.attempt(key)).toBe(true);
    expect(t.box.pending()).toBe(0);
  });

  it("a failed post is retried with backoff until the server takes it", async () => {
    let up = false;
    const t = setup({ ok: () => up });
    const key = t.box.record(change("MSG000000002"));
    expect(await t.box.attempt(key)).toBe(false);
    expect(t.box.pending()).toBe(1);
    // Not yet due: nothing is posted.
    t.advance(backoffMs(1) - 1);
    expect(await t.box.drainDue()).toBe(0);
    expect(t.post).toHaveBeenCalledTimes(1);
    t.advance(1);
    expect(await t.box.drainDue()).toBe(0);
    expect(t.post).toHaveBeenCalledTimes(2);
    up = true;
    t.advance(backoffMs(2));
    expect(await t.box.drainDue()).toBe(1);
    expect(t.box.pending()).toBe(0);
  });

  it("backoff doubles from 15 seconds and stops growing at 15 minutes", () => {
    expect(backoffMs(1)).toBe(15_000);
    expect(backoffMs(2)).toBe(30_000);
    expect(backoffMs(20)).toBe(15 * 60_000);
  });

  it("after a restart the file is read back: what was not taken is retried, and every change is handed back for the Pi's own record", async () => {
    const file = memoryFile();
    const first = setup({ file, ok: () => false });
    await first.box.attempt(first.box.record(change("MSG000000003")));
    const okKey = first.box.record(change("MSG000000004", "edit"));
    first.post.mockResolvedValueOnce(true);
    await first.box.attempt(okKey);

    const second = setup({ file });
    const restored = second.box.load();
    expect(restored.map((c) => c.messageId)).toEqual(["MSG000000003", "MSG000000004"]);
    expect(second.box.pending()).toBe(1);
    second.advance(backoffMs(1));
    expect(await second.box.drainDue()).toBe(1);
    expect(second.post).toHaveBeenCalledWith(expect.objectContaining({ messageId: "MSG000000003" }));
  });

  it("a taken change is kept a day (for late copies after a restart), then goes from the file", async () => {
    const t = setup();
    await t.box.attempt(t.box.record(change("MSG000000005", "edit")));
    t.advance(24 * 60 * 60 * 1000 + 1);
    t.box.record(change("MSG000000006"));
    expect(JSON.stringify(t.file.saved)).not.toContain("MSG000000005");
  });

  it("gives up on a change after seven days, saying so by id only", async () => {
    const t = setup({ ok: () => false });
    const key = t.box.record(change("MSG000000007", "edit"));
    await t.box.attempt(key);
    t.advance(7 * 24 * 60 * 60 * 1000 + 1);
    await t.box.drainDue();
    expect(t.box.pending()).toBe(0);
    expect(t.logs.join("\n")).toMatch(/ERR .*MSG000000007.*gave up/);
    expect(t.logs.join("\n")).not.toContain("new words");
  });

  it("is bounded: past OUTBOX_MAX the oldest TAKEN changes go first, and a change not yet taken is the last to go", async () => {
    const t = setup({ ok: () => true });
    const firstKey = t.box.record(change("KEEPME000001"));
    t.post.mockResolvedValueOnce(false);
    await t.box.attempt(firstKey);
    for (let i = 0; i < OUTBOX_MAX + 5; i++) await t.box.attempt(t.box.record(change(`MSG${String(i).padStart(9, "0")}`)));
    const saved = t.file.saved as { entries: unknown[] };
    expect(saved.entries.length).toBeLessThanOrEqual(OUTBOX_MAX);
    expect(JSON.stringify(saved)).toContain("KEEPME000001");
  });

  it("no edit's words are ever in the file: an edit is a purge", async () => {
    const t = setup();
    await t.box.attempt(t.box.record(change("MSG000000020", "edit")));
    expect(JSON.stringify(t.file.saved)).not.toMatch(/"text"|mention/);
  });

  it("a delete whose admin status could not be read stays pending and is checked again on its retry: posted as an admin's once it is known", async () => {
    const answers: Array<boolean | null> = [null, true];
    const t = setup({ recheck: async () => answers.shift() ?? null });
    const key = t.box.record(change("MSG000000021", "revoke", { adminUnknown: true }));
    // First attempt: still unknown. Posted (it applies to the sender's own message meanwhile) but kept.
    expect(await t.box.attempt(key)).toBe(false);
    expect(t.post).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: "MSG000000021", byAdmin: false }));
    expect(t.box.pending()).toBe(1);
    t.advance(backoffMs(1));
    await t.box.drainDue();
    expect(t.post).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: "MSG000000021", byAdmin: true }));
    expect(t.post.mock.calls.at(-1)?.[0]).not.toHaveProperty("adminUnknown");
    expect(t.resolved).toHaveBeenCalledWith(expect.objectContaining({ messageId: "MSG000000021", byAdmin: true }));
    expect(t.box.pending()).toBe(0);
  });

  it("a re-check that finds the sender is NOT an admin settles it as the sender's own delete", async () => {
    const t = setup({ recheck: async () => false });
    const key = t.box.record(change("MSG000000022", "revoke", { adminUnknown: true }));
    expect(await t.box.attempt(key)).toBe(true);
    expect(t.post).toHaveBeenLastCalledWith(expect.objectContaining({ byAdmin: false }));
    expect(t.resolved).not.toHaveBeenCalled();
    expect(t.box.pending()).toBe(0);
  });

  it("a corrupt or missing file is an empty outbox, never a crash", () => {
    expect(setup({ file: memoryFile({ entries: "nope" }) }).box.load()).toEqual([]);
    expect(setup({ file: memoryFile(null) }).box.load()).toEqual([]);
    const none = createMessageChangeOutbox({ io: null, now: () => 0, post: async () => true, log: () => {}, error: () => {} });
    expect(none.load()).toEqual([]);
  });
});
