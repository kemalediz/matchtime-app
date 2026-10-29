/**
 * THE OWNER'S INTRO MESSAGES BY DM (2026-10-29).
 *
 * Kemal promotes MatchTime by pasting introduction messages into WhatsApp
 * groups. He DMs MatchTime in his own words ("send me the category 1 intro
 * message", "kategori 3 tanıtım mesajını gönder", "send me all the intro
 * messages") and gets each category back as two DMs, English then Turkish.
 *
 * How the ask is understood: the DM admin intent (`dm-intent.ts`), one model
 * call that already reads every DM from an admin, says `intro_messages` and
 * lists the categories named. Nothing here reads words.
 *
 * Who gets them: the platform owner only, the SELF_JOIN_APPROVER_PHONES
 * number(s), the same notion the self-join approval uses
 * (`isApproverSender`). The copy is in his voice. Anybody else asking is
 * handled exactly as before, and nothing says the feature exists.
 *
 * How they go: `queueOwnerDm`, the one door to the owner's phone, purpose
 * `owner-intro`, keyed on the DM it answers, so a re-forwarded DM is never
 * answered twice. It answers something he just asked, so it is not held
 * through quiet hours (as `owner-ack`).
 */
import { appBaseUrl, appUrl } from "./app-url";
import { isApproverSender } from "./club-decision-rules";
import { ownerIntroCopy } from "./i18n/owner-intro";
import { parseApproverPhones, queueOwnerDm, type OwnerDmResult } from "./owner-dm";

import type { IntroCategory } from "./owner-intro-rules";

export { INTRO_CATEGORIES, introCategoriesToSend, type IntroCategory } from "./owner-intro-rules";
export const OWNER_INTRO_PURPOSE = "owner-intro" as const;

const LANGS = ["en", "tr"] as const;

function messageFor(category: IntroCategory, lang: (typeof LANGS)[number]): string {
  const c = ownerIntroCopy(lang);
  if (category === 1) return c.footballGroups(appBaseUrl());
  if (category === 2) return c.poolInvite(appUrl("/play"));
  return c.newFeatures();
}

/** Each category's English message, then its Turkish one. */
export function buildOwnerIntroMessages(categories: readonly IntroCategory[]): string[] {
  return categories.flatMap((cat) => LANGS.map((lang) => messageFor(cat, lang)));
}

/** Is this DM from the platform owner? The self-join approver numbers. */
export function isPlatformOwnerSender(
  sender: { phone?: string | null; senderAltPhone?: string | null },
  approvers: readonly string[] = parseApproverPhones(process.env.SELF_JOIN_APPROVER_PHONES),
): boolean {
  return isApproverSender(sender, approvers);
}

/** Queue the bubbles to the owner, in order. */
export async function sendOwnerIntroMessages(args: {
  categories: readonly IntroCategory[];
  waMessageId: string;
  queue?: (text: string, purpose: typeof OWNER_INTRO_PURPOSE, refId: string) => Promise<OwnerDmResult>;
}): Promise<{ categories: IntroCategory[]; queued: number }> {
  const queue = args.queue ?? ((text, purpose, refId) => queueOwnerDm(text, purpose, refId));
  let queued = 0;
  for (const cat of args.categories) {
    for (const lang of LANGS) {
      const r = await queue(messageFor(cat, lang), OWNER_INTRO_PURPOSE, `intro:${args.waMessageId}:${cat}:${lang}`);
      queued += r.queued;
    }
  }
  return { categories: [...args.categories], queued };
}
