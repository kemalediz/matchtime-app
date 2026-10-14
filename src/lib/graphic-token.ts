/**
 * THE SIGNED, SHORT-LIVED TOKEN IN A GRAPHIC'S URL (2026-10-14).
 *
 * `/api/graphics/<token>` renders the list poster or the team sheet for
 * one match. The Pi fetches it with nothing but the URL (the same way it
 * would open any link), so the token is the route's whole access control:
 *
 *   - it names ONE org, ONE match and ONE kind; the route renders exactly
 *     that and checks the match belongs to the org;
 *   - it expires: 15 minutes for the Pi (`GROUP_GRAPHIC_TTL_SECONDS`), a
 *     day at most (`GRAPHIC_TOKEN_MAX_TTL_SECONDS`, the owner-DM fallback),
 *     clamped at mint time and checked again at verify time;
 *   - it is HMAC-SHA256 under AUTH_SECRET, like magic links, but over a
 *     domain-separated input ("matchtime-graphic-v1." + payload), so a
 *     graphic token can never be replayed as a sign-in link or the other
 *     way round.
 *
 * Same compact shape as `magic-link.ts`: base64url(payload).base64url(sig).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { GraphicKind } from "./match-graphics-copy";

export const GROUP_GRAPHIC_TTL_SECONDS = 15 * 60;
export const DM_GRAPHIC_TTL_SECONDS = 24 * 60 * 60;
export const GRAPHIC_TOKEN_MAX_TTL_SECONDS = DM_GRAPHIC_TTL_SECONDS;

const DOMAIN = "matchtime-graphic-v1.";
const KINDS: readonly GraphicKind[] = ["list", "teams"];

export interface GraphicTarget {
  orgId: string;
  matchId: string;
  kind: GraphicKind;
}

interface Payload {
  o: string;
  m: string;
  k: string;
  iat: number;
  exp: number;
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET not set: graphic links disabled");
  return s.trim();
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(`${DOMAIN}${body}`).digest("base64url");
}

export function signGraphicToken(args: GraphicTarget & { ttlSeconds: number; now?: Date }): string {
  const iat = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const ttl = Math.max(1, Math.min(args.ttlSeconds, GRAPHIC_TOKEN_MAX_TTL_SECONDS));
  const payload: Payload = { o: args.orgId, m: args.matchId, k: args.kind, iat, exp: iat + ttl };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** The target, or null for anything forged, expired, malformed or unknown. Never throws. */
export function verifyGraphicToken(token: string, now: Date = new Date()): GraphicTarget | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    if (!body || !sig) return null;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(body));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Payload>;
    if (typeof p.o !== "string" || !p.o || typeof p.m !== "string" || !p.m) return null;
    if (!KINDS.includes(p.k as GraphicKind)) return null;
    if (typeof p.exp !== "number" || typeof p.iat !== "number" || !isFinite(p.exp) || !isFinite(p.iat)) return null;
    if (p.exp - p.iat > GRAPHIC_TOKEN_MAX_TTL_SECONDS) return null;
    if (p.exp * 1000 < now.getTime()) return null;
    return { orgId: p.o, matchId: p.m, kind: p.k as GraphicKind };
  } catch {
    return null;
  }
}
