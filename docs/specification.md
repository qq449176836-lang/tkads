# GMV Max 自动化 — 规格书 v4.0

> **📋 系统架构与技术规格**
>
> 版本：v4.0（2026-06-12）
> 适用店铺：Hanmac.my（马来西亚站，seller-my.tiktok.com）
> 技术栈：Node.js + Python + CDP (Chrome DevTools Protocol) + SQLite

---

## 1. 系统概述

TK Ads 自动化系统通过 CDP（Chrome DevTools Protocol）操控 AdsPower 浏览器内的 TikTok Seller Center，
实现 GMV Max 广告的完整生命周期管理：创建、读取、更新、暂停/恢复、删除。

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      Node.js 引擎层                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │config-   │  │hook-     │  │gate-     │  │degrade-  │   │
│  │chain.js  │  │engine.js │  │engine.js │  │engine.js │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────────────────────────────────────────────┐      │
│  │               tkads.js（统一入口）               │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
         │ CDP (puppeteer-core)
         ▼
┌─────────────────────────────────────────────────────────────┐
│                  AdsPower 浏览器                            │
│  ┌──────────────────────────────────────────────────┐      │
│  │          TikTok Seller Center 页面               │      │
│  │  (seller-my.tiktok.com)                          │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
         │ Cookie 认证
         ▼
┌─────────────────────────────────────────────────────────────┐
│              TikTok API 端点                               │
│  /oec_ads/shopping/v1/creation/...                        │
│  /oec_ads/shopping/v1/stat/...                            │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                  Python 层                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ db.py    │  │db_v2.py  │  │ api.py   │  │campaign.py│  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │ save_    │  │collect_  │  │report_   │                 │
│  │ meta.py  │  │day_by_   │  │gen.py    │                 │
│  │          │  │day.py    │  │          │                 │
│  └──────────┘  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    SQLite 数据库                            │
│  campaign_meta.db  │  analytics.db  │  ads.db              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 核心模块

### 2.1 统一引擎 — tkads.js

**路径：** `~/.tkads/tkads.js`
**语言：** Node.js (puppeteer-core)

核心入口脚本，自动检测 AdsPower 浏览器 WebSocket 地址，未运行时自动唤醒。

**支持命令：**

| 命令 | 格式 | 说明 |
|------|------|------|
| list | `tkads.ad.list [天数]` | 广告列表（默认30天） |
| pause | `tkads.ad.pause <campaign_id>` | 暂停广告 |
| resume | `tkads.ad.resume <campaign_id>` | 恢复广告 |
| update | `tkads.ad.update <id> <ROI> [budget]` | 修改 ROI/预算 |
| creatives | `tkads.creative.list` | 素材/达人概览 |
| products | `tkads.ad.products <campaign_id>` | 广告内商品数据 |
| post | `tkads.creative.post <video_id> [mode]` | 视频详情分析 |

### 2.2 配置链 — config-chain.js

**路径：** `~/.tkads/config-chain.js`

从 stores.json 加载配置的层级系统：
1. 系统默认值 → 2. stores.json 共享默认 → 3. 店铺特定配置

### 2.3 门禁引擎 — gate-engine.js

**路径：** `~/.tkads/gate-engine.js`

运行前检查所有约束条件：

| 门禁 | 说明 |
|------|------|
| `not_legacy` | 非遗留计划才允许修改 |
| `spu_available` | SPU 未被占用才允许创建 |
| `ad_type_modifiable` | 广告类型支持修改 |
| `ad_exists` | 广告真实存在 |
| `naming_rule` | 命名符合 `自动化-<SPU_ID>` 格式 |

### 2.4 钩子引擎 — hook-engine.js

**路径：** `~/.tkads/hook-engine.js`

操作生命周期钩子：pre-hook（执行前检查）→ 执行操作 → post-hook（记录结果）

### 2.5 降级引擎 — degrade-engine.js

**路径：** `~/.tkads/degrade-engine.js`

当主路径失败时尝试替代方案（例如 CDP `Runtime.evaluate` 被拦截时降级到 `Network.fetch` + CDP 拦截）。

### 2.6 创建脚本 — gmvmax-create-v4.cjs

**路径：** `~/.tkads/gmvmax-create-v4.cjs`

通过 UI 自动化 + CDP 拦截创建 GMV Max 广告。
创建完成后自动从 API 响应中提取 `ad_id`、`campaign_id`、`start_time` 并存入数据库。

---

## 3. API 端点全集

所有 API 通过 Seller Center 域名调用，使用浏览器 Cookie 认证。

### 3.1 广告管理

| 用途 | API 端点 | 方法 |
|------|----------|------|
| 广告列表 | `post_campaign_list` | POST |
| 广告详情/获取 ad_id | `all_ad_data/detail?campaign_id=xxx` | POST |
| 创建广告 | `all_ad_data/create` | POST |
| 修改 ROI/预算 | `all_ad_data/update` | POST |
| 暂停/恢复/删除 | `campaign/update_status?op=1/2/3` | POST |
| 高级设置 | `get_gmax_advanced_setting` | POST |
| 搜索商品 | `search_spu` | POST |
| 创建推荐 | `creation_recommendation` | POST |

