/** `month-setup.en.ts`, in Turkish. */
import type { MonthSetupStrings } from "./month-setup.en";

export const monthSetupTr: MonthSetupStrings = {
  held_notice: (p) =>
    [
      `📋 ${p.month} listesinin açılma zamanı geldi, ama bu MatchTime'ın grubunuzla ilk ayı, bu yüzden paylaşacağı kendi listesi yok.`,
      `${p.month} ayını grubunuzun listesiyle buradan başlatın: ${p.link}`,
      ...(p.inGroup ? ["Ya da beni etiketleyip listeyi bu gruba yapıştırın, isimleri önce sizinle kontrol edeyim."] : []),
      "Grubunuzun henüz listesi yoksa o sayfada boş bir liste açın, ben paylaşırım.",
      `O zamana kadar ${p.month} hakkında hiçbir şey paylaşmıyorum.`,
    ].join("\n"),

  held_nudge: (p) =>
    `📋 Hatırlatma: ${p.month} ayının ilk maçı ${p.day} ve ay burada henüz başlatılmadı, bu yüzden o maç dahil onun için hiçbir şey paylaşmıyorum. Grubunuzun listesiyle başlatın ya da boş bir liste açın: ${p.link}`,

  next_title: (p) => `${p.month} ayını listenizle başlatın`,
  next_body: (p) =>
    `Grubunuzun ${p.month} için kullandığı listeyi yapıştırın. MatchTime isimleri oyuncularınızla eşleştirir, siz kontrol edersiniz, sonra ayı onlarla başlatır. Hemen ardından kendi listesini paylaşmaz: listeyi yalnızca biri bir şey değiştirdiğinde paylaşır.`,
  next_held: (p) => `Siz burada başlatana kadar MatchTime ${p.month} için liste paylaşmıyor.`,
  next_open_empty: (p) => `${p.month} için boş liste aç`,
  next_open_empty_hint: "MatchTime listeyi grubunuzda paylaşır, oyuncular orada yazılır.",
  next_opened: (p) => `${p.month} listesi açıldı`,
  next_posts_note: "Ayı böyle başlatmak hemen bir şey paylaşmaz. MatchTime listeyi biri bir şey değiştirdiğinde paylaşır.",
  next_break: (p) => `${p.month} ayında maç yok: sezon arası.`,

  col_games_committed: "Maç",
  games_hint: "Her maç için boş bırakın. \"Sadece 4\" diyen bir oyuncu için 4 yazın.",
  games_all: "Hepsi",
  games_note: (p) => `${p.games} maç`,
  games_of: (p) => `${p.of} maçtan ${p.games}`,
  games_save: "Kaydet",
  games_saved: "Maç sayısı kaydedildi",
  games_error: (p) =>
    p.key === "more-than-the-month"
      ? "Bu, ayın maç sayısından fazla."
      : p.key === "bad-games"
        ? "Tam bir maç sayısı yazın, ya da her maç için boş bırakın."
        : p.key === "locked"
          ? "Bu ödeme onaylandı. Maç sayısını bir yöneticiye değiştirtin."
          : p.key === "not-a-regular"
            ? "Maç sayısı yalnızca ayın daimi oyuncuları içindir."
            : p.key === "fewer-than-played"
              ? "Bu ay zaten bundan fazla maç oynadı."
            : "Kaydedilemedi. Tekrar deneyin.",
  my_games_label: (p) => `${p.of} maçın kaçında oynuyorsunuz?`,
  my_games_all: (p) => `${p.of} maçın hepsi`,

  add_cover_label: "Ay başladı. Oyuncunun kapsadığı:",
  add_cover_whole: (p) => `Ayın tamamı (${p.games} maç)`,
  add_cover_left: (p) => `Kalan maçlar (${p.games})`,
  add_cover_pick: "Önce ayın tamamını ya da kalan maçları seçin.",
  cover_label: "Kapsadığı",
  cover_opt: (p) => (p.whole ? `${p.of} maçtan ${p.games}, ayın tamamı` : p.left ? `${p.of} maçtan ${p.games}, en az (katıldığından beri oynanan, kredi verilen iptal haftaları ve kalan)` : `${p.of} maçtan ${p.games}`),
  cover_save: "Kaydet",
  cover_saved: "Kapsam kaydedildi",
  cover_error: (p) =>
    p.key === "below-games-left"
      ? "Bu, kapsayabileceğinden az: katıldığından beri oynanan maçlar, kredi aldığı iptal edilen haftalar ve kalan maçlar."
      : p.key === "more-than-the-month"
        ? "Bu, ayın maç sayısından fazla."
        : p.key === "below-credits"
          ? "Bu aydan bundan fazla kredisi düşülmüş. Önce bir krediyi geri alın."
          : p.key === "not-a-regular" || p.key === "not-a-member"
            ? "Maçları yalnızca ayın daimi oyuncuları kapsar."
            : p.key === "closed"
              ? "Bu ay kapandı."
              : "Kaydedilemedi. Tekrar deneyin.",

  hq_cover_ask: (p) =>
    `📋 ${p.month} listesindeki ${p.name}: ayın tamamı mı, yoksa sadece kalan maçlar mı? Ayın tamamı ${p.whole} maç; ${p.left} maç kaldı. Cevabını beni etiketleyerek yaz.`,
  hq_cover_confirm_item: (p) =>
    p.wholeMonth
      ? `${p.name}: ${p.month} ayının tamamı (${p.games} maç${p.amount ? `, ${p.amount} ${p.more ? "fazla" : "az"}` : ""})`
      : `${p.name}: ${p.month} ayının ${p.of} maçından ${p.games} maç${p.amount ? ` (${p.amount} ${p.more ? "fazla" : "az"})` : ""}`,
  hq_cover_confirm: (p) => `Kapsamı değiştireyim mi? ${p.items}. Onaylamak için *@Match Time EVET* yazın.`,
  hq_cover_confirm_changed: "Sorduğumdan beri fiyat ya da bir ödeme değişti.",
  hq_cover_confirm_expired: "Bir oyuncunun kapsamıyla ilgili o soru 30 dakikadan eski, bu yüzden hiçbir şeyi değiştirmedim. Tekrar yazarsanız tekrar sorarım.",
  hq_cover_done: (p) =>
    p.wholeMonth
      ? `✅ ${p.name}, ${p.month} ayının tamamını kapsıyor: ${p.games} maç.`
      : `✅ ${p.name}, ${p.month} ayının ${p.of} maçından ${p.games} maçı kapsıyor.`,
  hq_cover_same: (p) =>
    p.wholeMonth
      ? `${p.name} zaten ${p.month} ayının tamamını kapsıyor, hiçbir şey değişmedi.`
      : `${p.name} zaten ${p.month} ayının ${p.of} maçından ${p.games} maçı kapsıyor, hiçbir şey değişmedi. Katıldığından beri oynadığı maçlar, kredi aldığı iptal haftaları ve kalan maçlardan az olamaz.`,
  hq_cover_failed: (p) =>
    p.key === "below-credits"
      ? `${p.name} için ${p.month} ayından bundan fazla kredi düşülmüş, ${p.name} için kapsamı değiştirmedim. Aylar sayfasından değiştirebilirsin.`
      : p.key === "below-games-left"
        ? `${p.name}, katıldığından beri oynanan maçlar, kredi aldığı iptal haftaları ve kalan maçlardan azını kapsayamaz, ${p.name} için kapsamı değiştirmedim.`
        : p.key === "not-a-regular" || p.key === "not-a-member"
          ? `${p.name}, ${p.month} listesinde daimi oyuncu değil, ${p.name} için kapsamı değiştirmedim.`
          : p.key === "closed"
            ? `${p.month} kapandı, ${p.name} için kapsamı değiştirmedim.`
            : `${p.name} için kapsamı değiştiremedim. Aylar sayfasından yapabilirsin.`,
  hq_cover_balance: (p) => (p.owes ? `Hâlâ ödemesi gereken ${p.amount} görünüyor.` : `Ona geri verilecek ${p.amount} görünüyor.`),
  hq_cover_others: (p) =>
    `${p.names} için kapsamı değiştirmedim: bunu ayrı bir mesajla beni etiketleyerek yaz, örneğin "@Match Time ${p.first} ayın tamamını kapsıyor".`,
  hq_cover_which: (p) =>
    `Hangi oyuncuyu kastediyorsun: ${p.names}? Onunla ilgili soruma yanıt ver ya da beni adıyla etiketle, örneğin "@Match Time ${p.first} ayın tamamını kapsıyor".`,
  hq_cover_merged: "Sorduğumdan beri o oyuncu başka bir oyuncuyla birleştirildi, hiçbir şeyi değiştirmedim. Lütfen onu yeniden ekle.",
  added_left_note: (p) =>
    p.group
      ? `${p.names}, ${p.month} listesinde kalan maçlar için. Ayın tamamını ${p.count === 1 ? "ödediyse" : "ödedilerse"} aylar sayfasında Kapsadığı kısmından (${p.link}) ya da yönetici grubunda beni etiketleyerek ayın tamamına ayarla, örneğin "@Match Time ${p.first} ayın tamamını kapsıyor"; sayfa sonra ödenecek ya da onaylanacak kalanı gösterir.`
      : `${p.names}, ${p.month} listesinde kalan maçlar için. Ayın tamamını ${p.count === 1 ? "ödediyse" : "ödedilerse"} aylar sayfasında Kapsadığı kısmından (${p.link}) ayın tamamına ayarla; sayfa sonra ödenecek ya da onaylanacak kalanı gösterir.`,
  hq_cover_who: (p) =>
    p.name
      ? `${p.name} ayın listesindeki hangi daimi oyuncu, anlayamadım, ${p.name} için bir şey değiştirmedim.`
      : `Kimi kastediyorsun? Beni adıyla etiketle, örneğin "@Match Time Dan ayın tamamını kapsıyor".`,

  break_title: "Sezon arası",
  break_body:
    "Kulübünüzün maç oynamadığı ayları işaretleyin. O aylarda liste açılmaz, maç oluşturulmaz ve hiçbir şey paylaşılmaz. Sonraki ay her zamanki gibi, oynanan son ayın daimi oyuncularıyla başlar.",
  break_save: "Kaydet",
  break_saved: "Sezon arası kaydedildi",
  break_error: (p) =>
    p.key === "month-exists"
      ? `${p.month ?? "O ay"} burada zaten başladı, sezon arası olamaz. Önce oyuncularını aydan çıkarın.`
      : p.key === "bad-months"
        ? "Bu aydan başlayarak en fazla bir yıl sonrasına kadar ay seçin."
        : "Kaydedilemedi. Tekrar deneyin.",
  break_kept_games: (p) =>
    p.count === 1
      ? "O aylardaki 1 maçta zaten oyuncu var. Oynanmayacaksa maç sayfasından iptal edin."
      : `O aylardaki ${p.count} maçta zaten oyuncu var. Oynanmayacaklarsa maç sayfalarından iptal edin.`,

  hq_seed_proposal: (p) =>
    [
      `📋 ${p.month} listenizi okudum: ${p.count} oyuncu (${p.names}).`,
      ...(p.unknown ? [`Henüz tanımadığım isimler: ${p.unknown}. Onları oyuncu olarak ekleyin ya da onlarsız başlatın.`] : []),
      `${p.month} ayını onlarla başlatmak için *@Match Time EVET* yazın. Önce kontrol etmek ya da değiştirmek için: ${p.link}`,
    ].join("\n"),
  hq_seed_applied: (p) => `✅ ${p.month} ${p.count} oyuncuyla başladı. Biri bir şey değiştirene kadar kendi listemi paylaşmayacağım.`,
  hq_seed_failed: (p) =>
    p.key === "already-started"
      ? `${p.month} zaten başladı, hiçbir şey değiştirilmedi.`
      : `${p.month} ayını o listeyle başlatamadım. Lütfen web sitesinde, Aylar sayfasından yapın.`,
};
