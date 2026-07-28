# mieru 出口面板 v4.1

中文、新手友好的 **mieru / mita 拓扑出口管理面板**。

仓库：https://github.com/cheesydui-cloud/wg  
当前版本：**v4.2.9**（小火箭备注=profile）

- 每台 IX 独立商家前置（IP/域名）与端口段
- 拓扑 = IX 工作台；落地列表点开详情；客户端按落地分组
- 管理员账号/密码在「设置」完整可改

> **正确路径（已打通验证）**  
> **电脑/客户端 → 商家 IX 前置(114/211) → IX(DNAT) → 落地家宽 mita → 出网**  
>
> - 「移动入口」= 商家**移动宽带前置**（如 211），**不是手机**  
> - 客户端 Endpoint = 商家前置，**不是**家宽公网 IP、不是面板 IP  
> - 协议 **mieru TCP**；端口商家段 **7900–7999**  
> - WireGuard 见 tag **v1.4.1**（本线路不用）

---

## V4 新增

| 能力 | 说明 |
|------|------|
| **多落地** | 多台家宽 Agent；每落地独立 apply / 一键落地 / 安装命令 |
| **多 IX** | 多台 IX；按 **IX × 落地 × 端口** 生成 DNAT 脚本 |
| **用户路由** | 用户可绑指定落地、独立端口 |
| **流量 / 期限** | `quotaMb` + `expireAt`；触发后停用并下发 mita |
| **用量** | Agent 上报 `mita get users/quotas` 快照（非计费级） |
| **兼容 v3.1** | 单前置 / 单 IX / 单落地自动迁成一条路由，Endpoint 保留 |

路径保持不变。业务流量不经面板。

### v4.2.9

- **小火箭备注**：`mierus` 链接的 `profile=` 写入「备注 · 到期日期」（此前写死 default，扫码后备注才是 default）。需重新扫码/导入。

### v4.2.8

- **分享/二维码节点名**：`mierus://…#备注 · 到期YYYY-MM-DD`，小火箭等导入后列表可显示备注与到期（需重新复制/扫码；旧链接无此项）。

### v4.2.7

- **客户端卡片 UI**：备注、到期、估算实时网速分行展示，不再挤在一行；扫码弹窗显示备注与到期。网速由相邻两次用量差估算（约 30s）。

### v4.2.6

- **稳定版**：Agent 禁止重叠 tick（防 apply 中途被自更新打断）；`syncPrimaryFromState` 不再用全局 7901 盖掉落地端口；BOTH 协议 TCP/UDP 端口与分享链一致（UDP=base+1）；改端口一律排队 apply；监听检测轮询重试。

### v4.2.5

- **apply 强制端口**：bundle/agent 强制 portBindings=落地 listenPort；apply 后校验本机是否在听该端口，否则不算成功并走 OneClick 重配（修 pro3 仍停 7901）。
- 落地改端口保存后，在线时自动排队 apply。

### v4.2.4

- **落地一键更新 Agent**：落地详情「更新 Agent」/ 顶栏「全部更新 Agent」；在线时面板下发任务，Agent 拉取最新代码并重启，无需 SSH 家宽。

### v4.2.3

- **客户端页**：不再只显示「默认 Endpoint :7901」；按落地列出 `前置:7901` / `前置:7902`，避免误以为只有 7901。
- 用户端口列显示实际端口（落地 listenPort）；诊断列出每条落地转发与可达地址冲突警告。

### v4.2.2

- **修「任务超时，已重新排队」死循环**：旧 Agent 在 heartbeat 领到 apply 任务后若先自更新 exit，任务已 lease 却未执行，2 分钟后反复超时。现改为**先跑完任务再自更新**；任务 lease 延长至 10 分钟；多次超时后标记失败而非永久 pending。
- Agent 版本对齐 **4.2.2**。

### v4.2.1

- **固定面板升级命令**：`scripts/upgrade-panel.sh`（curl 一条完成 pull + 同步 `/opt/wg-panel` + 重启）。不要只 `git pull`。

### v4.2.0

- **落地显示名称保存后不再被改回**：Agent `hello` 曾用安装时的 `WG_AGENT_NAME` 覆盖面板改名；现以面板 `nameSource=panel` 锁定，Agent 重启也不回滚。
- 继承 4.1.x：IX/落地可自定义名、/api/health 修复、多落地用户列表不被主落地心跳抹掉。

### v4.1.11

- **修家宽装 Agent 失败**：`/api/health` 误引用未定义变量导致 500，安装脚本健康检查失败；并加固 `install-agent.sh`（校验下载内容、env 引号、启动失败打印 journal）。

### v4.1.10

