#!/bin/sh
# dsh-go 1.0.15 本机引擎修复 v4
#
# 已确诊的根因：
#   1.0.15 在 install() 前新增了 killStrays() 闸门（1.0.14 没有这行）。
#   该闸门要求 /proc 观测「完全可观测」；而 proot 用 ptrace 追踪自己的子进程，
#   被追踪进程的 /proc/<pid>/cwd 对非追踪者不可读 -> App 读不到 -> 该 pid 进 uncertain
#   -> 它进不了 records -> owned 算出来是 0 -> snapshot.observed=false
#   -> killStrays() 返回 complete=false -> throw RuntimeUpgradeBlocked("running")
#   -> 1.0.15 的运行时永远装不进来 -> 界面显示「运行环境还没有安装」。
#   App 杀不掉它，因为它连归属都读不出来。
#
# 本脚本三种模式：
#   diag           只诊断（不改任何文件）
#   fix            清场：停 App + 杀 App uid 下全部进程 + 删失效 pid 文件 + sync
#   repair         绕过 App 的闸门，手工完成 1.0.15 引擎替换（/root 不动）
#   repair --dry-run   只列出将要替换的路径，不做任何修改
#
# 用法:
#   sh dsh-go-runtime-fix-v4.sh [diag|fix|repair] [--dry-run]
#
# 兼容 POSIX sh。需 root（自动 su / tsu 提权）。日志写在脚本同目录。

PATH="/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin:/usr/bin:/bin:$PATH"
export PATH

MODE="diag"
DRY=0
for a in "$@"; do
  case "$a" in
    fix|repair|diag) MODE="$a" ;;
    --dry-run) DRY=1 ;;
    *) echo "用法: sh $0 [diag|fix|repair] [--dry-run]"; exit 2 ;;
  esac
done

SELF="$0"
case "$SELF" in /*) ;; *) SELF="$PWD/$SELF" ;; esac
if command -v readlink >/dev/null 2>&1; then
  R=$(readlink -f "$SELF" 2>/dev/null); [ -n "$R" ] && SELF="$R"
fi
SCRIPT_DIR=$(dirname "$SELF")
SCRIPT_NAME=$(basename "$SELF")

if [ "$(id -u)" != "0" ]; then
  echo "[*] 需要 root，正在提权…"
  if command -v su >/dev/null 2>&1; then
    exec su -c "sh '$SELF' $MODE"
  elif command -v tsu >/dev/null 2>&1; then
    exec tsu sh "'$SELF'" "$MODE"
  else
    echo "!! 找不到 su/tsu，请手动: su -c \"sh '$SELF' $MODE\""
    exit 1
  fi
fi

OUT_DIR="$SCRIPT_DIR"
if ! ( : > "$OUT_DIR/.dsh-go-write-test" ) 2>/dev/null; then
  OUT_DIR="$PWD"; echo "[!] 脚本目录不可写，日志改存到 $OUT_DIR"
else
  rm -f "$OUT_DIR/.dsh-go-write-test" 2>/dev/null
fi
STAMP=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo 0)
LOG_FILE="$OUT_DIR/dsh-go-runtime-fix-$STAMP.log"

PKG=io.github.ccch1mneyyy.dsh_app
BASE="/data/user/0/$PKG"
RT="$BASE/files/runtime"
ROOTFS="$RT/rootfs"

# 1.0.15 的 15 个引擎路径（与 APK assets/runtime/manifest.json 的 upgrade.paths 一致）
ENGINE_PATHS="opt/dsh
opt/node
opt/dsh-go
etc/dsh-app
etc/profile.d/dsh-app.sh
usr/local/lib/node_modules/pnpm
usr/local/bin/dsh
usr/local/bin/node
usr/local/bin/npm
usr/local/bin/npx
usr/local/bin/corepack
usr/local/bin/pnpm
usr/local/bin/pnpx
usr/local/bin/pn
usr/local/bin/pnx"

# 工作目录：优先 /data/local/tmp（快），不行退回脚本目录
WORK=""
for cand in "/data/local/tmp/dsh-go-repair" "$SCRIPT_DIR/.dsh-go-repair"; do
  if mkdir -p "$cand" 2>/dev/null && ( : > "$cand/.t" ) 2>/dev/null; then
    rm -f "$cand/.t" 2>/dev/null; WORK="$cand"; break
  fi
done
[ -z "$WORK" ] && WORK="/tmp/dsh-go-repair" && mkdir -p "$WORK" 2>/dev/null

say(){ echo; echo "=== $* ==="; }

apk_extract() {
  _apk="$1"; _in="$2"; _out="$3"
  if command -v unzip >/dev/null 2>&1; then
    unzip -p "$_apk" "$_in" > "$_out" 2>/dev/null && [ -s "$_out" ] && return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$_apk" "$_in" "$_out" <<'PY' 2>/dev/null && return 0
import sys, zipfile
apk, inner, out = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = zipfile.ZipFile(apk).read(inner)
    open(out, "wb").write(data)
    sys.exit(0)
except Exception:
    sys.exit(1)
PY
  fi
  return 1
}

apk_manifest_field() {
  _apk="$1"; _key="$2"; _tmp="$WORK/manifest.json"
  [ -f "$_tmp" ] || apk_extract "$_apk" "assets/runtime/manifest.json" "$_tmp" || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$_tmp" "$_key" <<'PY'
import sys, json
try:
    v = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
for part in sys.argv[2].split('.'):
    if isinstance(v, dict) and part in v:
        v = v[part]
    else:
        sys.exit(1)
print(v if not isinstance(v, (dict, list)) else json.dumps(v))
PY
    return $?
  fi
  grep -o "\"$_key\"[^,}]*" "$_tmp" | head -1 | sed 's/.*: *"\{0,1\}\([^",}]*\).*/\1/'
}

