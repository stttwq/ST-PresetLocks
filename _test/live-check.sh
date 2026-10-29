#!/bin/bash
# 在酒馆服务器本机验证角色卡写接口（写 → 读回 → 清除 → 再读回）
set -u
BASE=http://127.0.0.1:8000
CJ=/tmp/pl-cookies.txt
rm -f "$CJ"

TOKEN=$(curl -s -c "$CJ" "$BASE/csrf-token" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
echo "token_len=${#TOKEN}"
[ -z "$TOKEN" ] && { echo "拿不到 CSRF token"; exit 1; }

POST() { curl -s -b "$CJ" -c "$CJ" -X POST -H "X-CSRF-Token: $TOKEN" -H 'Content-Type: application/json' "$@"; }

PICK=$(POST -d '{}' "$BASE/api/characters/all" | node -pe 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")); const c=a.find(x=>x.avatar)||{}; JSON.stringify({avatar:c.avatar, name:c.name, n:a.length})')
echo "pick=$PICK"
AVATAR=$(echo "$PICK" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).avatar')
[ -z "$AVATAR" ] || [ "$AVATAR" = "undefined" ] && { echo "没有可测角色卡"; exit 1; }

readback() {
  POST -d "{\"avatar_url\":\"$AVATAR\"}" "$BASE/api/characters/get" \
    | node -pe 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); JSON.stringify((c.data&&c.data.extensions&&c.data.extensions.presetLocks)!==undefined ? c.data.extensions.presetLocks : "无该键")'
}

echo "--- 写入 ---"
curl -s -o /dev/null -w "http=%{http_code}\n" -b "$CJ" -c "$CJ" -X POST \
  -H "X-CSRF-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"avatar\":\"$AVATAR\",\"data\":{\"extensions\":{\"presetLocks\":{\"preset\":\"__pl_test__\",\"at\":1}}}}" \
  "$BASE/api/characters/merge-attributes"
echo "读回：$(readback)"

echo "--- 清除 ---"
curl -s -o /dev/null -w "http=%{http_code}\n" -b "$CJ" -c "$CJ" -X POST \
  -H "X-CSRF-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"avatar\":\"$AVATAR\",\"data\":{\"extensions\":{\"presetLocks\":null}}}" \
  "$BASE/api/characters/merge-attributes"
echo "读回：$(readback)"
