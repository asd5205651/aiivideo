#!/bin/sh
# dsh-go 1.0.15 本机引擎：插件兼容修复 v2
# 在 DSH Go 的「终端」里执行（引擎已启动的前提下）
#
# 修两件事：
#   1) @ccch1mneyyy/dsh-media@0.2.1 被跳过：peer 锁死 0.2.1-rc.4，与 dsh 0.2.2-rc.1 不兼容。
#      0.3.1 的 peer 是 "0.2.1-rc.4 || 0.2.2-rc.1" → 升级到 0.3.1。
#   2) @cocofhu/anime-find 导入失败：0.1.12 仍 import installSettingsSection，
#      而 dsh-settings 0.2.2-rc.1 的公开导出里已没有它 → 移除。
#
# 全部输出同时写入「当前文件夹」下的 dsh-go-plugin-fix-<时间戳>.log；
# 结束时把 profile 快照和引擎诊断文件也复制到当前文件夹，方便打包发回。
# 兼容 POSIX sh（不用 bash 的进程替换）。

set -u

CWD_DIR="$(pwd 2>/dev/null || echo "$HOME")"
OUT_DIR="$CWD_DIR"
if ! ( : > "$OUT_DIR/.dsh-go-write-test" ) 2>/dev/null; then
  OUT_DIR="$HOME"
  echo "[!] 当前文件夹不可写，日志改存到 $OUT_DIR"
else
  rm -f "$OUT_DIR/.dsh-go-write-test" 2>/dev/null
fi
STAMP=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo 0)
LOG_FILE="$OUT_DIR/dsh-go-plugin-fix-$STAMP.log"

PROFILE=web
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF_DIR="$DSH_HOME/profiles/$PROFILE"

main() {
echo "=== 环境 ==="
echo "当前文件夹 : $CWD_DIR"
echo "日志文件   : $LOG_FILE"
echo "DSH_HOME   : $DSH_HOME"
echo "profile    : $PROFILE  ($PROF_DIR)"
echo "dsh 版本   : $(dsh --version 2>&1 | head -1)"
echo "node       : $(node --version 2>&1 | head -1)"
echo "whoami     : $(id -un) ($(id -u))"
echo "pwd        : $(pwd)"
echo "时间       : $(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"

echo
echo "=== 修复前：profile 声明的插件 ==="
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
echo "=== 修复前：版本豁免 ==="
dsh plugin --profile "$PROFILE" version-exemptions 2>&1 | sed 's/^/  /'

echo
echo "=== 步骤 1/3：@ccch1mneyyy/dsh-media 0.2.1 -> 0.3.1 ==="
if cd "$PROF_DIR" 2>/dev/null; then
  pnpm remove @ccch1mneyyy/dsh-media 2>&1 | tail -3 | sed 's/^/  /'
  echo "  --- add 0.3.1 ---"
  pnpm add @ccch1mneyyy/dsh-media@0.3.1 2>&1 | tail -25 | sed 's/^/  /'
else
  echo "  !! 进不去 $PROF_DIR"
fi

echo
echo "=== 步骤 2/3：移除 @cocofhu/anime-find ==="
if cd "$PROF_DIR" 2>/dev/null; then
  pnpm remove @cocofhu/anime-find 2>&1 | tail -8 | sed 's/^/  /'
else
  echo "  !! 进不去 $PROF_DIR"
fi

echo
echo "=== 步骤 3/3：校验 ==="
echo "--- 现在的 profile 依赖 ---"
if [ -f "$PROF_DIR/package.json" ]; then
  node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for (const [k,v] of Object.entries(j.dependencies||{})) console.log("  "+k+" = "+v);
' "$PROF_DIR/package.json" 2>&1
fi

echo "--- 实际安装版本 ---"
for p in @ccch1mneyyy/dsh-media @cocofhu/anime-find; do
  f="$PROF_DIR/node_modules/$p/package.json"
  if [ -f "$f" ]; then
    echo "  $p = $(node -e 'console.log(require(process.argv[1]).version)' "$f" 2>/dev/null)"
  else
    echo "  $p = (未安装)"
  fi
done

echo "--- dsh-media peer 是否覆盖当前 dsh 版本 ---"
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
echo "=== 修复后的版本豁免 ==="
dsh plugin --profile "$PROFILE" version-exemptions 2>&1 | sed 's/^/  /'

echo
echo "=== 收集诊断文件到 $OUT_DIR ==="
DIAG="$DSH_HOME/dsh-app/diagnostics.md"
if [ -f "$DIAG" ]; then
  cp "$DIAG" "$OUT_DIR/dsh-app-diagnostics.md" 2>/dev/null && \
    echo "  已复制 diagnostics.md"
else
  echo "  (没有 $DIAG)"
fi
if [ -f "$PROF_DIR/package.json" ]; then
  cp "$PROF_DIR/package.json" "$OUT_DIR/profile-package.json" 2>/dev/null && echo "  已复制 profile-package.json"
fi
for cand in "$DSH_HOME/logs/dsh.log" "$DSH_HOME/dsh-app/dsh.log" "$DSH_HOME/logs/engine.log" "$DSH_HOME/dsh-app/engine.log"; do
  if [ -f "$cand" ]; then
    cp "$cand" "$OUT_DIR/$(basename "$cand")" 2>/dev/null && echo "  已复制 $cand"
  fi
done

echo
echo "=== 插件相关错误行 ==="
for f in "$OUT_DIR"/*.md "$OUT_DIR"/*.log; do
  [ -f "$f" ] || continue
  case "$f" in *"$STAMP"*) continue ;; esac
  HITS=$(grep -nE "skipping profile bundle|failed to import|did not activate|incompatible with dsh" "$f" 2>/dev/null | tail -15)
  if [ -n "$HITS" ]; then
    echo "  --- $f ---"
    echo "$HITS" | sed 's/^/    /'
  fi
done

echo
echo "=== 完成 ==="
echo "日志文件: $LOG_FILE"
echo "打包发回:"
echo "  cd \"$OUT_DIR\" && tar czf dsh-go-plugin-fix-report.tgz dsh-go-plugin-fix-*.log profile-package.json dsh-app-diagnostics.md 2>/dev/null"
echo
echo "接下来：完全退出并重开 DSH Go（或 App 里点一次「停止引擎」再「启动」），"
echo "再看引擎日志里还有没有 'skipping profile bundle' / 'failed to import'。"
}

main 2>&1 | tee -a "$LOG_FILE"
