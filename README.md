# WireGuard 配置面板（WG Panel）

面向新手的 **中文 WireGuard 服务端管理面板**。可安装在闲置服务器上，用网页管理接口与客户端，自动生成密钥、配置、二维码，并支持一键应用到系统。

仓库地址：https://github.com/cheesydui-cloud/wg  
当前版本：**v1.3.0**

## 功能

- 首次引导：公网地址 → 密钥 → 网段 → 首个客户端
- 服务器设置：端口、Endpoint、DNS、MTU、PostUp/PostDown（自动识别出口网卡）
- 客户端管理：增删改、自动分配 IP、启用/停用、PSK、**在线/握手/流量**
- 导出：客户端 `.conf`、二维码扫码、**批量导出**、服务端配置下载
- 应用配置：预检 → 备份 → 写入 `/etc/wireguard` → `wg-quick` 启动/热重载
- **未应用变更**提醒、一键填公网 IP、登录防爆破、会话持久化
- 密码登录（默认用户名 `admin`）、JSON 备份导入导出、深色/浅色主题
- **v1.1.1** 界面精简：统一布局、减少按钮噪音、更清晰的状态展示
- **v1.2.0** 一键落地：开启转发、NAT、客户端全局代理并查看落地状态
- **v1.3.0** 中心面板 + 边缘 Agent：远程节点安装、远程应用/落地（适配移动入口机器手动 Endpoint）

## 环境要求

- Linux 服务器（推荐 Ubuntu 20.04+ / Debian 11+）
- Node.js 18+（`install.sh` 会自动安装 Node 20）
- `wireguard` / `wireguard-tools`（应用配置时需要，安装脚本会装）
- 应用配置建议 **root** 运行面板
- 开放端口：
  - **TCP 51821**：Web 面板（可改）
  - **UDP 51820**：WireGuard（可改）

---

## 一、从 GitHub 一键安装（推荐）

在 **Ubuntu / Debian** 服务器上执行：

```bash
# 1. 安装 git（若没有）
sudo apt update
sudo apt install -y git

# 2. 拉取仓库
git clone https://github.com/cheesydui-cloud/wg.git
cd wg

# 3. 一键安装（默认用户名 admin，自动生成随机密码）
sudo bash install.sh
```

### 更新到新版本（保留数据与密码）

```bash
cd wg
git pull
sudo bash install.sh
# 或显式：
# sudo bash install.sh --update
```

检测到 `/opt/wg-panel/data/state.json` 时会自动进入**更新模式**，不会重置登录密码。

### 指定登录密码安装

```bash
cd wg
sudo WG_PASSWORD='你的强密码' bash install.sh
```

### 自定义面板端口 / 安装目录

```bash
cd wg
sudo APP_DIR=/opt/wg-panel WG_PORT=51821 WG_UDP_PORT=51820 WG_PASSWORD='你的强密码' bash install.sh
```

安装成功后，终端会打印类似信息：

```text
面板地址: http://服务器IP:51821
用户名:   admin
密  码:   xxxxxxxxxxxx
服务状态: systemctl status wg-panel
数据目录: /opt/wg-panel/data
```

浏览器打开该地址，使用 **admin + 终端打印的随机密码** 登录。

忘记密码可查看（仅 root）：

```bash
sudo cat /opt/wg-panel/data/initial-credentials.txt
```

---

## 二、install.sh 会做什么

安装脚本 `install.sh` 会自动完成：

1. 安装系统依赖：`wireguard`、`wireguard-tools`、`iptables`、`curl`
2. 若无 Node.js，安装 **Node.js 20**
3. 把项目部署到 `/opt/wg-panel`（可用 `APP_DIR` 修改）
4. 执行 `npm install --omit=dev`
5. 开启 IPv4 转发：`net.ipv4.ip_forward=1`
6. 创建并启动 systemd 服务：`wg-panel`
7. 若系统有 `ufw`，尝试放行面板 TCP 端口与 WireGuard UDP 端口

相关命令（安装后可用）：

```bash
# 查看服务状态
sudo systemctl status wg-panel

# 启动 / 停止 / 重启
sudo systemctl start wg-panel
sudo systemctl stop wg-panel
sudo systemctl restart wg-panel

# 开机自启（安装脚本已 enable）
sudo systemctl enable wg-panel
sudo systemctl disable wg-panel

# 查看实时日志
sudo journalctl -u wg-panel -f

# 查看最近 100 行日志
sudo journalctl -u wg-panel -n 100 --no-pager
```

