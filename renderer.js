'use strict';

const {
    SmartSpectraSDK,
    ProcessingStatus,
    ValidationCode,
    SmartSpectraErrorCode,
    cardioMetrics,
    faceMetrics,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const { EyeTracker } = require('./eyes');
const { PhraseMenu, CANCEL } = require('./menu');
const { CheckIn } = require('./checkin');
const { Tour } = require('./tutorial');

const USAGE_KEY = 'onblink.liveSecondsUsed';
const LONG_MS = 700;

const $ = (id) => document.getElementById(id);
const els = {
    preview: $('preview'),
    hint: $('hint'),
    status: $('status'),
    error: $('error'),
    usage: $('usage'),
    usageReset: $('usage-reset'),
    start: $('btn-start'),
    stop: $('btn-stop'),
    autoStop: $('auto-stop'),
    countdown: $('countdown'),
    eyeState: $('eye-state'),
    holdBar: $('hold-bar'),
    menu: $('menu'),
    menuIdle: $('menu-idle'),
    lastEvent: $('last-event'),
    practice: $('practice'),
    tourBtn: $('btn-tour'),
    actionList: $('action-list'),
    add: $('btn-add'),
    step: $('step'),
    stepVal: $('step-val'),
    voice: $('voice'),
    save: $('btn-save'),
    revert: $('btn-revert'),
    saveMsg: $('save-msg'),
    hr: $('hr'),
    checkinState: $('checkin-state'),
    menuTitle: $('menu-title'),
    checkinEnabled: $('checkin-enabled'),
    checkinSensitivity: $('checkin-sensitivity'),
    consent: $('consent'),
    consentCheckin: $('consent-checkin'),
    consentAccept: $('consent-accept'),
    consentCancel: $('consent-cancel'),
    readAloud: $('read-aloud'),
    cueDevice: $('cue-device'),
    cueVolume: $('cue-volume'),
    cueVolumeVal: $('cue-volume-val'),
    cueTest: $('cue-test'),
    keyStatus: $('key-status'),
    keyInput: $('key-input'),
    keySave: $('key-save'),
    keyClear: $('key-clear'),
    keySignup: $('key-signup'),
    keyMsg: $('key-msg'),
    guide: $('guide'),
    howto: $('howto'),
    inputMode: $('input-mode'),
    blinkSpacing: $('blink-spacing'),
    setup: $('setup'),
    setupText: $('setup-text'),
    setupProgress: $('setup-progress'),
};

const ERROR_NAMES = Object.fromEntries(Object.entries(SmartSpectraErrorCode).map(([k, v]) => [v, k.slice(1)]));
const FRIENDLY_ERRORS = {
    AuthenticationFailed: 'Presage did not accept the API key. Check or replace it in Settings.',
    CreditExhausted: 'This Presage key has used up its available time. Check your plan at physiology.presagetech.com.',
    NetworkError: 'Could not reach Presage. Check your internet connection and try again.',
    ServerError: 'Presage had a server problem. Try again in a minute.',
    InputUnavailable: 'The camera is not available. Close other apps that use it, and allow camera access in System Settings > Privacy & Security > Camera.',
    ConfigurationFailed: 'The SDK could not start with these settings.',
};

function friendlyError(code, message) {
    if (code === 'NotAllowedError' || /permission|notallowed/i.test(message || '')) {
        return 'Camera access was blocked. Allow it in System Settings > Privacy & Security > Camera, then press Start again.';
    }
    const name = typeof code === 'number' ? ERROR_NAMES[code] : String(code || '').replace(/^k/, '');
    const friendly = FRIENDLY_ERRORS[name] || 'Something went wrong while running the SDK.';
    return `${friendly}${message ? ` Details: ${name ? name + ', ' : ''}${message}` : ''}`;
}

const MOTION_CODES = new Set(['ExcessiveMotion', 'NoFaceFound']);
const FRAME_OK = new Set(['Ok', 'ChestNotVisible', 'CameraTuning', 'FrameRateTooLow']);
const SETTLE_MS = 2000;
const SPACING = {
    relaxed: { min: 400_000, max: 1_500_000 },
    quick: { min: 280_000, max: 800_000 },
};
const AFTER_PICK_US = 1_500_000;
const IDLE_TEXT = { native: 'Double blink to open the menu', long: 'Long blink to open the menu' };
const STALE_MS = 1500;

const STATUS_NAMES = Object.fromEntries(Object.entries(ProcessingStatus).map(([k, v]) => [v, k.slice(1)]));
const VALIDATION_NAMES = Object.fromEntries(Object.entries(ValidationCode).map(([k, v]) => [v, k.slice(1)]));

let sdk = null;
let sessionStartMs = 0;
let countdownTimer = null;
let config = { stepMs: 1600, voice: '', consentAccepted: false, checkin: { enabled: false, sensitivity: 'normal' }, actions: [], checkinActions: [] };
let pendingCheckin = null;
let nativeOpen = false;
let firstBlinkTs = 0;
let firstBlinkTimer = null;
let lastDoubleTs = 0;
let blinkFlashTimer = null;
const framing = { phase: 'idle', goodSince: 0, lastOk: false, lastMs: 0, hint: '' };
let menuItems = [];
let menuTitleText = '';
let draft = null;
let audioCtx = null;

const toNum = (ts) => (ts == null ? 0 : typeof ts === 'object' && ts.toNumber ? ts.toNumber() : Number(ts));

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of [].concat(children)) node.append(c);
    return node;
}

