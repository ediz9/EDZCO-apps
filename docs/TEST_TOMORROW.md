# Yarın araçta — adım adım test rehberi

Her iki uygulamayı araca ulaştırmak için **iki yol** var. İlk defa test ediyorsan **A yolunu** (SSH ile direkt) kullan — hızlı, Store'u aradan çıkartır, hata çıkarsa logu hemen görürsün.

---

## A) SSH ile direkt yükleme (önerilen — ilk test için)

### 0. Hazırlık (araca gitmeden)

```powershell
cd C:\Users\EDIZ\Desktop\id78custom
# VIN'in SSH key'inin yerinde olduğundan emin ol
Test-Path vendor\data\enrollments\<VIN>\id_rsa
```

### 1. SSH bağlantısını test et

```powershell
# aracın IP'sini id78custom'da öğren (Araci Tanimla butonu); sonra:
ssh -i vendor\data\enrollments\<VIN>\id_rsa root@<car-ip> "hostname && uptime"
```

### 2. Tool dosyalarını yükle

```powershell
# edzco-exhaust
scp -i vendor\data\enrollments\<VIN>\id_rsa `
  EDZCO-apps\tools\edzco-exhaust\exhaust.js `
  EDZCO-apps\tools\edzco-exhaust\uds.js `
  EDZCO-apps\tools\edzco-exhaust\config.json `
  EDZCO-apps\tools\edzco-exhaust\README.md `
  root@<car-ip>:/opt/edzco-exhaust/

scp -i vendor\data\enrollments\<VIN>\id_rsa `
  EDZCO-apps\tools\edzco-exhaust\edzco-exhaust.service `
  root@<car-ip>:/etc/systemd/system/

# edzco-light
scp -i vendor\data\enrollments\<VIN>\id_rsa `
  EDZCO-apps\tools\edzco-light\light.js `
  EDZCO-apps\tools\edzco-light\uds.js `
  EDZCO-apps\tools\edzco-light\zones.js `
  EDZCO-apps\tools\edzco-light\README.md `
  root@<car-ip>:/opt/edzco-light/

scp -i vendor\data\enrollments\<VIN>\id_rsa `
  EDZCO-apps\tools\edzco-light\edzco-light.service `
  root@<car-ip>:/etc/systemd/system/
```

### 3. Servisleri başlat

```powershell
ssh -i vendor\data\enrollments\<VIN>\id_rsa root@<car-ip> @'
mkdir -p /opt/edzco-exhaust /opt/edzco-light
systemctl daemon-reload
systemctl enable --now edzco-exhaust.service edzco-light.service
systemctl --no-pager status edzco-exhaust.service edzco-light.service
'@
```

**Beklenen çıktı:** her ikisi de `Active: active (running)`.

### 4. Tool'ları hızlı ping testi

```powershell
ssh -i vendor\data\enrollments\<VIN>\id_rsa root@<car-ip> @'
echo '{"op":"ping"}' | nc -U /run/edzco-exhaust/ctl.sock -q 1
echo '{"op":"ping"}' | nc -U /run/edzco-light/ctl.sock   -q 1
'@
```

**Beklenen:** her iki soketten de `{"reply":"pong"}` döner.

### 5. Light tool — manuel bir renk yazması

Bu DME yazması gerektirmediği için **güvenli** — doğrudan BDC ambient layer'a yazar, kaybolur.

```powershell
ssh -i vendor\data\enrollments\<VIN>\id_rsa root@<car-ip> @'
# Her zone'u M Red'e boya 20 saniyeliğine (BDC otomatik 254 sn sonra kapatır)
printf '%s\n' '{"op":"set","zones":{"footwell":{"rgb":"#e1001a","brightness":60},"dash":{"rgb":"#e1001a","brightness":60},"doors":{"rgb":"#e1001a","brightness":60},"console":{"rgb":"#e1001a","brightness":60},"seats":{"rgb":"#e1001a","brightness":60},"roof":{"rgb":"#e1001a","brightness":60}}}' \
  | nc -U /run/edzco-light/ctl.sock -q 1
'@
```

**Beklenen:** araç içi her ambient zone'u 20-30 sn M Red olur. Hata çıkarsa `journalctl -u edzco-light -n 50` ile logu oku — hangi NAD'in hangi NRC ile reddedildiği yazar. `requestOutOfRange (0x31)` → o NAD aracında yok (normal, otomatik atlanacak). `conditionsNotCorrect (0x22)` → araç kontak durumu uymuyor.

### 6. Pop-Bang — ÖNCE DME DID doldurulmuş olmalı

**Bu adımı `tools/edzco-exhaust/config.json`'da en az bir ECU satırı doldurulmuş değilse ATLA.** DID yoksa tool yazmayı reddeder.

