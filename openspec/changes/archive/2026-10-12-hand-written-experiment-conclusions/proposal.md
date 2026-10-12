## Why

页面由代码推导的“实验结论”放在页面顶部，与具体实验脱节，且结论文字由程序生成，难以逐条审核。改为：结论位置紧贴对应实验，文字由作者逐条手写，页面只负责展示。

## What Changes

- 删除页面顶部的“实验结论”区块，以及页面端推导结论的逻辑（MySQL `experimentConclusions()`、Redis `redisConclusions()`）及其单测。
- 在每个正式实验上方提供一个“实验结论”位：
  - MySQL：性能看板（六场景正式实验）、Buffer Pool 对比、热点更新。
  - Redis：七个场景章节，各自上方一个。
- 结论文字存放于 `site/data/conclusions.json`，按实验 id 手写。空文本不显示；对应实验隐藏时，结论也隐藏。
- 结论位不随场景筛选、并发选择或刻度切换变化。
- 页面不写回数据文件，不改变任何测量结果，不新增实验或场景。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `mysql-results-dashboard`：统一看板中的读写比值仅可出现在对应实验上方的手写结论中；“Formal experiment conclusions”改为每个实验上方的手写结论位；加载与空状态中不再以页面推导补齐结论。
- `redis-results-dashboard`：“Experiment conclusions”改为每个场景上方的手写结论位，不再由页面推导。

## Non-goals

- 不规定结论的具体措辞；由作者逐条审核编写。
- 不为 32 线程补充实验新增独立结论位，除非另行确认。
- 不调整数据来源、测量协议或正式实验范围。

## Impact

- 页面：`site/app.js`、`site/redis-app.js`、`site/mysql.html`、`site/redis.html`、`site/styles.css`、`site/README.md`。
- 数据：新增 `site/data/conclusions.json`；`site/data/mysql.json` 与 `site/data/redis.json` 不变。
- 代码：删除 `site/report.mjs` 的 `experimentConclusions()` 与 `site/redis-report.mjs` 的 `redisConclusions()`。
- 测试：删除推导相关单测；`site/test/browser.mjs` 与 `site/test/redis-browser.mjs` 改为验证结论位的位置与显示逻辑。
