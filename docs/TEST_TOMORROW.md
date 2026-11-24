# Araçta ilk gün

## Önce: ne kurulur, ne kurulmaz

| | Durum |
|---|---|
| **edzco-sound** (tool) | Kurulur ve çalışır. Düz dosya + systemd unit, SDK istemez. |
| **edzco-lights** (tool) | Aynı. |
| **Pop-Bang** (app) | **Kurulmaz** — `oap-sdk` çıkarılana kadar Store paketleyemez. |
| **Lights** (app) | Aynı. |

Her MGU app reposu böyle; ENJATZ da açıkça yazmış: *"An installable package requires BMW's oap-sdk, extracted from your own head unit."* SDK dağıtılabilir değil, o yüzden hiçbir repo içine koymuyor.

Yani ilk gün **tool'ları kurup soketlerinden test ediyoruz**. App'lerin arayüzü SDK çıktıktan sonra.

---

## 1. SDK'yı çıkar (her şeyden önce)

```sh
ssh -i vendor/data/enrollments/<VIN>/id_rsa root@<car-ip> \
  'find / -type d -name "oap-sdk" 2>/dev/null; ls /var/opt/public/oap/*/source/node_modules/ 2>/dev/null | head'
```

Bulunca çek:

```sh
scp -r -i vendor/data/enrollments/<VIN>/id_rsa \
  root@<car-ip>:/var/opt/public/oap/oap_*/source/node_modules/oap-sdk ./oap-sdk/
```

Bu olmadan app'ler derlenmez. Çıktıyı bana gönder, `kit/build.js`'i ona göre bağlarım.

---

## 2. Store'a kaynak ekle

Araç ekranından: **MGU Store → Settings → Add source → `EDZCO/EDZCO-apps`**

Store repoyu çeker. **Tool'lar listede görünür ve kurulur.** App'ler build adımında SDK yok diye hata verir — beklenen davranış, `kit/build.js` neyin eksik olduğunu açıkça yazar.

---

## 3. Ses yolunu doğrula (en kritik bilinmeyen)

Tool kurulduktan sonra:

```sh
echo '{"op":"probe"}' | nc -U /run/edzco-sound/ctl.sock -q 2
```

Üç şeye bak:

- `aplay` var mı
- `deviceOk: true` mi — yani `plug:smartx:CarLifeMedia_CF_48_STEREO` bu firmware'de var mı
- `pcms` listesinde CarLifeMedia geçen başka bir ad var mı

Ad farklıysa unit'te değiştir:
```
Environment=EDZCO_PCM=plug:smartx:<aplay -L ne diyorsa>
```

Sonra ses çal:
```sh
echo '{"op":"play","id":"ex_pop_30"}' | nc -U /run/edzco-sound/ctl.sock -q 3
```

> Bu tek başına **duyulmayabilir.** Ses ancak AudioManager 287→1024 rotası açıkken hoparlöre çıkar, o rotayı app kuruyor. SDK'sız app olmadığı için rotayı elle kurmak gerekir — o adımı birlikte yaparız. `played` cevabı gelirse PCM yazımı çalışıyor demektir, yarısı tamam.

---

## 4. Lamba yolunu doğrula

```sh
echo '{"op":"lamp_check"}' | nc -U /run/edzco-lights/ctl.sock -q 60
```

50 saniye sürer, her lambayı 1.2 sn yakar. Çıktıda:

- `layouts.bdcOut` — BDC hangi output düzenini kabul etti (A/B/C/D/E), hiçbiri değilse `null`
- `capable` — her lamba hangi yoldan sürülebildi (`bdc_out:A` / `flm:L` / `bdc_fn`)

Araç **park halinde, kontak açık** olsun.

Tek lamba denemek için:
```sh
echo '{"op":"lamp","id":"fog_rear","on":true}'  | nc -U /run/edzco-lights/ctl.sock -q 2
echo '{"op":"lamp","id":"fog_rear","on":false}' | nc -U /run/edzco-lights/ctl.sock -q 2
```

---

## Sorun çıkarsa

| Belirti | Bak |
|---|---|
| Soket cevap vermiyor | `systemctl status edzco-sound` — unit açılmış mı |
| Log yok | `journalctl -u edzco-sound -n 50` (unit'te `StandardOutput=journal` var) |
| `aplay: command not found` | Bu firmware'de ALSA aracı yok; `probe` çıktısını bana gönder |
| Lambalarda `NRC 31` yığını | O NAD bu araçta yok — normal, otomatik atlanır |
| Lambalarda `NRC 22` | Araç park değil veya kontak kapalı |
| Hiç `bdc_out` düzeni tutmadı | FLM/BDC fonksiyon yoluna düşer, yine çalışır ama yan yan |

---

## Dönüşte bana getir

- `probe` çıktısı (ses cihazı adı)
- `lamp_check` çıktısı (`layouts` + `capable`)
- `journalctl -u edzco-sound -u edzco-lights -n 200`
- `oap-sdk` klasörü

Bunlarla hem ses rotasını hem lamba yollarını araca özel sabitleriz, hem de app'leri derleyebilir hale geliriz.
