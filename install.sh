#!/usr/bin/env bash
set -euo pipefail

# WireGuard 配置面板一键安装（Debian/Ubuntu）
# 用法：
#   sudo bash install.sh
#   sudo WG_PASSWORD='你的密码' bash install.sh
#
# 默认登录用户名：admin
# 未指定 WG_PASSWORD 时自动生成随机密码，并打印在终端

APP_DIR="${APP_DIR:-/opt/wg-panel}"
PANEL_PORT="${WG_PORT:-51821}"
WG_PORT_UDP="${WG_UDP_PORT:-51820}"
SERVICE_NAME="wg-panel"
DEFAULT_USER="${WG_USERNAME:-admin}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash install.sh"
  exit 1
fi

echo "==> 安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates wireguard wireguard-tools iptables openssl

if ! command -v node >/dev/null 2>&1; then
  echo "==> 安装 Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
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

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules --exclude data --exclude .git \
    "${SCRIPT_DIR}/" "${APP_DIR}/"
else
  find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
  cp -a "${SCRIPT_DIR}/." "${APP_DIR}/"
  rm -rf "${APP_DIR}/node_modules" 2>/dev/null || true
fi

mkdir -p "${APP_DIR}/data"
cd "${APP_DIR}"
echo "==> 安装 npm 依赖"
npm install --omit=dev

echo "==> 开启 IPv4 转发"
mkdir -p /etc/sysctl.d
cat >/etc/sysctl.d/99-wireguard.conf <<'EOF'
net.ipv4.ip_forward=1
EOF
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
sysctl --system >/dev/null 2>&1 || true

# 生成随机密码（避免 tr|head 在 pipefail 下 SIGPIPE 中断安装）
if [[ -z "${WG_PASSWORD:-}" ]]; then
  WG_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-12)"
  GEN_PASS=1
else
  GEN_PASS=0
fi

ENV_FILE="/etc/default/${SERVICE_NAME}"
cat >"${ENV_FILE}" <<EOF
WG_PORT=${PANEL_PORT}
WG_HOST=0.0.0.0
WG_DATA_DIR=${APP_DIR}/data
WG_USERNAME=${DEFAULT_USER}
WG_PASSWORD=${WG_PASSWORD}
WG_ALLOW_APPLY=1
EOF
chmod 600 "${ENV_FILE}"

# 把账号密码也写一份到 data，方便用户找回（权限仅 root）
CRED_FILE="${APP_DIR}/data/initial-credentials.txt"
cat >"${CRED_FILE}" <<EOF
username=${DEFAULT_USER}
password=${WG_PASSWORD}
created_at=$(date -Iseconds 2>/dev/null || date)
panel_port=${PANEL_PORT}
EOF
chmod 600 "${CRED_FILE}"

echo "==> 创建 systemd 服务"
cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=WireGuard Config Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${APP_DIR}/server/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ${SERVICE_NAME}

sleep 1
if ! systemctl is-active --quiet ${SERVICE_NAME}; then
  echo "!! 服务启动失败，最近日志："
  journalctl -u ${SERVICE_NAME} -n 40 --no-pager || true
  exit 1
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow "${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
  ufw allow "${WG_PORT_UDP}/udp" >/dev/null 2>&1 || true
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "============================================"
echo " 安装完成！"
echo " 面板地址: http://${IP:-服务器IP}:${PANEL_PORT}"
echo " 用户名:   ${DEFAULT_USER}"
echo " 密  码:   ${WG_PASSWORD}"
if [[ "${GEN_PASS}" -eq 1 ]]; then
  echo " （随机密码，请立即保存；也可查看 ${CRED_FILE}）"
else
  echo " （来自 WG_PASSWORD 环境变量）"
fi
echo " 服务状态: systemctl status ${SERVICE_NAME}"
echo " 查看日志: journalctl -u ${SERVICE_NAME} -f"
echo " 数据目录: ${APP_DIR}/data"
echo "============================================"
