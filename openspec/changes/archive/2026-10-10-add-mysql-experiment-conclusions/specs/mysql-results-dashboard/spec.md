## MODIFIED Requirements

### Requirement: Unified results dashboard

详情页 SHALL 使用统一看板呈现 QPS、TPS、p95 和 p99，按一致的并发与场景语义比较 `point_select`、`update_index` 和 `read_write`。页面 MUST NOT 提供脱离条件的独立“读写差异”区或读写比值卡片；读写差异仅可作为带明确并发、数据规模与稳定性的“实验结论”条目之一出现。

#### Scenario: Existing results are displayed

- **WHEN** 用户打开有有效结果的 MySQL 详情页
- **THEN** 紧凑标题和资源摘要后出现四个独立指标面板
- **AND** 三类场景在全部图表中采用一致名称、顺序和颜色
- **AND** 页面不出现脱离条件的独立“读写差异”区域；读写比值只在“实验结论”中以带范围的条目呈现

#### Scenario: A concurrency is selected

- **WHEN** 用户选择并发 1、8 或 32
- **THEN** 四个面板突出同一并发点，并展示三类场景的对应指标数值
- **AND** 不混合不同并发、场景或单位的数据

## ADDED Requirements

### Requirement: Formal experiment conclusions
页面 SHALL 在 MySQL 详情页环境摘要之后展示“实验结论”区块，固定至多四项：读写性能差异、写入策略的影响、缓存容量的影响、热点竞争的影响。结论 MUST 仅由 `formalExperiment.purpose=formal` 的已发布数据在页面端推导，MUST NOT 修改、回写或补全任何结果，也 MUST NOT 使用 failed、`sourceRole=verification` 或非 formal 来源。

#### Scenario: Four conclusions are derived from approved comparisons
- **WHEN** 报告含正式六场景结果、正式缓存实验和正式热点实验
- **THEN** 读写差异取 16 并发主键点查与同步索引更新的 TPS 之比及 p99，写入策略取 16 并发异步与同步索引更新 TPS 之比，并在无二级索引数据有效时附带其相对同步更新的变化
- **AND** 缓存结论取独立实验 16 并发下 1 GiB 到 2 GiB 的 QPS 变化、p99 与缺页读取速率；热点结论取 16 并发分散与集中更新的 TPS 变化与行锁等待速率
- **AND** 每项显示自身范围（并发、行数或独立实验及重复次数），读写与写入策略、缓存各自展示来源的稳定性标记
- **AND** 32 并发补测点不影响任何结论，渲染前后报告数据保持不变

#### Scenario: A source is missing or invalid
- **WHEN** 某来源缺失、`tps` 为零或空、状态为 failed、`sourceRole=verification`、必需延迟缺失，或缓存 / 热点实验 `purpose` 不是 formal 或协议与 16 并发不符
- **THEN** 仅该项结论不生成，其余有效结论保留
- **AND** 报告非 formal 或没有任何有效结论时，整个“实验结论”区块隐藏
- **AND** 不以零、插值或其他并发的数据代替

#### Scenario: Direction follows the measurement
- **WHEN** 缓存或热点对比的实测变化为下降
- **THEN** 百分比显示负号，说明文字不预设提升；热点结论仅在集中场景行锁等待速率更高时声称竞争增加
- **AND** 同步与异步更新的备注不把吞吐倍数解释为唯一原因

#### Scenario: Conclusions stay independent of interaction
- **WHEN** 用户切换场景筛选、并发或刻度
- **THEN** 实验结论内容保持不变
- **AND** 桌面为四列、平板为两列、移动端为单列，文本不溢出且页面无横向滚动
