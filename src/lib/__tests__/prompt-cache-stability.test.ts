/**
 * The cached prompt prefix must not contain a clock.
 *
 * Anthropic prompt caching matches on an EXACT byte prefix. The user
 * message's first content block carries `cache_control: {ttl: "1h"}`,
 * so a single character that changes between calls throws the whole
 * ~2,120-token block from a $0.30/MTok cache READ to a $6/MTok cache
 * WRITE — on every call, all day.
 *
 * Measured before the fix (analyzer-redesign-2026-08-31.md §8.1): four
 * identical requests where only "32.4h until kickoff" became "32.2h"
 * flipped 2,120 tokens from cache_read to cache_write, +40% on the
 * batch. `kickoffHint` changes every ~6 minutes; the Pi flushes every
 * 10. So the cache essentially never hit.
 *
 * These tests pin the invariant: build the cacheable segment at two
 * different wall-clock times with an otherwise identical world, and it
 * must be byte-identical. The volatile values still have to reach the
 * model — they just belong in the uncached segment.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildMatchContextBlock, buildMatchClockBlock } from "@/lib/message-analyzer";

/** A fixed kickoff, so the ONLY thing that varies between builds is the clock. */
const KICKOFF = new Date("2026-09-01T20:30:00.000Z");

const SQUAD = ["Elvin", "Mustafa", "Idris", "Sait", "Kemal", "Elnur", "Najib", "Wasim"];

function contextAt(nowIso: string, names: string[] = SQUAD): string {
  vi.setSystemTime(new Date(nowIso));
  return buildMatchContextBlock({
    orgName: "Sutton Football Club",
    match: {
      activity: { name: "Tuesday 7-a-side", venue: "Sim Arena" },
      date: KICKOFF,
      status: "UPCOMING",
      maxPlayers: 14,
      attendances: names.map((name, i) => ({
        status: "CONFIRMED",
        user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
      })),
    },
    teamLabels: ["Reds", "Yellows"],
    alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
  });
}

function clockAt(nowIso: string): string {
  vi.setSystemTime(new Date(nowIso));
  return buildMatchClockBlock(KICKOFF);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("cacheable Match Context segment", () => {
  it("is byte-identical when only the clock advances by 6 minutes", () => {
    vi.useFakeTimers();
    // 6 minutes is the interval at which `${h.toFixed(1)}h until kickoff`
    // changes — the exact cache-buster measured in production.
    const a = contextAt("2026-08-31T12:00:00.000Z");
    const b = contextAt("2026-08-31T12:06:00.000Z");
    expect(b).toBe(a);
  });

  it("is byte-identical across a proximity-bucket change (future → tonight)", () => {
    vi.useFakeTimers();
    // 3 days out ("future") vs 2h out ("tonight"). Even the bucket and
    // the roster header must not live in the cached segment.
    const a = contextAt("2026-08-29T20:30:00.000Z");
    const b = contextAt("2026-09-01T18:30:00.000Z");
    expect(b).toBe(a);
  });

  it("is byte-identical before and after kickoff", () => {
    vi.useFakeTimers();
    const a = contextAt("2026-09-01T18:30:00.000Z");
    const b = contextAt("2026-09-01T22:30:00.000Z"); // 2h SINCE kickoff
    expect(b).toBe(a);
  });

  it("carries no clock-derived token at all", () => {
    vi.useFakeTimers();
    const block = contextAt("2026-08-31T12:00:00.000Z");
    expect(block).not.toContain("until kickoff");
    expect(block).not.toContain("since kickoff");
    expect(block).not.toContain("proximity=");
    expect(block).not.toContain("Use roster header:");
  });

  it("still changes when the WORLD changes (the cache must invalidate then)", () => {
    vi.useFakeTimers();
    const a = contextAt("2026-08-31T12:00:00.000Z");
    const b = contextAt("2026-08-31T12:00:00.000Z", [...SQUAD, "Habib"]);
    expect(b).not.toBe(a);
  });
});

describe("uncached Match timing segment", () => {
  it("still hands the model the hint, the proximity and the roster header", () => {
    vi.useFakeTimers();
    const block = clockAt("2026-08-31T12:00:00.000Z");
    expect(block).toContain("Kickoff (London):");
    expect(block).toMatch(/\d+\.\dh until kickoff/);
    expect(block).toContain("proximity=");
    expect(block).toContain("Use roster header:");
  });

  it("recomputes the countdown as the clock advances", () => {
    vi.useFakeTimers();
    const a = clockAt("2026-08-31T12:00:00.000Z");
    const b = clockAt("2026-08-31T12:06:00.000Z");
    expect(b).not.toBe(a);
  });

  it("buckets proximity exactly as it always did", () => {
    vi.useFakeTimers();
    expect(clockAt("2026-09-01T22:30:00.000Z")).toContain("proximity=past");
    expect(clockAt("2026-09-01T22:30:00.000Z")).toContain("2.0h since kickoff");
    expect(clockAt("2026-09-01T18:30:00.000Z")).toContain("proximity=tonight");
    expect(clockAt("2026-09-01T18:30:00.000Z")).toContain("*Playing tonight:*");
    expect(clockAt("2026-09-01T02:30:00.000Z")).toContain("proximity=tomorrow");
    expect(clockAt("2026-09-01T02:30:00.000Z")).toContain("*Playing tomorrow:*");
    expect(clockAt("2026-08-29T20:30:00.000Z")).toContain("proximity=this-week");
    expect(clockAt("2026-08-20T20:30:00.000Z")).toContain("proximity=future");
    // Day-name headers come from the KICKOFF date, not from today.
    // (Regex, not a literal: ICU renders the month as "Sep" or "Sept"
    // depending on the Node build, and that is pre-existing behaviour
    // this change must not touch.)
    expect(clockAt("2026-08-29T20:30:00.000Z")).toMatch(/\*Playing Tue 1 Sept? /);
  });

  it("is empty when there is no upcoming match", () => {
    expect(buildMatchClockBlock(null)).toBe("");
  });
});