- **IX / 落地显示名称可自定义**：拓扑页改「IX 显示名称」或双击标签；落地页改「落地显示名称」或双击列表行，保存后标签/分组/所属 IX 同步。

### v4.1.9

- **根因修复**：主落地 Agent 心跳 / 拉 bundle / job-result 后，`syncStateFromPrimary` 曾用「仅含本落地用户」的 `node.clients` 覆盖全局 `state.clients`，导致 **pro3 等其它落地用户一刷新就消失**，应用本落地也误报无用户。
- 用户列表以 `state.clients` 为唯一真源；`node.clients` 仅作脏标记/缓存，不再回写全局。
- 启动时 `mergeClientsFromNodes`：若历史数据用户只在 `node.clients`，合并恢复到全局列表。
- 回归：smoke 覆盖「主落地心跳不抹多落地用户」与 merge 恢复。

### v4.1.8
- 修复：客户端列表在 pro3 下有用户，点「应用本落地」却报没有绑定用户
- 统一 resolveLandingNodeId / clientsForNode 与 UI 分组规则
- 多落地 landing.id 去重（旧数据 landing-default 重复）
- 保存/创建时规范化 landingNodeId 为 nodeId

### v4.1.7
- 修复：编辑/保存用户报「用户不存在」——旧数据缺 id 或 PUT 路径无效
- 启动时为所有客户端补齐 id；保存前校验并给出明确提示

### v4.1.6
- 修复：0 用户/未 apply 过的落地不再让全局「有未应用的更改」永远亮着
- 诊断写明**哪几台**落地未应用；「连接参数已变」降为提醒（复制新链接后点「我已更新」）
- 「应用全部」只下发有用户且 dirty 的落地

### v4.1.5
- 面板消毒旧 Agent 的「脚本异常，已用 mita apply 回退成功」误导 toast（任务实际已成功）
- 落地页 / 顶栏提示 Agent 版本过旧；heartbeat 下发 panelVersion
- Agent ≥4.1.5 可从面板自动拉新并重启；**更旧版本请重装一次安装命令**

### v4.1.4
- 落地 0 绑定用户时禁止 apply / 一键落地，直接提示先改绑
- 「已从 WireGuard 迁移」改为历史提示，可点「知道了」关闭
- 落地卡片 0 用户时禁用「应用配置」并提示

### v4.1.3
- 新建落地自动分配空闲端口；同 IX 禁止端口冲突
- IX 转发脚本一次写入全部落地端口（不再只留一条）
- 落地页区分「本落地端口」与「全局默认端口」

### v4.1.2
- 修复用量一直 0B：正确解析 `mita get users` 表格（1Day/7Days/30Days 上下行）
- 客户端列表展示 ↓下行 / ↑上行 / 合计（默认 30 天累计）

### v4.1.1
- 一键落地成功后正确清除 dirty（bundle hash 对齐）
- Agent apply-full / OneClick 回退文案修正，失败带脚本尾部
- 任务 toast 按目标落地轮询；设置页账号密码与按钮样式统一

### v4.1.0
- 每台 IX 独立商家前置（IP/域名）与端口段
- 拓扑 = IX 工作台；落地列表+详情；客户端按落地分组
- 分享链按 route.ixId → landing.ixId 解析前置


---

## 架构

```
电脑 / 客户端（NekoBox / 官方 mieru / 支持 mieru 的 App）
        │  TCP mierus://
        ▼
  商家 IX 前置   114.x（外部）/ 211.x（移动宽带前置）
        │
        ▼
  IX（可多台，内网如 172.16.2.79）   ← 面板生成 DNAT 脚本
        │  TCP 转发到指定家宽:端口
        ▼
  落地家宽 mita + Agent（可多台）    ← 真正出网
        │
        ▼
  公网（出口 IP = 对应家宽）
```

| 角色 | 装什么 | 注意 |
|------|--------|------|
| **你的电脑** | mieru 客户端 | 连商家前置 114/211 |
| **商家 IX 前置** | 商家提供 | 端口 7900–7999，TCP |
| **IX** | 转发脚本（不装 mita） | root 整段执行；可多台 |
| **落地家宽** | Agent + mita | 可多台；RUNNING 且监听端口 |
| **面板** | 本仓库 | **独立 VPS**，只管理 |

无关 VPS 对前置 IP 的 `nc` 超时可能因白名单，**不算失败**。用本机经商家前置测。

---

## 稳定版打通清单（单路径 = v3.1 行为）

### 1. 面板（独立 VPS）

**升级（固定这一条，不要只 git pull）：**

```bash
curl -fsSL https://raw.githubusercontent.com/cheesydui-cloud/wg/main/scripts/upgrade-panel.sh | sudo bash
```

