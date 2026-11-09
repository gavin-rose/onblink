'use strict';

const DEFAULT_STEP_MS = 1600;
const PASSES = 2;
const CANCEL = { id: '__cancel', label: 'Cancel' };

class PhraseMenu {
    constructor({ onOpen, onStep, onLock, onSelect, onClose } = {}) {
        this.onOpen = onOpen || (() => {});
        this.onStep = onStep || (() => {});
        this.onLock = onLock || (() => {});
        this.onSelect = onSelect || (() => {});
        this.onClose = onClose || (() => {});
        this.items = [CANCEL];
        this.active = this.items;
        this.timer = null;
        this.index = -1;
        this.locked = -1;
        this.steps = 0;
        this.stepMs = DEFAULT_STEP_MS;
    }

    get open() {
        return this.timer !== null;
    }

    setItems(items) {
        this.close('reset');
        this.items = [...items, CANCEL];
    }

    setStepMs(ms) {
        this.stepMs = ms;
    }

    closeStart() {
        if (!this.open) return;
        this.locked = this.index;
        this.onLock(this.locked);
    }

    unlock() {
        if (this.locked < 0) return;
        this.locked = -1;
        this.onLock(-1);
    }

    longBlink() {
        if (!this.open) return this.start();
        const item = this.active[this.locked >= 0 ? this.locked : this.index];
        if (item.id === CANCEL.id) return this.close('cancelled');
        this.close('selected');
        this.onSelect(item);
    }

    start(items = this.items, title = '') {
        if (this.open) this.close('replaced');
        this.active = items;
        this.index = 0;
        this.locked = -1;
        this.steps = 0;
        this.onOpen(this.active, title);
        this.onStep(this.index);
        this.timer = setInterval(() => this.step(), this.stepMs);
    }

    step() {
        if (this.locked >= 0) return;
        this.steps++;
        if (this.steps >= this.active.length * PASSES) return this.close('timed out');
        this.index = (this.index + 1) % this.active.length;
        this.onStep(this.index);
    }

    close(reason) {
        if (!this.open) return;
        clearInterval(this.timer);
        this.timer = null;
        this.index = -1;
        this.locked = -1;
        this.onClose(reason);
    }
}

module.exports = { PhraseMenu, CANCEL };
