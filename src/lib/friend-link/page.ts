/**
 * A FRIEND LINK, OPENED (2026-10-31). Thin I/O: the link row, its match's
 * facts (`facts.ts`), who sent it, and whether it is still usable
 * (`friendLinkState`). Read by the /play/f/<token> page and by the sign-up
 * route, so both decide on the same answer. Opening the page changes
 * nothing (WhatsApp fetches links to draw a preview).
 */
import { db } from "../db";
import { loadFriendMatchFacts, type FriendMatchFacts } from "./facts";
import { friendLinkState, type FriendLinkState } from "./rules";
import { friendLinkIdFromToken } from "./token";

export interface OpenedFriendLink {
  id: string;
  state: FriendLinkState;
  issuedByUserId: string;
  /** The member's first name, for "Shane invited you to play". */
  issuer: string;
  friendName: string | null;
  facts: FriendMatchFacts;
}

export async function openFriendLink(token: string, now: Date = new Date()): Promise<OpenedFriendLink | null> {
  const id = friendLinkIdFromToken(token);
  if (!id) return null;
  const link = await db.friendLink.findUnique({ where: { id }, select: { id: true, matchId: true, issuedByUserId: true, friendName: true, usedAt: true } });
  if (!link) return null;
  const [facts, issuer] = await Promise.all([
    loadFriendMatchFacts(link.matchId),
    db.user.findUnique({ where: { id: link.issuedByUserId }, select: { name: true } }),
  ]);
  if (!facts) return null;
  return {
    id: link.id,
    state: friendLinkState({ used: !!link.usedAt, matchStatus: facts.status, isHistorical: facts.isHistorical, kickoff: facts.kickoff, now }),
    issuedByUserId: link.issuedByUserId,
    issuer: (issuer?.name ?? "").trim().split(/\s+/)[0] ?? "",
    friendName: link.friendName,
    facts,
  };
}
