#!/usr/bin/env node
'use strict';
/*
 * build.js - pack one app into the .tgz the Store installs.
 *
 *   node kit/build.js <appId>        ->  dist/<appId>@<version>.tgz
 *
 * mgu-repo.json points the unit here (apps.build.node), and the unit runs it when it
 * builds this source.
 *
 * ---------------------------------------------------------------------------------------
 * What a package has to contain
 *
 * An OAP package is not just the app's own files. It is:
 *
 *   <id>@<version>/          the OAP shell the head unit's app manager loads
 *     package.json           with oapAppSettings (disk, cpu, memory, priority, visibility)
 *     manifest.json          the joynr/SOME/IP proxies the app may reach
 *     permissions.json       the DAC access-control entries for those proxies
 *     rhmiData/              one RHMI host state per screen, strings, resources
 *     icon.png
 *   src/                     the app's own modules
 *   mgu-app.json             which modules to load and which oap-sdk pieces to wire in
 *
 * The shell is generated from BMW's own `oap-sdk`, which is NOT redistributable and is not
 * in this repository. It is extracted from your own head unit (see docs/OAP_SDK.md). Every
 * other MGU app repository works the same way - ENJATZ's README puts it plainly: "An
 * installable package requires BMW's oap-sdk, extracted from your own head unit."
 *
 * So: with the SDK present this builds a package. Without it, it says exactly what is
 * missing and exits non-zero rather than producing something the unit would reject.
 *
 * The TOOLS in this repo (tools/edzco-sound, tools/edzco-lights) need none of this - they
 * are plain files plus a systemd unit, and the Store installs them directly from
 * component.json. They work before the SDK is ever extracted.
 * ---------------------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SDK_DIR = process.env.OAP_SDK || path.join(ROOT, 'oap-sdk');

function die(msg) {
    console.error('build: ' + msg);
    process.exit(1);
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { die('cannot read ' + p + ': ' + e.message); }
}

function main() {
    const appId = process.argv[2];
    if (!appId) die('usage: node kit/build.js <appId>');

    const appDir = path.join(ROOT, 'apps', appId);
    if (!fs.existsSync(appDir)) die('no such app: ' + appId);

    const manifest = readJson(path.join(appDir, 'app.json'));
    const version = manifest.version;
    if (!version) die(appId + '/app.json has no version');

    if (!fs.existsSync(SDK_DIR)) {
        die([
            '',
            '  BMW\'s oap-sdk is not here, so the OAP shell cannot be generated.',
            '',
            '  Expected at: ' + SDK_DIR,
            '  Override with: OAP_SDK=/path/to/oap-sdk',
            '',
            '  It is extracted from your own head unit - see docs/OAP_SDK.md. It is not',
            '  redistributable, so no MGU app repository ships it.',
            '',
            '  The tools in this repo (edzco-sound, edzco-lights) do not need it and can be',
            '  installed now.',
            '',
        ].join('\n'));
    }

    const outDir = path.join(ROOT, 'dist');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `${appId}@${version}.tgz`);

    const tree = `${appId}@${version}`;
    const stage = path.join(outDir, '.stage-' + appId);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, tree), { recursive: true });
    fs.mkdirSync(path.join(stage, 'src'), { recursive: true });

    // the app's own modules
    for (const f of fs.readdirSync(appDir)) {
        if (!f.endsWith('.js')) continue;
        fs.copyFileSync(path.join(appDir, f), path.join(stage, 'src', f));
    }
    const icon = path.join(appDir, 'icon.png');
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(stage, tree, 'icon.png'));

    // what the unit needs to wire the app up
    const modules = fs.readdirSync(path.join(stage, 'src')).map((f) => 'src/' + f);
    fs.writeFileSync(path.join(stage, 'mgu-app.json'), JSON.stringify({
        schema: 1,
        id: appId,
        version,
        tree,
        modules,
        sdk: [
            'oap-sdk/src/core/OnlineApp.js',
            'oap-sdk/src/logging/logging',
            'oap-sdk/src/someip/someipBuilders',
        ],
    }, null, 2) + '\n');

    // the OAP shell, from the SDK's own generator
    const gen = path.join(SDK_DIR, 'tools', 'oapgen');
    if (fs.existsSync(gen)) {
        execFileSync(process.execPath, [gen, '--app', appId, '--out', path.join(stage, tree)],
                     { stdio: 'inherit' });
    } else {
        die('oap-sdk is present but its generator is missing at ' + gen);
    }

    execFileSync('tar', ['-czf', out, '-C', stage, '.'], { stdio: 'inherit' });
    fs.rmSync(stage, { recursive: true, force: true });
    console.log('built ' + path.relative(ROOT, out));
}

main();
