/**
 * The privacy policy in English. Plain words, short sentences, no em or
 * en dashes. Facts (company, email, version, date) come from `f`; see
 * `privacy-policy.ts` for the shape and the house rules.
 */
import { formatPolicyDate, type PolicyFacts, type PrivacyPolicyCopy } from "./privacy-policy-shared";

export function buildPrivacyPolicyEn(f: PolicyFacts): PrivacyPolicyCopy {
  const { company: c, email, ico } = f;
  const date = formatPolicyDate(f.effectiveDate, "en-GB");
  const name = c.legalName ?? "MatchTime";
  const number = c.companyNumber ? ` (company number ${c.companyNumber})` : "";
  const office = c.registeredOffice ? ` Our registered office is ${c.registeredOffice}.` : "";

  return {
    title: "Privacy policy",
    lead:
      "How MatchTime uses the details of the players and organisers it works with, and of the people who join its player pool.",
    versionLine: `Version ${f.version}, in effect from ${date}`,
    contentsLabel: "On this page",
    languageLabel: "Language",
    backHome: "Back to MatchTime",
    sections: [
      {
        id: "who-we-are",
        heading: "Who we are",
        blocks: [
          {
            kind: "p",
            text: `MatchTime is run by ${name}, a company registered in England and Wales${number}.${office} We decide how your personal data is used, which makes us the controller under UK data protection law.`,
          },
          {
            kind: "p",
            text: [
              "For anything about your personal data, email ",
              email,
              ". We have not appointed a Data Protection Officer because the law does not require us to, so this address reaches the people responsible.",
            ],
          },
        ],
      },
      {
        id: "what-it-covers",
        heading: "Who this policy covers",
        blocks: [
          { kind: "p", text: "This policy covers everyone MatchTime holds details about:" },
          {
            kind: "list",
            items: [
              "players in a WhatsApp group that uses MatchTime to run its games;",
              "organisers who set up and run a club on MatchTime;",
              "people who join the MatchTime player pool to be offered games near them, including people who are not in any club yet;",
              "anyone who messages MatchTime privately or visits this website.",
            ],
          },
          { kind: "p", text: "Points that start with “Player pool” apply only to pool members." },
        ],
      },
      {
        id: "what-we-hold",
        heading: "What we hold",
        blocks: [
          { kind: "p", text: "For every player and organiser:" },
          {
            kind: "list",
            items: [
              "your name and your WhatsApp phone number;",
              "the messages you send in a group MatchTime is in, and the messages you send MatchTime privately, so it can understand what you are asking;",
              "your games: whether you are in, out or on the bench, the teams, results, ratings, Man of the Match votes and badges;",
              "payments for games: what is owed and what was paid. Card details are taken by our payment provider, and we never see your full card number;",
              "for organisers: the club's settings, venues and schedule, and billing records.",
            ],
          },
          { kind: "p", text: "Player pool members, as well:" },
          {
            kind: "list",
            items: [
              "your area as a postcode district (such as SM1) and your travel distance;",
              "the days and hours you can play, your sports, the formats you like and, if you give it, your level in each sport;",
              "your consent record: when you agreed, which version of this policy you agreed to, and the message that confirmed it;",
              "the game offers we send you and your answers, including replies in your own words;",
              "your turn-up record: games played, no-shows and late cancellations;",
              "blocks and reports made by you or about you;",
              "referral and source codes: who brought you, or which link you used to sign up;",
              "your answers to invitations to join a club;",
              "your early sign-up, if you joined the early sign-up list before the pool opened.",
            ],
          },
          {
            kind: "p",
            text: "We never ask for or keep a full postcode, your exact location or your date of birth.",
          },
        ],
      },
      {
        id: "why",
        heading: "Why we use it, and the law that allows it",
        blocks: [
          {
            kind: "list",
            items: [
              "To run your club's games (who is in, the bench, teams, ratings, payments). For organisers this is our contract with you. For players it is our legitimate interest, and the club's, in running the game the group signed up for.",
              "Player pool: to keep your profile and match you to games, because you asked us to. It is the service you signed up for.",
              "Player pool: to send you offers of games, because you gave your consent. You can withdraw it at any time, as easily as you gave it.",
              "Player pool: to keep a turn-up record and to act on blocks and reports, because we have a legitimate interest in keeping games reliable and safe for everyone.",
              "To keep billing and payment records, because the law requires it.",
              "To keep MatchTime secure and fix problems, because we have a legitimate interest in a safe service that works.",
            ],
          },
        ],
      },
      {
        id: "who-sees-it",
        heading: "Who sees your details",
        blocks: [
          {
            kind: "p",
            text: "In your own club, the group sees what MatchTime posts there, such as the list, the bench, teams, results, leaderboards and badges. Organisers also see payments and settings in the club's dashboard.",
          },
          { kind: "p", text: "Player pool: clubs see as little as possible, step by step:" },
          {
            kind: "list",
            items: [
              "before a club asks for players, it sees only roughly how many pool players are nearby, never names or a list;",
              "while offers are out, it sees how many players were asked and how many said no, never who;",
              "when you accept a place, the club sees your first name and last initial, that you came from the MatchTime player pool, and your turn-up record;",
              "a club never sees your phone number, your area, the other clubs you play for or your ratings elsewhere. Your phone number only reaches a club's members if you choose to join its WhatsApp group yourself.",
            ],
          },
          {
            kind: "p",
            text: "An offer shows you the club, the venue, the day, the time, the format and the cost. It never shows the names or phone numbers of the club's members.",
          },
          {
            kind: "p",
            text: "Badges for bringing friends to a game, and a “Brought by” line on a friend's first game, name you in your own club's group. You can make them private on your manage page.",
          },
          { kind: "p", text: "We do not sell your data and we do not share it with advertisers." },
        ],
      },
      {
        id: "service-providers",
        heading: "Service providers",
        blocks: [
          {
            kind: "p",
            text: "We use a small number of companies to run MatchTime. They act only on our instructions and may not use your data for anything else:",
          },
          {
            kind: "list",
            items: [
              "a messaging service, which carries messages between you and MatchTime;",
              "hosting and database providers, which store the data;",
              "an AI service, which reads messages so MatchTime can understand them. For the player pool it reads only your reply to your own offer, together with that offer, and your pool profile is never shared with it;",
              "a card payment provider, for clubs that take payments;",
              "a website analytics service, which counts visits to our web pages and completed player pool sign-ups. It sets no cookies and never receives your name, phone number or postcode;",
              "an email provider, for the few emails we send.",
            ],
          },
          {
            kind: "p",
            text: "Some of these providers may handle data outside the UK. When they do, we rely on the safeguards UK law requires: a country the UK has found to protect data adequately, or the UK's approved data transfer agreement.",
          },
        ],
      },
      {
        id: "automatic-choices",
        heading: "Choices made automatically",
        blocks: [
          {
            kind: "p",
            text: "Player pool: MatchTime chooses automatically which pool players to offer a place to, using what you told us (sport, area, distance, days and hours, format) and your turn-up record.",
          },
          {
            kind: "p",
            text: [
              "If you leave several offers in a row unanswered, or miss games you accepted, your offers are paused automatically. You can ask for a person to review a pause at any time by emailing ",
              email,
              ". We will look at it and tell you what we decided.",
            ],
          },
          {
            kind: "p",
            text: "In clubs, MatchTime also balances teams automatically using ratings, when the organiser asks. None of these choices has a legal effect on you.",
          },
        ],
      },
      {
        id: "how-long",
        heading: "How long we keep it",
        blocks: [
          {
            kind: "list",
            items: [
              "Club records (games, teams, results, ratings) are kept while your club uses MatchTime, so its history and stats stay correct.",
              "Player pool: if your profile has no activity for 12 months (no reply, no game and no visit to your manage page), we send you one message to ask whether you still want offers. If you do not answer within 30 days, we end your profile and erase its personal details.",
              "Player pool: records of offers keep only what is needed to keep things fair and stop misuse, and are made anonymous after 24 months.",
              "When a pool profile is deleted, we keep a short record of any block or report for 24 months, so a person who was blocked cannot simply sign up again, and the record of your consent for 6 years, to show what you agreed to.",
              "Billing and payment records are kept for 6 years, as tax law requires.",
              "If you ask us to delete your details, we remove your name and phone number. A game you played as a guest stays in that club's history, as it does for any past guest.",
            ],
          },
        ],
      },
      {
        id: "your-rights",
        heading: "Your rights",
        blocks: [
          { kind: "p", text: "You have the right to:" },
          {
            kind: "list",
            items: [
              "see the data we hold about you and get a copy of it;",
              "correct anything that is wrong;",
              "have your data deleted;",
              "restrict how we use it;",
              "object to how we use it, including anything based on our legitimate interest;",
              "get a copy of the data you gave us in a form you can take elsewhere;",
              "withdraw your consent at any time, using the link in any offer or your manage page. This does not affect what was done before;",
              [
                "complain to the Information Commissioner's Office (ICO), the UK's data protection regulator, at ",
                ico,
                ".",
              ],
            ],
          },
          {
            kind: "p",
            text: [
              "To use any of these rights, email ",
              email,
              ". We reply within one month. Before we act we may ask you to confirm it is you, usually with a message from your own WhatsApp.",
            ],
          },
        ],
      },
      {
        id: "age",
        heading: "Age",
        blocks: [
          {
            kind: "p",
            text: "The player pool is only for people aged 18 or over, because players meet people they do not know at games. We do not knowingly keep a pool profile for anyone younger, and we delete one if we find it.",
          },
        ],
      },
      {
        id: "cookies",
        heading: "Cookies",
        blocks: [
          {
            kind: "p",
            text: "This website uses only the cookies it needs to work, such as the one that keeps you signed in. We use no advertising or tracking cookies, so we do not ask you to accept any.",
          },
        ],
      },
      {
        id: "security",
        heading: "Keeping your data safe",
        blocks: [
          {
            kind: "p",
            text: "Your data travels over encrypted connections and is stored so that only the people who need it to run MatchTime can reach it. The links we send you to manage your profile are personal to you, so please do not forward them. If something happens that puts your data at risk, we will tell you and the ICO whenever the law requires it.",
          },
        ],
      },
      {
        id: "changes",
        heading: "Changes to this policy",
        blocks: [
          {
            kind: "p",
            text: `This is version ${f.version} of this policy, in effect from ${date}. When you give consent, we record which version you agreed to.`,
          },
          {
            kind: "p",
            text: "If we make a big change, such as using your data for something new, we will tell you before it applies, by message if you are in the player pool. Small fixes to the wording are made on this page, and the date at the top changes.",
          },
        ],
      },
    ],
  };
}
