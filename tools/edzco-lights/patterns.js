'use strict';
/*
 * patterns.js - choreographies the daemon can run over the exterior lamps.
 *
 * A pattern is { id, name, group, durationMs, loop, parkedOnly, danger, steps: [
 *   { atMs, lamps: [lampId], fn: 'on' | 'off' | 'release' }
 * ]}. The daemon walks the steps in time and routes each lamp through the best path the lamp
 * check learnt (BDC output -> FLM function -> BDC function, in that order). Lamps the car
 * refuses stay the car's own.
 *
 * ---------------------------------------------------------------------------------------
 * 'off' vs 'release' - the distinction the moving group is built on
 *
 *   off      we keep the lamp and hold it dark. The car cannot light it either: flick the
 *            indicator stalk and nothing happens. Fine parked, wrong while driving.
 *   release  we hand the output back to the ECU (2F E3B5 00 <output>, or a function written
 *            with time 0). The car owns the lamp again immediately and its own logic works.
 *
 * A moving pattern uses 'release' between flashes, never 'off', so that between our flashes
 * the car's own indicators, brake lights and low beams behave exactly as they always do.
 * ---------------------------------------------------------------------------------------
 *
 * Groups:
 *   show    parked only. Free to hold lamps dark and to use any lamp, because nobody is
 *           reading them as traffic signals.
 *   moving  may run while the car is driving. Built to three rules:
 *             1. only lamps that are normally OFF while driving (high beams, fogs, reverse,
 *                rear fog) - never the brake, tail, number plate or low beams;
 *             2. 'release' between every flash, so the car keeps its own control;
 *             3. a speed ceiling (maxSpeedKmh) - the app refuses above it.
 *           Indicator-based choreography is deliberately NOT in this group: other drivers
 *           act on your indicators, and a chase pattern signals turns you are not making.
 *
 * Safety flags:
 *   parkedOnly    the app refuses to start unless CDS says the gear is in P
 *   danger        uses the high beams; the app asks for an explicit confirm first
 *   maxSpeedKmh   moving patterns only: refuse above this road speed
 *
 * Attribution: the moving-group design - lamps normally off while driving, handing each one
 * back between flashes so the car's own lights stay its own - is eroobeeroo/idrive7-apps
 * light_show's (MIT). The individual routines here are original.
 */

/**
 * WELCOME - "car says hello" when the user walks up.
 * Running order (on a G-series car): headlights blink slowly, DRL wakes, front fog sweep, turn
 * signals sequential chase outward. 6 s, one-shot. Safe to run while parked - it is the welcome
 * the OEM does on Comfort Access anyway.
 */
const welcome = {
    id: 'welcome',
    name: 'Welcome',
    group: 'show',
    durationMs: 6000,
    loop: false,
    parkedOnly: true,
    danger: false,
    description: 'Headlights + DRL + fog + sequential turn signals say hello.',
    steps: [
        // t=0: nothing (one tick of silence)
        { atMs:  200, lamps: ['drl_l',       'drl_r'],       fn: 'on' },
        { atMs:  600, lamps: ['fog_front_l', 'fog_front_r'], fn: 'on' },
        { atMs: 1200, lamps: ['turn_fl'],                    fn: 'on' },
        { atMs: 1400, lamps: ['turn_fr'],                    fn: 'on' },
        { atMs: 1800, lamps: ['turn_fl',     'turn_fr'],     fn: 'off' },
        // repeat the chase once
        { atMs: 2400, lamps: ['turn_fl'],                    fn: 'on' },
        { atMs: 2600, lamps: ['turn_fr'],                    fn: 'on' },
        { atMs: 3000, lamps: ['turn_fl',     'turn_fr'],     fn: 'off' },
        // settle
        { atMs: 5000, lamps: ['fog_front_l', 'fog_front_r'], fn: 'off' },
        { atMs: 5500, lamps: ['drl_l',       'drl_r'],       fn: 'off' },
    ],
};

/**
 * GOODBYE - the leaving-home counterpart. Headlights fade, DRL pulse once, done. The OEM has
 * its own goodbye; this is just a shorter echo to confirm the car heard the lock.
 */
