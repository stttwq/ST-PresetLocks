#!/bin/bash
# 造一个测试用角色卡 + 世界书，用于验证「删卡连带删世界书」
set -u
BASE=http://127.0.0.1:8000
CJ=/tmp/pl-cj.txt
rm -f "$CJ"
T=$(curl -s -c "$CJ" "$BASE/csrf-token" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
POST() { curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -H 'Content-Type: application/json' -X POST "$@"; }

echo "--- 世界书 ---"
POST -d '{"name":"PL_TEST_WORLD","data":{"entries":{},"name":"PL_TEST_WORLD"}}' "$BASE/api/worldinfo/edit"; echo
echo "--- 角色卡 ---"
curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -X POST \
  -d 'ch_name=PL_TEST_CARD&file_name=PL_TEST_CARD&description=temp&personality=&scenario=&first_mes=hi&mes_example=' \
  "$BASE/api/characters/create"; echo
echo "--- 绑定世界书 ---"
POST -d '{"avatar":"PL_TEST_CARD.png","data":{"extensions":{"world":"PL_TEST_WORLD"}}}' "$BASE/api/characters/merge-attributes" -o /dev/null -w "http=%{http_code}\n"
POST -d '{"avatar_url":"PL_TEST_CARD.png"}' "$BASE/api/characters/get" \
  | node -pe 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); JSON.stringify({name:c.name, world:c.data?.extensions?.world})'
echo "--- 文件清单 ---"
ls -1 /opt/SillyTavern/data/*/worlds/ 2>/dev/null | grep -i PL_TEST || ls -1 /opt/SillyTavern/data/default-user/worlds/ | grep -i PL_TEST
ls -1 /opt/SillyTavern/data/default-user/characters/ | grep -i PL_TEST
