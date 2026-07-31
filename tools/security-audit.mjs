import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failures = 0;
const fail = (message) => { console.error(`SECURITY NG: ${message}`); failures++; };
const ok = (message) => console.log(`SECURITY OK: ${message}`);

const manifest = JSON.parse(read('manifest.json'));
if (manifest.manifest_version !== 3) fail('Manifest V3 is required'); else ok('Manifest V3');
if (manifest.externally_connectable) fail('externally_connectable must not be enabled'); else ok('no external messaging');
if (manifest.background?.service_worker !== 'background-entry.js') fail('background security entry is not active');
if (manifest.content_scripts?.[0]?.js?.join(',') !== 'content-guard.js,dom-text.js,content.js') {
    fail('content scripts are not loaded in the reviewed order');
}
const expectedPermissions = ['activeTab', 'scripting', 'storage', 'contextMenus', 'offscreen'].sort();
if (JSON.stringify([...(manifest.permissions || [])].sort()) !== JSON.stringify(expectedPermissions)) {
    fail(`unexpected extension permissions: ${(manifest.permissions || []).join(', ')}`);
} else ok('reviewed extension permissions only');
if ((manifest.web_accessible_resources || []).some((entry) =>
    (entry.resources || []).some((resource) => resource !== 'images/icon128.png'))) {
    fail('unexpected web-accessible resource');
}
const csp = manifest.content_security_policy?.extension_pages || '';
if (!/^script-src 'self' 'wasm-unsafe-eval'; object-src 'self'$/.test(csp)) fail(`unexpected extension CSP: ${csp}`); else ok('strict extension CSP');

const firstPartyJs = fs.readdirSync(root).filter((f) => f.endsWith('.js'));
const contentSource = read('content.js');
const backgroundSource = read('background.js');
const offscreenSource = read('offscreen.js');
const optionsSource = read('options.js');
const constantsSource = read('constants.js');
if (!/String\(active\.type\)\.toLowerCase\(\) === "password"/.test(contentSource)) fail('password input exclusion is missing');
if (!/chromewebstore\.google\.com\/detail\/web-reader-for-voicevox\/ilcfondcjhaalpcghnhcejioopcbhhla\/reviews/.test(contentSource)) fail('store URL must use the published review page');
if (/高評価（★5）|高評価する/.test(contentSource)) fail('review UI must not demand a specific rating');
const captureSource = read('capture.js');
if (!/if \(ocrInProgress\) terminateWorkers\(\)/.test(captureSource)) fail('capture OCR concurrency guard is missing');
if (!/CONTENT_SCRIPT_FILES = \["content-guard\.js", "dom-text\.js", "content\.js"\]/.test(backgroundSource)) fail('dynamic content injection omits the guard');
if (!/VVRadioBackgroundSecurity/.test(backgroundSource)) fail('background message validator is not integrated');
if (!/VVRadioOffscreenSecurity/.test(offscreenSource)) fail('offscreen message validator is not integrated');
if (!/voiceOperationQueue/.test(backgroundSource)) fail('voice operation serialization is missing');
if (!/MAX_PENDING_OCR_REQUESTS/.test(offscreenSource)) fail('OCR queue limit is missing');
if (!/readJsonResponseWithLimit/.test(backgroundSource)
    || !/readBlobResponseWithLimit/.test(offscreenSource)
    || !/readResponseBytesWithLimit/.test(constantsSource)) fail('bounded local-engine response readers are not active');
if (!/isSafeRasterDataUrl/.test(optionsSource) || !/ICON_DECODE_MAX_PIXELS/.test(optionsSource)) {
    fail('stored/uploaded icon validation is incomplete');
}
if (!/keyboardShortcutListener/.test(contentSource) || !/messageListener/.test(contentSource)) {
    fail('content listener cleanup is incomplete');
}
for (const file of firstPartyJs) {
    const src = read(file);
    if (/\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(/.test(src)) fail(`${file}: dynamic code execution`);
    if (/importScripts\s*\(\s*["']https?:/i.test(src)) fail(`${file}: remote importScripts`);
    for (const match of src.matchAll(/\.innerHTML\s*=\s*`([\s\S]*?)`/g)) {
        if (/\$\{/.test(match[1])) fail(`${file}: interpolated innerHTML`);
    }
    for (const match of src.matchAll(/https?:\/\/[^"'`\s)]+/g)) {
        const url = match[0];
        const allowed = url.startsWith('http://127.0.0.1:50021')
            || url.startsWith('https://chromewebstore.google.com/')
            || url.startsWith('https://voicevox.hiroshiba.jp/')
            || url.startsWith('https://github.com/');
        if (!allowed) fail(`${file}: unreviewed remote URL ${url}`);
    }
}

for (const html of ['offscreen.html', 'capture.html', 'options.html']) {
    const src = read(html);
    if (/\son[a-z]+\s*=/i.test(src)) fail(`${html}: inline event handler`);
    for (const m of src.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
        if (/^(?:https?:|\/\/)/i.test(m[1])) fail(`${html}: remote resource ${m[1]}`);
        else if (!fs.existsSync(path.join(root, m[1]))) fail(`${html}: missing resource ${m[1]}`);
    }
}

const workflow = read('.github/workflows/check.yml');
for (const use of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(use[1])) fail(`GitHub Action is not pinned to a full commit SHA: ${use[1]}`);
}
for (const temporary of ['.github/workflows/audit-export.yml', '.github/workflows/codeql-audit.yml']) {
    if (fs.existsSync(path.join(root, temporary))) fail(`temporary audit workflow remains: ${temporary}`);
}

const pack = read('tools/pack.ps1');
for (const file of ['background-entry.js', 'background-security.js', 'content-guard.js', 'offscreen-security.js']) {
    if (!pack.includes(`'${file}'`)) fail(`release package omits ${file}`);
}

const sumsFile = path.join(root, 'vendor/tesseract/SHA256SUMS');
if (!fs.existsSync(sumsFile)) {
    fail('vendor checksum manifest missing');
} else {
    for (const line of fs.readFileSync(sumsFile, 'utf8').trim().split(/\r?\n/)) {
        const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line);
        if (!m) { fail(`invalid checksum line: ${line}`); continue; }
        const filePath = path.join(root, 'vendor/tesseract', m[2]);
        if (!fs.existsSync(filePath)) { fail(`missing vendored file ${m[2]}`); continue; }
        const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        if (actual !== m[1]) fail(`vendor checksum mismatch: ${m[2]}`);
    }
    if (!failures) ok('vendored OCR assets match recorded SHA-256');
}

if (failures) process.exit(1);
console.log('security audit: PASSED');
