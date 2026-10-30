// world-info.js 的桩件：只需要 world_info 容器、世界书列表刷新与单本读取
export const state = {
    entries: {
        W1: { 0: { constant: true }, 1: { constant: false }, 2: { constant: false } },
        W2: { 0: { constant: false } },
    },
    updatedCalls: 0,
    loadCalls: [],
};

export const world_info = { charLore: [] };

export const world_names = ['W1', 'W2', 'W3'];

export async function updateWorldInfoList() {
    state.updatedCalls++;
}

export async function loadWorldInfo(name) {
    state.loadCalls.push(name);
    const entries = state.entries[name];
    return entries ? { entries } : null;
}
