## MODIFIED Requirements

### Requirement: Unified results dashboard

详情页 SHALL 使用统一看板呈现 QPS、TPS、p95 和 p99，按一致的并发与场景语义比较 `point_select`、`update_index` 和 `read_write`。页面 MUST NOT 提供脱离条件的独立“读写差异”区或读写比值卡片；读写比值仅可出现在看板上方、作者手写并带明确并发与数据规模的“实验结论”中。

#### Scenario: Existing results are displayed

- **WHEN** 用户打开有有效结果的 MySQL 详情页
- **THEN** 紧凑标题和资源摘要后出现四个独立指标面板
- **AND** 三类场景在全部图表中采用一致名称、顺序和颜色
- **AND** 页面不出现脱离条件的独立“读写差异”区域；读写比值只在看板上方的“实验结论”中以带范围的文字呈现

#### Scenario: A concurrency is selected

- **WHEN** 用户选择并发 1、8 或 32
- **THEN** 四个面板突出同一并发点，并展示三类场景的对应指标数值
- **AND** 不混合不同并发、场景或单位的数据

### Requirement: Formal experiment conclusions

页面 SHALL 在每个正式实验上方展示一个“实验结论”位，覆盖性能看板（六场景正式实验）、Buffer Pool 对比实验与热点更新实验。结论文本 MUST 由作者逐条手写并存放于 `site/data/conclusions.json`；页面 MUST NOT 根据测量数据生成、计算或改写结论文字，只按实验 id 展示对应文本。结论 MUST NOT 修改、回写或补全任何结果数据。

#### Scenario: Summary sits above its experiment

- **WHEN** 对应实验在报告中可见，且 `conclusions.json` 中该实验 id 有非空文本
- **THEN** 结论位显示在该实验区块之前，并保留文本中的换行
- **AND** 结论内容不随场景筛选、并发选择或刻度切换而变化

#### Scenario: Empty or hidden experiment

- **WHEN** 某实验 id 的文本为空或缺失，或对应实验因数据缺失而隐藏
- **THEN** 该结论位不显示，其他实验的结论位不受影响
- **AND** 结论文件无法读取时，页面仍正常显示报告，只是不显示任何结论位

#### Scenario: Layout keeps text readable

- **WHEN** 用户在桌面、平板或移动端查看结论位
- **THEN** 文本在容器内换行，不溢出，页面无横向滚动

### Requirement: Report loading and failure states

页面 SHALL 区分加载中、无有效数据、请求/解析失败和正常报告，错误不能仅写入控制台，也不能以零填充缺失指标。

#### Scenario: Results cannot be loaded

- **WHEN** 结果请求失败、JSON 无法解析或基础结构不兼容
- **THEN** 页面显示明确错误状态和可操作的重试入口
- **AND** 不无限保留“正在读取测试结果”或绘制假数据

#### Scenario: Results are empty or incomplete

- **WHEN** 基础报告结构有效但某场景或指标没有有效数据
- **THEN** 页面保留已知环境和其他有效结果，并在受影响面板显示空状态
- **AND** 不把缺失场景补为零值，也不以页面推导补齐结论文字
