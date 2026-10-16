/**
 * THE SETTINGS EXPLANATIONS (2026-10-15): what every setting on
 * /admin/settings does, in plain words, for a club organiser who has
 * never used MatchTime. One place, so the whole set can be reviewed
 * together, in English and Turkish side by side.
 *
 * Read by the ⓘ beside each setting (`SettingInfo`,
 * src/components/info/setting-info.tsx). Each entry says:
 *   - `what`:     what the setting does, in the organiser's terms;
 *   - `example`:  a short example of the WhatsApp message, where one helps
 *                 (the real wording from the string tables, with sample
 *                 names, shortened);
 *   - `choices`:  what each choice does (On and Off for a switch);
 *   - `newClubs`: the default for a new club;
 *   - `suits`:    who it suits;
 *   - `together`: how it works with other settings.
 *
 * ACCURACY IS THE POINT. Every sentence here was traced to the code that
 * does it (org-features.ts, the scheduler, compose.ts, list-announcer.ts,
 * organiser-pick, rolling-squad, squad-month, weekly-deadlines,
 * team-proposal, admin-channel, admin-group-graphics, payments,
 * badge-announcements, club-setup, club-partnership and partner-ask for
 * the partner clubs). When the behaviour changes, change
 * the sentence here in the same PR.
 *
 * House rules for the copy (a test checks them): no em or en dashes, no
 * slash used for "or", every entry in both languages with the same shape.
 *
 * CLIENT-SAFE: no DB, no server imports. The settings page is a client
 * component.
 */
import { normaliseLang, type Lang } from "./i18n/lang";

/** Every setting with an explanation, in the page's order. */
export const SETTING_INFO_KEYS = [
  // Go live (shown while a club is setting up)
  "goLive",
  // General
  "clubName",
  "teamNames",
  "language",
  // Bot features
  "attendance",
  "bench",
  "teamBalancing",
  "momVoting",
  "playerRating",
  "reminders",
  "statsQa",
  // "paymentTracking" is hidden for now (2026-10-16): no row, no ⓘ.
  "paymentCollection",
  "payByBank",
  "payCard",
  "payDirect",
  "badgeAnnouncements",
  "gearReminder",
  // Weekly routine
  "rollingSquad",
  "benchPickMode",
  "benchPickFallback",
  "listAnnouncer",
  "dropOutDeadline",
  "listPublish",
  "adminChannel",
  "adminGroupLink",
  "teamsReady",
  // Partner clubs
  "partnerClubs",
  "partnerAskWhen",
  "partnerAskTime",
  "partnerAskCutoff",
  "partnerApproval",
  // Posters
  "posters",
  "posterDesign",
  "posterBackground",
  // Monthly squad
  "squadMode",
  "monthCreditRule",
  "paygPrice",
  "monthListOpens",
  "paymentInstructions",
  // Payments
  "moneyCollector",
  "collectorBank",
] as const;

export type SettingInfoKey = (typeof SETTING_INFO_KEYS)[number];

export interface SettingInfoCopy {
  /** The popup's heading; the trigger reads "What is <title>?". */
  title: string;
  /** What the setting does, one short paragraph each. */
  what: string[];
  /** A WhatsApp message it sends, shortened, with sample names. */
  example?: string;
  /** What each choice does: On and Off for a switch, each option for a list. */
  choices?: { name: string; text: string }[];
  /** The default for a new club. */
  newClubs: string;
  /** Who it suits. */
  suits?: string;
  /** How it works with other settings. */
  together?: string[];
}

/** The small headings inside every popup. */
const LABELS: Record<Lang, { example: string; newClubs: string; suits: string; together: string }> = {
  en: { example: "Example", newClubs: "New clubs:", suits: "Suits:", together: "Works with other settings" },
  tr: { example: "Örnek", newClubs: "Yeni kulüpler:", suits: "Kimler için:", together: "Diğer ayarlarla birlikte" },
};

const ON = { en: "On", tr: "Açık" } as const;
const OFF = { en: "Off", tr: "Kapalı" } as const;

