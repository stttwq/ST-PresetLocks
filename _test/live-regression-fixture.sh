#!/bin/bash
# v2.2 全功能验收夹具：3 本带唯一标记的世界书 + 2 张卡（同预设、不同提示词快照）
set -u
BASE=http://127.0.0.1:8000
CJ=/tmp/pl-fx-cj.txt
rm -f "$CJ"
T=$(curl -s -c "$CJ" "$BASE/csrf-token" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
POST() { curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -H 'Content-Type: application/json' -X POST "$@"; }

entry() { # $1=marker
cat <<EOF
"0": {"uid":0,"key":["pl_nokey"],"keysecondary":[],"comment":"","content":"<<$1>>","constant":true,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":false,"order":100,"position":0,"disable":false,"excludeRecursion":false,"preventRecursion":false,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":null,"matchWholeWords":null,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"matchPersonaDescription":false,"matchCharacterDescription":false,"matchCharacterPersonality":false,"matchCharacterDepthPrompt":false,"matchScenario":false,"matchCreatorNotes":false}
EOF
}

for pair in "PL_WA:WA-MARK" "PL_WB:WB-MARK" "PL_WC:WC-MARK"; do
  NAME="${pair%%:*}"; MARK="${pair##*:}"
  POST -d "{\"name\":\"$NAME\",\"data\":{\"entries\":{$(entry "$MARK")},\"name\":\"$NAME\"}}" "$BASE/api/worldinfo/edit" > /dev/null
done

for C in PL_T1 PL_T2; do
  curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -X POST \
    -d "ch_name=$C&file_name=$C&description=t&personality=&scenario=&first_mes=hi&mes_example=" \
    "$BASE/api/characters/create" > /dev/null
done

# T1: 绑定 Meowssiah破限 + 三本世界书（顺序 WA,WB,WC）
POST -d '{"avatar":"PL_T1.png","data":{"extensions":{"presetLocks":{"preset":"Meowssiah破限","at":1},"worldBooks":["PL_WA","PL_WB","PL_WC"],"world":"PL_WA"}}}' \
  "$BASE/api/characters/merge-attributes" -o /dev/null -w "T1 bind=%{http_code}\n"
POST -d '{"avatar":"PL_T2.png","data":{"extensions":{"presetLocks":{"preset":"Meowssiah破限","at":1}}}}' \
  "$BASE/api/characters/merge-attributes" -o /dev/null -w "T2 bind=%{http_code}\n"

ls -1 /opt/SillyTavern/data/default-user/worlds/ | grep -E 'PL_W[ABC]'
ls -1 /opt/SillyTavern/data/default-user/characters/ | grep -E 'PL_T[12]'
