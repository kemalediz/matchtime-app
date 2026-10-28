/**
 * "FIND A SETTING" on /admin/settings (2026-10-28): a static index of the
 * page's cards and a pure search over it. Each card is found by its title
 * and by keywords, in English AND Turkish whatever the club's language
 * ("pool" and "havuz" both find Player pool), including the titles of the
 * settings inside it (the ⓘ titles, `settings-info.ts`).
 *
 * Client-side and static: it searches the settings, never people's
 * messages or any club data. Unit tested in `__tests__/settings-search.test.ts`.
 */
import { SETTINGS_CARDS, type SettingsCardId, type SettingsTab } from "./settings-anchors";
import { settingInfo, type SettingInfoKey } from "./settings-info";
import { settingsNavCopy } from "./i18n/settings-nav";
import { poolClubSwitchCopy } from "./i18n/pool-club-switch";
import { poolClubShareCopy } from "./i18n/pool-club-share";
import { inviteCopy } from "./i18n/pool-invite";
import { t } from "./i18n/t";
import { normaliseLang, type Lang } from "./i18n/lang";

type Titled = (lang: Lang) => string;

interface CardSearchSpec {
  title: Titled;
  /** The settings inside the card: their ⓘ titles are keywords too. */
  settings: SettingInfoKey[];
  keywords: { en: string[]; tr: string[] };
}

const nav = (k: keyof ReturnType<typeof settingsNavCopy>["titles"]): Titled => (l) => settingsNavCopy(l).titles[k];

const SPECS: Record<SettingsCardId, CardSearchSpec> = {
  "club-details": {
    title: (l) => t(l).st_general_title,
    settings: ["clubName"],
    keywords: { en: ["club name", "name", "members", "details"], tr: ["kulüp adı", "ad", "üye", "bilgiler"] },
  },
  "bot-language": {
    title: (l) => t(l).st_language_title,
    settings: ["language"],
    keywords: { en: ["language", "english", "turkish"], tr: ["dil", "ingilizce", "türkçe"] },
  },
  whatsapp: {
    title: (l) => t(l).st_wa_title,
    settings: [],
    keywords: { en: ["whatsapp", "group", "bot", "go live"], tr: ["whatsapp", "grup", "bot", "yayına al"] },
  },
  "weekly-routine": {
    title: (l) => t(l).wr_section_title,
    settings: ["rollingSquad", "listAnnouncer", "dropOutDeadline", "listPublish"],
    keywords: { en: ["deadline", "drop out", "list", "squad", "weekly"], tr: ["son saat", "çıkış", "liste", "kadro", "haftalık"] },
  },
  reminders: {
    title: nav("reminders"),
    settings: ["reminders", "gearReminder"],
    keywords: { en: ["reminder", "remind me", "kit", "gear", "gloves", "ball"], tr: ["hatırlatma", "hatırlat", "malzeme", "eldiven", "top"] },
  },
  teams: {
    title: nav("teams"),
    settings: ["teamBalancing", "teamNames", "teamsReady"],
    keywords: { en: ["teams", "team names", "balance", "colours", "bibs"], tr: ["takım", "takım adları", "denge", "renk", "yelek"] },
  },
  "monthly-squad": {
    title: (l) => t(l).msq_section_title,
    settings: ["squadMode", "monthCreditRule", "paygPrice", "monthListOpens"],
    keywords: { en: ["monthly", "month", "payg", "regulars"], tr: ["aylık", "ay", "daimi"] },
  },
  attendance: {
    title: nav("attendance"),
    settings: ["attendance"],
    keywords: { en: ["attendance", "in", "out", "squad list", "who is playing"], tr: ["yoklama", "varım", "yokum", "kadro listesi"] },
  },
  bench: {
    title: nav("bench"),
    settings: ["bench", "benchPickMode", "benchPickFallback"],
    keywords: { en: ["bench", "substitutes", "reserves", "open place"], tr: ["yedek", "yedekler", "boş yer"] },
  },
  ratings: {
    title: nav("ratings"),
    settings: ["playerRating", "badgeAnnouncements", "statsQa"],
    keywords: { en: ["ratings", "rating", "badges", "stats", "statistics"], tr: ["puan", "puanlar", "rozet", "istatistik"] },
  },
  mom: {
    title: nav("mom"),
    settings: ["momVoting", "momChosenBy"],
    keywords: { en: ["mom", "motm", "man of the match", "vote", "best player"], tr: ["maçın adamı", "oy", "oylama", "en iyi oyuncu"] },
  },
  "invite-link": {
    title: (l) => t(l).st_invite_title,
    settings: [],
    keywords: { en: ["invite", "join", "link", "add players"], tr: ["davet", "katıl", "bağlantı", "oyuncu ekle"] },
  },
  payments: {
    title: nav("payments"),
    settings: ["paymentCollection", "payByBank", "payCard", "payDirect", "moneyCollector", "collectorBank", "paymentInstructions"],
    keywords: { en: ["payments", "pay", "fees", "money", "stripe", "bank", "collector", "card"], tr: ["ödeme", "ücret", "para", "stripe", "banka", "kart"] },
  },
  billing: {
    title: nav("billing"),
    settings: [],
    keywords: { en: ["billing", "club fee", "subscription", "invoice"], tr: ["fatura", "kulüp ücreti", "abonelik"] },
  },
  "partner-clubs": {
    title: (l) => t(l).pc_section_title,
    settings: [
      "partnerClubs",
      "partnerAskWhen",
      "partnerAskTime",
      "partnerAskCutoff",
      "partnerApproval",
      "partnerDiscoverable",
      "partnerAutoAccept",
      "partnerShareRatings",
      "clubHomeVenue",
    ],
    keywords: { en: ["partner", "clubs", "borrow players", "venue", "other clubs"], tr: ["partner", "kulüp", "oyuncu ödünç", "saha", "diğer kulüpler"] },
  },
  "player-pool": {
    title: (l) => poolClubSwitchCopy(l).title,
    settings: ["playerPool"],
    keywords: { en: ["pool", "player pool", "guests", "find players"], tr: ["havuz", "oyuncu havuzu", "misafir", "oyuncu bul"] },
  },
  "play-style": {
    title: (l) => t(l).ps_title,
    settings: ["playStyle"],
    keywords: { en: ["style", "casual", "competitive", "pool"], tr: ["tarz", "oyun tarzı", "keyifli", "rekabetçi", "havuz"] },
  },
  "pool-auto-ask": {
    title: (l) => t(l).pauto_title,
    settings: ["poolAutoAsk"],
    keywords: { en: ["automatic", "auto ask", "pool"], tr: ["otomatik", "kendiliğinden", "havuz"] },
  },
  "pool-club-share": {
    title: (l) => poolClubShareCopy(l).title,
    settings: [],
    keywords: { en: ["share", "tell", "post", "pool"], tr: ["paylaş", "anlat", "mesaj", "havuz"] },
  },
  "group-invite-link": {
    title: (l) => inviteCopy(l).set_title,
    settings: ["groupInviteLink"],
    keywords: { en: ["invite link", "whatsapp link", "guests", "group link"], tr: ["davet bağlantısı", "whatsapp bağlantısı", "misafir", "grup bağlantısı"] },
  },
  "quiet-hours": {
    title: (l) => t(l).qh_settings_label,
    settings: ["quietHours"],
    keywords: { en: ["quiet", "night", "hours", "silent"], tr: ["sessiz", "gece", "saat"] },
  },
  "admin-group": {
    title: nav("adminGroup"),
    settings: ["adminChannel", "adminGroupLink"],
    keywords: { en: ["admin", "admins", "admin group", "hq", "organisers"], tr: ["yönetici", "yönetici grubu", "organizatör"] },
  },
  posters: {
    title: (l) => t(l).gp_title,
    settings: ["posters", "posterDesign", "posterBackground"],
    keywords: { en: ["poster", "graphics", "design", "background", "team sheet"], tr: ["afiş", "tasarım", "arka plan", "takım listesi"] },
  },
};