---

## 三、从源码手动安装（不使用 install.sh）

```bash
# 1. 克隆
git clone https://github.com/cheesydui-cloud/wg.git
cd wg

# 2. 安装 WireGuard 与转发
sudo apt update
sudo apt install -y wireguard wireguard-tools iptables nodejs npm
# 若 node 版本过旧，建议装 Node 20：
# curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
# sudo apt install -y nodejs

echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-wireguard.conf
sudo sysctl -p /etc/sysctl.d/99-wireguard.conf

# 3. 安装依赖并启动
npm install --omit=dev
sudo WG_PASSWORD='你的强密码' WG_PORT=51821 WG_ALLOW_APPLY=1 npm start
```

### 手动注册 systemd（可选）

```bash
sudo tee /etc/systemd/system/wg-panel.service >/dev/null <<'EOF'
[Unit]
Description=WireGuard Config Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wg-panel
Environment=WG_PORT=51821
Environment=WG_HOST=0.0.0.0
Environment=WG_DATA_DIR=/opt/wg-panel/data
Environment=WG_PASSWORD=请改成你的密码
Environment=WG_ALLOW_APPLY=1
ExecStart=/usr/bin/node /opt/wg-panel/server/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# 先把代码放到 /opt/wg-panel
sudo mkdir -p /opt/wg-panel
sudo rsync -a --exclude node_modules --exclude data ./ /opt/wg-panel/
cd /opt/wg-panel && sudo npm install --omit=dev

sudo systemctl daemon-reload
sudo systemctl enable --now wg-panel
```

---

## 四、本地开发 / 试用（macOS / 本机）

```bash
git clone https://github.com/cheesydui-cloud/wg.git
cd wg
npm install
WG_PASSWORD=changeme WG_ALLOW_APPLY=0 npm start
# 浏览器打开 http://127.0.0.1:51821
```

说明：本机一般没有 root 写 `/etc/wireguard`，可用 `WG_ALLOW_APPLY=0` 只做配置生成；到服务器再用「应用到服务器」。

开发热重载（Node 18+）：

```bash
WG_PASSWORD=changeme npm run dev
```

---

## 五、Docker 部署

需要 **host 网络** 与 `NET_ADMIN` 才能真正操作 WireGuard：

```bash
git clone https://github.com/cheesydui-cloud/wg.git
cd wg

export WG_PASSWORD='你的强密码'
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

或直接用 Docker：

```bash
docker build -t wg-panel .
docker run -d --name wg-panel --network host --cap-add NET_ADMIN --cap-add SYS_MODULE \
  -e WG_PASSWORD='你的强密码' \
  -e WG_PORT=51821 \
  -e WG_ALLOW_APPLY=1 \
  -v "$(pwd)/data:/data" \
  -v /etc/wireguard:/etc/wireguard \
  --sysctl net.ipv4.ip_forward=1 \
  wg-panel
```

---

## 六、环境变量一览

| 变量 | 默认 | 说明 |
|------|------|------|
| `WG_PORT` | `51821` | 面板 HTTP 端口 |
| `WG_HOST` | `0.0.0.0` | 监听地址 |
| `WG_USERNAME` | `admin` | 面板登录用户名（默认 admin） |
| `WG_PASSWORD` | 空 | 首次初始化密码；`install.sh` 未设置时会随机生成 |
| `WG_DATA_DIR` | `./data` | 数据目录（状态、备份配置） |
| `WG_ALLOW_APPLY` | `1` | 是否允许写入系统并操作接口（`0` 关闭） |
| `WG_BIN` | `wg` | `wg` 命令路径 |
| `WG_QUICK_BIN` | `wg-quick` | `wg-quick` 命令路径 |
| `APP_DIR` | `/opt/wg-panel` | 仅 `install.sh`：安装目录 |
| `WG_UDP_PORT` | `51820` | 仅 `install.sh`：防火墙放行的 WG UDP 端口 |

---

## 七、防火墙命令

### ufw

```bash
sudo ufw allow 51820/udp
sudo ufw allow 51821/tcp
sudo ufw reload
sudo ufw status
```

### firewalld

```bash
sudo firewall-cmd --permanent --add-port=51820/udp
sudo firewall-cmd --permanent --add-port=51821/tcp
sudo firewall-cmd --reload
```

### iptables（示例）

```bash
sudo iptables -A INPUT -p udp --dport 51820 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 51821 -j ACCEPT
```

---

## 八、使用流程（新手）

1. 打开面板：`http://服务器IP:51821`，设置/输入密码  
2. 按引导填写 **公网 IP:端口**（Endpoint），例如 `203.0.113.10:51820`  
3. 确认网段（默认 `10.8.0.1/24`），可选启用 NAT  
4. 创建客户端 → 手机 WireGuard App **扫码** 或下载 `.conf`  
5. 点 **应用到服务器**  
6. 确认防火墙已放行 UDP（WireGuard）与 TCP（面板）  

