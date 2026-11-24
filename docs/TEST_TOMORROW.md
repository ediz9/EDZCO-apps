# Araçta ilk gün

## 1. Store'a kaynak ekle ve kur

Araç ekranından: **MGU Store → Settings → Add source → `github.com/ediz9/EDZCO-apps/tree/main`**

- Repo GitHub'da **public** olmalı (private ise Store GitHub girişi ister).
- `/tree/main` kanalı `main` dalına sabitler. Sadece `ediz9/EDZCO-apps` da olur, ama repoda bir GitHub Release açılırsa Store paketleri Release'lerde arar ve bulamaz — Release açma.

Listede dört şey görünür:

| | Ne olur |
|---|---|
| **Pop-Bang** (app) | Araç kendisi derler (kit + aracın kendi `oap-sdk`'sı), `edzco-sound`'u da beraberinde kurar |
| **Lights** (app) | Aynı şekilde derlenir; tool istemez (0.2.0'dan beri lambaları kendisi sürer) |
| **Sound** (tool) | Pop-Bang ile gelir; ayrıca kurmana gerek yok |

0.1.0'dan kalan **Exterior Lights** tool'u kuruluysa Store'dan kaldır: artık kullanılmıyor.

SDK'yı elle çıkarmak **gerekmiyor** — Store'un updater'ı derleme sırasında aracın kendi SDK'sını veriyor.

Kurulumdan sonra tool servisleri ilk açılışta (yeniden başlatmadan sonra) çalışmaya başlar; Store "pending" derse aracı bir kez yeniden başlat.

App'ler **Installed Apps**'te görünür.

---

## 2. App'lerin ekranında ne görmelisin

**Pop-Bang:** sol panelde canlı devir. Motor çalışırken sayı oynamıyorsa sinyal gelmiyor demektir → log'u getir.
Satırlar: Durum, Değişim, Tepe, Efekt sayısı (20 olmalı), Ses rotası.

**Lights:** solda desen listesi (8 desen; dokun = seç, tekrar dokun = çalıştır / durdur), sağda Vites / Hız / BDC düzeni / Çalışan lamba, her lambanın durumu ve en altta teşhis bağlantısı satırı.

---

## 3. Ses yolunu doğrula (en kritik bilinmeyen)

```sh
echo '{"op":"probe"}' | nc -U /run/edzco-sound/ctl.sock -q 2
```

`python` kısmına bak: `libasound: loaded`, `open: ok`, `params: ok` olmalı. Değilse oradaki hata metni sebebi söyler.

Sonra app'ten dene: **Pop-Bang → Dene**. Sonuç, ekranda "Pop-Bang" panelinin altında yazar:

| Ekranda | Anlamı |
|---|---|
| `Ses: calindi 412 ms (pcm.py)` | Cihaz sesi aldı. Duyulmuyorsa ses seviyesi / kaynak tarafı |
| `Ses: stall: ... the source is not connected` | Rota bağlanmadı (CarPlay müziği durmadıysa bu) |
| `Ses: open: ...` / `params: ...` | Cihaz adı bu firmware'de farklı |
| `Ses: libasound: ...` | libasound bulunamadı |
| `Rota: ...` | AudioManager hatası |

İlk denemede (0.1.0, aplay ile) rota bağlanıp CarPlay durdu ama ses gelmedi; 0.2.0 sesi moonride gibi doğrudan libasound ile yazıyor.

---

## 4. Lamba yolunu doğrula

Araç **P'de, kontak açık** olsun. **Lights → Lamp check**. Yaklaşık 1 dakika sürer; her lambayı 1,2 sn yakar.

Ekranda:

- **BDC duzeni**: gövde modülünün kabul ettiği çıkış isteği (`03 E A 00` gibi) ya da `yok`
- **Calisan lamba**: kaç lamba sürülebildi; altta her lambanın yolu: `far modulu` / `cikis` / `fonksiyon` / `yok`
- En alttaki **Teshis** satırı: istek / ok / red / cevapsız sayıları ve son red. `cevapsiz` artıyor ve `ok` 0 ise gövde modülüne ulaşılamıyor

Lambalar yanık kalırsa: **Lambalari birak**; olmazsa kontağı kapat-aç.

---

## 5. Pop-Bang'i yolda dene

Gaza bas, devri 3000'in üstüne çıkar, ayağını çek.

- Araç gaz pedalı sinyalini veriyorsa ayağı kaldırdığın **an** çalar.
- Vermiyorsa devir düşüşünden yakalar (ayarlardan "Hassas" / "Gec").

Log'da `lift: ... by pedal` ya da `by rpm` yazar — hangisinin çalıştığını oradan görürüz.

---

## Sorun çıkarsa

| Belirti | Bak |
|---|---|
| App Store'da derlenmiyor | Store'daki hata metni; ekran görüntüsünü getir |
| Soket cevap vermiyor | `systemctl status edzco-sound` |
| Log | `journalctl -u edzco-sound -n 200` |
| App log'u | app klasörünün `data/` altında: `find / -name 'edzco_*.log' 2>/dev/null` |
| Hangi sinyal bu araçta yok | App log'unun başı: `... subscribed` / `... error` satırları |
| `aplay: command not found` | Bu firmware'de ALSA aracı yok; `probe` çıktısını getir |
| Lambalarda `NRC 31` yığını | O NAD bu araçta yok — normal, otomatik atlanır |
| Lambalarda `NRC 22` | Araç park değil veya kontak kapalı |

---

## Dönüşte bana getir

- `probe` çıktısı
- Lamp check sonucu (ekran fotoğrafı yeter)
- `journalctl -u edzco-sound -n 200`
- İki app'in log dosyası
