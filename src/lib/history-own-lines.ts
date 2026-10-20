/**
 * THE HISTORY LINE THAT IS A MESSAGE IN THIS BATCH SAYS WHAT THE MESSAGE
 * SAYS (FNF, 2026-10-20).
 *
 * The Pi records every inbound message into its history buffer as WhatsApp
 * delivered it (`whatsapp-bot/src/index.ts`, `recordHistory(... head.body)`),
 * and only afterwards rewrites the bot's own mention to "@Match Time" on the
 * copy it forwards for analysis (`rewriteMentions`). The server then
 * substitutes members' names for their mention tokens on that copy too
 * (`nameMentionsFromRoster`). So one message reaches the server in two
 * spellings: "@158055467598020 out" in the history and "@Match Time out" as
 * the message.
 *
 * Every extractor drops the sender's own line from RECENT CHAT by comparing
 * author AND body (`extractForRoute`, "THE MESSAGE IS NOT ITS OWN CONTEXT"),
 * because a message shown twice reads as an echo and its claim disappears
 * (the 2026-09-09 incident). Two spellings defeat that filter. Naim's
 * "@Match Time out" was shown his own "@158055467598020 out" as context and
 * came back `claims: []`: measured 6 of 63 claimless on the exact input,
 * 0 of 63 with the line removed.
 *
 * The fix matches on IDENTITY, not on words: a history line with the same
 * author and the same WhatsApp timestamp (to the second; both sides read
 * `messageTimestamp`) as exactly one message in the batch IS that message,
 * and takes that message's body. Nothing is removed here: a batch message
 * stays visible as context to the OTHER messages in the batch, and the
 * extractor's own filter then drops it for its sender. When two messages
 * from one sender share the second, nothing is changed: guessing which line
 * is which would be worse than the echo.
 */
export interface HistoryLine {
  authorName: string | null;
  body: string;
  timestamp: string;
}

function secondOf(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function alignHistoryWithBatch<H extends HistoryLine>(history: H[], messages: HistoryLine[]): H[] {
  return history.map((h) => {
    const at = secondOf(h.timestamp);
    if (at === null) return h;
    const same = messages.filter(
      (m) => (m.authorName ?? null) === (h.authorName ?? null) && secondOf(m.timestamp) === at,
    );
    if (same.length !== 1 || same[0].body === h.body) return h;
    return { ...h, body: same[0].body };
  });
}
