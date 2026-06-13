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
├── engine/                     # 核心引擎 (v4)
│   ├── tkads.js               # 统一引擎(自动唤醒+检测)
│   ├── api.py                 # API body构建
│   ├── db.py / db_v2.py       # 数据库操作
│   ├── config_chain.py        # 配置链
│   ├── gate-engine.js         # 7门禁引擎
│   ├── hook-engine.js         # 钩子引擎
│   ├── degrade-engine.js      # 降级引擎
│   ├── config-chain.js        # 配置链JS版
│   ├── gmvmax-create-v4.cjs   # 广告创建
│   └── tkads-catalog.json     # 版本化目录
├── evolution/                  # 双循环自进化引擎
│   ├── orchestrator.js        # 协调器(P1扫描/P2分析/P3加载)
│   ├── autoloader.js          # 技能使用频率分析+自动加载
│   ├── explorer.js            # GitHub技能探索
│   ├── reviewer.js            # 会话蒸馏
│   ├── update_autoloader.js   # 全量技能扫描维护
│   └── usage.json             # 技能使用统计
├── docs/                      # 架构文档
│   ├── tkads-v4-architecture.md
│   ├── tkads-automation.md
│   ├── tkads-daily-collection.md
│   ├── evolution-engine.md
│   ├── self-evolution.md
│   └── tkads-gmv-max-api-catalog.md   # API端点全量目录
├── notes/                     # 方法论知识库
│   ├── hermes-methodology/    # 29章方法论 + API目录
│   └── hermes-agent-knowledge/ # 官方文档解读
├── scripts/                   # 核心采集脚本
│   ├── daily-collect.py       # 每日采集入口
│   ├── daily-report.py        # 广告日报
│   ├── daily-creator-report.py # 达人日报
│   ├── e_logger.py            # E层日志系统
│   ├── e_log_viewer.py        # 日志查看器
│   ├── self_evolve_check.sh   # 自进化自检
│   └── ...
├── dashboard/                  # 数据看板
│   ├── server.py              # FastAPI 后端
│   ├── index.html             # 前端页面
│   └── db_config.py           # 数据库配置
├── skills/                    # Hermes Agent 技能
│   ├── ad-automation/gmvmax/
│   ├── data-collection/tkads-daily/
│   ├── hermes-evolution-engine/
│   └── hermes-self-evolve/
├── template/                  # 安装模板
├── setup.sh                   # 一键安装
├── SOP.md                     # 操作标准流程
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
