#!/bin/sh
# PiDeck 部署的「容器内侧」脚本（由 scripts/deploy-web.mjs 以 --privileged --pid=host 拉起）。
#
# 为什么整段放进容器：
# 1) 从 PiDeck 内的 agent 会话发起部署时，重启会连带杀掉 pideck.service 的整个 cgroup，
#    宿主机侧脚本根本活不到「验证/回滚」那一步；容器在 docker 的 cgroup 里，能活下来。
# 2) 必须 --privileged：docker-default 的 AppArmor 不允许向 unconfined 的 pideck 发信号
#    （dmesg: apparmor="DENIED" operation="signal" ... requested_mask="send" peer="pideck"），
#    普通容器里 pkill 会静默失败，健康检查被旧进程应答 → 假成功。
# 3) 主进程捕获了 SIGTERM（SigCgt 含 bit14），默认信号杀不掉；必须 SIGKILL。
#
# 由调用方挂载：
#   /target = /opt/PiDeck/resources（最终 app.asar 所在，root 拥有）
#   /src    = 本次构建的 release/linux-unpacked/resources（只读）
#   /log    = 宿主机日志文件（调用方 tail 这个文件读结果）
# 环境：
#   BUNDLE  必填，本次渲染层入口（assets/web-*.js），用于验证线上真的换包
#   DELAY   可选，开始前等待秒数（给调用方留出打印说明的时间）
set -u

log() { echo "[$(date +%H:%M:%S)] $*"; }
exec >>/log 2>&1

: "${BUNDLE:?需要 BUNDLE（assets/web-*.js）}"

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="/target/app.asar.bak-$STAMP"
MAIN_PATTERN='^/opt/PiDeck/pideck$'
# xvfb-run 的 argv 形如 `/bin/sh /usr/bin/xvfb-run -a /opt/PiDeck/pideck`；用它兜住包装进程。
WRAPPER_PATTERN='xvfb-run -a /opt/PiDeck'

main_pid() { pgrep -f "$MAIN_PATTERN" | head -1; }

healthy() { wget -q -T 3 -O - http://127.0.0.1:8765/api/health 2>/dev/null | grep -q '"ok":true'; }

# 重启并等到「新主进程 + 健康」：只看健康会被旧进程骗过（这是上一版的假成功）。
restart_and_wait() {
	local old=$1
	pkill -9 -f "$MAIN_PATTERN" 2>/dev/null
	sleep 1
	pkill -9 -f "$WRAPPER_PATTERN" 2>/dev/null
	local i=0 new=""
	while [ "$i" -lt 90 ]; do
		new=$(main_pid)
		if [ -n "$new" ] && [ "$new" != "$old" ] && healthy; then
			log "新主进程 PID=$new（旧 PID=${old:-?}，耗时 ${i}s）"
			return 0
		fi
		i=$((i + 1))
		sleep 1
	done
	log "90s 内没等到「新主进程 + 健康」（旧 PID=${old:-?} 当前 PID=${new:-?}）"
	return 1
}

log "=== 部署开始：bundle=$BUNDLE stamp=$STAMP"

if [ ! -f /src/app.asar ]; then
	log "DEPLOY_RESULT=failed 原因=缺少构建产物 /src/app.asar（线上未变）"
	exit 1
fi

if [ "${DELAY:-0}" -gt 0 ]; then
	log "等待 ${DELAY}s 后开始替换（留时间给调用方收尾）"
	sleep "$DELAY"
fi

OLD=$(main_pid)
log "当前主进程 PID=${OLD:-未找到}"

# 1) 备份 + 安装
if ! cp -a /target/app.asar "$BACKUP"; then
	log "DEPLOY_RESULT=failed 原因=备份失败（线上未变）"
	exit 1
fi
if ! install -m 644 /src/app.asar /target/app.asar; then
	log "DEPLOY_RESULT=failed 原因=安装失败（线上未变，备份 $BACKUP）"
	exit 1
fi
log "app.asar 已替换（备份 $BACKUP）"

# 只保留最近 3 份备份，避免 /opt 无限增长
ls -1t /target/app.asar.bak-* 2>/dev/null | tail -n +4 | while read -r old_backup; do rm -f "$old_backup"; done

# 2) 重启 + 验证
log "重启 pideck.service（Restart=always 用新包自拉起）"
if restart_and_wait "${OLD:-}"; then
	if wget -q -T 3 -O - http://127.0.0.1:8765/ 2>/dev/null | grep -q "$BUNDLE"; then
		log "DEPLOY_RESULT=ok 入口=$BUNDLE 备份=$BACKUP"
		exit 0
	fi
	log "健康但首页未引用 $BUNDLE，按失败处理"
else
	log "重启后未通过健康检查"
fi

# 3) 回滚
log "开始回滚到 $BACKUP"
if ! install -m 644 "$BACKUP" /target/app.asar; then
	log "DEPLOY_RESULT=failed 原因=回滚写入失败，需要人工处理（备份仍在 $BACKUP）"
	exit 1
fi
log "已写回旧包，再次重启"
restart_and_wait "$(main_pid)" || log "回滚后仍未恢复健康，需要人工介入：systemctl status pideck"
log "DEPLOY_RESULT=rolledback 备份=$BACKUP"
exit 1
