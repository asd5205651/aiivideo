#!/bin/sh
# dsh-go 1.0.15 本机引擎诊断 / 修复 v3
# 目标问题：install failed: runtime_upgrade_blocked:running
#
# 用法:
#   sh dsh-go-runtime-fix-v3.sh          # 只诊断（不改任何文件）
#   sh dsh-go-runtime-fix-v3.sh fix      # 诊断 + 强制清场（停 App + 杀全部 App 进程）
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

# ---------- 常量 ----------
PKG=io.github.ccch1mneyyy.dsh_app
BASE="/data/user/0/$PKG"
# 关键修正：RuntimeInstaller.baseDir = File(context.filesDir, "runtime")
# context.filesDir = /data/user/0/<pkg>/files
RT="$BASE/files/runtime"
LOGS="$BASE/files/runtime/logs"

main() {
  say(){ echo; echo "=== $* ==="; }

  say "运行信息"
  echo "脚本      : $SELF"
  echo "脚本目录  : $SCRIPT_DIR"
  echo "日志文件  : $LOG_FILE"
  echo "模式      : $MODE"
  echo "uid       : $(id -u)   SELinux: $(getenforce 2>/dev/null || echo '?')"
  echo "时间      : $(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"

  if [ ! -d "$BASE" ]; then
    echo "!! 找不到 $BASE（App 没装，或包名/路径不同）"
    return 1
  fi
  AUID=$(stat -c %u "$BASE" 2>/dev/null)
  echo "App 数据目录: $BASE"
  echo "App uid     : $AUID"
  echo "运行时目录  : $RT"

  say "App 版本"
  if command -v dumpsys >/dev/null 2>&1; then
    dumpsys package "$PKG" 2>/dev/null | grep -E "versionName|versionCode|firstInstallTime|lastUpdateTime" | sed 's/^/  /'
  fi
  APK=$(command -v pm >/dev/null 2>&1 && pm path "$PKG" 2>/dev/null | head -1 | sed 's/^package://')
  echo "  APK: ${APK:-（未知）}"

  say "App 内置的运行时清单（APK assets/runtime/manifest.json）"
  if [ -n "$APK" ] && [ -f "$APK" ]; then
    if command -v unzip >/dev/null 2>&1; then
      unzip -p "$APK" assets/runtime/manifest.json 2>/dev/null | head -40 | sed 's/^/  /'
    elif command -v python3 >/dev/null 2>&1; then
      python3 -c "
import zipfile,sys
try:
    z=zipfile.ZipFile('$APK')
    d=z.read('assets/runtime/manifest.json').decode('utf-8','replace')
    print('\n'.join('  '+l for l in d.splitlines()[:40]))
except Exception as e:
    print('  (读取失败: %s)' % e)
" 2>/dev/null
    else
      echo "  (没有 unzip / python3，跳过)"
    fi
  else
    echo "  (拿不到 APK 文件)"
  fi

  say "files/ 目录"
  ls -la "$BASE/files" 2>&1 | sed 's/^/  /'

  say "运行时目录状态"
  if [ ! -d "$RT" ]; then
    echo "  !! $RT 不存在 —— 运行时根本没装过（和 App 显示「运行环境还没有安装」一致）"
    ls -la "$BASE/files" 2>&1 | sed 's/^/  /'
  else
    ls -la "$RT" 2>&1 | sed 's/^/  /'
    echo "  rootfs.version = $(cat "$RT/rootfs.version" 2>/dev/null || echo '(无)')"
    echo "  dsh-web.pid    = $(cat "$RT/rootfs/tmp/dsh-web.pid" 2>/dev/null || echo '(无)')"
    echo "  已装 runtime.json:"
    if [ -f "$RT/rootfs/etc/dsh-app/runtime.json" ]; then
      head -40 "$RT/rootfs/etc/dsh-app/runtime.json" | sed 's/^/    /'
    else
      echo "    (无)"
    fi
    echo "  staging runtime.json:"
    if [ -f "$RT/staging/etc/dsh-app/runtime.json" ]; then
      head -40 "$RT/staging/etc/dsh-app/runtime.json" | sed 's/^/    /'
    else
      echo "    (无 staging)"
    fi
  fi

  say "升级事务 / 残留标记"
  for d in engine.upgrade engine.prepare engine.done home.carry rootfs.old staging runtime-keep runtime.reset; do
    if [ -e "$RT/$d" ]; then echo "  存在: $RT/$d"; else echo "  无  : $d"; fi
  done

  say "磁盘空间"
  df -h "$BASE/files" 2>&1 | sed 's/^/  /'

  say "App uid 名下的全部进程（关键：TracerPid != 0 的就是 App 读不到 /proc 的那个）"
  KILL=""
  TRACED=""
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    [ -d "$d" ] || continue
    owner=$(stat -c %u "$d" 2>/dev/null)
    [ -n "$owner" ] || continue
    [ "$owner" = "$AUID" ] || continue
    comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
    ppid=$(awk '/^PPid:/{print $2}' "$d/status" 2>/dev/null)
    trp=$(awk '/^TracerPid:/{print $2}' "$d/status" 2>/dev/null)
    cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-140)
    mark=""
    [ -n "$trp" ] && [ "$trp" != "0" ] && mark="*** 被 ptrace 追踪(TracerPid=$trp) -> App 读不到它的 cmdline/environ ***"
    case "$comm$cmd" in *proot*) mark="$mark PROOT";; esac
    case "$cmd" in *rootfs*) mark="$mark ROOTFS";; esac
    echo "  pid=$p ppid=$ppid comm=$comm $mark"
    echo "      cmd=$cmd"
    case "$mark" in *PROOT*|*追踪*) KILL="$KILL $p";; esac
    [ -n "$trp" ] && [ "$trp" != "0" ] && TRACED="$TRACED $p"
  done
  echo "  ==> proot/被追踪的 pid:${KILL:-（无）}"
  echo "  ==> 被 ptrace 的 pid（App 唯一读不到的那类）:${TRACED:-（无）}"

  say "根视角逐项读取测试（App 视角会失败，但根能读到 → 证明是 ptrace 限制，不是文件损坏）"
  for p in $TRACED; do
    echo "  --- pid=$p ---"
    for f in cmdline environ cwd; do
      if [ "$f" = "cwd" ]; then
        out=$(readlink "/proc/$p/$f" 2>&1)
      else
        out=$(cat "/proc/$p/$f" 2>&1 | head -c 100)
      fi
      case "$out" in
        *"Permission denied"*) echo "    $f : Permission denied" ;;
        "") echo "    $f : (空)" ;;
        *) echo "    $f : OK ($(echo "$out" | head -c 70))" ;;
      esac
    done
    echo "    SELinux 上下文: $(ls -Zd "/proc/$p" 2>/dev/null | awk '{print $NF}')"
  done

  say "App 日志关键行"
  if [ -f "$LOGS/dsh.log" ]; then
    grep -nE "runtime_upgrade_blocked|cleanup incomplete|process observation|unpacking runtime|runtime ready|install failed" "$LOGS/dsh.log" 2>/dev/null | tail -40 | sed 's/^/  /'
    echo "  ---- 日志尾部 ----"
    tail -n 20 "$LOGS/dsh.log" | sed 's/^/  /'
  else
    echo "  (读不到 $LOGS/dsh.log)"
  fi

  if [ "$MODE" = "fix" ]; then
    say "执行清场"
    echo "  1) 强制停止 DSH Go（会杀掉主进程 + :input_probe 等子进程 + proot）"
    am force-stop "$PKG" 2>&1 | sed 's/^/    /'
    sleep 2
    echo "  2) 扫一遍并杀掉所有 App uid 的残留进程"
    for d in /proc/[0-9]*; do
      p=${d#/proc/}
      [ -d "$d" ] || continue
      owner=$(stat -c %u "$d" 2>/dev/null)
      [ -n "$owner" ] || continue
      [ "$owner" = "$AUID" ] || continue
      comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
      cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-80)
      case "$comm$cmd" in
        *proot*|*rootfs*|*1mneyyy.dsh_app*)
          echo "    kill -9 $p  ($comm)"
          kill -9 "$p" 2>/dev/null || true
          ;;
      esac
    done
    sleep 1
    echo "  3) 清理失效的 pid 文件"
    for f in "$RT/rootfs/tmp/dsh-web.pid" "$RT/tmp/dsh-web.pid"; do
      [ -f "$f" ] && rm -f "$f" 2>/dev/null && echo "    已删除 $f"
    done
    echo "  4) 同步磁盘"
    sync 2>/dev/null

    say "清场后复查"
    LEFT=0
    for d in /proc/[0-9]*; do
      p=${d#/proc/}
      [ -d "$d" ] || continue
      owner=$(stat -c %u "$d" 2>/dev/null)
      [ -n "$owner" ] || continue
      [ "$owner" = "$AUID" ] || continue
      comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
      trp=$(awk '/^TracerPid:/{print $2}' "$d/status" 2>/dev/null)
      cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-100)
      echo "    pid=$p comm=$comm TracerPid=$trp cmd=$cmd"
      LEFT=1
    done
    [ "$LEFT" = "0" ] && echo "  OK：App uid 下已无任何进程" || echo "  仍有残留，看上面列表"
    echo
    echo "下一步（顺序很重要）："
    echo "  1) 打开 DSH Go → 本机引擎"
    echo "  2) 确认引擎状态是「已停止」（不要让它自动起引擎）"
    echo "  3) 再点「重新安装」/「重新…」"
    echo "装完再跑一次 'sh $SCRIPT_NAME'，把新日志发我。"
  fi

  say "结束"
  echo "日志文件: $LOG_FILE"
}

main 2>&1 | tee -a "$LOG_FILE"