export interface SettingsIndexEntry {
  id: SettingsCardId;
  tab: SettingsTab;
  title: Record<Lang, string>;
  /** Folded for search: both titles, every keyword, every ⓘ title. */
  terms: string[];
  order: number;
}

/** Lower case (Turkish-aware) without accents: "Işık" → "isik". */
export function foldForSearch(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

export const SETTINGS_INDEX: SettingsIndexEntry[] = SETTINGS_CARDS.map((c, order) => {
  const spec = SPECS[c.id];
  const title = { en: spec.title("en"), tr: spec.title("tr") };
  const infoTitles = spec.settings.flatMap((k) => [settingInfo("en", k).title, settingInfo("tr", k).title]);
  return {
    id: c.id,
    tab: c.tab,
    title,
    terms: [...spec.keywords.en, ...spec.keywords.tr, ...infoTitles].map(foldForSearch),
    order,
  };
});

/** How well one word matches a card: 0 is no match. */
function scoreWord(word: string, titles: string[], terms: string[]): number {
  let best = 0;
  for (const tt of titles) {
    if (tt.startsWith(word)) best = Math.max(best, 4);
    else if (tt.split(" ").some((w) => w.startsWith(word))) best = Math.max(best, 3);
    else if (tt.includes(word)) best = Math.max(best, 2);
  }
  if (best) return best;
  for (const term of terms) {
    if (term.split(" ").some((w) => w.startsWith(word))) return 1;
    if (term.includes(word)) best = 0.5;
  }
  return best;
}

export interface SettingsSearchResult {
  id: SettingsCardId;
  tab: SettingsTab;
  /** In the club's language. */
  title: string;
}

/**
 * The cards matching `query`, best first. Every word of the query must
 * match the card's titles or keywords. `present`: only these cards (the
 * ones on the page for this club); all when omitted.
 */
export function searchSettings(query: string, lang: Lang | string | null | undefined, present?: ReadonlySet<string>): SettingsSearchResult[] {
  const words = foldForSearch(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const l = normaliseLang(lang);
  const scored: Array<{ e: SettingsIndexEntry; score: number }> = [];
  for (const e of SETTINGS_INDEX) {
    if (present && !present.has(e.id)) continue;
    const titles = [foldForSearch(e.title.en), foldForSearch(e.title.tr)];
    let score = 0;
    let all = true;
    for (const w of words) {
      const s = scoreWord(w, titles, e.terms);
      if (!s) {
        all = false;
        break;
      }
      score += s;
    }
    if (all) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.title[l].length - b.e.title[l].length || a.e.order - b.e.order);
  return scored.map(({ e }) => ({ id: e.id, tab: e.tab, title: e.title[l] }));
}
