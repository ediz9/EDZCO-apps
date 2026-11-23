'use strict';
/*
 * lamps.js - the car's exterior lamps, one by one, through BMW's own test functions.
 *
 * Addresses (G-series body: BDC_G05 / BDC_G11):
 *   BDC body controller   0x40
 *   FLM left headlight    0x43  (FLM02_L)
 *   FLM right headlight   0x44  (FLM02_R)
 *
 * Three UDS write shapes it uses (SGBD labels):
 *
 *   LICHT_AUSGANG_DIGITAL_STEUERN - 0x2F I/O control on 0xE3B5 at BDC
 *       2F E3 B5 03 <output> <on=1/off=0> 00                  (G05 layout the lamp check learns)
 *     one lamp output at a time, each side its own. The SGBD names the arguments but not the
 *     layout; the G05 refused several obvious ones. Needs a learnt layout: see LAYOUTS.
 *
 *   LEUCHTEN_FUNKTION - 0x2E on 0xD542 at BDC
 *       2E D5 42 <function hi> <function lo> <time, 10 ms units>
 *     a lamp function for a time, both sides at once (except the turn signals, which have
 *     separate function ids per side).
 *
 *   FLM_FUNKTION_LICHTVERTEILUNG - 0x2E on 0xD6DC at FLM (one module per side)
 *       2E D6 DC 00 <function> <seconds>                      (0 s = off)
 *     a light function in one headlight (front lamps route here first on the G05's LEDs,
 *     because the BDC takes their output requests and nothing lights).
 *
 * Status read-back: 22 E3 B9 (LICHT_AUSGANG_DIGITAL) at BDC - one byte per output by its number.
 * Session: 10 03 (extended) once, 3E 00 every 2 s while writes are flowing, 10 01 at stop.
 * All lamps the tool drives time themselves out at the ECU in a few seconds - if the tool dies
 * mid-pattern, the lamps go back to the car on their own.
 *
 * Attribution: lamp list, output numbers, function ids, layout candidates and session plan are
 * taken from eroobeeroo/idrive7-apps/light_show (MIT, Copyright 2026 eroobeeroo), car-tested on
 * a 2021 X5 xDrive45e G05. Cross-check on your own car before arming.
 */

const BDC = 0x40, FLM_L = 0x43, FLM_R = 0x44;

// LICHT_AUSGANG_DIGITAL_STEUERN layouts the lamp check tries on the rear left turn signal and
// keeps the first one the body controller takes. Each is 'DID bytes' + the output byte + on/off
// byte, in the shape the SGBD arguments suggest. The lamp check feeds these one by one.
const LAYOUTS = [
    { id: 'A', hint: '03 <out> <on> 00',    build: (out, on) => [0x03, out, on & 1, 0x00] },
    { id: 'B', hint: '<out> <on> 00',        build: (out, on) => [out, on & 1, 0x00] },
    { id: 'C', hint: '03 <out> 00 <on>',    build: (out, on) => [0x03, out, 0x00, on & 1] },
    { id: 'D', hint: '<out> <on>',           build: (out, on) => [out, on & 1] },
    { id: 'E', hint: '03 <out> <on> 0A',    build: (out, on) => [0x03, out, on & 1, 0x0A] },  // last byte might be time x100ms
];

/**
 * TAB_LEUCHTEN_FUNKTION_ARG picks for LEUCHTEN_FUNKTION (0xD542). The function id is 2 bytes
 * (high / low). A function marked 'bothSides: true' lights both sides in one call - the turn
 * signals are the exception and have separate functions (that is why they can be chased).
 */
const BDC_FUNC = {
    fogFront:     { hi: 0x00, lo: 0x05, both: true,  note: 'front fog lamps' },
    fogRear:      { hi: 0x00, lo: 0x06, both: true,  note: 'rear fog lamps' },
    reverseLeft:  { hi: 0x00, lo: 0x07, both: false, side: 'L', note: 'reversing lamp left' },
    reverseRight: { hi: 0x00, lo: 0x08, both: false, side: 'R', note: 'reversing lamp right' },
    indicatorL:   { hi: 0x00, lo: 0x09, both: false, side: 'L', note: 'turn signal left' },
    indicatorR:   { hi: 0x00, lo: 0x0a, both: false, side: 'R', note: 'turn signal right' },
    drlLow:       { hi: 0x00, lo: 0x0b, both: true,  note: 'DRL low brightness' },
    drlHigh:      { hi: 0x00, lo: 0x0c, both: true,  note: 'DRL high brightness' },
    tailBrake:    { hi: 0x00, lo: 0x0d, both: true,  note: 'brake lights (refused on G05 by default)' },
    plateLight:   { hi: 0x00, lo: 0x0e, both: true,  note: 'number plate light' },
    special:      { hi: 0x00, lo: 0x1c, both: true,  note: 'special flash sequence' },
    reversingFx:  { hi: 0x00, lo: 0x1b, both: true,  note: 'reversing flash' },
};

/**
 * FLM functions for FLM_FUNKTION_LICHTVERTEILUNG (0xD6DC). One module per side (0x43 left,
 * 0x44 right). TAB_LF_LV_FRONT_ARG picks:
 */
