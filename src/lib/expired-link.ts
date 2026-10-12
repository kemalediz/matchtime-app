/**
 * AN EXPIRED SIGNED LINK IS NOT A DEAD END (2026-10).
 *
 * The setup DM's and the reminder's links live 7 days. An organiser who
 * opened one later saw "This link isn't valid any more" and a button to a
 * bare sign-in page that then took them to the home page, not to where
 * the link was going.
 *
 * Now the /r page sends them to /login with a notice ("That link has
 * expired. Sign in with your WhatsApp number to carry on.") and the page
 * the link was for as `callbackUrl`, which the sign-in follows only when
 * it is a path on this site (`safeCallbackPath`).
 *
 * WHAT THIS TELLS A STRANGER HOLDING AN OLD LINK: the page it pointed at
 * and the language to say so in. Never who it was for. It is read only
 * from a token whose SIGNATURE is good (`readExpiredMagicLink`), so a made
 * up token says nothing; and it signs nobody in.
 */
import { db } from "./db";
import { normaliseLang, type Lang } from "./i18n/lang";
import { readExpiredMagicLink, type MagicLinkPayload } from "./magic-link";
import { safeCallbackPath } from "./safe-callback";

export interface ExpiredLinkInfo {
  /** The page the link was for, when it is a path on this site. */
  nextPath: string | null;
  lang: Lang;
}

/** Where the link was going: the same choice the /r page makes on a good link. */
export function expiredLinkDestination(payload: Pick<MagicLinkPayload, "purpose" | "matchId" | "nextPath">): string | null {
  if (payload.purpose === "rate-match" && payload.matchId) return safeCallbackPath(`/matches/${payload.matchId}/rate`);
  return safeCallbackPath(payload.nextPath);
}

/**
 * `codeOrToken` is what follows /r/: a short code, or a long token (it
 * holds a "."). Null unless it is a real link of ours that has expired.
 */
export async function expiredLinkInfo(codeOrToken: string): Promise<ExpiredLinkInfo | null> {
  try {
    if (!codeOrToken) return null;
    let token = codeOrToken;
    if (!codeOrToken.includes(".")) {
      const row = await db.shortLink.findUnique({ where: { code: codeOrToken }, select: { token: true } });
      if (!row) return null;
      token = row.token;
    }
    const payload = readExpiredMagicLink(token);
    if (!payload) return null;

    // The notice's language: the club the link opens, else the person's
    // oldest club (the one the admin pages fall back to), else English.
    let language: string | null = null;
    if (payload.orgId) {
      language = (await db.organisation.findUnique({ where: { id: payload.orgId }, select: { language: true } }))?.language ?? null;
    }
    if (!language) {
      const membership = await db.membership.findFirst({
        where: { userId: payload.userId, leftAt: null },
        orderBy: { createdAt: "asc" },
        select: { org: { select: { language: true } } },
      });
      language = membership?.org.language ?? null;
    }
    return { nextPath: expiredLinkDestination(payload), lang: normaliseLang(language) };
  } catch {
    return null;
  }
}

/** The sign-in page for somebody whose link expired. */
export function expiredLoginPath(info: ExpiredLinkInfo): string {
  const q = new URLSearchParams({ expired: "1" });
  if (info.lang !== "en") q.set("lang", info.lang);
  if (info.nextPath) q.set("callbackUrl", info.nextPath);
  return `/login?${q.toString()}`;
}