function beep(freqs, ms = 120) {
    try {
        audioCtx = audioCtx || new AudioContext();
        freqs.forEach((f, i) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const t = audioCtx.currentTime + i * (ms / 1000);
            osc.frequency.value = f;
            gain.gain.setValueAtTime(0.15, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(t);
            osc.stop(t + ms / 1000);
        });
    } catch {}
}

const cueAudio = new Audio();
let cueToken = 0;

async function playCues(texts, opts = config) {
    const token = ++cueToken;
    cueAudio.pause();
    try {
        await cueAudio.setSinkId?.(opts.cueDevice || '');
    } catch {}
    for (const text of texts) {
        const data = await window.onblink.cue(text);
        if (token !== cueToken) return;
        if (!data) continue;
        const url = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
        cueAudio.src = url;
        cueAudio.volume = opts.cueVolume ?? 0.3;
        await new Promise((resolve) => {
            cueAudio.onended = resolve;
            cueAudio.onerror = resolve;
            cueAudio.onpause = resolve;
            cueAudio.play().catch(resolve);
        });
        URL.revokeObjectURL(url);
        if (token !== cueToken) return;
    }
}

function speakLabel(texts) {
    if (config.readAloud) playCues(texts);
}

function stopSpeaking() {
    cueToken++;
    cueAudio.pause();
}

async function loadOutputs() {
    try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default');
        const current = draft?.cueDevice || '';
        els.cueDevice.replaceChildren(
            el('option', { value: '', textContent: 'Same output as phrases' }),
            ...devices.map((d, i) => el('option', { value: d.deviceId, textContent: d.label || `Audio output ${i + 1}` })),
        );
        if (current && !devices.some((d) => d.deviceId === current)) {
            els.cueDevice.append(el('option', { value: current, textContent: 'Saved device (not connected)' }));
        }
        els.cueDevice.value = current;
    } catch {}
}

let lastEventTimer = null;

function log(text) {
    console.info(`[onblink] ${text}`);
    els.lastEvent.textContent = text;
    clearTimeout(lastEventTimer);
    lastEventTimer = setTimeout(() => { els.lastEvent.textContent = ''; }, 6000);
}

let practice = null;

function signalText() {
    return longMode() ? 'close your eyes for about a second' : 'blink twice';
}

