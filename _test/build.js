// 用桩件替换 index.js 的 SillyTavern 导入，其余代码原样保留
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const lines = src.split(/\r?\n/);

const firstImport = lines.findIndex((l) => l.startsWith('import '));
let lastImport = firstImport;
while (lastImport + 1 < lines.length && /^(import |\s+[A-Za-z_,{}\s]+\} from )/.test(lines[lastImport + 1])) lastImport++;

const stub = `import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, extension_settings, getContext, getPresetManager, Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup, state } from './stubs.mjs';`;

const out = [...lines.slice(0, firstImport), stub, ...lines.slice(lastImport + 1)].join('\n');

fs.writeFileSync(
    path.join(__dirname, 'pl.mjs'),
    out +
        `
export { settings, getLock, setLock, clearLock, migrateByName, cardKey, cardName, applyPreset, onContextChanged, currentPresetName, refreshEditorRow, onEditorChange, refreshWorldRow, onWorldToggle, getWorlds, writeCardWorlds, syncCharLore, worldRefs, decideWorldDelete, onCharacterDeleted, pendingWorldDelete, refreshStWorldList };
`,
);
console.log('pl.mjs 生成完毕，替换了 import 行', firstImport + 1, '-', lastImport + 1);
