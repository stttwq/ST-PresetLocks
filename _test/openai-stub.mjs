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
    openai_model: 'gpt-4-turbo',
    prompts: [{ identifier: 'main', content: 'hi', role: 'system' }],
    prompt_order: [{ character_id: 100001, order: baseOrder.map((e) => ({ ...e })) }],
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
