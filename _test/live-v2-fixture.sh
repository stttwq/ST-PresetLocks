#!/bin/bash
# v2.0.0 全功能验收夹具：3 本带唯一常驻标记的世界书 + 1 张测试卡
set -u
BASE=http://127.0.0.1:8000
CJ=/tmp/pl-v2-cj.txt
rm -f "$CJ"
T=$(curl -s -c "$CJ" "$BASE/csrf-token" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
POST() { curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -H 'Content-Type: application/json' -X POST "$@"; }

entry() { # $1=marker
cat <<EOF
"0": {"uid":0,"key":["pl_nokey"],"keysecondary":[],"comment":"","content":"<<$1>>","constant":true,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":false,"order":100,"position":0,"disable":false,"excludeRecursion":false,"preventRecursion":false,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":null,"matchWholeWords":null,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"matchPersonaDescription":false,"matchCharacterDescription":false,"matchCharacterPersonality":false,"matchCharacterDepthPrompt":false,"matchScenario":false,"matchCreatorNotes":false},
"1": {"uid":1,"key":["pl_kw_only"],"keysecondary":[],"comment":"","content":"<<$1-KW>>","constant":false,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":false,"order":100,"position":0,"disable":false,"excludeRecursion":false,"preventRecursion":false,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":null,"matchWholeWords":null,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"matchPersonaDescription":false,"matchCharacterDescription":false,"matchCharacterPersonality":false,"matchCharacterDepthPrompt":false,"matchScenario":false,"matchCreatorNotes":false}
EOF
}

for pair in "PL_G1:G1-MARK" "PL_G2:G2-MARK" "PL_G3:G3-MARK"; do
  NAME="${pair%%:*}"; MARK="${pair##*:}"
  POST -d "{\"name\":\"$NAME\",\"data\":{\"entries\":{$(entry "$MARK")},\"name\":\"$NAME\"}}" "$BASE/api/worldinfo/edit" > /dev/null
done

curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -X POST \
  -d 'ch_name=PL_V2&file_name=PL_V2&description=temp&personality=&scenario=&first_mes=hi&mes_example=' \
  "$BASE/api/characters/create" > /dev/null

ls -1 /opt/SillyTavern/data/default-user/worlds/ | grep -E 'PL_G[123]'
ls -1 /opt/SillyTavern/data/default-user/characters/ | grep PL_V2
