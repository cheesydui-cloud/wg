# mieru 出口面板 v3.0

中文、新手友好的 **mieru / mita 拓扑出口管理面板**。

仓库：https://github.com/cheesydui-cloud/wg  
当前版本：**v3.0.1**

> **v3 面向商家 IX 前置约束**：端口 7900–7999、TCP mieru、沪日 IX 转发到落地家宽。  
> **正确路径：你的电脑/客户端 → 商家 IX 前置 → 沪日 IX → 落地家宽。**  
> 「移动入口」= 商家提供的**移动宽带前置**（如 211），**不是手机**。  
> **v2 起默认协议是 mieru，不再是 WireGuard。** 最后一版 WireGuard 见 tag **v1.4.1**。

---

## 真实拓扑（必读）

```
电脑 / 客户端（NekoBox / 官方 mieru / 支持 mieru 的 App）
        │  TCP mierus://
        ▼
  商家 IX 前置  外部 114.x  /  移动宽带前置 211.x   ← 客户端填这个（不是出网 IP）
        │
        ▼
  沪日 IX（内网 172.16.x）                          ← TCP DNAT 转发到家宽
        │
        ▼
  落地家宽 mita + Agent                             ← 真正出网
        │
        ▼
  公网（出口 IP = 家宽）
```

| 角色 | 装什么 | 注意 |
|------|--------|------|
| **你的电脑** | mieru 客户端 | 连商家前置 Endpoint |
| **商家 IX 前置** | 商家提供 | 114 / 211，端口 7900–7999 |
| **沪日 IX** | 转发脚本（不装 mita） | root 执行面板生成的 DNAT 脚本 |
| **落地家宽** | Agent + mita | 「一键落地」；出网 IP 只读 |
| **面板** | 本仓库 Web | **独立 VPS**，只管理，不在业务链上 |

无关 VPS 对 114:7901 的 `nc` 超时可能因白名单，**不算落地失败**。请用**你本机**经商家前置测。

---

## 五步打通

### 1. 独立 VPS 安装/升级面板

```bash
cd ~/wg   # 或你的安装目录
git pull
sudo bash install.sh --update
# 新装：sudo bash install.sh
```

浏览器打开 `http://面板IP:51821`。

#### 忘记登录密码

```bash
cd ~/wg && git pull
sudo bash install.sh --reset-password '你的新密码'
```

### 2. 向导确认路径 → 落地家宽装 Agent

向导默认路径：**电脑 → 商家IX前置 → 沪日IX → 落地家宽**。  
在**落地家宽** root 执行面板给出的 Agent 安装命令（不是 IX、不是面板机）。

### 3. 拓扑页配置前置 + IX 转发

- 前置选 **外部 114** 或 **移动宽带 211**，端口 **7900–7999**（如 7901），协议 **TCP**
- 填写「家宽对 IX 可达地址」（家宽公网或隧道）
- **生成并复制 IX 转发脚本** → 在**沪日 IX root** 执行
- 勾选「IX 转发已配置」

### 4. 落地家宽一键落地 mita

「落地机 / 概览」→ **一键落地** → 等 Agent 任务完成，`mita` = RUNNING。

### 5. 本机客户端

- 「客户端」→ **114 / 211** 双链接（按商家给你用的前置选）
- 登录名须英文/数字（如 `u7af760`），**不要**把中文备注填进用户栏
- 验证：`ifconfig.me` ≈ 家宽出网 IP

---

## 升级说明

### 2.x / 3.0.0 → 3.0.1

1. `git pull` 后 `sudo bash install.sh --update`
2. 文案与路径纠正：第一跳是**电脑客户端**，不是手机
3. 打开「拓扑」：补全 IX 家宽可达地址、跑转发脚本、勾选已配置
4. 客户端重新复制商家前置 mierus 链接
5. 落地家宽再点一次「一键落地 / 应用配置」

### 1.x → 3.x

旧 WireGuard 归档；落地机重装 Agent；新建 mieru 用户。

---

## 功能摘要

- **拓扑页**：商家前置 114/211、商家端口段校验、IX 转发脚本、分层诊断
- 远程 Agent 一键装 mita、用户与 `mierus://` 双前置二维码
- 诊断：前置 / IX 转发 / Agent / mita / 出网 IP 分层展示
- 登录加固、重置密码、改 Endpoint 后提示更新链接

---

## 环境要求

- 面板：Linux，Node.js 18+，TCP 51821（可改）
- 落地家宽：Linux root，出网访问面板与 GitHub，监听 TCP 790x
- IX：root，能访问家宽可达地址，可写 nft/iptables DNAT
- 客户端：支持 mieru；连商家前置，不连出网 IP

---

## 许可证

MIT（面板）。  
mita/mieru 上游为 GPL-3.0；OneClick 安装脚本见 `vendor/mieru-oneclick`。
