'use strict';
/*
 * edzco_lights ("Lights") - flashes the exterior lamps in patterns through the body controller's
 * own lamp test functions.
 *
 * Everything runs in the app. The lamps are reached the way light_show (eroobeeroo, car-tested on
 * an X5 G05) and ambient_config (car-tested on a G20's BDC_G05) reach the body controller: UDS over
 * the head unit's own diagnostic transport (InternalTasu, kit/diag.js), from the OAP app. 0.1.0
 * did this in a root service through /usr/bin/hmictl, which the head unit does not have: every
 * request timed out.
 *
 *   lamps.js     light_show's LampLink: sessions, the output request layout, give-back forms, and
 *                a whitelist of the only requests it may send (PolyForm Noncommercial, vendored)
 *   patterns.js  light_show's Player: runs frames on the link (same licence, vendored)
 *   edzco_patterns.js  this app's patterns (Welcome, Goodbye, Piyasa, ...)
 *
 * Lamp check (parked): finds the output request layout and whether outputs time themselves, then
 * lights each lamp for a moment through its headlight module, its output, or its lamp function,
 * and keeps what worked in data/lamp-check.json. Patterns leave out lamps that did not work.
 *
 * Safety: show patterns run parked only and stop when the car moves; moving ones stop above their
 * speed ceiling; high-beam ones need a second press. Stop gives every lamp back and ends the
 * session; if the app dies, the body controller ends the session itself within seconds (no tester
 * present) and every lamp is the car's own again.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const Vehicle = require('./edzco_vehicle');
const { LampLink, LAMPS, KEPT, BY_ID, FN, NRC, LAYOUT, hex, why } = require('./lamps');
const { Player } = require('./patterns');
const { PATTERNS } = require('./edzco_patterns');

const W = 1600, H = 520;
const CONFIRM_MS = 5000;     // a danger arm lapses, so a stray press never leaves one primed
const CHECK_ON_MS = 1200, CHECK_GAP_MS = 600;
const ROW_H = 58, LIST_Y = 92, LIST_ROWS = 6;

const NAME = {
    lowL: 'Kisa far sol', lowR: 'Kisa far sag', highL: 'Uzun far sol', highR: 'Uzun far sag',
    drlL: 'Gunduz sol', drlR: 'Gunduz sag', fogL: 'On sis sol', fogR: 'On sis sag',
    indFL: 'Sinyal on sol', indFR: 'Sinyal on sag', indSL: 'Ayna sinyal sol', indSR: 'Ayna sinyal sag',
    indRL: 'Sinyal arka sol', indRR: 'Sinyal arka sag', rfogL: 'Arka sis sol', rfogR: 'Arka sis sag',
    revL: 'Geri vites sol', revR: 'Geri vites sag',
};
const lampName = (id) => NAME[id] || (BY_ID[id] ? BY_ID[id].name : id);

/** text cut into lines of at most n characters, at spaces where it can */
function wrap(text, n) {
    const out = [];
    let rest = String(text);
    while (rest.length > n) {
        let cut = rest.lastIndexOf(' ', n);
        if (cut < n * 0.5) cut = n;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
}

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;

        /* ---- the diagnostic link: the head unit's own transport, from this app ---- */
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true; diag.busyMs = 60;
        const diagReady = diag.init();
        const link = new LampLink(diag, log);

        /* ---- the lamp check's results, kept: { id: { ok, how, why, t }, _layout, _timer, ... } ---- */
        const FILE = path.join(ctx.dataDir || '.', 'lamp-check.json');
        let checked = {};
        try { checked = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { /* none yet */ }
        const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(checked)); } catch (e) { log.warn('lights: ' + e.message); } };
        // a lamp works through its own output, or through its lamp function when that is its side's alone
        const sideFn = (id) => !!(checked[id] && checked[id].fn && FN[id]
            && Object.keys(FN).filter((k) => FN[k] === FN[id]).every((k) => BY_ID[k].side === BY_ID[id].side));
        const usable = (id) => !BY_ID[id].outDark && (!checked[id] || checked[id].ok !== false || sideFn(id));
        const restore = () => {
            if (checked._layout && LAYOUT[checked._layout]) link.layout = LAYOUT[checked._layout];
            link.timer = checked._timer || null;
            link.noRelease = !!checked._noRelease;
            LAMPS.forEach((l) => { link.how[l.id] = checked[l.id] && checked[l.id].how === 'flm' ? 'flm' : 'out'; });
        };
        restore();

        /* ---- the car ---- */
        let doorsWere = null, awayWas = null;
        const car = Vehicle.watch(ctx, { speed: true, gear: true, doors: true, condition: true }, (what, v) => {
            if (what === 'doors') {
                if (doorsWere === false && v.doorsOpen && settings.get('autoWelcome') && v.parked() && !v.ignition()) {
                    log.info('auto-welcome on door open');
                    start(find('welcome'), 'otomatik');
                }
                doorsWere = v.doorsOpen;
            } else if (what === 'condition') {
                const away = v.away();
                if (awayWas === false && away && settings.get('autoGoodbye')) {
                    log.info('auto-goodbye on locked and left');
                    start(find('goodbye'), 'otomatik');
                }
                awayWas = away;
            }
        });
        const find = (id) => PATTERNS.find((p) => p.id === id);

        /* ---- the player ---- */
        let lit = new Set(), current = null, startedAt = 0, note = '', noteBad = false;
        const say = (text, bad) => { note = text; noteBad = !!bad; };
        const player = new Player(link, {
            log, usable, dark: darkAtStart,
            needsLayout: () => LAMPS.some((l) => link.how[l.id] !== 'flm' && usable(l.id) && !(checked[l.id] && checked[l.id].ok === false)),
            viaFn: (id) => !!(checked[id] && checked[id].ok === false && sideFn(id)),
            onFrame: (l, i) => {
                lit = new Set(l);
                // a one-shot pattern ends on its last (dark) frame
                if (current && current.once && i === current.frames.length - 1) stop('bitti');
            },
            refused: (id, nrc) => {
                checked[id] = { ok: false, why: NRC[nrc] || 'NRC ' + hex(nrc), t: Date.now() }; save();
                log.warn('lights: ' + lampName(id) + ' refused (' + checked[id].why + '): left out');
            },
        });
        /** a show starts dark: lamps on now (read back) are held off while it runs (as light_show does) */
        async function darkAtStart(p) {
            if (p.kind !== 'show' || !link.layout) return [];
            const st = await link.readStates();
            if (!st) return [];
            return LAMPS.filter((l) => link.how[l.id] === 'out' && !l.outDark && st[l.out] && l.usual !== 'brake'
                && (!l.usual || link.timer) && !(checked[l.id] && checked[l.id].ok === false)).map((l) => l.id);
        }

        /** why p may not run now, or null */
        function refusal(p) {
            if (p.kind === 'show') return car.parked() ? null : p.name + ' sadece parkta (P veya duruyor)';
            if (car.parked()) return null;
            if (car.speed === null) return 'Hiz okunamiyor: hareketli desen calistirilmiyor';
            if (p.maxSpeedKmh != null && car.speed > p.maxSpeedKmh) return p.name + ' en fazla ' + p.maxSpeedKmh + ' km/h';
            return null;
        }

        function start(p, why) {
            if (!p) return;
            if (check.running || back.running) { say('Once lamp check / iade bitsin', true); return; }
            if (player.running || player.ending) { say('Onceki desen lambalari geri veriyor, birazdan tekrar bas', true); return; }
            const no = refusal(p);
            if (no) { say(no, true); return; }
            current = p; startedAt = Date.now();
            if (!player.start(p, 1)) { say('Baslatilamadi, tekrar bas', true); return; }
            say((why ? why + ': ' : '') + p.name + ' calisiyor');
            log.info('lights: ' + p.id + ' started' + (why ? ' (' + why + ')' : ''));
        }
        async function stop(why) {
            if (!player.running) return;
            const p = current;
            log.info('lights: stopped' + (why ? ' (' + why + ')' : ''));
            await player.stop();
            current = null;
            if (player.error) say('Hata: ' + player.error, true);
            else say((p ? p.name + ' ' : '') + (why || 'durduruldu'), why && why !== 'bitti' && why !== 'durduruldu');
            render().catch(() => {});
        }
        // the stops that need no button: the car moved, too fast, the time cap
        setInterval(() => {
            if (!player.running || !current) return;
            const p = current;
            if (p.kind === 'show' && !car.parked()) stop('durdu: araba hareket etti');
            else if (p.kind === 'emergency' && !car.parked()
                     && (car.speed === null || (p.maxSpeedKmh != null && car.speed > p.maxSpeedKmh))) stop('durdu: hiz siniri');
            else if (p.capMs && Date.now() - startedAt > p.capMs) stop('bitti (sure)');
        }, 250);

        /* ---- lamp check: each lamp on for a moment, in turn ---- */
        const check = { running: false, at: -1, step: null };
        async function runCheck() {
            if (check.running || player.running || back.running) return;
            if (!car.parked()) { say('Lamp check sadece parkta', true); return; }
            check.running = true; check.at = -1; check.step = 'Teshis baglantisi aciliyor';
            say('Lamp check calisiyor');
            try {
                await diagReady;
                if (!diag.p) throw new Error('teshis baglantisi yok: ' + (diag.error || 'InternalTasu'));
                await link.start();
                checked._session = link.session;
                // the body controller's output request: the layout it takes (a moment on a reversing light)
                link.layout = null; link.probed = null; link.noRelease = false; link.releaseForm = null;
                check.step = 'BDC cikis duzeni deneniyor (geri vites sol)'; lit = new Set(['revL']);
                await link.probe();
                lit = new Set();
                checked._layout = link.layout ? link.layout.id : null;
                checked._probed = link.probed;
                if (link.layout) {
                    check.step = 'Cikislarin zamanlayicisi olculuyor (arka sis sol)'; lit = new Set(['rfogL']);
                    await link.probeTimer();
                    lit = new Set();
                }
                checked._timer = link.timer; checked._timerTried = link.timerTried;
                check.step = null;
                for (let i = 0; i < LAMPS.length && check.running; i++) {
                    const l = LAMPS[i];
                    check.at = i; lit = new Set([l.id]);
                    // 1. its headlight module, 2. its own output, 3. its lamp function
                    let r = { ok: false, nrc: null }, how = null;
                    const tried = [];
                    if (l.flm) { link.how[l.id] = 'flm'; r = await link.set(l.id, true, null, CHECK_ON_MS); tried.push('far modulu: ' + why(r)); if (r.ok) how = 'flm'; }
                    if (!how && link.layout && !l.outDark && !l.usual) { link.how[l.id] = 'out'; r = await link.set(l.id, true, null, CHECK_ON_MS); tried.push('cikis: ' + why(r)); if (r.ok) how = 'out'; }
                    let fnOk = false;
                    if (!how) { const fr = await link.fn(l.id, CHECK_ON_MS); fnOk = fr.ok; if (FN[l.id]) tried.push('fonksiyon: ' + why(fr)); }
                    await new Promise((res) => setTimeout(res, CHECK_ON_MS));
                    let gave = { ok: true };
                    if (how === 'out') gave = await link.set(l.id, false, 'release');
                    if (how === 'flm') gave = await link.set(l.id, false);
                    link.how[l.id] = how === 'flm' ? 'flm' : 'out';
                    lit = new Set();
                    checked[l.id] = how ? { ok: true, how, back: gave.ok ? (gave.timed ? 'by itself' : 'ok') : why(gave), t: Date.now(), ms: r.ms }
                        : { ok: false, fn: fnOk, why: fnOk ? 'function only' : tried.join(', ') || 'no way', t: Date.now() };
                    log.info('lamp check: ' + l.name + ': ' + (how ? 'works by its ' + (how === 'flm' ? 'headlight module' : 'output') : checked[l.id].why)
                             + ' [' + tried.join(', ') + ']');
                    await new Promise((res) => setTimeout(res, CHECK_GAP_MS));
                }
                checked._noRelease = LAMPS.some((l) => checked[l.id] && checked[l.id].how === 'out' && checked[l.id].back
                    && checked[l.id].back !== 'ok' && checked[l.id].back !== 'by itself');
                checked._t = Date.now();
                save();
                const good = LAMPS.filter((l) => checked[l.id] && (checked[l.id].ok || checked[l.id].fn)).length;
                say('Lamp check bitti: ' + good + ' / ' + LAMPS.length + ' lamba calisiyor', good === 0);
            } catch (e) {
                say('Lamp check: ' + (e.message || e), true);
                log.warn('lamp check: ' + (e.stack || e));
            }
            try { await link.stop(); } catch (e) { /* given back by the session ending */ }
            lit = new Set();
            check.running = false; check.at = -1; check.step = null;
            render().catch(() => {});
        }

        /* ---- every lamp given back, every give-back form tried; then the sessions ended ---- */
        const back = { running: false };
        async function giveAllBack() {
            if (back.running) return;
            if (player.running) await stop('lambalar geri veriliyor');
            check.running = false;
            back.running = true; say('Butun lambalar araca geri veriliyor');
            let ok = 0, refused = 0;
            try {
                await link.start();
                link.releaseForm = null; link.releaseTried = [];
                for (const l of LAMPS.concat(KEPT)) {
                    link.how[l.id] = 'out';
                    const r = await link.release(l.id, true);
                    if (r.ok) ok++; else refused++;
                    link.releaseForm = null;
                }
                restore();
                await link.stop();
                say('Geri verildi: ' + ok + ', reddedildi: ' + refused, ok === 0);
            } catch (e) { say('Geri verme: ' + (e.message || e), true); }
            back.running = false;
            render().catch(() => {});
        }

        /* ---- choosing and running ---- */
        let idx = 0, armedDanger = null, armedAt = 0;
        function toggle(i) {
            const p = PATTERNS[i];
            if (!p) return;
            idx = i;
            if (player.running && current && current.id === p.id) { stop('durduruldu'); return; }
            if (player.running) { stop('degistirildi'); return; }
            // high-beam patterns: a second press on the same one confirms
            if (p.danger && settings.get('confirmDanger')) {
                const fresh = armedDanger === p.id && Date.now() - armedAt < CONFIRM_MS;
                if (!fresh) {
                    armedDanger = p.id; armedAt = Date.now();
                    say('Selektor kullanir: onaylamak icin tekrar bas');
                    return;
                }
            }
            armedDanger = null;
            start(p);
        }
        function select(i) {
            if (i === idx) { toggle(i); return; }
            idx = i; armedDanger = null;
        }

        ui.onClick('BTN_PLAY', () => { toggle(idx); return render(); });
        ui.onClick('BTN_PAGE', () => { idx = (idx + 1) % PATTERNS.length; armedDanger = null; return render(); });
        ui.onClick('BTN_ACTION', () => {
            if (check.running) { check.running = false; say('Lamp check durduruluyor'); }
            else runCheck().catch((e) => log.warn('lamp check: ' + e));
            return render();
        });
        ui.onClick('BTN_BACK', () => { giveAllBack().catch((e) => log.warn('give back: ' + e)); return render(); });

        /* ---- the screen ---- */
        function lampState(id) {
            const c = checked[id];
            if (!c) return { text: '-', col: null };
            if (c.ok) return { text: c.how === 'flm' ? 'far modulu' : 'cikis', col: 'ok' };
            if (c.fn) return { text: 'fonksiyon', col: 'ok' };
            return { text: 'yok', col: 'bad' };
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const crit = t.crit || '#ef2b2d', good = t.accent;
            const p = PATTERNS[idx];

            /* left: the patterns, tap one to choose it, tap it again to run / stop it */
            G.panel(cv, t, 40, 44, 520, 430, 'Desenler');
            const first = Math.max(0, Math.min(idx - 2, PATTERNS.length - LIST_ROWS));
            PATTERNS.slice(first, first + LIST_ROWS).forEach((q, k) => {
                const i = first + k, y = LIST_Y + k * ROW_H, on = i === idx;
                const running = player.running && current && current.id === q.id;
                if (on) cv.roundRect(56, y, 488, ROW_H - 6, 6, t.sel || t.accent);
                cv.text(q.name, 76, y + 24, 19, on ? '#ffffff' : t.text, { font: on ? 'bold' : null });
                const tag = (q.kind === 'show' ? 'PARK' : 'HAREKET')
                    + (q.maxSpeedKmh ? '  <=' + q.maxSpeedKmh + ' km/h' : '')
                    + (q.danger ? '  SELEKTOR' : '') + (q.once ? '' : '  dongu');
                cv.text(tag, 76, y + 44, 12, on ? '#ffffff' : t.dim, { spacing: 1 });
                if (running) cv.text('CALIYOR', 528, y + 24, 14, on ? '#ffffff' : good, { align: 'right', font: 'bold' });
                if (cv.own && cv.target) cv.target(56, y, 488, ROW_H - 6, () => { select(i); return render(); }, 'pat:' + q.id);
            });

            /* right: the chosen pattern, the state, the lamp check */
            G.panel(cv, t, 600, 44, 960, 430, p ? p.name : 'Lights');
            const big = check.running ? 'LAMP CHECK' : back.running ? 'IADE' : player.running ? 'CALIYOR'
                : armedDanger ? 'ONAY' : 'HAZIR';
            cv.text(big, 1080, 128, 44, player.running || check.running ? good : (armedDanger ? t.warn : t.dim),
                    { align: 'center', font: 'bold', spacing: 5 });
            if (p) cv.text(p.what || '', 1080, 160, 15, t.dim, { align: 'center' });
            wrap(note || '', 110).slice(0, 2).forEach((l, i) => cv.text(l, 1080, 186 + i * 18, 15,
                noteBad ? crit : (armedDanger ? t.warn : t.text), { align: 'center' }));

            const lay = link.layout ? link.layout.id : (checked._layout || null);
            const works = LAMPS.filter((l) => checked[l.id] && (checked[l.id].ok || checked[l.id].fn)).length;
            const info = [
                ['Vites', car.stage || (car.parked() ? 'P (duruyor)' : '-')],
                ['Hiz', car.speed == null ? '-' : Math.round(car.speed) + ' km/h'],
                ['BDC duzeni', lay || (checked._t ? 'yok' : 'lamp check yap')],
                ['Calisan lamba', checked._t || check.running ? works + ' / ' + LAMPS.length : '-'],
            ];
            info.forEach((r, i) => {
                const x = 640 + i * 230;
                cv.text(r[0], x, 236, 13, t.dim, { spacing: 1 });
                cv.text(String(r[1]), x, 258, 17, t.text);
            });

            // lamp check progress or results: every lamp, how it is driven
            if (check.running && check.step) cv.text(check.step, 1080, 290, 15, t.warn, { align: 'center' });
            LAMPS.forEach((l, i) => {
                const col = i % 3, row = Math.floor(i / 3);
                const x = 640 + col * 300, y = 300 + row * 22 + (check.running && check.step ? 10 : 0);
                const now = check.running && check.at === i;
                const st = lampState(l.id);
                cv.text(lampName(l.id), x, y, 13, now ? t.warn : (lit.has(l.id) ? good : t.dim));
                cv.text(now ? 'yaniyor...' : st.text, x + 270, y, 13,
                        now ? t.warn : st.col === 'ok' ? good : st.col === 'bad' ? crit : t.dim, { align: 'right' });
            });

            // the link itself, so a dead transport is visible without a PC
            const s = link.stats;
            const linkLine = diag.error ? 'Teshis baglantisi: ' + diag.error
                : !diag.p ? 'Teshis baglantisi aciliyor'
                : 'Teshis: ' + (diag.available ? 'hazir' : 'bekleniyor') + ', oturum ' + (link.session || '-')
                  + '  ·  istek ' + s.sent + ', ok ' + s.ok + ', red ' + s.refused + ', cevapsiz ' + s.missed
                  + (s.last ? '  ·  son: ' + s.last : '');
            wrap(linkLine, 120).slice(0, 2).forEach((l, i) => cv.text(l, 1080, 446 + i * 16, 12,
                diag.error || (s.missed && !s.ok) ? crit : t.dim, { align: 'center' }));

            if (link.stuck && link.stuck.size) {
                const stuck = Array.from(link.stuck).map(lampName);
                cv.roundRect(600, 44, 960, 30, 6, crit);
                cv.text('GERI VERILMEDI: ' + stuck.join(', ') + ' - "Lambalari birak", olmazsa kontagi kapat-ac',
                        1080, 65, 14, '#ffffff', { align: 'center', font: 'bold' });
            }
            return ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 6, render);
        await render();
        diagReady.then(() => { log.info('lights: diagnostic link ' + (diag.p ? 'ready' : 'missing: ' + diag.error)); render().catch(() => {}); });
        process.on('exit', () => { if (player.running || check.running) log.warn('lights: closing while running: the body controller gives the lamps back in a few seconds'); });
        log.info('ready');

        return { player, link, check, start, stop, runCheck, giveAllBack, patterns: () => PATTERNS };
    },
});
