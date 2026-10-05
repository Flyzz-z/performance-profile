# Tasks

## 1. MySQL benchmark environment

- [x] 1.1 创建 `benchmarks/mysql/compose.yaml`、环境变量和目录骨架，固定 MySQL ARM64 平台、`4 vCPU`、`6 GB` 内存、named volume 和独立网络，并使用 `docker compose config` 验证配置有效
- [x] 1.2 创建 MySQL 配置，设置 `3 GB` Buffer Pool 和测试所需的连接上限，启动容器并通过 `mysqladmin ping` 验证健康检查
- [x] 1.3 创建 sysbench 负载容器定义并固定基础镜像和工具版本，运行 `sysbench --version` 验证容器可用
- [x] 1.4 在根 `package.json` 增加 MySQL 准备、运行、汇总和页面生成命令，并通过 `npm run` 列出命令验证脚本入口
- [x] 1.5 编写 `benchmarks/mysql/README.md`，记录环境限制、资源配额、启动和清理命令，并逐条执行文档中的初始化与清理命令验证可复现性

## 2. Dataset and benchmark execution

- [x] 2.1 实现数据集准备脚本，创建 10 张表且每张 100,000 行，并通过 sysbench 输出和数据库计数验证总行数
- [x] 2.2 生成环境清单，记录 MySQL 版本、镜像摘要、平台、资源限制、Buffer Pool、Docker 运行时和宿主机指纹，并验证清单中的所有字段非空
- [x] 2.3 实现单场景运行器，支持 `point_select`、`update_index` 和 `read_write`，保存实际命令和完整原始输出，并通过每个场景的一次短运行验证结果文件
- [x] 2.4 实现预热和自适应重复编排，固定 60 秒预热、两次 120 秒正式运行，并在 TPS 或 p99 差异超过 10% 时补跑第三次，通过测试桩验证稳定与不稳定两条分支
- [x] 2.5 实现并发矩阵 `1/8/32` 的顺序执行，确保所有组件串行运行，并在出现失败时停止后续组合且返回非零退出码
- [x] 2.6 在 `benchmarks/mysql/README.md` 增加完整运行说明和预计耗时，并通过一次预处理检查和 dry-run 验证命令无需手工修改

## 3. Results and analysis pipeline

- [x] 3.1 实现 sysbench 原始输出解析器，提取事务数、查询数、TPS、QPS、平均延迟、p95、p99 和错误数，并使用成功与失败 fixture 验证解析结果
- [x] 3.2 定义并生成 `results/normalized/runs.jsonl`，每条记录关联场景、并发、重复次数、环境、协议、指标和原始文件路径，并通过 JSON 校验验证所有必填字段
- [x] 3.3 实现组合汇总，生成平均值、中位数、最小值和最大值以及波动比例和稳定性等级，并使用固定 fixture 验证计算准确性
- [x] 3.4 实现读写对比，计算写吞吐相对读吞吐的比值、写 p95/p99 相对读 p95/p99 的倍数及每次事务查询数，并验证只在相同并发数据间比较
- [x] 3.5 生成 `results/summary/combinations.json`、`comparison.json` 和 `site/data/mysql.json`，并通过结构校验确认结果可被页面直接读取
- [x] 3.6 编写 `benchmarks/mysql/results/README.md`，说明文件含义、稳定性判定和失败结果处理，并用实际生成结果核对文档示例

## 4. MySQL web presentation

- [x] 4.1 创建项目索引页和 MySQL 入口卡片，展示 MySQL 版本、`local Docker benchmark` 标签和代表性指标，并在本地静态服务中验证链接和文本内容
- [x] 4.2 创建 MySQL 详情页的环境、协议、数据集和限制区域，确保页面不把本机 Docker 结果描述为生产性能上限
- [x] 4.3 实现并发数到 QPS/TPS 的图表，并验证 `1/8/32` 三个并发点的数据与汇总文件一致
- [x] 4.4 实现并发数到 p95/p99 的图表和读写对比视图，展示吞吐比值与延迟倍数，并验证页面使用相同并发进行对比
- [x] 4.5 实现运行稳定性表和原始结果入口，展示两次或三次运行及波动比例，并验证失败运行不会出现在有效结果中
- [x] 4.6 在 `README.md` 或 `site/README.md` 记录页面生成和本地预览命令，并在桌面和移动视口检查布局无溢出或内容重叠

## 5. End-to-end validation

- [x] 5.1 运行完整 MySQL MVP，覆盖 3 个场景、3 个并发和自适应重复协议，并确认所有有效运行错误数为零
- [x] 5.2 核对原始结果、标准化记录、组合汇总和网页数据之间的事务数、吞吐及延迟一致
- [x] 5.3 检查 MySQL 详情页和索引页能够从汇总数据生成，并清楚展示读、写和混合场景差异及环境限制
- [x] 5.4 执行一次 MySQL 容器和数据卷清理后重新准备数据，验证测试可从空环境复现且不依赖手工数据库操作
