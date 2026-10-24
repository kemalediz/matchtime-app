"use server";

/**
 * "Play elsewhere" on a club member's own profile (local player pool, slice
 * L3). Every action is for the SIGNED-IN person (the session's user id;
 * nothing in the request names whose), through src/lib/pool/member-optin.ts.
 * The same validator as /play (`validatePoolSignup`: the fields, 18 or over
 * and the consent, both ticked).
 *
 * THE MATCHTIME NUMBER. Only `startPlayElsewhereWhatsApp` and the waiting
 * state of `loadPlayElsewhereAction` return it, inside the wa.me link, and
 * only to a signed-in member with no number on his account who asked to
 * confirm on WhatsApp: the same door as /play's sign-up answer, narrower.
 */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { matchtimeWaNumber } from "@/lib/club-connect";
import { waMeLink } from "@/lib/club-connect-rules";
import { normaliseLang } from "@/lib/i18n/lang";
import { poolConfirmPrefill } from "@/lib/pool/confirm-rules";
import { isPoolSignupPaused, poolOpenFrom } from "@/lib/pool/flags";
import { POOL_OPEN_TEST_COOKIE } from "@/lib/pool/flags-request";
import { joinPoolAsMember, loadPlayElsewhere, startMemberWhatsAppStep, type PlayElsewhereView } from "@/lib/pool/member-optin";
import { validatePoolSignup, type PoolFieldErrors } from "@/lib/pool/profile-fields";

const PROFILE_PATH = "/profile";

async function me(): Promise<string | null> {
  return (await auth())?.user?.id ?? null;
}

/** While the pool is not open, a new profile goes on the early sign-up list. */
async function earlyList(): Promise<boolean> {
  const override = process.env.MT_TEST_MODE === "1" ? (await cookies()).get(POOL_OPEN_TEST_COOKIE)?.value : undefined;
  return !poolOpenFrom(override);
}

export interface WhatsAppStep {
  code: string;
  prefill: string;
  waLink: string;
}

function whatsAppStep(code: string, lang: string): WhatsAppStep | null {
  const number = matchtimeWaNumber();
  if (!number) return null;
  const prefill = poolConfirmPrefill(normaliseLang(lang), code);
  return { code, prefill, waLink: waMeLink(number, prefill) };
}

export type PlayElsewhereState =
  | { ok: true; paused: boolean; view: PlayElsewhereView; whatsApp: WhatsAppStep | null }
  | { ok: false; reason: "signed-out" };

export async function loadPlayElsewhereAction(): Promise<PlayElsewhereState> {
  const userId = await me();
  if (!userId) return { ok: false, reason: "signed-out" };
  const view = await loadPlayElsewhere(userId, { earlyList: await earlyList() });
  if (!view) return { ok: false, reason: "signed-out" };
  const whatsApp = view.pendingCode ? whatsAppStep(view.pendingCode, view.prefill.language) : null;
  return { ok: true, paused: isPoolSignupPaused(), view, whatsApp };
}

type Refusal = { ok: false; reason: string; errors?: PoolFieldErrors };

/** A member with a number on his account: join, active at once. */
export async function joinPlayElsewhereAction(payload: unknown): Promise<{ ok: true } | Refusal> {
  const userId = await me();
  if (!userId) return { ok: false, reason: "signed-out" };
  if (isPoolSignupPaused()) return { ok: false, reason: "paused" };
  const valid = validatePoolSignup(payload);
  if (!valid.ok) return { ok: false, reason: "invalid", errors: valid.errors };
  const res = await joinPoolAsMember(userId, valid.value, { earlyList: await earlyList() });
  revalidatePath(PROFILE_PATH);
  return res;
}

/** A member with no number: the /play WhatsApp step, started by him. */
export async function startPlayElsewhereWhatsApp(payload: unknown): Promise<({ ok: true } & WhatsAppStep) | Refusal> {
  const userId = await me();
  if (!userId) return { ok: false, reason: "signed-out" };
  if (isPoolSignupPaused()) return { ok: false, reason: "paused" };
  const valid = validatePoolSignup(payload);
  if (!valid.ok) return { ok: false, reason: "invalid", errors: valid.errors };
  if (!matchtimeWaNumber()) return { ok: false, reason: "unavailable" };
  const res = await startMemberWhatsAppStep(userId, valid.value, { earlyList: await earlyList() });
  if (!res.ok) return res;
  const step = whatsAppStep(res.code, valid.value.language);
  return step ? { ok: true, ...step } : { ok: false, reason: "unavailable" };
}
