#!/data/data/com.termux/files/usr/bin/bash
# dsh-go 1.0.15 本机引擎：runtime_upgrade_blocked:running 诊断 + 修复
# 用法:
#   bash dsh-go-runtime-fix.sh         # 只诊断（只读）
#   bash dsh-go-runtime-fix.sh fix     # 诊断 + 清理卡住升级的 proot 残留进程
#
# 需要 root（Termux 里会自动 su 提权一次）。
# 只读诊断部分不会改动手机上的任何文件。
# 全部输出同时写入本脚本所在文件夹下的 dsh-go-runtime-fix-<时间戳>.log

set -u
export PATH="/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin:$PATH"

# ---- 定位本脚本（含符号链接解析），输出日志写到脚本同目录 ----------------
SELF="${BASH_SOURCE[0]}"
case "$SELF" in
  /*) ;;
  *) SELF="$PWD/$SELF" ;;
esac
if command -v readlink >/dev/null 2>&1; then
  R="$(readlink -f "$SELF" 2>/dev/null || true)"
  [ -n "$R" ] && SELF="$R"
fi
SCRIPT_DIR="$(dirname "$SELF")"
SCRIPT_NAME="$(basename "$SELF")"

MODE="${1:-diag}"

if [ "$(id -u)" != "0" ]; then
  CMD="bash $(printf '%q' "$SELF") $MODE"
  echo "[*] 需要 root，正在提权…"
  exec su -c "$CMD"
fi

# ---- 打开日志文件（脚本同目录；不可写则退回当前目录）--------------------
OUT_DIR="$SCRIPT_DIR"
if ! (touch "$OUT_DIR/.dsh-go-write-test" 2>/dev/null); then
  OUT_DIR="$PWD"
  echo "[!] 脚本目录不可写，日志改存到 $OUT_DIR"
else
  rm -f "$OUT_DIR/.dsh-go-write-test" 2>/dev/null || true
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$OUT_DIR/dsh-go-runtime-fix-$STAMP.log"
exec > >(tee -a "$LOG_FILE") 2>&1

PKG=io.github.ccch1mneyyy.dsh_app
BASE="/data/user/0/$PKG"
RT="$BASE/runtime"

say(){ echo; echo "=== $* ==="; }

say "运行信息"
echo "脚本        : $SELF"
echo "日志文件    : $LOG_FILE"
echo "模式        : $MODE"
echo "uid=$(id -u)  SELinux=$(getenforce 2>/dev/null || echo '?')"
echo "时间        : $(date '+%Y-%m-%d %H:%M:%S %Z')"

if [ ! -d "$BASE" ]; then echo "!! 找不到 $BASE（App 没装，或包名/路径不同）"; exit 1; fi
AUID=$(stat -c %u "$BASE" 2>/dev/null)
echo "App 数据目录 : $BASE"
echo "App uid      : $AUID"

say "运行时目录状态"
ls -la "$RT" 2>&1 | sed 's/^/  /'
echo "  rootfs.version = $(cat "$RT/rootfs.version" 2>/dev/null || echo '(无)')"
echo "  旧 runtime.json:"
cat "$RT/rootfs/etc/dsh-app/runtime.json" 2>/dev/null | head -30 | sed 's/^/    /' || echo "    (无)"
echo "  staging runtime.json:"
cat "$RT/staging/etc/dsh-app/runtime.json" 2>/dev/null | head -30 | sed 's/^/    /' || echo "    (无 staging)"

say "升级事务 / 残留标记"
for d in engine.upgrade engine.prepare engine.done home.carry rootfs.old staging runtime-keep runtime.reset; do
  if [ -e "$RT/$d" ]; then echo "  存在: $d"; else echo "  无  : $d"; fi
done
echo "  rootfs/tmp/dsh-web.pid = $(cat "$RT/rootfs/tmp/dsh-web.pid" 2>/dev/null || echo '(无)')"

say "App uid 的全部进程（/proc 全量扫描）"
KILL=""
for d in /proc/[0-9]*; do
  p=${d#/proc/}
  owner=$(stat -c %u "$d" 2>/dev/null) || continue
  [ "$owner" = "$AUID" ] || continue
  comm=$(tr -d '\0' < "$d/comm" 2>/dev/null)
  st=$(sed -E 's/^[0-9]+ \(.*\) ([A-Za-z]).*/\1/' "$d/stat" 2>/dev/null)
  trp=$(awk '/^TracerPid:/{print $2}' "$d/status" 2>/dev/null)
  cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-120)
  mark=""
  if [ -n "$trp" ] && [ "$trp" != "0" ]; then mark="被proot追踪(TracerPid=$trp)"; fi
  case "$comm$cmd" in *proot*) mark="$mark PROOT";; esac
  case "$cmd" in *rootfs*) mark="$mark ROOTFS";; esac
  echo "  pid=$p comm=$comm state=$st $mark"
  echo "      cmd=$cmd"
  case "$mark" in *PROOT*|*追踪*) KILL="$KILL $p";; esac
done
echo "  ==> 需要清理的 pid:${KILL:-（无）}"

say "App 日志尾部（runtime/logs/dsh.log）"
tail -n 25 "$RT/logs/dsh.log" 2>/dev/null | sed 's/^/  /' || echo "  (读不到)"

if [ "$MODE" = "fix" ]; then
  say "执行清理"
  echo "  强制停止 DSH Go…"
  am force-stop "$PKG" 2>/dev/null || echo "  (am force-stop 不可用，手动强停 App 即可)"
  sleep 1
  for p in $KILL; do
    echo "  kill -9 $p"
    kill -9 "$p" 2>/dev/null || true
  done
  sleep 1
  if [ -f "$RT/rootfs/tmp/dsh-web.pid" ]; then
    rm -f "$RT/rootfs/tmp/dsh-web.pid" 2>/dev/null && echo "  已删除失效的 tmp/dsh-web.pid"
  fi
  say "清理后复查"
  LEFT=0
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    owner=$(stat -c %u "$d" 2>/dev/null) || continue
    [ "$owner" = "$AUID" ] || continue
    comm=$(tr -d '\0' < "$d/comm" 2>/dev/null)
    trp=$(awk '/^TracerPid:/{print $2}' "$d/status" 2>/dev/null)
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-100)
    echo "  pid=$p comm=$comm TracerPid=$trp cmd=$cmd"
    case "$comm$cmd" in *proot*) LEFT=1;; esac
  done
  [ "$LEFT" = "0" ] && echo "  OK：没有残留 proot 进程了"
  echo
  echo "接下来：打开 DSH Go → 本机引擎 → 点「重新…」（或重新安装运行环境）"
  echo "装完再跑一次 'bash $SCRIPT_NAME'，把日志文件发我。"
fi

say "结束"
echo "日志文件: $LOG_FILE"
