#!/usr/bin/env bash
# 面板唯一升级入口 —— 以后永远只用这一条：
#   curl -fsSL https://raw.githubusercontent.com/cheesydui-cloud/wg/main/scripts/upgrade-panel.sh | sudo bash
# 或在已 clone 的仓库里：
#   sudo bash scripts/upgrade-panel.sh
#
# 作用：git pull 最新代码 → install.sh --update → 重启 wg-panel
# 保留 /opt/wg-panel/data 与登录密码，不重装系统依赖（除非缺 node）

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行：sudo bash scripts/upgrade-panel.sh"
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/wg-panel}"
SERVICE_NAME="wg-panel"
REPO_URL="${WG_REPO_URL:-https://github.com/cheesydui-cloud/wg.git}"
BRANCH="${WG_BRANCH:-main}"

# 1) 定位带 package.json 的源码目录
SRC=""
if [[ -f "${PWD}/package.json" && -f "${PWD}/install.sh" ]]; then
  SRC="${PWD}"
elif [[ -f "${APP_DIR}/.git/config" && -f "${APP_DIR}/package.json" ]]; then
  SRC="${APP_DIR}"
elif [[ -f "${HOME}/wg/package.json" && -f "${HOME}/wg/install.sh" ]]; then
  SRC="${HOME}/wg"
elif [[ -f /root/wg/package.json && -f /root/wg/install.sh ]]; then
  SRC="/root/wg"
fi

if [[ -z "${SRC}" ]]; then
  # 没有本地仓库：clone 到临时目录再更新
  SRC="$(mktemp -d /tmp/wg-panel-src.XXXXXX)"
  echo "==> 未找到本地仓库，clone ${REPO_URL} → ${SRC}"
  git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${SRC}"
  CLEAN_SRC=1
else
  CLEAN_SRC=0
  echo "==> 使用源码目录: ${SRC}"
  cd "${SRC}"
  if [[ -d .git ]]; then
    echo "==> git fetch / pull (${BRANCH})"
    git fetch --tags origin 2>/dev/null || git fetch --tags 2>/dev/null || true
    git checkout "${BRANCH}" 2>/dev/null || true
    git pull --ff-only origin "${BRANCH}" 2>/dev/null || git pull --ff-only 2>/dev/null || {
      echo "git pull 失败，若你改过本地文件请先处理冲突；或："
      echo "  cd ${SRC} && git status"
      exit 1
    }
  else
    echo "    警告: ${SRC} 不是 git 仓库，将用当前文件执行 --update（可能不是最新）"
  fi
fi

cd "${SRC}"
if [[ ! -f install.sh ]]; then
  echo "找不到 install.sh（SRC=${SRC}）"
  exit 1
fi

BEFORE="?"
if [[ -f "${APP_DIR}/package.json" ]]; then
  BEFORE="$(node -p "require('${APP_DIR}/package.json').version" 2>/dev/null || echo '?')"
fi
echo "==> 当前已安装版本: v${BEFORE}"
echo "==> 执行 install.sh --update → ${APP_DIR}"
bash "${SRC}/install.sh" --update

AFTER="$(node -p "require('${APP_DIR}/package.json').version" 2>/dev/null || echo '?')"
echo ""
echo "============================================"
echo " 面板升级完成: v${BEFORE} → v${AFTER}"
echo " 服务: systemctl status ${SERVICE_NAME}"
echo " 健康: curl -sS http://127.0.0.1:51821/api/health"
echo " 浏览器强刷后看左下角/关于版本号"
echo "============================================"

if [[ "${CLEAN_SRC}" -eq 1 ]]; then
  rm -rf "${SRC}"
fi

# 打印 health 版本
sleep 1
curl -fsS --max-time 5 "http://127.0.0.1:${WG_PORT:-51821}/api/health" 2>/dev/null | head -c 300 || true
echo
