# mysql-results-dashboard Specification

## Purpose
为已有 MySQL 性能结果提供紧凑、可交互且可追溯的报告界面，使用户在统一看板中直接比较读、写与混合负载，并明确理解容器资源限制、实验协议和结果适用边界。

## Requirements

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

### Requirement: Historical MySQL container limits

页面 SHALL 从报告环境快照展示 MySQL CPU 上限、内存上限、Buffer Pool、平台和版本，并明确资源上限是容器配置配额，不是实时使用量、专用物理核或宿主机总资源。

#### Scenario: Current report resource limits are shown

- **WHEN** 展示现有 MySQL 报告
- **THEN** 资源摘要明确标为“MySQL 容器 CPU 上限 4 CPU”和“内存上限 6 GiB”
- **AND** 独立标出 Buffer Pool 为 3 GiB，以及平台 `linux/arm64`
- **AND** 不将 6 GiB 内存上限与 3 GiB Buffer Pool 混为同一指标

#### Scenario: Runtime changes after testing

- **WHEN** 本机容器、配置或运行时在测试后发生变化
- **THEN** 页面继续使用报告中保存的环境快照
- **AND** 不查询当前环境或用当前配置覆盖历史报告

### Requirement: Complete environment and protocol details

页面 SHALL 分组提供 MySQL 配置、压测端、Docker VM、宿主机和实验协议明细，并区分各层资源。数据未记录的字段 SHALL 显示“未记录”，不得猜测。

#### Scenario: Environment details are expanded

- **WHEN** 用户打开环境明细
- **THEN** 能看到 MySQL 版本与镜像摘要、连接上限、事务隔离、`innodb_flush_log_at_trx_commit` 和 `sync_binlog`
- **AND** 能看到压测端 CPU/内存配额及 sysbench 版本
- **AND** 能看到报告记录的 Docker/Compose 版本、运行时、VM 可见 CPU/内存、内核、宿主机型号、架构和物理内存
- **AND** 长摘要和其他长文本完整可读，不撑破页面

#### Scenario: Benchmark protocol is displayed

- **WHEN** 用户查看实验协议
- **THEN** 页面展示表数、每表行数、总行数、场景和并发
- **AND** 展示 60 秒预热、两次 120 秒正式运行、差异超过 10% 补跑第三次的协议
- **AND** 展示每个组合的实际重复次数，不把所有组合一律描述为仅运行两次

#### Scenario: Some environment fields are absent

- **WHEN** 某字段缺失或旧版运行时字符串无法可靠解析
- **THEN** 该字段显示“未记录”，已知字段仍正常展示
- **AND** 不因 `sync_binlog=1` 推断未记录的 binlog 启用状态或声称 CPU 配额已由独立物理核保障

### Requirement: Readable and truthful chart scales

四个指标面板 SHALL 支持线性与对数 Y 轴切换，并标明当前刻度、指标和单位。默认视图 SHALL 使不同量级的有效数据可辨识，不能把正值伪显示为零或用替代数值冒充缺失数据。

#### Scenario: Different orders of magnitude are compared

- **WHEN** 展示约 190 到 135,000 的 TPS，以及约 0.027 到 78 ms 的延迟
- **THEN** 默认视图能够辨认全部场景趋势，并保持标签、单位和有效数字可读
- **AND** 吞吐与延迟不共用同一 Y 轴，p95 与 p99 分别有独立面板

#### Scenario: Scale is changed

- **WHEN** 用户在任一面板切换线性与对数刻度
- **THEN** 坐标轴和曲线正确更新，原始指标值不变
- **AND** 对数轴不出现零刻度
- **AND** X 轴明确标示实际测试并发 1、8、32，不暗示额外采样点

#### Scenario: Zero or missing data is encountered

- **WHEN** 面板包含零值、负值、缺失值或非有限数值
- **THEN** 无效值不作为有效性能点绘制，缺失值形成断点并在数值区标记“未记录”
- **AND** 零值在线性轴保持为零，在对数轴标记为不可绘制，不静默钳制成正值
- **AND** 页面不产生 `NaN`、`Infinity` 或崩溃

