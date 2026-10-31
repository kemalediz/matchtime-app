/**
 * THE /play REMINDER'S MEMORY (2026-10-31). CLIENT-SAFE.
 *
 * Two in ten sign-ups never sent the WhatsApp code, and we have no number to
 * remind them. So the browser that signed up remembers just enough to put
 * the reminder on /play when he comes back: the code, the wa.me link that
 * sends it, the status token (`signup-status-token.ts`) and when the code
 * runs out. Nothing about him: no name, area or days.
 *
 * localStorage (it must outlive the tab), every read and write wrapped: a
 * blocked store just means no reminder. What comes back is read
 * defensively. The page asks the server (`checkPendingSignup`) before it
 * shows anything, so a confirmed sign-up is never reminded, and forgets
 * the entry once the server says "done" or "gone", or the code has run out.
 */
import { POOL_CONFIRM_CODE_ALPHABET, POOL_CONFIRM_CODE_LENGTH } from "./rules";

export const PENDING_SIGNUP_KEY = "mt.pool.pendingSignup.v1";
export const PENDING_SIGNUP_STATUS_PATH = "/api/play/signup/status";

export interface PendingSignup {
  code: string;
  waLink: string;
  token: string;
  /** When the code runs out, ms since the epoch. */
  expiresAt: number;
}

export type PendingSignupCheck = "waiting" | "done" | "gone" | "unknown";

const WA_PREFIX = "https://wa.me/";

export function encodePendingSignup(p: PendingSignup): string {
  return JSON.stringify({ v: 1, code: p.code, waLink: p.waLink, token: p.token, expiresAt: p.expiresAt });
}

const isCode = (x: unknown): x is string =>
  typeof x === "string" && x.length === POOL_CONFIRM_CODE_LENGTH && [...x].every((c) => POOL_CONFIRM_CODE_ALPHABET.includes(c));

export function decodePendingSignup(raw: string | null): PendingSignup | null {
  if (!raw) return null;
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (o.v !== 1 || !isCode(o.code)) return null;
  if (typeof o.waLink !== "string" || !o.waLink.startsWith(WA_PREFIX) || o.waLink.length > 2000) return null;
  if (typeof o.token !== "string" || !o.token || o.token.length > 200) return null;
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) return null;
  return { code: o.code, waLink: o.waLink, token: o.token, expiresAt: o.expiresAt };
}

export function pendingSignupExpired(p: PendingSignup, nowMs: number): boolean {
  return nowMs >= p.expiresAt;
}

// ── The browser's store (never required to work) ───────────────────────

export function loadPendingSignup(): PendingSignup | null {
  try {
    return decodePendingSignup(window.localStorage.getItem(PENDING_SIGNUP_KEY));
  } catch {
    return null;
  }
}

export function savePendingSignup(p: PendingSignup): void {
  try {
    window.localStorage.setItem(PENDING_SIGNUP_KEY, encodePendingSignup(p));
  } catch {
    // Blocked or full: he just gets no reminder.
  }
}

export function clearPendingSignup(): void {
  try {
    window.localStorage.removeItem(PENDING_SIGNUP_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Does the server say this sign-up still waits? "unknown" when it could not
 *  say (busy, offline): the page then shows nothing and keeps the entry. */
export async function checkPendingSignup(p: PendingSignup, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<PendingSignupCheck> {
  try {
    const res = await fetchImpl(PENDING_SIGNUP_STATUS_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: p.token, code: p.code }),
    });
    if (!res.ok) return "unknown";
    const data = (await res.json().catch(() => null)) as { state?: unknown } | null;
    const s = data?.state;
    return s === "waiting" || s === "done" || s === "gone" ? s : "unknown";
  } catch {
    return "unknown";
  }
}
