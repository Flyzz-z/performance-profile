## ADDED Requirements

### Requirement: Unified indexed read comparison presentation
MySQL 页面 SHALL 将已发布且完整有效的 `indexReadExperiment` 两组加入性能看板，展示 1/8/16 并发下的 QPS/TPS、p95/p99、同并发吞吐倍数、两端 CPU 配额占比、稳定性和全部正式观测。两组 SHALL 共同参与看板筛选、并发选择和刻度控制，MUST 保留自身正式日期、条件和证据归属，MUST NOT 改写既有原始场景或索引页代表性指标。

#### Scenario: Paired results are displayed
- **WHEN** 读取完整有效的正式索引读实验
- **THEN** 在原四张指标图和数值表中追加“二级索引点查”和“无二级索引查询（全表扫描）”，使用与原场景不同的颜色
- **AND** 标题说明下显示每组 10 表 × 100,000 行、每次返回一行、SQL `SELECT c FROM 表 WHERE k=?` 和本实验的真实日期
- **AND** 吞吐倍数只按同并发有索引 QPS / 无索引 QPS 展示，分母缺失或非正时不计算
- **AND** 全部重复、稳定性、执行计划、数据清单、脚本及资源资料合并到结果明细，移除重复的独立图表与控件
- **AND** 结果明细整体默认收起，点击标题可展开；展开后保留各组合的逐次记录与原始资料入口

#### Scenario: Optional experiment is unavailable
- **WHEN** 旧报告没有索引读实验，或实验不是 formal、缺组、缺并发或字段无效
- **THEN** 不添加对应曲线、数值、比较或结论，现有报告继续正常显示

#### Scenario: Shared controls and layout remain usable
- **WHEN** 用户改变场景筛选、1/8/16 并发或图表刻度
- **THEN** 八场景图表和数值表共同响应，隐藏任一索引读组时隐藏配对吞吐倍数
- **AND** 32 并发不进入图表，原介绍栏与明细保留；页面整体不横向溢出，表格只在自身区域滚动

### Requirement: Author written indexed read experiment conclusions
页面 SHALL 将作者填写的 `site/data/conclusions.json` 的 `mysql.index-read` 文本作为性能看板的一行结论，在标题和说明下、图表上展示。文本 SHALL 保留换行及每行冒号前加粗，沿用浅青色结论框；页面 MUST NOT 自动撰写或回写结论。

#### Scenario: Written conclusion accompanies valid results
- **WHEN** 正式索引读实验有效且结论非空
- **THEN** 将该文本拼接到统一看板原有结论后，保留所有原有文字，且不随筛选和并发变化

#### Scenario: Conclusion is empty or experiment is unavailable
- **WHEN** 结论为空、文件无法读取或索引实验无效
- **THEN** 不展示对应索引结论，现有其他结论正常显示
