/**
 * A WhatsApp message for a web page: its lines, with WhatsApp bold (`*x*`)
 * marked as bold runs. Pure and client-safe. Everything else (emoji,
 * spacing, links as text) is left exactly as written.
 *
 * WhatsApp's own rule, kept here: a bold run starts and ends on a
 * non-space character and stays on one line, so "5 * 2" and "4* today"
 * keep their stars.
 */
export interface WhatsAppRun {
  text: string;
  bold: boolean;
}

const BOLD = /\*([^\s*](?:[^*\n]*[^\s*])?)\*/g;

export function whatsappLines(message: string): WhatsAppRun[][] {
  return message.split(/\r?\n/).map((line) => {
    const runs: WhatsAppRun[] = [];
    let at = 0;
    for (const m of line.matchAll(BOLD)) {
      const start = m.index ?? 0;
      if (start > at) runs.push({ text: line.slice(at, start), bold: false });
      runs.push({ text: m[1], bold: true });
      at = start + m[0].length;
    }
    if (at < line.length) runs.push({ text: line.slice(at), bold: false });
    return runs;
  });
}
