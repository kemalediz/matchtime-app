export const metadata = { title: "Organiser guide" };

export default function AdminGuidePage() {
  return (
    <>
      <h2 className="!mt-0">Organiser guide</h2>
      <p>
        You run the group. This guide walks through what MatchTime does for
        you each week, and what you can check or fix from the dashboard.
        MatchTime costs up to £9.99 a month per group, and you only pay for
        the weeks you play. Your first month is free. See{" "}
        <a href="#club-fee">Club fee</a> below.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="setup">1. Getting started</h2>

      <h3>Sign up and create your club</h3>
      <p>
        Sign up and hit <strong>Create organisation</strong>. Give it the same
        name as your WhatsApp group so it&apos;s obvious when MatchTime posts
        there. If you have a WhatsApp chat export, the setup wizard can read it
        and suggest your player list and schedule.
      </p>

      <h3>We&apos;ll help you add MatchTime to your WhatsApp group</h3>
      <p>
        Sign up and we&apos;ll get your group connected, usually the same day.
        Nothing else changes for your players: they keep saying In and Out as
        they always have. Once it&apos;s in your group, MatchTime:
      </p>
      <ul>
        <li>Reads messages in your group, and only acts on In, Out and messages that tag <strong>@Match Time</strong></li>
        <li>Reacts ✅ (in the squad), 🪑 (bench) or 👋 (dropped) to attendance messages</li>
        <li>Posts updates and sends DMs around each match</li>
      </ul>
      <p>
        Don&apos;t like it? Remove it from the group. You can also switch
        individual features off in <strong>Settings</strong>.
      </p>

      <h3 id="club-fee">Club fee</h3>
      <p>
        Your first month is free, counted from the day we approve your club.
        No card is needed to start.
      </p>
      <p>
        After that you only pay for the weeks you play: up to £9.99 a month
        per WhatsApp group, VAT included, for the whole group rather than
        each player. After each month MatchTime counts the games your group
        played out of the games it had scheduled, and the card on file is
        charged for those only, the morning after the month ends. Play 3
        weeks out of 4 and it&apos;s £7.49. Play none, or take a summer
        break, and nothing is charged.
      </p>
      <p>
        The <strong>money collector</strong> (the person who collects the
        match fees, set in <strong>Settings</strong>) adds a card. If no money
        collector is set, the club owner is asked instead. Nothing is taken
        when the card is added.
      </p>
      <p>
        Nine days before your first month ends, MatchTime sends a reminder by
        WhatsApp with a link to your billing page, and another two days
        before the end if there is still no card. If the first month ends
        without a card, MatchTime keeps running for a week. After that week
        it goes quiet in your group until a card is added: no posts, no
        replies, and nothing is said in the group. Your players, matches and
        stats are all kept, and MatchTime starts again within a few minutes
        of a card being added.
      </p>
      <p>
        Each month, its games and its charge are on your billing page. There
        is no contract: to stop, press <strong>Stop paying</strong> there.
        Billing ends when the current month ends, and that month is charged
        only for the games played, as usual. Removing MatchTime from the
        group stops it straight away; the games already played that month
        are charged when the month ends.
      </p>
      <p>
        <strong>Tip:</strong> a game played costs the club at most £2.50
        (£9.99 over four weeks), so with 10 players it&apos;s at most about
        25p a player per game. Add that to each player&apos;s match fee and
        the club fee is covered; a week you don&apos;t play costs nothing.
        Match fees are separate: collecting them through MatchTime is
        optional (see <a href="#payments">Payments</a>).
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="activities">2. Your weekly match</h2>

      <p>
        Each regular game is an <strong>activity</strong>, for example
        &quot;Tuesday 7-a-side&quot;. For each one you set:
      </p>
      <ul>
        <li>The sport and format (football 5, 7 or 11-a-side, futsal, basketball and more), which sets the squad size</li>
        <li>Day, kickoff time and venue</li>
        <li>How many hours before kickoff sign-ups close, and how long the match lasts</li>
      </ul>
      <p>
        Upcoming matches are created for you automatically, so there&apos;s
        always a next match for players to say In to.
      </p>

      <h3>A smaller format for short weeks</h3>
      <p>
        If you usually play 7-a-side but drop to 5-a-side when numbers are
        short, set up both as activities. MatchTime will suggest the switch
        in its call for players, and DM you the day before if you&apos;re
        short (see below). You book the smaller pitch and switch the match
        yourself (see the next section).
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="schedule">3. Changing the schedule</h2>

      <p>
        Schedule changes are made on the dashboard, not by messaging
        MatchTime. Open <strong>Admin</strong> in the menu; the tabs along the
        top take you to each screen.
      </p>

      <h3>Add or change your weekly game</h3>
      <ol>
        <li>Go to <strong>Admin</strong>, then the <strong>Activities</strong> tab.</li>
        <li>
          For a new game, press <strong>Create activity</strong>, fill in the
          name, sport, day, time, venue, sign-up deadline and match length,
          then press Create.
        </li>
        <li>
          To change a game, press <strong>Edit</strong> next to it, change the
          name, day, time or venue, then press <strong>Save changes</strong>.
        </li>
      </ol>
      <p>
        <em>What the group is told:</em> Nothing is posted. A new day or time
        applies to matches created from then on; matches already created keep
        their date and time.
      </p>

      <h3>Book a run of weeks</h3>
      <ol>
        <li>On the <strong>Block bookings</strong> tab, press <strong>New block booking</strong>.</li>
        <li>
          Pick the activity and the start date. The kickoff time defaults to
          the activity&apos;s; change it only if this booking is different.
        </li>
        <li>
          Under Block length, choose an end date or a number of matches (up
          to 60). Cost per match and notes are optional, for your own records.
        </li>
        <li>
          Press <strong>Preview dates</strong> and check the list. A date that
          already has a match is added to the block, not duplicated.
        </li>
        <li>Press <strong>Create block</strong>.</li>
      </ol>
      <p>
        <em>What the group is told:</em> Nothing is posted. MatchTime carries
        on announcing only the next match that&apos;s on.
      </p>

      <h3>Cancel or restore a range of dates</h3>
      <p>
        For a holiday, or weeks when the pitch isn&apos;t available. It works
        for any match, booked in a block or not.
      </p>
      <ol>
        <li>On the <strong>Block bookings</strong> tab, press <strong>Bulk cancel / restore</strong>.</li>
        <li>
          Set From and To (both dates included), choose{" "}
          <strong>Cancel matches</strong> or{" "}
          <strong>Restore cancelled matches</strong> under Action, then press{" "}
          <strong>Find matches</strong>.
        </li>
        <li>
          Untick any match you want to leave alone. Matches that already have
          players in show how many.
        </li>
        <li>
          When cancelling, tick <strong>Announce to the group</strong> if you
          want players told. Then press the button at the bottom to confirm.
        </li>
      </ol>
      <p>
        <em>What the group is told:</em> Nothing, unless you ticked Announce
        to the group. Then MatchTime posts one &quot;❌ Schedule update&quot;
        message listing the dates that are off. Restoring is always silent.
      </p>
      <p>
        Each block on the Block bookings tab also has{" "}
        <strong>Cancel remaining</strong> (every future match in that block,
        silently) and <strong>Restore cancelled</strong>.
      </p>

      <h3>Cancel one match</h3>
      <ol>
        <li>Open <strong>Matches</strong> in the menu and pick the match.</li>
        <li>
          Press <strong>Manage teams</strong>, or <strong>Generate teams</strong>{" "}
          if sign-ups have closed and the teams aren&apos;t made yet.
        </li>
        <li>
          Press <strong>Cancel match</strong>, check the details, then press
          Cancel match again to confirm.
        </li>
      </ol>
      <p>
        <em>What the group is told:</em> MatchTime posts
        &quot;❌ Match cancelled&quot; with the date and time, saying there
        aren&apos;t enough players this week. Reminders and DMs for that match stop, and
        there are no ratings or Man of the Match that week.
      </p>
      <p>
        Before sign-ups close, the match page has no teams button. To cancel
        then, use Bulk cancel / restore with the same date in From and To.
      </p>

      <h3>Switch one match to a smaller format</h3>
      <p>The smaller format needs its own activity first (see above).</p>
      <ol>
        <li>Open <strong>Matches</strong> in the menu and pick the match.</li>
        <li>Press <strong>Switch format</strong>.</li>
        <li>
          Under <strong>Switch to</strong>, pick the smaller activity. The page
          shows how many players stay in and how many move to the bench (the
          earliest Ins keep their places).
        </li>
        <li>Press <strong>Confirm switch</strong>.</li>
      </ol>
      <p>
        <em>What the group is told:</em> MatchTime posts
        &quot;🔁 Match switched&quot; with the new format, who&apos;s playing and who&apos;s on
        the bench. If the smaller format kicks off at a different time, the
        match moves to that time and the post says so.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="players">4. Players</h2>

      <h3>Adding players</h3>
      <ol>
        <li>
          <strong>Add them yourself</strong> under <strong>Players</strong>:
          a name, and a phone number so they get DMs.
        </li>
        <li>
          <strong>They post in the group.</strong> Someone MatchTime
          doesn&apos;t know yet is added straight away (so their In
          isn&apos;t lost) and flagged <strong>NEW</strong> for you to check.
        </li>
        <li>
          <strong>Someone brings them</strong> (&quot;my brother Dan is in
          too&quot;). Same as above: added and flagged for you.
        </li>
      </ol>

      <h3>Checking new players</h3>
      <p>
        New players show with a <strong>NEW</strong> badge and a banner at the
        top of the Players page. Press <strong>Confirm</strong> once
        you&apos;re happy, or <strong>Remove</strong> if they shouldn&apos;t be
        there. Removing someone keeps their past games and ratings but takes
        them off future matches. While anyone is waiting, you get one DM a day
        reminding you.
      </p>
      <p>
        If the same person ends up on the list twice under different names,
        use <strong>Merge</strong>. You can also add nicknames, so
        &quot;Danny&quot; and &quot;Dan&quot; always mean the same player.
      </p>

      <h3>Starting ratings</h3>
      <p>
        Give each player a starting rating from 1 to 10 so the first teams
        are fair:
      </p>
      <ul>
        <li><strong>9</strong>: carries a team</li>
        <li><strong>7 or 8</strong>: strong regular</li>
        <li><strong>5 or 6</strong>: steady contributor</li>
        <li><strong>3 or 4</strong>: still learning</li>
      </ul>
      <p>
        As team-mates rate each other after games, their ratings take over
        from yours. Players never see the starting rating you gave them; they
        only see what team-mates have said.
      </p>

      <h3>Positions and phones</h3>
      <p>
        Set each player&apos;s positions per activity under{" "}
        <strong>Players</strong>, or players can set their own on their
        profile. A phone number is what lets MatchTime DM someone their
        rating link, bench offers and reminders. Without one they can still
        say In and Out in the group.
      </p>

      <h3>More admins</h3>
      <p>
        Change anyone&apos;s role from Player to Admin on the Players page.
        Admins can use the dashboard and get the organiser DMs.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="match-lifecycle">5. What happens each week</h2>

      <p>
        The steps follow your match day, so this works the same whether you
        play on a Tuesday night or a Sunday morning. Anything tagged{" "}
        <strong>@Match Time</strong> is answered straight away, whenever it
        comes in.
      </p>

      <h3>In the days before</h3>
      <ul>
        <li>
          Players say In or Out. When the squad is full, late Ins go on the
          bench.
        </li>
        <li>
          <strong>Every day at 17:00</strong> MatchTime posts the squad so far,
          with a call for players if you&apos;re short.
        </li>
        <li>
          If a confirmed player drops and there&apos;s a bench, the bench is
          offered the spot in the group and by DM. The first to claim it plays.
        </li>
        <li>
          Anyone who said maybe gets a DM a day before kickoff asking if
          they&apos;re in or out.
        </li>
        <li>
          Short of players? As an admin, ask it:{" "}
          <code>@Match Time we need 2 more, invite the recent players</code>.
          It DMs people who played in your last few matches but haven&apos;t
          replied yet, and follows up once if they don&apos;t answer.
        </li>
      </ul>

      <h3>The day before</h3>
      <ul>
        <li>
          <strong>Around 10:00</strong>, if you&apos;re short and you have a
          smaller format set up, you get a DM suggesting the switch.
        </li>
        <li>
          <strong>Around 18:00</strong>, if you&apos;re below the minimum to
          play at all, you get a DM suggesting you cancel.
        </li>
      </ul>

      <h3>Match day</h3>
      <ul>
        <li>
          If you&apos;re still short, more calls for players go out on match
          morning and in the last few hours before kickoff. They stop the
          moment the squad is full.
        </li>
        <li>
          Teams are made when anyone asks:{" "}
          <code>@Match Time generate the teams</code>. You can also generate
          them from the dashboard.
        </li>
        <li>
          About 2 hours before kickoff (football), a reminder to bring goalie
          gloves, a ball and spare bibs.
        </li>
      </ul>

      <h3>After the match</h3>
      <ul>
        <li>
          About an hour after the end, MatchTime asks for the score. Anyone who
          played, or an admin, can post it (<code>7-3</code>,{" "}
          <code>we won 5-4</code>).
        </li>
        <li>
          From <strong>08:00 the next morning</strong>, everyone who played
          gets a personal rating link by DM, then a reminder at 18:00 each day
          for up to 5 days until they&apos;ve rated.
        </li>
        <li>
          <strong>Man of the Match</strong> is announced in the group as soon
          as everyone has voted (between 09:00 and 21:00), or from day 5 at the
          latest.
        </li>
        <li>
          Want to know who hasn&apos;t rated yet? It&apos;s on your dashboard,
          or ask <code>@Match Time who hasn&apos;t rated?</code>
        </li>
      </ul>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="team-balancing">6. How teams are picked</h2>

      <p>
        MatchTime uses each player&apos;s rating at your club: your starting
        rating at first, then more and more the ratings team-mates give after
        each game. It also takes a quick look at the week&apos;s chat for
        anything that matters tonight (someone carrying a knock, say) and
        nudges ratings a little. Then it splits the squad into two sides with
        the closest total rating, keeping positions like goalkeepers spread
        evenly where it can.
      </p>
      <p>
        Only confirmed players are included. To count in someone who has
        already replied for this match, ask{" "}
        <code>@Match Time generate the teams including Dan</code>.
      </p>

      <h3>Changing the teams</h3>
      <p>
        From the match page, choose <strong>Manage teams</strong> to swap two
        players, move someone to the other side, swap colours, add or remove
        players, or bring someone up from the bench. In the group,{" "}
        <code>@Match Time swap Dan with Leo</code> and{" "}
        <code>@Match Time swap the colours</code> work too.
      </p>
      <p>
        If someone drops after the teams are out, whoever replaces them (a
        bench player who claims the spot, or &quot;Sam is replacing
        Joe&quot;) goes straight into the same team, so you don&apos;t have to
        redo them.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="scores-ratings">7. Scores, ratings and Man of the Match</h2>

      <ul>
        <li>
          Each player rates everyone else who played, from 1 to 10, and picks
          one Man of the Match.
        </li>
        <li>
          Every score also moves a separate results-based ranking, where a big
          win counts for more than a narrow one. Players see it on the
          leaderboard; it isn&apos;t used to pick teams.
        </li>
        <li>
          A wrong score can be corrected from the team page for that match.
        </li>
      </ul>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="payments">8. Payments (optional)</h2>
      <p>
        Switch on <strong>Collect match fees</strong> in Settings, choose who
        collects the money and connect their bank. After each game players
        get a pay link: card, Apple Pay, Google Pay or pay by bank. Players
        who haven&apos;t paid are reminded by DM. Players can also choose to
        pay the collector directly, and the collector confirms it.
      </p>
      <p>
        Players pay the card or bank fee on top, so the collector receives
        the full match fee. Collecting cash instead? Just leave payments off.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="admin-dms">9. DMs you&apos;ll get as an admin</h2>

      <ul>
        <li>
          <strong>New players to check</strong>: once a day while anyone is
          waiting.
        </li>
        <li>
          <strong>Switch format</strong>: the day before, around 10:00, when
          you&apos;re short and a smaller format is set up.
        </li>
        <li>
          <strong>Cancel</strong>: the day before, around 18:00, when even the
          smallest format can&apos;t fill.
        </li>
      </ul>
      <p>
        Each DM has a link that signs you straight in and opens the right
        page. Links are valid for
        48 hours.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="corrections">10. Fixing things</h2>

      <h3>Someone&apos;s attendance is wrong</h3>
      <p>
        Open the match. You can add a player, take someone out, or move
        someone up from the bench.
      </p>

      <h3>A message wasn&apos;t understood</h3>
      <p>
        If someone said In or Out and MatchTime couldn&apos;t tell who they
        meant, it appears under <strong>Unresolved</strong>. Link it to the
        right player once and that name is remembered from then on.
      </p>

      {/* ───────────────────────────────────────────────── */}
      <h2 id="faq">11. FAQ</h2>

      <h3>How do I get MatchTime into my group?</h3>
      <p>
        Sign up and create your club, and we&apos;ll help you add MatchTime to
        your WhatsApp group, usually the same day. Questions? Email{" "}
        <a href="mailto:hello@matchtime.ai">hello@matchtime.ai</a>.
      </p>

      <h3>Does MatchTime reply to everything?</h3>
      <p>
        No. It only acts on In, Out and messages that tag{" "}
        <strong>@Match Time</strong>. The rest of the chat is left alone.
      </p>

      <h3>Can I run two games from one group?</h3>
      <p>
        MatchTime handles one weekly game per WhatsApp group. If you run a
        second game, give it its own group.
      </p>

      <h3>Can players turn off DMs?</h3>
      <p>
        Yes. A player can DM MatchTime <code>stop</code> to turn off
        everything except payment messages, or <code>stop ratings</code> for
        just the rating links. <code>start messages</code> turns them back on.
      </p>

      <h3>How do I stop using it?</h3>
      <p>
        Remove MatchTime from your WhatsApp group. Your matches, ratings and
        stats stay on the dashboard.
      </p>
    </>
  );
}
