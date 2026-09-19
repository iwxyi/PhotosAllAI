# PhotoAllIsAI 企业级系统架构

> 状态：基线设计  
> 版本：0.1  
> 日期：2026-09-18

## 1. 目标与质量属性

系统面向包含数万张普通图片与 RAW 文件的本地图库，在 macOS 和 Windows 上提供流畅浏览、可靠文件管理、AI 视觉分析、持久化生成队列和非破坏性版本管理。

架构优先级从高到低为：

1. 数据与原图安全。
2. 前台浏览响应性。
3. 任务可恢复与结果可追溯。
4. 服务商和图像引擎可替换。
5. 跨平台一致性与平台原生集成。
6. 可测试、可诊断、可升级。

## 2. 系统上下文

```text
用户
  │
  ▼
PhotoAllIsAI Desktop
  ├── 本地文件系统 / 外接盘 / 网络卷
  ├── 系统凭据库
  ├── OpenAI Compatible API
  ├── NanoBanana Compatible API
  └── 系统回收站 / 文件管理器 / 原生菜单
```

本应用是 local-first 桌面系统。图库数据库、任务状态、生成结果和缓存默认保存在本地；只有用户配置并执行 AI 操作时才向相应服务发送图片和文本。

## 3. 进程架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Electron Renderer                                            │
│ React UI / View Models / Commands / Keyboard / Accessibility │
└─────────────────────────────┬────────────────────────────────┘
                              │ typed IPC
┌─────────────────────────────▼────────────────────────────────┐
│ Electron Main                                                │
│ Window / IPC Gateway / Credential / Provider / App Lifecycle │
└──────────────┬──────────────────────────────┬────────────────┘
               │ RPC                          │ HTTPS
┌──────────────▼────────────────┐   ┌─────────▼────────────────┐
│ Image & Library Service       │   │ External AI Providers    │
│ Rust sidecar                  │   │ capability adapters      │
│ scan/db/decode/cache/files    │   └──────────────────────────┘
└───────────────────────────────┘
```

### 3.1 Renderer

Renderer 只负责表现与交互，不直接读取任意文件、不持有 API Key、不拼装服务商请求、不执行数据库 SQL。它通过受控 IPC 调用用例，并接收事件或分页结果。

### 3.2 Main

Main 是桌面权限和应用生命周期边界：

- 创建窗口、菜单、托盘和系统对话框。
- 校验所有 Renderer IPC 输入。
- 管理系统凭据库。
- 管理 sidecar 生命周期和协议版本。
- 执行 AI Provider 适配器和网络安全策略。
- 处理自动更新、崩溃恢复和单实例锁。

### 3.3 Image & Library Service

生产实现采用 Rust 独立 sidecar。它拥有图库数据库与本地文件操作：

- 目录扫描、监视、资源指纹和重新定位。
- 目录事件去抖采用脏状态循环，保证扫描期间的新事件触发后续扫描；监听错误进入退避重连，恢复后重新协调离线资源。
- SQLite 事务、迁移、搜索和任务持久化。
- 缩略图、预览、RAW 解码和导出。
- 原子写入、文件移动、复制、校验和回收站协议。
- 调度 CPU/IO 工作，向前台任务让出资源。

首个垂直切片允许使用 TypeScript 内存适配器，但端口协议不得依赖实现语言。

## 4. 模块边界

代码采用端口与适配器结构，依赖只能指向内层：

```text
presentation → application → domain
                         ↘ ports ← infrastructure adapters
