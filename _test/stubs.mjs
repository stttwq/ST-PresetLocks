// SillyTavern 侧的最小桩件，用于离线跑 index.js 的逻辑
export const state = {
    ctx: { characters: [], characterId: -1, groupId: null, chatId: null },
    presets: ['A', 'B', 'C'],
    selected: 'A',
    selectedCalls: [],
    handlers: {},
    fetchOk: true,
    fetchCalls: [],
    worlds: ['W1', 'W2'],
    popupAnswers: [],
    popupCalls: [],
};

export const extension_settings = { world_info: { charLore: [] } };

export const eventSource = {
    on(name, fn) {
        (state.handlers[name] ||= []).push(fn);
    },
};

export const event_types = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_changed',
    CHAT_LOADED: 'chat_loaded',
    CHARACTER_DELETED: 'character_deleted',
};

export const saveSettingsDebounced = () => {};

export const getRequestHeaders = () => ({ 'Content-Type': 'application/json' });

export function getContext() {
    return state.ctx;
}

export const pmStub = { shape: 'jquery' };

/** 四个附属模板管理器（上下文/指令/系统提示/推理）的桩状态 */
export const extraState = {
    context: { names: ['Default', 'CtxA'], selected: 'Default', calls: [] },
    instruct: { names: ['Alpaca', 'InstB'], selected: 'Alpaca', calls: [] },
    sysprompt: { names: ['Neutral - Chat', 'SysC'], selected: 'Neutral - Chat', calls: [] },
    reasoning: { names: ['Think XML', 'ReasonD'], selected: 'Think XML', calls: [] },
};

export function getPresetManager(apiId = '') {
    if (apiId && extraState[apiId]) {
        const st = extraState[apiId];
        return {
            get select() {
                return '#fake-' + apiId + '-select';
            },
            getSelectedPresetName: () => st.selected,
            findPreset: (name) => (st.names.includes(name) ? st.names.indexOf(name) : undefined),
            async selectPreset(index) {
                st.calls.push(st.names[index]);
                st.selected = st.names[index];
            },
        };
    }
    return {
        get select() {
            const opts = state.presets.map((p) => ({ text: p }));
            if (pmStub.shape === 'jquery') return [{ options: opts }];
            if (pmStub.shape === 'element') return { options: opts };
            return '#fake-preset-select';
        },
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
export const POPUP_RESULT = { AFFIRMATIVE: 1, CANCELLED: 0 };
export const callGenericPopup = async (html, type, title) => {
    state.popupCalls.push({ html, type, title });
    return state.popupAnswers.length ? state.popupAnswers.shift() : POPUP_RESULT.CANCELLED;
};

// 模拟服务端 /api/characters/merge-attributes：只做深合并到角色卡的 data 上
class FakeOption {
    constructor(text, value, defaultSelected, selected) {
        this.text = text;
        this.value = value;
        this.selected = !!selected;
    }
}
globalThis.Option = FakeOption;

export const dom = { els: {} };
dom.els['avatar_url_pole'] = { value: '' };
dom.els['character_name_pole'] = { value: '' };

export function makeFakeSelect() {
    return {
        tagName: 'DIV',
        children: [],
        value: '',
        disabled: false,
        dataset: {},
        get options() {
            return this.children;
        },
        replaceChildren(o) {
            this.children = o ? [o] : [];
        },
        append(...els) {
            this.children.push(...els.flat().filter(Boolean));
        },
    };
}

export function makeElem(tag) {
    const el = {
        tagName: String(tag).toUpperCase(),
        children: [],
        dataset: {},
        className: '',
        textContent: '',
        type: '',
        checked: false,
        append(...kids) {
            this.children.push(...kids.flat().filter(Boolean));
        },
        replaceChildren(...kids) {
            this.children = kids.flat().filter(Boolean);
        },
        addEventListener() {},
        querySelector: () => null,
    };
    return el;
}

globalThis.document = {
    getElementById: (id) => dom.els[id] || null,
    querySelector: (sel) => {
        if (sel === '#fake-preset-select') return { options: state.presets.map((p) => ({ text: p })) };
        const m = /^#fake-(context|instruct|sysprompt|reasoning)-select$/.exec(sel);
        if (m) return { options: extraState[m[1]].names.map((n) => ({ text: n })) };
        return null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => makeElem(tag),
};

globalThis.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    state.fetchCalls.push({ url, body });

    if (url === '/api/worldinfo/list') {
        return { ok: true, status: 200, json: async () => state.worlds.map((w) => ({ file_id: w, name: w })) };
    }
    if (url === '/api/worldinfo/delete') {
        if (!state.fetchOk) return { ok: false, status: 500 };
        state.worlds = state.worlds.filter((w) => w !== body.name);
        return { ok: true, status: 200 };
    }

    // 模拟 /api/characters/merge-attributes：只做深合并到角色卡的 data 上
    if (!state.fetchOk) return { ok: false, status: 403 };
    const ch = state.ctx.characters.find((c) => c.avatar === body.avatar);
    if (ch) {
        ch.data ||= {};
        ch.data.extensions = Object.assign({}, ch.data.extensions, body.data.extensions);
    }
    return { ok: true, status: 200 };
};
