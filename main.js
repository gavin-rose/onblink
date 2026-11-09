'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, safeStorage, session, shell } = require('electron');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

try {
    process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

app.setName('OnBlink');
app.setPath('userData', path.join(app.getPath('appData'), 'onblink'));

const ICON = path.join(__dirname, 'assets', 'icon.png');
const SAY = '/usr/bin/say';
const KEY_SIGNUP_URL = 'https://physiology.presagetech.com/auth/login';
const MAX_KEY = 512;
const MAX_ACTIONS = 30;
const MAX_LABEL = 60;
const MAX_TEXT = 500;

const SENSITIVITIES = ['gentle', 'normal', 'sensitive'];
const AUTO_STOP_OPTIONS = [0, 1, 2, 5, 15, 30];
const CUE_EXTRAS = [
    'Cancel',
    'Dismiss',
    'Test check-in. Want to check in?',
    'Your heart rate has been higher than earlier in this session for a while. Want to check in?',
];
const MAX_CUES = 100;

const CHECKIN_ACTIONS = [
    { id: '__checkin_fine', label: 'I am fine', type: 'none' },
    { id: '__checkin_break', label: 'I need a break', type: 'say', text: 'I need a break, please' },
    { id: '__checkin_help', label: 'I need help', type: 'say', text: 'I need help, please come here' },
];

const DEFAULT_CONFIG = {
    stepMs: 1600,
    voice: '',
    readAloud: false,
    inputMode: 'native',
    blinkSpacing: 'relaxed',
    tutorialDone: false,
    autoStopMin: 0,
    cueVolume: 0.3,
    cueDevice: '',
    consentAccepted: false,
    checkin: { enabled: false, sensitivity: 'normal' },
    actions: [
        { id: 'yes', label: "Yes", type: 'say', text: "Yes" },
        { id: 'no', label: "No", type: 'say', text: "No" },
        { id: 'help', label: "I need help", type: 'say', text: "I need help, please come here" },
        { id: 'thirsty', label: "I'm thirsty", type: 'say', text: "I'm thirsty. Could I have something to drink, please?" },
        { id: 'hungry', label: "I'm hungry", type: 'say', text: "I'm hungry. Could I have something to eat, please?" },
        { id: 'bathroom', label: "Bathroom", type: 'say', text: "I need to use the bathroom, please" },
        { id: 'uncomfortable', label: "I'm uncomfortable", type: 'say', text: "I'm uncomfortable. Could you help me adjust?" },
        { id: 'thanks', label: "Thank you", type: 'say', text: "Thank you" },
        { id: 'notes', label: "Open Notes", type: 'open', app: '/System/Applications/Notes.app' },
    ],
};

let configPath = '';
let keyPath = '';
let config = DEFAULT_CONFIG;
let voices = null;

function listVoices() {
    if (voices) return Promise.resolve(voices);
    return new Promise((resolve) => {
        execFile(SAY, ['-v', '?'], (err, stdout) => {
            voices = err ? [] : stdout.split('\n')
                .map((line) => line.match(/^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})/))
                .filter(Boolean)
                .map((m) => ({ name: m[1].trim(), lang: m[2] }));
            resolve(voices);
        });
    });
}

