/**
 * The polls we sent, on disk, so a MoM vote cast after a restart can still
 * be decrypted. Votes trickle in for a day and a half after kickoff, and a
 * deploy in that window used to cost every vote after it: the secret that
 * decrypts them lived only in memory.
 */
import { describe, it, expect } from "vitest";
import { createPollArchive, POLL_ARCHIVE_MAX_AGE_MS, type PollArchiveIO } from "./poll-store.js";

function memoryIO(initial: unknown = null) {
  const io = { value: initial as unknown, saves: 0 } as { value: unknown; saves: number } & PollArchiveIO;
  io.load = () => io.value;
  io.save = (v: unknown) => {
    io.value = JSON.parse(JSON.stringify(v));
    io.saves++;
  };
  return io;
}

describe("createPollArchive", () => {
  it("remembers a poll and saves it at once: a vote may arrive after the next crash", () => {
    const io = memoryIO();
    const a = createPollArchive({ io, now: () => 1000 });
    a.remember("P1", "120363@g.us", "AAAA");
    expect(io.saves).toBe(1);
    expect(a.get("P1")).toBe("AAAA");
  });

  it("reloads what a previous process saved", () => {
    const io = memoryIO();
    createPollArchive({ io, now: () => 1000 }).remember("P1", "120363@g.us", "AAAA");
    expect(createPollArchive({ io, now: () => 2000 }).get("P1")).toBe("AAAA");
  });

  it("forgets polls older than the age limit, on load and on read", () => {
    const io = memoryIO();
    let t = 0;
    const a = createPollArchive({ io, now: () => t });
    a.remember("OLD", "g@g.us", "AAAA");
    t = POLL_ARCHIVE_MAX_AGE_MS + 1;
    expect(a.get("OLD")).toBeUndefined();
    expect(createPollArchive({ io, now: () => t }).size()).toBe(0);
  });

  it("is bounded: pinning must never become the leak the bound exists to prevent", () => {
    const io = memoryIO();
    const a = createPollArchive({ io, max: 3, now: () => 0 });
    for (const id of ["A", "B", "C", "D"]) a.remember(id, "g@g.us", "AAAA");
    expect(a.size()).toBe(3);
    expect(a.get("A")).toBeUndefined();
    expect(a.get("D")).toBe("AAAA");
  });

  it("treats a missing, corrupt or hostile file as empty rather than crashing the bot", () => {
    for (const bad of [null, "nonsense", { polls: "x" }, { polls: [{ id: 1 }, null, { id: "Z" }] }]) {
      expect(createPollArchive({ io: memoryIO(bad), now: () => 0 }).size()).toBe(0);
    }
  });

  it("survives a save that throws: the poll is still held in memory", () => {
    const io = memoryIO();
    io.save = () => {
      throw new Error("disk full");
    };
    const errors: string[] = [];
    const a = createPollArchive({ io, now: () => 0, error: (l) => errors.push(l) });
    a.remember("P1", "g@g.us", "AAAA");
    expect(a.get("P1")).toBe("AAAA");
    expect(errors.join()).toMatch(/disk full/);
  });
});
