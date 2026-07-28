#!/usr/bin/env bash
set -euo pipefail

# mieru 出口面板一键安装 / 更新（Debian/Ubuntu）
# 用法：
#   sudo bash install.sh
#   sudo WG_PASSWORD='你的密码' bash install.sh
#   sudo bash install.sh --update
#   sudo bash install.sh --reset-password '新密码'
#
# 默认登录用户名：admin
# v4.0：多 IX · 多落地 · 用户路由 · 流量/期限；路径 客户端 → 商家IX前置 → IX → 落地家宽 mita
# WireGuard 见 tag v1.4.1
# 未指定 WG_PASSWORD 且首次安装时自动生成随机密码
# --update 不会改登录密码；忘记密码请用 --reset-password

APP_DIR="${APP_DIR:-/opt/wg-panel}"
PANEL_PORT="${WG_PORT:-51821}"
WG_PORT_UDP="${WG_UDP_PORT:-51820}"
SERVICE_NAME="wg-panel"
DEFAULT_USER="${WG_USERNAME:-admin}"
UPDATE_MODE=0
RESET_PASSWORD=""

args=("$@")
i=0
while [[ $i -lt ${#args[@]} ]]; do
  arg="${args[$i]}"
  case "$arg" in
    --update|-u) UPDATE_MODE=1 ;;
    --reset-password|--set-password)
      i=$((i + 1))
      RESET_PASSWORD="${args[$i]:-}"
      if [[ -z "${RESET_PASSWORD}" ]]; then
        echo "用法: sudo bash install.sh --reset-password '新密码'"
        exit 1
      fi
      ;;
    --help|-h)
      echo "用法: sudo bash install.sh [--update] [--reset-password 新密码]"
      echo "  --update              更新代码，保留 data 与已有密码"
      echo "  --reset-password P    重置登录密码为 P（至少 6 位）并重启服务"
      exit 0
      ;;
  esac
  i=$((i + 1))
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash install.sh"
  exit 1
fi

# 仅重置密码：不重装
if [[ -n "${RESET_PASSWORD}" && "${UPDATE_MODE}" -eq 0 && ! -f "${APP_DIR}/package.json" ]]; then
  :
