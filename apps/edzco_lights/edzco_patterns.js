'use strict';
/*
 * edzco_patterns.js - the Lights app's own patterns, in the frame format of light_show's Player
 * (patterns.js): a frame is { ms, on: [lamp ids lit] }, and only the lamps that change are sent.
 * Lamp ids are lamps.js's (lowL, highL, drlL, fogL, indFL, indRL, rfogL, revL, ... and the R side).
 *
 *   kind 'show'       parked only. Any lamp, held dark between flashes.
 *   kind 'emergency'  may run while rolling: only lamps that are normally off while driving
 *                     (Player never takes a lamp the car keeps on), and a lamp's dark phase gives
 *                     it back to the car. maxSpeedKmh is the ceiling the app enforces.
 *   once              plays the frames once; the last frame is always dark, and the app stops the
 *                     pattern when it reaches it.
 *   capMs             a looping pattern stops by itself after this long.
 *   danger            uses the high beams: the app asks for a second press to confirm.
 *
 * The rear turn signals and the mirrors' repeaters do not light through their own outputs on a
 * BDC_G05 (light_show, X5 G05): they light through their side's turn-signal function, which the
 * lamp check finds and the Player uses (viaFn). Reversing lights are never used while moving: lit
 * while driving forward they tell the car behind something false.
 */
const f = (ms, ...on) => ({ ms, on });

const FRONT = ['drlL', 'drlR'];
const FOGS = ['fogL', 'fogR'];
const HAZ = ['indFL', 'indFR', 'indRL', 'indRR'];

const PATTERNS = [
    {
        id: 'welcome', name: 'Welcome', kind: 'show', once: true,
        what: 'Gunduz farlari, sisler, sirali sinyal, geri vites isiklari: araba merhaba der',
        frames: [
            f(400, ...FRONT), f(400, ...FRONT, ...FOGS),
            f(250, ...FRONT, ...FOGS, 'indFL'), f(250, ...FRONT, ...FOGS, 'indFR'),
            f(250, ...FRONT, ...FOGS, 'indFL'), f(250, ...FRONT, ...FOGS, 'indFR'),
            f(800, ...FRONT, ...FOGS, 'revL', 'revR'), f(400, ...FRONT), f(300),
        ],
    },
    {
        id: 'goodbye', name: 'Goodbye', kind: 'show', once: true,
        what: 'Gunduz farlari iki kez, sonra arka lambalar: kilidi duydu',
        frames: [f(400, ...FRONT), f(300), f(400, ...FRONT), f(300), f(600, 'rfogL', 'rfogR', 'revL', 'revR'), f(300)],
    },
    {
        id: 'comfort_flash', name: 'Comfort Flash', kind: 'emergency', once: true, maxSpeedKmh: 90,
        what: 'Bes kez dortlu: tesekkur / ozur. Donus sinyali anlami tasimaz',
        frames: [f(250, ...HAZ), f(250), f(250, ...HAZ), f(250), f(250, ...HAZ), f(250), f(250, ...HAZ), f(250), f(250, ...HAZ), f(300)],
    },
    {
        id: 'chase', name: 'Sequential Chase', kind: 'show', capMs: 30000,
        what: 'Sinyaller arabanin etrafinda doner (30 sn)',
        frames: [f(220, 'indFL'), f(220, 'indRL'), f(220, 'indRR'), f(220, 'indFR')],
    },
    {
        id: 'hazard_dance', name: 'Hazard Dance', kind: 'show', once: true,
        what: 'Sisler, sag-sol sinyal, arka sisler, gunduz farlari: 10 sn kutlama',
        frames: [
            f(300, ...FRONT), f(300, ...FRONT, ...FOGS),
            f(300, ...FRONT, ...FOGS, 'indFL', 'indRL'), f(300, ...FRONT, ...FOGS, 'indFR', 'indRR'),
            f(300, ...FRONT, ...FOGS, 'rfogL', 'rfogR'),
            f(300, ...FRONT, ...FOGS, 'indFL', 'indRL'), f(300, ...FRONT, ...FOGS, 'indFR', 'indRR'),
            f(300, ...FRONT, ...FOGS, 'rfogL', 'rfogR'),
            f(300, ...FRONT, ...FOGS, 'indFL', 'indRL'), f(300, ...FRONT, ...FOGS, 'indFR', 'indRR'),
            f(600, ...FRONT, ...FOGS, ...HAZ, 'rfogL', 'rfogR'), f(400, ...FRONT), f(300),
        ],
    },
    {
        id: 'piyasa', name: 'Piyasa', kind: 'emergency', once: true, danger: true, maxSpeedKmh: 30,
        what: 'Sol selektor cift, sag selektor cift, sonra ikisi birden cift',
        frames: [
            f(180, 'highL'), f(160), f(180, 'highL'), f(400),
            f(180, 'highR'), f(160), f(180, 'highR'), f(400),
            f(180, 'highL', 'highR'), f(160), f(180, 'highL', 'highR'), f(300),
        ],
    },
    {
        id: 'wigwag', name: 'Wig-Wag', kind: 'emergency', danger: true, maxSpeedKmh: 30, capMs: 15000,
        what: 'Sol-sag donusumlu selektor (15 sn)',
        frames: [f(350, 'highL'), f(350, 'highR')],
    },
    {
        id: 'rear_alert', name: 'Rear Alert', kind: 'emergency', maxSpeedKmh: 50, capMs: 20000,
        what: 'Arka sisler yanip soner: sadece arkadan gorunur (20 sn)',
        frames: [f(350, 'rfogL', 'rfogR'), f(350)],
    },
];

const BY_ID = {};
PATTERNS.forEach((p) => { BY_ID[p.id] = p; });

module.exports = { PATTERNS, BY_ID };
