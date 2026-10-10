## 1. Implementation（事后补录，已随 f31bd2f 完成）

- [x] 1.1 在 `site/report.mjs` 增加 `experimentConclusions()`，仅从 formal 来源推导四项 16 并发结论，缺失 / 失败 / verification 不生成
- [x] 1.2 在 `site/mysql.html`、`site/app.js`、`site/styles.css` 渲染实验结论区块，适配桌面四列、平板两列、移动单列，筛选与并发选择不影响内容

## 2. Verification

- [x] 2.1 单测覆盖推导数值、不修改数据、32 并发不影响结论、缺失 / 失败 / verification 拒绝及方向性（`npm run test:site`，15 项通过）
- [x] 2.2 浏览器回归断言四项数值、并发切换后内容不变、文本不溢出并生成 1440 / 375 截图（`npm run test:site:browser`）

## 3. Spec And Archive

- [x] 3.1 严格校验 OpenSpec，并把本 change 的 delta 同步到 `mysql-results-dashboard`
- [x] 3.2 经用户授权后归档
