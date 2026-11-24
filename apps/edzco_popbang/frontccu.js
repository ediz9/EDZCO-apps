'use strict';
/*
 * frontccu.js - the iDrive rotary controller, for cars without a touchscreen.
 *
 * FrontCCU (de.bmw.infotainment.controlelements.FrontCCU, instance 1) publishes
 * statusRotaryEncoderState: the knob's counter, whether it is pressed, and which way it is
 * pushed. Subscribe, and every state the car sends arrives here.
 *
 * Three things that are easy to get wrong, all learned the hard way upstream:
 *
 *  1. iDrive 7's oap-sdk 24.x hands the timeout argument to the native waitUntilAvailable
 *     unchanged, and `{ timeoutMs: n }` times out immediately there. It must be a plain
 *     NUMBER. iDrive 8's oap-sdk 50.x accepts either. (car-apps issue #37, a G20 on iD7.)
 *
 *  2. The proxy has to be HELD. One nobody keeps a reference to gets collected and the
 *     states simply stop arriving, with no error.
 *
 *  3. The counter is free-running and wraps. What matters is the DELTA between states, and
 *     the first state after a subscribe has no previous to compare with - treat it as a
 *     reference point, not as a turn, or the UI jumps the moment the app opens.
 *
 * The app's manifest must list the proxy:
 *   "de.bmw.infotainment.controlelements.FrontCCU": {
 *       "instances": ["1"], "attributes": { "statusRotaryEncoderState": "rs" } }
 *
 * Attribution: the subscribe shape and the iDrive 7 timeout fix are from IterioDev's
 * car-apps (oap-shared/frontccu.js, MIT, Copyright 2026 cauliflowermossgrape).
 */

const IF = 'de.bmw.infotainment.controlelements.FrontCCU';
const RETRY_MS = 30000;
const WAIT_MS = 10000;          // a NUMBER - see note 1
const LOG_FIRST = 20;           // log the first states, so a new car's shape is in the log

/** The counter is a small unsigned field that wraps; a raw subtraction across the wrap
 *  looks like a huge jump in the wrong direction. */
function wrapDelta(cur, prev, modulo) {
    let d = cur - prev;
    const half = modulo / 2;
    if (d > half) d -= modulo;
    else if (d < -half) d += modulo;
    return d;
}

/**
 * watchController(sdk, handlers, log)
 *
 *   sdk       someipBuilders from oap-sdk (passed in, so this is testable off the car)
 *   handlers  { onTurn(delta), onPress(), onRelease(), onPush(dir) }
 *   log       fn(...)
 *
 * Returns { stop() }.
 */
function watchController(sdk, handlers, log) {
    const h = handlers || {};
    const held = [];                 // see note 2
    let seen = 0;
    let prevCount = null;
    let prevPressed = false;
    let stopped = false;

    function decode(v) {
        // Cars differ in what they put in the state: names on some branches, numbers on
        // others. Read defensively and only act on what is actually there.
        if (v == null) return null;
        const o = typeof v === 'object' ? v : { value: v };
        const count = pick(o, ['counter', 'rotaryCounter', 'encoderCounter', 'position', 'value']);
        const pressed = truthy(pick(o, ['pressed', 'isPressed', 'pressState', 'buttonState', 'press']));
        const push = pick(o, ['push', 'pushDirection', 'direction', 'tilt']);
        return { count, pressed, push };
    }
    function pick(o, keys) {
        for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
        return undefined;
    }
    function truthy(x) {
        if (x === undefined) return false;
        if (typeof x === 'boolean') return x;
        if (typeof x === 'number') return x > 0;
        const s = String(x).toUpperCase();
        return s.indexOf('PRESS') >= 0 || s === 'TRUE' || s === 'ON' || s === '1';
    }

    function onState(v) {
        if (stopped) return;
        if (seen < LOG_FIRST) { seen++; log('controller state ' + JSON.stringify(v)); }
        const s = decode(v);
        if (!s) return;

        if (typeof s.count === 'number') {
            if (prevCount === null) {
                prevCount = s.count;           // see note 3: reference, not a turn
            } else if (s.count !== prevCount) {
                // the field width is not documented; 256 covers the counters seen so far and
                // a wrong guess only matters across a wrap
                const d = wrapDelta(s.count, prevCount, 256);
                prevCount = s.count;
                if (d !== 0 && h.onTurn) h.onTurn(d);
            }
        }

        if (s.pressed !== prevPressed) {
            prevPressed = s.pressed;
            if (s.pressed) { if (h.onPress) h.onPress(); }
            else if (h.onRelease) h.onRelease();
        }

        if (s.push !== undefined && h.onPush) {
            const p = String(s.push).toUpperCase();
            if (p.indexOf('LEFT') >= 0) h.onPush('left');
            else if (p.indexOf('RIGHT') >= 0) h.onPush('right');
            else if (p.indexOf('UP') >= 0) h.onPush('up');
            else if (p.indexOf('DOWN') >= 0) h.onPush('down');
        }
    }

    function connect() {
        if (stopped) return;
        sdk.buildAndInitTypedProxy(IF, '1', WAIT_MS)
            .then((p) => {
                held.push(p);
                return p.statusRotaryEncoderState.subscribe(onState);
            })
            .then(() => log('controller: subscribed'))
            .catch((e) => {
                log('controller: ' + String((e && e.message) || e) + ' - retrying in 30 s');
                setTimeout(connect, RETRY_MS);
            });
    }

    connect();
    return { stop() { stopped = true; held.length = 0; } };
}

module.exports = { watchController, wrapDelta, IF };