function renderPractice() {
    if (!practice) {
        els.practice.hidden = true;
        return;
    }
    const target = practiceTarget();
    const text = {
        frame: 'Practice: fit your face in the outline and hold still for a moment.',
        open: `Practice: ${signalText()} to open the menu.`,
        pick: `Now wait until "${target}" is highlighted, then ${signalText()} to pick it.`,
        retry: `No problem. ${signalText()[0].toUpperCase() + signalText().slice(1)} to open the menu again.`,
        done: 'Nice, that is all there is to it. You can add your own phrases and apps in Settings.',
    }[practice];
    const done = el('button', { textContent: practice === 'done' ? 'Close' : 'End practice' });
    done.addEventListener('click', () => { practice = null; renderPractice(); });
    els.practice.replaceChildren(el('div', { textContent: text }), el('div', { className: 'practice-actions' }, [done]));
    els.practice.hidden = false;
}

function practiceTarget() {
    return config.actions.find((a) => a.type === 'say')?.label || config.actions[0]?.label || 'an item';
}

function setPractice(stage) {
    if (!practice) return;
    practice = stage;
    renderPractice();
}

async function startPractice() {
    showView('use');
    practice = 'frame';
    renderPractice();
    if (!sessionStartMs) await start();
}

function readUsage() {
    try { return Number(localStorage.getItem(USAGE_KEY)) || 0; } catch { return 0; }
}

function addUsage(seconds) {
    try { localStorage.setItem(USAGE_KEY, String(readUsage() + seconds)); } catch {}
    renderUsage();
}

