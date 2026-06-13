# Hermes Agent 核心知识库 — N层笔记

## 来源信息

- **仓库**: `qq449176836-lang/hermes-agent-knowledge` (GitHub)
- **下载日期**: 2026-06-13
- **文件数**: 8 个核心文档
- **协议**: 公开仓库

## 文件清单

| # | 文件名 | 中文名 | 行数 | 一句话摘要 |
|---|--------|--------|------|-----------|
| 1 | `CONSTITUTION.md` | 宪章 | 102 | Agent 的行为边界、安全底线与操作规范 —— 三层规则体系（🔴铁律 > 🟡约定 > 🟢建议） |
| 2 | `EVOLUTION-ENGINE.md` | 进化引擎 | 199 | 让 Agent 像生物体一样自我进化：感知环境变化 → 内化新能力 → 复盘并固化经验 |
| 3 | `EXPERIENCE-LIFECYCLE.md` | 经验生命周期 | 206 | 经验的完整旅程：从单次遭遇 → 蒸馏提炼 → 检索消费 → 固化技能 |
| 4 | `KNOWLEDGE-CRYSTALLIZATION.md` | 知识结晶化 | 168 | 经验如何从一次对话变成永久知识：三层蒸馏 + 分层归档 + 衰减管理 |
| 5 | `METHODOLOGY.md` | 方法论 | 204 | Agent 面对问题的思考框架：如何检索、如何拆解、如何执行、如何闭环 |
| 6 | `MULTI-AGENT-COORDINATION.md` | 多Agent协调 | 210 | 四层架构 + 审查协调分离 + 问题部门间闭环的多Agent协作协议 |
| 7 | `OPERATIONS.md` | 实战守则 | 238 | 数百次真实任务的踩坑经验与操作守则，每条背后都有一段血泪史 |
| 8 | `SPEC-DRIVEN-DEV.md` | 规约驱动开发 | 186 | "先定宪法，再写法律；先写规格，再写代码" —— 7阶段不可逆管道 |

## 与E层/N层体系的关联

### 知识流动路径

```
经验发生 (E层操作日志记录)
    ↓ 蒸馏
日常笔记 (N层笔记 · ~/.tkads/notes/)
    ↓ 结晶化
Hermes Agent 核心知识 (本目录)
    ↓ 固化
可复用 Skill (P层 · ~/.hermes/profiles/default/skills/)
```

### E层对接

E层日志使用 `~/.tkads/scripts/e_logger.py` 记录知识导入事件，与 `~/.tkads/operation_log/` 中的结构化日志关联。

### N层位置

本目录作为 N层笔记 的子目录，遵循 `~/.tkads/notes/` 下的 Markdown 知识管理规范。所有文档可直接被 Agent 在日常工作中检索和引用。