新装（仅首次）：

```bash
git clone https://github.com/cheesydui-cloud/wg.git ~/wg
cd ~/wg && sudo bash install.sh
```

打开 `http://面板IP:51821`，确认版本 **v4.2.9**。

忘记密码：

```bash
sudo bash install.sh --reset-password '新密码'
```

### 2. 落地家宽：Agent + mita

1. 面板「落地」→ 复制 Agent 安装命令 → **家宽 root** 执行  
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
| 端口 | 7901（商家段内；多落地用不同端口） |
| 家宽对 IX 可达地址 | **家宽公网 IP**（IX 能访问到的） |
| 家宽 mita 端口 | 一般与入口相同 |

1. 选择 **IX × 落地** → **生成/刷新转发脚本** → **复制脚本**  
2. 对应 IX root **整段**执行（不要一行行贴进交互 shell）：

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

- **OK** → 面板勾选该 IX「已转发」→ 保存  
- **Connection refused** → 家宽 mita 没在听  
- **timeout** → IX 到不了家宽，查防火墙/IP  

### 4. 电脑客户端

- 「客户端」→ 复制 **114 / 211** mierus 链接导入  
- 登录名须英文/数字（如 `u7af760`），**不要**填中文备注当用户名  
- Endpoint 必须是商家前置，**禁止**填家宽公网 IP  
- 验证：`ifconfig.me` ≈ 对应落地出网 IP  

---

## 多落地 / 多线路（V4）

1. **落地**页 → 添加落地 → 新端口（如 7902）→ 在新家宽装 Agent  
2. **拓扑** → 为该落地填家宽可达地址 → 按 IX×落地 生成脚本 → 在 IX 执行  
3. **客户端** → 编辑用户 → 绑定落地 / 专用端口；可设配额 MB、到期日  
4. 改用户只脏对应落地；点该落地「应用」或全局「应用」  
5. 到期/超额：默认自动停用并下发（设置里可关 `autoApplyEnforce`）

同 IX 多落地**必须不同 listenPort**（7900–7999）。

---

## 故障对照

| 现象 | 原因 | 处理 |
|------|------|------|
| IX 探测 `Connection refused` | 家宽 mita STOPPED / 未听端口 | `mita start`；`ss` 确认 |
| IX 探测 timeout | 地址错或防火墙 | 填家宽公网；放行 TCP |
| 脚本执行像没效果 | 一行行粘贴只写了注释 | 整段写入文件再 `bash` |
| 客户端不通但家宽/IX 都 OK | Endpoint 填错 | 改连 114/211，不要连家宽 IP |
| 美国 VPS nc 114 超时 | 商家白名单 | **忽略**；本机测 |
| 小火箭连不上 | 用户填了中文 | 改填登录名 u7af760 |
| 用户已到期限仍能连 | 未应用 / Agent 旧 | 应用配置；重装 Agent 对齐 v4 |

---

## 升级（固定命令）

**面板机 root 只跑这一条**（自动 pull + 同步到 `/opt/wg-panel` + 重启 `wg-panel`，保留 data/密码）：

```bash
curl -fsSL https://raw.githubusercontent.com/cheesydui-cloud/wg/main/scripts/upgrade-panel.sh | sudo bash
```

等价本地写法（仓库已 clone 时）：

```bash
cd ~/wg   # 你的 git 目录
git pull
sudo bash scripts/upgrade-panel.sh
# 或：sudo bash install.sh --update
```

| 错误做法 | 为什么不够 |
|----------|------------|
| 只 `git pull` | 运行中的服务在 `/opt/wg-panel`，源码目录更新了进程还是旧文件 |
| 只 `systemctl restart wg-panel` | 没有把新代码同步进 `/opt/wg-panel` |
| 只改 `~/wg` 不跑 `install.sh --update` | systemd 仍执行 `/opt/wg-panel/server/index.js` |

升级后自检：

```bash
curl -sS http://127.0.0.1:51821/api/health
systemctl status wg-panel --no-pager
```

- **3.1 → 4.x**：state 自动迁 v6（备份到 `data/backups/`）  
- 升级前建议：`cp /opt/wg-panel/data/state.json /opt/wg-panel/data/state.json.bak`  
- **Agent 与面板版本不一致**时：落地页复制安装命令在家宽重装一次（不必每次面板升级都重装）

本地回归：

```bash
npm run smoke
```

---

## 功能摘要

- 拓扑：商家前置 114/211、多 IX、IX×落地转发脚本、分层诊断  
- 多落地 Agent：安装命令、一键落地、按节点 apply / bundle 过滤用户  
- 用户路由 + 套餐（配额/到期）+ 用量快照  
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
