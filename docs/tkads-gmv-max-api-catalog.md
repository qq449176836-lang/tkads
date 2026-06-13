# TK广告API架构 + 管理套件

## 🔑 最大发现：API格式分裂

| 类别 | 格式 | 示例API | 字段命名 |
|:----|:----|:--------|:--------|
| **广告管理类** | 传统JSON | `post_campaign_list`, `all_ad_data/update`, `campaign/update_status` | `start_time`, `end_time`, `query_list`, `campaign_id` |
| **统计素材类** | **`common_req`** 包装 | `post_video_over_view_stat` (已验证) | `st`, `et`, `metrics[]`, `dimensions[]`, `filters[]` |

### ✅ 已验证的API格式

**传统格式**（`post_campaign_list` 等）：
```json
{
  "query_list": ["campaign_id", "cost", "gmv", ...],
  "start_time": "2026-06-01", "end_time": "2026-06-13",
  "campaign_id": "xxx"
}
```

**common_req 格式**（`post_video_over_view_stat`）：
```json
{
  "common_req": {
    "st": "2026-06-06",                // 起始日期（不是start_time!）
    "et": "2026-06-13",                // 结束日期（不是end_time!）
    "dimensions": ["stat_time_day"],   // 维度
    "sort_stat": "stat_time_day",      // 排序字段
    "compare_st": "2026-05-29",        // 对比起始
    "compare_et": "2026-06-05",        // 对比结束
    "metrics": ["onsite_roi2_shopping_value", "total_videos_with_links",
                "total_authorized_videos", "total_creators_using_aca"],
    "filters": [{ "field": "ads_video_scenario", "filter_type": 10,
                  "in_field_values": ["2"] }],
    "extra": { "get_compare_rate": "1" }
  }
}
```

### ❌ 待破解的API（需通过CDP拦截获取正确参数）

| API | 格式推测 | 失败原因 |
|:----|:--------|:--------|
| `post_video_list` | common_req | code=1/3，内参不对 |
| `post_product_list` | common_req | code=3，缺必要字段 |
| `post_creator_list` | common_req | code=1/3，内参不对 |
| `post_creator_over_view_stat` | common_req | code=1，内参不对 |

**破解方法：** 在 `manage-analyze` 页点击对应Tab（视频/商品/达人），CDP捕获真实请求体。

---

## 一、架构概览

### 统一引擎
```
~/.tkads/tkads.js  ← v4 统一入口（32KB）
  ├── config-chain.js     ← 配置链
  ├── gate-engine.js      ← 7道门禁
  ├── hook-engine.js      ← 钩子
  ├── db_v2.py            ← 审计日志
  ├── api.py              ← API body构建
  ├── db.py               ← 数据库
  └── gmvmax-create-v4.cjs  ← 广告创建
```

### 配置
- Profile: `k1456ta2`
- SID: `7494105016200037977` | ADVID: `7569565674088136705`
- 语言: `zh`（中文）
- 浏览器自动WS检测+唤醒

---

## 二、API端点全集

### 2.1 广告管理（写操作·传统格式）

| 用途 | API | |
|:----|:----|:-|
| 列表 | `post_campaign_list` | CDP拦截·28字段 |
| 获取ad_id | `all_ad_data/detail?campaign_id=xxx` | |
| 创建广告 | `all_ad_data/create` | 响应含ad_id，需立即保存 |
| 修改ROI/预算 | `all_ad_data/update` | 需ad_id+start_time |
| 暂停/恢复/删除 | `campaign/update_status?op=1/2/3` | |

### 2.2 统计与素材

| 用途 | API | 格式 |
|:----|:----|:----:|
| 活动概览 | `post_overview_stat` | 传统✅ |
| 店铺整体 | `post_shop_overview_stat` | 传统✅ |
| 电商概览 | `post_ecomm_overview_stat` | 传统? |
| **素材概览** | **`post_video_over_view_stat`** | **common_req✅** |
| 素材列表 | `post_video_list` | common_req?❌ |
| 商品维度 | `post_product_list` | common_req?❌ |
| 达人列表 | `post_creator_list` | common_req?❌ |
| 达人概览 | `post_creator_over_view_stat` | common_req?❌ |
| 视频分析 | `post_video_analysis` + `video_anchors` | ? |
| 下载任务 | `download_task/query` | 传统✅ |

---

## 三、命令参考

### bash快捷命令（`source ~/.tkads/tkads.sh`）

```bash
tkads-list [天数]                 # 广告列表
tkads-pause <campaign_id>        # 暂停
tkads-resume <campaign_id>       # 恢复
tkads-update <id> <roi> [budget] # 修改ROI/预算
tkads-creatives                  # 素材概览（common_req）
tkads-products <id>              # 商品数据（CDP）
tkads-post <id> [mode]           # 视频分析
tkads-export [天数]               # 导出CSV
tkads-gmvrank <topN>             # GMV排名
```