```

| 模块 | 责任 | 禁止事项 |
| --- | --- | --- |
| `catalog` | 资源、文件夹、相册、标签、选择集 | 不调用 AI 服务 |
| `viewer` | 预览、缩放、比较、版本导航 | 不写原图 |
| `analysis` | 分析请求、契约校验、分析版本 | 不直接生成文件 |
| `generation` | 生成方案、批次、结果、重试 | 不管理 UI 状态 |
| `templates` | 模板与版本、变量解析 | 不保存凭据 |
| `tasks` | 状态机、优先级、恢复、取消 | 不解释业务提示词 |
| `files` | 文件事务、冲突、恢复日志 | 不决定产品确认策略 |
| `export` | 导出预设、命名、编码和报告 | 不修改内部版本 |
| `providers` | 能力发现、请求/响应转换 | 不暴露厂商对象到领域层 |
| `settings` | 用户偏好和策略 | 不保存明文密钥 |
| `telemetry` | 本地日志、指标、诊断包 | 不采集图片和提示词正文 |

## 5. 领域模型与不变量

### 5.1 聚合

- `Asset`：原图身份、当前位置、指纹和离线状态。
- `AnalysisRevision`：不可变分析快照，可被新版本替代但不覆盖。
- `GenerationPlan`：分析动作、模板、用户要求和保护规则的组合。
- `GenerationBatch`：一次生成 N 张的业务操作。
- `GenerationTask`：一个可调度执行单元。
- `GenerationResult`：持久文件、内容哈希和评价状态。
- `PromptTemplate`：可编辑身份；具体内容存在不可变版本中。
- `FileOperation`：移动、复制、重命名、删除的事务日志。

### 5.2 关键不变量

- `Asset` 原始内容不被分析或生成任务覆盖。
- 完成的生成任务必须且只能关联一个已校验的结果文件。
- 运行中任务参数不可变；修改产生新任务或取消后重建。
- 已入队任务引用模板版本快照，而不是模板当前版本。
- 版本序号对单个 Asset 单调递增且不复用。
- 删除数据库记录前先处理持久文件，或在同一补偿事务中记录待清理状态。
- Provider 响应必须转换并通过内部 Schema 校验后进入领域层。

## 6. 数据架构

### 6.1 SQLite

SQLite 使用 WAL 模式，启用外键和忙等待；所有 schema 变更使用单向版本迁移。主要表组：

- catalog：`libraries`, `folders`, `assets`, `asset_locations`, `albums`, `album_assets`, `tags`, `asset_tags`
- analysis：`analysis_revisions`, `analysis_issues`, `adjustment_suggestions`, `generative_actions`, `catalog_annotations`
- generation：`generation_plans`, `generation_batches`, `generation_tasks`, `generation_results`, `version_groups`
- templates：`prompt_templates`, `prompt_template_versions`, `template_examples`
- operations：`file_operations`, `file_operation_items`, `task_events`, `exports`
- system：`schema_migrations`, `settings`, `provider_profiles`, `outbox_events`

用户凭据不进入 SQLite。Provider Profile 只保存凭据引用 ID。

### 6.2 ID、时间与并发

- 领域 ID 使用 UUIDv7 或 ULID，兼顾全局唯一和时间排序。
- 数据库时间统一保存 UTC 毫秒，UI 按系统时区显示。
- 可编辑实体包含 `revision`，更新使用乐观并发控制。
- 长任务状态变化同时写入当前状态和追加式 `task_events`。

### 6.3 搜索

第一阶段使用 SQLite FTS5 索引文件名、用户标签、AI 标签、短描述、长描述和 OCR。结构化筛选使用普通索引。向量索引通过独立端口后续接入，不改变查询用例。

## 7. IPC 与协议

### 7.1 原则

- IPC 通道使用明确命名和版本，例如 `catalog.assets.list.v1`。
- 请求与响应使用共享 Schema 在两端运行时校验。
- Renderer 不能提交任意路径给通用“读文件”接口。
- 列表接口必须分页或基于游标，禁止一次返回全图库。
- 大图只传受控协议 URL、文件句柄或共享缓冲信息，不传 Base64。
- 长操作返回 `operationId`，进度通过事件通道发送。

### 7.2 错误模型

统一错误包括：

```ts
type AppError = {
  code: string;
  message: string;
  retryable: boolean;
  operationId?: string;
  details?: Record<string, unknown>;
  causeId?: string;
};
```

`message` 可展示但不包含秘密；诊断细节通过 `causeId` 在本地日志关联。领域错误、Provider 错误和系统错误都转换为该模型。

## 8. Provider 架构

```ts
interface VisionProvider {
  capabilities(): VisionCapabilities;
  testConnection(signal: AbortSignal): Promise<ConnectionTest>;
  analyze(request: AnalyzeRequest, signal: AbortSignal): Promise<AnalysisEnvelope>;
}