apk_paths_list() {
  _apk="$1"; _tmp="$WORK/manifest.json"
  [ -f "$_tmp" ] || apk_extract "$_apk" "assets/runtime/manifest.json" "$_tmp" || return 1
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$_tmp" <<'PY'
import sys, json
try:
    d = json.load(open(sys.argv[1]))
    p = d.get("upgrade", {}).get("paths", [])
    print("\n".join(p))
except Exception:
    sys.exit(1)
PY
    return $?
  fi
  printf '%s\n' "$ENGINE_PATHS"
}

apk_path() {
  command -v pm >/dev/null 2>&1 && pm path "$PKG" 2>/dev/null | head -1 | sed 's/^package://'
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else echo ""; fi
}

# 解 xz + tar：按优先级换实现
extract_engine() {
  _archive="$1"; _stage="$2"; _paths="$3"
  mkdir -p "$_stage" || return 1
  # 1) xz -dc | tar -xf -
  if command -v xz >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    (cd "$_stage" && xz -dc "$_archive" | tar -xf - $(echo "$_paths" | tr '\n' ' ')) 2>/dev/null && return 0
  fi
  # 2) tar -xJf（busybox/toybox 自带 xz 支持时）
  if command -v tar >/dev/null 2>&1; then
    (cd "$_stage" && tar -xJf "$_archive" $(echo "$_paths" | tr '\n' ' ')) 2>/dev/null && return 0
  fi
  # 3) python3 lzma + tarfile 兜底
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$_archive" "$_stage" "$_paths" <<'PY' 2>/dev/null && return 0
import sys, tarfile, lzma
archive, stage, paths = sys.argv[1], sys.argv[2], sys.argv[3].split()
want = set(paths)
try:
    with lzma.open(archive) as f, tarfile.open(fileobj=f, mode='r|') as t:
        for m in t:
            if not m.name.startswith(tuple(paths)):
                continue
            try:
                t.extract(m, stage, set_attrs=True)
            except Exception:
                pass
    import os
    for p in paths:
        if not os.path.exists(os.path.join(stage, p)):
            sys.exit(1)
    sys.exit(0)
except Exception:
    sys.exit(1)
PY
  fi
  return 1
}

