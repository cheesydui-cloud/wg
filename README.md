# mieru 出口面板 v3.1

中文、新手友好的 **mieru / mita 拓扑出口管理面板**（稳定版）。

仓库：https://github.com/cheesydui-cloud/wg  
当前版本：**v3.1.0**

> **正确路径（已打通验证）**  
> **电脑/客户端 → 商家 IX 前置(114/211) → 沪日 IX(DNAT) → 落地家宽 mita → 出网**  
>  
> - 「移动入口」= 商家**移动宽带前置**（如 211），**不是手机**  
> - 客户端 Endpoint = 商家前置，**不是**家宽公网 IP、不是面板 IP  
> - 协议 **mieru TCP**；端口商家段 **7900–7999**  
> - WireGuard 见 tag **v1.4.1**（本线路不用）

---

## 架构

```
电脑 / 客户端（NekoBox / 官方 mieru / 支持 mieru 的 App）
        │  TCP mierus://
        ▼
  商家 IX 前置   114.x（外部）/ 211.x（移动宽带前置）
        │
        ▼
  沪日 IX（内网如 172.16.2.79）     ← 面板生成 DNAT 脚本
        │  TCP 转发到家宽公网:端口
        ▼
  落地家宽 mita + Agent            ← 真正出网
        │
        ▼
  公网（出口 IP = 家宽）
```

| 角色 | 装什么 | 注意 |
|------|--------|------|
| **你的电脑** | mieru 客户端 | 连商家前置 114/211 |
| **商家 IX 前置** | 商家提供 | 端口 7900–7999，TCP |
| **沪日 IX** | 转发脚本（不装 mita） | root 整段执行脚本 |
| **落地家宽** | Agent + mita | RUNNING 且监听端口 |
| **面板** | 本仓库 | **独立 VPS**，只管理 |

无关 VPS 对前置 IP 的 `nc` 超时可能因白名单，**不算失败**。用本机经商家前置测。

---

## 稳定版打通清单（按这个做）

### 1. 面板（独立 VPS）

```bash
cd ~/wg   # 或安装目录
git pull
sudo bash install.sh --update
# 新装：sudo bash install.sh
```

打开 `http://面板IP:51821`，确认版本 **v3.1.0**。

忘记密码：

```bash
sudo bash install.sh --reset-password '新密码'
```

### 2. 落地家宽：Agent + mita

1. 面板向导/落地机 → 复制 Agent 安装命令 → **家宽 root** 执行  
2. 面板确认 Agent **在线**  
3. 拓扑端口 **7901**、协议 **TCP** → **一键落地**  
4. 家宽确认：

```bash
mita status          # 须 RUNNING
ss -lntp | grep 7901 # 须 LISTEN
# 若 STOPPED：
mita start
```

### 3. 拓扑：IX 转发

| 字段 | 填什么 |
|------|--------|
| 商家前置 | 114 或 211（客户端连这个） |
| 端口 | 7901（商家段内） |
| 家宽对 IX 可达地址 | **家宽公网 IP**（IX 能访问到的） |
| 家宽 mita 端口 | 7901 |

1. **生成/刷新转发脚本** → **复制脚本**  
2. 沪日 IX root **整段**执行（不要一行行贴进交互 shell）：

```bash
cat > /tmp/ix-forward.sh << 'SCRIPT_EOF'
# 粘贴面板复制的完整脚本
SCRIPT_EOF
chmod +x /tmp/ix-forward.sh
bash /tmp/ix-forward.sh
```

3. 在 **IX** 上探测：

```bash
timeout 5 bash -c 'echo >/dev/tcp/家宽公网IP/7901' && echo OK || echo FAIL
```

- **OK** → 面板勾选「IX 已执行且探测 OK」→ 保存  
- **Connection refused** → 家宽 mita 没在听，回步骤 2  
- **timeout** → IX 到不了家宽，查防火墙/IP 是否填对  

### 4. 电脑客户端

- 面板「客户端」→ 复制 **114 / 211** mierus 链接导入  
- 登录名须英文/数字（如 `u7af760`），**不要**填中文备注当用户名  
- Endpoint 必须是商家前置，**禁止**填家宽公网 IP  
- 验证：`ifconfig.me` ≈ 家宽出网 IP  

---

## 故障对照（已踩过的坑）

| 现象 | 原因 | 处理 |
|------|------|------|
| IX 探测 `Connection refused` | 家宽 mita STOPPED / 未听 7901 | `mita start`；`ss` 确认 |
| IX 探测 timeout | 地址错或防火墙 | 填家宽公网；放行 TCP 7901 |
| 脚本执行像没效果 | 一行行粘贴只写了注释 | 整段写入文件再 `bash` |
| 客户端不通但家宽/IX 都 OK | Endpoint 填错 | 改连 114/211，不要连 82.x |
| 美国 VPS nc 114 超时 | 商家白名单 | **忽略**；本机测 |
| 小火箭连不上 | 用户填了「我的手机」 | 改填登录名 u7af760 |

---

## 升级

```bash
cd ~/wg && git pull
sudo bash install.sh --update
```

- **3.0.x → 3.1.0**：文案与稳定运维清单；路径模型不变  
- **2.x → 3.1**：state v5 拓扑；补 IX 转发与勾选  
- **1.x → 3.1**：WG 归档；重装 Agent；新建 mieru 用户  

落地机建议重装/再执行一次 Agent 安装命令以对齐 agent 版本。

---

## 功能摘要

- 拓扑：商家前置 114/211、端口段、IX 转发脚本、分层诊断  
- 远程 Agent：一键装/应用 mita、用户与双前置二维码  
- 登录加固、重置密码、改前置后提示更新链接  
- 面板只管理，业务链不经面板  

---

## 环境要求

- 面板：Linux，Node.js 18+，TCP 51821  
- 落地家宽：Linux root，出网访问面板与 GitHub，TCP 790x 监听  
- IX：root，能访问家宽可达地址，nft/iptables DNAT  
- 客户端：支持 mieru，连商家前置  

---

## 许可证

MIT（面板）。  
mita/mieru 上游 GPL-3.0；OneClick 见 `vendor/mieru-oneclick`。