interface ImageGenerationProvider {
  capabilities(): GenerationCapabilities;
  testConnection(signal: AbortSignal): Promise<ConnectionTest>;
  generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationSubmission>;
  poll?(remoteId: string, signal: AbortSignal): Promise<GenerationPoll>;
  cancel?(remoteId: string): Promise<void>;
}
```

适配器负责认证、限流、超时、重试、响应格式和能力差异。业务层只使用内部 DTO。URL 返回结果必须限制协议、响应大小、重定向次数和下载超时，防止 SSRF 与磁盘耗尽。

## 9. 任务调度

任务分为交互预览、分析、生成、文件操作、导出和后台索引六类队列。调度原则：

- 预览最高优先级并可取消过时任务。
- 生成默认并发为 1，按 Provider Profile 单独限流。
- 文件移动与删除按涉及路径加互斥锁。
- 任务执行使用租约与心跳；崩溃后过期租约转为待恢复。
- 每次外部副作用前后写检查点，保证至少一次执行下结果不重复入库。
- 重试使用指数退避、随机抖动和错误白名单。
- 取消是协作式的；不能远端取消时标记“本地已取消”，丢弃随后返回的结果或按策略保留为孤立结果。

## 10. 文件事务

文件操作采用 plan/execute/verify/commit 四阶段：

1. `plan`：解析所有源与目标，检测权限、空间、冲突和关联文件。
2. `execute`：同卷原子移动；跨卷复制到临时名。
3. `verify`：检查大小与哈希，确认目标可读。
4. `commit`：更新数据库并移除或回收源；写完成事件。

任何阶段失败都保留足够日志进行补偿。目录扫描器忽略应用受管目录和当前文件事务的临时文件。

## 11. 前端架构

### 11.1 技术栈

- Electron、React、TypeScript、Vite。
- Zustand 管理短生命周期 UI 状态。
- TanStack Query 管理 IPC 查询缓存和失效。
- Zod 定义 Renderer/Main 共享运行时 Schema。
- React Router 管理工作区标签内容路由，不把标签状态等同于浏览器历史。
- CSS Variables 管理设计令牌；动画优先使用 Web Animations 或轻量运动库。

### 11.2 状态所有权

- 数据库实体状态：查询缓存，服务端为真相来源。
- 选择、焦点、面板尺寸、查看模式：工作区 View Model。
- 草稿提示词和未提交设置：表单状态。
- 任务实时状态：持久快照 + 事件增量，重连后重新对账。
- 不允许把完整图片二进制放入全局状态库。

### 11.3 命令系统

菜单、右键菜单、按钮、快捷键和命令面板统一引用 Command Registry。每个命令定义 ID、标题、快捷键、可见性、启用条件、执行器和危险级别，避免同一操作出现不同行为。

## 12. 配置、日志与可观测性

- 设置分为应用级、图库级和工作区会话级，优先级明确。
- 日志采用结构化 JSON，包含时间、级别、模块、operationId 和 causeId。
- 默认脱敏路径中的用户名，不记录 API Key、请求头、图片内容和完整提示词。
- 诊断包由用户主动生成，可预览内容后导出。
- 图库数据库备份使用 SQLite 一致性快照（`VACUUM INTO`），不直接复制活动数据库、WAL 或 SHM 文件；备份结果返回字节数和 SHA-256，Provider 凭据不进入快照之外的导出路径。
- 采集本地性能指标：首图时间、缩略图命中率、解码耗时、队列等待时间、内存峰值和掉帧区间。
- 任何远程遥测默认关闭，未来加入时必须独立征得同意。
- 本地诊断可只读扫描 SQLite 与受管生成目录，输出数据库状态、引用缺失、路径边界、文件类型和孤立载荷计数；不得把文件名、绝对路径、提示词或图片内容写入诊断快照。轻量诊断不替代完整备份中的 SHA-256 校验。

## 13. 升级与兼容

- 应用版本遵循 SemVer；数据库和 sidecar 协议独立版本化。
- 任何服务打开数据库并执行 Schema 迁移前，先用 `VACUUM INTO` 创建带 SHA-256 的一致性 checkpoint；全部服务成功初始化后才提交应用 Schema 版本。若进程在迁移中失败或崩溃，下次启动会在业务连接建立前校验并恢复 checkpoint，同时保留失败数据库用于诊断。高版本图库拒绝由低版本应用打开。
- Main 启动时验证 sidecar 版本和能力，不兼容时拒绝打开图库并提供修复信息。
- Provider 请求与分析结果保存 schema 版本，读取层负责兼容旧版本。
- 自动更新包必须签名；macOS 使用公证，Windows 使用代码签名。

## 14. 部署形态

- macOS：universal 或分别提供 arm64/x64，经 Hardened Runtime 和 notarization。
- Windows：优先 x64，安装器支持当前用户安装与可靠卸载。
- 原生 sidecar、迁移文件和静态资源随应用签名打包。
- 用户图库和生成文件不随卸载默认删除。

## 15. 架构验收门槛

一个模块进入稳定实现前必须满足：

- 领域不变量有自动化测试。
- 公共端口有 Schema 和契约测试。
- 文件副作用有失败注入测试。
- Renderer 不能绕过 preload 暴露的白名单 API。
- 错误可通过 operationId 在日志追踪。
- 任务在进程崩溃后可恢复到一致状态。
- macOS 与 Windows 的关键路径均有验证记录。
