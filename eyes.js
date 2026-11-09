'use strict';

const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
const LEFT_EYE = [362, 385, 387, 263, 373, 380];

const BASELINE_US = 3_000_000;
const MIN_BASELINE_FRAMES = 30;
const CLOSE_BELOW = 0.78;
const OPEN_ABOVE = 0.88;
const OPEN_FRAMES_TO_END = 3;
const BLINK_MIN_US = 66_000;
const LONG_MIN_US = 700_000;
const LONG_MAX_US = 2_500_000;
const MAX_FRAME_GAP_US = 300_000;
const MAX_NOSE_TRAVEL = 0.06;
const NOSE = 1;

function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function ear(pts, [p1, p2, p3, p4, p5, p6]) {
    const horiz = dist(pts[p1], pts[p4]);
    return horiz ? (dist(pts[p2], pts[p6]) + dist(pts[p3], pts[p5])) / (2 * horiz) : 0;
}

function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

class EyeTracker {
    constructor({ onCloseStart, onCloseEnd, onBlink, onLongBlink, onRejected, onState } = {}) {
        this.onCloseStart = onCloseStart || (() => {});
        this.onCloseEnd = onCloseEnd || (() => {});
        this.onBlink = onBlink || (() => {});
        this.onLongBlink = onLongBlink || (() => {});
        this.onRejected = onRejected || (() => {});
        this.onState = onState || (() => {});
        this.reset();
    }

    reset() {
        this.history = [];
        this.closedSince = 0;
        this.lastClosedTs = 0;
        this.openStreak = 0;
        this.lastTs = 0;
        this.talking = false;
    }

    setTalking(detected) {
        this.talking = detected;
        if (detected && this.closedSince) this.rejectReason = 'talking';
    }

    push(tsUs, pts) {
        if (!pts || pts.length < 400) return;
        if (this.lastTs && tsUs - this.lastTs > MAX_FRAME_GAP_US && this.closedSince) {
            this.closedSince = 0;
            this.openStreak = 0;
            this.onCloseEnd();
        }
        this.lastTs = tsUs;

        const r = ear(pts, RIGHT_EYE);
        const l = ear(pts, LEFT_EYE);
        while (this.history.length && this.history[0].ts < tsUs - BASELINE_US) this.history.shift();
        if (this.history.length < MIN_BASELINE_FRAMES) {
            this.history.push({ ts: tsUs, r, l });
            this.onState({ ready: false });
            return;
        }

        const rn = r / median(this.history.map((h) => h.r));
        const ln = l / median(this.history.map((h) => h.l));
        const openness = (rn + ln) / 2;

        if (!this.closedSince) {
            if (openness < CLOSE_BELOW) {
                this.closedSince = tsUs;
                this.lastClosedTs = tsUs;
                this.openStreak = 0;
                this.noseStart = pts[NOSE];
                this.iod = dist(pts[33], pts[263]);
                this.rejectReason = this.talking ? 'talking' : null;
                this.onCloseStart(tsUs);
            } else {
                this.history.push({ ts: tsUs, r, l });
            }
        } else {
            if (dist(pts[NOSE], this.noseStart) > MAX_NOSE_TRAVEL * this.iod) {
                this.rejectReason = this.rejectReason || 'head moved';
            }
            if (openness > OPEN_ABOVE) {
                if (++this.openStreak >= OPEN_FRAMES_TO_END) this.finish();
            } else {
                this.openStreak = 0;
                if (openness < CLOSE_BELOW) this.lastClosedTs = tsUs;
            }
        }

        this.onState({
            ready: true,
            openness,
            closed: !!this.closedSince,
            closedMs: this.closedSince ? (tsUs - this.closedSince) / 1000 : 0,
        });
    }

    finish() {
        const durUs = this.lastClosedTs - this.closedSince + 33_000;
        const endTs = this.lastClosedTs;
        const reason = this.rejectReason;
        this.closedSince = 0;
        this.openStreak = 0;
        this.rejectReason = null;
        this.classify(durUs, endTs, reason);
        this.onCloseEnd();
    }

    classify(durUs, endTs, reason) {
        if (durUs < BLINK_MIN_US) return;
        const long = durUs >= LONG_MIN_US;
        if (reason) return this.onRejected(reason, durUs / 1000, endTs);
        if (long && durUs > LONG_MAX_US) return this.onRejected('closed too long', durUs / 1000, endTs);
        if (long) this.onLongBlink(durUs / 1000, endTs);
        else this.onBlink(durUs / 1000, endTs);
    }
}

module.exports = { EyeTracker };
