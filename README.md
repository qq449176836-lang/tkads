# TKADS v4

> TikTok Ads 自动化运营系统 — 数据采集 · 监控告警 · 双循环自进化 · Hermes Agent 技能库

[![GitHub](https://img.shields.io/badge/GitHub-tkads-blue)](https://github.com/qq449176836-lang/tkads)

## 📋 概述

TKADS v4 是一套完整的 TikTok Shop 自动化运营系统，专注 Hanmac.my（马来西亚站）母婴类目运营。

## 📁 目录结构

```
tkads/
├── collector/              📡 数据采集
│   ├── daily-collect.py           # 每日采集入口
│   ├── daily-report.py            # 广告日报
│   ├── daily-creator-report.py    # 达人日报
│   ├── collect_full_rankings.js   # 全量排名采集
│   ├── collect_daily_products.js  # 商品逐日数据
│   ├── collect_content_daily.js   # 内容拆分（直播/视频/商品卡）
│   ├── collect_product_analysis.js# 商品深度分析
│   └── tkads_daily.js            # 商品逐日采集（Puppeteer）
│
├── engine/                🏗️ 核心引擎
│   ├── tkads.js                   # 统一引擎（create/pause/resume/list）
│   ├── api.py                     # API body 构建
│   ├── db.py / db_v2.py           # 数据库 + 审计
│   ├── gate-engine.js             # 7 门禁引擎
│   ├── hook-engine.js             # 钩子引擎
│   ├── degrade-engine.js          # 降级引擎
│   ├── config-chain.js            # 配置链
│   ├── gmvmax-create-v4.cjs       # 广告创建（自动存 ad_id）
│   ├── tkads-browser.py           # 浏览器自动化
│   ├── tkads-puppeteer.js         # Puppeteer 工具
│   ├── tkads-create-spu.js        # SPU 搜索
│   └── tkads-update.js            # 广告更新
│
├── evolution/            🔄 自进化引擎
│   ├── orchestrator.js            # 协调器（P1扫描/P2分析/P3加载）
│   ├── autoloader.js              # 技能使用分析+自动加载
│   ├── explorer.js                # GitHub 技能探索
│   ├── reviewer.js                # 会话蒸馏
│   ├── update_autoloader.js       # 全量技能扫描工具
│   └── usage.json                 # 技能使用统计
│
├── scripts/              🛠️ 工具脚本
│   ├── monitor.py                 # 全能守护者
│   ├── catalog-check.js           # 目录校验
│   ├── e_logger.py                # E 层日志系统
│   ├── e_log_viewer.py            # 日志查看器
│   ├── store_config.py            # 店铺配置
│   ├── report_gen.py              # 报告生成
│   ├── deploy-monitor.cjs         # 守护者部署
│   └── ...
│
├── docs/                 📖 架构文档
│   ├── tkads-v4-architecture.md   # 整体架构
│   ├── tkads-gmv-max-api-catalog.md # API 端点全量目录
│   ├── evolution-engine.md        # 自进化引擎
│   ├── constitution.md            # 系统宪法
│   ├── operations.md              # 操作守则
│   ├── specification.md           # 技术规范
│   └── SOP.md                     # 标准操作流程
│
├── notes/                📚 知识库
│   ├── hermes-methodology/        # 29 章方法论
│   └── hermes-agent-knowledge/    # 官方文档解读
│
├── skills/               🎯 Hermes 技能
│   ├── ad-automation/gmvmax/
│   ├── data-collection/tkads-daily/
│   └── hermes-evolution-engine/
│
├── dashboard/            📈 数据看板
│   ├── server.py                 # FastAPI 后端
│   ├── index.html                # 前端页面
│   └── db_config.py              # 数据库配置
│
├── template/             📋 安装模板
├── setup.sh                     # 一键安装
└── README.md
```

## 🧠 底层架构

```
┌──────────┐   ┌──────────┐   ┌──────────┐
│  📡 采集层 │   │  🧠 分析层 │   │  🎯 执行层 │
│ collector/│──▶│ scripts/ │──▶│  engine/ │
└──────────┘   └──────────┘   └──────────┘
       │                            │
       └────── 🔄 evolution/ ───────┘
                   │
              🐕 watchdog (监控)
```

## 🔧 环境要求

- Python 3.10+
- Node.js 18+
- Hermes Agent
- AdsPower（浏览器自动化）
- PostgreSQL（可选，Dashboard 需要）
