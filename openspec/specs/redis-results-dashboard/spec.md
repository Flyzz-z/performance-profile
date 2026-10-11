# redis-results-dashboard Specification

## Purpose
为 Redis 正式实验结果提供独立详情页和索引入口，按各场景自变量选择合适的图表，使读者直观理解命令、Pipeline、Value、持久化、连接、内存淘汰与慢命令阻塞的量化影响，并明确结果的环境边界。
## Requirements
### Requirement: Redis report page and data source

系统 SHALL 提供独立的 Redis 详情页，页面只读取已发布的 Redis 正式数据文件，不查询当前 Docker、不运行采集或压测、不修改结果。页面 MUST 明确标注 `local Docker benchmark`，并说明结果不代表生产服务器性能。

#### Scenario: Formal data is displayed

- **WHEN** 用户打开有有效正式数据的 Redis 页面
- **THEN** 页面按场景展示已发布结果，所有数值直接来自数据文件的汇总点
- **AND** 页面不显示 dry run、标定或其他过程验证产生的曲线、指标或结论

#### Scenario: Data missing or invalid

- **WHEN** 数据文件缺失、解析失败或某场景数据缺失
- **THEN** 页面显示明确的读取失败或缺失提示，缺失场景不绘制、不补零
- **AND** 其余有效场景继续显示

### Requirement: Scenario coverage disclosure

当数据文件只覆盖部分场景组时，页面 SHALL 明确显示已覆盖场景与尚未测量的场景，并仅展示已覆盖场景的章节、图表与实验结论；未测量场景 MUST NOT 被表述为失败、零值或缺陷，导航编号保持原场景序号。

#### Scenario: Partial coverage

- **WHEN** 数据文件的覆盖信息少于七个场景组
- **THEN** 页首显示“已覆盖 N/7 个场景”及尚未测量的场景名称
- **AND** 索引页条目同时标注覆盖范围

#### Scenario: Full coverage

- **WHEN** 数据文件覆盖全部七个场景组
- **THEN** 页面不显示覆盖提示

### Requirement: Index entry for Redis

组件索引页 SHALL 增加 Redis 条目，展示版本与平台、Redis 与压测端资源上限、最高观测 ops/s 及其所属场景范围、测试日期，并链接到详情页。

#### Scenario: Index shows peak with scope

- **WHEN** 用户打开索引页
- **THEN** Redis 条目的最高观测 ops/s 同时标出对应场景、命令、并发与 Pipeline 深度
- **AND** MySQL 条目的内容与行为保持不变

### Requirement: Environment summary from historical snapshot

页面 SHALL 从数据文件的环境快照展示 Redis 版本与镜像摘要、平台、Redis 与压测端 CPU/内存配额、`io-threads`、持久化默认设置及测试日期，并说明配额是容器配置上限而非专用物理核。未记录字段显示“未记录”。

#### Scenario: Runtime changes after testing

- **WHEN** 本机环境在测试后发生变化
- **THEN** 页面继续展示数据文件中保存的环境快照，不查询当前环境

### Requirement: Scenario-appropriate presentation

页面 SHALL 为七个场景分别提供章节，并使用与自变量匹配的图表：命令基线使用按命令分组的条形图；Pipeline 与连接数使用以深度或连接数为横轴的折线；Value 大小使用以大小为对数横轴的 ops/s 与有效载荷带宽折线；持久化使用按模式分组、可区分连接数的柱状图；内存淘汰使用成对指标卡及表格；慢命令使用各组前台 p99、p99.9 与 p99.99 的条形对比及前台吞吐条形。每个图 MUST 同时提供数值表。

#### Scenario: Scenario sections share consistent semantics

- **WHEN** 用户浏览任一场景章节
- **THEN** 吞吐与延迟分别使用一致的名称、单位与颜色，不混合不同场景、命令或并发的数据
- **AND** 缺失、负值或非有限值的点断开曲线，不补零，对数轴不绘制零

#### Scenario: Derived metrics are labeled

- **WHEN** 页面展示有效载荷带宽、命中率、淘汰速率或每批延迟
- **THEN** 明确标注其推导口径，例如带宽不含协议开销、Pipeline 延迟为每批请求延迟

### Requirement: Saturation and caveat disclosure

页面 SHALL 在每个观测可得时展示 Redis 与压测端 CPU 占配额比例，并对压测端接近配额的组合显示“可能受压测端限制”标记。页面 MUST NOT 把此类组合表述为 Redis 性能上限，也不得将持久化磁盘结果表述为物理磁盘性能。

#### Scenario: Loadgen-bound point

- **WHEN** 某组合压测端 CPU 占其配额比例达到阈值
- **THEN** 该点显示可能受压测端限制标记，并保留原始数值与说明

### Requirement: Experiment conclusions

页面 SHALL 在环境摘要之后提供“实验结论”区块，仅由已发布正式数据在页面端推导，每条带明确范围（连接数、数据规模、重复次数）和稳定性标记，不写回数据文件。至少包含：Pipeline 对吞吐的放大、Value 大小对吞吐的影响、持久化模式对写入的影响、内存淘汰对命中率与延迟的影响、慢命令对前台吞吐与尾延迟的影响。

#### Scenario: Conclusion derived from formal data

- **WHEN** 对应场景的数据完整有效
- **THEN** 生成该条结论，百分比或倍数按实际方向显示正负，不预设“提升”或“下降”

#### Scenario: Source data unavailable

- **WHEN** 某条结论的来源缺失、失败、非正式或指标无效
- **THEN** 该条结论不生成；全部缺失时整个区块隐藏

### Requirement: Detail and raw evidence access

页面 SHALL 提供可展开的环境明细和逐次观测，包含全部有效观测、稳定性标记与原始数据链接；原始数据由站点的 Redis 专用路由提供，不改变 MySQL 的原始数据路由。

#### Scenario: Raw evidence expanded

- **WHEN** 用户展开某组合的逐次结果
- **THEN** 展示每次观测的 ops/s、延迟分位数、错误数、资源占比，并提供原始输出链接

### Requirement: Responsive layout

页面 SHALL 在桌面、平板与手机宽度下无页面级横向溢出，图表自适应，详细表格仅在自身区域滚动，并保持键盘与触摸可用。

#### Scenario: Mobile viewport

- **WHEN** 在手机宽度打开 Redis 页面
- **THEN** 图表与表格布局可读，页面不出现横向滚动条

