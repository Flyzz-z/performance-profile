## MODIFIED Requirements

### Requirement: Experiment conclusions

页面 SHALL 在每个已测量场景章节之前提供一个“实验结论”位，文本由作者手写并存放于 `site/data/conclusions.json` 的 `redis` 对象中，按场景 id 对应（`commands`、`pipeline`、`value-size`、`persistence`、`connections`、`memory`、`blocking`）。页面 MUST NOT 从测量数据推导或生成结论文字，不写回数据文件。

#### Scenario: Summary appears above its scenario

- **WHEN** 某场景章节可见，且 `conclusions.json` 中该场景 id 有非空文本
- **THEN** 结论位显示在该场景章节之前，并保留文本中的换行
- **AND** 其他场景的结论位不受影响

#### Scenario: Empty or unmeasured scenario

- **WHEN** 某场景 id 的文本为空或缺失，或该场景尚未测量
- **THEN** 该结论位不显示
- **AND** 未测量场景不被表述为失败、零值或缺陷
