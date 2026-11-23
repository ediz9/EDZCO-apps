'use strict';
/*
 * patterns.js - choreographies the daemon can run over the exterior lamps.
 *
 * A pattern is { id, name, durationMs, loop, parkedOnly, danger, steps: [
 *   { atMs, lamps: [lampId], fn: 'on'|'off'|'flash'|'func', side?: 'L'|'R'|'-', opts?: {...} }
 * ]}. The daemon walks the steps in time; a step's `fn` is the kit action that drives one or
 * more lamps, and the daemon routes each lamp through the best path the lamp check learnt
 * (BDC output -> FLM function -> BDC function, in that order). Lamps the car refuses stay the
 * car's own.
 *
 * Safety:
 *   parkedOnly     - the app refuses to start a pattern while the gear is not P (default true
 *                    on every pattern; only Comfort Flash ships parkedOnly: false and still
 *                    needs engineOn true)
 *   danger         - uses high beams or flooding patterns that would annoy traffic; the app
 *                    needs explicit confirm; refuses on public roads (no GPS is checked, just
 *                    parked + ignition state and an UI confirm)
 *
 * Attribution: the Emergency and Show pattern groups are inspired by eroobeeroo/idrive7-apps
 * light_show (MIT). The welcome / comfort flash routines are original.
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
const comfortFlash = {
    id: 'comfort_flash',
    name: 'Comfort Flash',
    durationMs: 2500,
    loop: false,
    parkedOnly: false,
    danger: false,
    description: 'Five turn-signal flashes, both sides, as an acknowledgement.',
    steps: [
        { atMs:    0, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'on' },
        { atMs:  250, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'off' },
        { atMs:  500, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'on' },
        { atMs:  750, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'off' },
        { atMs: 1000, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'on' },
        { atMs: 1250, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'off' },
        { atMs: 1500, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'on' },
        { atMs: 1750, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'off' },
        { atMs: 2000, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'on' },
        { atMs: 2250, lamps: ['turn_fl', 'turn_rl', 'turn_fr', 'turn_rr'], fn: 'off' },
    ],
};

/**
 * SEQUENTIAL CHASE - a visible turn-signal sweep useful at a show. Front-left -> rear-left ->
 * (pause) -> front-right -> rear-right -> (pause), repeating until the pattern ends. Parked only.
 */
const sequentialChase = {
    id: 'sequential_chase',
    name: 'Sequential Chase',
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
 * LAMP CHECK (diagnostic) - cycles every non-dangerous lamp on for 1.2 s so the operator can
 * see which ones the car took. Mirrors eroobeeroo's lamp check page. Parked only, 50 s run.
 * The page/UI uses the result of this run to light or grey each lamp in the Freeform tab.
 */
const lampCheck = {
    id: 'lamp_check',
    name: 'Lamp Check',
    durationMs: 50000,
    loop: false,
    parkedOnly: true,
    danger: false,
    diagnostic: true,
    description: 'Cycles every safe lamp for 1.2 s each so you can see which ones the car took.',
    steps: [], // the daemon generates steps for this one from LAMPS at run time
};

const PATTERNS = [welcome, goodbye, comfortFlash, sequentialChase, hazardDance, lampCheck];

module.exports = { PATTERNS };
