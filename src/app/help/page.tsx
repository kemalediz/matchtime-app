import Link from "next/link";
import { UserCog, Users, ArrowRight } from "lucide-react";

export const metadata = { title: "Help & guides" };

export default function HelpLandingPage() {
  return (
    <>
      <h2 className="!mt-0">Welcome</h2>
      <p>
        MatchTime runs your group&apos;s weekly match from WhatsApp. It
        tracks who&apos;s in, runs the bench, chases when you&apos;re short,
        balances the teams when you ask and collects ratings after the game.
        It costs £9.99 a month for the whole group, not per player, and your
        first month is free. Add it to your group, and if you don&apos;t like
        it, remove it.
      </p>
      <p>Two guides, depending on your role in the group:</p>

      <div className="grid sm:grid-cols-2 gap-4 not-prose mt-6">
        <Link
          href="/help/admin"
          className="group block p-6 rounded-2xl border border-slate-200 bg-white hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <UserCog className="w-6 h-6 text-blue-600 mb-3" />
          <p className="font-semibold text-slate-900">For organisers</p>
          <p className="text-sm text-slate-500 mt-1">
            Setting up your club, managing players, what happens each week,
            payments, and what you can fix from the dashboard.
          </p>
          <span className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 mt-3 group-hover:gap-2 transition-all">
            Read the organiser guide <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </Link>
        <Link
          href="/help/player"
          className="group block p-6 rounded-2xl border border-slate-200 bg-white hover:border-purple-300 hover:shadow-sm transition-all"
        >
          <Users className="w-6 h-6 text-purple-600 mb-3" />
          <p className="font-semibold text-slate-900">For players</p>
          <p className="text-sm text-slate-500 mt-1">
            What to say in the group to play, drop out, bring a mate, ask
            questions and post the score, plus how ratings and MoM work.
          </p>
          <span className="inline-flex items-center gap-1 text-sm font-medium text-purple-600 mt-3 group-hover:gap-2 transition-all">
            Read the player guide <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </Link>
      </div>

      <h2>What MatchTime does, in one minute</h2>
      <ul>
        <li>
          <strong>Tracks who&apos;s in.</strong> Players say <code>IN</code> or{" "}
          <code>OUT</code> as normal. MatchTime reacts ✅ when you&apos;re in the
          squad, 🪑 when you&apos;re on the bench and 👋 when you&apos;ve dropped.
        </li>
        <li>
          <strong>Runs the bench.</strong> When someone drops, the bench is
          offered the spot and the first to claim it plays.
        </li>
        <li>
          <strong>Chases when short, stops when full.</strong> It asks the
          group for players at set points before kickoff, and goes quiet once
          the squad is full.
        </li>
        <li>
          <strong>Balances the teams when asked.</strong> Tag it with{" "}
          <code>@Match Time generate the teams</code> and it splits the squad
          using ratings and positions.
        </li>
        <li>
          <strong>Collects ratings after.</strong> Everyone gets a personal
          rating link the morning after, with a daily reminder at 18:00 for
          up to 5 days.
        </li>
        <li>
          <strong>Announces Man of the Match</strong> as soon as everyone has
          voted, or on day 5 at the latest.
        </li>
        <li>
          <strong>Stays quiet during banter.</strong> It only replies when
          tagged, or when someone says In or Out.
        </li>
      </ul>

      <p className="text-sm text-slate-500 not-prose mt-8">
        Have a question that isn&apos;t covered? Ask your group&apos;s
        organiser, or email{" "}
        <a href="mailto:hello@matchtime.ai" className="text-blue-600 underline">
          hello@matchtime.ai
        </a>
        .
      </p>
    </>
  );
}
