/**
 * THE FRIEND LINK'S SCENARIO HELPERS (2026-10-31). Built on the pool world
 * (`../pool/world.ts`): a club is a real players' group, a friend is a
 * stranger with a number, and every message goes through the real routes.
 * Model-free: the router and extractor are stubbed per message ($0).
 */
import type { PoolClub, PoolClubOpts, PoolWorld } from "../pool/world";
import type { SentMessage } from "../pool/transcript";
import type { AttStatus, SimPlayerSpec } from "../group";
import { claim, facts } from "../../helpers/stub";

export const ROSTER: SimPlayerSpec[] = [
  { key: "owner", name: "Oscar Owner", role: "OWNER" },
  { key: "alice", name: "Alice Admin", role: "ADMIN" },
  { key: "shane", name: "Shane Smith" },
  { key: "dan", name: "Dan Drummer" },
  { key: "pete", name: "Pete Power" },
  { key: "gary", name: "Gary Guest", hasPhone: false },
];

/** A club with the friend-link roster; `confirmed` start CONFIRMED. */
export async function friendClub(pool: PoolWorld, key: string, opts: PoolClubOpts & { confirmed?: string[] } = {}): Promise<PoolClub> {
  const { confirmed = ["owner", "dan"], ...rest } = opts;
  const club = await pool.club(key, {
    name: key.toUpperCase(),
    maxPlayers: 10,
    players: ROSTER,
    attendance: confirmed.map((k) => ({ key: k, status: "CONFIRMED" as AttStatus })),
    ...rest,
  });
  await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [club.group.orgId]);
  return club;
}

/** A named friend nobody knows: "my friend Ali is in". */
export const namedFriend = (ref: string) => facts([claim({ subject: "other", personRef: ref, personNamed: true, personKind: "named", polarity: "in" })]);
/** An unnamed friend: "+1", "my brother can play". */
export const unnamedFriend = (ref: string, kind: "placeholder" | "relation" = "placeholder") =>
  facts([claim({ subject: "other", personRef: ref, personNamed: false, personKind: kind, polarity: "in" })]);

/** A message in the players' group; what MatchTime reacted, replied and queued. */
export async function say(
  pool: PoolWorld,
  club: PoolClub,
  member: string,
  body: string,
  f: Record<string, unknown>,
  opts: { route?: string; waMessageId?: string; tag?: boolean } = {},
): Promise<{ react: string | null; reply: string | null; sent: SentMessage[] }> {
  pool.log({ kind: "in", from: `${club.key}.${member}`, channel: "group", text: body });
  const r = await club.group.postBatch([{ player: member, body, route: opts.route ?? "other_att", facts: f, tag: opts.tag, waMessageId: opts.waMessageId }]);
  const reply = r.results[0]?.reply?.trim() ? r.results[0].reply : null;
  const sent = await pool.collect(reply ? { channel: "group", to: `${club.key}.group`, text: reply, orgId: club.group.orgId } : undefined);
  return { react: r.results[0]?.react ?? null, reply, sent };
}

/** Every friend link (`/play/f/<token>`) in a text. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+?(\/play\/f\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

/** The token of a `/play/f/<token>` path. */
export const tokenOf = (path: string) => path.replace(/^\/play\/f\//, "");

export async function friendLinkRows(pool: PoolWorld, orgId: string) {
  return pool.db.all<{ id: string; friendName: string | null; issuedByUserId: string; usedAt: Date | null; outcome: string | null }>(
    `SELECT id, "friendName", "issuedByUserId", "usedAt", outcome FROM "FriendLink" WHERE "orgId" = $1 ORDER BY "createdAt" ASC, "claimIndex" ASC`,
    [orgId],
  );
}
