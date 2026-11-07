import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isSuperadmin } from "@/lib/org";
import { checkCloudTemplates } from "@/lib/cloud-api/template-sync-admin";
import { NOT_CONFIGURED, TemplateDiffTable, TemplateStatusTable } from "./template-sync-view";
import { SubmitTemplatesControls } from "./submit-controls";

/**
 * /admin/whatsapp-templates: the official number's message templates, the
 * code (`src/lib/cloud-api/templates.ts`) against what Meta holds (Cloud
 * API plan 5.6). `scripts/cloud-templates.ts` needs `WA_CLOUD_ACCESS_TOKEN`,
 * a Vercel secret that cannot be pulled locally, so the same engine runs
 * here on the server:
 *   - every load is a dry run: Meta's list is read (GET only) and the
 *     difference shown, new, changed, same and not ours, with Meta's status
 *     and category;
 *   - the status rows Meta's template webhooks wrote (`CloudTemplateStatus`);
 *   - "Submit to Meta", behind a confirmation on the page, submits the new
 *     and edits the changed, and shows what happened per template.
 * The token never leaves the server. Reading Meta's list and submitting a
 * template are free; only sends are charged.
 *
 * OWNER ONLY: 404 to anybody who is not `User.isSuperadmin`, as
 * /admin/health and /admin/pool/safety; the action checks again
 * (`app/actions/cloud-templates.ts`). English only (owner copy).
 */
export const dynamic = "force-dynamic";

export default async function WhatsAppTemplatesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isSuperadmin(session.user.id))) notFound();

  const [check, rows] = await Promise.all([
    checkCloudTemplates(),
    db.cloudTemplateStatus.findMany({
      orderBy: [{ name: "asc" }, { language: "asc" }],
      select: { name: true, language: true, status: true, category: true, previousCategory: true, qualityScore: true, reason: true, updatedAt: true },
    }),
  ]);
  const newCount = check.state === "ok" ? check.diffs.filter((d) => d.kind === "new").length : 0;
  const changedCount = check.state === "ok" ? check.diffs.filter((d) => d.kind === "changed").length : 0;

  return (
    <div className="space-y-10" data-testid="whatsapp-templates-page">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">WhatsApp templates</h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          The official number&apos;s message templates: what the code says against what Meta holds. Opening this page only reads Meta&apos;s list. Nothing
          is sent until you press Submit to Meta and confirm.
        </p>
      </div>

      <section aria-labelledby="wt-diff-title" className="space-y-3">
        <h3 id="wt-diff-title" className="text-lg font-semibold text-slate-900">
          Code against Meta
        </h3>
        {check.state === "not-configured" && (
          <p className="text-sm text-slate-700" data-testid="wt-not-configured">
            {NOT_CONFIGURED}
          </p>
        )}
        {check.state === "error" && (
          <p className="text-sm text-red-700" data-testid="wt-check-error">
            Meta could not be read: {check.message}
          </p>
        )}
        {check.state === "ok" && (
          <>
            <p className="text-sm text-slate-600" data-testid="wt-summary">
              {newCount} new, {changedCount} changed, {check.diffs.filter((d) => d.kind === "same").length} the same,{" "}
              {check.diffs.filter((d) => d.kind === "not-ours").length} at Meta but not in the code (never deleted, yours to decide).
            </p>
            <TemplateDiffTable diffs={check.diffs} />
            {newCount + changedCount > 0 ? (
              <SubmitTemplatesControls newCount={newCount} changedCount={changedCount} />
            ) : (
              <p className="text-sm text-slate-700" data-testid="wt-nothing">
                Nothing to submit: every template matches what Meta holds.
              </p>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="wt-status-title" className="space-y-3">
        <h3 id="wt-status-title" className="text-lg font-semibold text-slate-900">
          Status from Meta ({rows.length})
        </h3>
        <p className="max-w-2xl text-sm text-slate-600">What Meta&apos;s template updates said last: approved, rejected, paused, a new category or quality rating.</p>
        <TemplateStatusTable rows={rows} />
      </section>
    </div>
  );
}