function isApp(p) {
    try {
        return typeof p === 'string' && path.isAbsolute(p) && p.endsWith('.app') && fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

async function validate(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.actions)) throw new Error('invalid config');
    if (input.actions.length > MAX_ACTIONS) throw new Error(`at most ${MAX_ACTIONS} actions`);
    const stepMs = Math.round(Number(input.stepMs));
    if (!(stepMs >= 800 && stepMs <= 5000)) throw new Error('step speed must be 800 to 5000 ms');
    const voice = typeof input.voice === 'string' ? input.voice : '';
    if (voice && !(await listVoices()).some((v) => v.name === voice)) throw new Error(`unknown voice: ${voice}`);
    const ids = new Set();
    const actions = input.actions.map((a, i) => {
        const label = String(a?.label ?? '').trim().slice(0, MAX_LABEL);
        if (!label) throw new Error(`action ${i + 1} needs a label`);
        let id = typeof a.id === 'string' && /^[\w-]{1,40}$/.test(a.id) && !a.id.startsWith('__') ? a.id : crypto.randomUUID();
        if (ids.has(id)) id = crypto.randomUUID();
        ids.add(id);
        if (a.type === 'say') {
            const text = String(a.text ?? '').trim().slice(0, MAX_TEXT);
            if (!text) throw new Error(`"${label}" needs something to say`);
            return { id, label, type: 'say', text };
        }
        if (a.type === 'open') {
            if (!isApp(a.app)) throw new Error(`"${label}" needs an app`);
            return { id, label, type: 'open', app: a.app };
        }
        throw new Error(`"${label}" has an unknown type`);
    });
    const checkin = {
        enabled: !!input.checkin?.enabled,
        sensitivity: SENSITIVITIES.includes(input.checkin?.sensitivity) ? input.checkin.sensitivity : 'normal',
    };
    const inputMode = input.inputMode === 'long' ? 'long' : 'native';
    const blinkSpacing = input.blinkSpacing === 'quick' ? 'quick' : 'relaxed';
    const autoStopMin = AUTO_STOP_OPTIONS.includes(Number(input.autoStopMin)) ? Number(input.autoStopMin) : 0;
    const vol = Number(input.cueVolume);
    const cueVolume = Number.isFinite(vol) ? Math.min(1, Math.max(0.05, vol)) : 0.3;
    const cueDevice = typeof input.cueDevice === 'string' ? input.cueDevice.slice(0, 256) : '';
    return { stepMs, voice, readAloud: !!input.readAloud, inputMode, blinkSpacing, autoStopMin, cueVolume, cueDevice, tutorialDone: !!input.tutorialDone, consentAccepted: !!input.consentAccepted, checkin, actions };
}

function storedKey() {
    try {
        if (!safeStorage.isEncryptionAvailable()) return '';
        return safeStorage.decryptString(fs.readFileSync(keyPath));
    } catch {
        return '';
    }
}

function currentKey() {
    const stored = storedKey();
    if (stored) return { key: stored, source: 'keychain' };
    const env = process.env.SMARTSPECTRA_API_KEY || '';
    return env ? { key: env, source: 'env' } : { key: '', source: 'none' };
}

ipcMain.handle('onblink:key', () => currentKey());

ipcMain.handle('onblink:key-status', () => ({ source: currentKey().source, encryption: safeStorage.isEncryptionAvailable() }));

ipcMain.handle('onblink:key-set', (event, key) => {
    const clean = typeof key === 'string' ? key.trim() : '';
    if (!clean || clean.length > MAX_KEY || /\s/.test(clean)) return 'That does not look like an API key.';
    if (!safeStorage.isEncryptionAvailable()) return 'Secure storage is not available on this computer.';
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, safeStorage.encryptString(clean), { mode: 0o600 });
    return '';
});

ipcMain.handle('onblink:key-clear', () => {
    try { fs.unlinkSync(keyPath); } catch {}
    return '';
});

ipcMain.handle('onblink:open-signup', () => shell.openExternal(KEY_SIGNUP_URL));