fi
if [[ -n "${RESET_PASSWORD}" ]]; then
  STATE_JSON="${APP_DIR}/data/state.json"
  if [[ ! -f "${STATE_JSON}" ]]; then
    echo "未找到 ${STATE_JSON}，请先安装面板"
    exit 1
  fi
  if [[ ${#RESET_PASSWORD} -lt 6 ]]; then
    echo "密码至少 6 位"
    exit 1
  fi
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  RESET_JS=""
  if [[ -f "${APP_DIR}/scripts/reset-password.js" ]]; then
    RESET_JS="${APP_DIR}/scripts/reset-password.js"
  elif [[ -f "${SCRIPT_DIR}/scripts/reset-password.js" ]]; then
    RESET_JS="${SCRIPT_DIR}/scripts/reset-password.js"
  else
    echo "找不到 scripts/reset-password.js"
    exit 1
  fi
  echo "==> 重置面板登录密码"
  node "${RESET_JS}" --data-dir "${APP_DIR}/data" --user "${DEFAULT_USER}" --restart "${RESET_PASSWORD}"
  exit 0
fi

echo "==> 安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
# 有 node 时更新不强制 apt（避免坏掉的 nodesource 403 卡死）
if command -v node >/dev/null 2>&1 && [[ "${UPDATE_MODE}" -eq 1 || -f "${APP_DIR}/data/state.json" ]]; then
  echo "    已有 Node $($(command -v node) -v)，跳过 apt 重装依赖"
else
  # 禁用失效的 NodeSource 源，避免 403 导致整次 update 失败
  if ls /etc/apt/sources.list.d/*nodesource* >/dev/null 2>&1; then
    echo "    发现 NodeSource 源，若 403 将临时禁用"
    for f in /etc/apt/sources.list.d/*nodesource*; do
      [[ -f "$f" ]] || continue
      if ! grep -q 'deb.nodesource.com' "$f" 2>/dev/null; then
        continue
      fi
      # 探测是否可用；失败则改名禁用
      if ! curl -fsSIL --max-time 8 https://deb.nodesource.com/node_20.x/dists/nodistro/InRelease >/dev/null 2>&1; then
        mv "$f" "${f}.disabled-by-wg-panel" 2>/dev/null || true
        echo "    已禁用失效源: $f"
      fi
    done
  fi
  apt-get update -y || echo "    警告: apt-get update 有错误，继续尝试安装基础包"
  apt-get install -y curl ca-certificates iptables openssl || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "==> 安装 Node.js 20"
  if curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; then
    apt-get install -y nodejs
  else
    echo "    NodeSource 不可用，尝试系统源 nodejs"
    apt-get install -y nodejs npm || true
  fi
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "未找到 node，请先安装 Node.js 18+"
  exit 1
fi
echo "    使用 Node: ${NODE_BIN} ($("${NODE_BIN}" -v))"

echo "==> 部署面板到 ${APP_DIR}"
mkdir -p "${APP_DIR}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "${SCRIPT_DIR}/package.json" ]]; then
  echo "未找到项目文件，请在项目目录执行 install.sh"
  exit 1
fi

# 是否已有数据（更新模式自动识别）
EXISTING_STATE="${APP_DIR}/data/state.json"
if [[ -f "${EXISTING_STATE}" ]]; then
  UPDATE_MODE=1
  echo "    检测到已有数据，进入更新模式（保留 data 与登录密码）"
fi

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules --exclude data --exclude .git \
    "${SCRIPT_DIR}/" "${APP_DIR}/"
else
  find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  cp -a "${SCRIPT_DIR}/." "${APP_DIR}/"
  rm -rf "${APP_DIR}/node_modules" 2>/dev/null || true
fi

mkdir -p "${APP_DIR}/data" "${APP_DIR}/data/backups"
cd "${APP_DIR}"
echo "==> 安装 npm 依赖"
npm install --omit=dev

echo "==> 开启 IPv4 转发（mita 出站可选）"
mkdir -p /etc/sysctl.d
cat >/etc/sysctl.d/99-mieru-panel.conf <<'EOF'
net.ipv4.ip_forward=1
EOF
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
sysctl --system >/dev/null 2>&1 || true

ENV_FILE="/etc/default/${SERVICE_NAME}"
GEN_PASS=0
SHOW_CRED=0

if [[ "${UPDATE_MODE}" -eq 1 && -f "${ENV_FILE}" ]]; then
  # 更新：尽量保留已有环境变量，只刷新端口等可选覆盖
  # shellcheck disable=SC1090
  set -a
  # 读取旧值
  OLD_PASS=""
  OLD_USER="${DEFAULT_USER}"
  if grep -q '^WG_PASSWORD=' "${ENV_FILE}" 2>/dev/null; then
    OLD_PASS="$(grep '^WG_PASSWORD=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
  fi
  if grep -q '^WG_USERNAME=' "${ENV_FILE}" 2>/dev/null; then
    OLD_USER="$(grep '^WG_USERNAME=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
  fi
  set +a
  WG_PASSWORD="${WG_PASSWORD:-$OLD_PASS}"
  DEFAULT_USER="${WG_USERNAME:-$OLD_USER}"
  if [[ -z "${WG_PASSWORD}" ]]; then
    # 已有 state 时不必写入密码（账号已在 data 中）
    WG_PASSWORD=""
  fi
  echo "    已保留原登录配置"
else
  if [[ -z "${WG_PASSWORD:-}" ]]; then
    WG_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-12)"
    GEN_PASS=1
  fi
  SHOW_CRED=1
fi

# 写 EnvironmentFile
{
  echo "WG_PORT=${PANEL_PORT}"
  echo "WG_HOST=0.0.0.0"
  echo "WG_DATA_DIR=${APP_DIR}/data"
  echo "WG_USERNAME=${DEFAULT_USER}"
  if [[ -n "${WG_PASSWORD}" ]]; then
    echo "WG_PASSWORD=${WG_PASSWORD}"
  fi
  echo "WG_ALLOW_APPLY=1"
  # 仅首次安装时提示改密
  if [[ "${SHOW_CRED}" -eq 1 ]]; then
    echo "WG_FORCE_PASSWORD_CHANGE=1"
  fi
} >"${ENV_FILE}"
chmod 600 "${ENV_FILE}"

if [[ "${SHOW_CRED}" -eq 1 ]]; then
  CRED_FILE="${APP_DIR}/data/initial-credentials.txt"
  cat >"${CRED_FILE}" <<EOF
username=${DEFAULT_USER}
password=${WG_PASSWORD}
created_at=$(date -Iseconds 2>/dev/null || date)
panel_port=${PANEL_PORT}
EOF
  chmod 600 "${CRED_FILE}"
fi

echo "==> 创建 / 更新 systemd 服务"
cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=mieru Exit Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=${NODE_BIN} ${APP_DIR}/server/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME} >/dev/null 2>&1 || true
systemctl restart ${SERVICE_NAME}

sleep 1
if ! systemctl is-active --quiet ${SERVICE_NAME}; then
  echo "!! 服务启动失败，最近日志："
  journalctl -u ${SERVICE_NAME} -n 40 --no-pager || true
  exit 1
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow "${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
VER="$(node -p "require('${APP_DIR}/package.json').version" 2>/dev/null || echo '?')"
echo ""
echo "============================================"
if [[ "${UPDATE_MODE}" -eq 1 && "${SHOW_CRED}" -eq 0 ]]; then
  echo " 更新完成！版本 v${VER}（mieru）"
  echo " 面板地址: http://${IP:-服务器IP}:${PANEL_PORT}"
  echo " 登录账号保持不变（data 已保留）"
  echo " 请在落地机重装 Agent，再点「一键落地」安装 mita"
else
  echo " 安装完成！版本 v${VER}（mieru）"
  echo " 面板地址: http://${IP:-服务器IP}:${PANEL_PORT}"
  echo " 用户名:   ${DEFAULT_USER}"
  echo " 密  码:   ${WG_PASSWORD}"
  if [[ "${GEN_PASS}" -eq 1 ]]; then
    echo " （随机密码，请立即保存；也可查看 ${APP_DIR}/data/initial-credentials.txt）"
  fi
fi
echo " 协议: mieru / mita（非 WireGuard）"
echo " 服务状态: systemctl status ${SERVICE_NAME}"
echo " 查看日志: journalctl -u ${SERVICE_NAME} -f"
echo " 数据目录: ${APP_DIR}/data"
echo "============================================"