### Requirement: Accessible chart inspection

页面 SHALL 提供共享场景筛选，以及鼠标、触摸和键盘可访问的数值查看方式。读写差异 SHALL 通过同并发的图表与数值直接体现，而非要求阅读比值卡片。

#### Scenario: A scenario is hidden or restored

- **WHEN** 用户切换某个场景的可见状态
- **THEN** 四个图表同步更新，其他场景颜色与名称保持不变
- **AND** 当前并发和刻度选择保持不变
- **AND** 全部场景被隐藏时显示明确空状态，能够重新启用

#### Scenario: Values are inspected without a mouse

- **WHEN** 用户通过触摸选择并发或通过键盘操作筛选与并发控件
- **THEN** 可获取与鼠标提示一致的 QPS、TPS、p95 和 p99 数值
- **AND** 当前选择和键盘焦点可辨识
- **AND** 相同并发的数值区显示场景、每次事件/事务查询数及稳定性标记，避免跨事务语义误读

### Requirement: Compact responsive report layout

详情页与索引页 SHALL 采用一致、以数据为中心的紧凑报告布局。桌面看板 SHALL 支持双列对照，移动端 SHALL 完整呈现单列图表，不要求横向滚动才能查看完整图形。

#### Scenario: Desktop report is opened

- **WHEN** 用户在 1440 × 900 的视口打开详情页
- **THEN** 首屏展示组件身份、环境标签、MySQL 容器资源上限和看板顶部内容
- **AND** 不使用大面积空白标题区或独立读写比值区域挤压结果

#### Scenario: Mobile report is opened

- **WHEN** 用户使用 375 或 390 像素宽的视口查看报告
- **THEN** 图表自适应宽度，坐标、图例和控制项不遮挡、不裁切
- **AND** 页面整体无横向溢出
- **AND** 必须横向滚动的详细数据表仅在自身区域滚动

#### Scenario: Index entry is opened

- **WHEN** 用户打开项目索引页
- **THEN** MySQL 入口展示版本、环境标签、容器资源摘要和带场景/并发信息的代表性指标
- **AND** 不将不同并发的峰值与比值拼成无条件结论，不把不稳定观测标为稳定上限
- **AND** 索引与详情页可以互相导航

### Requirement: Result integrity and traceability

界面优化 SHALL 只读使用现有结果，不改变测试协议、指标、统计算法或原始结果。页面 SHALL 显示稳定性、数据来源、指标含义与测试限制，保留逐次结果和原始输出入口。

#### Scenario: A result is traced

- **WHEN** 用户从结果明细展开某个场景与并发组合
- **THEN** 能看到每次正式运行的指标、次数和原始输出链接
- **AND** 有效汇总不包含失败运行，不稳定组合仍保留并显式标记
- **AND** 汇总值与现有 JSON 一致，仅展示精度可能不同

#### Scenario: Latency and scope are described

- **WHEN** 用户查看指标来源和实验边界
- **THEN** 页面标明 p95 为延迟直方图近似值，p99 为 sysbench 原生分位数输出，并指出延迟按测试事件/事务计量
- **AND** 保留本地 Docker 探索性标签和 macOS/虚拟化环境限制
- **AND** 不将报告解释为生产容量或将 CPU/I/O 瓶颈作为已实测结论

### Requirement: Report loading and failure states

页面 SHALL 区分加载中、无有效数据、请求/解析失败和正常报告，错误不能仅写入控制台，也不能以零填充缺失指标。

#### Scenario: Results cannot be loaded

- **WHEN** 结果请求失败、JSON 无法解析或基础结构不兼容
- **THEN** 页面显示明确错误状态和可操作的重试入口
- **AND** 不无限保留“正在读取测试结果”或绘制假数据

#### Scenario: Results are empty or incomplete

- **WHEN** 基础报告结构有效但某场景或指标没有有效数据
- **THEN** 页面保留已知环境和其他有效结果，并在受影响面板显示空状态
- **AND** 不把缺失场景补为零值，不生成缺少来源的结论

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
