#!/usr/bin/env bash
set -euo pipefail

# mieru 边缘 Agent 安装脚本（在「落地服务器 / 美国家宽」上执行）
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
  echo "请在面板「落地」页复制安装命令"
  exit 1
fi

PANEL_URL="${PANEL_URL%/}"
# 去掉可能误粘贴的空白
TOKEN="$(printf '%s' "${TOKEN}" | tr -d '[:space:]')"
NAME="$(printf '%s' "${NAME}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
[[ -n "${NAME}" ]] || NAME="node"

shell_quote() {
  # 安全写入 EnvironmentFile / 脚本
  printf "%s" "$1" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/"
}

echo "==> 检查面板连通性"
HEALTH_CODE="$(curl -sS -o /tmp/wg-panel-health.json -w '%{http_code}' --max-time 10 \
  "${PANEL_URL}/api/health" 2>/tmp/wg-panel-health.err || true)"
if [[ "${HEALTH_CODE}" == "200" ]]; then
  echo "    面板可访问: ${PANEL_URL} (HTTP 200)"
  if command -v head >/dev/null 2>&1; then
    head -c 200 /tmp/wg-panel-health.json 2>/dev/null | tr '\n' ' ' || true
    echo
  fi
else
  echo "    警告: 无法正常访问 ${PANEL_URL}/api/health (HTTP ${HEALTH_CODE:-000})"
  if [[ -s /tmp/wg-panel-health.err ]]; then
    echo "    curl: $(head -c 300 /tmp/wg-panel-health.err | tr '\n' ' ')"
  fi
  if [[ -s /tmp/wg-panel-health.json ]]; then
    echo "    body: $(head -c 200 /tmp/wg-panel-health.json | tr '\n' ' ')"
  fi
  echo "    请确认："
  echo "      1) 落地机能否访问面板公网 IP:端口（不是内网 IP）"
  echo "      2) 面板机防火墙/安全组放行 TCP 51821"
  echo "      3) 面板进程在跑：ss -lntp | grep 51821"
  echo "    仍继续安装（若后续下载 agent 失败则会中止）…"
fi

echo "==> 安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y curl ca-certificates openssl
  # wireguard/iptables 可选；mita 不强制
  apt-get install -y wireguard wireguard-tools iptables 2>/dev/null || true
  if ! command -v node >/dev/null 2>&1; then
    echo "==> 安装 Node.js 20"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl ca-certificates openssl
  yum install -y wireguard-tools iptables 2>/dev/null || true
  if ! command -v node >/dev/null 2>&1; then
    echo "请先安装 Node.js 18+"
    exit 1
  fi
else
  echo "未识别的包管理器，请手动安装 node / curl"
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_VER="$("${NODE_BIN}" -v 2>/dev/null || true)"
echo "    Node: ${NODE_BIN} (${NODE_VER})"
# 要求 Node >= 18
NODE_MAJOR="$(echo "${NODE_VER}" | sed -n 's/^v\([0-9]*\).*/\1/p')"
if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt 18 ]]; then
  echo "Node.js 版本过旧（需要 18+），当前: ${NODE_VER}"
  exit 1
fi

echo "==> 从面板下载 agent"
mkdir -p "${APP_DIR}"
DL_CODE="$(curl -sS -o "${APP_DIR}/index.js" -w '%{http_code}' --max-time 60 \
  -H "Authorization: Bearer ${TOKEN}" \
  "${PANEL_URL}/api/agent/download" 2>/tmp/wg-agent-dl.err || true)"
if [[ "${DL_CODE}" != "200" ]]; then
  echo "下载 agent 失败 HTTP ${DL_CODE:-000}"
  [[ -s /tmp/wg-agent-dl.err ]] && cat /tmp/wg-agent-dl.err
  head -c 300 "${APP_DIR}/index.js" 2>/dev/null || true
  echo
  echo "常见原因：落地机访问不了面板、Token 错误/已轮换、面板未启动"
  exit 1
fi
# 校验是 JS 而不是 HTML/JSON 错误页
if ! head -c 80 "${APP_DIR}/index.js" | grep -qE 'node|mieru|agent|require'; then
  echo "下载内容不像 agent 脚本，前 120 字节："
  head -c 120 "${APP_DIR}/index.js"; echo
  exit 1
fi
chmod 755 "${APP_DIR}/index.js"

# 语法检查，避免装上就崩
if ! "${NODE_BIN}" --check "${APP_DIR}/index.js" 2>/tmp/wg-agent-syntax.err; then
  echo "agent 脚本语法错误："
  cat /tmp/wg-agent-syntax.err
  exit 1
fi

cat > "${APP_DIR}/package.json" <<EOF
{
  "name": "wg-agent",
  "version": "4.2.0",
  "private": true,
  "main": "index.js"
}
EOF

mkdir -p /var/lib/wg-agent /etc/wg-agent
# systemd EnvironmentFile：值用双引号，避免中文名/特殊字符导致服务起不来
cat > /etc/wg-agent/agent.env <<EOF
WG_PANEL_URL="${PANEL_URL}"
WG_AGENT_TOKEN="${TOKEN}"
WG_AGENT_NAME="${NAME}"
WG_AGENT_INTERVAL=10
WG_AGENT_DATA=/var/lib/wg-agent
EOF
chmod 600 /etc/wg-agent/agent.env

echo "==> 配置 systemd"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=mieru Panel Edge Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-/etc/wg-agent/agent.env
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/index.js
Restart=always
RestartSec=5
LimitNOFILE=65535
# 保证能找到 node 依赖的动态库
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE_NAME}"
sleep 2

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo ""
  echo "=========================================="
  echo "  Agent 已安装并运行"
  echo "  名称: ${NAME}"
  echo "  面板: ${PANEL_URL}"
  echo "  服务: systemctl status ${SERVICE_NAME}"
  echo "=========================================="
  echo "回到面板「落地」确认「在线」。"
  echo "填家宽可达地址 → 拓扑生成 IX 转发 → 一键落地（装 mita）→ 应用配置。"
  echo ""
else
  echo "服务未成功启动。最近日志："
  journalctl -u "${SERVICE_NAME}" -n 40 --no-pager || true
  echo ""
  echo "手动试跑（便于看报错）："
  echo "  set -a; source /etc/wg-agent/agent.env; set +a"
  echo "  ${NODE_BIN} ${APP_DIR}/index.js"
  exit 1
fi
