/**
 * The owner's WhatsApp templates page, the parts that only show things: the
 * dry run's difference, the status rows Meta's webhooks wrote
 * (`CloudTemplateStatus`), and what "Submit to Meta" did per template. No
 * hooks, so the server page and the client controls both render them.
 * English only, as the rest of the owner's pages.
 */
import type { TemplateDiff } from "@/lib/cloud-api/template-sync";
import type { TemplateSubmit } from "@/lib/cloud-api/template-sync-admin";
import { formatLondon } from "@/lib/london-time";

const KIND: Record<TemplateDiff["kind"], string> = {
  new: "New",
  changed: "Changed",
  same: "Same",
  "not-ours": "Not ours",
};

const KIND_STYLE: Record<TemplateDiff["kind"], string> = {
  new: "bg-blue-50 text-blue-800",
  changed: "bg-amber-50 text-amber-800",
  same: "bg-slate-100 text-slate-700",
  "not-ours": "bg-purple-50 text-purple-800",
};

const TH = "px-3 py-2 text-left font-medium text-slate-600";
const TD = "px-3 py-2 align-top text-slate-800";

/** New first, then changed, not ours and same, as the script prints them. */
const ORDER: TemplateDiff["kind"][] = ["new", "changed", "not-ours", "same"];

export function TemplateDiffTable({ diffs }: { diffs: TemplateDiff[] }) {
  if (diffs.length === 0) return <p className="text-sm text-slate-600">No templates in the code or at Meta.</p>;
  const sorted = [...diffs].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className={TH}>Template</th>
            <th className={TH}>Language</th>
            <th className={TH}>Difference</th>
            <th className={TH}>Meta status</th>
            <th className={TH}>Meta category</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {sorted.map((d) => (
            <tr key={`${d.name}|${d.language}`} data-testid="wt-diff" data-kind={d.kind}>
              <td className={`${TD} font-mono`}>{d.name}</td>
              <td className={TD}>{d.language}</td>
              <td className={TD}>
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${KIND_STYLE[d.kind]}`}>
                  {d.kind === "changed" && d.changes?.length ? `${KIND.changed}: ${d.changes.join(", ")}` : KIND[d.kind]}
                </span>
              </td>
              <td className={TD}>{d.metaStatus ?? "Not at Meta"}</td>
              <td className={TD}>{d.metaCategory ? `${d.metaCategory} (not the one in the code)` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface TemplateStatusRow {
  name: string;
  language: string;
  status: string;
  category: string | null;
  previousCategory: string | null;
  qualityScore: string | null;
  reason: string | null;
  updatedAt: Date;
}

export function TemplateStatusTable({ rows }: { rows: TemplateStatusRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-slate-600">No status from Meta yet. Rows appear here as Meta reviews each template.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className={TH}>Template</th>
            <th className={TH}>Language</th>
            <th className={TH}>Status</th>
            <th className={TH}>Category</th>
            <th className={TH}>Quality</th>
            <th className={TH}>Reason</th>
            <th className={TH}>Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={`${r.name}|${r.language}`} data-testid="wt-status">
              <td className={`${TD} font-mono`}>{r.name}</td>
              <td className={TD}>{r.language}</td>
              <td className={TD}>{r.status}</td>
              <td className={TD}>{r.category ? (r.previousCategory ? `${r.category} (was ${r.previousCategory})` : r.category) : ""}</td>
              <td className={TD}>{r.qualityScore ?? ""}</td>
              <td className={`${TD} break-words`}>{r.reason ?? ""}</td>
              <td className={`${TD} whitespace-nowrap`}>{formatLondon(r.updatedAt, "d MMM yyyy, HH:mm")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const NOT_CONFIGURED = "WA_CLOUD_WABA_ID or WA_CLOUD_ACCESS_TOKEN is not set on the server, so Meta cannot be asked.";

export type SubmitOutcome = TemplateSubmit | { state: "forbidden" };

/** What "Submit to Meta" did, one line per template. */
export function SyncResultList({ result }: { result: SubmitOutcome }) {
  if (result.state === "forbidden") return <p className="text-sm text-red-700">Only the platform owner can submit templates.</p>;
  if (result.state === "not-configured") return <p className="text-sm text-red-700">{NOT_CONFIGURED}</p>;
  if (result.state === "error") return <p className="text-sm text-red-700">Meta could not be reached: {result.message}</p>;
  const lines = [
    ...result.applied.map((a) => ({ ...a, tone: "text-green-800", what: a.action === "created" ? "Created" : "Edited" })),
    ...result.skipped.map((s) => ({ ...s, tone: "text-amber-800", what: `Skipped, ${s.why}` })),
    ...result.failed.map((f) => ({ ...f, tone: "text-red-700", what: `Failed, ${f.why}` })),
  ];
  if (lines.length === 0) return <p className="text-sm text-slate-700">Nothing to submit: every template matches what Meta holds.</p>;
  return (
    <ul className="space-y-1 text-sm" aria-label="What was submitted">
      {lines.map((l) => (
        <li key={`${l.name}|${l.language}`} data-testid="wt-result" className={l.tone}>
          <span className="font-mono">{l.name}</span> {l.language}: {l.what}
        </li>
      ))}
    </ul>
  );
}
