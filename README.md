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
