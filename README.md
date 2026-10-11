# Performance Profile

对互联网常见组件进行可复现的性能测试，建立不同场景下的量化性能认知，并通过网页呈现各组件详情与总览。

## 开发方式

项目使用 Git 管理，并采用 OpenSpec 进行规格驱动开发（SDD）。需求、设计、任务和实施记录均先进入 OpenSpec change，再进入代码开发。

## 常用命令

```bash
npm install
npm run openspec -- list
npm run openspec:validate
```

OpenSpec 规格与变更记录位于 `openspec/`。

## 当前结果

MySQL 本地 Docker 测试页面：

```bash
npm run site
```

打开 [组件索引](http://127.0.0.1:4173/) 或 [MySQL 结果页面](http://127.0.0.1:4173/mysql.html)。结果明确标记为 `local Docker benchmark`，不代表生产服务器性能。

Redis 本地 Docker 基准见 [benchmarks/redis/README.md](benchmarks/redis/README.md)，页面为 [Redis 结果页面](http://127.0.0.1:4173/redis.html)（正式实验完成并发布后可用）。
