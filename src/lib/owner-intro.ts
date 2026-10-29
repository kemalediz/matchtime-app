/**
 * THE OWNER'S INTRO MESSAGES BY DM (2026-10-29).
 *
 * Kemal promotes MatchTime by pasting introduction messages into WhatsApp
 * groups. He DMs MatchTime in his own words ("send me the category 1 intro
 * message", "kategori 3 tanıtım mesajını gönder", "send me all the intro
 * messages") and gets each category back as English then Turkish DMs: one
 * bubble per language, two for category 3 (EN 1, EN 2, TR 1, TR 2).
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

interface IntroBubble {
  text: string;
  /** Unique per bubble within one DM answered: `<cat>:<lang>`, plus `:<part>` for category 3. */
  key: string;
}

function bubblesFor(category: IntroCategory, lang: (typeof LANGS)[number]): IntroBubble[] {
  const c = ownerIntroCopy(lang);
  if (category === 1) return [{ text: c.footballGroups(appBaseUrl()), key: `1:${lang}` }];
  if (category === 2) return [{ text: c.poolInvite(appUrl("/play")), key: `2:${lang}` }];
  return c.newFeatures(appUrl("/play")).map((text, i) => ({ text, key: `3:${lang}:${i + 1}` }));
}

/** Every bubble in send order: per category, the English one(s), then the Turkish. */
function introBubbles(categories: readonly IntroCategory[]): IntroBubble[] {
  return categories.flatMap((cat) => LANGS.flatMap((lang) => bubblesFor(cat, lang)));
}

/** Each category's English message(s), then its Turkish one(s). */
export function buildOwnerIntroMessages(categories: readonly IntroCategory[]): string[] {
  return introBubbles(categories).map((b) => b.text);
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
  for (const b of introBubbles(args.categories)) {
    const r = await queue(b.text, OWNER_INTRO_PURPOSE, `intro:${args.waMessageId}:${b.key}`);
    queued += r.queued;
  }
  return { categories: [...args.categories], queued };
}
