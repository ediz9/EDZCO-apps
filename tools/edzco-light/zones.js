'use strict';
/*
 * zones.js - the zone -> BDC NAD map for the layering jobs. Derived from
 * BDC_G05 TAB_INNENLICHT_VERBAUORT_LIN (every LIN slave's location byte),
 * trimmed to the six zones M Scenes addresses:
 *
 *   dash     - every "Dash ..." location (line / decor / backlit)
 *   doors    - every "...door..." location, all four doors
 *   footwell - the four footwell locations
 *   console  - centre stack, console lines, console decor, cupholders
 *   seats    - B-pillar + seat backs
 *   roof     - roof segments + light swords
 *
 * On LIN bus 1 the layering job is 2E DA 5E <NAD> ...; on bus 2 it is 2E E3 D1
 * <NAD> ... (same payload shape). A location whose record read back as empty
 * (loc = 0xFF) is skipped: writing to a slot the car doesn't have returns 7F
 * 31 (requestOutOfRange).
 *
 * Attribution: the location map comes from IterioDev's iteriodev-comfort
 * (MIT, Copyright 2026 cauliflowermossgrape), car-tested on an M4 2026-11-07.
 */

const ZONES = ['dash', 'doors', 'footwell', 'console', 'seats', 'roof'];

// NAD ranges (inclusive) per zone, per LIN bus. 'lin1' is the main LIN
// (addresses 0x01..0x5F in BDC_G05); 'lin2' is the second bus for cars that
// have one (back-seat footwell, 3rd-row door lights, cars without a module on
// lin1 for a location the catalog lists). The tool probes each one once and
// remembers which ones answered.
const NAD_RANGES = {
    dash: {
        lin1: [[0x13, 0x18], [0x4f, 0x50]],
        lin2: [],
    },
    doors: {
        lin1: [[0x05, 0x12], [0x21, 0x2a], [0x3f, 0x46], [0x4d, 0x4e],
               [0x51, 0x58], [0x59, 0x5e], [0x62, 0x65]],
        lin2: [],
    },
    footwell: {
        lin1: [[0x01, 0x04]],
        lin2: [[0x23, 0x24]],
    },
    console: {
        lin1: [[0x1d, 0x20], [0x2b, 0x32], [0x47, 0x4c], [0x5f, 0x61]],
        lin2: [],
    },
    seats: {
        lin1: [[0x19, 0x1c], [0x33, 0x34]],
        lin2: [[0x71, 0x74]],
    },
    roof: {
        lin1: [[0x35, 0x3e]],
        lin2: [],
    },
};

function nadsOf(zone, bus) {
    const r = (NAD_RANGES[zone] || {})[bus] || [];
    const out = [];
    for (const [lo, hi] of r) for (let n = lo; n <= hi; n++) out.push(n);
    return out;
}

module.exports = { ZONES, NAD_RANGES, nadsOf };
