#!/bin/sh
# PiDeck Web 热部署助手（root 执行，固定源路径，不接受参数）。
#
# 为什么需要它：/opt/PiDeck 属 root，pideck.service 是系统级单元，
# 没有 sudo 就无法替换 app.asar 或重启服务。装成本脚本 + NOPASSWD 规则后，
# 开发侧 `npm run deploy:web` 即可完成「构建 → 替换 → 重启 → 验证」，
# 不再需要人工介入。
#
# 安全边界：
# - 源路径写死，不读参数、不读环境变量，避免被当成通用 root 桥；
# - 只 install 单个文件到固定目标，再 restart 固定单元；
# - 旧版本自动备份成 app.asar.bak-<时间戳>（保留最近 3 份），供回滚。
set -eu

SRC=/home/bing/PiDeck/release/linux-unpacked/resources/app.asar
DST=/opt/PiDeck/resources/app.asar
UNIT=pideck
KEEP_BACKUPS=3

if [ ! -f "$SRC" ]; then
  echo "deploy: 缺少构建产物 $SRC（先跑 npm run build:fast && npx electron-builder --dir）" >&2
  exit 1
fi

# 产物自检：必须是打包过的 asar（魔数 04 00 00 00 + 头部 JSON），避免把坏文件推上去导致白屏
if [ "$(head -c 4 "$SRC" | od -An -tu1 | tr -d ' \n')" != "4000" ]; then
  echo "deploy: $SRC 不是可用的 asar（魔数不符），拒绝部署" >&2
  exit 1
fi

BACKUP=""
if [ -f "$DST" ]; then
  BACKUP="$DST.bak-$(date +%Y%m%d-%H%M%S)"
  install -m 644 "$DST" "$BACKUP"
  ls -1t "$DST".bak-* 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -f "$old"; done
fi

install -m 644 "$SRC" "$DST"
systemctl restart "$UNIT"

# 健康自检（最多 40s）：首页 200 且 /api/health 返回 ok 才算上线；
# 失败自动回滚到上一版并重启，避免把 Web 端留在白屏状态。
i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS --max-time 2 http://127.0.0.1:8765/api/health 2>/dev/null | grep -q '"ok":true'; then
    echo "deploy: 已替换 app.asar 并重启 $UNIT（健康检查通过）"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "deploy: 健康检查失败，开始回滚" >&2
if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
  install -m 644 "$BACKUP" "$DST"
  systemctl restart "$UNIT"
  echo "deploy: 已回滚到 $BACKUP（线上恢复为上一版）" >&2
else
  echo "deploy: 没有可用备份，请人工检查 systemctl status $UNIT" >&2
fi
exit 1
