## 1. Environment And Protocol Foundation

- [x] 1.1 新增 `benchmarks/redis/`：`compose.yaml`（Redis 2 CPU/4 GiB、memtier 4 CPU/1 GiB、后台 redis-cli 0.5 CPU，独立项目/网络/数据卷名）、`.env.example`、`config/redis.conf`、`.gitignore` 的 verification 目录；核验 Redis 与 memtier 镜像 arm64 清单并固定摘要
- [x] 1.2 实现七场景 48 组合的单一矩阵声明（命令、Pipeline、value 大小、持久化模式、连接映射、`maxmemory`/分布、后台命令频率及数据规模）；单测覆盖组合数 8/8/8/12/4/4/4、连接映射与场景 3/6/7 的数据规模
- [x] 1.3 实现 memtier 参数构造与 JSON 输出解析（ops/s、p50/p95/p99/p99.9、hits/misses、错误数）；`--command` 工作负载含 `hget`/`hset`/`list_push_pop`/`zincrby`/`zrange`；单测覆盖解析、Pipeline 延迟标注与异常输出拒绝
- [x] 1.4 实现 Redis `INFO`/`CONFIG` 读取及窗口差分（命令数、CPU、命中/未命中、淘汰、`rdb_saves`、`aof_rewrites`、`latest_fork_usec`、`errorstat_OOM`），单测覆盖计数重置、缺失字段与窗口秒数取实际读取时间

## 2. Executor And Evidence

- [x] 2.1 实现按组合的数据准备：`FLUSHALL`、顺序装载、Hash/List/ZSet 装载、等待 BGSAVE/AOF rewrite 结束，并记录装载耗时与实际 key 数/`used_memory`；验证读命令未命中为 0
- [x] 2.2 实现执行器：持久化模式与 `maxmemory` 的重启配置、预热 30 秒、两次 60 秒测量、差异超 30% 补第三次（复用 MySQL 的重复运行协议），后台 redis-cli 慢命令驱动（`HGETALL`/`KEYS`/`SCAN`）及后台次数与 slowlog 计数
- [x] 2.3 复用并薄封装 Docker Stats 5 秒采样，60 秒窗口覆盖 ≥48 秒、跨度 ≤70 秒、间隔 ≤10 秒；保存 Redis 与压测端 CPU 占配额比例并计算 `loadgenBound`；单测覆盖证据不足与限流计数
- [x] 2.4 实现环境核验：实际限额、镜像摘要、arm64、Redis 版本与 `CONFIG`，与场景要求不符则拒绝；`--dry-run` 只读输出 48 组合、数据规模、协议与预计时长，不启动容器不写文件；支持可捕获中断清理本入口创建的压测与后台容器，不删除数据卷
- [x] 2.5 添加 `package.json` 的 `redis:*` 与 `test:redis` 脚本，并增加 Redis 的 README（环境口径、命令、协议、证据与适用边界）

## 3. Collection And Publication

- [x] 3.1 实现 collect：从原始记录重新计算汇总，拒绝缺失组合、混批、协议或环境不符、采样不足、读命令未命中非零、非预期非零错误及恢复失败；`noeviction` 组的 OOM 拒绝按 `errorstat_OOM` 作为测量结果
- [x] 3.2 实现 `site/data/redis.json` 的原子发布与旧文件备份（备份存放于 `site/data` 外），拒绝 `verification` 来源；单测覆盖失败时数据文件保持不变
- [x] 3.3 更新 `site/server.mjs` 增加 `/artifacts/redis/` 路由，并保证 MySQL 路由行为不变；增加路由单测

## 4. Dashboard

- [x] 4.1 新增 `redis-report.mjs`：数据投影、坐标轴与格式化复用现有函数、`loadgenBound` 标记、有效载荷带宽与命中率等推导口径、实验结论推导；单测覆盖缺失、非正式、方向性与对数轴零值处理
- [x] 4.2 新增 `redis.html` 与 `redis-app.js`：环境摘要、实验结论、吸顶场景导航、七场景图表与数值表（条形、折线、分组柱、指标卡）、环境明细与逐次观测及原始链接；复用并扩展 `styles.css`，不改动 MySQL 页面逻辑
- [x] 4.3 更新索引页 Redis 条目（版本/平台、资源上限、最高观测 ops/s 及其场景范围、测试日期）；确认 MySQL 条目不变
- [x] 4.4 增加页面 fixture 与浏览器回归：桌面/平板/手机无页面溢出、缺失与解析错误提示、`loadgenBound` 标记、索引链接及原始路由；更新 `site/README.md`