### 3.2 统计与素材

| 用途 | API 端点 | 方法 |
|------|----------|------|
| 广告概览 | `post_overview_stat` | POST |
| 店铺整体统计 | `post_shop_overview_stat` | POST |
| 电商概览 | `post_ecomm_overview_stat` | POST |
| 商品维度 | `post_product_list` | POST |
| 素材列表 | `post_video_list` | POST |
| 素材概览 | `post_video_over_view_stat` | POST |
| 达人列表 | `post_creator_list` | POST |
| 达人概览 | `post_creator_over_view_stat` | POST |
| 视频分析 | `post_video_analysis`（逐日/逐帧） | POST |
| 视频关联 | `video_anchors` | POST |

### 3.3 通用请求参数

```
URL pattern:
  /oec_ads/shopping/v1/{category}/{endpoint}
  ?locale=zh&language=zh
  &oec_seller_id={sid}
  &aadvid={advid}

Headers:
  Content-Type: application/json
  x-csrftoken: <来自 Cookie 的 csrftoken>

Auth:
  通过浏览器 Cookie 传递认证信息
```

---

## 4. 数据库结构

### 4.1 campaign_meta.db

```sql
CREATE TABLE campaign_meta (
    campaign_id TEXT PRIMARY KEY,
    ad_id TEXT,
    start_time TEXT,
    spu_id TEXT
);
```

### 4.2 analytics.db

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

### 4.3 ads.db (SOP 时期遗留)

```sql
CREATE TABLE campaign_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT, campaign_name TEXT,
    status TEXT, budget REAL, roi REAL,
    cost REAL, orders INTEGER, revenue REAL,
    snapshot_date TEXT
);

CREATE TABLE tz_mappings (
    campaign_id TEXT PRIMARY KEY,
    custom_tz_id TEXT
);

CREATE TABLE operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT, action_type TEXT,
    campaign_id TEXT, details TEXT
);
```

---

## 5. 数据采集流程

### 每日数据采集

脚本：`~/.tkads/collect_day_by_day.py`

```
1. 连接 AdsPower 浏览器（自动启动）
2. 遍历最近30天（或指定范围），对每天：
   a. 在 Seller Center 页面用 page.evaluate() 调用 fetch()
   b. POST /post_overview_stat (start_time = end_time = 当天)
   c. 解析 data.statistics
   d. INSERT OR REPLACE INTO daily_stats
3. 输出汇总（总消耗、订单、收入、平均ROI）

API 参数:
  - campaign_shop_automation_type: 2
  - external_type_list: ["307", "304", "305"]
  - query_list: ["cost","onsite_roi2_shopping_sku","onsite_roi2_shopping_value","onsite_roi2_shopping"]
```

---

## 6. 配置管理

### stores.json — 单一事实源

**路径：** `~/.tkads/stores.json`

```json
{
  "version": "1.0",
  "active_store": "hanmac",
  "defaults": { "budget": 20, "roi_target": 1.2 },
  "constitution": { "rules": [ 5条宪法 ] },
  "stores": {
    "hanmac": {
      "shop_name": "Hanmac.my",
      "seller_domain": "seller-my.tiktok.com",
      "profile_id": "k1456ta2",
      "sid": "7494105016200037977",
      "aadvid": "7569565674088136705",
      "ads_url": "http://local.adspower.net:50325",
      "country": "MY",
      "currency": "USD",
      "timezone": "Asia/Shanghai"
    }
  }
}
```

---

## 7. 关键文件清单

| 文件 | 路径 | 说明 |
|------|------|------|
| tkads.js | `~/.tkads/tkads.js` | 统一引擎（自动WS检测+唤醒） |
| tkads.sh | `~/.tkads/tkads.sh` | bash 别名入口（命名空间命令） |
| config-chain.js | `~/.tkads/config-chain.js` | 配置链加载 |
| gate-engine.js | `~/.tkads/gate-engine.js` | 门禁检查引擎 |
| hook-engine.js | `~/.tkads/hook-engine.js` | 生命周期钩子 |
| degrade-engine.js | `~/.tkads/degrade-engine.js` | 降级引擎 |
| gmvmax-create-v4.cjs | `~/.tkads/gmvmax-create-v4.cjs` | 创建广告（自动存ad_id） |
| collect_day_by_day.py | `~/.tkads/collect_day_by_day.py` | 按天逐日采集 |
| db.py | `~/.tkads/db.py` | 数据库操作模块 |
| db_v2.py | `~/.tkads/db_v2.py` | 审计日志模块 |
| api.py | `~/.tkads/api.py` | API body 构建 |
| report_gen.py | `~/.tkads/report_gen.py` | 报表生成器 |
| stores.json | `~/.tkads/stores.json` | 配置单一事实源 |

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v4.0 | 2026-06-12 | 统一引擎 tkads.js + 四引擎架构（config/gate/hook/degrade） |
| v3.0 | 2026-06-10 | tkads_daily.js + Python 报表生成器 + SOP 文档 |
| v2.0 | 2026-05-XX | adspower-gmvmax 脚本集成 |
| v1.0 | 2026-05-XX | 初始版本：基本 CDP 操控 |
