# GMV Max 自动化 — 宪法 v1.0

> **🏛️ 终极规则 — 永不修改**
>
> 以下 5 条宪法规则是系统的不可动摇根基。任何代码、脚本、配置或操作都不得违反。
> 每次广告操作（创建、修改、暂停、恢复、删除）前，**必须**通过门禁引擎（gate-engine）检查这 5 条规则。

---

## 宪法规则

### 规则 1 — 禁止修改遗留计划
> **NEVER modify ROI or budget of legacy plans with existing data**

已有数据的旧广告不应修改 ROI/预算。让平台机器学习算法基于已有数据进行优化。
- 违反后果：平台可能重置学习期，导致广告效果下降
- 生效范围：所有 `campaign_primary_status !== "draft"` 的广告
- 例外：无（硬性规则）

### 规则 2 — 统一命名规范
> **All automation ads MUST be named '自动化-<SPU_ID>'**

所有自动化创建的广告名称必须遵循 `自动化-<SPU_ID>` 格式。
- SPU_ID 是 TikTok Seller Center 中的商品 SPU ID
- 示例：`自动化-7324567890123456789`
- 违反后果：广告管理混乱，无法通过命名快速定位商品

### 规则 3 — 一广告一商品
> **Each automation plan MUST contain exactly 1 product**

每个自动化广告计划必须且只能包含 1 个商品。
- 违反后果：无法精确追踪单个 SPU 的广告效果
- 允许创建多个广告，每个针对不同 SPU

### 规则 4 — 保持默认时区与开始时间
> **Do NOT change timezone or start time (use defaults)**

创建广告时不得修改时区和开始时间。
- 默认时区：Asia/Shanghai (UTC+08:00)
- 默认开始时间：创建后立即开始
- custom_tz_id: `7473424031757336583`（如需用于 update body）
- 违反后果：可能导致数据报表时区混乱

### 规则 5 — 创建前检查 SPU 可用性
> **New ads must check SPU availability first**

创建新广告前必须检查 SPU 是否已被其他广告占用。
- 每个 SPU 在同一店铺内只能属于一个 GMV Max 广告
- 违反后果：创建失败或覆盖已有广告（"SPU occupied" 错误）

---

## 规则来源

宪法规则定义于 `~/.tkads/stores.json` 的 `constitution.rules` 数组，
由 `gate-engine.js` 在运行时强制执行。

| 文件 | 角色 |
|------|------|
| `stores.json` | 宪法规则定义（单一事实源） |
| `gate-engine.js` | 运行时门禁检查引擎 |
| `config-chain.js` | 配置链加载（从 stores.json 读取） |

> ✅ **宪法规则永不修改。** 任何需要修改规则的请求必须先升级到宪法修正流程。