app_busy() {
  _au="$1"; _busy=0
  for d in /proc/[0-9]*; do
    p=${d#/proc/}; [ -d "$d" ] || continue
    owner=$(stat -c %u "$d" 2>/dev/null); [ -n "$owner" ] || continue
    [ "$owner" = "$_au" ] || continue
    comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
    cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-80)
    case "$comm$cmd" in *proot*|*rootfs*|*1mneyyy.dsh_app*|*app_process*) _busy=1 ;; esac
  done
  echo "$_busy"
}

main() {
  say "运行信息"
  echo "脚本     : $SELF"
  echo "日志文件 : $LOG_FILE"
  echo "模式     : $MODE   dry-run=$DRY"
  echo "uid      : $(id -u)  SELinux: $(getenforce 2>/dev/null || echo '?')"
  echo "时间     : $(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"
  echo "工作目录 : $WORK"

  [ -d "$BASE" ] || { echo "!! 找不到 $BASE（App 未安装？）"; return 1; }
  AUID=$(stat -c %u "$BASE" 2>/dev/null)
  echo "App uid  : $AUID"
  echo "运行时   : $RT"

  APK=$(apk_path)
  echo "APK      : ${APK:-（未知）}"

  say "版本对比"
  CUR=$(cat "$RT/rootfs.version" 2>/dev/null)
  echo "  已装 rootfs.version : ${CUR:-（无）}"
  WANT=""
  if [ -n "$APK" ]; then
    WANT=$(apk_manifest_field "$APK" runtimeVersion 2>/dev/null)
    echo "  APK 期望版本       : ${WANT:-（读不到）}"
    echo "  APK upgrade.baseId  : $(apk_manifest_field "$APK" upgrade.baseId 2>/dev/null || echo '(无)')"
    echo "  已装 runtime.json 是否含 upgrade 字段:"
    if grep -q '"upgrade"' "$ROOTFS/etc/dsh-app/runtime.json" 2>/dev/null; then
      echo "    含（说明是 1.0.15+ 的 rootfs）"
    else
      echo "    不含（旧 rootfs，需要一次性采纳判定）"
    fi
  fi

  say "磁盘空间"
  df -h "$BASE/files" "$WORK" 2>&1 | sed 's/^/  /'

  say "App uid 名下的进程（root 视角逐项读 /proc，验证 ptrace 限制）"
  for d in /proc/[0-9]*; do
    p=${d#/proc/}; [ -d "$d" ] || continue
    owner=$(stat -c %u "$d" 2>/dev/null); [ -n "$owner" ] || continue
    [ "$owner" = "$AUID" ] || continue
    comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
    trp=$(awk '/^TracerPid:/{print $2}' "$d/status" 2>/dev/null)
    cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-110)
    mark=""; [ -n "$trp" ] && [ "$trp" != "0" ] && mark="*** TracerPid=$trp（被ptrace，App读不到它的cwd）***"
    echo "  pid=$p comm=$comm $mark"
    echo "      cmd=$cmd"
    for f in cmdline environ; do
      if cat "/proc/$p/$f" >/dev/null 2>&1; then echo "      $f: OK"; else echo "      $f: 读不到"; fi
    done
    if readlink "/proc/$p/cwd" >/dev/null 2>&1; then
      echo "      cwd: OK -> $(readlink "/proc/$p/cwd" 2>/dev/null)"
    else
      echo "      cwd: 读不到（ptrace 限制）"
    fi
  done

  case "$MODE" in
    diag) ;;
    fix) do_fix "$AUID" ;;
    repair) do_repair "$AUID" "$APK" "$WANT" ;;
  esac

  say "结束"
  echo "日志文件: $LOG_FILE"
}