const goodbye = {
    id: 'goodbye',
    name: 'Goodbye',
    group: 'show',
    durationMs: 3000,
    loop: false,
    parkedOnly: true,
    danger: false,
    description: 'DRL pulse to acknowledge the lock.',
    steps: [
        { atMs:   0, lamps: ['drl_l', 'drl_r'], fn: 'on' },
        { atMs: 400, lamps: ['drl_l', 'drl_r'], fn: 'off' },
        { atMs: 800, lamps: ['drl_l', 'drl_r'], fn: 'on' },
        { atMs:1200, lamps: ['drl_l', 'drl_r'], fn: 'off' },
    ],
};

/**
 * COMFORT FLASH - five sequential turn-signal flashes to acknowledge something (e.g., a remote
 * command, a diagnostic success). The only pattern where parkedOnly can be false (engine must
 * still be on, and the car itself won't let indicators run while above a couple of km/h anyway).
 */
const ALL_TURN = ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'];
const comfortFlash = {
    id: 'comfort_flash',
    name: 'Comfort Flash',
    group: 'moving',
    durationMs: 2500,
    loop: false,
    parkedOnly: false,
    danger: false,
    maxSpeedKmh: 90,
    // All four indicators together is the hazard-light gesture, which traffic already reads
    // as "thanks" or "sorry" - unlike a chase, it never signals a turn. That is why this is
    // the one indicator pattern allowed to move, and it releases between every flash.
    description: 'Five hazard flashes, both sides, as an acknowledgement.',
    steps: [
        { atMs:    0, lamps: ALL_TURN, fn: 'on' },
        { atMs:  250, lamps: ALL_TURN, fn: 'release' },
        { atMs:  500, lamps: ALL_TURN, fn: 'on' },
        { atMs:  750, lamps: ALL_TURN, fn: 'release' },
        { atMs: 1000, lamps: ALL_TURN, fn: 'on' },
        { atMs: 1250, lamps: ALL_TURN, fn: 'release' },
        { atMs: 1500, lamps: ALL_TURN, fn: 'on' },
        { atMs: 1750, lamps: ALL_TURN, fn: 'release' },
        { atMs: 2000, lamps: ALL_TURN, fn: 'on' },
        { atMs: 2250, lamps: ALL_TURN, fn: 'release' },
    ],
};

/**
 * SEQUENTIAL CHASE - a visible turn-signal sweep useful at a show. Front-left -> rear-left ->
 * (pause) -> front-right -> rear-right -> (pause), repeating until the pattern ends. Parked only.
 */
const sequentialChase = {
    id: 'sequential_chase',
    name: 'Sequential Chase',
    group: 'show',
    durationMs: 8000,
    loop: true,
    cap_ms: 30000,                 // the daemon caps this at 30 s regardless
    parkedOnly: true,
    danger: false,
    description: 'A dynamic turn-signal sweep front-to-back, both sides.',
    steps: [
        { atMs:    0, lamps: ['turn_fl'], fn: 'on' },
        { atMs:  200, lamps: ['turn_rl'], fn: 'on' },
        { atMs:  400, lamps: ['turn_fl'], fn: 'off' },
        { atMs:  600, lamps: ['turn_rl'], fn: 'off' },
        { atMs: 1000, lamps: ['turn_fr'], fn: 'on' },
        { atMs: 1200, lamps: ['turn_rr'], fn: 'on' },
        { atMs: 1400, lamps: ['turn_fr'], fn: 'off' },
        { atMs: 1600, lamps: ['turn_rr'], fn: 'off' },
        // dark pause then repeat
        { atMs: 2000, lamps: ['turn_fl'], fn: 'on' },
        { atMs: 2200, lamps: ['turn_rl'], fn: 'on' },
        { atMs: 2400, lamps: ['turn_fl'], fn: 'off' },
        { atMs: 2600, lamps: ['turn_rl'], fn: 'off' },
        { atMs: 3000, lamps: ['turn_fr'], fn: 'on' },
        { atMs: 3200, lamps: ['turn_rr'], fn: 'on' },
        { atMs: 3400, lamps: ['turn_fr'], fn: 'off' },
        { atMs: 3600, lamps: ['turn_rr'], fn: 'off' },
    ],
};

