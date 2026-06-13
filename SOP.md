# TK Ads 自动化运营 SOP

> 适用店铺：Hanmac.my（马来西亚站）
> 时区：Australian Western Standard Time (UTC+08:00)
> 工具版本：tkads v1.0 (2026-06-10)

---

## 一、系统架构

```
~/.tkads/
├── tkads_daily.js        ← 主执行脚本（采集+报表）
├── save_snapshot.py       ← 数据持久化（被JS调用）
├── report_gen.py          ← 报表生成器
├── db.py                  ← SQLite 数据库层
├── api.py                 ← API 调用封装
├── campaign.py            ← 广告操作封装
├── data/
│   └── ads.db            ← 数据库文件
└── reports/               ← 报表输出目录
```

### 数据库表结构

| 表名 | 用途 |
|------|------|
| `campaign_snapshots` | 广告每日快照（ID/名称/状态/预算/ROI/花费） |
| `tz_mappings` | 时区配置映射（campaign_id ↔ custom_tz_id） |
| `operation_logs` | 操作日志（创建/暂停/修改/采集等） |

---

## 二、自动化能力清单

### ✅ 已实现（可直接使用）

| 功能 | 方式 | 命令 |
|------|------|------|
| 📊 数据采集 | API `post_campaign_list` | `node ~/.tkads/tkads_daily.js` |
| 📈 日报 | Python 报表生成 | `node ~/.tkads/tkads_daily.js --report daily` |
| 📈 周报 | Python 报表生成 | `node ~/.tkads/tkads_daily.js --report weekly` |
| 📈 月报 | Python 报表生成 | `node ~/.tkads/tkads_daily.js --report monthly` |
| ⏸️ 暂停广告 | API `update_status op=2` | 在 `api.py` 中调用 `update_status(cid, 2)` |
| ▶️ 恢复广告 | API `update_status op=1` | 在 `api.py` 中调用 `update_status(cid, 1)` |
| 🗑️ 删除广告 | API `update_status op=3` | 在 `api.py` 中调用 `update_status(cid, 3)` |
| 🆕 创建广告 | UI 自动化 (gmvmax-create.cjs v3.0) | `node gmvmax-create.cjs --roi 5.6 --budget 200 --name "广告名"` |

### ⚠️ 部分实现

| 功能 | 状态 | 说明 |
|------|:----:|------|
| ✏️ 修改 ROI | 需配合 | 需要 body 含 name + custom_tz_id，API 已可调用但需完整字段 |

### ❌ 不支持

| 功能 | 原因 |
|------|------|
| 广告详细报表（展现/点击/CTR） | Seller Center API 不暴露 |
| 自动优化出价 | 缺少细粒度转化数据 |
| 跨平台操作（Ads Manager） | 用户要求仅通过 Seller Center 操作 |

---

## 三、API 技术参数

### 3.1 读取广告列表

```
POST /oec_ads/shopping/v1/oec/stat/post_campaign_list
 ?locale=zh&language=zh
 &oec_seller_id=7494105016200037977
 &aadvid=7569565674088136705

Headers: Content-Type: application/json, x-csrftoken: <cookie中的csrftoken>
Body: {
  "query_list": ["campaign_name","campaign_primary_status","campaign_id","cost","campaign_target_roi_budget","create_time"],
  "page": 1, "page_size": 200
}
```

⚠️ 注意：`query_list` 中不能包含 `budget` 字段，否则报 `QueryStatData error`。

### 3.2 暂停/恢复/删除

```
POST /oec_ads/shopping/v1/creation/campaign/update_status
 ?locale=zh&language=zh&oec_seller_id=...&aadvid=...

Body: { "campaign_list": ["campaign_id"], "operation": 1|2|3 }
```

- operation=1: 启动
- operation=2: 暂停
- operation=3: 删除

### 3.3 修改 ROI

```
POST /oec_ads/shopping/v1/creation/all_ad_data/update
 ?locale=zh&language=zh&oec_seller_id=...&aadvid=...

Body 必须包含：
  campaign_info: { campaign_id, name, budget, budget_mode, custom_tz_id, ... }
  ad_info: { ad_id, name, custom_tz_id, custom_tz_type, roas_bid, ... }
  roas_bid: string
```

| 参数 | 值 |
|------|-----|
| custom_tz_id | `7473424031757336583`（Australian Western Standard Time 选项ID） |
| custom_tz_type | `1` |
| oec_seller_id | `7494105016200037977` |
| aadvid | `7569565674088136705` |
| shop_id | `7494105016200037977` |
| shop_authorized_bc | `7545376144372318224` |
| ad_id = campaign_id | 是的，两者相同 |

### 3.4 创建广告（UI 自动化）

使用 `gmvmax-create.cjs`（v3.0），需要浏览器已打开并登录。

```
node ~/.hermes/skills/ecommerce/adspower-gmvmax/scripts/gmvmax-create.cjs \
  --roi 5.6 \
  --budget 200 \
  --name "Hanmac_商品名_日期"
```

当前 UI 为英文版，ROI 为单选按钮（预设值 3.4 / 5.6 / 7.5）。

---

## 四、数据库操作

### 查看所有广告快照
```python
python -c "import sys, os; sys.path.insert(0, os.path.expanduser('~/.tkads')); import db; rows=db.get_latest_snapshots(); [print(r['campaign_name'], r['cost'], r['status']) for r in rows]"
```

### 查看时区映射
```python
python -c "import sys, os; sys.path.insert(0, os.path.expanduser('~/.tkads')); import db; rows=db.get_conn().execute('SELECT * FROM tz_mappings').fetchall(); [print(r['campaign_id'], r['custom_tz_id']) for r in rows]"
```

### 查看操作日志
```python
python -c "import sys, os; sys.path.insert(0, os.path.expanduser('~/.tkads')); import db; rows=db.get_recent_ops(72); [print(r['timestamp'], r['action_type'], r.get('campaign_id','')) for r in rows]"
```

---

## 五、定时任务

### 日报（每天 9:00）
```
30 1 * * * cd ~ && node ~/.tkads/tkads_daily.js --report daily >> ~/.tkads/logs/daily.log 2>&1
```

### 周报（每周一 9:30）
```
30 1 * * 1 cd ~ && node ~/.tkads/tkads_daily.js --report weekly >> ~/.tkads/logs/weekly.log 2>&1
```

### 月报（每月 1 日 10:00）
```
0 2 1 * * cd ~ && node ~/.tkads/tkads_daily.js --report monthly >> ~/.tkads/logs/monthly.log 2>&1
```

---

## 六、故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| `QueryStatData error` | query_list 中包含 `budget` 字段 | 去掉 budget 字段 |
| API 返回 0 个广告 | 页面 URL 包含 `type=product` | 确保 query_list 正确，API 在 type=product 下也可用 |
| CSRF 错误 | csrftoken cookie 过期 | 重新登录 |
| 浏览器未运行 | AdsPower 关闭 | 自动重启（脚本已处理） |
| 创建广告失败 | UI 版本更新 | 检查 ROI 输入方式（单选/文本）、按钮文字（中/英文） |