### 开启 IP 转发（若未用安装脚本）

```bash
echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-wireguard.conf
sudo sysctl -p /etc/sysctl.d/99-wireguard.conf
```

### NAT 网卡名

PostUp 模板里的 `eth0` 请改成真实出口网卡：

```bash
ip route | grep default
# 示例：default via x.x.x.x dev ens3  → 把 eth0 改成 ens3
```

### 手动应用配置（面板无 root 时）

在面板下载服务端配置后：

```bash
sudo cp wg0.conf /etc/wireguard/wg0.conf
sudo chmod 600 /etc/wireguard/wg0.conf
sudo wg-quick up wg0

# 开机自启
sudo systemctl enable wg-quick@wg0

# 查看状态
sudo wg show
sudo wg-quick down wg0   # 关闭
```

---

## 九、常用运维命令速查

```bash
# ---- 面板 ----
sudo systemctl status wg-panel
sudo systemctl restart wg-panel
sudo journalctl -u wg-panel -f

# ---- WireGuard 接口 ----
sudo wg show
sudo wg show wg0
sudo wg-quick up wg0
sudo wg-quick down wg0
sudo systemctl enable wg-quick@wg0

# ---- 配置文件 ----
sudo ls -l /etc/wireguard/
sudo cat /etc/wireguard/wg0.conf
sudo less /opt/wg-panel/data/state.json

# ---- 更新面板（从 GitHub 拉新版本）----
cd /path/to/wg          # 或重新 clone
git pull
sudo bash install.sh    # 会重新同步到 /opt/wg-panel 并重启服务
```

### 卸载（可选）

```bash
sudo systemctl disable --now wg-panel
sudo rm -f /etc/systemd/system/wg-panel.service
sudo systemctl daemon-reload
# 可选：删除程序与数据
# sudo rm -rf /opt/wg-panel
# 可选：关闭 WG 接口
# sudo wg-quick down wg0
```

---

## 十、安全建议

- 使用强密码，并限制面板端口仅自己可访问（防火墙 / 安全组 / SSH 隧道）
- 私钥与备份 JSON 不要发到公共网络
- 生产环境建议面板仅监听内网，或前面加 Nginx/Caddy 与 HTTPS
- 云厂商安全组需同时放行 **UDP 51820** 与 **TCP 51821**

SSH 隧道仅本机访问面板示例：

```bash
ssh -L 51821:127.0.0.1:51821 user@服务器IP
# 浏览器打开 http://127.0.0.1:51821
```

---

## 目录结构

```
wg/
├── server/              # Node 后端
│   ├── index.js         # HTTP API
│   ├── wg-manager.js    # 配置生成与应用
│   ├── crypto-wg.js     # 密钥生成
│   ├── auth.js          # 登录会话
│   └── config.js        # 环境与持久化
├── public/              # 中文前端面板
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── data/                # 运行时数据（自动生成，不入库）
├── install.sh           # Ubuntu/Debian 一键安装
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

## License

MIT


## 节点 / Agent（远程落地）

面板可以装在一台机器上，把 **WireGuard 落地** 放到另一台（例如带移动入口的 CM）。

1. 面板升级到 v1.3.0+ 后打开 **节点** 页 → **添加节点**
2. 复制安装命令，在**落地服务器**用 root 执行
3. 节点显示在线后，填写 Endpoint（有移动入口时填外部连接 IP 或移动入口 IP + 可用端口，如 `114.111.176.37:7901` / `211.x.x.x:7901`，端口范围以商家为准，勿用探测出口 IP）
4. 添加客户端 → **远程应用** 或 **远程落地**
5. 手机重新扫码连接

本机 WG 仍在 **本机** 页管理；节点是独立配置与密钥空间。

