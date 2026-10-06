# MySQL Result Files

## 目录

- `environment.json`：本次 MySQL、Docker、宿主机、资源和工具版本清单。
- `dataset.json`：数据表数量、数据规模、实际行数和准备命令。
- `raw/`：每次 sysbench 运行的原始输出、stderr 和运行元数据。
- `normalized/runs.jsonl`：每次运行一条标准化记录。
- `summary/combinations.json`：按场景和并发聚合的稳定性结果。
- `summary/comparison.json`：相同并发下的读写对比。

网页数据生成到 `site/data/mysql.json`。

## 稳定性

- `stable`：TPS 或 p99 的最大波动不超过 5%。
- `acceptable`：最大波动在 5%-10%。
- `unstable`：最大波动超过 10%。

每个组合先运行两次；TPS 或 p99 的差异超过 10% 时补跑第三次。两次使用平均值，三次使用中位数。

沿用原计算口径：补跑触发的两次差异为 `abs(a-b)/max(abs(a),abs(b))`，稳定性表中的极差为 `(max-min)/mean`。分母不同，所以两次未触发补跑时，汇总仍可能被标为不稳定；不隐藏该波动。

## 延迟指标

sysbench 1.0.20 一次只提供精确的一个分位数。本测试使用 sysbench 精确 p99，并从 latency histogram 计算 p95；标准化记录中的 `p95Source` 和 `p99Source` 说明每个值的来源。

## 失败结果

退出码非零、解析失败或错误数大于零的运行标记为 `failed`。失败运行保留在原始目录中供诊断，但不会参与组合汇总、读写对比或网页图表。

## 日志策略对照文件

新入口自动生成唯一 `runGroup`，沿用现有目录，不建立批次注册表：

- 根目录：`<runGroup>-<scenario>-c<N>-environment.json` 与 `dataset.json` 清单。
- `raw/`：带 runGroup 前缀的原始文本和元数据，元数据携带实际日志配置。
- `normalized/`：`<runGroup>-runs.jsonl`。
- `summary/`：带 runGroup 前缀的组合、对照和报告 JSON。
- `summary/`：正式更新看板前保留一份 `<runGroup>-previous-report.json`；验证报告仅保存在此目录。

旧原始文件与默认汇总保留。旧归档报告可能包含不同日期的背景参照，但不属于当前最终产物。最终发布规则如下，不增加历史报告选择界面。

## 正式4 CPU基线

最终报告只接受 `purpose=formal` 的同一结果组12组合，不接受旧条件、短测或verification。正式组原始资料使用 `formal-4cpu-*` 前缀；每次测量额外有 `.resources.json` 采样及元数据资源汇总。

逐次CPU资源使用按采样覆盖时间加权汇总，性能指标继续使用原均值/中位数。资源使用为辅助证据，不新增实验场景。

发布前旧JSON归档至 `summary/<runGroup>-previous-report.json`，历史site/data备份移到summary。最终site/data仅保留当前mysql.json，不混入历史或过程资料；旧数据仍可在开发/归档目录及Git追溯。

经用户确认替换的受中断组合完整保存到本地 `verification/`，不提交、不参与正式collector或页面。归档清单记录文件哈希，内部保留原相对路径结构；检查原始记录中的相对引用时，以该归档目录为根，避免误读替换后的同名正式记录。
