/**
 * THE DATABASE HALF OF THE SETTINGS-AWARE GROUP HELLO (2026-10-12, go-live
 * slice S2). One read of the club's settings and one of the organiser's
 * name, so the caller only does:
 *
 *   buildGroupHello(await loadHelloInput(orgId))
 *
 * The settings are read at the moment of the call, so a hello built at
 * go-live says what the club is set to then, not at approval.
 *
 * The organiser is the person who connected the club: the user on its
 * most recently linked `ClubConnect` (the same person `decideClub` names
 * in today's hello), else the club's OWNER. Pass `organiserUserId` when
 * the caller already knows who it is. No name is not an error: the hello
 * has a wording for it.
 *
 * `client` may be a transaction, so the hello can be built from the same
 * snapshot the caller writes in.
 */
import { db } from "@/lib/db";
import { HELLO_ORG_SELECT, helloInputFromOrg, type GroupHelloInput, type HelloOrgRow } from "./group-hello";

/** The part of the Prisma client (or of a transaction) this reads through. */
export interface HelloReadClient {
  organisation: { findUnique(args: { where: { id: string }; select: typeof HELLO_ORG_SELECT }): Promise<HelloOrgRow | null> };
  clubConnect: {
    findFirst(args: {
      where: { orgId: string; linkedAt: { not: null } };
      orderBy: { linkedAt: "desc" };
      select: { userId: true };
    }): Promise<{ userId: string } | null>;
  };
  membership: {
    findFirst(args: {
      where: { orgId: string; role: "OWNER"; leftAt: null };
      orderBy: { id: "asc" };
      select: { userId: true };
    }): Promise<{ userId: string } | null>;
  };
  user: { findUnique(args: { where: { id: string }; select: { name: true } }): Promise<{ name: string | null } | null> };
}

export async function loadHelloInput(
  orgId: string,
  opts: { organiserUserId?: string | null; client?: HelloReadClient } = {},
): Promise<GroupHelloInput> {
  const client = opts.client ?? (db as unknown as HelloReadClient);
  const row = await client.organisation.findUnique({ where: { id: orgId }, select: HELLO_ORG_SELECT });
  if (!row) throw new Error(`loadHelloInput: organisation ${orgId} not found`);

  let userId = opts.organiserUserId ?? null;
  if (!userId) {
    const link = await client.clubConnect.findFirst({
      where: { orgId, linkedAt: { not: null } },
      orderBy: { linkedAt: "desc" },
      select: { userId: true },
    });
    userId = link?.userId ?? null;
  }
  if (!userId) {
    const owner = await client.membership.findFirst({
      where: { orgId, role: "OWNER", leftAt: null },
      orderBy: { id: "asc" },
      select: { userId: true },
    });
    userId = owner?.userId ?? null;
  }
  const user = userId ? await client.user.findUnique({ where: { id: userId }, select: { name: true } }) : null;
  return helloInputFromOrg(row, user?.name ?? null);
}
