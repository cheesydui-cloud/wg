# WireGuard 配置面板（wg-panel）v1.4

中文、新手友好的 WireGuard **出口管理面板**。

仓库：https://github.com/cheesydui-cloud/wg  
当前版本：**v1.4.1**

**v1.4 核心：单一出口模型** —— 不再「本机一套 + 节点一套」两套客户端/二维码/落地。  
面板可单独部署；真正跑 WireGuard 的只有「当前出口」（本机或远程落地机）。

### v1.4.1

- Endpoint **主机/端口拆分编辑** + CM 快捷填入（外部连接 / 移动入口）
- 只改 Endpoint 不再误标「未应用」；改服务端参数才需要应用/落地
- 改 Endpoint 后强制提示 **删旧隧道并重扫**
- 远程任务状态轮询，完成后自动刷新脏标记
- 诊断页区分 **出网 IP（只读）** 与 **入站 Endpoint**

适合：

- 面板装在管理机，**美国家宽 / CM / VPS** 上落地
- 商家前置入口（外部连接 IP / 移动入口），只允许 WireGuard
- TK 直播等需要家宽出口 IP

---

## 架构（推荐：面板与落地分离）

```
手机 / 官方 WireGuard / 小火箭
        │  UDP → Endpoint（入站）
        ▼
  落地机（美国家宽等）  ←── Agent ──  面板机（仅管理 Web）
  WireGuard + NAT
        │
        ▼
     公网（出口 IP = 家宽）
```

| 角色 | 做什么 |
|------|--------|
| 面板机 | 只跑面板，**不要**当出口 |
| 落地机 | 装 Agent，听 UDP，做 NAT |
| Endpoint | 填落地机**入站**地址，不是面板 IP，不是探测出网 IP |

---

## 五步打通（你的场景）

### 1. 管理机安装面板

```bash
sudo bash install.sh
# 面板端口默认 51821
```

浏览器打开 `http://面板IP:51821`，用安装输出的 `admin` + 密码登录。

### 2. 向导选「另一台落地机」

- 出口位置 → **另一台落地机（推荐）**
- 复制安装命令

### 3. 落地机（美国家宽）root 执行安装命令

```bash
# 面板生成的一行命令，形如：
curl -fsSL "http://面板IP:51821/install-agent.sh" | sudo env WG_PANEL_URL="..." WG_AGENT_TOKEN="..." bash
```

回到面板「出口服务器」，状态应为 **在线**。

### 4. 填入站地址并一键落地

- 监听端口：如 `7901`（商家 UDP 可用段内，勿占 SSH）
- Endpoint：`外部连接IP:7901`（移动网不行再换移动入口）
- 点 **一键落地**（只打到落地机，不会改面板机网络）

### 5. 客户端扫码

- 只在 **客户端** 页添加设备并扫码
- 打开隧道 → **诊断** 看握手
- 浏览器打开 ifconfig.me → 应是 **美国家宽 IP**

升级（保留 data）：

```bash
sudo bash install.sh --update
```

v1.3 → v1.4 自动迁移 state 到 v3。

---

## 导航

| 页面 | 作用 |
|------|------|
| 概览 | 当前出口、快捷落地/应用 |
| 出口服务器 | 模式、Agent 安装、Endpoint/端口 |
| 客户端 | **唯一**二维码入口 |
| 诊断 | 无握手 / 仅发送 / 无 NAT |
| 设置 | 密码 |

---

## Endpoint 填写

| 填这个 | 别填这个 |
|--------|----------|
| 商家「外部连接 IP」:端口 | 面板机 IP |
| 或「移动入口」:端口 | 探测出网 IP（107.x 等） |
| 可用 UDP 端口（如 7901） | 内网 172.16.x.x |

---

## 诊断与落地机命令

```bash
systemctl status wg-agent
wg show
ss -ulnp | grep 7901
tcpdump -n -i any udp port 7901
```

| 现象 | 处理 |
|------|------|
| Agent 离线 | 检查安装命令、面板 URL、落地机出网 |
| 无握手、手机有发送 | UDP 未映射 / Endpoint 错 / 扫错码 |
| 有握手上不了网 | 再点一键落地（NAT） |
| ifconfig.me 是面板 IP | 扫错码或模式仍是本机 |

**SSH TCP 通 ≠ UDP 通。** 商家需放行 WireGuard 的 UDP 端口。

---

## 环境变量

面板：`WG_PORT` `WG_PASSWORD` `WG_ALLOW_APPLY` `WG_DATA_DIR`  
Agent：`WG_PANEL_URL` `WG_AGENT_TOKEN` `WG_AGENT_INTERVAL`

---

## 版本摘要

- **1.4.0** 单一出口；诊断；job 租约；NAT 回写；空 Endpoint 禁止出码；远程落地默认路径
- **1.3.x** 多节点 Agent（双轨）
- **1.2.x** 一键落地
- **1.1 / 1.0** 基础面板

## 许可证

MIT
