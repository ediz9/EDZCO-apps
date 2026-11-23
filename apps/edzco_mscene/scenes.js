'use strict';
/*
 * scenes.js - scene catalogue for M Scenes. A scene is a timeline of keyframes that each specify
 * the colour and brightness of named zones (dash, doors, footwell, console, seats, roof) at a
 * given time. The runner (main.js) interpolates between keyframes at the frame rate the Light
 * tool exposes and sends the composite to the tool as a single `set` op per frame.
 *
 * The zone names match the Light tool's tool-side map, which in turn matches the ambient-light
 * zones defined by IterioDev's iteriodev-comfort (BDC_G05 TAB_INNENLICHT_VERBAUORT_LIN). Keep
 * them stable: a renamed zone becomes untargetable.
 *
 *   zone colour: #rrggbb hex string, or null to leave as the car's own colour
 *   zone brightness: 0..100 (%); below 10 is treated as off by the tool
 *
 * A timeline is { duration_ms, loop, keyframes: [{ t: 0..1, zones: {name: {rgb, brightness}}}] }.
 */

const ZONES = ['dash', 'doors', 'footwell', 'console', 'seats', 'roof'];

const M_BLUE = '#81c4ff';
const M_MID  = '#16588e';
const M_RED  = '#e7222e';
const WARM_AMBER = '#ff9d00';
const WARM_PEACH = '#ff6b4a';
const COOL_MAGENTA = '#b050dc';
const NIGHT_AMBER = '#c86a16';
const DEEP_WHITE = '#f4f7fb';

/* ---------------------------------------------------------------- Welcome */
// Each door opens: cabin lights up its half corner-first (footwell -> seat ->
// door -> dash), then the other half follows. Settles on a warm amber steady
// state. 5 s run, no loop.
const welcome = {
    id: 'welcome',
    name: 'Welcome',
    duration_ms: 5000,
    loop: false,
    description: 'Cabin lights up corner to corner when a door opens, settling on a warm amber.',
    keyframes: [
        { t: 0.00, zones: { footwell: { rgb: NIGHT_AMBER, brightness: 20 } } },
        { t: 0.15, zones: { footwell: { rgb: WARM_PEACH,  brightness: 70 } } },
        { t: 0.30, zones: { footwell: { rgb: WARM_AMBER,  brightness: 80 },
                             seats:    { rgb: WARM_PEACH,  brightness: 50 } } },
        { t: 0.45, zones: { seats:    { rgb: WARM_AMBER,  brightness: 70 },
                             doors:    { rgb: WARM_PEACH,  brightness: 50 } } },
        { t: 0.60, zones: { doors:    { rgb: WARM_AMBER,  brightness: 80 },
                             console:  { rgb: WARM_PEACH,  brightness: 60 },
                             dash:     { rgb: WARM_PEACH,  brightness: 40 } } },
        { t: 0.80, zones: { console:  { rgb: WARM_AMBER,  brightness: 80 },
                             dash:     { rgb: WARM_AMBER,  brightness: 70 },
                             roof:     { rgb: WARM_AMBER,  brightness: 20 } } },
        { t: 1.00, zones: { footwell: { rgb: WARM_AMBER,  brightness: 50 },
                             doors:    { rgb: WARM_AMBER,  brightness: 50 },
                             seats:    { rgb: WARM_AMBER,  brightness: 40 },
                             console:  { rgb: WARM_AMBER,  brightness: 60 },
                             dash:     { rgb: WARM_AMBER,  brightness: 60 },
                             roof:     { rgb: WARM_AMBER,  brightness: 20 } } },
    ],
};

/* ---------------------------------------------------------------- M Mode */
// Static M tricolour pattern: blue on the driver's half (dash, door, seat,
// footwell on that side read as the mid blue), dark blue centre (console,
// roof), red on the passenger's half. Steady, no animation - a signature
// setup to switch to when the mood calls for it.
const mmode = {
    id: 'mmode',
    name: 'M Mode',
    duration_ms: 2500,
    loop: false,
    description: 'The M tricolour settled across the cabin: blue driver side, dark blue centre, red passenger side.',
    keyframes: [
        { t: 0.00, zones: { footwell: { rgb: NIGHT_AMBER, brightness: 15 },
                             doors:    { rgb: NIGHT_AMBER, brightness: 15 },
                             seats:    { rgb: NIGHT_AMBER, brightness: 15 },
                             console:  { rgb: NIGHT_AMBER, brightness: 15 },
                             dash:     { rgb: NIGHT_AMBER, brightness: 15 },
                             roof:     { rgb: NIGHT_AMBER, brightness: 15 } } },
        { t: 0.50, zones: { footwell: { rgb: M_BLUE, brightness: 60 },
                             doors:    { rgb: M_BLUE, brightness: 50 },
                             seats:    { rgb: M_MID,  brightness: 40 },
                             console:  { rgb: M_MID,  brightness: 70 },
                             dash:     { rgb: M_RED,  brightness: 70 },
                             roof:     { rgb: M_MID,  brightness: 20 } } },
        { t: 1.00, zones: { footwell: { rgb: M_BLUE, brightness: 70 },
                             doors:    { rgb: M_BLUE, brightness: 60 },
                             seats:    { rgb: M_MID,  brightness: 50 },
                             console:  { rgb: M_MID,  brightness: 80 },
                             dash:     { rgb: M_RED,  brightness: 80 },
                             roof:     { rgb: M_MID,  brightness: 30 } } },
    ],
};

