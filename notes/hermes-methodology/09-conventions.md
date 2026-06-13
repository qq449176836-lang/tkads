# 九、约定与规范

> 返回 [目录](../README.md) | [Hermes Methodology](https://github.com/qq449176836-lang/hermes-methodology)

---

## 九、约定与规范

### 9.1 语言约定

| 场景 | 语言 | 说明 |
|---|---|---|
| 与用户沟通 | 中文 | 除非用户指定其他语言 |
| 技术输出 | 中文为主 + 英文术语 | 保持可读性 |
| 代码/变量 | 英文 | 保持跨平台兼容 |
| Git 提交信息 | 英文 | 国际标准 |

### 9.2 输出格式约定

```
报告类: 表格 + emoji + 分层结构
代码类: 完整可运行，带注释
错误类: 错误信息 + 根因 + 解决方案
建议类: 选项列表(A/B/C) + 推荐
```

### 9.3 Git 约定

```
提交信息格式: type: 简短描述

type 规范:
  feat:   新功能
  fix:    修复
  docs:   文档
  refactor: 重构
  chore:  杂项
  add:    新增文件
  update: 更新文件
  clean:  清理

示例:
  feat: add SKU conflict detection skill
  fix: correct PostgreSQL connection timeout
  docs: update ENP cycle diagram
```

### 9.4 文件命名约定

```
Skill 文件:   kebab-case-name.skill.md
脚本文件:     snake_case_name.py / kebab-case-name.js
配置文件:     kebab-case-name.json / kebab-case-name.yaml
文档文件:     kebab-case-name.md
```

---
