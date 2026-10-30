#!/bin/bash
# 造 3 本各有唯一常驻条目的世界书 + 1 张测试卡，用于验证多选世界书真实生效与加载顺序
set -u
BASE=http://127.0.0.1:8000
CJ=/tmp/pl-mb-cj.txt
rm -f "$CJ"
T=$(curl -s -c "$CJ" "$BASE/csrf-token" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
POST() { curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -H 'Content-Type: application/json' -X POST "$@"; }

entry() { # $1=marker $2=order
cat <<EOF
"0": {"uid":0,"key":["pl_nokey"],"keysecondary":[],"comment":"","content":"<<$1>>","constant":true,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":false,"order":$2,"position":0,"disable":false,"excludeRecursion":false,"preventRecursion":false,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":null,"matchWholeWords":null,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"matchPersonaDescription":false,"matchCharacterDescription":false,"matchCharacterPersonality":false,"matchCharacterDepthPrompt":false,"matchScenario":false,"matchCreatorNotes":false}
EOF
}

for pair in "PL_ALPHA:AAA-MARK" "PL_BETA:BBB-MARK" "PL_GAMMA:CCC-MARK"; do
  NAME="${pair%%:*}"; MARK="${pair##*:}"
  POST -d "{\"name\":\"$NAME\",\"data\":{\"entries\":{$(entry "$MARK" 100)},\"name\":\"$NAME\"}}" "$BASE/api/worldinfo/edit" > /dev/null
done

curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -X POST \
  -d 'ch_name=PL_MB&file_name=PL_MB&description=temp&personality=&scenario=&first_mes=hi&mes_example=' \
  "$BASE/api/characters/create" > /dev/null

# 故意按「非字母序」绑定：GAMMA, ALPHA, BETA
POST -d '{"avatar":"PL_MB.png","data":{"extensions":{"worldBooks":["PL_GAMMA","PL_ALPHA","PL_BETA"],"world":"PL_GAMMA"}}}' \
  "$BASE/api/characters/merge-attributes" -o /dev/null -w "bind http=%{http_code}\n"

ls -1 /opt/SillyTavern/data/default-user/worlds/ | grep -E 'PL_(ALPHA|BETA|GAMMA)'
ls -1 /opt/SillyTavern/data/default-user/characters/ | grep PL_MB
