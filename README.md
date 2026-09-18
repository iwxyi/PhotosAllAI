# PhotoAllIsAI

PhotoAllIsAI 是一款面向 macOS 与 Windows 的 AI 原生图片管理和生成式修图桌面应用。

项目当前处于设计与基础实现阶段。产品范围见 [产品设计](docs/product-design.md)，工程边界见 [系统架构](docs/architecture.md)，交付顺序见 [实施计划](docs/delivery-plan.md)。

## 核心原则

- 原图默认不被后台任务修改。
- AI 分析、生成任务和生成版本完整可追溯。
- 浏览、文件管理、AI 队列和导出互不阻塞。
- 默认由程序管理生成结果，同时提供可靠的批量导出。
- macOS 与 Windows 使用同一业务核心并分别通过平台验收。

## 文档

- [产品与系统设计](docs/product-design.md)
- [企业级系统架构](docs/architecture.md)
- [实施与验收计划](docs/delivery-plan.md)
- [质量、安全与发布规范](docs/quality-security.md)
- [架构决策记录](docs/adr/README.md)