/* ------------------------------------------------------------- Celebration */
// A loop: a rainbow wave sweeps across every zone, each zone phase-shifted so
// the whole cabin reads as one moving spectrum. 8-second loop, 30-second cap.
// Used for parties / handover / that-moment-a-friend-sees-it-first.
const celebration = {
    id: 'celebration',
    name: 'Celebration',
    duration_ms: 8000,
    loop: true,
    cap_ms: 30000,
    description: 'A rainbow wave sweeps across the cabin for half a minute.',
    _generated: true,  // keyframes built programmatically to keep the file readable
};

/* ---------------------------------------------------------------- Sunset */
// Warm amber under the dash shading up to cool magenta on the roof. No
// animation - a calm, cinematic stop. Pairs well with the M Scenes "Freeform"
// per-zone tab for small tweaks.
const sunset = {
    id: 'sunset',
    name: 'Sunset',
    duration_ms: 3000,
    loop: false,
    description: 'Warm amber at the floor, cool magenta at the roof - a calm, cinematic stop.',
    keyframes: [
        { t: 0.00, zones: { footwell: { rgb: NIGHT_AMBER, brightness: 20 },
                             doors:    { rgb: NIGHT_AMBER, brightness: 15 },
                             seats:    { rgb: NIGHT_AMBER, brightness: 10 },
                             console:  { rgb: NIGHT_AMBER, brightness: 15 },
                             dash:     { rgb: NIGHT_AMBER, brightness: 15 },
                             roof:     { rgb: NIGHT_AMBER, brightness: 5  } } },
        { t: 1.00, zones: { footwell: { rgb: WARM_AMBER,   brightness: 70 },
                             doors:    { rgb: WARM_PEACH,   brightness: 60 },
                             seats:    { rgb: WARM_PEACH,   brightness: 50 },
                             console:  { rgb: '#d04080',    brightness: 50 },
                             dash:     { rgb: '#a0408c',    brightness: 60 },
                             roof:     { rgb: COOL_MAGENTA, brightness: 40 } } },
    ],
};

/* ------------------------------------------------------------- Night Drive */
// A dim, warm steady state meant for after-dark driving. Nothing above 25%
// brightness so it does not distract. Fades in over 2 s from whatever was on.
const nightDrive = {
    id: 'night',
    name: 'Night Drive',
    duration_ms: 2000,
    loop: false,
    description: 'A dim warm steady state for after-dark driving. Nothing above 25% brightness.',
    keyframes: [
        { t: 0.00, zones: { footwell: { rgb: NIGHT_AMBER, brightness: 5 },
                             doors:    { rgb: NIGHT_AMBER, brightness: 5 },
                             seats:    { rgb: NIGHT_AMBER, brightness: 5 },
                             console:  { rgb: NIGHT_AMBER, brightness: 5 },
                             dash:     { rgb: NIGHT_AMBER, brightness: 5 },
                             roof:     { rgb: NIGHT_AMBER, brightness: 5 } } },
        { t: 1.00, zones: { footwell: { rgb: NIGHT_AMBER, brightness: 25 },
                             doors:    { rgb: NIGHT_AMBER, brightness: 20 },
                             seats:    { rgb: NIGHT_AMBER, brightness: 15 },
                             console:  { rgb: NIGHT_AMBER, brightness: 25 },
                             dash:     { rgb: NIGHT_AMBER, brightness: 20 },
                             roof:     { rgb: NIGHT_AMBER, brightness: 10 } } },
    ],
};

/* ---------------------- programmatic: celebration rainbow wave ---------- */
function hsvRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
}

function buildCelebration() {
    const steps = 16;
    const zonePhase = { dash: 0, doors: 60, footwell: 120, console: 180, seats: 240, roof: 300 };
    const kf = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const zones = {};
        for (const z of ZONES) {
            zones[z] = { rgb: hsvRgb(zonePhase[z] + t * 360, 1, 1), brightness: 70 };
        }
        kf.push({ t, zones });
    }
    celebration.keyframes = kf;
    return celebration;
}
buildCelebration();

const SCENES = [welcome, mmode, celebration, sunset, nightDrive];

module.exports = { SCENES, ZONES };
