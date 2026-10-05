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

## 延迟指标

sysbench 1.0.20 一次只提供精确的一个分位数。本测试使用 sysbench 精确 p99，并从 latency histogram 计算 p95；标准化记录中的 `p95Source` 和 `p99Source` 说明每个值的来源。

## 失败结果

退出码非零、解析失败或错误数大于零的运行标记为 `failed`。失败运行保留在原始目录中供诊断，但不会参与组合汇总、读写对比或网页图表。