## 5. Process Verification

- [x] 5.1 运行单测与页面 fixture；执行 dry run 核对 48 组合；用过程验证确认各命令/数据/后台慢命令有效、memtier 对错误回复的行为，以及压测端线程映射标定；全部写入 verification，不进入正式页面
- [x] 5.2 向用户汇报验证结论；若需要调整正式条件（测量时长、数据规模、后台频率、连接映射），先更新本 change 并获用户确认，再进入正式实验

## 6. Formal Execution And Acceptance

- [x] 6.0 支持分批执行与分组发布：`--groups` 选择并排序场景组，`--resume` 续跑，汇总由已保存结果重建，发布仅包含完整场景组并记录覆盖信息；页面与索引标注已覆盖/未测量场景；补充单测

- [x] 6.1 使用防闲置休眠保护，串行执行 48 个组合的正式实验（运行期间不叠加其他负载或合盖）；核验数据、原始证据、环境及恢复
- [x] 6.2 联合验收并只发布确认的正式结果；检查实际数据下桌面/移动截图和全部原始链接，确认页面不含过程验证、未确认试验或中间版本
- [x] 6.3 执行 OpenSpec 严格校验，记录验收证据；按用户后续授权同步规格、归档并提交

## Acceptance Evidence

- 2026-10-10 批次 1：运行组 `formal-redis-20261010`，场景 2 Pipeline、5 连接数、6 内存淘汰、7 慢命令阻塞共 20 个组合，预热 30 秒、两次 60 秒测量，2 个组合（memory-lru-gaussian、blocking-keys）因差异超过 30% 补跑第三次；耗时约 55 分钟。
- 全部观测零非预期错误，资源采样覆盖、未命中、驱逐、后台命令执行次数均通过，压测端 CPU 最高约 24%，无压测端受限点；容器已清理，数据卷保留。
- 已发布 `site/data/redis.json`（覆盖 4/7 场景，未测量：命令基线、Value 大小、持久化策略）；169 个原始数据链接均返回 HTTP 200，页面无过程验证引用。
- 过程验证（短时长全矩阵与正式时长子集）保存在 gitignored 的 `results/verification/`，未进入页面。
- 环境提示：单次会话内 connections-c64 低于 c16，Redis CPU 仅占配额 33%，未饱和；宿主机负载均值约 6.6，结果包含本机共享负载与虚拟网络影响。
- 待办：场景 4 持久化（12 个组合，约 38 分钟）以及场景 1、3（16 个组合，约 48 分钟），用 `--resume --group=formal-redis-20261010 --groups=...` 续跑后再次发布。
- 2026-10-10 连接数场景重测：首次测量时宿主机桌面负载较高（c64 仅 12.4–13.8 万 ops/s，低于 c16，Redis CPU 仅占配额 33%）。应用户要求在尽量空闲的机器上重测，新结果 c64 为 17.6–17.8 万 ops/s，曲线在 64 连接附近进入平台期。首次测量的原始数据保留在 `results/formal-redis-20261010/superseded/`，不进入页面或汇总；重测用相同环境、协议与矩阵，未改变任何实验条件。
- 2026-10-10 批次 2：场景 4 持久化策略 12 个组合（关闭 / RDB / AOF everysec / AOF always × 1 / 16 / 64 连接），随机数据，预热 30 秒、两次 60 秒测量，无补跑；耗时约 40 分钟。全部观测零非预期错误，每个 RDB 窗口恰好触发 1 次 BGSAVE，AOF everysec 窗口内重写 4–7 次；AOF always 在 Docker VM 虚拟盘上仅 747–11,771 ops/s。已发布，覆盖 5/7 场景，仍待场景 1 命令基线与场景 3 Value 大小。
- 2026-10-11 批次 3：场景 1 命令基线 8 个与场景 3 Value 大小 8 个组合，无补跑，零非预期错误，无压测端受限点，耗时约 50 分钟，容器已清理。至此 7 个场景共 48 个组合全部完成，运行组 `formal-redis-20261010`（连接数场景为重测结果，首次测量保留在 `superseded/`），页面覆盖 7/7，不再显示覆盖提示。
