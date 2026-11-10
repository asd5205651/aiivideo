#!/bin/sh
# dsh-go 1.0.15 本机引擎：插件兼容修复 v3
#
# 本脚本在【Termux】（root）里跑，但引擎（dsh/node/pnpm）装在 proot 的 rootfs 里，
# 所以必须用 proot 进 rootfs 才能操作插件。v1/v2 之所以失败，是因为它们在
# Termux 里直接找 dsh/node —— 那里根本没有，DSH_HOME 也变成了 //.dsh。
#
# 用法:
#   sh dsh-go-plugin-fix-v3.sh              # 执行
#   sh dsh-go-plugin-fix-v3.sh --dry-run    # 只打印将要执行的命令
#
# 前置：先在 DSH Go 里点「停止引擎」，再跑本脚本。
# 输出：全部写入【当前文件夹】下的 dsh-go-plugin-fix-<时间戳>.log
set -u

PKG=io.github.ccch1mneyyy.dsh_app
BASE="/data/user/0/$PKG"
ROOTFS="$BASE/files/runtime/rootfs"
HOST_PROF="$ROOTFS/root/.dsh/profiles/web"

CWD_DIR="$(pwd 2>/dev/null || echo "$HOME")"
OUT_DIR="$CWD_DIR"
if ! ( : > "$OUT_DIR/.dsh-go-write-test" ) 2>/dev/null; then
  OUT_DIR="$HOME"; echo "[!] 当前文件夹不可写，日志改存到 $OUT_DIR"
else
  rm -f "$OUT_DIR/.dsh-go-write-test" 2>/dev/null
fi
STAMP=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo 0)
LOG_FILE="$OUT_DIR/dsh-go-plugin-fix-$STAMP.log"

DRY=0
for a in "$@"; do
  case "$a" in --dry-run) DRY=1 ;; esac
done

say(){ echo; echo "=== $* ==="; }

# ---------- 找 proot / APK ----------
APK=$(/system/bin/pm path "$PKG" 2>/dev/null | head -1 | sed 's/^package://')
APKDIR=$(dirname "$APK" 2>/dev/null)
LIBDIR="$APKDIR/lib/arm64"
PROOT="$LIBDIR/libproot.so"
LOADER="$LIBDIR/libproot-loader.so"
PROOT_TMP="$BASE/cache/proot-tmp"

# ---------- guest 脚本（跑在 rootfs 里） ----------
GUEST="$ROOTFS/root/.dsh-go-plugin-fix-inner.sh"
cat > "$GUEST" <<'INNER'
set -u
PROFILE=web
DSH_HOME=/root/.dsh
PROF_DIR="$DSH_HOME/profiles/$PROFILE"

echo "=== guest 环境 ==="
echo "whoami   : $(id -un) ($(id -u))"
echo "HOME     : $HOME"
echo "DSH_HOME : $DSH_HOME"
echo "pwd      : $(pwd)"
echo "dsh      : $(command -v dsh 2>&1) $(dsh --version 2>&1 | head -1)"
echo "node     : $(command -v node 2>&1) $(node --version 2>&1 | head -1)"
echo "pnpm     : $(command -v pnpm 2>&1) $(pnpm --version 2>&1 | head -1)"

echo
echo "=== profile 目录 ==="
ls -la "$PROF_DIR" 2>&1 | head -20

echo
echo "=== 修复前：声明的插件 ==="
if [ -f "$PROF_DIR/package.json" ]; then
  node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for (const [k,v] of Object.entries(j.dependencies||{})) console.log("  "+k+" = "+v);
' "$PROF_DIR/package.json" 2>&1
else
  echo "  !! 找不到 $PROF_DIR/package.json"
fi

echo
echo "=== 修复前：实际安装版本 ==="
for p in @ccch1mneyyy/dsh-media @cocofhu/anime-find; do
  f="$PROF_DIR/node_modules/$p/package.json"
  if [ -f "$f" ]; then
    echo "  $p = $(node -e 'console.log(require(process.argv[1]).version)' "$f" 2>/dev/null)"
  else
    echo "  $p = (未安装)"
  fi
done