const FLM_FUNC = {
    lowBeam:      { fn: 0x01, note: 'low beam' },
    highBeam:     { fn: 0x02, note: 'high beam (static)' },
    highFlash:    { fn: 0x0a, note: 'Fernlichtblinken - high beam blink' },
    panicMode:    { fn: 0x0b, note: 'Panik-Modus - rapid both-beam pulse' },
    cornering:    { fn: 0x04, note: 'cornering light' },
    welcomeAnim:  { fn: 0x06, note: 'welcome animation (OEM sequence)' },
    goodbyeAnim:  { fn: 0x07, note: 'goodbye animation' },
    mLightLow:    { fn: 0x08, note: 'M-Light / adaptive low' },
    turnSignalL:  { fn: 0x0c, note: 'sequential indicator left (only valid on FLM_L)' },
    turnSignalR:  { fn: 0x0d, note: 'sequential indicator right (only valid on FLM_R)' },
};

/**
 * LAMPS: the lamp catalogue the patterns pick from. side: 'L' / 'R' / '-' both.
 * route: how the tool drives the lamp when a layout is learnt (output) or when no layout was
 * taken (function via BDC or FLM).
 *
 * out: BDC output byte for LICHT_AUSGANG_DIGITAL_STEUERN
 * flm: { ecu, fn } for FLM_FUNKTION_LICHTVERTEILUNG  (ecu = 0x43 or 0x44)
 * fn:  BDC function for LEUCHTEN_FUNKTION             (both-sides unless side given)
 */
const LAMPS = [
    { id: 'fog_front_l',  side: 'L', out: 0x12, flm: { ecu: FLM_L, fn: 0x05 }, fn: BDC_FUNC.fogFront,     dangerous: false, label: 'Front fog L' },
    { id: 'fog_front_r',  side: 'R', out: 0x13, flm: { ecu: FLM_R, fn: 0x05 }, fn: BDC_FUNC.fogFront,     dangerous: false, label: 'Front fog R' },
    { id: 'fog_rear',     side: '-', out: 0x14,                                fn: BDC_FUNC.fogRear,      dangerous: false, label: 'Rear fog' },
    { id: 'reverse_l',    side: 'L', out: 0x16,                                fn: BDC_FUNC.reverseLeft,  dangerous: false, label: 'Reverse L' },
    { id: 'reverse_r',    side: 'R', out: 0x17,                                fn: BDC_FUNC.reverseRight, dangerous: false, label: 'Reverse R' },
    { id: 'turn_fl',      side: 'L', out: 0x18, flm: { ecu: FLM_L, fn: 0x0c }, fn: BDC_FUNC.indicatorL,   dangerous: false, label: 'Turn signal front L' },
    { id: 'turn_fr',      side: 'R', out: 0x19, flm: { ecu: FLM_R, fn: 0x0d }, fn: BDC_FUNC.indicatorR,   dangerous: false, label: 'Turn signal front R' },
    { id: 'turn_rl',      side: 'L', out: 0x1a,                                fn: BDC_FUNC.indicatorL,   dangerous: false, label: 'Turn signal rear L' },
    { id: 'turn_rr',      side: 'R', out: 0x1b,                                fn: BDC_FUNC.indicatorR,   dangerous: false, label: 'Turn signal rear R' },
    { id: 'high_beam_l',  side: 'L', out: 0x1c, flm: { ecu: FLM_L, fn: 0x02 },                             dangerous: true,  label: 'High beam L',   note: 'DO NOT use on public roads' },
    { id: 'high_beam_r',  side: 'R', out: 0x1d, flm: { ecu: FLM_R, fn: 0x02 },                             dangerous: true,  label: 'High beam R',   note: 'DO NOT use on public roads' },
    { id: 'drl_l',        side: 'L', out: 0x1e, flm: { ecu: FLM_L, fn: 0x03 }, fn: BDC_FUNC.drlLow,       dangerous: false, label: 'DRL L' },
    { id: 'drl_r',        side: 'R', out: 0x1f, flm: { ecu: FLM_R, fn: 0x03 }, fn: BDC_FUNC.drlLow,       dangerous: false, label: 'DRL R' },
    { id: 'cornering_l',  side: 'L',             flm: { ecu: FLM_L, fn: 0x04 },                           dangerous: false, label: 'Cornering L' },
    { id: 'cornering_r',  side: 'R',             flm: { ecu: FLM_R, fn: 0x04 },                           dangerous: false, label: 'Cornering R' },
];

// Lamps the tool never drives: the BDC refuses "conditions not correct" on the brake pedal's
// own lamps and the number plate light stays on the car's night-driving logic.
const KEPT = [
    { id: 'brake',   label: 'Brake lights (always the car)' },
    { id: 'tail',    label: 'Tail lights (always the car)' },
    { id: 'plate',   label: 'Number plate light (always the car)' },
];

const BY_ID = Object.create(null);
LAMPS.concat(KEPT).forEach((l) => { BY_ID[l.id] = l; });

module.exports = {
    BDC, FLM_L, FLM_R,
    LAYOUTS, BDC_FUNC, FLM_FUNC, LAMPS, KEPT, BY_ID,
};
