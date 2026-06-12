# TKADS v4

> TikTok Ads 自动化运营系统 — 数据采集 · 监控告警 · 双循环自进化 · Hermes Agent 技能库

## 📋 概述

TKADS v4 是一套完整的 TikTok Shop 自动化运营系统，包含：

| 模块 | 说明 |
|---|---|
| 🔄 **双循环自进化引擎** | 每2小时快速优化 + 每日23:00深度进化 |
| 📊 **数据采集** | 全量店铺排名 / 商品分析 / 内容拆分 / 广告数据 |
| 🚨 **监控告警** | 系统健康检查 + 异常自动修复 |
| 🧠 **Hermes 技能库** | 标准化的 AI Agent 工作流 |
| 📈 **Dashboard** | PostgreSQL + FastAPI 看板 |

## 🚀 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/qq449176836-lang/tkads.git
cd tkads

# 2. 运行安装脚本
bash setup.sh

# 3. 配置环境
cp template/env.example .env
# 编辑 .env 填入 GitHub Token 等配置
vim .env

# 4. 配置店铺
cp template/stores.example.json scripts/stores.json
# 编辑 stores.json 填入店铺信息

# 5. 测试采集
python scripts/daily-collect.py
```

## 📁 目录结构

```
tkads/
├── docs/                      # 架构文档
│   ├── tkads-v4-architecture.md
│   ├── tkads-automation.md
│   ├── tkads-daily-collection.md
│   ├── evolution-engine.md
│   └── self-evolution.md
├── scripts/                   # 核心脚本
│   ├── daily-collect.py       # 每日采集入口
│   ├── collect_full_rankings.js    # 店铺全量排名采集
│   ├── collect_daily_products.js   # 商品逐日数据采集
│   ├── collect_product_analysis.js  # 商品深度分析采集
│   ├── collect_content_daily.js     # 内容拆分（LIVE/视频/商品卡）
│   ├── daily-report.py        # 广告日报自动推送
│   ├── daily-creator-report.py # 达人日报自动推送
│   ├── compass_api_explore.js  # API字段探索工具
│   ├── store_config.py        # 店铺配置管理
│   ├── store_utils.py         # 店铺工具函数
│   ├── config_chain.py        # 配置链
│   ├── self-evolve.js         # 自进化引擎
│   ├── catalog-check.js       # 目录校验
│   ├── monitor.py             # 系统监控
│   └── ...
├── dashboard/                  # 数据看板
│   ├── server.py              # FastAPI 后端
│   ├── index.html             # 前端页面(5个Tab)
│   └── db_config.py           # 数据库配置
├── skills/                    # Hermes Agent 技能
│   ├── ad-automation/gmvmax/  # 广告自动化
│   ├── data-collection/tkads-daily/
│   ├── hermes-evolution-engine/
│   └── hermes-self-evolve/
├── template/                  # 安装模板
│   ├── env.example
│   └── stores.example.json
├── setup.sh                   # 一键安装
└── README.md
```

## 🧠 认知进化系统

TKADS v4 基于 Hermes 认知进化方法论运作：

```
三层检索：精配 → 语义 → 搜库
三级沉淀：E 日志 → N 笔记 → P 技能
三频复盘：日回顾 → 周提炼 → 月固化
```

详见 [`docs/tkads-v4-architecture.md`](docs/tkads-v4-architecture.md)

## 🔧 环境要求

- Python 3.10+
- Node.js 18+（可选，部分 JS 脚本）
- PostgreSQL（可选，Dashboard 需要）
- Hermes Agent（可选，自动化调度需要）

## 📄 License

MIT
