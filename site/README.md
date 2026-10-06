# 结果看板

```bash
npm run site
npm run test:site
npm run test:site:browser
```

本地索引为 `http://127.0.0.1:4173/`，MySQL 报告为 `/mysql.html`。

## 数据契约

页面只读 `site/data/mysql.json`，不查询当前 Docker、不运行采集或压测，不修改结果。测试时间来自 `component.testedAt`，以 Asia/Shanghai（UTC+8）展示。

- MySQL 限额来自 `environment.container.mysqlCpuLimit/mysqlMemoryLimit`。
- Buffer Pool、连接数、隔离与持久化参数来自 `environment.mysql`。
- 压测端、Docker VM、宿主机分别使用对应的历史快照字段。
- Docker 的 `6g` 为 6 GiB；CPU 是配置配额上限，不是独占物理核。
- `runtime.dockerInfo` 仅在字段数与类型匹配时解析，未知字段显示“未记录”，保留原始记录。
- 四面板数值直接来自 `series.points`。不重新计算均值或中位数，不隐藏不稳定观测。
- p95 为直方图近似，p99 为 sysbench 原生分位数输出；延迟以事件/事务为计量单位。
- 点查与索引更新每事件 1 条查询，读写混合每事件 20 条；采用记录的 `queriesPerTransaction` 显示。

## 展示规则

默认使用对数轴，线性轴可以独立选择。对数轴不绘制零；缺失/负值/非有限值断开曲线，不补零。场景筛选同步作用于四图，并发选择同步作用于图与数值表。

移动端图表自适应，无强制最小宽度；详细表格仅在自身区域滚动。完整环境和逐次结果可以展开，原始数据沿用 `/artifacts/mysql/` 路由。

## 浏览器回归

浏览器回归使用本机已安装的 Playwright 与 Chromium，优先读取项目依赖，找不到时读取全局安装。该工具只用于测试，不参与站点运行。

测试自行启动临时本地服务，结束后关闭，不影响 `npm run site` 的预览服务。验证四种视口、触摸/键盘、场景筛选、刻度、并发、原始输出、缺失环境和请求/解析错误。

截图默认写入 `/tmp/performance-profile-dashboard`；可通过 `SITE_SCREENSHOTS` 环境变量改变目录。

## 索引更新日志对照

异步场景仅在报告中确实存在时显示。新同步/异步曲线使用各自的 `series.environment`、`testedAt` 和 `runGroup`，不把基础资源记录的单一日志配置套到所有曲线。

旧点查/混合的 `sourceRole=historical` 表示背景参照，新两组为 `paired`。风险与跨批次说明位于看板上方，每个组合展开后显示报告日期和实际日志参数。没有新增历史报告选择或独立比值面板。