/**
 * HAZARD DANCE - celebration: fogs + sequential chase + DRL pulse. Parked-only, 10 s, one-shot.
 * Uses no brake lights (the car keeps those). Harmless but visible.
 */
const hazardDance = {
    id: 'hazard_dance',
    name: 'Hazard Dance',
    group: 'show',
    durationMs: 10000,
    loop: false,
    parkedOnly: true,
    danger: false,
    description: 'A ten-second parked celebration: fogs, sequential chase and DRL pulse.',
    steps: [
        { atMs:    0, lamps: ['drl_l', 'drl_r'],                             fn: 'on' },
        { atMs:  300, lamps: ['fog_front_l', 'fog_front_r'],                 fn: 'on' },
        { atMs:  600, lamps: ['turn_fl', 'turn_rl'],                         fn: 'on' },
        { atMs:  900, lamps: ['turn_fl', 'turn_rl'],                         fn: 'off' },
        { atMs:  900, lamps: ['turn_fr', 'turn_rr'],                         fn: 'on' },
        { atMs: 1200, lamps: ['turn_fr', 'turn_rr'],                         fn: 'off' },
        { atMs: 1500, lamps: ['fog_rear'],                                   fn: 'on' },
        { atMs: 1800, lamps: ['turn_fl', 'turn_rl'],                         fn: 'on' },
        { atMs: 2100, lamps: ['turn_fl', 'turn_rl'],                         fn: 'off' },
        { atMs: 2100, lamps: ['turn_fr', 'turn_rr'],                         fn: 'on' },
        { atMs: 2400, lamps: ['turn_fr', 'turn_rr'],                         fn: 'off' },
        { atMs: 2700, lamps: ['fog_rear'],                                   fn: 'off' },
        // keep chasing a few more cycles, then wind down
        { atMs: 8500, lamps: ['fog_front_l', 'fog_front_r'],                 fn: 'off' },
        { atMs: 9500, lamps: ['drl_l', 'drl_r'],                             fn: 'off' },
    ],
};

/**
 * PIYASA - the headlight-flasher salute, the way it is done cruising a strip: a double
 * flash from the left high beam, a double from the right, then a double from both.
 *
 * In the moving group on purpose: "piyasa yapmak" IS done rolling, at walking pace down a
 * boulevard. Parked-only would miss the point. The risk is bounded instead:
 *   - maxSpeedKmh 30, so this is the slow cruise it is meant to be and not a high-beam
 *     flash into oncoming traffic at speed;
 *   - every flash is ~180 ms and ends in 'release', so between flashes the headlights are
 *     the car's own and its auto high beam / flash-to-pass work normally;
 *   - danger: true, so the app confirms before the first run.
 *
 * Rhythm: ~180 ms lit, ~160 ms dark inside a pair, ~400 ms rest between the three phases so
 * each one reads as its own gesture.
 */
const piyasa = {
    id: 'piyasa',
    name: 'Piyasa',
    group: 'moving',
    durationMs: 2600,
    loop: false,
    parkedOnly: false,
    danger: true,
    maxSpeedKmh: 30,
    description: 'Sol selektör çift, sağ selektör çift, sonra ikisi birden çift.',
    steps: [
        // sol çift
        { atMs:    0, lamps: ['high_beam_l'], fn: 'on' },
        { atMs:  180, lamps: ['high_beam_l'], fn: 'release' },
        { atMs:  340, lamps: ['high_beam_l'], fn: 'on' },
        { atMs:  520, lamps: ['high_beam_l'], fn: 'release' },
        // sağ çift
        { atMs:  920, lamps: ['high_beam_r'], fn: 'on' },
        { atMs: 1100, lamps: ['high_beam_r'], fn: 'release' },
        { atMs: 1260, lamps: ['high_beam_r'], fn: 'on' },
        { atMs: 1440, lamps: ['high_beam_r'], fn: 'release' },
        // ikisi birden çift
        { atMs: 1840, lamps: ['high_beam_l', 'high_beam_r'], fn: 'on' },
        { atMs: 2020, lamps: ['high_beam_l', 'high_beam_r'], fn: 'release' },
        { atMs: 2180, lamps: ['high_beam_l', 'high_beam_r'], fn: 'on' },
        { atMs: 2360, lamps: ['high_beam_l', 'high_beam_r'], fn: 'release' },
    ],
};

