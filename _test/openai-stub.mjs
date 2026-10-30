// openai.js 的桩件：模拟酒馆的 Chat Completion 预设状态
export const state = {
    applicationPromise: Promise.resolve(),
    promptsRendered: 0,
    sanitized: 0,
    live: {
        temperature: 1,
        top_p: 1,
        chat_completion_source: 'deepseek',
        openai_model: 'gpt-4-turbo',
    },
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
    return { ...state.live };
}
