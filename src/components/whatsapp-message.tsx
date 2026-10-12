/**
 * A WhatsApp message shown on a web page as the group will see it: line
 * breaks kept, WhatsApp bold (`*x*`) as bold, emoji untouched. No hooks,
 * so it renders in server and client components alike.
 *
 * Long words and links wrap inside the box, so it never makes a phone
 * scroll sideways.
 */
import { whatsappLines } from "@/lib/whatsapp-text";

export function WhatsAppMessage(props: {
  text: string;
  /** The message's language, when it differs from the page's. */
  lang?: string | null;
  testId?: string;
  labelledBy?: string;
}) {
  return (
    <div
      data-testid={props.testId}
      lang={props.lang ?? undefined}
      role="group"
      aria-labelledby={props.labelledBy}
      className="min-w-0 max-w-full rounded-lg border border-emerald-200 bg-white px-3 py-2.5 text-sm leading-relaxed text-slate-800 shadow-sm [overflow-wrap:anywhere]"
    >
      {whatsappLines(props.text).map((runs, i) => (
        <p key={i} className="min-h-[1.625em] whitespace-pre-wrap">
          {runs.map((run, j) => (run.bold ? <strong key={j}>{run.text}</strong> : <span key={j}>{run.text}</span>))}
        </p>
      ))}
    </div>
  );
}
