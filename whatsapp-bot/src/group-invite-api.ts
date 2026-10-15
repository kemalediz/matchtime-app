/**
 * The Pi asks the server whether to join a group it was invited to
 * (2026-10-15): POST /api/whatsapp/group-invite. See baileys/group-invite.ts.
 *
 * Like picture-api.ts, kept out of api.ts so the one new call is readable
 * in one place, and refused in shadow mode (shadow.ts), where it is "no
 * answer": a shadow bot never joins a group. Total: any failure is null,
 * which the caller reads as "do not join". Never logs the body.
 */
import { config } from "./config.js";
import { refuseServerWriteInShadow } from "./shadow.js";

export const GROUP_INVITE_TIMEOUT_MS = 10_000;
const PATH = "/api/whatsapp/group-invite";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export async function postGroupInviteCheck(
  body: { phone?: string; senderLid?: string; senderAltPhone?: string; kind: "invite-message" | "invite-link" },
  fetchFn: Fetch = fetch,
): Promise<{ accept: boolean; reason?: string } | null> {
  const url = `${config.apiUrl}${PATH}`;
  const json = JSON.stringify(body);
  if (refuseServerWriteInShadow(url, json)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROUP_INVITE_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": config.apiKey },
      body: json,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const out = (await res.json()) as { accept?: unknown; reason?: unknown; match?: unknown };
    if (typeof out?.accept !== "boolean") return null;
    return out as { accept: boolean; reason?: string };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
