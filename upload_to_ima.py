#!/usr/bin/env python3
"""创建IMA笔记并添加到知识库"""
import json, urllib.request, urllib.error, sys, os

CLIENT_ID = open(os.path.expanduser('~/.config/ima/client_id')).read().strip()
API_KEY = open(os.path.expanduser('~/.config/ima/api_key')).read().strip()
BASE = 'https://ima.qq.com'
KB_ID = '_MhKoAmsiL5d_cn5L-6g5Anay2jd-yYk1v4Cv-EMQYo='

def ima_api(path, body):
    url = f'{BASE}/{path}'
    headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'ima-openapi-clientid': CLIENT_ID,
        'ima-openapi-apikey': API_KEY,
    }
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {'code': -1, 'msg': f'HTTP {e.code}: {e.read().decode()}'}
    except Exception as e:
        return {'code': -1, 'msg': str(e)}

# ========= 笔记1: GMV Max 广告自动化管理 =========
content1 = r"""# TK Ads GMV Max 广告自动化管理套件

> 基于 CDP（Chrome DevTools Protocol）操控 AdsPower 浏览器内的 TikTok Seller Center，实现 GMV Max 广告的完整生命周期管理。

## 技术栈与依赖

| 项目 | 说明 |
|------|------|
| AdsPower API | `http://local.adspower.net:50325` 管理浏览器 |
| puppeteer-core | Node.js CDP 客户端 |
| Python 3.12 | 数据库操作、API body 构建 |
| SQLite | `campaign_meta.db` + `analytics.db` |
| 浏览器 | Profile `k1456ta2` |

**环境变量：**
- SID（oec_seller_id）: `7494105016200037977`
- ADVID（aadvid）: `7569565674088136705`
- Seller Center 域名: `seller-my.tiktok.com`

---

## 统一引擎 tkads.js

核心文件 `~/.tkads/tkads.js`，所有命令通过它执行。

**自动检测 WebSocket**：无需硬编码 WS 地址，脚本自动调用 AdsPower API 获取浏览器状态，未运行时自动启动。

**核心连接模式：**
```
Node.js → AdsPower API (HTTP) → 获取 WS URL → puppeteer.connect(ws)
→ CDP Session → Network.enable → 拦截响应 / page.evaluate → 发 API 请求
```

两种操作方式：
1. **CDP 拦截**：监听 `Network.responseReceived` 捕获真实 API 响应
2. **page.evaluate**：在页面中执行 `fetch()` 发送 POST 请求（利用已有 Cookie 认证）

---

## 命令参考

通过 bash 别名调用（`source ~/.tkads/tkads.sh` 后可用）：

### list [天数]
查看广告列表，默认近30天。显示状态、目标ROI、实际ROI、消耗、订单、收入、预算。
- API：`post_campaign_list`（CDP 拦截）
- 参数：`campaign_shop_automation_type: 2`，`external_type_list: ["304", "307"]`

### pause <campaign_id>
暂停广告。API：`campaign/update_status?op=2`

### resume <campaign_id>
恢复广告。API：`campaign/update_status?op=1`

### update <campaign_id> <ROI> [budget]
修改 ROI 和/或预算。必须先有 ad_id（通过 `all_ad_data/detail?campaign_id=xxx` 获取）。
- API：`all_ad_data/update`
- 创建时通过 `all_ad_data/create` 响应捕获 ad_id，存入 `campaign_meta` 表

**重要规则：**
- ✅ 已有数据的老广告不要改 ROI/预算，让平台学习
- ❌ Product GMV Max 和商品 GMV Max 类型无法修改（系统自动类型）
- ✅ 创建后立即保存响应的 ad_id

### creatives
查看素材/达人概览（30天数据）。
API 链：`post_video_over_view_stat` → `post_video_list` → `post_creator_list` → `post_creator_over_view_stat`

### products <campaign_id>
查看广告内商品数据。API：`post_product_list`

### post <video_id> [mode]
视频详情分析。
- mode=`time_series`（默认）：视频每日数据
- mode=`frame`：Frame by frame 每秒数据
- mode=`all`：全部
- API：`post_video_analysis` + `video_anchors`

---

## API 端点全集（18+个）

### 广告管理
| 用途 | API |
|------|-----|
| 列表 | `post_campaign_list` |
| 获取 ad_id | `all_ad_data/detail?campaign_id=xxx` |
| 创建广告 | `all_ad_data/create`（响应含 ad_id） |
| 修改 ROI/预算 | `all_ad_data/update` |
| 暂停/恢复/删除 | `campaign/update_status`（op=1/2/3） |
| 高级设置 | `get_gmax_advanced_setting` |
| 搜索商品 | `search_spu` |
| 创建推荐 | `creation_recommendation` |

### 统计与素材
| 用途 | API |
|------|-----|
| 广告概览 | `post_overview_stat` |
| 店铺整体统计 | `post_shop_overview_stat` |
| 电商概览 | `post_ecomm_overview_stat` |
| 商品维度 | `post_product_list` |
| 素材列表 | `post_video_list` |
| 素材概览 | `post_video_over_view_stat` |
| 达人列表 | `post_creator_list` |
| 达人概览 | `post_creator_over_view_stat` |
| 视频分析 | `post_video_analysis`（逐日/逐帧） |
| 视频关联 | `video_anchors` |

---

## 数据库结构

### campaign_meta.db（广告元数据）
```sql
CREATE TABLE campaign_meta (
    campaign_id TEXT PRIMARY KEY,
    ad_id TEXT,
    start_time TEXT,
    spu_id TEXT
);
```

### analytics.db（分析数据）
```sql
CREATE TABLE daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    cost REAL DEFAULT 0,
    orders INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    roi REAL DEFAULT 0
);

CREATE TABLE posts (
    post_id TEXT PRIMARY KEY,
    username TEXT, revenue REAL, orders INTEGER,
    cost REAL, roi REAL, impressions INTEGER, clicks REAL,
    click_rate REAL, data_range TEXT
);

CREATE TABLE creators (
    username TEXT, revenue REAL, orders INTEGER,
    impressions INTEGER, clicks REAL, click_rate REAL,
    data_range TEXT
);
```

---

## 关键文件清单

| 文件 | 路径 | 说明 |
|------|------|------|
| tkads.js | `~/.tkads/tkads.js` | 统一引擎（自动WS检测） |
| tkads.sh | `~/.tkads/tkads.sh` | bash 别名入口 |
| tkads-update.js | `~/.tkads/tkads-update.js` | 兼容调用层 |
| gmvmax-create-v4.cjs | `~/.tkads/gmvmax-create-v4.cjs` | 创建广告（自动存 ad_id） |
| collect_day_by_day.py | `~/.tkads/collect_day_by_day.py` | 按天逐日采集 |
| db.py | `~/.tkads/db.py` | 数据库操作模块 |
| api.py | `~/.tkads/api.py` | API body 构建 |

---

## 注意事项

### 不要做的事
- ❌ 已有数据的老广告不要改 ROI/预算（让平台学习）
- ❌ 不要修改 Product GMV Max 和商品 GMV Max 类型的广告
- ❌ 创建广告前不检查 SPU 占用会导致冲突
- ❌ 不要通过 Ads Manager 操作，所有操作必须在 Seller Center 完成

### 最佳实践
- ✅ 所有 API 请求加通用 query 参数：`locale=zh&language=zh&oec_seller_id={sid}&aadvid={advid}`
- ✅ auth 通过 Cookie 中的 `csrftoken` + `x-csrftoken` header
- ✅ 创建广告后立即保存响应的 ad_id（通过 CDP 拦截）
"""

