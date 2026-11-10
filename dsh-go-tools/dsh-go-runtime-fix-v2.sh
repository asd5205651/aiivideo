#!/bin/sh
# dsh-go 1.0.15 本机引擎诊断 / 修复
# 目标问题：install failed: runtime_upgrade_blocked:running
#
# 用法:
#   sh dsh-go-runtime-fix-v2.sh          # 只诊断（不改任何文件）
#   sh dsh-go-runtime-fix-v2.sh fix      # 诊断 + 清掉卡住升级的残留 proot 进程
#
# 兼容: POSIX sh（Termux 的 sh / Android 的 mksh 都能跑），不需要 bash 特性。
# 需要 root：脚本会自动提权一次（su / tsu 都试）。
# 输出同时写入「本脚本所在文件夹」下的 dsh-go-runtime-fix-<时间戳>.log

PATH="/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin:/usr/bin:/bin:$PATH"
export PATH

MODE="diag"
case "${1:-}" in
  fix) MODE="fix" ;;
  diag|"") MODE="diag" ;;
  *) echo "用法: sh $0 [diag|fix]"; exit 2 ;;
esac

# ---------- 定位本脚本（POSIX 写法，不依赖 BASH_SOURCE） ----------
SELF="$0"
case "$SELF" in
  /*) ;;
  *) SELF="$PWD/$SELF" ;;
esac
if command -v readlink >/dev/null 2>&1; then
  R=$(readlink -f "$SELF" 2>/dev/null)
  [ -n "$R" ] && SELF="$R"
fi
SCRIPT_DIR=$(dirname "$SELF")
SCRIPT_NAME=$(basename "$SELF")

# ---------- 提权 ----------
if [ "$(id -u)" != "0" ]; then
  echo "[*] 需要 root，正在提权…"
  if command -v su >/dev/null 2>&1; then
    exec su -c "sh '$SELF' $MODE"
  elif command -v tsu >/dev/null 2>&1; then
    exec tsu sh "'$SELF'" "$MODE"
  else
    echo "!! 找不到 su/tsu，请自己在 Termux 里执行: su -c \"sh '$SELF' $MODE\""
    exit 1
  fi
fi

# ---------- 日志文件（脚本同目录；不可写则退回当前目录） ----------
OUT_DIR="$SCRIPT_DIR"
if ! ( : > "$OUT_DIR/.dsh-go-write-test" ) 2>/dev/null; then
  OUT_DIR="$PWD"
  echo "[!] 脚本目录不可写，日志改存到 $OUT_DIR"
else
  rm -f "$OUT_DIR/.dsh-go-write-test" 2>/dev/null
fi
STAMP=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo 0)
LOG_FILE="$OUT_DIR/dsh-go-runtime-fix-$STAMP.log"

# ---------- 主流程（全部输出走 tee，同时上屏和落盘） ----------
main() {
  say(){ echo; echo "=== $* ==="; }

  say "运行信息"
  echo "脚本      : $SELF"
  echo "脚本目录  : $SCRIPT_DIR"
  echo "日志文件  : $LOG_FILE"
  echo "模式      : $MODE"
  echo "uid       : $(id -u)   SELinux: $(getenforce 2>/dev/null || echo '?')"
  echo "时间      : $(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"
  echo "shell     : $0"

  PKG=io.github.ccch1mneyyy.dsh_app
  BASE="/data/user/0/$PKG"
  RT="$BASE/runtime"

  if [ ! -d "$BASE" ]; then
    echo "!! 找不到 $BASE（App 没装，或包名/路径不同）"
    return 1
  fi
  AUID=$(stat -c %u "$BASE" 2>/dev/null)
  echo "App 数据目录: $BASE"
  echo "App uid     : $AUID"

  say "运行时目录状态"
  ls -la "$RT" 2>&1 | sed 's/^/  /'
  echo "  rootfs.version = $(cat "$RT/rootfs.version" 2>/dev/null || echo '(无)')"
  echo "  dsh-web.pid    = $(cat "$RT/rootfs/tmp/dsh-web.pid" 2>/dev/null || echo '(无)')"
  echo "  旧 runtime.json:"
  if [ -f "$RT/rootfs/etc/dsh-app/runtime.json" ]; then
    head -30 "$RT/rootfs/etc/dsh-app/runtime.json" | sed 's/^/    /'
  else
    echo "    (无)"
  fi
  echo "  staging runtime.json:"
  if [ -f "$RT/staging/etc/dsh-app/runtime.json" ]; then
    head -30 "$RT/staging/etc/dsh-app/runtime.json" | sed 's/^/    /'
  else
    echo "    (无 staging)"
  fi

  say "升级事务 / 残留标记"
  for d in engine.upgrade engine.prepare engine.done home.carry rootfs.old staging runtime-keep runtime.reset; do
    if [ -e "$RT/$d" ]; then echo "  存在: $d"; else echo "  无  : $d"; fi
  done

  say "磁盘空间（安装需要约 920 MB 解压空间）"
  df -h "$RT" 2>&1 | sed 's/^/  /'

  say "App uid 名下的全部进程"
  KILL=""
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    [ -d "$d" ] || continue
    owner=$(stat -c %u "$d" 2>/dev/null)
    [ -n "$owner" ] || continue
    [ "$owner" = "$AUID" ] || continue
    comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
    st=$(sed 's/^[0-9]* (.*) //' "$d/stat" 2>/dev/null | cut -c1-1)
    trp=$(awk '/^TracerPid:/{print $2}' "$d/status" 2>/dev/null)
    cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-140)
    mark=""
    [ -n "$trp" ] && [ "$trp" != "0" ] && mark="proot追踪(TracerPid=$trp)"
    case "$comm$cmd" in *proot*) mark="$mark PROOT";; esac
    case "$cmd" in *rootfs*) mark="$mark ROOTFS";; esac
    echo "  pid=$p comm=$comm state=$st $mark"
    echo "      cmd=$cmd"
    # App 能否读到自己的 /proc/<pid>/*：这正是 App 判定「进程观测不可用」的条件
    if [ -n "$cmd" ]; then
      if cat "$d/environ" >/dev/null 2>&1; then
        echo "      root 读 environ : OK"
      else
        echo "      root 读 environ : 失败(EPERM/EACCES)"
      fi
      if cat "$d/cwd" >/dev/null 2>&1; then
        echo "      root 读 cwd     : OK"
      else
        echo "      root 读 cwd     : 失败(EPERM/EACCES)"
      fi
    fi
    case "$mark" in *PROOT*|*追踪*) KILL="$KILL $p";; esac
  done
  echo "  ==> 需要清理的 pid:${KILL:-（无）}"

  say "以 App 身份复现观测条件（这是 App 判定的真实视角）"
  if [ -n "$AUID" ] && command -v su >/dev/null 2>&1; then
    for d in /proc/[0-9]*; do
      p=${d#/proc/}
      [ -d "$d" ] || continue
      owner=$(stat -c %u "$d" 2>/dev/null)
      [ "$owner" = "$AUID" ] || continue
      comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
      case "$comm" in *proot*) ;; *) continue;; esac
      echo "  --- pid=$p comm=$comm ---"
      for f in cmdline environ cwd; do
        out=$(su "$AUID" -c "cat /proc/$p/$f" 2>&1 | head -c 120)
        case "$out" in
          *"Permission denied"*|*"denied"*) echo "    App 读 $f : Permission denied  <== App 判定为「观测不可用」" ;;
          "") echo "    App 读 $f : (空)" ;;
          *) echo "    App 读 $f : OK ($(echo "$out" | head -c 60))" ;;
        esac
      done
    done
  else
    echo "  (无 su 或无 App uid，跳过)"
  fi

  say "App 日志里的关键行"
  if [ -f "$RT/logs/dsh.log" ]; then
    grep -nE "runtime_upgrade_blocked|cleanup incomplete|process observation|unpacking runtime|runtime ready|install failed" "$RT/logs/dsh.log" 2>/dev/null | tail -30 | sed 's/^/  /'
    echo "  ---- 日志尾部 ----"
    tail -n 15 "$RT/logs/dsh.log" | sed 's/^/  /'
  else
    echo "  (读不到 $RT/logs/dsh.log)"
  fi

  if [ "$MODE" = "fix" ]; then
    say "执行清理"
    echo "  强制停止 DSH Go…"
    am force-stop "$PKG" 2>&1 | sed 's/^/    /'
    sleep 2
    for p in $KILL; do
      echo "  kill -9 $p"
      kill -9 "$p" 2>/dev/null || true
    done
    sleep 1
    # 残留的 proot 子进程可能脱离父进程，再扫一遍
    for d in /proc/[0-9]*; do
      p=${d#/proc/}
      [ -d "$d" ] || continue
      owner=$(stat -c %u "$d" 2>/dev/null)
      [ "$owner" = "$AUID" ] || continue
      comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
      case "$comm" in *proot*) echo "  再 kill -9 $p"; kill -9 "$p" 2>/dev/null || true;; esac
    done
    sleep 1
    if [ -f "$RT/rootfs/tmp/dsh-web.pid" ]; then
      rm -f "$RT/rootfs/tmp/dsh-web.pid" 2>/dev/null && echo "  已删除失效的 tmp/dsh-web.pid"
    fi
    say "清理后复查"
    LEFT=0
    for d in /proc/[0-9]*; do
      p=${d#/proc/}
      [ -d "$d" ] || continue
      owner=$(stat -c %u "$d" 2>/dev/null)
      [ "$owner" = "$AUID" ] || continue
      comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
      trp=$(awk '/^TracerPid:/{print $2}' "$d/status" 2>/dev/null)
      cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-100)
      echo "  pid=$p comm=$comm TracerPid=$trp cmd=$cmd"
      case "$comm$cmd" in *proot*) LEFT=1;; esac
    done
    [ "$LEFT" = "0" ] && echo "  OK：没有残留 proot 进程了" || echo "  仍有 proot 残留，看上面列表"
    echo
    echo "下一步：打开 DSH Go → 本机引擎 → 点「重新…」/ 重新安装运行环境"
    echo "装完再跑一次 'sh $SCRIPT_NAME'，把新日志发我。"
  fi

  say "结束"
  echo "日志文件: $LOG_FILE"
}

main 2>&1 | tee -a "$LOG_FILE"