echo
echo "=== 步骤 1/3：@ccch1mneyyy/dsh-media -> 0.3.1 ==="
echo "(0.2.1 的 peer 写死 0.2.1-rc.4；引擎是 0.2.2-rc.1，故被跳过。0.3.1 支持两者)"
cd "$PROF_DIR" 2>/dev/null || { echo "  !! 进不去 $PROF_DIR"; exit 1; }
pnpm remove @ccch1mneyyy/dsh-media 2>&1 | tail -5 | sed 's/^/  /'
echo "  --- add 0.3.1 ---"
pnpm add @ccch1mneyyy/dsh-media@0.3.1 2>&1 | tail -30 | sed 's/^/  /'
echo "  add 退出码: $?"

echo
echo "=== 步骤 2/3：移除 @cocofhu/anime-find ==="
pnpm remove @cocofhu/anime-find 2>&1 | tail -10 | sed 's/^/  /'

echo
echo "=== 步骤 3/3：校验 ==="
echo "--- 现在的 profile 依赖 ---"
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for (const [k,v] of Object.entries(j.dependencies||{})) console.log("  "+k+" = "+v);
' "$PROF_DIR/package.json" 2>&1

echo "--- 实际安装版本 ---"
for p in @ccch1mneyyy/dsh-media @cocofhu/anime-find; do
  f="$PROF_DIR/node_modules/$p/package.json"
  if [ -f "$f" ]; then
    echo "  $p = $(node -e 'console.log(require(process.argv[1]).version)' "$f" 2>/dev/null)"
  else
    echo "  $p = (未安装)"
  fi
done

echo "--- dsh-media peer 是否覆盖当前 dsh ---"
MD="$PROF_DIR/node_modules/@ccch1mneyyy/dsh-media/package.json"
if [ -f "$MD" ]; then
  CUR=$(dsh --version 2>&1 | head -1 | sed 's/^v//')
  node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const cur=process.argv[2];
let bad=[];
for (const [k,v] of Object.entries(j.peerDependencies||{})) {
  if (!k.startsWith("@deepseek-ai/dsh-")) continue;
  const opts=String(v).split("||").map(s=>s.trim());
  if (!opts.includes(cur)) bad.push(k+" 要求 "+v);
}
console.log("  当前 dsh: "+cur);
console.log(bad.length ? "  !! 不匹配: "+bad.join("; ") : "  OK 全部匹配");
' "$MD" "$CUR" 2>&1
else
  echo "  (dsh-media 未安装)"
fi

echo
echo "=== 版本豁免 ==="
dsh plugin --profile web version-exemptions 2>&1 | sed 's/^/  /'
INNER

