# Hermes 自进化引擎

## 架构

```
Cron 每日 23:00
  ↓ 启动新的 agent 会话
  ↓ terminal: node orchestrator.js
      │
      ├── 📡 Phase 1: Explorer
      │     └─ curl GitHub API → 搜 agent skills / SDD / 开发工具
      │     └─ 评分 (1-10) → >=8 分的结果在飞书报告里标注
      │
      ├── 📊 Phase 2: AutoLoader
      │     └─ 读 usage.json → 高频技能 (>=10次 / 近3天使用)
      │     └─ 自动升级为 auto_load
      │     └─ 30天未使用 → 标记 deprecation
      │
      ├── 📝 Phase 3: Reviewer
      │     └─ operation_log_v2 → 今日新增了什么能力
      │     └─ 修复了什么错误
      │     └─ 学到了什么模式
      │     └─ 生成 memory-save 清单
      │
      └── 📬 Phase 4: 飞书推送简报
```

## 文件结构

```
~/.tkads/evolution/
├── orchestrator.js     — 总编排器（入口）
├── explorer.js         — 搜索外部资源 + 评分
├── autoloader.js       — 技能使用频率追踪 + 自动升级
├── reviewer.js         — 会话蒸馏 + memory 提取
├── usage.json          — 技能使用数据库
├── autoload.sh         — 自动生成的加载脚本
├── explorer_cache.json — GitHub 搜索缓存 (24h TTL)
└── reviews/            — 每日蒸馏存档
    └── YYYY-MM-DD.json
```

## 与 self-evolve.js 的关系

| | self-evolve.js | evolution-engine |
|---|---|---|
| 方向 | 内向防守 | 外向学习 |
| 频率 | 每2小时 | 每日23:00 |
| 检查 | catalog 61项完整性 | 搜外部新东西 |
| 修复 | 路径/版本/日志 | 技能升级/经验蒸馏 |
| 结果 | 修 catalog 报错 | 推飞书新发现 |

两者不冲突，互补。self-evolve 保系统稳定，evolution 保能力进化。

## 每日报告示例

```
🌱 hermes-evolution-engine 每日进化报告
━━━━━━━━━━━━━━━━━━━━━━
📡 Explorer: ✅ 找到 29 个 ≥8 分结果
📊 AutoLoader: ✅ tkads-ad-automation 已 auto_load
📝 Reviewer: ✅ 今日新增 3 个能力，修复 0 个错误
⏱ 耗时: 2.3s
━━━━━━━━━━━━━━━━━━━━━━
```
