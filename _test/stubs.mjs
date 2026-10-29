// SillyTavern 侧的最小桩件，用于离线跑 index.js 的逻辑
export const state = {
    ctx: { characters: [], characterId: -1, groupId: null, chatId: null },
    presets: ['A', 'B', 'C'],
    selected: 'A',
    selectedCalls: [],
    handlers: {},
};

export const extension_settings = {};

export const eventSource = {
    on(name, fn) {
        (state.handlers[name] ||= []).push(fn);
    },
};

export const event_types = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_changed',
    CHAT_LOADED: 'chat_loaded',
};

export const saveSettingsDebounced = () => {};

export function getContext() {
    return state.ctx;
}

export function getPresetManager() {
    return {
        getSelectedPresetName: () => state.selected,
        findPreset: (name) => (state.presets.includes(name) ? state.presets.indexOf(name) : undefined),
        selectPreset: async (index) => {
            state.selectedCalls.push(state.presets[index]);
            state.selected = state.presets[index];
        },
    };
}

export class Popup {
    constructor(html, type, input, options) {
        this.dlg = null;
        this.options = options || {};
    }
    async show() {}
}

export const POPUP_TYPE = { TEXT: 'text', CONFIRM: 'confirm' };
export const POPUP_RESULT = { AFFIRMATIVE: 1 };
export const callGenericPopup = async () => POPUP_RESULT.AFFIRMATIVE;

globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {}, appendChild() {} }),
};
