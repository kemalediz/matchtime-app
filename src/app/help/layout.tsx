import Link from "next/link";
import { BookOpen, UserCog, Users } from "lucide-react";

/**
 * Shared shell for the /help section: prose width, sub-nav tabs at the
 * top, section anchor support. Server component — no client state here,
 * just layout.
 */
export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <div className="max-w-4xl mx-auto px-6 py-8 sm:py-12">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Help & guides</h1>
            <p className="text-sm text-slate-500">
              How MatchTime works, end to end.{" "}
              <Link href="/" className="text-blue-600 hover:underline">
                Back to MatchTime
              </Link>
            </p>
          </div>
        </div>

        <div className="flex gap-2 mb-8 border-b border-slate-200">
          <TabLink href="/help" icon={<BookOpen className="w-4 h-4" />} label="Overview" />
          <TabLink href="/help/admin" icon={<UserCog className="w-4 h-4" />} label="For organisers" />
          <TabLink href="/help/player" icon={<Users className="w-4 h-4" />} label="For players" />
        </div>

        <article className="help-article prose prose-slate max-w-none prose-headings:scroll-mt-20 prose-headings:font-semibold prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-3 prose-h3:text-base prose-h3:mt-6 prose-h3:mb-2 prose-p:text-[15px] prose-p:leading-relaxed prose-li:text-[15px] prose-li:leading-relaxed prose-code:text-[13px] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:bg-slate-100 prose-code:text-slate-800 prose-code:before:content-none prose-code:after:content-none prose-strong:text-slate-900">
          {children}
        </article>
      </div>
    </div>
  );
}

function TabLink({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-600 border-b-2 border-transparent hover:border-slate-300 hover:text-slate-900 data-[active=true]:border-blue-600 data-[active=true]:text-blue-700"
    >
      {icon}
      {label}
    </Link>
  );
}
