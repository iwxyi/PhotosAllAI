# PhotoAllIsAI

PhotoAllIsAI 是一款面向 macOS 与 Windows 的 AI 原生图片管理和生成式修图桌面应用。

项目当前处于可运行的垂直切片迭代阶段。产品聚焦大量图片浏览、选片与图片批任务生成，后续仅考虑轻量剪辑，不做网页素材采集。图库、文件管理、AI 分析与生成队列、模板、版本比较、导出和跨平台打包已有实现；大目录首屏、超大图库长期性能、RAW 全尺寸与跨平台发行仍需逐项验证或完善。当前范围、能力状态与后续验收见[浏览与批量生成路线图](docs/browsing-batch-generation-roadmap.md)，长期设计见[产品设计](docs/product-design.md)，工程边界见[系统架构](docs/architecture.md)。

## 核心原则

- 原图默认不被后台任务修改。
- AI 分析、生成任务和生成版本完整可追溯。
- 浏览、文件管理、AI 队列和导出互不阻塞。
- 默认由程序管理生成结果，同时提供可靠的批量导出。
- macOS 与 Windows 使用同一业务核心并分别通过平台验收。

## 文档

- [大量图片浏览与批量生成路线图](docs/browsing-batch-generation-roadmap.md)
- [产品与系统设计](docs/product-design.md)
- [企业级系统架构](docs/architecture.md)
- [实施与验收计划](docs/delivery-plan.md)
- [质量、安全与发布规范](docs/quality-security.md)
- [架构决策记录](docs/adr/README.md)

## 本地开发

使用 `pnpm dev` 启动应用。页面修改会热更新；主进程和预加载脚本修改会自动重建并重启 Electron，使原生菜单、快捷键和 IPC 同步生效。重启会关闭当前窗口，未保存的输入需要先保存。此前已运行的开发进程需要退出并重新执行一次 `pnpm dev` 才能启用监听。

## 本地打包

`pnpm package:dir` 会构建当前平台的未签名可运行目录。macOS 和 Windows x64 的安装包分别使用 `pnpm package:mac`、`pnpm package:win`；签名、公证和证书由发布环境注入，仓库不包含任何证书或私钥。macOS 上的 Windows 交叉构建只验证产物生成，不能替代 Windows x64 真机安装、升级、卸载和硬件兼容性验收。

RAW 预览优先使用 Electron 原生解码；如果系统安装了 ImageMagick（`magick` 命令），应用会在原生解码失败时使用受限的外部适配器生成预览。该适配器使用无 shell 参数调用、30 秒超时和 20 MiB 输出上限，未安装时不会阻止普通图片和图库管理功能。
