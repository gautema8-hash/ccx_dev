# ⚠️ 本目录已废弃（历史遗留）

小程序前端代码已**完整迁移到 [`../miniprogram/`](../miniprogram/)**。

本目录在「拆分为四个独立目录」的重构中被取代，源码已清空，仅保留此说明文件。

## 为什么还留着

删除目录时受环境的安全删除策略限制（回收站操作失败并被拒绝回退删除），
因此保留一个空目录 + 说明文件，避免误以为这里还有代码。

## 你需要做的

- 开发、构建、真机预览一律使用 **[`../miniprogram/`](../miniprogram/)**
- 确认无引用后，可直接在文件管理器中删除本目录

## 迁移对照

| 旧位置（本目录） | 新位置 |
| --- | --- |
| `app.js` / `app.json` / `app.wxss` | `../miniprogram/app.js` 等 |
| `pages/` | `../miniprogram/pages/` |
| `components/` | `../miniprogram/components/` |
| `services/` | `../miniprogram/services/` |
| `utils/` | `../miniprogram/utils/` |
| `mock/` | `../miniprogram/mock/` |
| `packageUser/` | `../miniprogram/packageUser/` |
| `project.config.json` | `../miniprogram/project.config.json` |
