#!/usr/bin/env bash
# 安装/重启 GVS 前的安全检查：确认没有正在下载或封装的任务。
# 用法：scripts/check-idle-before-install.sh [窗口秒数]
# 退出码：0 = 空闲可以安装；1 = 有任务在跑，等它结束。
# 判定三路互相兜底（下载中 / 封装中 / 刚开始还没落盘 都能覆盖）：
#   1) 下载器/封装器子进程（N_m3u8DL-RE、mkvmerge、ffmpeg、MP4Box）
#   2) 工作目录 .gvs-tmp 在窗口期内的写盘活动
#   3) 运行日志在窗口期内还有 job/playlist 事件
set -uo pipefail

WINDOW="${1:-120}"
CFG="$HOME/.config/gvs/tui.json"
LOG="$HOME/.config/gvs/desktop-run.log"
OUT_DIR="$HOME/Downloads/视频"
if [ -f "$CFG" ]; then
  OUT_DIR="$(python3 - "$CFG" <<'PY'
import json,sys
try:
    cfg=json.load(open(sys.argv[1]))
    print(cfg.get('outDir') or h if (h:='~/Downloads/视频') else h)
except Exception:
    print('~/Downloads/视频')
PY
)"
fi
OUT_DIR="${OUT_DIR/#\~/$HOME}"
BUSY=()

# 1) 子进程：下载/解密/封装
for pat in N_m3u8DL-RE mkvmerge ffmpeg MP4Box; do
  if pgrep -f "$pat" >/dev/null 2>&1; then
    BUSY+=("进程 $pat 正在运行（pid $(pgrep -f "$pat" | tr '\n' ' ')）")
  fi
done

# 2) 写盘活动
TMP="$OUT_DIR/.gvs-tmp"
if [ -d "$TMP" ]; then
  n="$(find "$TMP" -type f -newermt "-${WINDOW} seconds" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$n" != "0" ] && BUSY+=("${WINDOW}s 内 ${TMP} 有 ${n} 个文件在写入")
fi

# 3) 日志事件（job 开始 / playlist 进度）
if [ -f "$LOG" ]; then
  last="$(tail -n 200 "$LOG" | grep -E " (job|playlist) " | tail -n 1 || true)"
  if [ -n "$last" ]; then
    ts="${last%%Z *}"
    if python3 - "$ts" "$WINDOW" <<'PY'
import sys, datetime
ts, window = sys.argv[1], int(sys.argv[2])
try:
    t = datetime.datetime.strptime(ts, '%Y-%m-%dT%H:%M:%S.%f')
except Exception:
    sys.exit(1)
age = (datetime.datetime.utcnow() - t).total_seconds()
sys.exit(0 if age <= window else 1)
PY
    then BUSY+=("日志 ${WINDOW}s 内仍有任务事件：${last:0:120}")
    fi
  fi
fi

if [ "${#BUSY[@]}" -eq 0 ]; then
  echo "空闲：没有下载/封装任务，可以安全安装或重启 GVS。"
  exit 0
fi
echo "有任务在跑，先不要动 App："
for line in "${BUSY[@]}"; do echo "  - $line"; done
echo "建议：等任务结束（或等 ${WINDOW}s 无写盘/日志事件）后再安装。"
exit 1