async function loadConfig() {
    configPath = path.join(app.getPath('userData'), 'actions.json');
    keyPath = path.join(app.getPath('userData'), 'api-key.bin');
    try {
        config = await validate(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch {
        config = DEFAULT_CONFIG;
    }
}

function speak(text, voice) {
    return new Promise((resolve) => {
        const args = voice ? ['-v', voice, '-f', '-'] : ['-f', '-'];
        const child = spawn(SAY, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => resolve(err.message));
        child.on('close', (code) => resolve(code ? stderr.trim() || `say exited ${code}` : ''));
        child.stdin.end(text);
    });
}

async function runAction(action, voice = config.voice) {
    if (action.type === 'none') return '';
    if (action.type === 'say') return speak(action.text, voice);
    if (action.type === 'open') return isApp(action.app) ? shell.openPath(action.app) : 'app not found';
    return 'unknown action';
}

ipcMain.handle('onblink:config', () => ({ ...config, checkinActions: CHECKIN_ACTIONS.map(({ id, label }) => ({ id, label })) }));

ipcMain.handle('onblink:save', async (event, input) => {
    try {
        const next = await validate(input);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(next, null, 2));
        config = next;
        return { ok: true, config: { ...config, checkinActions: CHECKIN_ACTIONS.map(({ id, label }) => ({ id, label })) } };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('onblink:run', (event, id) => {
    const action = config.actions.find((a) => a.id === id) || CHECKIN_ACTIONS.find((a) => a.id === id);
    return action ? runAction(action) : `unknown action: ${id}`;
});

ipcMain.handle('onblink:test', async (event, input, voice) => {
    try {
        const checked = await validate({ stepMs: config.stepMs, voice, actions: [input] });
        return runAction(checked.actions[0], checked.voice);
    } catch (err) {
        return err.message;
    }
});

ipcMain.handle('onblink:pick-app', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
        title: 'Choose an app',
        defaultPath: '/Applications',
        properties: ['openFile'],
        filters: [{ name: 'Applications', extensions: ['app'] }],
    });
    if (res.canceled || !res.filePaths[0] || !isApp(res.filePaths[0])) return null;
    const app = res.filePaths[0];
    return { app, name: path.basename(app, '.app') };
});

ipcMain.handle('onblink:voices', () => listVoices());

const cues = new Map();

function renderCue(text, voice) {
    const out = path.join(app.getPath('temp'), `onblink-cue-${crypto.randomUUID()}.wav`);
    const args = [...(voice ? ['-v', voice] : []), '-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', '-'];
    return new Promise((resolve) => {
        const child = spawn(SAY, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => resolve(null));
        child.on('close', (code) => {
            let data = null;
            try {
                if (!code) data = fs.readFileSync(out);
                fs.unlinkSync(out);
            } catch {}
            resolve(data);
        });
        child.stdin.end(text);
    });
}

ipcMain.handle('onblink:cue', async (event, text) => {
    const allowed = new Set([...config.actions.map((a) => a.label), ...CHECKIN_ACTIONS.map((a) => a.label), ...CUE_EXTRAS]);
    if (typeof text !== 'string' || !allowed.has(text)) return null;
    const key = `${config.voice}|${text}`;
    if (!cues.has(key)) {
        const data = await renderCue(text, config.voice);
        if (!data) return null;
        if (cues.size >= MAX_CUES) cues.delete(cues.keys().next().value);
        cues.set(key, data);
    }
    return cues.get(key);
});

let awakeId = null;

ipcMain.handle('onblink:keep-awake', (event, on) => {
    if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && awakeId !== null) {
        powerSaveBlocker.stop(awakeId);
        awakeId = null;
    }
});

function setupApp() {
    app.setAboutPanelOptions({
        applicationName: 'OnBlink',
        applicationVersion: app.getVersion(),
        copyright: 'MIT License. Built with the Presage SmartSpectra SDK.',
    });
    if (process.platform === 'darwin') app.dock.setIcon(ICON);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        {
            label: 'OnBlink',
            submenu: [
                { role: 'about', label: 'About OnBlink' },
                { type: 'separator' },
                { role: 'hide', label: 'Hide OnBlink' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit', label: 'Quit OnBlink' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
        },
        { role: 'windowMenu' },
    ]));
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1100,
        height: 780,
        backgroundColor: '#0e1014',
        title: 'OnBlink',
        icon: ICON,
        webPreferences: {
            preload: path.join(__dirname, 'dist', 'preload.bundle.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });

    bindSmartSpectraIpc(win);

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
    await loadConfig();
    setupApp();
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
        const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
        const mediaTypes = (details && details.mediaTypes) || [];
        const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
        callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
    });
    createWindow();
});

app.on('window-all-closed', () => app.quit());
