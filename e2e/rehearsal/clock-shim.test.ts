import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { makeShiftedDate, fileOffsetReader } = require("./clock-shim.cjs") as {
  makeShiftedDate: (real: DateConstructor, off: () => number) => DateConstructor;
  fileOffsetReader: (file: string, real: DateConstructor) => () => number;
};

describe("the rehearsal clock shim", () => {
  it("moves only 'now': Date.now(), new Date() and Date() follow the offset", () => {
    const DAY = 86_400_000;
    const D = makeShiftedDate(Date, () => 10 * DAY);
    const real = Date.now();
    expect(Math.abs(D.now() - (real + 10 * DAY))).toBeLessThan(1000);
    expect(Math.abs(new D().getTime() - (real + 10 * DAY))).toBeLessThan(1000);
    expect(new Date((D as unknown as () => string)()).getTime()).toBeGreaterThan(real + 9 * DAY);
  });

  it("leaves every explicit date, parse and UTC alone, and dates stay real Dates", () => {
    const D = makeShiftedDate(Date, () => 123_456_789);
    expect(new D("2027-01-04T09:00:00Z").toISOString()).toBe("2027-01-04T09:00:00.000Z");
    expect(new D(0).getTime()).toBe(0);
    expect(D.UTC(2027, 0, 4)).toBe(Date.UTC(2027, 0, 4));
    expect(D.parse("2027-01-04T09:00:00Z")).toBe(Date.parse("2027-01-04T09:00:00Z"));
    const made = new D();
    expect(made instanceof Date).toBe(true);
    expect(new Date() instanceof D).toBe(true);
  });

  it("a garbled or missing offset is the real clock", () => {
    const D = makeShiftedDate(Date, () => Number.NaN);
    expect(Math.abs(D.now() - Date.now())).toBeLessThan(1000);
  });

  it("is given to the server only when a rehearsal is asked for", async () => {
    const { rehearsalServerEnv } = await import("../helpers/env");
    expect(rehearsalServerEnv({})).toEqual({});
    const env = rehearsalServerEnv({ MT_REHEARSAL_SCENARIO: "x.json", NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(env.NODE_OPTIONS).toMatch(/^--max-old-space-size=4096 --require ".*e2e\/rehearsal\/clock-shim\.cjs"$/);
    expect(env.MT_REHEARSAL_CLOCK_FILE).toMatch(/\.e2e\/rehearsal-clock\.json$/);
  });

  it("reads the offset from its file, and 0 when the file is missing or garbled", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-clock-"));
    const file = path.join(dir, "clock.json");
    // A fake clock that advances past the cache window on every read.
    let t = 0;
    const FakeDate = { now: () => (t += 1000) } as unknown as DateConstructor;
    const read = fileOffsetReader(file, FakeDate);
    expect(read()).toBe(0);
    writeFileSync(file, JSON.stringify({ offsetMs: 5000 }));
    expect(read()).toBe(5000);
    writeFileSync(file, "{not json");
    expect(read()).toBe(0);
  });
});
