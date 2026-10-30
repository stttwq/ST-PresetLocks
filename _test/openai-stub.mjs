// openai.js 的桩件：模拟酒馆的 Chat Completion 预设状态
export const state = {
    applicationPromise: Promise.resolve(),
    promptsRendered: 0,
    sanitized: 0,
};

const baseOrder = [
    { identifier: 'main', enabled: true },
    { identifier: 'jailbreak', enabled: true },
    { identifier: 'nsfw', enabled: true },
    { identifier: 'jazz', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'worldInfoBefore', enabled: false },
];

export const live = {
    temperature: 1,
    top_p: 1,
    chat_completion_source: 'deepseek',
    custom_url: 'https://example.test/v1',
    custom_model: 'model-A',
    reverse_proxy: '',
    proxy_password: '',
    openai_model: 'gpt-4-turbo',
    deepseek_model: 'deepseek-chat',
    prompts: [{ identifier: 'main', content: 'hi', role: 'system' }],
    prompt_order: [{ character_id: 100001, order: baseOrder.map((e) => ({ ...e })) }],
};

/** 酒馆用 settingsToUpdate 标记连接类字段（第 4 位 isConnection） */
export const settingsToUpdate = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true],
    custom_url: ['#custom_api_url_text', 'custom_url', false, true],
    custom_model: ['#custom_model_id', 'custom_model', false, true],
    openai_model: ['#model_openai_select', 'openai_model', false, true],
    deepseek_model: ['#model_deepseek_select', 'deepseek_model', false, true],
    reverse_proxy: ['#openai_reverse_proxy', 'reverse_proxy', false, true],
    proxy_password: ['#openai_proxy_access_key', 'proxy_password', false, true],
    temperature: ['#temp_openai', 'temperature', false, false],
    top_p: ['#top_p_openai', 'top_p', false, false],
};

export const openai_setting_names = { P1: 0, P2: 1 };

export const openai_settings = [
    { name: 'P1', temperature: 0.6, top_p: 0.9, chat_completion_source: 'deepseek', openai_model: 'deepseek-chat' },
    { name: 'P2', temperature: 1.2, top_p: 0.5, chat_completion_source: 'deepseek', openai_model: 'gpt-4-turbo' },
];

export const promptManager = {
    sanitizeServiceSettings() {
        state.sanitized++;
    },
    render() {
        state.promptsRendered++;
    },
};

export function getPresetApplicationPromise() {
    return state.applicationPromise;
}

export function getChatCompletionPreset() {
    return JSON.parse(JSON.stringify(live));
}

export function captureSnapshot() {
    return JSON.parse(JSON.stringify(live.prompt_order));
}

export function setEnabled(identifier, enabled) {
    const entry = live.prompt_order[0].order.find((e) => e.identifier === identifier);
    if (entry) entry.enabled = enabled;
}

export function enabledOf(identifier) {
    const entry = live.prompt_order[0].order.find((e) => e.identifier === identifier);
    return entry ? entry.enabled : null;
}

export function restoreSnapshot(snapshot) {
    live.prompt_order = JSON.parse(JSON.stringify(snapshot));
}

// index.js 会写回 oai_settings.prompt_order / oai_settings.prompts
export const oai_settings = live;