print("📝 创建笔记1: GMV Max 广告自动化管理套件...")
resp1 = ima_api('openapi/note/v1/import_doc', {
    'content_format': 1,
    'content': content1,
    'title': 'TK Ads GMV Max 广告自动化管理套件'
})
print(json.dumps(resp1, ensure_ascii=False, indent=2))

if resp1.get('code') == 0 and resp1.get('data', {}).get('note_id'):
    note_id1 = resp1['data']['note_id']
    print(f"✅ 笔记1创建成功，note_id: {note_id1}")
    
    # 添加到知识库
    print("\n📎 添加笔记1到知识库 阿里云-AI...")
    resp_kb1 = ima_api('openapi/wiki/v1/add_knowledge', {
        'media_type': 11,
        'title': 'TK Ads GMV Max 广告自动化管理套件',
        'knowledge_base_id': KB_ID,
        'note_info': {'content_id': note_id1}
    })
    print(json.dumps(resp_kb1, ensure_ascii=False, indent=2))
    if resp_kb1.get('code') == 0:
        print("✅ 笔记1已添加到知识库")
    else:
        print(f"❌ 添加失败: {resp_kb1.get('msg')}")
else:
    print(f"❌ 笔记1创建失败: {resp1.get('msg')}")

# ========= 笔记2: 每日数据采集 =========
content2 = r"""# TK Ads GMV Max 广告每日数据采集

> 基于 CDP 操控 AdsPower 浏览器内的 TikTok Seller Center，逐日调用 `post_overview_stat` API 获取单日 GMV Max 广告数据（非店铺整体数据）。
> 技术栈：Python + Node.js (puppeteer-core) + SQLite

## 原理

TikTok Seller Center Dashboard 页面的 `post_overview_stat` API 支持设置 `start_time` 和 `end_time`：

- **多日范围**（start ≠ end）：返回 `data.table[]`（每日一行）
- **单日范围**（start = end）：返回 `data.statistics`（单日汇总）

将30天分别调用单日API，获取每一天的精确数据。

---

## 脚本位置

`~/.tkads/collect_day_by_day.py`

## 核心参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `campaign_shop_automation_type` | `2` | GMV Max 类型 |
| `external_type_list` | `["307", "304", "305"]` | 广告子类型 |
| `query_list` | `["cost","onsite_roi2_shopping_sku","onsite_roi2_shopping_value","onsite_roi2_shopping"]` | 请求字段 |

---

## 用法

```bash
# 采集最近30天
python ~/.tkads/collect_day_by_day.py

# 指定日期范围
python ~/.tkads/collect_day_by_day.py 2026-05-12 2026-06-11

# 补采单天（自动跳过已有）
python ~/.tkads/collect_day_by_day.py 2026-06-12 2026-06-12
```

## 数据库

数据存入 `~/.tkads/data/analytics.db` 的 `daily_stats` 表：

```sql
CREATE TABLE daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    cost REAL DEFAULT 0,
    orders INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    roi REAL DEFAULT 0
);
```

---

## 工作流

1. **连接浏览器** — 通过 AdsPower API 获取/启动浏览器 WS 地址
2. **遍历日期** — 对每一天分别执行：
   - 在 Seller Center 页面用 `page.evaluate()` 调用 `fetch()` 发送 API 请求
   - `start_time = end_time = 当天`
   - 解析 `data.statistics`（单日）或 `data.table[0]`（多日）
3. **入库** — `INSERT OR REPLACE INTO daily_stats`
4. **输出汇总** — 总消耗、订单、收入、平均ROI

---

## 注意事项

- 浏览器必须已登录 Seller Center（脚本会自动寻找已有页面或打开新页面）
- 单日API返回 `data.statistics` 格式，多日返回 `data.table[]`，两种格式都需要处理
- 今天的数据会持续更新，不同时间采集结果可能略有差异
- 每次调用间隔 1 秒避免限流
- 脚本会自动跳过数据库中已有的日期（增量采集）

---

## 文件清单

| 文件 | 路径 | 说明 |
|------|------|------|
| `collect_day_by_day.py` | `~/.tkads/collect_day_by_day.py` | 主采集脚本 |
| `analytics.db` | `~/.tkads/data/analytics.db` | SQLite 数据库 |
"""

