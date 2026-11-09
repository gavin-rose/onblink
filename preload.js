'use strict';

require('@smartspectra/node-sdk/preload');
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onblink', {
    config: () => ipcRenderer.invoke('onblink:config'),
    save: (config) => ipcRenderer.invoke('onblink:save', config),
    run: (id) => ipcRenderer.invoke('onblink:run', id),
    test: (action, voice) => ipcRenderer.invoke('onblink:test', action, voice),
    pickApp: () => ipcRenderer.invoke('onblink:pick-app'),
    voices: () => ipcRenderer.invoke('onblink:voices'),
    key: () => ipcRenderer.invoke('onblink:key'),
    keyStatus: () => ipcRenderer.invoke('onblink:key-status'),
    setKey: (key) => ipcRenderer.invoke('onblink:key-set', key),
    clearKey: () => ipcRenderer.invoke('onblink:key-clear'),
    openSignup: () => ipcRenderer.invoke('onblink:open-signup'),
    keepAwake: (on) => ipcRenderer.invoke('onblink:keep-awake', on),
    cue: (text) => ipcRenderer.invoke('onblink:cue', text),
});
