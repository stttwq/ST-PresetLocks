#!/bin/bash
# 造 2 本带「常驻条目」的世界书 + 1 张测试卡，用于验证「不开任何全局世界书也能自动生效」
set -u
BASE=http://127.0.0.1:8000
CJ=/tmp/pl-cj3.txt
rm -f "$CJ"
T=$(curl -s -c "$CJ" "$BASE/csrf-token" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
POST() { curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -H 'Content-Type: application/json' -X POST "$@"; }

mk_entry() { # $1=uid $2=content
cat <<EOF
"$1": {"uid":$1,"key":["pl_test_kw"],"keysecondary":[],"comment":"","content":"$2","constant":true,"vectorized":false,"selective":true,"selectiveLogic":0,"addMemo":false,"order":100,"position":0,"disable":false,"excludeRecursion":false,"preventRecursion":false,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":null,"matchWholeWords":null,"useGroupScoring":null,"automationId":"","role":0,"sticky":0,"cooldown":0,"delay":0,"matchPersonaDescription":false,"matchCharacterDescription":false,"matchCharacterPersonality":false,"matchCharacterDepthPrompt":false,"matchScenario":false,"matchCreatorNotes":false}
EOF
}

POST -d "{\"name\":\"PL_W1\",\"data\":{\"entries\":{$(mk_entry 0 'WORLD-ONE-ACTIVE')},\"name\":\"PL_W1\"}}" "$BASE/api/worldinfo/edit" > /dev/null
POST -d "{\"name\":\"PL_W2\",\"data\":{\"entries\":{$(mk_entry 0 'WORLD-TWO-ACTIVE')},\"name\":\"PL_W2\"}}" "$BASE/api/worldinfo/edit" > /dev/null
POST -d '{"name":"PL_W1"}' "$BASE/api/worldinfo/get" | head -c 200; echo
curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -X POST \
  -d 'ch_name=PL_MULTI&file_name=PL_MULTI&description=temp&personality=&scenario=&first_mes=hi&mes_example=' \
  "$BASE/api/characters/create"; echo
ls -1 /opt/SillyTavern/data/default-user/worlds/ | grep PL_ || true
