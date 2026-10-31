/**
 * Gizlilik politikası, Türkçe. The owner (a native speaker) reviews this
 * file when the Turkish changes. Same sections, in the same order, as
 * `privacy-policy.en.ts` (unit tested). Facts come from `f`.
 */
import { formatPolicyDate, type PolicyFacts, type PrivacyPolicyCopy } from "./privacy-policy-shared";

export function buildPrivacyPolicyTr(f: PolicyFacts): PrivacyPolicyCopy {
  const { company: c, email, ico } = f;
  const date = formatPolicyDate(f.effectiveDate, "tr-TR");
  const name = c.legalName ?? "MatchTime";
  const number = c.companyNumber ? ` (şirket numarası ${c.companyNumber})` : "";
  const office = c.registeredOffice ? ` Kayıtlı adresimiz: ${c.registeredOffice}.` : "";

  return {
    title: "Gizlilik politikası",
    lead:
      "MatchTime'ın birlikte çalıştığı oyuncuların ve organizatörlerin, ayrıca oyuncu havuzuna katılanların bilgilerini nasıl kullandığı.",
    versionLine: `Sürüm ${f.version}, ${date} tarihinden itibaren geçerli`,
    contentsLabel: "Bu sayfada",
    languageLabel: "Dil",
    backHome: "MatchTime'a dön",
    sections: [
      {
        id: "who-we-are",
        heading: "Biz kimiz",
        blocks: [
          {
            kind: "p",
            text: `MatchTime, İngiltere ve Galler'de kayıtlı ${name} tarafından işletilir${number}.${office} Kişisel verilerinizin nasıl kullanılacağına biz karar veririz; bu da bizi Birleşik Krallık veri koruma hukukuna göre veri sorumlusu yapar.`,
          },
          {
            kind: "p",
            text: [
              "Kişisel verilerinizle ilgili her konuda ",
              email,
              " adresine e-posta gönderin. Yasa zorunlu tutmadığı için bir Veri Koruma Görevlisi atamadık; bu adres doğrudan sorumlu kişilere ulaşır.",
            ],
          },
        ],
      },
      {
        id: "what-it-covers",
        heading: "Bu politika kimleri kapsar",
        blocks: [
          { kind: "p", text: "Bu politika, MatchTime'ın bilgilerini tuttuğu herkesi kapsar:" },
          {
            kind: "list",
            items: [
              "maçlarını MatchTime ile düzenleyen bir WhatsApp grubundaki oyuncular;",
              "MatchTime'da bir kulüp kuran ve yöneten organizatörler;",
              "yakınlarında maç teklifi almak için MatchTime oyuncu havuzuna katılanlar (henüz hiçbir kulüpte olmayanlar dahil);",
              "MatchTime'a özelden mesaj yazan ya da bu web sitesini ziyaret eden herkes.",
            ],
          },
          { kind: "p", text: "“Oyuncu havuzu” ile başlayan maddeler yalnızca havuz üyeleri için geçerlidir." },
        ],
      },
      {
        id: "what-we-hold",
        heading: "Hangi bilgileri tutuyoruz",
        blocks: [
          { kind: "p", text: "Her oyuncu ve organizatör için:" },
          {
            kind: "list",
            items: [
              "adınız ve WhatsApp telefon numaranız;",
              "MatchTime'ın bulunduğu bir grupta yazdığınız ve MatchTime'a özelden gönderdiğiniz mesajlar, ne istediğinizi anlayabilmesi için;",
              "maçlarınız: varım, yokum ya da yedek olduğunuz, takımlar, sonuçlar, puanlar, maçın adamı oyları ve rozetler;",
              "maç ödemeleri: ne kadar borç olduğu ve ne ödendiği. Kart bilgilerinizi ödeme sağlayıcımız alır; kart numaranızın tamamını hiçbir zaman görmeyiz;",
              "organizatörler için: kulübün ayarları, sahaları, programı ve fatura kayıtları.",
            ],
          },
          { kind: "p", text: "Oyuncu havuzu üyeleri için ayrıca:" },
          {
            kind: "list",
            items: [
              "posta kodu bölgesi olarak bölgeniz (örneğin SM1) ve ne kadar uzağa gidebileceğiniz;",
              "oynayabileceğiniz günler ve saatler, sporlarınız, sevdiğiniz formatlar ve isterseniz her spordaki seviyeniz;",
              "onay kaydınız: ne zaman onay verdiğiniz, bu politikanın hangi sürümünü kabul ettiğiniz ve bunu doğrulayan mesaj;",
              "size gönderdiğimiz maç teklifleri ve kendi sözlerinizle yazdıklarınız dahil verdiğiniz yanıtlar;",
              "maça gelme kaydınız: oynadığınız maçlar, gelmediğiniz maçlar ve son anda yaptığınız iptaller;",
              "sizin yaptığınız ya da sizinle ilgili yapılan engellemeler ve şikayetler;",
              "davet ve kaynak kodları: sizi kimin getirdiği ya da kaydolurken hangi bağlantıyı kullandığınız;",
              "bir kulübe katılma davetlerine verdiğiniz yanıtlar;",
              "havuz açılmadan önce erken kayıt listesine katıldıysanız erken kaydınız.",
            ],
          },
          {
            kind: "p",
            text: "Tam posta kodunuzu, tam konumunuzu ya da doğum tarihinizi hiçbir zaman istemeyiz ve saklamayız.",
          },
        ],
      },
      {
        id: "why",
        heading: "Bilgileri neden kullanıyoruz ve hangi hukuki dayanakla",
        blocks: [
          {
            kind: "list",
            items: [
              "Kulübünüzün maçlarını yürütmek için (kimin geldiği, yedekler, takımlar, puanlar, ödemeler). Organizatörler için dayanak bizimle yaptıkları sözleşmedir. Oyuncular için ise grubun kaydolduğu maçı yürütmekte bizim ve kulübün meşru menfaatidir.",
              "Oyuncu havuzu: profilinizi tutmak ve sizi maçlarla eşleştirmek için, çünkü bunu siz istediniz. Kaydolduğunuz hizmet budur.",
              "Oyuncu havuzu: size maç teklifleri göndermek için, çünkü onay verdiniz. Onayınızı, verdiğiniz kadar kolay bir şekilde, istediğiniz zaman geri çekebilirsiniz.",
              "Oyuncu havuzu: maça gelme kaydını tutmak, engellemeler ve şikayetlerle ilgilenmek için, çünkü maçların herkes için güvenilir ve güvenli olmasında meşru menfaatimiz var.",
              "Fatura ve ödeme kayıtlarını saklamak için, çünkü yasa bunu zorunlu kılar.",
              "MatchTime'ı güvende tutmak ve sorunları gidermek için, çünkü düzgün çalışan, güvenli bir hizmette meşru menfaatimiz var.",
            ],
          },
        ],
      },
      {
        id: "who-sees-it",
        heading: "Bilgilerinizi kimler görür",
        blocks: [
          {
            kind: "p",
            text: "Kendi kulübünüzde grup, MatchTime'ın orada paylaştıklarını görür: liste, yedekler, takımlar, sonuçlar, sıralamalar ve rozetler gibi. Organizatörler ayrıca kulübün panelinde ödemeleri ve ayarları görür.",
          },
          { kind: "p", text: "Oyuncu havuzu: kulüpler adım adım, olabildiğince az şey görür:" },
          {
            kind: "list",
            items: [
              "bir kulüp oyuncu istemeden önce yalnızca yakında aşağı yukarı kaç havuz oyuncusu olduğunu görür; hiçbir zaman isim ya da liste görmez;",
              "teklifler gönderilmişken kaç oyuncuya sorulduğunu ve kaçının hayır dediğini görür, kimler olduğunu görmez;",
              "bir yeri kabul ettiğinizde kulüp adınızı ve soyadınızın baş harfini, MatchTime oyuncu havuzundan geldiğinizi ve maça gelme kaydınızı görür;",
              "bir kulüp telefon numaranızı, bölgenizi, oynadığınız diğer kulüpleri ya da başka yerlerdeki puanlarınızı hiçbir zaman görmez. Telefon numaranız bir kulübün üyelerine ancak o kulübün WhatsApp grubuna kendiniz katılmayı seçerseniz ulaşır.",
            ],
          },
          {
            kind: "p",
            text: "Bir teklif size kulübü, sahayı, günü, saati, formatı ve ücreti gösterir. Kulüp üyelerinin isimlerini ya da telefon numaralarını hiçbir zaman göstermez.",
          },
          {
            kind: "p",
            text: "Maça arkadaş getirdiğiniz için kazandığınız rozetler ve bir arkadaşınızın ilk maçındaki “Getiren” satırı, kendi kulübünüzün grubunda adınızı gösterir. Bunları yönetim sayfanızdan gizleyebilirsiniz.",
          },
          { kind: "p", text: "Verilerinizi satmayız ve reklamcılarla paylaşmayız." },
        ],
      },
      {
        id: "service-providers",
        heading: "Hizmet sağlayıcılar",
        blocks: [
          {
            kind: "p",
            text: "MatchTime'ı çalıştırmak için az sayıda şirketle çalışıyoruz. Bu şirketler yalnızca bizim talimatımızla hareket eder ve verilerinizi başka hiçbir amaçla kullanamaz:",
          },
          {
            kind: "list",
            items: [
              "sizinle MatchTime arasındaki mesajları taşıyan bir mesajlaşma hizmeti;",
              "verileri saklayan barındırma ve veritabanı sağlayıcıları;",
              "MatchTime'ın mesajları anlayabilmesi için onları okuyan bir yapay zeka hizmeti. Oyuncu havuzunda yalnızca kendi teklifinize verdiğiniz yanıtı, o teklifle birlikte okur; havuz profiliniz bu hizmetle hiçbir zaman paylaşılmaz;",
              "ödeme alan kulüpler için bir kart ödeme sağlayıcısı;",
              "web sayfalarımızın ziyaretlerini ve tamamlanan oyuncu havuzu kayıtlarını sayan bir web analiz hizmeti. Bu hizmet çerez kullanmaz ve adınızı, telefon numaranızı ya da posta kodunuzu hiçbir zaman almaz;",
              "gönderdiğimiz az sayıdaki e-posta için bir e-posta sağlayıcısı.",
            ],
          },
          {
            kind: "p",
            text: "Bu sağlayıcıların bazıları verileri Birleşik Krallık dışında işleyebilir. Bu durumda Birleşik Krallık hukukunun istediği güvencelere dayanırız: Birleşik Krallık'ın verileri yeterince koruduğunu kabul ettiği bir ülke ya da Birleşik Krallık'ın onayladığı veri aktarım sözleşmesi.",
          },
        ],
      },
      {
        id: "automatic-choices",
        heading: "Otomatik verilen kararlar",
        blocks: [
          {
            kind: "p",
            text: "Oyuncu havuzu: MatchTime, hangi havuz oyuncularına yer teklif edileceğini bize verdiğiniz bilgilere (spor, bölge, mesafe, günler ve saatler, format) ve maça gelme kaydınıza göre otomatik olarak seçer.",
          },
          {
            kind: "p",
            text: [
              "Arka arkaya birkaç teklifi yanıtsız bırakırsanız ya da kabul ettiğiniz maçlara gelmezseniz teklifleriniz otomatik olarak durdurulur. Bir durdurmanın bir kişi tarafından incelenmesini istediğiniz zaman ",
              email,
              " adresine yazarak isteyebilirsiniz. İnceleriz ve kararımızı size bildiririz.",
            ],
          },
          {
            kind: "p",
            text: "Kulüplerde MatchTime, organizatör istediğinde takımları da puanlara göre otomatik olarak dengeler. Bu kararların hiçbirinin sizin için hukuki bir sonucu yoktur.",
          },
        ],
      },
      {
        id: "how-long",
        heading: "Bilgileri ne kadar süre saklıyoruz",
        blocks: [
          {
            kind: "list",
            items: [
              "Kulüp kayıtları (maçlar, takımlar, sonuçlar, puanlar), kulübün geçmişi ve istatistikleri doğru kalsın diye kulübünüz MatchTime'ı kullandığı sürece saklanır.",
              "Oyuncu havuzu: profilinizde 12 ay boyunca hiçbir hareket olmazsa (yanıt, maç ya da yönetim sayfanıza ziyaret yoksa), hâlâ teklif almak isteyip istemediğinizi sormak için size bir mesaj göndeririz. 30 gün içinde yanıt vermezseniz profilinizi kapatır ve kişisel bilgilerini sileriz.",
              "Oyuncu havuzu: teklif kayıtlarında yalnızca işleri adil tutmak ve kötüye kullanımı önlemek için gerekenler kalır ve bu kayıtlar 24 ay sonra anonim hale getirilir.",
              "Bir havuz profili silindiğinde, engellenen biri kolayca yeniden kaydolamasın diye engelleme ve şikayetlerin kısa bir kaydını 24 ay, neyi kabul ettiğinizi gösterebilmek için de onay kaydınızı 6 yıl saklarız.",
              "Fatura ve ödeme kayıtları, vergi mevzuatının gerektirdiği gibi 6 yıl saklanır.",
              "Bilgilerinizin silinmesini isterseniz adınızı ve telefon numaranızı sileriz. Misafir olarak oynadığınız bir maç, her eski misafirde olduğu gibi o kulübün geçmişinde kalır.",
            ],
          },
        ],
      },
      {
        id: "your-rights",
        heading: "Haklarınız",
        blocks: [
          { kind: "p", text: "Şu haklara sahipsiniz:" },
          {
            kind: "list",
            items: [
              "hakkınızda tuttuğumuz verileri görmek ve bir kopyasını almak;",
              "yanlış olan her şeyi düzeltmek;",
              "verilerinizi sildirmek;",
              "verilerinizi nasıl kullandığımızı kısıtlamak;",
              "verilerinizi kullanmamıza, özellikle meşru menfaatimize dayanan kullanıma itiraz etmek;",
              "bize verdiğiniz verilerin bir kopyasını başka bir yere taşıyabileceğiniz bir biçimde almak;",
              "onayınızı her teklifteki bağlantıdan ya da yönetim sayfanızdan istediğiniz zaman geri çekmek. Bu, daha önce yapılanları etkilemez;",
              [
                "Birleşik Krallık'ın veri koruma kurumu olan Bilgi Komiserliği Ofisi'ne (ICO) ",
                ico,
                " üzerinden şikayette bulunmak.",
              ],
            ],
          },
          {
            kind: "p",
            text: [
              "Bu haklardan birini kullanmak için ",
              email,
              " adresine yazın. Bir ay içinde yanıt veririz. İşleme geçmeden önce, genellikle kendi WhatsApp'ınızdan bir mesajla, siz olduğunuzu doğrulamanızı isteyebiliriz.",
            ],
          },
        ],
      },
      {
        id: "age",
        heading: "Yaş",
        blocks: [
          {
            kind: "p",
            text: "Oyuncu havuzu yalnızca 18 yaş ve üzeri içindir, çünkü oyuncular maçlarda tanımadıkları insanlarla karşılaşır. 18 yaşından küçük birinin havuz profilini bilerek tutmayız; böyle bir profil fark edersek sileriz.",
          },
        ],
      },
      {
        id: "cookies",
        heading: "Çerezler",
        blocks: [
          {
            kind: "p",
            text: "Bu web sitesi yalnızca çalışması için gereken çerezleri kullanır, örneğin oturumunuzu açık tutan çerez. Reklam ya da izleme çerezi kullanmayız, bu yüzden sizden çerez onayı istemeyiz.",
          },
        ],
      },
      {
        id: "security",
        heading: "Verilerinizi nasıl koruyoruz",
        blocks: [
          {
            kind: "p",
            text: "Verileriniz şifreli bağlantılarla iletilir ve yalnızca MatchTime'ı çalıştırmak için ihtiyacı olan kişilerin erişebileceği şekilde saklanır. Profilinizi yönetmeniz için gönderdiğimiz bağlantılar size özeldir, lütfen başkasına iletmeyin. Verilerinizi riske atan bir şey olursa, yasanın gerektirdiği her durumda size ve ICO'ya haber veririz.",
          },
        ],
      },
      {
        id: "changes",
        heading: "Bu politikadaki değişiklikler",
        blocks: [
          {
            kind: "p",
            text: `Bu, politikanın ${f.version}. sürümüdür ve ${date} tarihinden itibaren geçerlidir. Onay verdiğinizde hangi sürümü kabul ettiğinizi kaydederiz.`,
          },
          {
            kind: "p",
            text: "Büyük bir değişiklik yaparsak, örneğin verilerinizi yeni bir amaçla kullanmak gibi, bu değişiklik geçerli olmadan önce size haber veririz; oyuncu havuzundaysanız mesajla. Küçük ifade düzeltmeleri bu sayfada yapılır ve üstteki tarih değişir.",
          },
        ],
      },
    ],
  };
}
