#!/usr/bin/env bash
set -euo pipefail

# WireGuard 边缘 Agent 安装脚本（在「落地服务器 / 美国家宽」上执行）
# 用法（由面板生成）：
#   curl -fsSL "http://面板地址:51821/install-agent.sh" | sudo env \
#     WG_PANEL_URL="http://面板地址:51821" \
#     WG_AGENT_TOKEN="节点token" \
#     WG_AGENT_NAME="落地出口" \
#     bash

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 root 运行"
  exit 1
fi

PANEL_URL="${WG_PANEL_URL:-}"
TOKEN="${WG_AGENT_TOKEN:-}"
NAME="${WG_AGENT_NAME:-node}"
APP_DIR="${WG_AGENT_DIR:-/opt/wg-agent}"
SERVICE_NAME="wg-agent"

if [[ -z "${PANEL_URL}" || -z "${TOKEN}" ]]; then
  echo "需要环境变量 WG_PANEL_URL 与 WG_AGENT_TOKEN"
  echo "请在面板「出口服务器」页复制安装命令"
  exit 1
fi

PANEL_URL="${PANEL_URL%/}"

echo "==> 检查面板连通性"
if curl -fsS --max-time 8 "${PANEL_URL}/api/health" >/dev/null 2>&1; then
  echo "    面板可访问: ${PANEL_URL}"
else
  echo "    警告: 无法访问 ${PANEL_URL}/api/health"
  echo "    请确认落地机出网、面板防火墙放行、地址写对（含端口）"
  echo "    仍继续安装…"
fi

echo "==> 安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y curl ca-certificates wireguard wireguard-tools iptables openssl
  if ! command -v node >/dev/null 2>&1; then
    echo "==> 安装 Node.js 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl ca-certificates wireguard-tools iptables openssl
  if ! command -v node >/dev/null 2>&1; then
    echo "请先安装 Node.js 18+"
    exit 1
  fi
else
  echo "未识别的包管理器，请手动安装 node / wireguard-tools / iptables"
fi

NODE_BIN="$(command -v node)"
echo "    Node: ${NODE_BIN} ($("${NODE_BIN}" -v))"

echo "==> 从面板下载 agent"
mkdir -p "${APP_DIR}"
curl -fsSL -H "Authorization: Bearer ${TOKEN}" \
  "${PANEL_URL}/api/agent/download" \
  -o "${APP_DIR}/index.js"
chmod 755 "${APP_DIR}/index.js"

cat > "${APP_DIR}/package.json" <<EOF
{
  "name": "wg-agent",
  "version": "1.4.0",
  "private": true,
  "main": "index.js"
}
EOF

mkdir -p /var/lib/wg-agent /etc/wg-agent
cat > /etc/wg-agent/agent.env <<EOF
WG_PANEL_URL=${PANEL_URL}
WG_AGENT_TOKEN=${TOKEN}
WG_AGENT_NAME=${NAME}
WG_AGENT_INTERVAL=10
WG_AGENT_DATA=/var/lib/wg-agent
EOF
chmod 600 /etc/wg-agent/agent.env

echo "==> 配置 systemd"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=WireGuard Panel Edge Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/wg-agent/agent.env
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/index.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"
sleep 2

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo ""
  echo "=========================================="
  echo "  Agent 已安装并运行 (v1.4.0)"
  echo "  名称: ${NAME}"
  echo "  面板: ${PANEL_URL}"
  echo "  服务: systemctl status ${SERVICE_NAME}"
  echo "=========================================="
  echo "回到面板「出口服务器」确认状态为「在线」。"
  echo "然后填写 Endpoint（入站 IP:UDP端口）→ 一键落地 → 客户端扫码。"
  echo ""
  echo "重要：商家需放行 WireGuard 的 UDP 端口（如 7901）。"
  echo "      SSH 的 TCP 通 ≠ UDP 通。仅发送无握手时先查 UDP 映射。"
else
  echo "服务未成功启动，请查看："
  echo "  journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  exit 1
fi
