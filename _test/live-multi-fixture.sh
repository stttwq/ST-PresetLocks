#!/bin/bash
# 造 2 本世界书 + 1 张测试卡，用于验证多本绑定
set -u
BASE=http://127.0.0.1:8000
CJ=/tmp/pl-cj2.txt
rm -f "$CJ"
T=$(curl -s -c "$CJ" "$BASE/csrf-token" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
POST() { curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -H 'Content-Type: application/json' -X POST "$@"; }

for W in PL_W1 PL_W2; do
  POST -d "{\"name\":\"$W\",\"data\":{\"entries\":{},\"name\":\"$W\"}}" "$BASE/api/worldinfo/edit" > /dev/null
done
curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -X POST \
  -d 'ch_name=PL_MULTI&file_name=PL_MULTI&description=temp&personality=&scenario=&first_mes=hi&mes_example=' \
  "$BASE/api/characters/create"; echo
ls -1 /opt/SillyTavern/data/default-user/worlds/ | grep PL_ || true
ls -1 /opt/SillyTavern/data/default-user/characters/ | grep PL_ || true
