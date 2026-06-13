# GMV Max 自动化 — 操作手册

> **🔧 故障排查 & 操作流程**
>
> 记录实际遇到的问题、解决方案和操作 SOP。
> 每次遇到新问题时更新此文档。

---

## 目录

1. [浏览器故障](#1-浏览器故障)
2. [CDP & 通信故障](#2-cdp--通信故障)
3. [广告创建故障](#3-广告创建故障)
4. [广告修改故障](#4-广告修改故障)
5. [数据采集故障](#5-数据采集故障)
6. [环境故障](#6-环境故障)
7. [常规操作 SOP](#7-常规操作-sop)

---

## 1. 浏览器故障

### 1.1 AdsPower Chrome 138 crashpad 崩溃

**症状：**
- 浏览器突然关闭
- 日志中出现 `crashpad` 相关报错
- AdsPower 客户端显示浏览器状态为 "Inactive"

**原因：**
AdsPower 内置的 Chrome 138 内核的 crashpad 进程在某些环境下不稳定，随机崩溃。

**解决方案：**
```bash
# 方法 1：手动重启（最简单）
# 在 AdsPower 客户端中点击"打开"按钮重新启动浏览器

# 方法 2：使用脚本自动重启（推荐）
# tkads.js 已内置自动检测和唤醒逻辑：
node ~/.tkads/tkads.js list
# 如果浏览器未运行，脚本自动调用 AdsPower API 重新启动

# 方法 3：直接通过 API 重启
curl "http://local.adspower.net:50325/api/v1/browser/start?user_id=k1456ta2&open_tabs=1"
```

**预防措施：**
- 定期检查浏览器状态（`tkads.ad.list` 自动检查）
- 不要在浏览器中打开过多标签页
- 低配机器可能出现更频繁的崩溃

---

### 1.2 AdsPower 连接超时

**症状：**
- `getBrowserWS()` 返回错误
- `ECONNREFUSED` 或超时异常

**原因：**
- AdsPower 客户端本身未启动
- AdsPower API 端口 50325 不可达

**解决方案：**
1. 检查 AdsPower 客户端是否运行
2. 确认端口 50325 没有被防火墙阻止
3. 重启 AdsPower 客户端

**验证命令：**
```bash
curl http://local.adspower.net:50325/api/v1/browser/active?user_id=k1456ta2
# 成功：{"code":0,"data":{"status":"Active","ws":{"puppeteer":"ws://..."}}}
# 失败：{"code":-1,"msg":"not found"}
```

---

## 2. CDP & 通信故障

### 2.1 CDP Runtime.evaluate 被 TikTok 屏蔽

**症状：**
- `page.evaluate()` 调用失败
- 返回 `Permission denied` 或空白响应
- TikTok 检测到 CDP 注入并阻止

**原因：**
TikTok 的安全机制会检测页面内的 JavaScript 注入并阻断 `Runtime.evaluate`。

**解决方案：**
使用 `Network.fetch` + CDP 拦截替代 `page.evaluate()`：

```javascript
// ❌ 不要用 — 会被 TikTok 屏蔽
const result = await page.evaluate(() => fetch(url, options));

// ✅ 正确方式 — 通过 CDP Network 层发送请求并拦截响应
const cdp = await page.target().createCDPSession();
await cdp.send('Network.enable');
await cdp.send('Network.fetch', {
    url: fullUrl,
    method: 'POST',
    headers: headers
});

// 拦截响应
cdp.on('Network.fetch.requestPaused', async (event) => {
    // 处理响应...
});
```

**检测方法：**
```bash
# 尝试 evaluate 看是否被屏蔽
node -e "
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.connect({browserWSEndpoint: 'ws://...'});
  const p = await b.pages();
  const r = await p[0].evaluate(() => 1+1);
  console.log('evaluate 正常:', r);
})();
"
# 如果抛出异常说明被屏蔽
```

---

### 2.2 WebSocket 连接断开

**症状：**
- CDP 操作中途失败
- `ProtocolError: Target closed`
- 操作执行一半中断

**原因：**
- 浏览器崩溃（见 1.1）
- 网络不稳定
- 长时间空闲自动断开

**解决方案：**
1. 重新连接 WS（tkads.js 自动处理）
2. 对长时间操作分段执行
3. 每次操作前重新获取 WS 地址

**自动恢复：**
```javascript
// tkads.js 内置重试逻辑
async function withRetry(fn, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); }
        catch (e) {
            if (i === retries - 1) throw e;
            await reconnectBrowser();  // 自动重连
            await sleep(delay);
        }
    }
}
```

---

## 3. 广告创建故障

### 3.1 ad_id 仅创建时返回（需拦截 create API）

**症状：**
- `all_ad_data/detail?campaign_id=xxx` 响应中缺少 `ad_id`
- 修改广告时缺少 ad_id 参数导致失败
- 错误：`ad_info.ad_id is required`

**原因：**
TikTok 的 `detail` API 不再返回 ad_id。
ad_id 仅在创建时通过 `all_ad_data/create` 的响应返回，之后无法再获取。

**解决方案：**
创建广告时必须通过网络拦截捕获 ad_id：

```javascript
// gmvmax-create-v4.cjs 已内置此逻辑
// 1. 开启 Network.responseReceived 监听
const cdp = await page.target().createCDPSession();
await cdp.send('Network.enable');

// 2. 过滤 all_ad_data/create API 的响应
cdp.on('Network.responseReceived', async (params) => {
    const url = params.request.url;
    if (url.includes('all_ad_data/create')) {
        const response = await cdp.send('Network.getResponseBody', {
            requestId: params.requestId
        });
        const data = JSON.parse(response.body);
        const adId = data.ad_id;  // 关键！仅在此处可用
        // 3. 立即存入数据库
        await saveToDb({ campaign_id, ad_id: adId, ... });
    }
});
```

**预防措施：**
- 创建立即保存 ad_id：`~/.tkads/gmvmax-create-v4.cjs` 自动处理
- 验证：`SELECT * FROM campaign_meta WHERE campaign_id = 'xxx';`

---

### 3.2 SPU 已占用

**症状：**
- 创建广告失败
- 错误消息包含 `spu`、`occupied`、`already in use`
- 或 API 返回商品相关错误

**原因：**
每个 SPU 在同一店铺内只能属于一个 GMV Max 广告。
创建广告前未检查目标 SPU 的占用状态。

**解决方案：**
```python
# 创建前必须检查 SPU 可用性
# 1. 查询已有的 campaign 列表
# 2. 检查目标 SPU 是否已被使用
# 3. 如果已占用，选择其他 SPU 或联系运营释放

# 在 gate-engine.js 中实现为 spu_available 门禁检查
```

**预防措施：**
- 宪法规则 #5 强制检查
- `gate-engine.js` 的 `spu_available` 门禁在创建前自动检测

---

### 3.3 创建后无法立即修改

**症状：**
- 创建广告后立即修改 ROI/预算失败
- `ad_info not found` 或类似错误

**原因：**
创建后 ad_id 和 campaign 需要时间在系统中同步。
刚创建的广告可能未完全就绪。

**解决方案：**
- 创建后等待至少 5 秒再执行修改操作
- 先用 `list` 命令确认广告状态为 active
- 确认 `campaign_meta` 表中已写入 ad_id

---

## 4. 广告修改故障

### 4.1 遗留计划无法修改 ROI/预算

**症状：**
- 修改已有数据的广告 ROI/预算失败
- 门禁引擎拒绝操作

**原因：**
宪法规则 #1 禁止修改遗留计划的 ROI/预算。
已被系统学习和优化的广告修改后可能重置学习期。

**解决方案：**
```bash
# 1. 确认是否为遗留计划
gate-engine 的 not_legacy 门禁会检查

# 2. 如需强制修改（不推荐），需要先暂停广告再修改
# ⚠️ 注意：这会重置平台的学习数据

# 3. 推荐做法：不修改，让平台继续学习
```

**验证方法：**
```
✓ 新创建的广告（无数据）：可修改 ROI/预算
✗ 已有数据的广告（遗留计划）：禁止修改
```

---

### 4.2 update body 缺少必要字段

**症状：**
- `all_ad_data/update` 返回错误
- 缺少 `ad_id`、`custom_tz_id`、`shop_authorized_bc` 等字段

**原因：**
update API 的 body 结构非常复杂，包含 `campaign_info`、`ad_info` 多个层级。

**完整 update body 模板：**
```json
{
    "campaign_info": {
        "campaign_id": "<campaign_id>",
        "name": "<广告名称>",
        "budget": "<预算金额>",
        "budget_mode": "INFINITE",
        "custom_tz_id": "7473424031757336583",
        "custom_tz_type": 1,
        "campaign_shop_automation_type": 2
    },
    "ad_info": {
        "campaign_id": "<campaign_id>",
        "ad_id": "<ad_id>",
        "name": "自动化-<SPU_ID>",
        "custom_tz_id": "7473424031757336583",
        "custom_tz_type": 1,
        "roas_bid": "<ROI目标>",
        "product_list": [
            {
                "product_id": "<SPU_ID>",
                "external_type_list": ["304", "307"]
            }
        ]
    },
    "roas_bid": "<ROI目标>"
}
```

**关键参数表：**
| 参数 | 示例值 | 说明 |
|------|--------|------|
| custom_tz_id | `7473424031757336583` | Australian Western Standard Time 选项ID |
| custom_tz_type | `1` | 时区类型 |
| shop_authorized_bc | `7545376144372318224` | 认证的商务中心 ID |
| ad_id = campaign_id | 两者相同 | 当前系统 ad_id 和 campaign_id 值相同 |

---

## 5. 数据采集故障

### 5.1 campaign_snapshots 表为空

**症状：**
- 执行报表生成命令后无输出
- 查询 `campaign_snapshots` 表返回 0 行
- `SELECT * FROM campaign_snapshots` 为空

**原因：**
Dashboard 认证过期或未登录。`campaign_snapshots` 表需要通过 Seller Center 的
Dashboard 页面采集数据，如果浏览器未登录或 Cookie 过期，采集会失败。

**解决方案：**
```bash
# 1. 检查浏览器是否已登录 Seller Center
# 手动在 AdsPower 浏览器中打开 seller-my.tiktok.com

# 2. 如果未登录，重新登录（可能需要手机验证码）

# 3. 登录后重新执行数据采集
node ~/.tkads/tkads_daily.js

# 4. 验证数据是否写入
python -c "
import sys; sys.path.insert(0, '.')
import db
rows = db.get_conn().execute('SELECT count(*) FROM campaign_snapshots').fetchone()
print(f'快照记录数: {rows[0]}')
"
```

**预防措施：**
- 每 7 天检查一次 Cookie 是否过期
- 登录时勾选「记住此设备」

---

### 5.2 query_list 包含 budget 字段

**症状：**
- 采集 API 返回 `QueryStatData error`
- `post_campaign_list` 调用失败

**原因：**
`query_list` 参数中不能包含 `budget` 字段，否则会触发 TikTok 的查询异常。

**解决方案：**
```json
// ❌ 错误：包含 budget
{"query_list": ["campaign_name", "budget", "cost"]}

// ✅ 正确：去掉 budget，使用 campaign_target_roi_budget
{"query_list": ["campaign_name", "campaign_target_roi_budget", "cost"]}
```

---

### 5.3 API 返回空广告列表

**症状：**
- `post_campaign_list` 返回 `[]` 或 `total = 0`
- 但 Seller Center 页面上明明有广告

**原因：**
URL 参数或 request body 错误。

**解决方案：**
检查以下参数：
1. `campaign_shop_automation_type: 2` — GMV Max 类型
2. `external_type_list: ["304", "307"]` — 广告子类型
3. `page: 1, page_size: 200` — 分页
4. locale/language 参数 — `locale=zh&language=zh`

---

## 6. 环境故障

### 6.1 Python3 别名问题（Microsoft Store stub exit 49）

**症状：**
- 运行 `python3` 命令时立即退出，返回码 49
- 提示跳转到 Microsoft Store
- `node child_process` 中调用 `python` 失败

**原因：**
Windows 上 `python3` 是 Microsoft Store 的 stub（存根），
会跳转到 Store 页面而不是执行真正的 Python。返回码 49 表示 "redirect to store"。

**解决方案：**
```bash
# 修复：使用 Windows Python Launcher 或 python 命令
# 系统正确路径：
python --version        # Python 3.12.10 ✅
# python3 --version     # ❌ exit code 49

# 在脚本/代码中使用 'python' 代替 'python3'
# 如果需要 python3 别名，创建符号链接：
# （在管理员终端中运行）
# pnpm install -g python3  # 不可行
# 推荐：在 Shell 别名中映射
alias python3='python'
```

**预防措施：**
- 所有脚本中使用 `python` 而不是 `python3`
- tkads.sh/shell 脚本中添加 `alias python3='python'`

---

### 6.2 磁盘空间不足

**症状：**
- 数据库写入失败
- 日志文件过大

**解决方案：**
```bash
# 检查磁盘使用
df -h

# 清理旧日志
truncate -s 0 ~/.tkads/logs/*.log

# 压缩旧数据
# 数据库清理（保留最近 90 天）
python ~/.tkads/save_daily.py --cleanup 90
```

---

## 7. 常规操作 SOP

### 7.1 每日检查

```bash
# 1. 检查广告状态
source ~/.tkads/tkads.sh
tkads.ad.list

# 2. 检查数据采集是否正常
python ~/.tkads/collect_day_by_day.py
```

### 7.2 创建新广告

```bash
# 前置条件：
#   1. AdsPower 浏览器已启动并登录
#   2. SPU 未被其他广告占用（gate-engine 自动检查）
#   3. 遵守宪法规则

# 方式 1：自动创建（推荐）
node ~/.tkads/gmvmax-create-v4.cjs \
  --roi 5.6 \
  --budget 100 \
  --name "自动化-<SPU_ID>"

# 方式 2：手动检查 SPU 可用性后创建
# 创建后验证：
python -c "
import sys; sys.path.insert(0, '.')
import db as db_old
# 查询最新创建的广告元数据
rows = db_old.get_conn().execute('SELECT * FROM campaign_meta ORDER BY rowid DESC LIMIT 1').fetchall()
print(rows or '未找到元数据 — 创建可能未完成')
"
```

### 7.3 修改广告 ROI/预算

```bash
# 注意：只能修改新建的、尚无数据的广告
# 已有数据的遗留计划不可修改（宪法规则 #1）

node ~/.tkads/tkads.js update <campaign_id> <new_roi> [new_budget]
# 示例：
node ~/.tkads/tkads.js update 123456789 5.6 200
```

### 7.4 恢复浏览器会话

当浏览器崩溃或需要手动操作时：
```bash
# 1. 在 AdsPower 客户端中打开浏览器
# 2. 登录 seller-my.tiktok.com（如需）
# 3. 导航到 GMV Max 管理页面
# 4. 验证会话正常
# 5. 回到终端继续自动化操作
```

---

## 8. 故障速查表

| 问题 | 症状 | 根本原因 | 快速解决 |
|------|------|----------|----------|
| 浏览器崩溃 | crashpad 崩溃 | Chrome 138 不稳定 | 自动重启（tkads.js 自动处理） |
| evaluate 被屏蔽 | Permission denied | TikTok 安全机制 | 改用 Network.fetch + CDP 拦截 |
| ad_id 找不到 | 修改失败 | 仅创建时返回 | gmvmax-create-v4.cjs 创建时拦截保存 |
| SPU 已占用 | 创建失败 | 重复使用 SPU | 创建前检查 SPU 可用性 |
| 遗留计划无法修改 | gate 拒绝 | 宪法规则 #1 | 不要修改，让平台学习 |
| 快照表为空 | 报表无数据 | 未登录/认证过期 | 重新登录 Seller Center |
| python3 exit 49 | 命令失败 | Microsoft Store stub | 用 `python` 代替 `python3` |
| QueryStatData error | API 失败 | query_list 含 budget | 去掉 budget 字段 |
| CSRF 错误 | 认证失败 | Cookie 过期 | 重新登录 Seller Center |
| WS 断开 | 连接中断 | 浏览器空闲断开 | 重新连接（自动重试） |

---

## 9. 更新日志

| 日期 | 条目 |
|------|------|
| 2026-06-12 | 初始版本 — 记录所有已知故障和解决方案 |
