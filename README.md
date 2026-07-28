# mieru 出口面板 v3.0

中文、新手友好的 **mieru / mita 拓扑出口管理面板**。

仓库：https://github.com/cheesydui-cloud/wg  
当前版本：**v3.0.0**

> **v3 面向商家移动入口约束**：端口 7900–7999、河南白名单、TCP mieru、沪日 IX 转发到美国家宽。  
> **v2 起默认协议是 mieru，不再是 WireGuard。** 最后一版 WireGuard 见 tag **v1.4.1**。

---

## 真实拓扑（必读）

```
手机（小火箭 / NekoBox / 官方 mieru）
        │  TCP mierus://
        ▼
  商家移动入口 211.x  /  外部 114.x     ← 手机填这个（不是出网 IP）
        │
        ▼
  沪日 IX（内网 172.16.x）              ← TCP DNAT 转发到家宽
        │
        ▼
  美国家宽 mita + Agent                 ← 真正出网
        │
        ▼
  公网（出口 IP = 家宽）
```

| 机器 | 装什么 | 注意 |
|------|--------|------|
| **面板** | 本仓库 Web 面板 | **独立 VPS**，只管理，不在业务链上 |
| **沪日 IX** | 不装 mita（转发场景） | root 执行面板生成的 **IX 转发脚本** |
| **美国家宽** | Agent + mita | 「一键落地」；出网 IP 只读 |

**美国 VPS 对 114:7901 的 `nc` 超时不算失败**（省份白名单）。请用 **河南移动手机** 测 211 入口。

---

## 五步打通（商家入口）

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

### 2. 向导确认路径 → 家宽装 Agent

向导默认路径：**商家移动入口 → 沪日IX → 美国家宽**。  
在**美国家宽** root 执行面板给出的 Agent 安装命令（不是 IX、不是面板机）。

### 3. 拓扑页配置入口 + IX 转发

- 入口优先 **移动 211**，端口 **7900–7999**（如 7901），协议 **TCP**
- 填写「家宽对 IX 可达地址」（家宽公网或隧道）
- **生成并复制 IX 转发脚本** → 在**沪日 IX root** 执行
- 勾选「IX 转发已配置」

### 4. 家宽一键落地 mita

「落地机 / 概览」→ **一键落地** → 等 Agent 任务完成，`mita` = RUNNING。

### 5. 客户端

- 「客户端」→ **211/114** 双链接（河南优先扫 **211**）
- 登录名须英文/数字（如 `u7af760`），**不要**把「我的手机」填进小火箭用户栏
- 验证：`ifconfig.me` ≈ 家宽出网 IP

---

## 升级说明

### 2.x → 3.0

1. `git pull` 后 `sudo bash install.sh --update`
2. state 自动迁到 **v5 / topology**（入口·IX·落地）
3. 打开「拓扑」：补全 IX 家宽可达地址、跑转发脚本、勾选已配置
4. 客户端重新复制 **211** mierus 链接
5. 家宽建议再点一次「一键落地 / 应用配置」

### 1.x → 3.0

同 2.0 迁移：旧 WireGuard 归档；落地机重装 Agent；新建 mieru 用户。

---

## 功能摘要

- **拓扑页**：211/114 入站、商家端口段校验、IX 转发脚本、分层诊断
- 远程 Agent 一键装 mita、用户与 `mierus://` 双入口二维码
- 诊断：入口 / IX 转发 / Agent / mita / 出网 IP 分层展示
- 登录加固、重置密码、改 Endpoint 后提示重扫

---

## 环境要求

- 面板：Linux，Node.js 18+，TCP 51821（可改）
- 家宽：Linux root，出网访问面板与 GitHub，监听 TCP 790x
- IX：root，能访问家宽可达地址，可写 nft/iptables DNAT
- 手机：河南移动优先；支持 mieru 的客户端

---

## 许可证

MIT（面板）。  
mita/mieru 上游为 GPL-3.0；OneClick 安装脚本见 `vendor/mieru-oneclick`。