print("\n\n📝 创建笔记2: GMV Max 广告每日数据采集...")
resp2 = ima_api('openapi/note/v1/import_doc', {
    'content_format': 1,
    'content': content2,
    'title': 'TK Ads GMV Max 广告每日数据采集'
})
print(json.dumps(resp2, ensure_ascii=False, indent=2))

if resp2.get('code') == 0 and resp2.get('data', {}).get('note_id'):
    note_id2 = resp2['data']['note_id']
    print(f"✅ 笔记2创建成功，note_id: {note_id2}")
    
    # 添加到知识库
    print("\n📎 添加笔记2到知识库 阿里云-AI...")
    resp_kb2 = ima_api('openapi/wiki/v1/add_knowledge', {
        'media_type': 11,
        'title': 'TK Ads GMV Max 广告每日数据采集',
        'knowledge_base_id': KB_ID,
        'note_info': {'content_id': note_id2}
    })
    print(json.dumps(resp_kb2, ensure_ascii=False, indent=2))
    if resp_kb2.get('code') == 0:
        print("✅ 笔记2已添加到知识库")
    else:
        print(f"❌ 添加失败: {resp_kb2.get('msg')}")
else:
    print(f"❌ 笔记2创建失败: {resp2.get('msg')}")

print("\n🎉 全部完成！")
