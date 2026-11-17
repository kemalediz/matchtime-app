/**
 * A CONTACT CARD IS TAKEN ASIDE AT THE DOOR (review of #621, 2026-11-17).
 * Pure.
 *
 * A shared card carries a person's name and phone number. Before anything
 * else on a door reads a message (sender resolution, reply contexts, the
 * mention reader, the router, the extractors, the stored rows, the chat
 * history the models are shown), its card text is taken aside for the
 * guest card door alone, and the message, and any message quoting a card,
 * carries `CONTACT_CARD_LABEL` instead. Only `door.ts` ever sees the
 * card, and only to hold it for an organiser's request.
 */
import { CONTACT_CARD_LABEL, isContactCard } from "./vcard";

/** The raw card text of one message: its own body, and what it quotes. */
export interface RawCards {
  body?: string;
  quoted?: string;
}

/**
 * The players' group's batch: every card body and every quoted card
 * replaced by the label; the raw text by message id, for the door.
 */
export function takeCardsAside<M extends { waMessageId: string; body: string; quotedBody?: string | null }>(
  messages: M[],
): { messages: M[]; raw: Map<string, RawCards> } {
  const raw = new Map<string, RawCards>();
  const out = messages.map((m) => {
    const cardBody = isContactCard(m.body);
    const cardQuote = isContactCard(m.quotedBody);
    if (!cardBody && !cardQuote) return m;
    raw.set(m.waMessageId, { ...(cardBody ? { body: m.body } : {}), ...(cardQuote ? { quoted: m.quotedBody as string } : {}) });
    return { ...m, ...(cardBody ? { body: CONTACT_CARD_LABEL } : {}), ...(cardQuote ? { quotedBody: CONTACT_CARD_LABEL } : {}) };
  });
  return { messages: out, raw };
}

/** History lines (the Pi's buffer) with every card replaced by the label. */
export function cardSafeLines<T extends { body: string }>(lines: T[]): T[] {
  return lines.map((l) => (isContactCard(l.body) ? { ...l, body: CONTACT_CARD_LABEL } : l));
}
