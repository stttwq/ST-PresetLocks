// 用桩件替换 index.js 的 SillyTavern 导入，其余代码原样保留
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const lines = src.split(/\r?\n/);

const firstImport = lines.findIndex((l) => l.startsWith('import '));
let lastImport = firstImport;
while (lastImport + 1 < lines.length && /^(import |\s+[A-Za-z_,{}\s]+\} from )/.test(lines[lastImport + 1])) lastImport++;

const stub = `import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, extension_settings, getContext, getPresetManager, Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup, state } from './stubs.mjs';`;

const out = [...lines.slice(0, firstImport), stub, ...lines.slice(lastImport + 1)]
    .join('\n')
    .replace(/import\('\.\.\/\.\.\/\.\.\/openai\.js'\)/g, "import('./openai-stub.mjs')")
    .replace(/import\('\.\.\/\.\.\/\.\.\/world-info\.js'\)/g, "import('./world-info-stub.mjs')");

fs.writeFileSync(
    path.join(__dirname, 'pl.mjs'),
    out +
        `
export { settings, getLock, setLock, clearLock, migrateByName, cardKey, cardName, applyPreset, onContextChanged, currentPresetName, refreshEditorRow, onEditorChange, refreshWorldRow, getWorlds, writeCardWorlds, syncCharLore, upsertCharLore, worldRefs, decideWorldDelete, cardOwnedWorlds, onCharacterDeleted, pendingWorldDelete, refreshStWorldList, settlePreset, verifyPreset, applyLock, lockSatisfied, capturePromptOrder, presetPromptSummary, captureForCard, computeAtBottom, scrollToBottomNow, wireKeepPosition, applyKeepPosition, followOnce, setFollowTimer, extractOptions, extractSummary, extractDecision, refreshDecisionBar, stripTags, toggleDecisionPanel, decisionPanelOpen, setGenerating, isGeneratingNow, markUserIntent, userIntentRecent, captureBaseline, resetLastAppliedPromptSig, setLastAppliedSig, promptOrderSummary, applyPromptOrder, onEnableChange, onCapturePrompts, worldStats, refreshWorldResults, onWorldAction, onWorldAdd, commitWorlds, bodyOpen, setBodyOpen, presetHasSPreset, presetHasDisplayRegex, rerenderIfNeeded, syncSPresetUI, captureConnection, applyConnection, restoreConnectionLock, installConnectionGuard, isConnectionKey, onCaptureConnection, secretKeyName, getLocalKey, setLocalKey, clearLocalKey, applyKeyForCard, installKeyCapture, migrateDefaults, DEFAULTS, VERSION };
`,
);
console.log('pl.mjs 生成完毕，替换了 import 行', firstImport + 1, '-', lastImport + 1);
