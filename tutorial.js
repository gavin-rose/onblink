'use strict';

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of [].concat(children)) node.append(c);
    return node;
}

function choice(name, value, checked, title, detail, onPick) {
    const input = el('input', { type: 'radio', name, value, checked });
    input.addEventListener('change', () => input.checked && onPick(value));
    return el('label', { className: 'choice' }, [input, el('span', {}, [title, el('small', { textContent: detail })])]);
}

function check(checked, text, onChange) {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { className: 'row' }, [input, text]);
}

class Tour {
    constructor(ctx) {
        this.ctx = ctx;
        this.dialog = document.getElementById('tour');
        this.q = (id) => document.getElementById(id);
        this.timers = [];
        this.q('tour-next').addEventListener('click', () => this.next());
        this.q('tour-back').addEventListener('click', () => this.go(this.index - 1));
        this.q('tour-skip').addEventListener('click', () => this.skip());
        this.dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            this.skip();
        });
    }

    open() {
        const c = this.ctx.config();
        this.work = {
            inputMode: c.inputMode || 'native',
            blinkSpacing: c.blinkSpacing || 'relaxed',
            readAloud: !!c.readAloud,
            checkin: { ...c.checkin },
        };
        this.understood = !!c.consentAccepted;
        this.steps = this.buildSteps();
        this.dialog.showModal();
        this.go(0);
    }

    clearTimers() {
        this.timers.forEach(clearInterval);
        this.timers = [];
    }

    go(i) {
        this.clearTimers();
        this.index = Math.max(0, Math.min(this.steps.length - 1, i));
        const step = this.steps[this.index];
        this.q('tour-step-label').textContent = `Step ${this.index + 1} of ${this.steps.length}`;
        this.q('tour-bar').style.width = `${((this.index + 1) / this.steps.length) * 100}%`;
        this.q('tour-title').textContent = step.title;
        this.q('tour-body').replaceChildren(...step.body());
        this.q('tour-back').disabled = this.index === 0;
        this.q('tour-next').textContent = step.nextLabel || 'Next';
        this.refreshNext();
        const nextBtn = this.q('tour-next');
        (nextBtn.disabled ? this.q('tour-body') : nextBtn).focus({ preventScroll: true });
    }

    refreshNext() {
        const step = this.steps[this.index];
        this.q('tour-next').disabled = step.canNext ? !step.canNext() : false;
    }

    async next() {
        const step = this.steps[this.index];
        if (step.onNext && (await step.onNext()) === false) return;
        if (this.index < this.steps.length - 1) this.go(this.index + 1);
    }

    async finish(practice) {
        this.clearTimers();
        const c = this.ctx.config();
        const res = await this.ctx.save({ ...c, ...this.work, consentAccepted: true, tutorialDone: true });
        this.dialog.close();
        if (res.ok && practice) this.ctx.startPractice();
    }

    async skip() {
        this.clearTimers();
        this.dialog.close();
        const c = this.ctx.config();
        if (!c.tutorialDone) await this.ctx.save({ ...c, tutorialDone: true });
    }

    modeVerb() {
        return this.work.inputMode === 'long' ? 'close your eyes for about a second' : 'blink twice';
    }

    buildSteps() {
        return [
            {
                title: 'Welcome to OnBlink',
                body: () => [
                    el('p', { textContent: 'OnBlink lets you speak a phrase out loud or open an app using only your eyes, with a regular webcam.' }),
                    el('p', { textContent: 'This short tour shows how the menu works, lets you pick the input that suits you, and explains what happens with your camera. It takes about a minute.' }),
                ],
            },
            {
                title: 'How the menu works',
                body: () => {
                    const items = ['Yes', 'No', 'I need help', "I'm thirsty", 'Cancel'];
                    const list = el('ol', { className: 'tour-demo' }, items.map((t) => el('li', { textContent: t })));
                    let i = 0;
                    const paint = () => [...list.children].forEach((li, n) => li.classList.toggle('active', n === i));
                    paint();
                    this.timers.push(setInterval(() => { i = (i + 1) % items.length; paint(); }, 1200));
                    return [
                        el('ol', {}, [
                            el('li', { textContent: 'Give the signal to open the menu.' }),
                            el('li', { textContent: 'The highlight moves down the list by itself, like the example below.' }),
                            el('li', { textContent: 'When your choice is highlighted, give the signal again to pick it.' }),
                            el('li', { textContent: 'Pick Cancel, or wait, and the menu closes on its own.' }),
                        ]),
                        list,
                    ];
                },
            },
            {
                title: 'Choose your signal',
                body: () => {
                    const spacing = el('div', { className: 'tour-body' }, [
                        el('p', { textContent: 'How quickly do you blink twice?' }),
                        choice('spacing', 'relaxed', this.work.blinkSpacing === 'relaxed', 'Relaxed', 'Blink, wait for "Blink again" on screen, then blink once more.', (v) => { this.work.blinkSpacing = v; }),
                        choice('spacing', 'quick', this.work.blinkSpacing === 'quick', 'Quick', 'Two fast blinks in a row.', (v) => { this.work.blinkSpacing = v; }),
                    ]);
                    spacing.hidden = this.work.inputMode !== 'native';
                    return [
                        choice('mode', 'native', this.work.inputMode === 'native', 'Double blink', 'Uses SmartSpectra\'s built-in blink detection. Blink twice to open the menu and twice to pick.', (v) => { this.work.inputMode = v; spacing.hidden = false; }),
                        choice('mode', 'long', this.work.inputMode === 'long', 'Long blink', 'Close your eyes for about a second instead. Very hard to trigger by accident, and often easier if double blinks get missed.', (v) => { this.work.inputMode = v; spacing.hidden = true; }),
                        spacing,
                        el('p', { className: 'note', textContent: 'You can switch at any time in Settings.' }),
                    ];
                },
            },
            {
                title: 'Your actions',
                body: () => {
                    const actions = this.ctx.config().actions || [];
                    return [
                        el('p', { textContent: 'Each menu item either says a phrase out loud or opens an app. You start with these:' }),
                        el('ul', {}, actions.slice(0, 8).map((a) => el('li', { textContent: `${a.label}${a.type === 'open' ? ' (opens an app)' : ''}` }))),
                        el('p', { textContent: 'In Settings you can add your own phrases and apps, reorder them so the ones you use most come first, test each one, and change the voice and how fast the menu moves.' }),
                    ];
                },
            },
            {
                title: 'Hear the options (optional)',
                body: () => [
                    el('p', { textContent: 'OnBlink can quietly say each menu option as it is highlighted, so you can use it without watching the screen closely.' }),
                    el('p', { textContent: 'Options play softly and can go to headphones or a single earbud, while the phrase you pick is spoken out loud for everyone. You can set this up in Settings.' }),
                    check(this.work.readAloud, 'Read options aloud', (v) => { this.work.readAloud = v; }),
                ],
            },
            {
                title: 'Check-ins (optional)',
                body: () => [
                    el('p', { textContent: 'OnBlink can estimate your heart rate from the camera. If it stays well above your own level from earlier in the same session, OnBlink offers a short check-in: "I am fine", "I need a break", or "I need help".' }),
                    el('p', { textContent: 'It is only an offer to talk. Nothing is said or sent unless you pick it, your heart rate is never saved, and check-ins appear at most once every 10 minutes.' }),
                    check(!!this.work.checkin.enabled, 'Turn on check-ins', (v) => { this.work.checkin.enabled = v; }),
                    el('p', { className: 'note', textContent: 'This is not a medical device and does not assess your health.' }),
                ],
            },
            {
                title: 'Getting in frame',
                body: () => [
                    el('ul', {}, [
                        el('li', { textContent: 'Sit about an arm\'s length from the screen, facing the camera.' }),
                        el('li', { textContent: 'Have light in front of you, not behind you.' }),
                        el('li', { textContent: 'When you press Start, an outline appears. Fit your face inside it and hold still for a moment.' }),
                        el('li', { textContent: 'OnBlink only listens once you are in position, and pauses if you move out of view.' }),
                    ]),
                ],
            },
            {
                title: 'Your Presage key',
                body: () => {
                    const status = el('p', { textContent: 'Checking...' });
                    const input = el('input', { type: 'password', placeholder: 'Paste your SmartSpectra API key', autocomplete: 'off', spellcheck: false });
                    const save = el('button', { className: 'primary', textContent: 'Save key' });
                    const msg = el('p', { className: 'note' });
                    const refresh = async () => {
                        const { source } = await this.ctx.keyStatus();
                        status.textContent = source === 'none'
                            ? 'OnBlink needs a free API key from Presage to use the camera features.'
                            : 'You already have a key set up. You can replace it below or skip this step.';
                    };
                    save.addEventListener('click', async () => {
                        const err = await this.ctx.setKey(input.value);
                        msg.textContent = err || 'Key saved. It is encrypted with your macOS Keychain.';
                        if (!err) input.value = '';
                        refresh();
                    });
                    const link = el('a', { href: '#', textContent: 'Get a free key from Presage' });
                    link.addEventListener('click', (e) => { e.preventDefault(); this.ctx.openSignup(); });
                    refresh();
                    return [status, el('div', { className: 'row' }, [input, save]), link, msg];
                },
            },
            {
                title: 'Camera and privacy',
                body: () => {
                    const details = document.querySelector('#consent ul').cloneNode(true);
                    return [
                        details,
                        el('p', { className: 'note', textContent: 'OnBlink is not a medical device and does not diagnose, treat, or monitor any condition. Do not rely on it in an emergency.' }),
                        check(this.understood, 'I understand how OnBlink uses my camera', (v) => { this.understood = v; this.refreshNext(); }),
                    ];
                },
                canNext: () => this.understood,
            },
            {
                title: 'You are ready',
                nextLabel: 'Finish',
                body: () => {
                    const practice = el('button', { className: 'primary', textContent: 'Try it now' });
                    practice.addEventListener('click', () => this.finish(true));
                    return [
                        el('p', { textContent: `To use OnBlink, press Start, get in frame, then ${this.modeVerb()} to open the menu.` }),
                        el('p', { textContent: 'Want a quick practice? OnBlink will start the camera and walk you through opening the menu and picking "Yes".' }),
                        practice,
                    ];
                },
                onNext: () => this.finish(false),
            },
        ];
    }
}

module.exports = { Tour };
