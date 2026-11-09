'use strict';

const LEVELS = {
    gentle: { delta: 20, pct: 0.25, sustainMs: 60_000 },
    normal: { delta: 15, pct: 0.2, sustainMs: 45_000 },
    sensitive: { delta: 10, pct: 0.15, sustainMs: 30_000 },
};

const BASELINE_MS = 60_000;
const MIN_BASELINE_SAMPLES = 20;
const MAX_GAP_MS = 10_000;
const DIP_TOLERANCE_MS = 5_000;
const MOTION_HOLD_MS = 10_000;
const COOLDOWN_MS = 10 * 60_000;

function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

class CheckIn {
    constructor({ onPrompt, onState } = {}) {
        this.onPrompt = onPrompt || (() => {});
        this.onState = onState || (() => {});
        this.enabled = false;
        this.level = LEVELS.normal;
        this.reset();
    }

    configure({ enabled, sensitivity }) {
        this.enabled = !!enabled;
        this.level = LEVELS[sensitivity] || LEVELS.normal;
        if (!this.enabled) this.reset();
        this.emit(Date.now());
    }

    reset() {
        this.samples = [];
        this.firstStable = 0;
        this.baseline = null;
        this.elevatedSince = 0;
        this.belowSince = 0;
        this.lastStable = 0;
        this.lastMotion = 0;
        this.lastPrompt = 0;
    }

    get threshold() {
        return this.baseline == null ? null : this.baseline + Math.max(this.level.delta, this.baseline * this.level.pct);
    }

    setMotion(now) {
        this.lastMotion = now;
        this.elevatedSince = 0;
    }

    push(value, stable, now) {
        if (!this.enabled || !Number.isFinite(value)) return;
        if (!stable) {
            if (this.lastStable && now - this.lastStable > MAX_GAP_MS) this.elevatedSince = 0;
            return this.emit(now);
        }
        if (this.lastStable && now - this.lastStable > MAX_GAP_MS) this.elevatedSince = 0;
        this.lastStable = now;

        if (this.baseline == null) {
            if (!this.firstStable) this.firstStable = now;
            this.samples.push(value);
            if (now - this.firstStable >= BASELINE_MS && this.samples.length >= MIN_BASELINE_SAMPLES) {
                this.baseline = median(this.samples);
                this.samples = [];
            }
            return this.emit(now);
        }

        if (now - this.lastMotion < MOTION_HOLD_MS) {
            this.elevatedSince = 0;
        } else if (value >= this.threshold) {
            this.belowSince = 0;
            if (!this.elevatedSince) this.elevatedSince = now;
            const sustained = now - this.elevatedSince >= this.level.sustainMs;
            const cooled = !this.lastPrompt || now - this.lastPrompt >= COOLDOWN_MS;
            if (sustained && cooled) this.prompt(now, 'elevated');
        } else if (this.elevatedSince) {
            if (!this.belowSince) this.belowSince = now;
            if (now - this.belowSince > DIP_TOLERANCE_MS) {
                this.elevatedSince = 0;
                this.belowSince = 0;
            }
        }
        this.emit(now);
    }

    prompt(now, reason) {
        this.lastPrompt = now;
        this.elevatedSince = 0;
        this.belowSince = 0;
        this.onPrompt(reason);
    }

    test() {
        this.onPrompt('test');
    }

    emit(now) {
        this.onState({
            enabled: this.enabled,
            learning: this.enabled && this.baseline == null,
            learnedMs: this.firstStable ? Math.min(BASELINE_MS, now - this.firstStable) : 0,
            learnMs: BASELINE_MS,
            baseline: this.baseline,
            threshold: this.threshold,
            elevatedMs: this.elevatedSince ? now - this.elevatedSince : 0,
            sustainMs: this.level.sustainMs,
        });
    }
}

module.exports = { CheckIn, LEVELS };