function formatLeft(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

function renderUsage() {
    const s = Math.round(readUsage());
    els.usage.textContent = `Camera time used on this computer: ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showError(message) {
    els.error.hidden = false;
    els.error.textContent = message;
}

const menu = new PhraseMenu({
    onOpen: (items, title) => {
        if (!title) beep([880]);
        if (!title && (practice === 'open' || practice === 'retry')) setPractice('pick');
        els.menuTitle.textContent = title;
        els.menuTitle.hidden = !title;
        els.menu.replaceChildren(...items.map((item) => el('li', { textContent: item.label })));
        menuItems = items;
        menuTitleText = title;
        els.menu.hidden = false;
        els.menuIdle.hidden = true;
    },
    onStep: (index) => {
        [...els.menu.children].forEach((li, i) => li.classList.toggle('active', i === index));
        const label = menuItems[index]?.label;
        if (label) speakLabel(index === 0 && menuTitleText ? [menuTitleText, label] : [label]);
    },
    onLock: (index) => {
        [...els.menu.children].forEach((li, i) => li.classList.toggle('locked', i === index));
    },
    onSelect: (item) => {
        if (practice === 'pick') setPractice('done');
        runAction(item);
    },
    onClose: (reason) => {
        stopSpeaking();
        els.menu.hidden = true;
        els.menuTitle.hidden = true;
        els.menuIdle.hidden = false;
        if (reason === 'cancelled' || reason === 'timed out') {
            beep([330]);
            log(`Menu ${reason}`);
            if (practice === 'pick') setPractice('retry');
        }
        if (pendingCheckin && sessionStartMs && reason !== 'replaced') {
            const r = pendingCheckin;
            pendingCheckin = null;
            setTimeout(() => openCheckin(r), 3000);
        }
    },
});

function listening() {
    return framing.phase === 'ready' && framing.lastOk && Date.now() - framing.lastMs < STALE_MS;
}

function onFraming(name, hint) {
    const now = Date.now();
    const ok = FRAME_OK.has(name);
    framing.lastOk = ok;
    framing.lastMs = now;
    framing.hint = ok ? '' : hint || name;
    if (!ok) framing.goodSince = 0;
    else if (!framing.goodSince) framing.goodSince = now;
    renderFraming();
}

function tickFraming() {
    if (framing.phase === 'idle') return;
    if (framing.phase === 'positioning' && framing.lastOk && framing.goodSince && Date.now() - framing.goodSince >= SETTLE_MS) {
        framing.phase = 'ready';
        tracker.reset();
        beep([660, 880]);
        log(`In position, listening for ${longMode() ? 'long blinks' : 'double blinks'}`);
        if (practice === 'frame') setPractice('open');
        if (!longMode()) els.eyeState.textContent = 'Watching for double blinks';
    }
    if (pendingCheckin && listening() && !menu.open) {
        const r = pendingCheckin;
        pendingCheckin = null;
        openCheckin(r);
    }
    renderFraming();
}

function renderFraming() {
    const active = framing.phase !== 'idle';
    const fresh = Date.now() - framing.lastMs < STALE_MS;
    const good = framing.lastOk && fresh;
    els.guide.hidden = !active || (framing.phase === 'ready' && good);
    els.guide.classList.toggle('good', good);
    if (framing.phase === 'positioning') {
        const pct = good && framing.goodSince ? Math.min(1, (Date.now() - framing.goodSince) / SETTLE_MS) : 0;
        els.setup.hidden = false;
        els.setupText.textContent = !framing.lastMs ? 'Getting the camera ready...'
            : good ? 'Good, hold still...' : `Fit your face in the outline. ${framing.hint}`;
        els.setupProgress.style.width = `${pct * 100}%`;
    } else if (framing.phase === 'ready' && !good) {
        els.setup.hidden = false;
        els.setupText.textContent = `Paused. ${framing.hint || 'Move back into view.'}`;
        els.setupProgress.style.width = '0';
    } else {
        els.setup.hidden = true;
    }
}

const longMode = () => config.inputMode === 'long';

function renderHowto() {
    const mode = longMode() ? 'long' : 'native';
    els.menuIdle.textContent = IDLE_TEXT[mode];
    els.holdBar.parentElement.hidden = mode !== 'long';
}

function handleNativeBlinks(samples) {
    for (const sample of samples || []) {
        const detected = !!sample.detected;
        if (detected && !nativeOpen) onNativeBlink(toNum(sample.timestamp));
        nativeOpen = detected;
    }
}

function onNativeBlink(ts) {
    if (longMode()) return;
    els.eyeState.textContent = 'Blink';
    clearTimeout(blinkFlashTimer);
    blinkFlashTimer = setTimeout(() => {
        if (sessionStartMs && !longMode()) els.eyeState.textContent = 'Watching for double blinks';
    }, 300);
    if (!listening() || ts - lastDoubleTs < AFTER_PICK_US) return;
    const spacing = SPACING[config.blinkSpacing] || SPACING.relaxed;
    const gap = ts - firstBlinkTs;
    if (firstBlinkTs && gap < spacing.min) return;
    if (firstBlinkTs && gap <= spacing.max) {
        clearTimeout(firstBlinkTimer);
        firstBlinkTs = 0;
        lastDoubleTs = ts;
        menu.longBlink();
        menu.unlock();
        return;
    }
    firstBlinkTs = ts;
    menu.closeStart();
    clearTimeout(blinkFlashTimer);
    clearTimeout(firstBlinkTimer);
    setTimeout(() => {
        if (firstBlinkTs === ts) els.eyeState.textContent = 'Blink again';
    }, spacing.min / 1000);
    firstBlinkTimer = setTimeout(() => {
        firstBlinkTs = 0;
        menu.unlock();
        if (sessionStartMs && !longMode()) els.eyeState.textContent = 'Watching for double blinks';
    }, spacing.max / 1000 + 100);
}

const tracker = new EyeTracker({
    onCloseStart: () => { if (longMode() && listening()) menu.closeStart(); },
    onCloseEnd: () => { if (longMode()) menu.unlock(); },
    onLongBlink: (ms) => {
        if (!longMode()) return;
        if (!listening()) return log(`Ignored ${Math.round(ms)} ms closure (not in position)`);
        menu.longBlink();
    },
    onRejected: (reason, ms) => { if (longMode()) log(`Ignored ${Math.round(ms)} ms closure (${reason})`); },
    onState: (st) => {
        if (!longMode()) return;
        if (!st.ready) {
            els.eyeState.textContent = 'Calibrating, keep your eyes open';
            els.holdBar.style.width = '0';
            return;
        }
        const pct = st.closed ? Math.min(1, st.closedMs / LONG_MS) : 0;
        els.eyeState.textContent = st.closed ? 'Eyes closed' : 'Eyes open';
        els.holdBar.style.width = `${pct * 100}%`;
        els.holdBar.classList.toggle('full', pct >= 1);
    },
});

const checkin = new CheckIn({
    onPrompt: (reason) => openCheckin(reason),
    onState: (st) => {
        let text = 'Check-ins off';
        if (st.enabled && !sessionStartMs) text = 'Check-ins on';
        else if (st.learning) text = st.learnedMs ? `Learning your level ${Math.round(st.learnedMs / 1000)}/${st.learnMs / 1000}s` : 'Check-ins on, waiting for a steady reading';
        else if (st.enabled) text = `Your level ${Math.round(st.baseline)} bpm` + (st.elevatedMs ? `, higher for ${Math.round(st.elevatedMs / 1000)}s` : '');
        els.checkinState.textContent = text;
        els.checkinState.classList.toggle('on', st.enabled);
    },
});

function openCheckin(reason) {
    if (!sessionStartMs) return;
    if (menu.open || !listening()) {
        pendingCheckin = reason;
        return;
    }
    beep([523, 659, 784], 140);
    log(reason === 'test' ? 'Test check-in' : 'Check-in offered');
    const title = reason === 'test'
        ? 'Test check-in. Want to check in?'
        : 'Your heart rate has been higher than earlier in this session for a while. Want to check in?';
    menu.start([...config.checkinActions, { id: CANCEL.id, label: 'Dismiss' }], title);
}

async function runAction(item) {
    stopSpeaking();
    beep([660, 990]);
    log(`Selected: ${item.label}`);
    const err = await window.onblink.run(item.id);
    if (err) log(`${item.label} failed: ${err}`);
}

function applyConfig(next) {
    config = next;
    menu.setStepMs(config.stepMs);
    checkin.configure(config.checkin);
    renderHowto();
    if (sessionStartMs) {
        tracker.reset();
        els.eyeState.textContent = longMode() ? 'Calibrating, keep your eyes open' : 'Watching for double blinks';
    }
    menu.setItems(config.actions.map(({ id, label }) => ({ id, label })));
}

function handleMetrics(buf) {
    const decoded = decodeMetrics(buf);
    const face = decoded.face;
    const hr = decoded.cardio?.pulseRate?.at(-1);
    if (hr) {
        els.hr.textContent = `Heart rate ${hr.value.toFixed(0)} bpm${hr.stable ? '' : ' (settling)'}`;
        checkin.push(hr.value, !!hr.stable, Date.now());
    }
    if (!face) return;
    handleNativeBlinks(face.blinking);
    if (!longMode()) return;
    const talking = face.talking?.at(-1);
    if (talking) tracker.setTalking(!!talking.detected);
    for (const sample of face.landmarks || []) {
        if (sample?.value?.length) tracker.push(toNum(sample.timestamp), sample.value);
    }
}

function setStatus(status) {
    els.status.textContent = STATUS_NAMES[status] || `Status ${status}`;
    els.status.className = 'badge ' + (status === ProcessingStatus.kRunning ? 'running' : status === ProcessingStatus.kError ? 'error' : '');
}

function buildSdk(apiKey) {
    sdk = new SmartSpectraSDK({
        apiKey,
        requestedMetrics: [...faceMetrics, ...cardioMetrics],
        enableAccumulatedOutput: false,
        enableTelemetry: false,
    });
    sdk.on('processingStatus', setStatus);
    sdk.on('validationStatus', (code, ts, hint) => {
        const name = VALIDATION_NAMES[code] || `Code ${code}`;
        els.hint.textContent = FRAME_OK.has(name) ? 'In view' : hint || name;
        onFraming(name, hint);
        if (MOTION_CODES.has(name)) checkin.setMotion(Date.now());
        els.hint.className = 'hint ' + (code === ValidationCode.kOk ? 'ok' : code === ValidationCode.kCameraTuning ? 'warn' : 'err');
    });
    sdk.on('metrics', (buf) => {
        try { handleMetrics(buf); } catch (e) { console.error('decode failed', e); }
    });
    sdk.on('error', (code, message, retryable) => {
        showError(friendlyError(code, message) + (retryable ? ' You can try pressing Start again.' : ''));
    });
    sdk.on('streamAvailable', (stream) => {
        els.preview.srcObject = stream;
        els.preview.play().catch(() => {});
    });
}

async function start() {
    const { key } = await window.onblink.key();
    if (!key) {
        showError('Add your Presage API key in Settings to start.');
        showView('actions');
        els.keyInput.focus();
        return;
    }
    if (!config.consentAccepted) {
        els.consentCheckin.checked = !!config.checkin.enabled;
        els.consent.showModal();
        return;
    }
    await startSession();
}

async function acceptConsent() {
    const res = await window.onblink.save({
        ...config,
        consentAccepted: true,
        checkin: { ...config.checkin, enabled: els.consentCheckin.checked },
    });
    els.consent.close();
    if (!res.ok) return showError(res.error);
    applyConfig(res.config);
    resetDraft();
    await startSession();
}

async function startSession() {
    els.error.hidden = true;
    els.start.disabled = true;
    tracker.reset();
    checkin.reset();
    checkin.configure(config.checkin);
    pendingCheckin = null;
    menu.close('reset');
    els.lastEvent.textContent = '';
    Object.assign(framing, { phase: 'positioning', goodSince: 0, lastOk: false, lastMs: 0, hint: '' });
    renderFraming();
    sessionStartMs = Date.now();
    countdownTimer = setInterval(() => {
        const limitS = (config.autoStopMin || 0) * 60;
        const left = limitS - (Date.now() - sessionStartMs) / 1000;
        els.countdown.textContent = limitS ? `Stops in ${formatLeft(left)}` : '';
        tickFraming();
        if (limitS && left <= 0) stop();
    }, 250);
    try {
        const { key } = await window.onblink.key();
        buildSdk(key);
        els.stop.disabled = false;
        window.onblink.keepAwake(true);
        await sdk.start();
    } catch (err) {
        showError(friendlyError(err.code ?? err.name, err.message));
        await stop();
    }
}

async function stop() {
    if (!sessionStartMs) return;
    const elapsed = (Date.now() - sessionStartMs) / 1000;
    sessionStartMs = 0;
    window.onblink.keepAwake(false);
    menu.close('stopped');
    clearInterval(countdownTimer);
    els.countdown.textContent = '';
    els.stop.disabled = true;
    try { if (sdk) await sdk.stop(); } catch (err) { console.error('stop failed', err); }
    try { if (sdk) sdk.destroy(); } catch {}
    sdk = null;
    addUsage(elapsed);
    els.preview.srcObject = null;
    els.start.disabled = false;
    els.eyeState.textContent = 'Not running';
    els.holdBar.style.width = '0';
    els.hr.textContent = 'Heart rate -';
    framing.phase = 'idle';
    renderFraming();
    els.hint.textContent = 'Press Start, then look at the camera.';
    els.hint.className = 'hint';
    if (practice !== 'done') practice = null;
    renderPractice();
    nativeOpen = false;
    firstBlinkTs = 0;
    lastDoubleTs = 0;
    clearTimeout(firstBlinkTimer);
    pendingCheckin = null;
    checkin.reset();
    checkin.configure(config.checkin);
}

function setSaveMsg(text, kind = '') {
    els.saveMsg.textContent = text;
    els.saveMsg.className = 'save-msg ' + kind;
}

function markDirty() {
    setSaveMsg('Unsaved changes');
}

function renderEditor() {
    els.step.value = draft.stepMs;
    els.stepVal.textContent = `${(draft.stepMs / 1000).toFixed(1)}s`;
    els.voice.value = draft.voice;
    els.checkinEnabled.checked = !!draft.checkin.enabled;
    els.readAloud.checked = !!draft.readAloud;
    els.cueVolume.value = draft.cueVolume ?? 0.3;
    els.cueVolumeVal.textContent = `${Math.round((draft.cueVolume ?? 0.3) * 100)}%`;
    if (els.cueDevice.value !== (draft.cueDevice || '')) loadOutputs();
    els.inputMode.value = draft.inputMode || 'native';
    els.blinkSpacing.value = draft.blinkSpacing || 'relaxed';
    els.autoStop.value = String(draft.autoStopMin || 0);
    els.checkinSensitivity.value = draft.checkin.sensitivity;
    if (!draft.actions.length) {
        els.actionList.replaceChildren(el('div', { className: 'empty', textContent: 'No actions yet. Add one to get started.' }));
        return;
    }
    els.actionList.replaceChildren(...draft.actions.map((a, i) => actionRow(a, i)));
}

function actionRow(a, i) {
    const label = el('input', { type: 'text', value: a.label, placeholder: 'Menu label' });
    label.addEventListener('input', () => { a.label = label.value; markDirty(); });

    const type = el('select', {}, [
        el('option', { value: 'say', textContent: 'Say' }),
        el('option', { value: 'open', textContent: 'Open app' }),
    ]);
    type.value = a.type;
    type.addEventListener('change', () => {
        a.type = type.value;
        markDirty();
        renderEditor();
    });

    let detail;
    if (a.type === 'say') {
        detail = el('input', { type: 'text', value: a.text || '', placeholder: 'What to say out loud' });
        detail.addEventListener('input', () => { a.text = detail.value; markDirty(); });
    } else {
        const name = a.app ? a.app.split('/').pop().replace(/\.app$/, '') : 'Choose app...';
        detail = el('button', { className: 'app-pick', textContent: name, title: a.app || '' });
        detail.addEventListener('click', async () => {
            const picked = await window.onblink.pickApp();
            if (!picked) return;
            a.app = picked.app;
            if (!a.label.trim()) a.label = `Open ${picked.name}`;
            markDirty();
            renderEditor();
        });
    }

    const test = el('button', { textContent: 'Test' });
    test.addEventListener('click', async () => {
        const err = await window.onblink.test(a, draft.voice);
        setSaveMsg(err ? `Test failed: ${err}` : `Tested "${a.label}"`, err ? 'err' : 'ok');
    });
    const up = el('button', { textContent: '↑', title: 'Move up', disabled: i === 0 });
    up.addEventListener('click', () => move(i, -1));
    const down = el('button', { textContent: '↓', title: 'Move down', disabled: i === draft.actions.length - 1 });
    down.addEventListener('click', () => move(i, 1));
    const del = el('button', { textContent: '✕', title: 'Delete', className: 'danger' });
    del.addEventListener('click', () => {
        draft.actions.splice(i, 1);
        markDirty();
        renderEditor();
    });

    return el('div', { className: 'action-row' }, [
        el('span', { className: 'num', textContent: String(i + 1) }),
        label,
        type,
        detail,
        el('div', { className: 'buttons' }, [test, up, down, del]),
    ]);
}

function move(i, dir) {
    const [a] = draft.actions.splice(i, 1);
    draft.actions.splice(i + dir, 0, a);
    markDirty();
    renderEditor();
}

function resetDraft() {
    draft = structuredClone(config);
    setSaveMsg('');
    renderEditor();
}

async function saveDraft() {
    const res = await window.onblink.save(draft);
    if (!res.ok) return setSaveMsg(res.error, 'err');
    applyConfig(res.config);
    resetDraft();
    setSaveMsg('Saved', 'ok');
}

function showView(name) {
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.view === name);
    $('view-use').hidden = name !== 'use';
    $('view-actions').hidden = name !== 'actions';
    if (name === 'actions') loadOutputs();
}

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showView(tab.dataset.view));
els.start.addEventListener('click', start);
els.stop.addEventListener('click', stop);
els.add.addEventListener('click', () => {
    draft.actions.push({ label: '', type: 'say', text: '' });
    markDirty();
    renderEditor();
    els.actionList.querySelector('.action-row:last-child input')?.focus();
});
els.step.addEventListener('input', () => {
    draft.stepMs = Number(els.step.value);
    els.stepVal.textContent = `${(draft.stepMs / 1000).toFixed(1)}s`;
    markDirty();
});
els.voice.addEventListener('change', () => { draft.voice = els.voice.value; markDirty(); });
els.checkinEnabled.addEventListener('change', () => { draft.checkin.enabled = els.checkinEnabled.checked; markDirty(); });
els.checkinSensitivity.addEventListener('change', () => { draft.checkin.sensitivity = els.checkinSensitivity.value; markDirty(); });
els.consentAccept.addEventListener('click', acceptConsent);
els.consentCancel.addEventListener('click', () => els.consent.close());
window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k' && sessionStartMs) {
        e.preventDefault();
        checkin.test();
    }
});
els.inputMode.addEventListener('change', () => { draft.inputMode = els.inputMode.value; markDirty(); });
els.autoStop.addEventListener('change', () => { draft.autoStopMin = Number(els.autoStop.value); markDirty(); });
els.blinkSpacing.addEventListener('change', () => { draft.blinkSpacing = els.blinkSpacing.value; markDirty(); });
els.cueVolume.addEventListener('input', () => {
    draft.cueVolume = Number(els.cueVolume.value);
    els.cueVolumeVal.textContent = `${Math.round(draft.cueVolume * 100)}%`;
    markDirty();
});
els.cueDevice.addEventListener('change', () => { draft.cueDevice = els.cueDevice.value; markDirty(); });
els.cueTest.addEventListener('click', () => {
    const label = config.actions[0]?.label || 'Cancel';
    playCues([label], draft);
});
navigator.mediaDevices?.addEventListener?.('devicechange', loadOutputs);
els.readAloud.addEventListener('change', () => { draft.readAloud = els.readAloud.checked; markDirty(); });
els.keySave.addEventListener('click', async () => {
    const err = await window.onblink.setKey(els.keyInput.value);
    els.keyMsg.textContent = err || 'Key saved.';
    els.keyMsg.className = 'save-msg ' + (err ? 'err' : 'ok');
    if (!err) {
        els.keyInput.value = '';
        els.error.hidden = true;
    }
    refreshKeyStatus();
});
els.keyClear.addEventListener('click', async () => {
    await window.onblink.clearKey();
    els.keyMsg.textContent = 'Saved key removed.';
    els.keyMsg.className = 'save-msg';
    refreshKeyStatus();
});
els.keySignup.addEventListener('click', (e) => {
    e.preventDefault();
    window.onblink.openSignup();
});
els.usageReset.addEventListener('click', () => {
    try { localStorage.removeItem(USAGE_KEY); } catch {}
    renderUsage();
});
els.save.addEventListener('click', saveDraft);
els.revert.addEventListener('click', resetDraft);
window.addEventListener('beforeunload', () => {
    if (sdk) { try { sdk.destroy(); } catch {} }
});

async function refreshKeyStatus() {
    const { source, encryption } = await window.onblink.keyStatus();
    const text = {
        keychain: 'Using your saved key.',
        env: 'Using the key from the .env file. Saving a key here will take priority.',
        none: 'No key yet. Paste one below to get started.',
    }[source];
    els.keyStatus.textContent = encryption ? text : `${text} Secure storage is unavailable, so a key cannot be saved here.`;
    els.keyStatus.className = 'key-status ' + (source === 'none' ? 'err' : 'ok');
    els.keyClear.disabled = source !== 'keychain';
}

async function init() {
    renderUsage();
    refreshKeyStatus();
    applyConfig(await window.onblink.config());
    const voices = await window.onblink.voices();
    els.voice.append(...voices.map((v) => el('option', { value: v.name, textContent: `${v.name} (${v.lang})` })));
    resetDraft();
    loadOutputs();
    if (!config.tutorialDone) tour.open();
}

const tour = new Tour({
    config: () => config,
    save: async (next) => {
        const res = await window.onblink.save(next);
        if (res.ok) {
            applyConfig(res.config);
            resetDraft();
        } else {
            showError(res.error);
        }
        return res;
    },
    keyStatus: () => window.onblink.keyStatus(),
    setKey: async (key) => {
        const err = await window.onblink.setKey(key);
        refreshKeyStatus();
        return err;
    },
    openSignup: () => window.onblink.openSignup(),
    startPractice,
});

els.tourBtn.addEventListener('click', () => {
    if (!sessionStartMs) tour.open();
});

init();