do_fix() {
  _au="$1"
  say "清场（让 App 自己重装）"
  echo "  1) am force-stop $PKG"
  am force-stop "$PKG" 2>&1 | sed 's/^/    /'
  sleep 2
  echo "  2) 杀掉 App uid 下全部残留进程"
  for d in /proc/[0-9]*; do
    p=${d#/proc/}; [ -d "$d" ] || continue
    owner=$(stat -c %u "$d" 2>/dev/null); [ -n "$owner" ] || continue
    [ "$owner" = "$_au" ] || continue
    comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
    cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-80)
    case "$comm$cmd" in
      *proot*|*rootfs*|*1mneyyy.dsh_app*|*app_process*)
        echo "    kill -9 $p ($comm)"; kill -9 "$p" 2>/dev/null || true ;;
    esac
  done
  sleep 1
  echo "  3) 删除失效的 pid 文件"
  for f in "$ROOTFS/tmp/dsh-web.pid" "$RT/tmp/dsh-web.pid"; do
    [ -f "$f" ] && rm -f "$f" 2>/dev/null && echo "    已删 $f"
  done
  sync 2>/dev/null
  say "清场后复查"
  if [ "$(app_busy "$_au")" = "0" ]; then
    echo "  OK：App uid 下已无进程"
  else
    echo "  仍有残留，见上面"
  fi
  echo
  echo "下一步：打开 DSH Go → 本机引擎 → 点「重新…」。"
  echo "若仍报 runtime_upgrade_blocked:running（大概率会），改用: sh $SCRIPT_NAME repair"
}

