# mieru 出口面板 v2.0

中文、新手友好的 **mieru / mita 出口管理面板**。

仓库：https://github.com/cheesydui-cloud/wg  
当前版本：**v2.0.4**

> **v2 起默认协议是 mieru，不再是 WireGuard。**  
> 老板移动前置 + 落地家宽只支持 mieru 时，请用本版本。  
> 最后一版 WireGuard 面板见 tag **v1.4.1**。

---

## 为什么是 mieru

| 线路 | 能用什么 |
|------|----------|
| 老板前置 + 家宽「只支持 mieru」 | **mieru / mita（TCP）** |
| 裸 UDP / 任意端口映射 | 才可考虑 WireGuard（v1.4.x） |

WireGuard 需要端到端 UDP；很多商家前置只转 **TCP / mieru**，所以 v1 扫码不通是线路限制，不是面板「又监听到本机」。

---

## 架构

```
手机（小火箭 / NekoBox / 官方 mieru）
        │  TCP → 前置入站 Endpoint
        ▼
  落地机 mita（美国家宽）  ←── Agent ──  面板（只管理）
        │
        ▼
     公网（出口 IP = 家宽）
```

| 角色 | 做什么 |
|------|--------|
| 面板机 | 只跑 Web 面板 |
| 落地机 | 装 Agent，跑 **mita**，出网 |
| Endpoint | 填**前置入站 IP:TCP端口**，不是出网 IP，不是面板 IP |

落地安装基于 [mieru-OneClick](https://github.com/ike-sh/mieru-OneClick)（仓库内 `scripts/install-mita.sh` / `vendor/mieru-oneclick`）。

---

## 五步打通（老板前置 + 家宽）

### 1. 管理机安装面板

```bash
cd ~/wg   # 或你的安装目录
git pull
sudo bash install.sh --update
# 新装：sudo bash install.sh
```

浏览器打开 `http://面板IP:51821`。

#### 忘记登录密码（不会丢配置）

`--update` **不会**改登录密码。重置：

```bash
cd ~/wg && git pull
sudo bash install.sh --reset-password '你的新密码'
# 或：
sudo node /opt/wg-panel/scripts/reset-password.js --restart '你的新密码'
```

默认用户名 `admin`。凭据也会写到 `/opt/wg-panel/data/initial-credentials.txt`。

### 2. 向导选「另一台落地机」

复制 Agent 安装命令。

### 3. 落地机 root 执行安装命令

回到面板确认 **远程落地 · 在线**。

### 4. 填参数并一键落地

- 协议：**TCP**（推荐）
- 端口：商家可用段，如 `7901`
- 入站 IP：`外部连接IP` 或 `移动入口`（如 114.x / 211.x）
- 点 **一键落地** → 落地机安装/配置 mita

### 5. 客户端

- 打开「客户端」→ 复制 **mierus://** 或扫码 / 下载 JSON  
- 用支持 mieru 的 App 导入（**不要**用 WireGuard 官方 App 扫 WG 码）  
- 验证：`ifconfig.me` 应为**家宽出网 IP**

若仍不通：让老板确认 **TCP 端口** 已映射到落地机内网（不是 UDP）。

---

## 升级说明（1.x → 2.0）

1. `git pull` 后 `sudo bash install.sh --update`
2. state 自动迁到 **v4 / protocol=mieru**
3. 旧 WireGuard 客户端会归档到 `legacyWireGuard`，**不会**当成 mieru 用户
4. 落地机建议**重装 Agent**（安装命令再执行一次），以使用 v2 agent
5. 重新「一键落地」装 mita，新建客户端用户，用 mierus 链接

---

## 功能摘要

- 单一出口模型（本机 / 远程 Agent）
- mita 安装与配置下发（OneClick + apply 回退）
- 用户管理、`mierus://` 分享链、JSON、二维码
- 诊断：Agent / mita RUNNING / 入站地址 / 出网 IP 只读
- 任务轮询、脏标记、改 Endpoint 后提示更新链接

---

## 环境要求

- 面板：Linux，Node.js 18+，TCP 面板端口（默认 51821）
- 落地：Linux root，出网访问面板与 GitHub（装 mita），前置映射 **TCP** 监听端口

---

## 许可证

MIT（面板）。  
mita/mieru 上游为 GPL-3.0；OneClick 安装脚本见 `vendor/mieru-oneclick`。
