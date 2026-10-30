#!/bin/bash
# 造一张 PL_REND 卡 + 一个含原始 <think_nya~> 标签的聊天，用于验证「切预设是否会重绘旧消息」
set -u
BASE=http://127.0.0.1:8000
CJ=/tmp/pl-rend-cj.txt
rm -f "$CJ"
T=$(curl -s -c "$CJ" "$BASE/csrf-token" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
POST() { curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -H 'Content-Type: application/json' -X POST "$@"; }

curl -s -b "$CJ" -c "$CJ" -H "X-CSRF-Token: $T" -X POST \
  -d 'ch_name=PL_REND&file_name=PL_REND&description=temp&personality=&scenario=&first_mes=hi&mes_example=' \
  "$BASE/api/characters/create"; echo

POST -d '{"avatar":"PL_REND.png","data":{"extensions":{"presetLocks":{"preset":"【小猫之神·喵赛亚】1.6","at":1}}}}' \
  "$BASE/api/characters/merge-attributes" -o /dev/null -w "bind http=%{http_code}\n"

node -e '
const chat = [
  { name: "PL_REND", is_user: false, is_system: false, send_date: "2026-10-30T00:00:00.000Z",
    mes: "旧消息甲：<think_nya~>思考内容AAA</think_nya~>正文AAA", extra: {} },
  { name: "PL_REND", is_user: false, is_system: false, send_date: "2026-10-30T00:00:01.000Z",
    mes: "旧消息乙：<think_nya~>思考内容BBB</think_nya~>正文BBB", extra: {} }
];
require("fs").writeFileSync("/tmp/pl-rend-chat.json", JSON.stringify({ ch_name: "PL_REND - 2026-10-30", file_name: "PL_REND - 2026-10-30", avatar_url: "PL_REND.png", chat: chat }));
'
POST --data-binary @/tmp/pl-rend-chat.json "$BASE/api/chats/save" -o /dev/null -w "chat save=%{http_code}\n"

echo "--- 校验 ---"
find /opt/SillyTavern/data/default-user/chats -iname "*PL_REND*" 2>/dev/null | head
grep -c "think_nya" /opt/SillyTavern/data/default-user/chats/PL_REND/*.jsonl 2>/dev/null || echo "0"