do_repair() {
  _au="$1"; _apk="$2"; _want="$3"
  say "手工完成 1.0.15 引擎替换（绕过 App 的 killStrays 闸门）"

  if [ "$(app_busy "$_au")" = "1" ]; then
    echo "  !! App 或 proot 还在跑。先执行: sh $SCRIPT_NAME fix"
    return 1
  fi
  [ -d "$ROOTFS" ] || { echo "  !! 没有 rootfs（$ROOTFS）"; return 1; }
  [ -n "$_apk" ] || { echo "  !! 拿不到 APK 路径"; return 1; }
  [ -n "$_want" ] || { echo "  !! 读不到 APK 内 runtimeVersion"; return 1; }

  CUR=$(cat "$RT/rootfs.version" 2>/dev/null)
  echo "  已装: ${CUR:-（无）}"
  echo "  目标: $_want"
  [ "$_want" = "$CUR" ] && { echo "  已是目标版本，无需替换"; return 0; }

  # 引擎路径清单：优先从 APK manifest 读，读不到用内置的
  PATHS=$(apk_paths_list "$_apk" 2>/dev/null)
  [ -n "$PATHS" ] || PATHS="$ENGINE_PATHS"
  echo "  引擎路径数: $(echo "$PATHS" | grep -c .)"

  # 1) 取 rootfs 归档
  ARCHIVE="$WORK/rootfs-arm64-v8a.tar.xz"
  if [ ! -s "$ARCHIVE" ]; then
    echo "  从 APK 取出 rootfs 归档（约 160 MB，需 1-2 分钟）…"
    apk_extract "$_apk" "assets/runtime/rootfs-arm64-v8a.tar.xz" "$ARCHIVE" || {
      echo "  !! 取不出 assets/runtime/rootfs-arm64-v8a.tar.xz"; return 1; }
  fi
  echo "  归档大小: $(ls -l "$ARCHIVE" | awk '{print $5}') bytes"

  # 2) 校验 sha256
  EXPECT=$(apk_manifest_field "$_apk" rootfsSha256 2>/dev/null)
  ACTUAL=$(sha256_of "$ARCHIVE")
  echo "  sha256 期望: ${EXPECT:-（无）}"
  echo "  sha256 实际: ${ACTUAL:-（算不出）}"
  if [ -n "$EXPECT" ] && [ -n "$ACTUAL" ] && [ "$EXPECT" != "$ACTUAL" ]; then
    echo "  !! 归档校验失败，终止（不碰 rootfs）"; return 1
  fi
  [ -n "$EXPECT" ] && [ "$EXPECT" = "$ACTUAL" ] && echo "  sha256 校验通过"

  # 3) 解出引擎路径
  STAGE="$WORK/stage"
  rm -rf "$STAGE" 2>/dev/null
  echo "  解压引擎路径（只解这 $(( $(echo "$PATHS" | grep -c .) )) 个，不解整个 rootfs）…"
  extract_engine "$ARCHIVE" "$STAGE" "$PATHS" || { echo "  !! 解压失败"; return 1; }
  echo "  解出:"
  ls -la "$STAGE" 2>&1 | sed 's/^/    /'

  # 4) 干跑
  if [ "$DRY" = "1" ]; then
    say "DRY RUN：将替换以下路径"
    echo "$PATHS" | while read -r p; do
      [ -z "$p" ] && continue
      printf "    %-40s 旧:%-8s 新:%s\n" "$p" \
        "$([ -e "$ROOTFS/$p" ] && echo 存在 || echo 缺失)" \
        "$([ -e "$STAGE/$p" ] && echo 有 || echo 缺)"
    done
    echo "  (DRY RUN 未做任何修改)"
    return 0
  fi

  # 5) 备份旧引擎
  BK="$RT/lkg/engine-$STAMP"
  mkdir -p "$BK" || return 1
  echo "  备份旧引擎到 $BK"
  echo "$PATHS" | while read -r p; do
    [ -z "$p" ] && continue
    [ -e "$ROOTFS/$p" ] || continue
    mkdir -p "$BK/$(dirname "$p")" 2>/dev/null
    cp -a "$ROOTFS/$p" "$BK/$p" 2>/dev/null || echo "    备份失败: $p"
  done

  # 6) 替换
  echo "  替换引擎路径…"
  FAILED=0
  echo "$PATHS" | while read -r p; do
    [ -z "$p" ] && continue
    if [ ! -e "$STAGE/$p" ]; then echo "    跳过（新版无此路径）: $p"; continue; fi
    OLD="$ROOTFS/$p.oldex"
    rm -rf "$OLD" 2>/dev/null
    if [ -e "$ROOTFS/$p" ]; then mv "$ROOTFS/$p" "$OLD" 2>/dev/null; fi
    mkdir -p "$(dirname "$ROOTFS/$p")" 2>/dev/null
    if cp -a "$STAGE/$p" "$ROOTFS/$p" 2>/dev/null; then
      rm -rf "$OLD" 2>/dev/null
      echo "    OK   $p"
    else
      echo "    FAIL $p（回滚）"
      [ -e "$OLD" ] && rm -rf "$ROOTFS/$p" 2>/dev/null && mv "$OLD" "$ROOTFS/$p" 2>/dev/null
    fi
  done

  # 7) 属主必须回到 App uid（App 以自己 uid 跑 proot）
  echo "  修正属主为 uid=$_au …"
  echo "$PATHS" | while read -r p; do
    [ -z "$p" ] && continue
    [ -e "$ROOTFS/$p" ] && chown -R "$_au:$_au" "$ROOTFS/$p" 2>/dev/null
    [ -e "$ROOTFS/$p" ] && chmod -R u+rwX "$ROOTFS/$p" 2>/dev/null
  done
  # 父目录也要可写
  for d in "$ROOTFS/opt" "$ROOTFS/etc" "$ROOTFS/etc/profile.d" "$ROOTFS/usr" "$ROOTFS/usr/local" "$ROOTFS/usr/local/bin" "$ROOTFS/usr/local/lib" "$ROOTFS/usr/local/lib/node_modules"; do
    [ -d "$d" ] && chown "$_au:$_au" "$d" 2>/dev/null
  done

  # 8) 版本标记（App 的 isCurrent() 就是比这个字符串）
  echo "$_want" > "$RT/rootfs.version" || return 1
  chown "$_au:$_au" "$RT/rootfs.version" 2>/dev/null
  sync
  echo "  rootfs.version = $(cat "$RT/rootfs.version")"

  say "完成"
  echo "  现在打开 DSH Go → 本机引擎 → 点「启动」。"
  echo "  启动成功后再跑一次 'sh $SCRIPT_NAME' 确认版本对上了。"
  echo "  旧引擎备份在: $BK"
  echo "  如需回滚: 把备份里的 15 个路径拷回 $ROOTFS，并把 rootfs.version 改回 ${CUR:-原值}"
}

main 2>&1 | tee -a "$LOG_FILE"
