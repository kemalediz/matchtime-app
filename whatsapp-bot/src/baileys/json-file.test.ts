/**
 * The small JSON files kept beside the auth state: harvested contact names
 * and the polls we sent. Written atomically and 0600, read defensively.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebouncedWriter, jsonFileIO } from "./json-file.js";
import { manualScheduler } from "./fake-socket.js";

describe("jsonFileIO", () => {
  it("round-trips a value, owner-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt-json-"));
    const io = jsonFileIO(join(dir, "x.json"));
    io.save({ a: [1, 2] });
    expect(io.load()).toEqual({ a: [1, 2] });
    expect(statSync(join(dir, "x.json")).mode & 0o777).toBe(0o600);
  });

  it("reads a missing or corrupt file as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt-json-"));
    expect(jsonFileIO(join(dir, "missing.json")).load()).toBeNull();
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(jsonFileIO(join(dir, "bad.json")).load()).toBeNull();
  });

  it("never leaves a half-written file behind: it writes a temp file and renames it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mt-json-"));
    const io = jsonFileIO(join(dir, "x.json"));
    io.save({ v: 1 });
    io.save({ v: 2 });
    expect(JSON.parse(readFileSync(join(dir, "x.json"), "utf8"))).toEqual({ v: 2 });
  });
});

describe("createDebouncedWriter", () => {
  it("coalesces a burst of changes into one write after the delay", async () => {
    const s = manualScheduler();
    let writes = 0;
    const w = createDebouncedWriter(() => void writes++, { delayMs: 30_000, schedule: s.schedule });
    w.markDirty();
    w.markDirty();
    w.markDirty();
    expect(s.delays()).toEqual([30_000]);
    await s.runAll();
    expect(writes).toBe(1);
  });

  it("flushes at once on close, and not again if nothing changed", () => {
    const s = manualScheduler();
    let writes = 0;
    const w = createDebouncedWriter(() => void writes++, { delayMs: 30_000, schedule: s.schedule });
    w.flush();
    expect(writes).toBe(0);
    w.markDirty();
    w.flush();
    w.flush();
    expect(writes).toBe(1);
  });

  it("logs a failed write and keeps the change pending for the next try", () => {
    const s = manualScheduler();
    let fail = true;
    let writes = 0;
    const errors: string[] = [];
    const w = createDebouncedWriter(
      () => {
        if (fail) throw new Error("EROFS");
        writes++;
      },
      { delayMs: 10, schedule: s.schedule, error: (l) => errors.push(l) },
    );
    w.markDirty();
    w.flush();
    expect(errors.join()).toMatch(/EROFS/);
    fail = false;
    w.flush();
    expect(writes).toBe(1);
  });
});