main() {
say "环境"
echo "当前文件夹 : $CWD_DIR"
echo "日志文件   : $LOG_FILE"
echo "模式       : $([ "$DRY" = 1 ] && echo DRY-RUN || echo 实做)"
echo "uid        : $(id -u)  SELinux: $(getenforce 2>/dev/null || echo '?')"
echo "时间       : $(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"

say "定位"
echo "APK        : ${APK:-（找不到）}"
echo "APK 目录   : ${APKDIR:-}"
echo "proot      : ${PROOT:-（找不到）}"
echo "rootfs     : $ROOTFS"
[ -d "$ROOTFS" ] || { echo "  !! rootfs 不存在，引擎没装好"; return 1; }
[ -f "$PROOT" ] || { echo "  !! proot 不存在"; return 1; }
echo "rootfs 里的 dsh: $(ls -la "$ROOTFS/usr/local/bin/dsh" 2>&1 | head -1)"
echo "rootfs 里的 pnpm: $(ls -la "$ROOTFS/usr/local/bin/pnpm" 2>&1 | head -1)"

say "App uid 下的进程（引擎在跑就别改插件）"
AUID=$(stat -c %u "$BASE" 2>/dev/null)
echo "App uid: $AUID"
BUSY=0
for d in /proc/[0-9]*; do
  p=${d#/proc/}; [ -d "$d" ] || continue
  owner=$(stat -c %u "$d" 2>/dev/null); [ -n "$owner" ] || continue
  [ "$owner" = "$AUID" ] || continue
  comm=$(tr -d '\000' < "$d/comm" 2>/dev/null)
  cmd=$(tr '\000' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-90)
  echo "  pid=$p comm=$comm cmd=$cmd"
  case "$comm$cmd" in *proot*|*rootfs*) BUSY=1 ;; esac
done
if [ "$BUSY" = "1" ]; then
  echo "  !! 引擎正在运行。请先在 DSH Go 里点「停止引擎」，再跑本脚本。"
  return 1
fi
echo "  引擎未运行，可以安全改插件"

say "proot 命令（dry-run 时只打印）"
mkdir -p "$PROOT_TMP" 2>/dev/null
cat > "$GUEST" 2>/dev/null && echo "  guest 脚本已写入 $GUEST"

if [ "$DRY" = "1" ]; then
  echo "  (DRY RUN，不执行)"
  return 0
fi

say "执行（进入 rootfs 跑 guest 脚本）"
PROOT_LOADER="$LOADER" \
PROOT_TMP_DIR="$PROOT_TMP" \
PROOT_L2S_DIR="$ROOTFS/root/.l2s" \
LD_LIBRARY_PATH="$LIBDIR" \
"$PROOT" \
  --kill-on-exit --link2symlink --sysvipc -L -0 \
  --rootfs="$ROOTFS" \
  --cwd=/root \
  -b /dev \
  -b /dev/urandom:/dev/random \
  -b /proc \
  -b /proc/self/fd:/dev/fd \
  -b /proc/self/fd/0:/dev/stdin \
  -b /proc/self/fd/1:/dev/stdout \
  -b /proc/self/fd/2:/dev/stderr \
  -b /sys \
  -b "$ROOTFS/var/lib/dsh-app/empty:/sys/fs/selinux" \
  -b "$ROOTFS/var/lib/dsh-app/shm:/dev/shm" \
  -b /system \
  -b /apex \
  /usr/bin/env -i \
  HOME=/root USER=root LOGNAME=root SHELL=/bin/bash \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  LANG=C.UTF-8 TERM=xterm-256color TMPDIR=/tmp \
  DSH_HOME=/root/.dsh \
  XDG_DATA_DIRS=/usr/local/share:/usr/share:/system \
  pnpm_config_registry=https://registry.npmmirror.com/ \
  NODE_OPTIONS=--dns-result-order=ipv4first \
  /bin/sh -c "/root/.dsh-go-plugin-fix-inner.sh"
RC=$?
echo "  guest 退出码: $RC"

say "修正属主（proot 以 root 跑，App 以 uid $AUID 跑）"
if [ -d "$HOST_PROF" ]; then
  chown -R "$AUID:$AUID" "$HOST_PROF" 2>/dev/null && echo "  已 chown $HOST_PROF"
  echo "  抽查:"
  ls -la "$HOST_PROF" 2>&1 | head -8 | sed 's/^/    /'
  for p in @ccch1mneyyy/dsh-media @cocofhu/anime-find; do
    f="$HOST_PROF/node_modules/$p/package.json"
    if [ -f "$f" ]; then
      v=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
      echo "    $p = ${v:-?}"
    else
      echo "    $p = (未安装)"
    fi
  done
else
  echo "  (没有 $HOST_PROF)"
fi
for d in "$ROOTFS/root/.local" "$ROOTFS/root/.cache" "$ROOTFS/root/.pnpm-store"; do
  [ -d "$d" ] && chown -R "$AUID:$AUID" "$d" 2>/dev/null && echo "  已 chown $d"
done
sync 2>/dev/null

say "清理"
rm -f "$GUEST" 2>/dev/null && echo "  已删除 guest 脚本"

say "收集到当前文件夹"
if [ -f "$HOST_PROF/package.json" ]; then
  cp "$HOST_PROF/package.json" "$OUT_DIR/profile-package.json" 2>/dev/null && echo "  已复制 profile-package.json"
fi
DIAG="$ROOTFS/root/.dsh/dsh-app/diagnostics.md"
if [ -f "$DIAG" ]; then
  cp "$DIAG" "$OUT_DIR/dsh-app-diagnostics.md" 2>/dev/null && echo "  已复制 diagnostics.md"
fi
for cand in "$ROOTFS/root/.dsh/logs/dsh.log" "$ROOTFS/root/.dsh/dsh-app/dsh.log"; do
  [ -f "$cand" ] && cp "$cand" "$OUT_DIR/engine-$(basename "$cand")" 2>/dev/null && echo "  已复制 $cand"
done

echo
echo "=== 完成 ==="
echo "日志文件: $LOG_FILE"
echo "打包发回:"
echo "  cd \"$OUT_DIR\" && tar czf dsh-go-plugin-fix-report.tgz dsh-go-plugin-fix-*.log profile-package.json dsh-app-diagnostics.md engine-*.log 2>/dev/null"
echo
echo "接下来：在 DSH Go 里点「启动」，然后看引擎日志还有没有 'skipping profile bundle' / 'failed to import'"
}

main 2>&1 | tee -a "$LOG_FILE"
