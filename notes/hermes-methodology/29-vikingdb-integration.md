# 二十九、VikingDB 双库集成

> 返回 [目录](../README.md) | [Hermes Methodology](https://github.com/qq449176836-lang/hermes-methodology)

---

## 二十九、VikingDB 双库集成

VikingDB 是火山引擎向量数据库，作为 N 层（精炼笔记）的云端存储实现，
替代已废弃的 IMA 知识库，提供语义搜索能力。

### 双库架构

```
┌─────────────────────────────────────────────────────────┐
│                   VikingDB 同一资源                      │
│               resource_id = kb-8b2019695282e94b          │
├────────────────────────┬────────────────────────────────┤
│   📖 知识库             │   🧠 记忆库                    │
│   ali_guangzhou_hermes_│   ali_guangzhou_hermes_memory  │
│   notes                │                                │
├────────────────────────┼────────────────────────────────┤
│   存: 方法论文档、笔记   │   存: 运营经验、每日复盘、     │
│       技术方案、规范     │       关键决策、踩坑记录       │
│   搜索: search 命令      │   搜索: memory search 命令     │
│   更新: 每日23:45 sync   │   更新: 复盘写入+手动随时写   │
└────────────────────────┴────────────────────────────────┘
```

### 认证方式

- **唯一认证：** `VIKING_SERVICE_API_KEY`（HTTP API Key）
- 所有凭证存储在 `~/.tkads/.env`，脚本自动加载

### 主要命令

```bash
# 初始化/检查连接
node ~/tkads-scripts/vikingdb.js init

# 查看状态
node ~/tkads-scripts/vikingdb.js status

# 知识库搜索
node ~/tkads-scripts/vikingdb.js search "<问题>"

# 知识库同步（本地笔记→云端）
node ~/tkads-scripts/vikingdb.js sync

# 记忆库写入
node ~/tkads-scripts/vikingdb.js memory write "<标题>" <内容>

# 记忆库搜索
node ~/tkads-scripts/vikingdb.js memory search "<关键词>"

# 记忆库列表
node ~/tkads-scripts/vikingdb.js memory list
```

### 自动同步机制

| 时间 | 任务 | 做什么 |
|:----:|------|--------|
| 23:30 | 每日复盘 | 复盘总结后自动写一条记忆到记忆库 |
| 23:45 | 知识库同步 | 检测笔记变更，同步到知识库 |

### 记忆写入策略

- **重要事件**（修 bug、发现新 API、改配置、策略决策）→ **对话中立即写入**，不等复盘
- **每日复盘** → 保底每天 1 条
- **手动触发** → 随时说"记一条"或"上传知识库"

### 三层检索中的位置

四层检索中的 **Level 4**，当前三层（精确匹配→语义扩展→Skill库）都未命中时，
通过 VikingDB 在历史笔记和记忆中进行语义搜索，避免从零推理。

### 优雅降级

```
VikingDB 连不上 → 降级到本地文件搜索（~/.tkads/notes/ 和 ~/.tkads/operation_log/）
```

---
