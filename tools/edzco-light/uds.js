'use strict';
/*
 * uds.js - edzco-light: UDS through the head unit's diagnostic gateway (TASU, SOME/IP 0xF8A6 instance 128),
 * over one `hmictl serve` session. This is the same mechanism iteriodev-comfort uses (car-tested on mgu-m4
 * 2026-11-07); the method is `sendTasuRequest` with sourceAddress F2, target (the ECU byte), service id, subroutine 0.
 *
 *   request  method 1 sendTasuRequest: F2 <target> <sid> 00 <len u16> <len u32> <data...> 00
 *            data is the UDS payload after the service byte.
 *   reply    event 0x8001: u32 length + bytes; [2] 0x7F = refused by the transport (code at [4]),
 *            [6] the unit that answered, the UDS reply from [9].
 *
 * One request at a time: the gateway answers one caller's requests in order, and a reply carries no request id.
 * Attribution: the hmictl line format + reply-parse pattern is borrowed from IterioDev's iteriodev-comfort
 * (MIT, Copyright 2026 cauliflowermossgrape).
 */
const SUB = 'sub 0xf8a6 128 1 1 0x8001';
const EV = 0x8001, SVC = 0xf8a6;
const TIMEOUT_MS = 3000, PENDING_MS = 10000;      // 7F xx 78 = response pending: BMW waits up to 10 s

const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0');

function hexToBytes(h) {
    if (!h) return [];
    h = String(h).replace(/^0x/, '').replace(/[\s_]/g, '');
    if (h.length % 2) throw new Error('odd hex: ' + h);
    const out = [];
    for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
    return out;
}

function bytesToHex(b) { return b.map((x) => hex2(x)).join(''); }

/** the hmictl line for one request. data = the UDS bytes after the service byte (an array of 0..255). */
function line(target, sid, data) {
    const d = Buffer.from(data || []), n = d.length;
    return `call 0xf8a6 128 1 1 f2${hex2(target)}${hex2(sid)}00${n.toString(16).padStart(4, '0')}` +
        `${n.toString(16).padStart(8, '0')}${d.toString('hex')}00`;
}

/** an event payload (hex) -> { unit, uds: [bytes] } | { reject: code } | null */
function parse(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]+$/i.test(hex) || hex.length < 8 || hex.length % 2) return null;
    const n = parseInt(hex.slice(0, 8), 16), b = Buffer.from(hex.slice(8, 8 + 2 * n), 'hex');
    if (b.length !== n) return null;
    if (b.length >= 5 && b[2] === 0x7f) return { reject: b[4] };
    if (b.length < 10) return null;
    return { unit: b[6], uds: Array.from(b.slice(9)) };
}

/**
 * Minimal UDS queue. hmi(line) -> Promise<"ok .." | "error ..">; feed every "ev 0xf8a6 0x8001 <hex>" line to onEvent.
 * send(target, sid, data, ms) -> Promise<[uds bytes]> (positive reply); rejects with Error (code: NRC or 'timeout').
 */
class Uds {
    constructor(hmi, log) { this.hmi = hmi; this.log = log || (() => {}); this.q = []; this.cur = null; }

    send(target, sid, data, ms) {
        return new Promise((res, rej) => {
            this.q.push({ target, sid, data: Array.from(data || []), ms: ms || TIMEOUT_MS, res, rej });
            this.pump();
        });
    }

    pump() {
        if (this.cur || !this.q.length) return;
        const c = this.cur = this.q.shift();
        const t = setTimeout(() => {
            if (this.cur !== c) return;
            this.cur = null;
            c.rej(new Error('timeout'));
            this.pump();
        }, c.ms + 500);
        this.hmi(line(c.target, c.sid, c.data)).then((r) => {
            // ok/error is only transport; the real reply arrives via event.
            if (typeof r === 'string' && r.startsWith('error')) {
                if (this.cur !== c) return;
                clearTimeout(t);
                this.cur = null;
                c.rej(new Error('hmictl: ' + r));
                this.pump();
            }
        }).catch((e) => {
            if (this.cur !== c) return;
            clearTimeout(t);
            this.cur = null;
            c.rej(e);
            this.pump();
        });
        c._timer = t;
    }

    /** feed every "ev 0xf8a6 0x8001 <hex>" from hmictl here */
    onEvent(hex) {
        const p = parse(hex);
        const c = this.cur;
        if (!c) return;
        if (!p) return;                                  // not our reply shape, keep waiting
        if (p.reject !== undefined) {                    // transport refused (gateway busy, bad target, ...)
            clearTimeout(c._timer);
            this.cur = null;
            c.rej(new Error('transport reject: ' + p.reject.toString(16)));
            this.pump();
            return;
        }
        const uds = p.uds;
        // NRC 78 = response pending, keep waiting (reset the timer up to PENDING_MS)
        if (uds.length >= 3 && uds[0] === 0x7f && uds[2] === 0x78) {
            clearTimeout(c._timer);
            c._timer = setTimeout(() => {
                if (this.cur !== c) return;
                this.cur = null;
                c.rej(new Error('timeout (after pending)'));
                this.pump();
            }, PENDING_MS);
            return;
        }
        // negative response code
        if (uds.length >= 3 && uds[0] === 0x7f) {
            clearTimeout(c._timer);
            this.cur = null;
            const err = new Error('NRC ' + uds[2].toString(16));
            err.nrc = uds[2];
            c.rej(err);
            this.pump();
            return;
        }
        // positive response (SID + 0x40)
        clearTimeout(c._timer);
        this.cur = null;
        c.res(uds);
        this.pump();
    }

    close() {
        if (this.cur) { clearTimeout(this.cur._timer); this.cur.rej(new Error('closing')); this.cur = null; }
        this.q.forEach((c) => c.rej(new Error('closing')));
        this.q = [];
    }
}

module.exports = { Uds, SUB, EV, SVC, hexToBytes, bytesToHex, line, parse };
