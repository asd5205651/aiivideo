#!/bin/sh
# dsh-go 1.0.15 本机引擎：插件兼容修复
# 在 DSH Go 的「终端」里执行（引擎已启动的前提下）
#
# 修两件事：
#   1) @ccch1mneyyy/dsh-media@0.2.1 被跳过：它 peer 依赖锁死 0.2.1-rc.4，
#      与 dsh 0.2.2-rc.1 不兼容。0.3.1 同时支持 0.2.1-rc.4 || 0.2.2-rc.1 → 升级到 0.3.1。
#   2) @cocofhu/anime-find 导入失败：0.1.12 仍 import installSettingsSection，
#      而 dsh-settings 0.2.2-rc.1 不再导出它 → 移除该插件（或换用你已有的 dsh-go-animegarden）。
#
# 只改手机本地引擎的 profile，不碰 VPS。
set -u

PROFILE=web
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROF_DIR="$DSH_HOME/profiles/$PROFILE"

echo "=== 环境 ==="
echo "DSH_HOME   : $DSH_HOME"
echo "profile    : $PROFILE  ($PROF_DIR)"
echo "dsh 版本   : $(dsh --version 2>&1 | head -1)"
echo "node       : $(node --version 2>&1 | head -1)"
echo "whoami     : $(id -un) ($(id -u))"
echo

echo "=== 修复前：profile 里声明的插件 ==="
if [ -f "$PROF_DIR/package.json" ]; then
  node -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
console.log("dependencies:");
for (const [k,v] of Object.entries(j.dependencies||{})) console.log("  "+k+" = "+v);
' "$PROF_DIR/package.json" 2>&1
else
  echo "  !! 找不到 $PROF_DIR/package.json"
fi
echo

echo "=== 修复前：版本豁免 ==="
dsh plugin --profile "$PROFILE" version-exemptions 2>&1 | sed 's/^/  /'
echo

# ---------- 1) dsh-media 升到 0.3.1 ----------
echo "=== 步骤 1/3：@ccch1mneyyy/dsh-media 0.2.1 -> 0.3.1 ==="
cd "$PROF_DIR" 2>/dev/null || { echo "  !! 进不去 $PROF_DIR"; exit 1; }
if pnpm remove @ccch1mneyyy/dsh-media >/dev/null 2>&1; then
  echo "  已移除旧版"
else
  echo "  (移除旧版跳过，直接尝试装新版)"
fi
if pnpm add @ccch1mneyyy/dsh-media@0.3.1 2>&1 | tail -20 | sed 's/^/  /'; then
  echo "  0.3.1 安装命令已执行"
else
  echo "  !! pnpm add 失败"
fi
echo

# ---------- 2) anime-find 移除 ----------
echo "=== 步骤 2/3：移除 @cocofhu/anime-find（与 dsh 0.2.2-rc.1 不兼容） ==="
if pnpm remove @cocofhu/anime-find 2>&1 | tail -10 | sed 's/^/  /'; then
  echo "  移除命令已执行"
else
  echo "  (可能本来就没装，忽略)"
fi
echo

# ---------- 3) 校验 ----------
echo "=== 步骤 3/3：校验 ==="
echo "--- 当前 profile 依赖 ---"
node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for (const [k,v] of Object.entries(j.dependencies||{})) console.log("  "+k+" = "+v);
' "$PROF_DIR/package.json" 2>&1
echo
echo "--- 实际安装的版本 ---"
for p in @ccch1mneyyy/dsh-media @cocofhu/anime-find; do
  d="$PROF_DIR/node_modules/$p"
  if [ -f "$d/package.json" ]; then
    echo "  $p = $(node -e 'console.log(require(process.argv[1]).version)' "$d/package.json" 2>/dev/null)"
  else
    echo "  $p = (未安装)"
  fi
done
echo
echo "--- dsh-media 的 peer 依赖是否覆盖当前 dsh ---"
if [ -f "$PROF_DIR/node_modules/@ccch1mneyyy/dsh-media/package.json" ]; then
  node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const peers=j.peerDependencies||{};
const cur=process.argv[2];
let bad=[];
for (const [k,v] of Object.entries(peers)) {
  if (!k.startsWith("@deepseek-ai/dsh-")) continue;
  const opts=String(v).split("||").map(s=>s.trim());
  if (!opts.includes(cur)) bad.push(k+" 要求 "+v);
}
console.log("  当前 dsh:", cur);
console.log(bad.length? "  !! 不匹配: "+bad.join("; ") : "  ✔ 全部匹配");
' "$PROF_DIR/node_modules/@ccch1mneyyy/dsh-media/package.json" "$(dsh --version 2>&1 | head -1 | sed 's/^v//')" 2>&1
fi
echo

echo "=== 全部完成 ==="
echo "接下来：完全退出并重开 DSH Go（或在 App 里点一次「停止引擎」再「启动」），"
echo "然后看引擎日志里还有没有 'skipping profile bundle' / 'failed to import'。"
echo
echo "诊断日志在: \$DSH_HOME/dsh-app/diagnostics.md"
