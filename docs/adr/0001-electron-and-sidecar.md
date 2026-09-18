# ADR-0001：Electron 与独立图像服务

- 状态：accepted
- 日期：2026-09-18

## 决策

桌面 UI 使用 Electron、React 和 TypeScript。RAW、缩略图、数据库和文件事务最终由 Rust sidecar 承担，通过版本化协议通信。

## 原因

Electron 更适合高密度桌面工作台和快速产品迭代；图像处理需要与 Renderer 的内存、崩溃和技术栈隔离。独立协议也允许未来替换 UI 或复用核心。

## 影响

需要维护跨进程协议、sidecar 生命周期和平台打包。开发早期可使用 TypeScript 适配器，但领域端口保持稳定。