/**
 * WIG-WAG - the alternating high-beam flash an emergency vehicle uses. Loops until stopped
 * or the 15 s cap, releasing each side the moment the other lights, so at any instant at
 * most one headlight is ours and the car keeps the rest.
 *
 * Same speed ceiling as Piyasa: this is for getting attention in slow traffic, not for
 * running down a motorway behind someone.
 */
const wigwag = {
    id: 'wigwag',
    name: 'Wig-Wag',
    group: 'moving',
    durationMs: 1000,
    loop: true,
    cap_ms: 15000,
    parkedOnly: false,
    danger: true,
    maxSpeedKmh: 30,
    description: 'Sol-sağ dönüşümlü selektör. Her geçişte diğer taraf araca iade edilir.',
    steps: [
        { atMs:   0, lamps: ['high_beam_l'], fn: 'on' },
        { atMs: 240, lamps: ['high_beam_l'], fn: 'release' },
        { atMs: 260, lamps: ['high_beam_r'], fn: 'on' },
        { atMs: 500, lamps: ['high_beam_r'], fn: 'release' },
        { atMs: 520, lamps: ['high_beam_l'], fn: 'on' },
        { atMs: 760, lamps: ['high_beam_l'], fn: 'release' },
        { atMs: 780, lamps: ['high_beam_r'], fn: 'on' },
        { atMs: 980, lamps: ['high_beam_r'], fn: 'release' },
    ],
};

/**
 * REAR ALERT - rear fog and the reversing lamps alternating, for the car behind. Nothing
 * here points forward, so oncoming traffic sees nothing at all. Useful to make yourself
 * seen from behind in fog or standing traffic.
 */
const rearAlert = {
    id: 'rear_alert',
    name: 'Rear Alert',
    group: 'moving',
    durationMs: 1200,
    loop: true,
    cap_ms: 20000,
    parkedOnly: false,
    danger: false,
    maxSpeedKmh: 50,
    description: 'Arka sis + geri vites lambaları dönüşümlü. Sadece arkadan görünür.',
    steps: [
        { atMs:    0, lamps: ['fog_rear'], fn: 'on' },
        { atMs:  300, lamps: ['fog_rear'], fn: 'release' },
        { atMs:  320, lamps: ['reverse_l', 'reverse_r'], fn: 'on' },
        { atMs:  620, lamps: ['reverse_l', 'reverse_r'], fn: 'release' },
        { atMs:  640, lamps: ['fog_rear'], fn: 'on' },
        { atMs:  940, lamps: ['fog_rear'], fn: 'release' },
        { atMs:  960, lamps: ['reverse_l', 'reverse_r'], fn: 'on' },
        { atMs: 1180, lamps: ['reverse_l', 'reverse_r'], fn: 'release' },
    ],
};

/**
 * LAMP CHECK (diagnostic) - cycles every non-dangerous lamp on for 1.2 s so the operator can
 * see which ones the car took. Mirrors eroobeeroo's lamp check page. Parked only, 50 s run.
 * The page/UI uses the result of this run to light or grey each lamp in the Freeform tab.
 */
const lampCheck = {
    id: 'lamp_check',
    name: 'Lamp Check',
    group: 'show',
    durationMs: 50000,
    loop: false,
    parkedOnly: true,
    danger: false,
    diagnostic: true,
    description: 'Cycles every safe lamp for 1.2 s each so you can see which ones the car took.',
    steps: [], // the daemon generates steps for this one from LAMPS at run time
};

const PATTERNS = [
    // show group: parked only
    welcome, goodbye, comfortFlash, sequentialChase, hazardDance,
    // moving group: may run while driving, under their own speed ceiling
    piyasa, wigwag, rearAlert,
    // diagnostic
    lampCheck,
];

/** the lamps a pattern touches, for the UI and for the moving-group rule check */
function lampsOf(pattern) {
    const set = new Set();
    (pattern.steps || []).forEach((s) => (s.lamps || []).forEach((l) => set.add(l)));
    return Array.from(set);
}

module.exports = { PATTERNS, lampsOf };