```powershell
# config'i güncelle (lokal dosyayı önce doldur, sonra push et)
scp -i vendor\data\enrollments\<VIN>\id_rsa `
  EDZCO-apps\tools\edzco-exhaust\config.json `
  root@<car-ip>:/opt/edzco-exhaust/config.json
ssh -i vendor\data\enrollments\<VIN>\id_rsa root@<car-ip> "systemctl restart edzco-exhaust.service"
```

Araç PARK halinde ve motor çalışıyorken, telefondan SSH üzerinden:

```sh
# OPEN (0.5 saniye aç, kapat)
printf '%s\n' '{"op":"popbang","hold":true,"parked":true,"engineOn":true}' | nc -U /run/edzco-exhaust/ctl.sock -q 1
sleep 0.5
printf '%s\n' '{"op":"popbang","hold":false,"parked":true,"engineOn":true}' | nc -U /run/edzco-exhaust/ctl.sock -q 1
```

**Beklenen:** egzoz valfi açılır, duyarsın. Hiçbir ses yoksa DID yanlış, `exhaust.log`'dan NRC'yi oku.

### 7. UI'dan test (opsiyonel, tool'lar çalışıyorsa)

Store'u atlayarak app'i de direkt yükleyebilirsin:

```powershell
# aşağıdakini araca kopyala
scp -i ...key... -r EDZCO-apps\apps\edzco_popbang\* root@<car-ip>:/var/opt/public/oap/dev/edzco_popbang/
scp -i ...key... -r EDZCO-apps\apps\edzco_mscene\*  root@<car-ip>:/var/opt/public/oap/dev/edzco_mscene/
# sonra araçta systemctl restart ile OAP host'u yeniden başlat
ssh -i ...key... root@<car-ip> "systemctl restart oap-dev@edzco_popbang oap-dev@edzco_mscene 2>/dev/null; systemctl list-units | grep oap"
```

Store entegrasyonu için B yolu.

---

## B) GitHub source olarak Store üzerinden

Daha temiz yöntem — her güncelleme otomatik gelir. Ama ilk kez için biraz daha uzun.

### 1. Lokal olarak git init + push

```powershell
cd C:\Users\EDIZ\Desktop\id78custom\EDZCO-apps
git init
git add .
git commit -m "Initial release: edzco_popbang + edzco_mscene"
git branch -M main
# GitHub'da EDZCO organizasyonunu ve EDZCO-apps reposunu oluştur
git remote add origin https://github.com/EDZCO/EDZCO-apps.git
git push -u origin main
```

### 2. Araçtan Store'a kaynak olarak ekle

Head unit'in orta ekranından:

1. **MGU Store** aç
2. **Settings → Sources → Add source**
3. Yaz: `EDZCO/EDZCO-apps`
4. **Save**
5. Store listesi tazelensin → `Pop-Bang` + `M Scenes` görünür
6. İkisine de **Install** bas; tool'lar otomatik kurulur
7. **Settings → Restart head unit** → 30-45 sn sonra ana ekranda app karoları çıkar

### 3. Değişiklik → araçta güncelleme

```powershell
# lokalde kod değiştir
git commit -am "fix: tighter safety for B58 DME"
git push
# araçta Store → Updates → Install
```

---

## Hata ayıklama kısa yol tablosu

| Semptom | Olası neden | Çözüm |
|---|---|---|
| `nc -U` dönmedi, hiçbir şey yazmadı | Tool çalışmıyor | `systemctl status edzco-exhaust` — log'da neden |
| `{"error":"not connected"}` app loguna düşüyor | Socket soketi yok | Tool çalışmıyor, aynı yukarıdaki |
| Light tool `NRC 31` yığını | O NAD aracında yok, zone bazen 0 iyi NAD | Normal, otomatik skip. Hiç zone yoksa BDC bu araçta ambient layering yapmıyor demektir |
| Pop-Bang `NRC 22` | Araç PARK'ta değil veya motor kapalı | Vites P'ye al, motor çalıştır, tekrar dene |
| Pop-Bang `NRC 31` | DID yanlış, bu engine family için | DID'i E-Sys'te tekrar bul, config.json güncelle |
| Pop-Bang `NRC 33` | SecurityAccess gerektiriyor | Bu engine family Pop-Bang için desteklenmiyor (SA scope dışı) |
| Hiçbir şey olmuyor, log da boş | hmictl bağlantısı yok | `systemctl status hmictl` — yoksa Store'dan `mgu-deploy` yeniden kur |

## Araç sonrası

- `/var/log/edzco-exhaust/exhaust.log` ve `/var/log/edzco-light/light.log`'u bana getir — hangi NRC'ler, hangi zone probe'ları başarılı/başarısız olmuş, hangi DID'ler çalışmış öğreniriz
- `config.json`'daki çalışan DID satırlarını commit edip GitHub'a push et — başka B58 sahipleri için referans olur
- M Scenes'de hangi zone'lar var/yok — bana söyle, scenes.js keyframe'lerini araca uygun hale getireyim
