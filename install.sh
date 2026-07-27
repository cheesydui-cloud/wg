#!/usr/bin/env bash
set -euo pipefail

# WireGuard 配置面板一键安装（Debian/Ubuntu）
# 用法：sudo bash install.sh

APP_DIR="${APP_DIR:-/opt/wg-panel}"
PANEL_PORT="${WG_PORT:-51821}"
WG_PORT_UDP="${WG_UDP_PORT:-51820}"
SERVICE_NAME="wg-panel"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash install.sh"
  exit 1
fi

echo "==> 安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates wireguard wireguard-tools iptables

if ! command -v node >/dev/null 2>&1; then
  echo "==> 安装 Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> 部署面板到 ${APP_DIR}"
mkdir -p "${APP_DIR}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude node_modules --exclude data --exclude .git \
      "${SCRIPT_DIR}/" "${APP_DIR}/"
  else
    find "${APP_DIR}" -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +
    cp -a "${SCRIPT_DIR}/." "${APP_DIR}/"
    rm -rf "${APP_DIR}/node_modules" 2>/dev/null || true
  fi
else
  echo "未找到项目文件，请在项目目录执行 install.sh"
  exit 1
fi

mkdir -p "${APP_DIR}/data"
cd "${APP_DIR}"
npm install --omit=dev

echo "==> 开启 IPv4 转发"
cat >/etc/sysctl.d/99-wireguard.conf <<EOF
net.ipv4.ip_forward=1
EOF
sysctl -p /etc/sysctl.d/99-wireguard.conf >/dev/null || true

if [[ -z "${WG_PASSWORD:-}" ]]; then
  WG_PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 12)"
  GEN_PASS=1
else
  GEN_PASS=0
fi

echo "==> 创建 systemd 服务"
cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=WireGuard Config Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=WG_PORT=${PANEL_PORT}
Environment=WG_HOST=0.0.0.0
Environment=WG_DATA_DIR=${APP_DIR}/data
Environment=WG_PASSWORD=${WG_PASSWORD}
Environment=WG_ALLOW_APPLY=1
ExecStart=/usr/bin/node ${APP_DIR}/server/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ${SERVICE_NAME}

if command -v ufw >/dev/null 2>&1; then
  ufw allow "${PANEL_PORT}/tcp" || true
  ufw allow "${WG_PORT_UDP}/udp" || true
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "============================================"
echo " 安装完成！"
echo " 面板地址: http://${IP:-服务器IP}:${PANEL_PORT}"
if [[ "${GEN_PASS}" -eq 1 ]]; then
  echo " 初始密码: ${WG_PASSWORD}"
  echo " （请登录后立即修改密码）"
else
  echo " 密码: 使用你设置的 WG_PASSWORD"
fi
echo " 服务管理: systemctl status ${SERVICE_NAME}"
echo " 数据目录: ${APP_DIR}/data"
echo "============================================"
