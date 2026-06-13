# 自进化引擎 v1.0

## 闭环

```
cron-guardian.bat（每2小时）
  ↓ 完整体检 (monitor.py --full)
  ↓ 自进化检查 (self-evolve.js)
      ├── Phase 1: catalog-check.js（61项完整性检查）
      ├── Phase 2: auto-fix（自动修复已知问题）
      │     ├── fixCatalogPath — 修正 catalog 路径注册错误
      │     ├── syncConstitution — 同步 stores.json 宪法规则到 gate-engine
      │     ├── purgeStaleLogs — 清理 90 天前的操作日志
      │     └── updateCatalogVersion — 更新模块版本号
      ├── Phase 3: operation_log_v2 记录
      └── Phase 4: 无法修复的问题发送飞书告警
  ↓ 
gate-engine → catalog_health 门禁
      （每次 create_ad / update_roi 前检查 catalog 健康度）
```

## 自动修复覆盖场景

| 场景 | 策略 | 自动修复 |
|------|------|---------|
| catalog 路径不对 | fixCatalogPath | ✅ 搜索实际路径并更新 |
| 宪法规则漂移 | syncConstitution | ✅ 从 stores.json 重新同步 |
| 旧日志堆积 | purgeStaleLogs | ✅ 清理 >90天 (保留 ERROR/BLOCKED) |
| 版本号过期 | updateCatalogVersion | ✅ 检测文件 mtime 并更新 |
| 核心文件缺失 | 告警 | ❌ 无法自动修复，发飞书 |

## 接入点

- 随 cron-guardian（每2小时）自动运行
- 通过 `node ~/.tkads/self-evolve.js` 手动触发
- `--check-only` 仅检查不修复
- `--dry-run` 预览修复内容
- `--verbose` 详细输出

## 门禁集成

`catalog_health` 门禁在以下操作前自动检查：
- `before:create_ad` — 新建广告前确保 catalog 健康
- `before:update_roi` — 修改 ROI 前确保 catalog 健康

60秒缓存，不重复频繁调用。
