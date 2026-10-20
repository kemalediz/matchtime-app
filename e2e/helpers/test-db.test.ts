/**
 * The spec-side database reads and writes instants the way Prisma does.
 *
 * Prisma keeps a DateTime in a `timestamp(3)` column (no zone) holding the
 * UTC wall time. Plain `pg` reads such a column as the MACHINE's local time
 * and writes a JS Date as local time too, so on a laptop in British Summer
 * Time every instant a spec read came back an hour early. On Tue 2026-10-20
 * at 03:50 London that moved the seed's "pay" match (00:50 London, the 20th)
 * onto Monday the 19th, and monthly-squad.spec.ts expected two games left
 * where MatchTime, reading the same row through Prisma, rightly counted one.
 */
import { describe, expect, it } from "vitest";
import { parseUtcTimestamp, toPgParam } from "./test-db";

describe("the spec-side database and Prisma agree on every instant", () => {
  it("a stored timestamp is read as UTC, whatever the machine's zone", () => {
    expect(parseUtcTimestamp("2026-10-19 23:55:00").toISOString()).toBe("2026-10-19T23:55:00.000Z");
    expect(parseUtcTimestamp("2026-10-19 23:55:00.123").toISOString()).toBe("2026-10-19T23:55:00.123Z");
    // The failing morning: this row is 00:55 on Tuesday the 20th in London.
    const pay = parseUtcTimestamp("2026-10-19 23:55:00");
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(pay)).toBe("2026-10-20");
  });

  it("a Date written by a spec is stored as its UTC wall time", () => {
    expect(toPgParam(new Date("2026-10-19T23:55:00.000Z"))).toBe("2026-10-19T23:55:00.000Z");
    expect(toPgParam("x")).toBe("x");
    expect(toPgParam(3)).toBe(3);
    expect(toPgParam(null)).toBeNull();
  });
});