export const SETTINGS_INFO: Record<SettingInfoKey, Record<Lang, SettingInfoCopy>> = {
  // ════ Go live ═══════════════════════════════════════════════════════
  goLive: {
    en: {
      title: "Go live",
      what: [
        "Your club is approved and MatchTime is in your WhatsApp group, but it stays silent there until an owner or admin of the club says go.",
        "Press Go live here, or send GO to MatchTime in a private WhatsApp message. MatchTime then switches on for your group and posts the hello message shown below, written from your settings at that moment. It can take a few minutes to appear.",
        "Anything MatchTime would have posted while it was waiting is dropped, so the group does not get a backlog.",
      ],
      newClubs: "Every new club waits here after it is approved.",
      suits: "Go live once the settings below look right: the hello message describes them to your players.",
      together: [
        "If MatchTime's club fee applies to your club, the free months start when you go live.",
        "If MatchTime has been removed from the group, add it back first. Going live is refused until it is in the group again.",
      ],
    },
    tr: {
      title: "Yayına al",
      what: [
        "Kulübünüz onaylandı ve MatchTime WhatsApp grubunuzda, ama kulübün sahibi ya da bir yöneticisi başla diyene kadar orada sessiz kalır.",
        "Buradaki Yayına al düğmesine basın ya da MatchTime'a özel WhatsApp mesajıyla BAŞLA yazın. MatchTime grubunuz için açılır ve aşağıda gördüğünüz karşılama mesajını, o anki ayarlarınıza göre yazarak gruba gönderir. Mesajın görünmesi birkaç dakika sürebilir.",
        "MatchTime'ın beklerken göndereceği her şey silinir, böylece grupta birikmiş mesaj çıkmaz.",
      ],
      newClubs: "Her yeni kulüp onaylandıktan sonra burada bekler.",
      suits: "Aşağıdaki ayarlar doğru görününce yayına alın: karşılama mesajı bunları oyunculara anlatır.",
      together: [
        "Kulübünüz MatchTime kulüp ücreti ödüyorsa ücretsiz aylar yayına aldığınız an başlar.",
        "MatchTime gruptan çıkarıldıysa önce onu tekrar ekleyin. Gruba dönene kadar yayına alma reddedilir.",
      ],
    },
  },

  // ════ General ═══════════════════════════════════════════════════════
  clubName: {
    en: {
      title: "Organisation name",
      what: [
        "Your club's name on MatchTime. It is shown on the website, in your admin pages and on the posters MatchTime makes.",
        "You can change it until MatchTime is added to your WhatsApp group. After that it is locked here, because MatchTime approves a club by its name.",
      ],
      newClubs: "The name typed when the club was set up.",
      together: [
        "The URL slug is made from the name when the club is created. Renaming the club does not change it.",
      ],
    },
    tr: {
      title: "Kulüp adı",
      what: [
        "Kulübünüzün MatchTime'daki adı. Web sitesinde, yönetici sayfalarınızda ve MatchTime'ın hazırladığı afişlerde görünür.",
        "MatchTime WhatsApp grubunuza eklenene kadar değiştirebilirsiniz. Sonra burada kilitlenir, çünkü MatchTime bir kulübü adıyla onaylar.",
      ],
      newClubs: "Kulüp kurulurken yazılan ad.",
      together: [
        "Web adresi (URL slug) kulüp kurulurken addan oluşturulur. Kulübün adını değiştirmek onu değiştirmez.",
      ],
    },
  },
  teamNames: {
    en: {
      title: "Team names",
      what: [
        "What the two sides are called in team sheets, score messages, match pages and the team sheet poster. Only the names change; everything else about the teams stays the same.",
        "Leave a box empty to use the default for that side. A name can be up to 24 characters, and the two names must be different.",
      ],
      newClubs: "Red and Yellow, or Kırmızı and Sarı for a Turkish club.",
      suits: "Clubs whose sides have names already, like bibs and non bibs, or Lions and Tigers.",
      together: [
        "If an admin asks MatchTime to pick names for one week's teams, those names are used for that match only.",
      ],
    },
    tr: {
      title: "Takım adları",
      what: [
        "İki tarafın takım listelerinde, skor mesajlarında, maç sayfalarında ve takım listesi afişinde görünen adı. Yalnızca adlar değişir; takımlarla ilgili geri kalan her şey aynı kalır.",
        "O taraf için varsayılan adı kullanmak için kutuyu boş bırakın. Bir ad en fazla 24 karakter olabilir ve iki ad farklı olmalıdır.",
      ],
      newClubs: "Kırmızı ve Sarı, İngilizce bir kulüp için Red ve Yellow.",
      suits: "Taraflarının zaten adı olan kulüpler, örneğin yelekliler ve yeleksizler ya da Aslanlar ve Kaplanlar.",
      together: [
        "Bir yönetici MatchTime'dan bir haftanın takımlarına ad seçmesini isterse o adlar yalnızca o maçta kullanılır.",
      ],
    },
  },
  language: {
    en: {
      title: "Bot language",
      what: [
        "The language MatchTime writes in for your club: its posts in the WhatsApp group, its private messages to players and admins, and the posters.",
        "It changes words, not times. Every time MatchTime uses is London time.",
      ],
      choices: [
        { name: "English", text: "MatchTime writes in English. Its messages ask players for IN and OUT." },
        { name: "Türkçe", text: "MatchTime writes in Turkish. Its messages ask players for VARIM and YOKUM." },
      ],
      newClubs: "The language picked when the club was set up.",
      together: [
        "If your group chat is in a different language, MatchTime may suggest changing this under Set up from your group chat. It never changes the language by itself.",
        "Some headings on this admin page are still in English whatever you choose.",
      ],
    },
    tr: {
      title: "Bot dili",
      what: [
        "MatchTime'ın kulübünüz için yazdığı dil: WhatsApp grubundaki mesajları, oyunculara ve yöneticilere özel mesajları ve afişler.",
        "Saatleri değil, kelimeleri değiştirir. MatchTime'ın kullandığı tüm saatler Londra saatidir.",
      ],
      choices: [
        { name: "English", text: "MatchTime İngilizce yazar. Mesajlarında oyunculardan IN ve OUT ister." },
        { name: "Türkçe", text: "MatchTime Türkçe yazar. Mesajlarında oyunculardan VARIM ve YOKUM ister." },
      ],
      newClubs: "Kulüp kurulurken seçilen dil.",
      together: [
        "Grup sohbetiniz başka bir dildeyse MatchTime, Grup sohbetinizden kurulum bölümünde bunu değiştirmeyi önerebilir. Dili hiçbir zaman kendisi değiştirmez.",
        "Bu yönetici sayfasındaki bazı başlıklar, ne seçerseniz seçin, şimdilik İngilizcedir.",
      ],
    },
  },

  // ════ Bot features ══════════════════════════════════════════════════
  attendance: {
    en: {
      title: "Attendance tracking",
      what: [
        "MatchTime reads IN and OUT in your WhatsApp group and keeps the squad for the next match. It announces each match, posts a squad update at 17:00, chases for players on match morning when places are still open, and makes a last call about 2 hours before kickoff.",
      ],
      example: "📅 *Tuesday 7-a-side*: *Tue 20 Oct* at Goals Sutton.\n\nSay *IN* to join. First 14 confirmed play.",
      choices: [
        { name: ON.en, text: "MatchTime keeps the squad from IN and OUT and posts the updates above." },
        {
          name: OFF.en,
          text: "MatchTime records no IN or OUT and posts no squad updates, chases or reminders. The rolling squad post, the drop-out reminder, the published list and the monthly lists are squad posts, so they stop too.",
        },
      ],
      newClubs: "On.",
      suits: "Clubs where players say IN and OUT in the group. Turn it off if your group keeps its list another way and only wants ratings or Man of the Match.",
      together: [
        "Bench management, Rolling squad, Who fills an open place and the weekly deadlines only do anything while this is on.",
        "Player ratings and Man of the Match go to the players in the match's squad. With this off, MatchTime does not fill that squad from the chat, so check how your squad gets onto the match before you turn it off.",
      ],
    },
    tr: {
      title: "Yoklama",
      what: [
        "MatchTime WhatsApp grubunuzda VARIM ve YOKUM mesajlarını okur ve bir sonraki maçın kadrosunu tutar. Her maçı duyurur, 17:00'de kadro güncellemesi paylaşır, boş yer varken maç sabahı oyuncu arar ve başlama saatinden yaklaşık 2 saat önce son çağrıyı yapar.",
      ],
      example: "📅 *Salı 7'li maç*, *Salı 20 Eki*, Goals Sutton.\n\nKatılmak için *VARIM* yazın. İlk 14 kişi oynar.",
      choices: [
        { name: ON.tr, text: "MatchTime kadroyu VARIM ve YOKUM mesajlarından tutar ve yukarıdaki güncellemeleri paylaşır." },
        {
          name: OFF.tr,
          text: "MatchTime VARIM ya da YOKUM kaydetmez; kadro güncellemesi, oyuncu arama ya da hatırlatma paylaşmaz. Kadro devam eder mesajı, son çıkış hatırlatması, yayınlanan liste ve aylık listeler de kadro mesajı olduğu için onlar da durur.",
        },
      ],
      newClubs: "Açık.",
      suits: "Oyuncuların grupta VARIM ve YOKUM dediği kulüpler. Grubunuz listeyi başka bir yolla tutuyor ve yalnızca puanlama ya da Man of the Match istiyorsa kapatın.",
      together: [
        "Yedek listesi, Kadro devam eder, Boşalan yeri kim doldurur ve haftalık son saatler yalnızca bu açıkken işe yarar.",
        "Oyuncu puanları ve Man of the Match, maçın kadrosundaki oyunculara gider. Bu kapalıyken MatchTime o kadroyu sohbetten doldurmaz, bu yüzden kapatmadan önce kadronun maça nasıl girdiğini kontrol edin.",
      ],
    },
  },
  bench: {
    en: {
      title: "Bench management",
      what: [
        "When the squad is full, anyone else who says IN goes on the bench. That happens whatever this switch says.",
        "This switch controls the bench messages. When a place opens, MatchTime tags the bench in the group and the first to say IN takes the place. Squad updates also say that the bench is open, and a new player who asks to join a full squad is invited onto the bench.",
      ],
      example: "🎟 A slot just opened for Tuesday's game. *First to claim it plays.*\n\n@Ali @Bilal\n\nJust reply *IN* here to take it.",
      choices: [
        { name: ON.en, text: "MatchTime tells the bench in the group when a place opens." },
        {
          name: OFF.en,
          text: "No bench messages in the group. The bench still fills up, and anyone who says IN while a place is free still takes it.",
        },
      ],
      newClubs: "On.",
      suits: "Clubs that often have more players than places.",
      together: [
        "Needs Attendance tracking.",
        "With The organisers pick (Who fills an open place), MatchTime does not offer the place to the bench: it asks your admins to pick.",
      ],
    },
    tr: {
      title: "Yedek listesi",
      what: [
        "Kadro dolunca VARIM diyen diğer herkes yedek listesine girer. Bu, düğme ne derse desin olur.",
        "Bu düğme yedek listesi mesajlarını yönetir. Bir yer açılınca MatchTime grupta yedekleri etiketler ve ilk VARIM diyen yeri alır. Kadro güncellemeleri de yedek listesinin açık olduğunu söyler ve dolu bir kadroya katılmak isteyen yeni oyuncu yedek listesine davet edilir.",
      ],
      example: "🎟 Bir yer açıldı: salı maçı. *İlk sahiplenen oynar.*\n\n@Ali @Bilal\n\nAlmak için buraya *VARIM* yazmanız yeterli.",
      choices: [
        { name: ON.tr, text: "Bir yer açılınca MatchTime grupta yedeklere haber verir." },
        {
          name: OFF.tr,
          text: "Grupta yedek listesi mesajı yok. Yedek listesi yine dolar ve yer boşken VARIM diyen yine yeri alır.",
        },
      ],
      newClubs: "Açık.",
      suits: "Çoğu zaman yerden fazla oyuncusu olan kulüpler.",
      together: [
        "Yoklama açık olmalıdır.",
        "Boşalan yeri kim doldurur ayarında Organizatörler seçer seçiliyse MatchTime yeri yedeklere sunmaz: yöneticilerinizden seçmelerini ister.",
      ],
    },
  },
  teamBalancing: {
    en: {
      title: "Team generation",
      what: [
        "Players and organisers can ask MatchTime in the group for the teams, for example \"@Match Time generate the teams\". It splits the squad into two even sides using club ratings and positions, and posts them.",
        "After the match it asks the group for the final score, which it uses to keep future teams balanced.",
      ],
      example: "🏁 *Tuesday 7-a-side*: hope it was a good one. What was the final score? I'll use it to keep next week's teams balanced.",
      choices: [
        { name: ON.en, text: "MatchTime makes teams when asked in the group and asks for the score after the match." },
        {
          name: OFF.en,
          text: "MatchTime ignores requests for teams in the group and does not ask for the score. The Generate teams button on a match page on the website still works.",
        },
      ],
      newClubs: "On.",
      suits: "Clubs that want fair sides without arguing about them. Turn it off if your organisers always pick the teams themselves.",
      together: [
        "Teams ready (Weekly routine) is a separate setting: it proposes teams in your admin group on match day.",
      ],
    },
    tr: {
      title: "Takım kurma",
      what: [
        "Oyuncular ve organizatörler grupta MatchTime'dan takımları isteyebilir, örneğin \"@Match Time takımları kur\". MatchTime kadroyu kulüp puanlarına ve mevkilere göre iki dengeli takıma böler ve paylaşır.",
        "Maçtan sonra gruba skoru sorar ve bunu gelecek takımları dengeli kurmak için kullanır.",
      ],
      example: "🏁 *Salı 7'li maç*, umarım iyi geçmiştir. Skor ne oldu? Gelecek haftaki takımları dengeli kurmak için kullanacağım.",
      choices: [
        { name: ON.tr, text: "MatchTime grupta istenince takım kurar ve maçtan sonra skoru sorar." },
        {
          name: OFF.tr,
          text: "MatchTime gruptaki takım isteklerine cevap vermez ve skoru sormaz. Web sitesindeki maç sayfasında Generate teams düğmesi yine çalışır.",
        },
      ],
      newClubs: "Açık.",
      suits: "Tartışmasız, dengeli takımlar isteyen kulüpler. Takımları hep organizatörler seçiyorsa kapatın.",
      together: [
        "Takımlar hazır (Haftalık düzen) ayrı bir ayardır: maç günü yönetici grubunuzda takım önerir.",
      ],
    },
  },
  momVoting: {
    en: {
      title: "Man of the Match",
      what: [
        "Players vote for Man of the Match on the rating page MatchTime sends them after each match. This switch decides whether MatchTime announces the winner in the group.",
        "The result is posted once everyone who played has voted or rated, between 09:00 and 21:00. If some players never rate, it is posted 5 days after the match, from 15:00. With no votes there is no post.",
      ],
      example: "🏆 *Man of the Match: Tuesday 7-a-side*\nCongrats *Sam* (5/9 votes) 🎉",
      choices: [
        { name: ON.en, text: "MatchTime posts the winner and the vote count in the group." },
        { name: OFF.en, text: "No winner is posted in the group. Players can still vote on the rating page, and the votes still count in stats and badges." },
      ],
      newClubs: "On.",
      suits: "Clubs that enjoy a bit of weekly glory.",
      together: [
        "The vote is on the rating page, so it needs Player ratings on: with ratings off nobody gets the link and there is nothing to announce.",
        "With this off, Man of the Match badges are still announced, but only once the match is more than 9 days old.",
      ],
    },
    tr: {
      title: "Maçın adamı",
      what: [
        "Oyuncular Man of the Match oyunu, MatchTime'ın her maçtan sonra gönderdiği puanlama sayfasında verir. Bu düğme MatchTime'ın kazananı grupta duyurup duyurmayacağını belirler.",
        "Sonuç, oynayan herkes oy ya da puan verince 09:00 ile 21:00 arasında paylaşılır. Bazı oyuncular hiç puan vermezse maçtan 5 gün sonra, 15:00'ten itibaren paylaşılır. Oy yoksa paylaşım da yoktur.",
      ],
      example: "🏆 *Man of the Match, Salı 7'li maç*\nTebrikler *Sam* (5/9 oy) 🎉",
      choices: [
        { name: ON.tr, text: "MatchTime kazananı ve oy sayısını grupta paylaşır." },
        { name: OFF.tr, text: "Grupta kazanan paylaşılmaz. Oyuncular puanlama sayfasında yine oy verebilir ve oylar istatistiklerde ve rozetlerde yine sayılır." },
      ],
      newClubs: "Açık.",
      suits: "Her hafta biraz şan şöhret seven kulüpler.",
      together: [
        "Oylama puanlama sayfasında olduğu için Oyuncu puanları açık olmalıdır: puanlar kapalıyken kimseye bağlantı gitmez ve duyurulacak bir şey olmaz.",
        "Bu kapalıyken Man of the Match rozetleri yine duyurulur, ama ancak maçın üzerinden 9 gün geçince.",
      ],
    },
  },
  playerRating: {
    en: {
      title: "Player ratings",
      what: [
        "The morning after each match (from 08:00), MatchTime sends every player who played, and has a phone number, a private link to rate their teammates and vote for Man of the Match. It then tells the group the links are out.",
        "Players who haven't rated get a reminder at 18:00 for the next few days. The ratings make up each player's club rating, which MatchTime uses to balance the teams.",
      ],
      example: "🏆 *Tuesday 7-a-side*, Tue 20 Oct\n\nRate your teammates and pick Man of the Match. Takes about a minute.\n\nYour personal link: …",
      choices: [
        { name: ON.en, text: "Rating links, reminders and the group note are sent after each match." },
        { name: OFF.en, text: "No rating links. Club ratings stop changing, and nobody gets the Man of the Match vote." },
      ],
      newClubs: "On.",
      suits: "Most clubs. It is what keeps the teams fair over time.",
      together: [
        "Man of the Match is voted in the same link, so it needs this on.",
        "The badge post tells players to find their stats link in the rating message, so with this off that link never arrives.",
        "Players without a phone number on MatchTime get no link.",
        "With the organisers announcing the list, the note that the links are out goes to your admin messages instead of the players' group. Players still get their links.",
      ],
    },
    tr: {
      title: "Oyuncu puanları",
      what: [
        "Her maçtan sonraki sabah (08:00'den itibaren) MatchTime, oynayan ve telefon numarası olan her oyuncuya takım arkadaşlarına puan vermesi ve Man of the Match oyu vermesi için özel bir bağlantı gönderir. Sonra gruba bağlantıların gönderildiğini söyler.",
        "Puan vermeyenlere sonraki birkaç gün 18:00'de hatırlatma gider. Puanlar her oyuncunun kulüp puanını oluşturur ve MatchTime takımları dengelemek için bunu kullanır.",
      ],
      example: "🏆 *Salı 7'li maç*, Salı 20 Eki\n\nTakım arkadaşlarına puan ver ve Man of the Match'i seç. Yaklaşık bir dakika sürer.\n\nKişisel bağlantın: …",
      choices: [
        { name: ON.tr, text: "Her maçtan sonra puanlama bağlantıları, hatırlatmalar ve grup notu gönderilir." },
        { name: OFF.tr, text: "Puanlama bağlantısı gitmez. Kulüp puanları değişmez ve kimse Man of the Match oyu veremez." },
      ],
      newClubs: "Açık.",
      suits: "Çoğu kulüp. Takımları zaman içinde dengeli tutan budur.",
      together: [
        "Man of the Match oyu aynı bağlantıda verilir, bu yüzden bunun açık olması gerekir.",
        "Rozet mesajı oyunculara istatistik bağlantısını puanlama mesajında bulmalarını söyler; bu kapalıyken o bağlantı hiç gelmez.",
        "MatchTime'da telefon numarası olmayan oyunculara bağlantı gitmez.",
        "Listeyi organizatörler duyuruyorsa bağlantıların gönderildiği notu oyuncu grubu yerine yönetici mesajlarınıza gider. Oyuncular bağlantılarını yine alır.",
      ],
    },
  },
  reminders: {
    en: {
      title: "Personal reminders",
      what: [
        "A player can tag MatchTime in the group and ask for a reminder, for example \"@Match Time remind me Monday\". MatchTime replies to confirm and sends them a private message at that time.",
      ],
      example: "👍 Got it, I'll DM you on Monday.",
      choices: [
        { name: ON.en, text: "MatchTime takes reminder requests that tag it." },
        { name: OFF.en, text: "Reminder requests get no reply and no reminder is sent. MatchTime's own match reminders are not affected." },
      ],
      newClubs: "On.",
      suits: "Any club. It costs nothing when nobody uses it.",
      together: ["The player needs a phone number on MatchTime to get the private message."],
    },
    tr: {
      title: "Hatırlatmalar",
      what: [
        "Bir oyuncu grupta MatchTime'ı etiketleyip hatırlatma isteyebilir, örneğin \"@Match Time pazartesi bana hatırlat\". MatchTime onaylayan bir cevap yazar ve o zaman oyuncuya özel mesaj gönderir.",
      ],
      example: "👍 Tamam, pazartesi sana DM atarım.",
      choices: [
        { name: ON.tr, text: "MatchTime kendisini etiketleyen hatırlatma isteklerini alır." },
        { name: OFF.tr, text: "Hatırlatma isteklerine cevap verilmez ve hatırlatma gönderilmez. MatchTime'ın kendi maç hatırlatmaları etkilenmez." },
      ],
      newClubs: "Açık.",
      suits: "Her kulüp. Kimse kullanmazsa hiçbir şey değişmez.",
      together: ["Özel mesajı alabilmek için oyuncunun MatchTime'da telefon numarası olmalıdır."],
    },
  },
  statsQa: {
    en: {
      title: "Stats answers",
      what: [
        "Players can tag MatchTime in the group with questions about the club's history, for example who has played the most, who won last week or past Man of the Match winners, and it answers in the group.",
      ],
      choices: [
        { name: ON.en, text: "MatchTime answers history questions that tag it." },
        { name: OFF.en, text: "Those questions get no answer. Each player's own stats page, linked from the rating message, still works." },
      ],
      newClubs: "On.",
      suits: "Clubs that like a bit of banter about records.",
    },
    tr: {
      title: "İstatistik cevapları",
      what: [
        "Oyuncular grupta MatchTime'ı etiketleyip kulübün geçmişi hakkında soru sorabilir, örneğin en çok kim oynadı, geçen hafta kim kazandı ya da geçmiş Man of the Match kazananları, ve MatchTime grupta cevaplar.",
      ],
      choices: [
        { name: ON.tr, text: "MatchTime kendisini etiketleyen geçmiş sorularını cevaplar." },
        { name: OFF.tr, text: "Bu sorulara cevap verilmez. Puanlama mesajındaki bağlantıyla açılan kişisel istatistik sayfası yine çalışır." },
      ],
      newClubs: "Açık.",
      suits: "Rekorlar üzerine biraz şakalaşmayı seven kulüpler.",
    },
  },
  paymentCollection: {
    en: {
      title: "Collect match fees",
      what: [
        "After each match MatchTime asks the money collector how much each player owes, then sends every player who played a private link to pay. Players who still owe get a reminder around 18:00 each day, for up to 6 days after the match.",
        "Players pay with the methods you leave on below. Card and Pay by Bank payments go to the money collector's own bank through Stripe.",
      ],
      example: "💷 Elvin, how much should each player pay for *Tuesday 7s* (12 played)?\n\nJust reply with the amount, e.g. \"£8 each\" or \"£80 total to split\". I'll confirm, then send everyone their pay link.",
      choices: [
        { name: ON.en, text: "The fee question, the pay links and the reminders run after every match. Once a bank is connected, MatchTime tells the group once that match fees now go through MatchTime." },
        { name: OFF.en, text: "No fee question, no pay links and no payment reminders." },
      ],
      newClubs: "Off.",
      suits: "Clubs where one person pays for the pitch and wants the money back without chasing anyone.",
      together: [
        "Choose a money collector (it appears below once this is on). Without one, MatchTime has nobody to ask for the fee.",
        "Connect the money collector's bank for card and Pay by Bank. Without it, the pay page only offers paying the organiser directly, if that is on.",
        "The money collector and monthly regulars are not sent pay links.",
      ],
    },
    tr: {
      title: "Maç ücreti toplama",
      what: [
        "Her maçtan sonra MatchTime para toplayan kişiye her oyuncunun ne kadar ödeyeceğini sorar, sonra oynayan her oyuncuya ödeme için özel bir bağlantı gönderir. Hâlâ borcu olanlara maçtan sonra 6 güne kadar her gün 18:00 civarında hatırlatma gider.",
        "Oyuncular aşağıda açık bıraktığınız yöntemlerle öder. Kartla ve bankadan yapılan ödemeler Stripe üzerinden para toplayan kişinin kendi bankasına gider.",
      ],
      example: "💷 Elvin, *Salı 7'li maç* için her oyuncu ne kadar ödemeli (12 kişi oynadı)?\n\nTutarı yazman yeterli, örneğin \"kişi başı £8\" ya da \"toplam £80, bölüşülsün\". Onaylarım, sonra herkese ödeme bağlantısını gönderirim.",
      choices: [
        { name: ON.tr, text: "Ücret sorusu, ödeme bağlantıları ve hatırlatmalar her maçtan sonra çalışır. Banka bağlanınca MatchTime gruba bir kez maç ücretlerinin artık MatchTime üzerinden alındığını söyler." },
        { name: OFF.tr, text: "Ücret sorusu, ödeme bağlantısı ve ödeme hatırlatması yok." },
      ],
      newClubs: "Kapalı.",
      suits: "Sahanın parasını bir kişinin ödediği ve kimseyi kovalamadan parasını geri almak istediği kulüpler.",
      together: [
        "Bir para toplayan kişi seçin (bu açılınca aşağıda görünür). Seçilmezse MatchTime'ın ücreti soracağı kimse olmaz.",
        "Kart ve bankadan ödeme için para toplayan kişinin bankasını bağlayın. Bağlanmazsa ödeme sayfası, açıksa, yalnızca organizatöre doğrudan ödemeyi sunar.",
        "Para toplayan kişiye ve aylık daimi oyunculara ödeme bağlantısı gönderilmez.",
      ],
    },
  },
  payByBank: {
    en: {
      title: "Pay by Bank",
      what: [
        "Players pay straight from their banking app, through Stripe. It is the cheapest way to pay by link.",
        "Fees are added on top so the money collector gets the full amount: on a £10 fee the player pays £10.36. That covers Stripe's fee and MatchTime's 1% service fee.",
      ],
      choices: [
        { name: ON.en, text: "Offered on the pay page once the money collector's bank is connected." },
        { name: OFF.en, text: "Not offered." },
      ],
      newClubs: "On.",
      together: [
        "Only used with Collect match fees on and the money collector's bank connected.",
        "MatchTime does not stop you turning all three payment methods off. Keep at least one on, or the pay page has nothing to offer.",
      ],
    },
    tr: {
      title: "Banka ile ödeme",
      what: [
        "Oyuncular Stripe üzerinden doğrudan banka uygulamalarından öder. Bağlantıyla ödemenin en ucuz yoludur.",
        "Para toplayan kişinin tam tutarı alması için ücretler üstüne eklenir: £10'luk bir ücrette oyuncu £10.36 öder. Bu, Stripe'ın ücretini ve MatchTime'ın %1 hizmet ücretini karşılar.",
      ],
      choices: [
        { name: ON.tr, text: "Para toplayan kişinin bankası bağlanınca ödeme sayfasında sunulur." },
        { name: OFF.tr, text: "Sunulmaz." },
      ],
      newClubs: "Açık.",
      together: [
        "Yalnızca Maç ücreti toplama açıkken ve para toplayan kişinin bankası bağlıyken kullanılır.",
        "MatchTime üç ödeme yöntemini birden kapatmanızı engellemez. En az birini açık tutun, yoksa ödeme sayfası hiçbir yöntem sunamaz.",
      ],
    },
  },
  payCard: {
    en: {
      title: "Card and Apple Pay",
      what: [
        "Players pay by card, Apple Pay or Google Pay, through Stripe.",
        "Fees are added on top so the money collector gets the full amount: on a £10 fee the player pays £10.46. That covers Stripe's fee and MatchTime's 1% service fee.",
      ],
      choices: [
        { name: ON.en, text: "Offered on the pay page once the money collector's bank is connected." },
        { name: OFF.en, text: "Not offered." },
      ],
      newClubs: "On.",
      suits: "Most clubs: nearly every player can pay this way.",
      together: [
        "Only used with Collect match fees on and the money collector's bank connected.",
        "Keep at least one of the three payment methods on.",
      ],
    },
    tr: {
      title: "Kart ile ödeme",
      what: [
        "Oyuncular Stripe üzerinden kart, Apple Pay ya da Google Pay ile öder.",
        "Para toplayan kişinin tam tutarı alması için ücretler üstüne eklenir: £10'luk bir ücrette oyuncu £10.46 öder. Bu, Stripe'ın ücretini ve MatchTime'ın %1 hizmet ücretini karşılar.",
      ],
      choices: [
        { name: ON.tr, text: "Para toplayan kişinin bankası bağlanınca ödeme sayfasında sunulur." },
        { name: OFF.tr, text: "Sunulmaz." },
      ],
      newClubs: "Açık.",
      suits: "Çoğu kulüp: neredeyse her oyuncu bu yolla ödeyebilir.",
      together: [
        "Yalnızca Maç ücreti toplama açıkken ve para toplayan kişinin bankası bağlıyken kullanılır.",
        "Üç ödeme yönteminden en az birini açık tutun.",
      ],
    },
  },
  payDirect: {
    en: {
      title: "Pay organiser directly",
      what: [
        "Players can choose to pay the money collector in cash or by bank transfer instead. MatchTime tells the money collector, who marks it as paid once the money arrives. There is no fee.",
      ],
      choices: [
        { name: ON.en, text: "Offered on the pay page, with or without a connected bank." },
        { name: OFF.en, text: "Not offered. Players can only pay by link." },
      ],
      newClubs: "On.",
      suits: "Clubs where some players still prefer cash.",
      together: [
        "Only used with Collect match fees on.",
        "Keep at least one of the three payment methods on.",
      ],
    },
    tr: {
      title: "Organizatöre ödeme",
      what: [
        "Oyuncular bunun yerine para toplayan kişiye nakit ya da havaleyle ödemeyi seçebilir. MatchTime para toplayan kişiye haber verir; para gelince o ödendi olarak işaretler. Ücret alınmaz.",
      ],
      choices: [
        { name: ON.tr, text: "Banka bağlı olsun ya da olmasın ödeme sayfasında sunulur." },
        { name: OFF.tr, text: "Sunulmaz. Oyuncular yalnızca bağlantıyla öder." },
      ],
      newClubs: "Açık.",
      suits: "Bazı oyuncuların hâlâ nakit tercih ettiği kulüpler.",
      together: [
        "Yalnızca Maç ücreti toplama açıkken kullanılır.",
        "Üç ödeme yönteminden en az birini açık tutun.",
      ],
    },
  },
  badgeAnnouncements: {
    en: {
      title: "Badge announcements",
      what: [
        "At 18:00 on the second day after each match, MatchTime posts the new badges players earned in the group: On the board (first game), Regular, Man of the Match, MoM Machine, Masterclass and Mr Reliable. Each badge is announced once per player.",
        "Badges for a first game go out at once. Badges that depend on ratings or Man of the Match wait until that result is final.",
      ],
      example: "🏅 *New badges this week*\n👟 On the board: Ali\n\nWell played all! 👏",
      choices: [
        { name: ON.en, text: "The badge post goes in the group after each match with new badges." },
        { name: OFF.en, text: "Nothing about badges is posted in the group. Players still see their badges on their stats page." },
      ],
      newClubs: "On. A club's first post never repeats badges players already held.",
      suits: "Clubs that like to celebrate milestones.",
      together: [
        "With Man of the Match off, its badges are announced only once the match is more than 9 days old.",
        "The post points players to the stats link in their rating message, which needs Player ratings on.",
        "The badge post goes in the players' group whoever announces the list.",
      ],
    },
    tr: {
      title: "Rozet duyuruları",
      what: [
        "Her maçtan sonraki ikinci gün saat 18:00'de MatchTime oyuncuların kazandığı yeni rozetleri grupta paylaşır: ilk maç, Regular, Man of the Match, MoM Machine, Masterclass ve Mr Reliable. Her rozet her oyuncu için bir kez duyurulur.",
        "İlk maç rozetleri hemen paylaşılır. Puanlara ya da Man of the Match'e bağlı rozetler o sonuç kesinleşene kadar bekler.",
      ],
      example: "🏅 *Bu haftanın yeni rozetleri*\n👟 İlk maç: Ali\n\nHepinizin eline sağlık! 👏",
      choices: [
        { name: ON.tr, text: "Yeni rozet olan her maçtan sonra grupta rozet mesajı paylaşılır." },
        { name: OFF.tr, text: "Grupta rozetlerle ilgili hiçbir şey paylaşılmaz. Oyuncular rozetlerini istatistik sayfalarında yine görür." },
      ],
      newClubs: "Açık. Kulübün ilk paylaşımı oyuncuların zaten sahip olduğu rozetleri tekrarlamaz.",
      suits: "Başarıları kutlamayı seven kulüpler.",
      together: [
        "Man of the Match kapalıyken onun rozetleri ancak maçın üzerinden 9 günden fazla geçince duyurulur.",
        "Mesaj oyuncuları puanlama mesajındaki istatistik bağlantısına yönlendirir; bunun için Oyuncu puanları açık olmalıdır.",
        "Rozet mesajı, listeyi kim duyurursa duyursun oyuncu grubunda paylaşılır.",
      ],
    },
  },

  gearReminder: {
    en: {
      title: "Match-day kit reminder",
      what: [
        "Between 90 minutes and 2 hours before each football kickoff, MatchTime posts once in the players' group: the kickoff time and place, and a reminder to bring goalie gloves, a ball and spare bibs.",
        "It is posted in the players' group whoever announces the list. Matches of other sports never get it.",
      ],
      example: "⚽ *20:00 at Goals Sutton*, see you there!\n\nQuick reminder: if you've got them, please bring your *goalie gloves*, a *ball*, and *spare bibs*.",
      choices: [
        { name: ON.en, text: "The reminder is posted before every football match." },
        { name: OFF.en, text: "The reminder is not sent anywhere." },
      ],
      newClubs: "Off. Clubs that were on MatchTime before 15 October 2026 had it switched on, so nothing changed for them.",
      suits: "Clubs where players take turns bringing the kit.",
      together: ["It is a squad post, so it needs Attendance tracking on."],
    },
    tr: {
      title: "Maç günü malzeme hatırlatması",
      what: [
        "Her futbol maçının başlama saatinden 90 dakika ile 2 saat önce MatchTime oyuncu grubuna bir kez yazar: maçın saati ve yeri, ve kaleci eldiveni, top ve yedek yelek getirme hatırlatması.",
        "Listeyi kim duyurursa duyursun oyuncu grubunda paylaşılır. Başka sporların maçlarında gönderilmez.",
      ],
      example: "⚽ *20:00, Goals Sutton*, orada görüşürüz!\n\nKüçük bir hatırlatma: varsa *kaleci eldiveni*, *top* ve *yedek yelek* getirin.",
      choices: [
        { name: ON.tr, text: "Hatırlatma her futbol maçından önce paylaşılır." },
        { name: OFF.tr, text: "Hatırlatma hiçbir yere gönderilmez." },
      ],
      newClubs: "Kapalı. 15 Ekim 2026'dan önce MatchTime'da olan kulüplerde açıldı, böylece onlar için hiçbir şey değişmedi.",
      suits: "Malzemeyi oyuncuların sırayla getirdiği kulüpler.",
      together: ["Bir kadro mesajı olduğu için Yoklama açık olmalıdır."],
    },
  },

  // ════ Weekly routine ════════════════════════════════════════════════
  rollingSquad: {
    en: {
      title: "Rolling squad",
      what: [
        "Everyone who played the last match is put in the squad for the next one automatically. They only need to say OUT if they can't make it.",
        "The squad is carried over at 08:00 after the match ends, so after an evening match there is the evening to take off anyone who didn't turn up. Bench players, guests an admin never added and anyone who has left the group are not carried. If more are carried than there are places, the rest go on the bench.",
        "On a morning more than a day before kickoff, MatchTime tells the group last week's players are in again. It sends this instead of the usual Say IN announcement.",
      ],
      example: "📅 *Tuesday 7-a-side*, *Tue 20 Oct*, Goals Sutton.\n\nEveryone who played last time is in again. Drop-out deadline: *Mon 21:00*. Until then, you're in unless you say *OUT*.",
      choices: [
        { name: ON.en, text: "Last match's players start each week in the squad." },
        { name: OFF.en, text: "Each week starts empty and players say IN." },
      ],
      newClubs: "Off. If your group chat clearly shows the same squad every week, MatchTime may switch it on when your club starts; it tells you, and you can undo it.",
      suits: "Groups where the same players play most weeks.",
      together: [
        "Needs Attendance tracking.",
        "With a Drop-out deadline set, an OUT after it still counts, and your admins are told it was late.",
        "Hidden while your squad is monthly: the month's regulars take its place.",
        "With the organisers announcing the list, the carried squad goes to your admin messages instead of the group.",
      ],
    },
    tr: {
      title: "Kadro devam eder",
      what: [
        "Son maçta oynayan herkes bir sonraki maçın kadrosuna otomatik olarak girer. Gelemeyecekse yalnızca YOKUM yazması yeterli.",
        "Kadro maç bittikten sonraki ilk 08:00'de aktarılır; akşam maçından sonra gelmeyenleri listeden çıkarmak için o akşam vardır. Yedekler, bir yöneticinin hiç eklemediği misafirler ve gruptan ayrılanlar aktarılmaz. Yerden fazla kişi aktarılırsa fazlası yedek listesine girer.",
        "Başlama saatinden bir günden fazla önceki bir sabah MatchTime gruba geçen haftanın oyuncularının yine kadroda olduğunu yazar. Bunu her zamanki Katılmak için VARIM yazın duyurusunun yerine gönderir.",
      ],
      example: "📅 *Salı 7'li maç*, *Salı 20 Eki*, Goals Sutton.\n\nGeçen maçta oynayan herkes yine kadroda. Son çıkış: *Pzt 21:00*. O saate kadar *YOKUM* yazmazsanız kadrodasınız.",
      choices: [
        { name: ON.tr, text: "Son maçın oyuncuları her hafta kadroda başlar." },
        { name: OFF.tr, text: "Her hafta boş başlar ve oyuncular VARIM der." },
      ],
      newClubs: "Kapalı. Grup sohbetiniz her hafta aynı kadroyu açıkça gösteriyorsa MatchTime kulübünüz başlarken bunu açabilir; size haber verir ve geri alabilirsiniz.",
      suits: "Çoğu hafta aynı oyuncuların oynadığı gruplar.",
      together: [
        "Yoklama açık olmalıdır.",
        "Son çıkış saati ayarlıysa ondan sonraki YOKUM yine geçerlidir ve yöneticilerinize geç olduğu bildirilir.",
        "Kadronuz aylıkken gizlenir: onun yerini ayın daimi oyuncuları alır.",
        "Listeyi organizatörler duyuruyorsa aktarılan kadro grup yerine yönetici mesajlarınıza gider.",
      ],
    },
  },
  benchPickMode: {
    en: {
      title: "Who fills an open place",
      what: ["Decides who gets a place when one opens in a full squad, for example when a player says OUT."],
      choices: [
        { name: "First to say IN", text: "MatchTime offers the place to the bench and the first player to say IN takes it." },
        {
          name: "The organisers pick",
          text: "MatchTime never fills a place by itself. Anyone who says IN goes on the bench. Your admin messages list the bench with positions and club ratings, and the first admin to reply with a number, a name or an @tag brings that player in. MatchTime then lets the player know by private message.",
        },
      ],
      example: "Bench:\n1. Ali (midfield, 6.8)\n2. Bilal (new)\nReply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open.",
      newClubs: "First to say IN. MatchTime never switches this from your group chat; it can only suggest it.",
      suits: "The organisers pick suits clubs where the organisers choose who plays, to keep the sides fair or to give regulars first call.",
      together: [
        "Admin messages go to decides where the bench list is sent.",
        "If nobody picks in time appears once the organisers pick.",
        "With a Drop-out deadline set, MatchTime asks your admins to pick only after the deadline. It asks between 09:00 and 23:00.",
      ],
    },
    tr: {
      title: "Boşalan yeri kim doldurur",
      what: ["Dolu bir kadroda bir yer açıldığında, örneğin bir oyuncu YOKUM dediğinde, yeri kimin alacağını belirler."],
      choices: [
        { name: "İlk VARIM diyen", text: "MatchTime yeri yedek listesine sunar ve ilk VARIM diyen oyuncu alır." },
        {
          name: "Organizatörler seçer",
          text: "MatchTime hiçbir yeri kendisi doldurmaz. VARIM diyen herkes yedek listesine girer. Yönetici mesajlarınız yedek listesini mevkiler ve kulüp puanlarıyla gösterir; numara, isim ya da @etiketle ilk yanıt veren yöneticinin seçtiği oyuncu kadroya girer. MatchTime sonra oyuncuya özel mesajla haber verir.",
        },
      ],
      example: "Yedekler:\n1. Ali (orta saha, 6.8)\n2. Bilal (yeni)\nBuraya numara, isim ya da @etiket yazın, örneğin *2*, iki kişi için *2 3*. *HİÇBİRİ* yazarsanız yer boş kalır.",
      newClubs: "İlk VARIM diyen. MatchTime bunu grup sohbetinize bakarak hiçbir zaman değiştirmez; yalnızca önerebilir.",
      suits: "Organizatörler seçer; takımları dengeli tutmak ya da daimi oyunculara öncelik vermek için kimin oynayacağını organizatörlerin seçtiği kulüplere uygundur.",
      together: [
        "Yedek listesinin nereye gideceğini Yönetici mesajları ayarı belirler.",
        "Organizatörler seçince Zamanında kimse seçmezse ayarı görünür.",
        "Son çıkış saati ayarlıysa MatchTime yöneticilerinizden ancak o saatten sonra seçim ister. Seçimi 09:00 ile 23:00 arasında ister.",
      ],
    },
  },
  benchPickFallback: {
    en: {
      title: "If nobody picks in time",
      what: [
        "Only used when the organisers pick. If no admin picks a player in time, this decides what happens to the open place.",
        "In time means within a day of MatchTime asking, and no later than 4 hours before kickoff. Your admins always get at least an hour.",
      ],
      choices: [
        { name: "Offer it to the bench", text: "MatchTime offers the place to the whole bench, the first to say IN gets it, and your admins are told." },
        { name: "Leave it open", text: "The place stays empty and your admins are told. An admin can still fill it from the match page." },
      ],
      example: "Nobody picked for *Tuesday 7-a-side*, so I've offered the place to the bench: the first to say IN gets it.",
      newClubs: "Offer it to the bench.",
      suits: "Leave it open suits clubs that would rather play a player short than let the bench decide.",
    },
    tr: {
      title: "Zamanında kimse seçmezse",
      what: [
        "Yalnızca organizatörler seçerken kullanılır. Hiçbir yönetici zamanında oyuncu seçmezse boş yere ne olacağını belirler.",
        "Zamanında, MatchTime sorduktan sonra bir gün içinde ve en geç başlama saatinden 4 saat önce demektir. Yöneticilerinize her zaman en az bir saat verilir.",
      ],
      choices: [
        { name: "Yedek listesine sun", text: "MatchTime yeri tüm yedek listesine sunar, ilk VARIM diyen alır ve yöneticilerinize haber verilir." },
        { name: "Boş bırak", text: "Yer boş kalır ve yöneticilerinize haber verilir. Bir yönetici yine de maç sayfasından doldurabilir." },
      ],
      example: "*Salı 7'li maç* için kimse seçim yapmadı, bu yüzden yeri yedek listesine açtım: ilk VARIM diyen alır.",
      newClubs: "Yedek listesine sun.",
      suits: "Boş bırak; yedeklerin karar vermesindense bir kişi eksik oynamayı tercih eden kulüplere uygundur.",
    },
  },
  listAnnouncer: {
    en: {
      title: "Who announces the list and teams",
      what: ["Decides who posts the squad list and the teams in the players' group."],
      choices: [
        { name: "MatchTime", text: "MatchTime posts the squad updates, the final list and the teams in the players' group." },
        {
          name: "The organisers",
          text: "MatchTime still reads IN and OUT in the players' group and ticks each message, but never posts the list or the teams there. Its squad updates, reminders and the final list go to your admin messages instead, for you to post. A player who asks who is playing is told the organisers will post the list.",
        },
      ],
      example: "📋 *Squad for Tuesday 7-a-side, Tue 20 Oct at 20:00*: 12 of 14 in, 2 spaces.\nMatchTime has not posted this in the players' group: you announce the list and the teams.",
      newClubs: "MatchTime.",
      suits: "The organisers suits clubs where the organisers like to post the list themselves, in their own words.",
      together: [
        "The squad updates go wherever Admin messages go to points. An admin WhatsApp group works best: MatchTime can then also send the list poster and the team sheet pictures there.",
        "With an admin group linked, Teams ready proposes teams at 10:00 on match day unless you change it.",
        "When your admins approve teams with YES, MatchTime does not post them in the players' group.",
      ],
    },
    tr: {
      title: "Listeyi ve takımları kim duyurur",
      what: ["Kadro listesini ve takımları oyuncu grubunda kimin paylaşacağını belirler."],
      choices: [
        { name: "MatchTime paylaşır", text: "MatchTime kadro güncellemelerini, son listeyi ve takımları oyuncu grubunda paylaşır." },
        {
          name: "Organizatörler paylaşır",
          text: "MatchTime oyuncu grubundaki VARIM ve YOKUM mesajlarını yine okur ve her mesaja tik koyar, ama listeyi ya da takımları orada hiç paylaşmaz. Kadro güncellemeleri, hatırlatmalar ve son liste sizin paylaşmanız için yönetici mesajlarınıza gider. Kimin oynadığını soran oyuncuya listeyi organizatörlerin paylaşacağı söylenir.",
        },
      ],
      example: "📋 *Salı 7'li maç kadrosu, Salı 20 Eki 20:00*: 14 kişilik kadroda 12 kişi var, 2 yer boş.\nMatchTime bunu oyuncu grubuna göndermedi: listeyi ve takımları siz duyuruyorsunuz.",
      newClubs: "MatchTime.",
      suits: "Organizatörler paylaşır; listeyi kendi cümleleriyle paylaşmayı seven organizatörleri olan kulüplere uygundur.",
      together: [
        "Kadro güncellemeleri Yönetici mesajları ayarının gösterdiği yere gider. En iyisi yönetici WhatsApp grubudur: MatchTime oraya kadro afişini ve takım listesi resmini de gönderebilir.",
        "Yönetici grubu bağlıysa Takımlar hazır, siz değiştirmedikçe maç günü 10:00'da takım önerir.",
        "Yöneticileriniz takımları EVET ile onaylayınca MatchTime bunları oyuncu grubunda paylaşmaz.",
      ],
    },
  },
  dropOutDeadline: {
    en: {
      title: "Drop-out deadline",
      what: [
        "The last day and time players can pull out of the week's match without it counting as late. Pick a weekday and a time; MatchTime uses the last one before each kickoff.",
        "About 3 hours before the deadline (not before 09:00), MatchTime reminds the group with the squad. After the deadline it sends your admins a summary of who is out and who is waiting.",
      ],
      example: "⏰ *Tuesday 7-a-side*, Mon: the drop-out deadline is *today at 21:00*. If you can't play, say *OUT* before then.",
      choices: [
        { name: "Set", text: "The reminder and the admin summary run each week." },
        { name: "Not set", text: "No reminder and no summary. Players can say OUT at any time." },
      ],
      newClubs: "Not set.",
      suits: "Clubs that want players to commit early, so the organisers know the squad a day or two before.",
      together: [
        "With Rolling squad on, an OUT after the deadline still counts and your admins are told it was late. Without Rolling squad nothing is marked late.",
        "With The organisers pick, MatchTime asks your admins to pick only after the deadline.",
        "With the organisers announcing the list, the reminder goes to your admin messages instead of the group.",
        "Set this and List published, and MatchTime stops its daily 17:00 post, except on match day.",
        "The time must be between 09:00 and 22:30, before List published, and before kickoff when it falls on match day. Monthly squads don't use it.",
      ],
    },
    tr: {
      title: "Son çıkış saati",
      what: [
        "Oyuncuların haftanın maçından geç sayılmadan çıkabileceği son gün ve saat. Bir gün ve saat seçin; MatchTime her maçtan önceki son denk gelen zamanı kullanır.",
        "Son çıkış saatinden yaklaşık 3 saat önce (09:00'dan önce değil) MatchTime kadroyla birlikte gruba hatırlatır. Saat geçince yöneticilerinize kimin çıktığını ve kimin beklediğini özetler.",
      ],
      example: "⏰ *Salı 7'li maç*, Pzt: son çıkış saati *bugün 21:00*. Oynayamayacaksanız o saatten önce *YOKUM* yazın.",
      choices: [
        { name: "Ayarlı", text: "Hatırlatma ve yönetici özeti her hafta çalışır." },
        { name: "Ayarlı değil", text: "Hatırlatma ve özet yok. Oyuncular istedikleri zaman YOKUM diyebilir." },
      ],
      newClubs: "Ayarlı değil.",
      suits: "Organizatörlerin kadroyu bir iki gün önceden bilmesi için oyuncuların erken karar vermesini isteyen kulüpler.",
      together: [
        "Kadro devam eder açıkken son çıkış saatinden sonraki YOKUM yine geçerlidir ve yöneticilerinize geç olduğu bildirilir. Kadro devam eder kapalıyken hiçbir şey geç sayılmaz.",
        "Organizatörler seçer ayarlıysa MatchTime yöneticilerinizden ancak bu saatten sonra seçim ister.",
        "Listeyi organizatörler duyuruyorsa hatırlatma grup yerine yönetici mesajlarınıza gider.",
        "Bunu ve Liste yayınını ayarlarsanız MatchTime her gün 17:00'de gönderdiği mesajı maç günü dışında durdurur.",
        "Saat 09:00 ile 22:30 arasında, Liste yayınından önce ve maç gününe denk geliyorsa başlama saatinden önce olmalıdır. Aylık kadrolar bunu kullanmaz.",
      ],
    },
  },
  listPublish: {
    en: {
      title: "List published",
      what: [
        "When MatchTime posts the final list for the match in the group: who is playing, who is on the bench and how many places are open. Pick a weekday and a time; MatchTime uses the last one before each kickoff.",
        "It is posted once per match, and not at all if the teams are already out.",
      ],
      example: "📋 *Tuesday 7-a-side* list, *Tue 20 Oct*, Goals Sutton\n1. Ali\n2. Sam\n…\nCan't make it now? Say *OUT* as soon as you can so a replacement can be brought in.",
      choices: [
        { name: "Set", text: "The final list is posted at that time each week." },
        { name: "Not set", text: "No final list post. MatchTime keeps its usual squad updates." },
      ],
      newClubs: "Not set.",
      suits: "Clubs that announce the squad at a fixed time each week.",
      together: [
        "Set this and a Drop-out deadline, and MatchTime stops its daily 17:00 post, except on match day.",
        "With the organisers announcing the list, the final list goes to your admin messages, and with an admin group linked MatchTime also sends the list poster there.",
        "It must be after the Drop-out deadline, between 09:00 and 22:30. Monthly squads don't use it.",
      ],
    },
    tr: {
      title: "Liste yayını",
      what: [
        "MatchTime'ın maçın son listesini gruba gönderdiği zaman: kim oynuyor, kim yedekte ve kaç yer boş. Bir gün ve saat seçin; MatchTime her maçtan önceki son denk gelen zamanı kullanır.",
        "Her maç için bir kez gönderilir; takımlar zaten paylaşıldıysa hiç gönderilmez.",
      ],
      example: "📋 *Salı 7'li maç* listesi, *Salı 20 Eki*, Goals Sutton\n1. Ali\n2. Sam\n…\nArtık gelemiyorsanız yerinize birinin alınabilmesi için hemen *YOKUM* yazın.",
      choices: [
        { name: "Ayarlı", text: "Son liste her hafta o saatte paylaşılır." },
        { name: "Ayarlı değil", text: "Son liste paylaşılmaz. MatchTime her zamanki kadro güncellemelerine devam eder." },
      ],
      newClubs: "Ayarlı değil.",
      suits: "Kadroyu her hafta belli bir saatte duyuran kulüpler.",
      together: [
        "Bunu ve Son çıkış saatini ayarlarsanız MatchTime her gün 17:00'de gönderdiği mesajı maç günü dışında durdurur.",
        "Listeyi organizatörler duyuruyorsa son liste yönetici mesajlarınıza gider; yönetici grubu bağlıysa MatchTime oraya kadro afişini de gönderir.",
        "Son çıkış saatinden sonra, 09:00 ile 22:30 arasında olmalıdır. Aylık kadrolar bunu kullanmaz.",
      ],
    },
  },
  adminChannel: {
    en: {
      title: "Admin messages go to",
      what: [
        "Where MatchTime sends the messages only organisers should see: new players to check, the drop-out summary, late drop-outs, who hasn't paid and the bench to pick from. With the organisers announcing the list, the squad updates come here too.",
        "Most notices that come up between 23:00 and 09:00 wait until 09:00.",
      ],
      choices: [
        { name: "One person", text: "A private message to the person you choose. If you don't choose anyone, the club's owner." },
        {
          name: "Admin WhatsApp group",
          text: "One message in your admins' own WhatsApp group. Admins can reply there to pick a player, change the squad (\"Ali out\", \"put Bilal in\", or paste a list), check and change the teams, and ask for the poster or team sheet. MatchTime only acts on messages from owners and admins there.",
        },
        { name: "Each admin by DM", text: "The same private message to every owner and admin with a phone number." },
      ],
      newClubs: "One person: the club's owner.",
      suits: "An admin group suits clubs with several organisers who share the work.",
      together: [
        "Teams ready and the Posters only work with an admin group linked.",
        "If MatchTime can't post in the linked group, it sends the message to the owner instead. Unlinking the group sends admin messages back to the owner.",
        "The list of who hasn't paid is not sent with Each admin by DM.",
      ],
    },
    tr: {
      title: "Yönetici mesajları",
      what: [
        "MatchTime'ın yalnızca organizatörlerin görmesi gereken mesajları gönderdiği yer: kontrol edilecek yeni oyuncular, son çıkış özeti, geç çıkanlar, ödemeyenler ve seçim için yedek listesi. Listeyi organizatörler duyuruyorsa kadro güncellemeleri de buraya gelir.",
        "23:00 ile 09:00 arasında çıkan bildirimlerin çoğu 09:00'a kadar bekler.",
      ],
      choices: [
        { name: "Tek kişi", text: "Seçtiğiniz kişiye özel mesaj. Kimseyi seçmezseniz kulübün sahibine." },
        {
          name: "Yönetici WhatsApp grubu",
          text: "Yöneticilerinizin kendi WhatsApp grubuna tek mesaj. Yöneticiler orada yanıt vererek oyuncu seçebilir, kadroyu değiştirebilir (\"Ali çıktı\", \"Bilal girsin\" ya da bir listeyi yapıştırarak), takımları görüp değiştirebilir ve afiş ya da takım listesi isteyebilir. MatchTime orada yalnızca sahiplerin ve yöneticilerin mesajlarına göre hareket eder.",
        },
        { name: "Her yöneticiye DM", text: "Telefon numarası olan her sahibe ve yöneticiye aynı özel mesaj." },
      ],
      newClubs: "Tek kişi: kulübün sahibi.",
      suits: "Yönetici grubu, işi paylaşan birden çok organizatörü olan kulüplere uygundur.",
      together: [
        "Takımlar hazır ve Afişler yalnızca yönetici grubu bağlıyken çalışır.",
        "MatchTime bağlı gruba yazamazsa mesajı sahibe gönderir. Grubun bağlantısını kaldırmak yönetici mesajlarını sahibe geri yollar.",
        "Her yöneticiye DM seçiliyken ödemeyenler listesi gönderilmez.",
      ],
    },
  },
  adminGroupLink: {
    en: {
      title: "Link admin group",
      what: [
        "How to link your admins' WhatsApp group: press the button, add MatchTime to that group, then send the code shown here in it. This page updates by itself once the group is linked.",
        "A code works once. A code made with this button lasts 48 hours. The code MatchTime sent you when your club was set up lasts 7 days, and this page shows it while it still has time left. The line under the steps says when the code on screen runs out.",
        "Linking never starts a new club in that group.",
      ],
      newClubs: "No admin group linked.",
      together: ["Admin messages only go to the group once it is linked; until then they go where they went before."],
    },
    tr: {
      title: "Yönetici grubunu bağla",
      what: [
        "Yöneticilerinizin WhatsApp grubunu bağlamak için: düğmeye basın, MatchTime'ı o gruba ekleyin, sonra burada gösterilen kodu o gruba gönderin. Grup bağlanınca bu sayfa kendiliğinden güncellenir.",
        "Bir kod bir kez çalışır. Bu düğmeyle oluşturulan kod 48 saat geçerlidir. Kulübünüz kurulurken MatchTime'ın size gönderdiği kod 7 gün geçerlidir ve süresi bitmediyse bu sayfa onu gösterir. Adımların altındaki satır ekrandaki kodun ne zaman biteceğini söyler.",
        "Bağlamak o grupta asla yeni bir kulüp başlatmaz.",
      ],
      newClubs: "Bağlı yönetici grubu yok.",
      together: ["Yönetici mesajları gruba ancak grup bağlanınca gider; o zamana kadar eskisi gibi gönderilir."],
    },
  },
  teamsReady: {
    en: {
      title: "Teams ready",
      what: [
        "On match day at this time, MatchTime builds balanced teams from the squad and posts them in your admin WhatsApp group as a proposal. Admins can change them there (swap Ali Bilal, move Ali, reshuffle) and reply YES when they are final. If the squad is short, MatchTime says so instead.",
        "If nobody has said YES 2 hours before kickoff, MatchTime reminds the admin group once.",
      ],
      example: "📝 *Proposed teams*: Tue 20:00 at Goals Sutton\n…\nReply *YES* when they are final and I'll post them in the players' group.",
      choices: [
        { name: "A time", text: "Teams are proposed in the admin group at that time on match day." },
        { name: "Off", text: "MatchTime never proposes teams by itself. Admins can still type teams in the admin group to get a proposal." },
      ],
      newClubs: "Not set, which means 10:00 when the organisers announce the list and teams, and Off when MatchTime does.",
      suits: "Organisers who want to check the teams before the players see them.",
      together: [
        "Only shown with an admin WhatsApp group linked and a weekly squad.",
        "After YES: with MatchTime announcing, it posts the final teams in the players' group; with the organisers announcing, it does not. Either way it sends the team sheet picture to the admin group.",
      ],
    },
    tr: {
      title: "Takımlar hazır",
      what: [
        "Maç günü bu saatte MatchTime kadrodan dengeli takımlar kurar ve öneri olarak yönetici WhatsApp grubunuza gönderir. Yöneticiler takımları orada değiştirebilir (Ali ile Bilal değiş, Ali taşı, yeniden) ve kesinleşince EVET yazar. Kadro eksikse MatchTime takım yerine bunu söyler.",
        "Başlama saatinden 2 saat önce hâlâ EVET yazan olmadıysa MatchTime yönetici grubuna bir kez hatırlatır.",
      ],
      example: "📝 *Önerilen takımlar*: Salı 20:00, Goals Sutton\n…\nKesinleşince *EVET* yazın, oyuncu grubuna ben gönderirim.",
      choices: [
        { name: "Saat ayarlı", text: "Takımlar maç günü o saatte yönetici grubunda önerilir." },
        { name: "Kapalı", text: "MatchTime kendiliğinden takım önermez. Yöneticiler öneri almak için yönetici grubunda yine takımlar yazabilir." },
      ],
      newClubs: "Ayarlı değil: listeyi ve takımları organizatörler duyuruyorsa 10:00, MatchTime duyuruyorsa Kapalı.",
      suits: "Takımları oyuncular görmeden kontrol etmek isteyen organizatörler.",
      together: [
        "Yalnızca yönetici WhatsApp grubu bağlıyken ve kadro haftalıkken görünür.",
        "EVET'ten sonra: MatchTime duyuruyorsa son takımları oyuncu grubunda paylaşır, organizatörler duyuruyorsa paylaşmaz. Her iki durumda da takım listesi resmini yönetici grubuna gönderir.",
      ],
    },
  },

  // ════ Partner clubs (cross-club ask, 2026-10-16) ═══════════════════
  // MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.1 to 3.7.
  // The behaviour is club-partnership.ts (pairings) and partner-ask.ts
  // (the asks, their approval, the post and the cut-off).
  partnerClubs: {
    en: {
      title: "Your partner clubs",
      what: [
        "Clubs MatchTime may ask for a player when your squad is short, and clubs that may ask yours. Each pairing works one way: your club asking another is a separate pairing from that club asking yours.",
        "Only the MatchTime team pairs two clubs. Your club's owner then accepts or declines here, and so does the other club's owner. A pairing does nothing until both have accepted.",
        "An owner or admin of either club can pause a pairing at any time, and only the club that paused it can resume it. Your owner can remove a pairing for good.",
      ],
      newClubs: "None. A club has no partner clubs until the MatchTime team pairs it with one.",
      together: [
        "A player from a partner club who answers an ask plays for you as a guest for that one match. Your organisers see their name and their club, never their phone number or their rating at their own club.",
        "Your own players are never put on another club's list unless they reply to that club's ask themselves.",
      ],
    },
    tr: {
      title: "Partner kulüpleriniz",
      what: [
        "Kadronuz eksik olduğunda MatchTime'ın oyuncu isteyebileceği kulüpler ve sizden oyuncu isteyebilecek kulüpler. Her eşleşme tek yönlüdür: sizin başka bir kulüpten istemeniz, o kulübün sizden istemesinden ayrı bir eşleşmedir.",
        "İki kulübü yalnızca MatchTime ekibi eşleştirir. Sonra kulübünüzün sahibi burada kabul eder ya da reddeder, diğer kulübün sahibi de öyle. İkisi de kabul edene kadar eşleşme hiçbir şey yapmaz.",
        "İki kulüpten birinin sahibi ya da bir yöneticisi eşleşmeyi istediği an durdurabilir; yalnızca durduran kulüp devam ettirebilir. Kulüp sahibiniz eşleşmeyi tamamen kaldırabilir.",
      ],
      newClubs: "Yok. MatchTime ekibi eşleştirene kadar bir kulübün partner kulübü olmaz.",
      together: [
        "Bir isteğe yanıt veren partner kulüp oyuncusu yalnızca o maç için misafir olarak sizin için oynar. Organizatörleriniz onun adını ve kulübünü görür; telefon numarasını ya da kendi kulübündeki puanını asla görmez.",
        "Kendi oyuncularınız, o kulübün isteğine kendileri yanıt vermedikçe başka bir kulübün listesine asla yazılmaz.",
      ],
    },
  },
  partnerAskWhen: {
    en: {
      title: "Ask partner clubs for players",
      what: ["Whether MatchTime asks your partner clubs for a player when a place in your squad is still open."],
      example: "⚽ *FNF* need 1 player: Fri 16 Oct, 20:30 at Goals Sutton (9-a-side, £8).\nFancy a game? *Reply to this message* with *IN* and their organisers will confirm by private message.",
      choices: [
        { name: "Off", text: "MatchTime never asks your partner clubs." },
        { name: "When we ask", text: "MatchTime asks a partner club only when one of your owners or admins asks it to, from the match page." },
        {
          name: "Automatically at a time",
          text: "As When we ask, and also by itself on match day at the Automatic ask time, if a place is still open and nobody is on your bench.",
        },
      ],
      newClubs: "Off.",
      suits: "Clubs that often end up a player short on the day.",
      together: [
        "The ask goes into the partner club's players' group once their organisers approve it, unless they chose to let asks through without asking.",
        "No ask goes out later than Last ask before kickoff.",
        "Players who answer go on your bench as guests, and Who fills an open place decides who plays, as it does for your own players.",
        "At most 2 asks a day go into any one partner club's group, and only one at a time for each of your matches.",
        "Nothing is asked while MatchTime is switched off or paused for your club.",
      ],
    },
    tr: {
      title: "Partner kulüplerden oyuncu iste",
      what: ["Kadronuzda hâlâ boş yer varken MatchTime'ın partner kulüplerinizden oyuncu isteyip istemeyeceği."],
      example: "⚽ *FNF* 1 oyuncu arıyor: Cuma 16 Eki, 20:30, Goals Sutton (9'a 9, £8).\nOynamak ister misin? *Bu mesajı yanıtlayıp* *VARIM* yaz, organizatörleri sana özel mesajla dönecek.",
      choices: [
        { name: "Kapalı", text: "MatchTime partner kulüplerinizden hiç oyuncu istemez." },
        { name: "Biz isteyince", text: "MatchTime bir partner kulüpten yalnızca kulübünüzün sahibi ya da bir yöneticisi maç sayfasından isteyince oyuncu ister." },
        {
          name: "Belirli bir saatte kendiliğinden",
          text: "Biz isteyince gibi, ayrıca maç günü Otomatik istek saatinde, hâlâ boş yer varsa ve yedek listenizde kimse yoksa kendiliğinden de ister.",
        },
      ],
      newClubs: "Kapalı.",
      suits: "Maç günü sık sık bir oyuncu eksik kalan kulüpler.",
      together: [
        "İstek, partner kulübün organizatörleri onaylayınca onların oyuncu grubuna gider; sormadan geçmesini seçtilerse hemen gider.",
        "Hiçbir istek Başlama saatinden önce son istek ayarından daha geç gönderilmez.",
        "Yanıt veren oyuncular yedek listenize misafir olarak girer ve kimin oynayacağına, kendi oyuncularınızda olduğu gibi, Boşalan yeri kim doldurur ayarı karar verir.",
        "Bir partner kulübün grubuna günde en fazla 2 istek gider ve maçlarınızın her biri için aynı anda yalnızca bir istek açık olur.",
        "MatchTime kulübünüz için kapalıyken ya da durdurulmuşken hiçbir şey istenmez.",
      ],
    },
  },
  partnerAskTime: {
    en: {
      title: "Automatic ask time",
      what: ["Only used with Automatically at a time: the London time on match day when MatchTime asks your partner clubs by itself."],
      newClubs: "16:00.",
      together: [
        "MatchTime asks only if a place is still open, nobody is on your bench, and it is still before Last ask before kickoff. A time after that is never reached, so MatchTime then never asks by itself.",
      ],
    },
    tr: {
      title: "Otomatik istek saati",
      what: ["Yalnızca Belirli bir saatte kendiliğinden seçiliyken kullanılır: MatchTime'ın partner kulüplerinizden maç günü kendiliğinden oyuncu istediği Londra saati."],
      newClubs: "16:00.",
      together: [
        "MatchTime yalnızca hâlâ boş yer varsa, yedek listenizde kimse yoksa ve Başlama saatinden önce son istek henüz geçmemişse ister. Bundan sonraki bir saate hiç gelinmez, yani MatchTime o zaman kendiliğinden hiç istemez.",
      ],
    },
  },
  partnerAskCutoff: {
    en: {
      title: "Last ask before kickoff",
      what: [
        "The last moment an ask can go out to a partner club, in hours before kickoff, so their players have time to get to your game. You can choose from 1 to 24 hours.",
        "An ask still waiting for the partner club's organisers to approve it is dropped at that moment, and your organisers are told. An ask already posted stays open until kickoff or until the place is filled.",
      ],
      newClubs: "4 hours.",
    },
    tr: {
      title: "Başlama saatinden önce son istek",
      what: [
        "Bir partner kulübe isteğin gidebileceği son an, başlama saatinden kaç saat önce olduğu; böylece oyuncularının maçınıza yetişecek zamanı olur. 1 ile 24 saat arasında seçebilirsiniz.",
        "Partner kulübün organizatörlerinin onayını hâlâ bekleyen bir istek o anda düşer ve organizatörlerinize haber verilir. Zaten paylaşılmış bir istek başlama saatine ya da yer dolana kadar açık kalır.",
      ],
      newClubs: "4 saat.",
    },
  },
  partnerApproval: {
    en: {
      title: "Asks from partner clubs",
      what: ["How a partner club's ask for a player reaches your players' group. Set separately for each club that may ask you."],
      example: "FNF ask if one of your players can play for them: Fri 16 Oct, 20:30 at Goals Sutton, 9-a-side, £8. OK to post this in your group? Reply YES, or tap the link.",
      choices: [
        {
          name: "Ask our organisers each time",
          text: "MatchTime first asks your admins, with the game's day, time, place and fee, and how your own squad stands that day. It posts the ask in your players' group only after an admin says YES or taps the link.",
        },
        { name: "Post without asking", text: "MatchTime posts the ask in your players' group straight away and tells your admins afterwards." },
      ],
      newClubs: "Ask our organisers each time.",
      together: [
        "Your players answer by replying to MatchTime's post with IN. A plain IN in your group still means your own game.",
        "MatchTime never shows the other club your players' phone numbers or ratings, and a player already in your own game at an overlapping time cannot sign up for theirs.",
      ],
    },
    tr: {
      title: "Partner kulüplerden gelen istekler",
      what: ["Bir partner kulübün oyuncu isteğinin oyuncu grubunuza nasıl ulaşacağı. Sizden oyuncu isteyebilecek her kulüp için ayrı ayarlanır."],
      example: "FNF oyuncularınızdan birinin onlar için oynayıp oynayamayacağını soruyor: Cuma 16 Eki, 20:30, Goals Sutton, 9'a 9, £8. Bunu grubunuzda paylaşayım mı? EVET yazın ya da bağlantıya dokunun.",
      choices: [
        {
          name: "Her seferinde organizatörlerimize sor",
          text: "MatchTime önce yöneticilerinize maçın gününü, saatini, yerini ve ücretini ve o gün kendi kadronuzun durumunu yazarak sorar. İsteği oyuncu grubunuzda ancak bir yönetici EVET deyince ya da bağlantıya dokununca paylaşır.",
        },
        { name: "Sormadan paylaş", text: "MatchTime isteği oyuncu grubunuzda hemen paylaşır ve yöneticilerinize sonra haber verir." },
      ],
      newClubs: "Her seferinde organizatörlerimize sor.",
      together: [
        "Oyuncularınız MatchTime'ın mesajını yanıtlayıp VARIM yazarak cevap verir. Grubunuzda düz bir VARIM yine kendi maçınız anlamına gelir.",
        "MatchTime diğer kulübe oyuncularınızın telefon numaralarını ya da puanlarını asla göstermez ve kendi maçınızda aynı saatlere denk gelen bir oyuncu onların maçına yazılamaz.",
      ],
    },
  },
  // ════ Posters ═══════════════════════════════════════════════════════
  posters: {
    en: {
      title: "Posters",
      what: [
        "Pictures MatchTime makes for your club, ready to forward to the players' group: a list poster (who is playing) and a team sheet (the two teams). MatchTime sends them to your admin WhatsApp group:",
        "the list poster at the List published time, when the organisers announce the list; the team sheet when your admins approve proposed teams with YES; and either one whenever an owner or admin types poster or team sheet in the admin group.",
        "The two pictures on this card show your next match, or sample names until there are enough players.",
      ],
      newClubs: "The MatchTime design.",
      suits: "Clubs that like to share a smart graphic each week.",
      together: [
        "Nothing is sent without an admin group linked (Admin messages go to). The previews here still work.",
      ],
    },
    tr: {
      title: "Afişler",
      what: [
        "MatchTime'ın kulübünüz için hazırladığı, oyuncu grubuna iletmeye hazır resimler: kadro afişi (kimler oynuyor) ve takım listesi (iki takım). MatchTime bunları yönetici WhatsApp grubunuza gönderir:",
        "listeyi organizatörler duyuruyorsa kadro afişini Liste yayını saatinde; yöneticileriniz önerilen takımları EVET ile onaylayınca takım listesini; ve bir sahip ya da yönetici yönetici grubunda afiş ya da takım listesi yazdığında ikisinden birini.",
        "Bu karttaki iki resim bir sonraki maçınızı, yeterli oyuncu olana kadar da örnek isimleri gösterir.",
      ],
      newClubs: "MatchTime tasarımı.",
      suits: "Her hafta şık bir görsel paylaşmayı seven kulüpler.",
      together: [
        "Yönetici grubu bağlı değilse (Yönetici mesajları) hiçbir şey gönderilmez. Buradaki önizlemeler yine çalışır.",
      ],
    },
  },
  posterDesign: {
    en: {
      title: "Design",
      what: [
        "How the posters look. Pick the MatchTime design, your club's own design (one MatchTime made from your artwork, or your uploaded background) or a design MatchTime shares with clubs. A shared design is drawn with your club's name and your players.",
        "The choice is saved at once and used for every poster from then on.",
      ],
      newClubs: "The MatchTime design.",
    },
    tr: {
      title: "Tasarım",
      what: [
        "Afişlerin görünümü. MatchTime tasarımını, kulübünüzün kendi tasarımını (MatchTime'ın görsellerinizden yaptığı ya da yüklediğiniz arka plan) ya da MatchTime'ın kulüplerle paylaştığı bir tasarımı seçin. Paylaşılan bir tasarım kulübünüzün adı ve oyuncularınızla çizilir.",
        "Seçim hemen kaydedilir ve bundan sonraki her afişte kullanılır.",
      ],
      newClubs: "MatchTime tasarımı.",
    },
  },
  posterBackground: {
    en: {
      title: "Your own background",
      what: [
        "Upload a picture and MatchTime draws its board (the names, day, time and venue) over it.",
        "JPEG, PNG or WebP, up to 4 MB, at least 540 by 675 pixels and not wider than it is tall. It is cropped to fit. Remove it to go back to a MatchTime design.",
      ],
      newClubs: "No background.",
      together: ["Not offered when MatchTime has made a design for your club."],
    },
    tr: {
      title: "Kendi arka planınız",
      what: [
        "Bir resim yükleyin, MatchTime tablosunu (isimler, gün, saat ve saha) üzerine çizer.",
        "JPEG, PNG ya da WebP, en fazla 4 MB, en az 540 x 675 piksel ve genişliği yüksekliğinden fazla olmamalı. Sığacak şekilde kırpılır. MatchTime tasarımına dönmek için kaldırın.",
      ],
      newClubs: "Arka plan yok.",
      together: ["MatchTime kulübünüz için bir tasarım hazırladıysa sunulmaz."],
    },
  },

  // ════ Monthly squad ═════════════════════════════════════════════════
  squadMode: {
    en: {
      title: "How your squad works",
      what: ["How each game's squad is put together."],
      choices: [
        { name: "Weekly", text: "Each game's squad comes from who says IN, and with Rolling squad on, who played last time. This is how MatchTime works unless you change it." },
        {
          name: "Monthly",
          text: "Regulars sign up for the whole month, are in every game of it and pay once for the month. Pay-as-you-go players take the free places and pay per game. A Months page appears in your admin pages for the list, who has paid and credits.",
        },
      ],
      example: "📋 List for November (5 Mondays: 2, 9, 16, 23, 30)\n\n1. Alex\n2.\n…\nRegulars from October are on already. Not in for November? Say *OUT FOR NOVEMBER*.",
      newClubs: "Weekly.",
      suits: "Monthly suits groups where the regulars pay for the month up front and others fill the gaps.",
      together: [
        "Monthly: MatchTime posts next month's sign-up list in the group at 10:00, the number of days set in List opens before the month's first game, with this month's regulars already on it. Names close 2 days before the first game.",
        "Switching to monthly turns Rolling squad off. Switching back does not turn it on again.",
        "The weekly deadlines and the daily 17:00 post are not used for a month's games, and regulars get no per-game pay links.",
      ],
    },
    tr: {
      title: "Kadronuz nasıl oluşuyor",
      what: ["Her maçın kadrosunun nasıl oluştuğu."],
      choices: [
        { name: "Haftalık", text: "Her maçın kadrosu VARIM diyenlerden, Kadro devam eder açıksa geçen maçta oynayanlardan oluşur. Siz değiştirmedikçe MatchTime böyle çalışır." },
        {
          name: "Aylık",
          text: "Daimi oyuncular tüm aya yazılır, ayın her maçında kadrodadır ve ay için bir kez öder. Maç başı ödeyenler boş yerleri alır ve maç başına öder. Yönetici sayfalarınızda liste, ödeyenler ve krediler için bir Aylar sayfası görünür.",
        },
      ],
      example: "📋 Kasım listesi (5 pazartesi: 2, 9, 16, 23, 30)\n\n1. Alex\n2.\n…\nEkim'in daimi oyuncuları listede. Kasım'da yoksanız *KASIM YOKUM* yazın.",
      newClubs: "Haftalık.",
      suits: "Aylık; daimi oyuncuların ayın parasını baştan ödediği ve diğerlerinin boşlukları doldurduğu gruplara uygundur.",
      together: [
        "Aylık: MatchTime gelecek ayın kayıt listesini, Liste açılışı ayarındaki gün sayısı kadar ayın ilk maçından önce, saat 10:00'da gruba gönderir; bu ayın daimi oyuncuları listede hazır gelir. Kayıtlar ilk maçtan 2 gün önce kapanır.",
        "Aylığa geçmek Kadro devam eder ayarını kapatır. Haftalığa dönmek onu tekrar açmaz.",
        "Haftalık son saatler ve her gün 17:00 mesajı ayın maçlarında kullanılmaz; daimi oyunculara maç başı ödeme bağlantısı gitmez.",
      ],
    },
  },
  monthCreditRule: {
    en: {
      title: "Credits",
      what: [
        "A credit is one game off a regular's payment for a later month. Credits are counted in games, not money, and are used the next time a month is priced. They are listed on the Months page.",
      ],
      choices: [
        { name: "Every game a paid regular misses", text: "A regular who has paid, or says they have, gets a credit for every game they are not in the squad for, late drop-outs included." },
        { name: "Only when their place is filled", text: "A credit only when a player who is not a regular took their place." },
        { name: "No credits", text: "Missed games are not credited." },
      ],
      newClubs: "Every game a paid regular misses.",
      together: ["Only used with a monthly squad. A regular who chose to be on the bench does not count as missing the game."],
    },
    tr: {
      title: "Krediler",
      what: [
        "Bir kredi, daimi oyuncunun sonraki bir ayın ödemesinden bir maç düşülmesidir. Krediler para ile değil, maç sayısıyla tutulur ve bir ayın ücreti bir sonraki belirlendiğinde kullanılır. Aylar sayfasında listelenir.",
      ],
      choices: [
        { name: "Ödemiş daimi oyuncunun kaçırdığı her maç", text: "Ödemesini yapmış ya da yaptığını söyleyen daimi oyuncu, kadroda olmadığı her maç için kredi alır; geç çıkışlar dahil." },
        { name: "Yalnızca yeri doldurulduğunda", text: "Yalnızca yerini daimi olmayan bir oyuncu aldıysa kredi verilir." },
        { name: "Kredi yok", text: "Kaçırılan maçlar için kredi verilmez." },
      ],
      newClubs: "Ödemiş daimi oyuncunun kaçırdığı her maç.",
      together: ["Yalnızca aylık kadroda kullanılır. Yedek listesinde olmayı seçen daimi oyuncu maçı kaçırmış sayılmaz."],
    },
  },
  paygPrice: {
    en: {
      title: "PAYG price per game",
      what: [
        "What a pay-as-you-go player pays for one game, for example £8. It is shown in the group next to the open places, and after a game the money collector is asked to confirm it instead of typing an amount.",
        "Leave it empty if you don't have a set price; the price is then left out. Regulars don't pay this: their share for the month is set on the Months page.",
      ],
      example: "2 places open, £8 PAYG: say *IN* to take one.",
      newClubs: "Empty.",
      together: ["Only used with a monthly squad. Any amount from £0.01 to £100."],
    },
    tr: {
      title: "Maç başı ücret, PAYG",
      what: [
        "Maç başı ödeyen bir oyuncunun tek maç için ödediği tutar, örneğin £8. Grupta boş yerlerin yanında görünür ve maçtan sonra para toplayan kişiden tutar yazmak yerine bunu onaylaması istenir.",
        "Belirli bir ücretiniz yoksa boş bırakın; o zaman ücret yazılmaz. Daimi oyuncular bunu ödemez: onların aylık payı Aylar sayfasında belirlenir.",
      ],
      example: "2 yer boş, maç başı £8: almak için *VARIM* yazın.",
      newClubs: "Boş.",
      together: ["Yalnızca aylık kadroda kullanılır. £0.01 ile £100 arasında herhangi bir tutar."],
    },
  },
  monthListOpens: {
    en: {
      title: "List opens",
      what: [
        "How many days before the month's first game MatchTime posts next month's sign-up list in the group. It is posted at 10:00 London time, with this month's regulars already on it.",
      ],
      newClubs: "7 days.",
      together: ["Only used with a monthly squad. Any whole number of days from 1 to 28."],
    },
    tr: {
      title: "Liste açılışı",
      what: [
        "MatchTime'ın gelecek ayın kayıt listesini ayın ilk maçından kaç gün önce gruba göndereceği. Londra saatiyle 10:00'da, bu ayın daimi oyuncuları listede hazır olarak gönderilir.",
      ],
      newClubs: "7 gün.",
      together: ["Yalnızca aylık kadroda kullanılır. 1 ile 28 arasında tam gün sayısı."],
    },
  },
  paymentInstructions: {
    en: {
      title: "Payment instructions",
      what: [
        "Your own words on how to pay, for example \"Bank details are in the group description\" or the money collector's bank details.",
        "With a monthly squad they are shown with the amount owed: in the month's list once prices are set, in the reminders to regulars who haven't paid, and on the player's month page.",
        "With weekly match fees they are shown when players can pay the money collector directly: on the pay page, in the pay link and in the daily reminder to players who haven't paid.",
        "Up to 500 characters. MatchTime shows exactly what you write here and never asks players for bank details itself.",
      ],
      newClubs: "Empty.",
      together: [
        "A monthly squad, or Collect match fees with Pay organiser directly on. With card and Pay by Bank only, weekly players do not see them.",
      ],
    },
    tr: {
      title: "Ödeme talimatı",
      what: [
        "Nasıl ödeneceğini anlatan kendi cümleleriniz, örneğin \"Banka bilgileri grup açıklamasında\" ya da para toplayan kişinin banka bilgileri.",
        "Aylık kadroda borçla birlikte gösterilir: ücretler belirlenince ayın listesinde, ödemeyen daimi oyunculara giden hatırlatmalarda ve oyuncunun ay sayfasında.",
        "Haftalık maç ücretlerinde, oyuncular para toplayan kişiye doğrudan ödeyebildiğinde gösterilir: ödeme sayfasında, ödeme linkinde ve ödemeyenlere giden günlük hatırlatmada.",
        "En fazla 500 karakter. MatchTime buraya yazdığınızı aynen gösterir ve oyunculardan kendisi asla banka bilgisi istemez.",
      ],
      newClubs: "Boş.",
      together: [
        "Aylık kadro ya da \"Organizatöre ödeme\" açıkken \"Maç ücreti toplama\". Yalnızca kart ve banka ile ödemede haftalık oyuncular bunu görmez.",
      ],
    },
  },

  // ════ Payments ══════════════════════════════════════════════════════
  moneyCollector: {
    en: {
      title: "Money collector",
      what: ["The member who collects the match fees. MatchTime:"],
      choices: [
        { name: "Asks them", text: "how much each player owes after each match, while Collect match fees is on." },
        { name: "Tells them", text: "when a player says they will pay them directly, so they can mark it as paid." },
        { name: "Pays them", text: "card and Pay by Bank payments go to their connected bank." },
        { name: "Leaves them out", text: "they are never sent a pay link, chased, or counted as unpaid." },
      ],
      newClubs: "Nobody is chosen.",
      together: [
        "This picker only shows while Collect match fees is on. Only members with a phone number are listed.",
        "They also look after the card for MatchTime's club fee; with no money collector, the owner does. If your club pays that fee, MatchTime tells a new money collector so.",
        "In a monthly squad, they confirm the month's payments.",
      ],
    },
    tr: {
      title: "Para toplayan kişi",
      what: ["Maç ücreti toplamayan üye. MatchTime:"],
      choices: [
        { name: "Ona sorar", text: "Maç ücreti toplama açıkken her maçtan sonra her oyuncunun ne kadar ödeyeceğini." },
        { name: "Ona haber verir", text: "bir oyuncu ona doğrudan ödeyeceğini söyleyince, ödendi olarak işaretleyebilsin diye." },
        { name: "Ona öder", text: "kartla ve bankadan yapılan ödemeler onun bağlı bankasına gider." },
        { name: "Onu dışarıda tutar", text: "ona ödeme bağlantısı gönderilmez, hatırlatma yapılmaz ve ödemeyen sayılmaz." },
      ],
      newClubs: "Kimse seçili değil.",
      together: [
        "Bu seçici yalnızca Maç ücreti toplama açıkken görünür. Yalnızca telefon numarası olan üyeler listelenir.",
        "MatchTime'ın kulüp ücreti için kartla da o ilgilenir; para toplayan kişi yoksa sahip ilgilenir. Kulübünüz bu ücreti ödüyorsa MatchTime yeni para toplayan kişiye bunu bildirir.",
        "Aylık kadroda ayın ödemelerini o onaylar.",
      ],
    },
  },
  collectorBank: {
    en: {
      title: "Money collector's bank",
      what: [
        "Connect the money collector's bank account once, through Stripe, so card and Pay by Bank payments reach it. Stripe asks for a few identity details and the bank account. Choose Individual when asked.",
      ],
      choices: [
        { name: "Connect bank", text: "Opens Stripe to set it up. Finish bank setup appears if it was started but not finished." },
        { name: "Manage bank and payouts", text: "Opens Stripe to see payouts and change the payout bank." },
        { name: "Start over", text: "Removes the link in MatchTime so you can connect a different account. Payments already taken are not affected." },
      ],
      newClubs: "Not connected.",
      together: [
        "This section only shows while Collect match fees is on.",
        "Paying the organiser directly needs no bank.",
        "Once it is connected, MatchTime tells the group once that match fees now go through MatchTime.",
      ],
    },
    tr: {
      title: "Para toplayan kişinin bankası",
      what: [
        "Kartla ve bankadan yapılan ödemelerin ulaşması için para toplayan kişinin banka hesabını Stripe üzerinden bir kez bağlayın. Stripe birkaç kimlik bilgisi ve banka hesabını ister. Sorulduğunda Individual'ı seçin.",
      ],
      choices: [
        { name: "Bankayı bağla", text: "Kurulum için Stripe'ı açar. Başlanıp bitirilmediyse Banka kurulumunu bitir görünür." },
        { name: "Bankayı ve ödemeleri yönet", text: "Ödemeleri görmek ve ödeme alınacak bankayı değiştirmek için Stripe'ı açar." },
        { name: "Baştan başla", text: "MatchTime'daki bağlantıyı kaldırır, böylece başka bir hesap bağlayabilirsiniz. Daha önce alınan ödemeler etkilenmez." },
      ],
      newClubs: "Bağlı değil.",
      together: [
        "Bu bölüm yalnızca Maç ücreti toplama açıkken görünür.",
        "Organizatöre doğrudan ödeme için banka gerekmez.",
        "Bağlanınca MatchTime gruba bir kez maç ücretlerinin artık MatchTime üzerinden alındığını söyler.",
      ],
    },
  },
};

/** The explanation for `key` in the club's language (English for anything unknown). */
export function settingInfo(lang: Lang | string | null | undefined, key: SettingInfoKey): SettingInfoCopy {
  return SETTINGS_INFO[key][normaliseLang(lang)];
}

/** The small headings inside the popup, in the club's language. */
export function settingInfoLabels(lang: Lang | string | null | undefined) {
  return LABELS[normaliseLang(lang)];
}
