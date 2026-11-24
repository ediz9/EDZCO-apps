'use strict';
/*
 * edzco_vehicle.js - the car's state as the EDZCO apps need it, read from the same signals and
 * decoded the same way as the MGU apps that run on cars today: kit/runtime/car.js (engine speed,
 * gear), kit/runtime/parked.js (road speed), idrive7-apps' live_data (accelerator pedal) and
 * ambient_config (doors, vehicle state).
 *
 *   const V = require('./edzco_vehicle').watch(ctx, { rpm: true, pedal: true, ... }, (what, v) => {});
 *   V.rpm, V.pedal (0-100 %), V.speed (km/h), V.stage ('P' | 'R' | 'N' | 'D'), V.doorsOpen, V.condition
 *   V.parked(), V.moving(), V.ignition(), V.away(), V.pedalLive()
 *
 * Each value is null until the car sends it. Every interface but CDS and Vehicle2 is "_optional" in
 * app.json, so a unit without it still installs the app; the value then stays null and the app says so.
 * The app.json signals each part needs are in SIGNALS below.
 */
const Car = require('./kit/car');

const SIGNALS = {
    rpm: ['de.bmw.infotainment.vehicle.CDS', { statusEngineSpeed2: 'rs' }],
    speed: ['de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: 'rs' }],
    pedal: ['de.bmw.powertrain.AcceleratorPedal', { AngleAcceleratorPedal: 's' }],
    gear: ['de.bmw.infrastructure.VehicleInformation', { statusGearboxDrive: 's', DataPowerTrain2: 's' }],
    doors: ['de.bmw.body.DoorsWindowsRoofMirrors', { CentralLockingSystemAndPanelStatus: 's' }],
    condition: ['de.bmw.infrastructure.VehicleCondition', { VehicleCondition: 's', vehicleConditionNoCrc: 's' }],
};

// selector position (statusActualStageDrive): names or wire numbers
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
// each door's switch, open = 1 or ..._OFFEN
const DOORS = ['statusDoorSwitchDRD', 'statusDoorSwitchPSD', 'statusDoorSwitchDRDR', 'statusDoorSwitchPSDR'];
const isOpen = (x) => x === 1 || /_OFFEN$/.test(String(x));
const MOVING_KMH = 3;          // kit/parked's threshold
const PEDAL_STALE_MS = 1500;   // a pedal that has gone quiet for this long no longer counts

function conditionFrom(v) {
    const n = Car.conditionOf(v && v.statusConditionVehicle);
    if (n !== undefined) return n;
    const p = v && v.controlBasePartialNetworks;
    if (p === 0 || p === 'KEINE_KOMMUNIKATION') return 1;
    return Car.conditionOf(typeof p === 'string' ? p.replace(/^KOM_/, '') : p);
}

function watch(ctx, want, onChange) {
    const log = ctx.log;
    const s = {
        rpm: null, pedal: null, pedalAt: 0, speed: null, stage: null, doorsOpen: null, condition: null,
        /** stage P; with no selector signal, standing still */
        parked() { return s.stage === 'P' || (s.stage === null && s.speed !== null && s.speed < 1); },
        moving() { return s.speed !== null && s.speed > MOVING_KMH; },
        /** ignition on or more (PRUEFEN_ANALYSE_DIAGNOSE and up) */
        ignition() { return s.condition !== null && s.condition >= 7; },
        /** locked and left: parked, standby, nobody in it */
        away() { return s.condition !== null && s.condition <= 3; },
        pedalLive() { return s.pedal !== null && Date.now() - s.pedalAt < PEDAL_STALE_MS; },
    };
    const changed = (what) => {
        if (!onChange) return;
        try { onChange(what, s); } catch (e) { log.warn('vehicle ' + what + ': ' + (e && e.message || e)); }
    };
    const sub = (iface, handlers, opts) => Promise.resolve()
        .then(() => ctx.signals.watch(iface, '1', handlers, log, opts))
        .then((r) => log.info(iface.split('.').pop() + (r && r.error ? ' error: ' + r.error : ' subscribed')),
            (e) => log.warn(iface.split('.').pop() + ': ' + (e && e.message || e)));

    if (want.rpm) {
        sub('de.bmw.infotainment.vehicle.CDS', {
            statusEngineSpeed2: (v) => {
                const r = v && v.actualValueRPMEngineCrankshaft;
                if (typeof r === 'number' && r !== 65535) { s.rpm = r * 0.25; changed('rpm'); }
            },
        });
    }
    if (want.speed) {
        // re-read every 2 s: a car standing still may not notify a speed that doesn't change
        sub('de.bmw.infotainment.vehicle.Vehicle2', {
            statusCarSpeed2: (v) => {
                const k = v && v.speedVehicleCentreOfGravity;
                if (typeof k === 'number' && k !== 65535) { s.speed = k * 0.015625; changed('speed'); }
            },
        }, { pollMs: 2000 });
    }
    if (want.pedal) {
        sub('de.bmw.powertrain.AcceleratorPedal', {
            AngleAcceleratorPedal: (v) => {
                const r = v && v.actualValueAngleAcceleratorPedal;
                if (typeof r !== 'number') return;
                const p = r * 0.025;
                if (p < -2 || p > 102) return;
                s.pedal = Math.max(0, Math.min(100, p)); s.pedalAt = Date.now();
                changed('pedal');
            },
        });
    }
    if (want.gear) {
        sub('de.bmw.infrastructure.VehicleInformation', {
            statusGearboxDrive: (v) => {
                const st = STAGES[v && v.statusActualStageDrive];
                if (st) { s.stage = st; changed('stage'); }
            },
            // some cars never send statusGearboxDrive; this one comes in another event group
            DataPowerTrain2: (v) => {
                const sel = Car.selectionOf(v && v.statusGearSelectionDrive);
                if (sel && sel.stage) { s.stage = sel.stage; changed('stage'); }
            },
        });
    }
    if (want.doors) {
        sub('de.bmw.body.DoorsWindowsRoofMirrors', {
            CentralLockingSystemAndPanelStatus: (v) => { s.doorsOpen = DOORS.some((k) => isOpen(v && v[k])); changed('doors'); },
        });
    }
    if (want.condition) {
        const on = (v) => { const n = conditionFrom(v); if (n !== undefined) { s.condition = n; changed('condition'); } };
        sub('de.bmw.infrastructure.VehicleCondition', { VehicleCondition: on, vehicleConditionNoCrc: on });
    }
    return s;
}

module.exports = { watch, SIGNALS, MOVING_KMH };
