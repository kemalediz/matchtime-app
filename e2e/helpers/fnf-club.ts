/**
 * FNF'S CLUB, AS THE HQ SCENARIOS SEED IT (moved here 2026-11-27 from
 * `sim/hq-exact-full-name.spec.ts`, so the posted-teams scenario uses the
 * same roster). FNF's members in membership order (prod, read-only,
 * 24 Nov), with the club's aliases ("AH" for Abdul-Hafeez), and namesakes
 * that matter: "Hamza" and "Hamzah", "Umar" and "Umar Noor". The fixture
 * admin's phone plays Imz, an organiser; the collector plays Hamzah.
 */
import { MATCH, ORG_ID, U } from "./constants";
import type { TestDb } from "./test-db";

export const FNF_HQ = "120363777000000092@g.us";

export type FnfMember = { name: string; role?: "OWNER" | "ADMIN"; aliases?: string[] };

export const FNF_MEMBERS: FnfMember[] = [
  { name: "Hamzah", role: "OWNER" },
  { name: "Raihan", role: "ADMIN" },
  { name: "Imz", role: "ADMIN" },
  ...["Rafi"].map((name) => ({ name })),
  { name: "Abdul-Hafeez", aliases: ["ah"] },
  ...["AK", "Nasir", "Wasim", "Mo", "Akram", "Bilal", "Hamza", "Kieran", "Maj", "Mojib", "Seb", "Yorel", "Feroz", "Mahir", "Ali", "Alamgir", "Habib", "Yaseen"].map((name) => ({ name })),
  { name: "Najib", aliases: ["uncle najib", "uncle"] },
  ...["Uways", "Umar", "Leo"].map((name) => ({ name })),
  { name: "Imti", aliases: ["imtiaz"] },
  ...["Monts", "Hanad", "Imran", "Omar Laher", "Naim", "Anfal", "Omar", "Andrew", "Maahi", "Shehryar", "Niro", "Irfan", "Mez", "Yusuf", "Youcef", "Morgan", "Bilz", "Kieran R"].map((name) => ({ name })),
  { name: "Kemal", role: "ADMIN" },
  ...["Shaq", "Juned", "Qash", "Clarence", "Biggz", "Lil Mo", "Umar Noor"].map((name) => ({ name })),
];

/** The sender, an organiser, plays the part of Imz (the fixture admin's phone). */
export const fnfIdOf = (name: string): string =>
  name === "Imz" ? U.admin : name === "Hamzah" ? U.collector : `e2e-fnf-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/**
 * FNF's club on the fixture org: HQ linked, the roster and its aliases,
 * an 18-place upcoming game with `playing` CONFIRMED and `bench` on the
 * bench, and no teams.
 */
export async function seedFnfClub(db: TestDb, opts: { members?: FnfMember[]; playing: string[]; bench: string[] }): Promise<void> {
  const members = opts.members ?? FNF_MEMBERS;
  await db.run(
    `UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group', "benchPickMode" = 'organiser', language = 'en' WHERE id = $1`,
    [ORG_ID, FNF_HQ],
  );
  await db.run(`DELETE FROM "UserAlias" WHERE "orgId" = $1`, [ORG_ID]);
  await db.run(`DELETE FROM "Membership" WHERE "orgId" = $1`, [ORG_ID]);
  const base = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const [i, m] of members.entries()) {
    const id = fnfIdOf(m.name);
    if (id === U.admin || id === U.collector) {
      await db.run(`UPDATE "User" SET name = $2 WHERE id = $1`, [id, m.name]);
    } else {
      await db.run(`INSERT INTO "User" (id, name, email, "updatedAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO UPDATE SET name = $2`, [
        id,
        m.name,
        `${id}@e2e.test`,
      ]);
    }
    await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role, "createdAt") VALUES ($1, $2, $3, $4, $5)`, [
      `e2e-fnf-mem-${i}`,
      id,
      ORG_ID,
      m.role ?? "PLAYER",
      new Date(base + i * 60_000),
    ]);
    for (const alias of m.aliases ?? []) {
      await db.run(`INSERT INTO "UserAlias" (id, "orgId", "userId", alias, source) VALUES ($1, $2, $3, $4, 'manual')`, [
        `e2e-fnf-al-${i}-${alias.replace(/\s+/g, "-")}`,
        ORG_ID,
        id,
        alias,
      ]);
    }
  }
  await db.run(`UPDATE "Match" SET "maxPlayers" = 18 WHERE id = $1`, [MATCH.upcoming]);
  await db.run(`DELETE FROM "TeamAssignment" WHERE "matchId" = $1`, [MATCH.upcoming]);
  await db.run(`DELETE FROM "Attendance" WHERE "matchId" = $1`, [MATCH.upcoming]);
  const listedAt = Date.now() - 24 * 60 * 60 * 1000;
  const rows: Array<[string, "CONFIRMED" | "BENCH"]> = [
    ...opts.playing.map((n) => [n, "CONFIRMED"] as [string, "CONFIRMED"]),
    ...opts.bench.map((n) => [n, "BENCH"] as [string, "BENCH"]),
  ];
  for (const [i, [name, status]] of rows.entries()) {
    await db.run(`INSERT INTO "Attendance" (id, "matchId", "userId", status, position, "updatedAt") VALUES ($1, $2, $3, $4::"AttendanceStatus", $5, now())`, [
      `e2e-fnf-att-${i}`,
      MATCH.upcoming,
      fnfIdOf(name),
      status,
      i + 1,
    ]);
    await db.run(
      `INSERT INTO "AttendanceEvent" (id, "matchId", "userId", "orgId", "toStatus", "toPosition", cause, "actorKind", "sourceRef", at)
       VALUES ($1, $2, $3, $4, $5::"AttendanceStatus", $6, 'test-fixture', 'system', 'e2e:seed', $7)`,
      [`e2e-fnf-ev-${i}`, MATCH.upcoming, fnfIdOf(name), ORG_ID, status, i + 1, new Date(listedAt + i * 60_000)],
    );
  }
}
