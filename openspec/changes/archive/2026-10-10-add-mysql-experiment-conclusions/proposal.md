## Why

MySQL 结果页已有六场景曲线、缓存实验与热点实验，但读者需要自行对照图表才能得到“读写差多少、写入策略、缓存、热点各自影响多大”这类结论。本 change 为事后补录：该功能已在提交 `f31bd2f` 实现并通过单测，现补充规格并归档，使主规范与页面行为一致。

## What Changes

- 在 MySQL 详情页环境摘要之后、资源摘要之前新增“实验结论”区块，固定四项：读写性能差异、写入策略的影响、缓存容量的影响、热点竞争的影响。
- 每项只由已发布的 `purpose=formal` 数据在页面端计算，每项带明确范围（并发、数据规模、独立实验及重复次数）和稳定性标记；不写回 JSON，不改变任何测量结果。
- 读写差异与写入策略取 16 并发的主键点查 / 同步索引更新 / 异步索引更新 / 无二级索引更新；缓存与热点取各自独立实验的 16 并发选定结果。
- 任一来源缺失、失败、非 formal、`sourceRole=verification` 或指标无效时，对应结论不生成；全部缺失时整个区块隐藏。
- 百分比按实际方向显示正负，不预设“提升”。结论区块不随场景筛选或并发选择变化。
- 修订“统一看板”需求：原先禁止的独立“读写差异”区 / 比值卡片，改为仅允许作为带条件的实验结论之一出现。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `mysql-results-dashboard`：新增实验结论区块需求；放宽“不得出现读写比值卡片”的绝对表述为带范围条件的例外。

## Impact

- 页面：`site/report.mjs` 新增 `experimentConclusions()`，`site/app.js`、`site/mysql.html`、`site/styles.css` 渲染并适配桌面 / 平板 / 移动布局。
- 测试：`site/test/report.test.mjs` 增加推导、缺失 / 失败 / verification 拒绝、方向性三项单测；`site/test/browser.mjs` 增加四项数值、筛选不变及布局不溢出断言。
- 不修改 benchmark 脚本、测量数据、`site/data/mysql.json`，不新增实验或场景；不涉及 32 并发补测点。
