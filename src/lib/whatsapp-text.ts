/**
 * A WhatsApp message for a web page: its lines, with WhatsApp bold (`*x*`)
 * marked as bold runs. Pure and client-safe. Everything else (emoji,
 * spacing, links as text) is left exactly as written.
 *
 * THE RULE (review of PR #236, fix 8), as close to WhatsApp's as could be
 * established without a device to check against:
 *   - a run stays on one line, and its text starts and ends on a
 *     non-space character ("5 * 2" keeps its stars);
 *   - the OPENING star starts a word: it is at the start of the line or
 *     follows something that is not a letter, a digit or an underscore;
 *   - the CLOSING star ends a word: it is at the end of the line or is
 *     followed by something that is not a letter, a digit or an
 *     underscore. So "2*3*4" and "a*b*c" are not bold, while "(*In*),"
 *     and "*Out*." are;
 *   - nothing inside a link is bold: a token that holds "://" or starts
 *     with "www." is left exactly as typed.
 * Letters and digits are Unicode ones, so Turkish words count as words.
 */
export interface WhatsAppRun {
  text: string;
  bold: boolean;
}

const BOLD = /(?<![\p{L}\p{N}_*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\p{L}\p{N}_*])/gu;
const LINK = /^(?:\S*:\/\/|www\.)\S*$/i;

function push(runs: WhatsAppRun[], text: string, bold: boolean): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.bold === bold && !bold) last.text += text;
  else runs.push({ text, bold });
}

function boldRuns(text: string, runs: WhatsAppRun[]): void {
  let at = 0;
  for (const m of text.matchAll(BOLD)) {
    const start = m.index ?? 0;
    push(runs, text.slice(at, start), false);
    push(runs, m[1], true);
    at = start + m[0].length;
  }
  push(runs, text.slice(at), false);
}

export function whatsappLines(message: string): WhatsAppRun[][] {
  return message.split(/\r?\n/).map((line) => {
    const runs: WhatsAppRun[] = [];
    // Links are set aside whole; the text between them is read for bold.
    let pending = "";
    for (const part of line.split(/(\s+)/)) {
      if (LINK.test(part)) {
        boldRuns(pending, runs);
        pending = "";
        push(runs, part, false);
      } else {
        pending += part;
      }
    }
    boldRuns(pending, runs);
    return runs;
  });
}
