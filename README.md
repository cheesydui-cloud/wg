# WireGuard 配置面板（WG Panel）

面向新手的 **中文 WireGuard 服务端管理面板**。可安装在闲置服务器上，用网页管理接口与客户端，自动生成密钥、配置、二维码，并支持一键应用到系统。

## 功能

- 首次引导：公网地址 → 密钥 → 网段 → 首个客户端
- 服务器设置：端口、Endpoint、DNS、MTU、PostUp/PostDown（NAT 模板）
- 客户端管理：增删改、自动分配 IP、启用/停用、PSK
- 导出：客户端 `.conf`、二维码扫码、服务端配置下载
- 应用配置：写入 `/etc/wireguard/*.conf` 并 `wg-quick` 启动/热重载
- 密码登录、JSON 备份导入导出、深色/浅色主题

## 环境要求

- Linux 服务器（推荐 Ubuntu 20.04+ / Debian 11+）
- Node.js 18+（安装脚本会自动装 Node 20）
- `wireguard` / `wireguard-tools`（应用配置时需要，安装脚本会装）
- 应用配置建议 **root** 运行面板

## 快速安装（推荐）

把整个项目上传到服务器后：

```bash
cd /path/to/wg
sudo bash install.sh
```

安装完成后终端会打印：

- 面板地址：`http://服务器IP:51821`
- 初始密码（若未设置 `WG_PASSWORD` 环境变量会自动生成）

自定义密码安装：

```bash
sudo WG_PASSWORD='你的强密码' bash install.sh
```

## 手动运行（开发/试用）

```bash
cd /path/to/wg
npm install
WG_PASSWORD=changeme npm start
# 浏览器打开 http://127.0.0.1:51821
```

可选环境变量：

| 变量 | 默认 | 说明 |
|------|------|------|
| `WG_PORT` | `51821` | 面板 HTTP 端口 |
| `WG_HOST` | `0.0.0.0` | 监听地址 |
| `WG_PASSWORD` | 空 | 首次初始化密码 |
| `WG_DATA_DIR` | `./data` | 数据目录 |
| `WG_ALLOW_APPLY` | `1` | 是否允许写入系统并操作接口 |
| `WG_BIN` / `WG_QUICK_BIN` | `wg` / `wg-quick` | 命令路径 |

## Docker 部署

需要 host 网络与 `NET_ADMIN` 才能真正操作 WireGuard：

```bash
export WG_PASSWORD='你的密码'
docker compose up -d --build
```

## 使用流程（新手）

1. 打开面板，设置/输入密码  
2. 按引导填写 **公网 IP:端口**（Endpoint）  
3. 确认网段（默认 `10.8.0.1/24`），可选启用 NAT  
4. 创建客户端 → 手机 WireGuard App **扫码** 或下载 `.conf`  
5. 点 **应用到服务器**  
6. 防火墙放行：
   - `UDP 51820`（WireGuard，若你改过端口则用你的端口）
   - `TCP 51821`（面板）

### 开启转发（若未用安装脚本）

```bash
echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-wireguard.conf
sudo sysctl -p /etc/sysctl.d/99-wireguard.conf
```

### NAT 注意

PostUp 模板里的 `eth0` 请改成真实出口网卡，可查看：

```bash
ip route | grep default
```

## 服务管理

```bash
sudo systemctl status wg-panel
sudo systemctl restart wg-panel
sudo journalctl -u wg-panel -f
```

## 安全建议

- 使用强密码，并限制面板端口仅自己可访问（防火墙 / VPN / SSH 隧道）
- 私钥与备份 JSON 不要发到公共网络
- 生产环境建议面板仅监听内网，或前面加反向代理与 HTTPS

## 目录结构

```
wg/
├── server/           # Node 后端
│   ├── index.js      # HTTP API
│   ├── wg-manager.js # 配置生成与应用
│   ├── crypto-wg.js  # 密钥生成
│   ├── auth.js
│   └── config.js
├── public/           # 中文前端面板
├── data/             # 运行时数据（自动生成）
├── install.sh
├── Dockerfile
└── docker-compose.yml
```

## 说明

- 面板负责生成与管理配置；真正连上 VPN 仍依赖系统 WireGuard。
- 若「应用到服务器」因权限失败，可在面板下载配置后手动：

```bash
sudo cp wg0.conf /etc/wireguard/wg0.conf
sudo chmod 600 /etc/wireguard/wg0.conf
sudo wg-quick up wg0
```

## License

MIT
