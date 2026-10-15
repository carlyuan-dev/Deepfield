# Deepfield Base.Model 设计文档

版本：0.3 · 日期：2026-10-15

状态：第 3 批实现及本阶段自动验证完成，可交付 staging，等待用户体验验收。安全契约、Pi runtime、Usage collector 及 main／Worker／Capability 接线已落地；本地协议、限定旧包服务兼容、生产边界与打包真实链路端测已完成。本文维护 [Base 抽取设计](base.extraction.设计文档.md) 的 Model 当前契约与验收边界。

## 1. 职责与范围

Model 消费 [Config](base.config.设计文档.md) 已解析的 LLM 运行快照，提供现有 OpenAI 兼容／Anthropic 协议调用、普通文本结果、流式输出、传输故障分类及请求观察，并在实际请求边界接入 [Usage](base.usage.设计文档.md)。本批保持已验收的 Pi 网关行为，让 Chat 与 Capability 实际复用新的底座。

配置管理及快照解析时机归 [Config 与调用方](base.config.设计文档.md#42-配置读取时机不变)；Model 执行中不重新读取 active Profile。会话、上下文、检索策略、工具授权和业务成果仍由上层管理。

按职责拆分现有共享实现，解除 SDK、应用 contracts、Chat 工具名单与宿主全局状态依赖，保持调用、取消与计量语义。

## 2. 当前实现与目标归属

`packages/base/src/model/` 已承载模型执行，桌面共享入口只负责单向兼容转出与进程内装配。当前归属如下。

| 原入口／职责 | 当前归属 | 留在原职责方 |
| --- | --- | --- |
| `shared/model-gateway.ts` 的 `PiModelGateway`、完成结果与模型错误 | Base.Model 契约、错误及 runtime | 标题、识别、诊断和 Agent 编排 |
| `shared/model-request-observation.ts` 的序列化投影与发送观察 | Base.Model runtime | 输入来源的构建、观察记录的保存与使用 |
| SDK `model-observation.ts` 的范围、投影、观察信封 | Base.Model 泛型契约；SDK 精确特化 | 网页来源字段、业务阶段枚举及 SDK 原类型名 |
| `shared/model-http-diagnostic.ts` 的限量读取及分类 | Base.Model runtime | Settings DTO 白名单和用户提示 |
| `shared/usage-collection.ts` 的身份、revision、attempt 更新和幂等终态 | Base.Usage 实例化 collector | 应用 ALS、recorder 绑定、跨进程输送与恢复 |
| 同文件的 `createLlmUsageTransport`、SSE 用量解析 | Base.Model runtime 内部 | Search dispatch 继续使用现有适配 |

上表 `shared/` 均指 `apps/desktop/src/shared/`。公司 `ResearchEvidenceCollector`、证据归档限制、冻结与数据库写入不进入 Base.Model；Pi Agent 执行器留待后续 Agent 批次。

## 3. 公开入口与依赖方向

已提供两个入口，避免只为读取观察类型或安全错误就加载 Pi／Node：

- `@deepfield/base/model`：模型调用接口、完成结果、泛型观察契约、受控诊断及 `ModelGatewayError`。只包含安全类型和错误实现，不加载 Pi、Node、网络客户端或凭据读取代码。
- `@deepfield/base/model/runtime`：`PiModelGateway`、运行端口类型，以及供旧入口兼容转出的 `createLlmUsageTransport`、`observeSerializedRequest`、`classifyModelHttpDiagnostic`、`readModelErrorPrefix`。SSE parser 保持内部实现。

调用接口保持 `createModel`、`getApiKey`、`completeText`、`completeTextResult`、`createStream` 的现有职责和返回语义；原接口中的可选方法继续可选，兼容现有测试替身和宿主端口。runtime 构造增加小范围注入参数，不要求消费者改用新服务注册框架。

可信 main／Worker 使用已解析快照构造和调用；应用的 `modelUsagePort` 在开始 attempt 时读取当前 ALS context，`snapshotIdentity` 是同进程共享的 opaque token mapper：

```ts
import { PiModelGateway } from "@deepfield/base/model/runtime";
import type { ModelToolOrigin } from "@deepfield/capability-sdk";
import { modelUsagePort, snapshotIdentity } from "./usage-collection.js";

const gateway = new PiModelGateway<ModelToolOrigin, "ordinary" | "synthesis">({
  usage: modelUsagePort,
  snapshotIdentity,
});
const result = await gateway.completeTextResult(snapshot, system, prompt, signal);
```

示例中的 snapshot、system、prompt、signal 由调用方提供；凭据快照仅留在可信执行端。桌面旧 `PiModelGateway` 构造器已封装同样装配，保留可选 factories 参数。

请求成功或 Usage 的 `succeeded` 仅说明对应请求边界的结果，不保证输出完整或业务成功。保留 `completeTextResult` 的完成信息和流式 `stopReason`，由上层结合 `length`、JSON 有效性、证据要求等判断业务结果。旧 `completeText` 便利接口语义不变，不因抽取自动修复 JSON、自动重试，或将 `length` 一律转成异常。

公开接口如需引用 Pi 的 `Model`、`Tool` 或流式类型，只作类型依赖，不从安全入口运行时转出 Pi。构建边界验证要覆盖实际转出图，不能只根据文件名或 `import type` 声称 Renderer 安全。需要执行凭据的对象只传到可信 main／worker，不因接口公开就传给 Renderer。

依赖限定如下：Model 使用 Config 的 LLM 契约、Usage 的采集端口及 Pi；Base 不导入应用 contracts、Capability SDK、Chat、公司模块或业务仓储。Usage collector 不依赖 Config／Model；配置身份通过中立 metadata 传入。Config 不反向调用 Model，连接诊断继续由应用编排草稿解析和模型调用。

保留两个 Pi lazy API、DeepSeek compat 和既有 Provider 构造方式，所有当前调用继续显式设置 `maxRetries: 0`。`pi-agent-core` 和共享执行循环不进入本批。包依赖和架构测试仅按实际模块精确允许 Pi、必要 Node 标准库，不放开整个旧业务包或不透明动态导入。

## 4. 请求观察契约

Base 提供 `ModelRequestOriginRange<Origin>`、`ModelRequestObservationInput<Origin, Phase>`、`EvidenceProjection<Origin>`、`ModelRequestObservation<Origin, Phase>` 与对应 observer；`Phase` 限定为字符串类型参数，值由调用方定义。范围位置、映射状态、字节数、哈希与裁剪度量是中立机制，保留现有字段和含义。

SDK 保留 `ModelToolOrigin`、`ModelEvidenceSource`、`SourceDateMetadata` 及现有来源字段；旧观察类型已用 Base 泛型精确特化，例如 `ModelRequestObserver = BaseModel.ModelRequestObserver<ModelToolOrigin, "ordinary" | "synthesis">`。旧消费者仍看到原精确类型，不把其 phase 放宽为任意字符串、origin 放宽为 unknown。retrieval 当前引用的 SDK 来源类型保持原归属。

运行时仅携带 origin／phase，不解释 URL、来源日期、业务阶段或公司证据规则。`createStream`、observer 与 `ObservedStreamOptions` 的泛型关联保持一致，不依赖强制断言接受不匹配的来源和阶段。

观察必须以最终实际序列化的请求为依据，保留以下语义：

- `prepared/not_sent` 与 `dispatched/pending` 分开；取消或准备失败不能伪造发送记录。
- 投影按消息位置与协议结构映射，保留 UTF-16 范围、UTF-8 字节数和哈希。适配器布局改变、外部 payload 改写或无法确定位置时标记 unmapped，不用生成文本匹配猜测来源。
- observer 同步抛错使执行结果拒绝；prepared 阶段失败阻止发送，dispatched 阶段失败可能已有实际请求。不能将证据存储失败变成模型成功或谎报未发送。
- 保留已知响应状态和终态记录；来源接收、限量归档、完整性校验、冻结及 unmapped 的业务处理由调用方负责。

## 5. Usage 采集与快照身份

在 `@deepfield/base/usage/runtime` 提供 `createUsageCollector` 实例工厂，处理身份规范化、attempt 生命周期、增量 metrics、revision 及幂等 finish。时钟、ID 工厂和记录接收者经端口提供；collector 不自行读配置、创建 ALS、打开数据库或注册进程全局状态。

应用保留现有 `configureUsageRecorder`、`withUsageContext` 外观及 ALS 桥接，每个 main／worker 进程持有一个 collector 和一份上下文来源。旧调用与新 Model 注入端口必须使用同一实例；绑定改变只影响后续 attempt，已开始的 attempt 继续使用开始时捕获的 recorder。传输队列、确认、恢复和健康状态沿原应用机制处理。

Model 仅注入 `startAttempt` 小端口，返回现有 `update(metrics)`、`finish(outcome, errorCode?, resultCount?)` 能力。应用桥接在开始时读取当前 ALS context，再委托 collector。端口只接收显式构造的无凭据配置身份：Profile／草稿身份、名称、Provider、modelId、configRevisionId；不传整份快照给 collector，不扩展为完整宿主对象。

`UsageAttemptHandle` 只读暴露 `operationId`／`attemptId`。runtime 的可选 `onRequestAttempt(association)` 在实际 fetch 发起后通知这两个标识与可得的 `requestId`／`modelRequestId`；后两者没有请求观察时可缺省。这些标识粒度不同，不强行视为同一个 ID。通知为 best-effort，回调异常不改变模型结果，也不表示已持久投递；这与失败必须传播的 request observer 不同。发送前失败没有 attempt 或关联通知。默认应用尚无新增关联存储消费者，SDK 事件及 IPC 字段保持原协议，关联不携带请求原文或凭据。

已有 `configRevisionId` 继续作为配置 revision；没有该字段的旧快照仍需满足“同一快照对象多次调用，fallback revision 稳定”。每次新建脱敏 metadata 再作为 WeakMap key 会破坏这一行为，不能采用。

兼容桥接维护 `WeakMap<snapshot object, opaque token>`，每个原快照得到一个空的不透明身份对象。该 identity mapper 在同进程各网关之间共享并显式注入 runtime，只将快照作为 WeakMap key，不读取或复制其字段；Model 将得到的 token 与脱敏 metadata 交给 collector。collector 按 token 缓存 fallback revision，token 不序列化、不入库、不携带凭据；新快照得到新 token。不得对密钥、整份配置或凭据指纹做哈希生成身份。

已有 Profile／operation 等非秘密标识的规范化规则继续保持；fallback token 不替代保存的 revision，也不把草稿诊断合并为已保存 Profile。实例销毁后不承诺无持久 revision 的临时身份跨进程稳定。

LLM 传输层归 Model，继续在实际 fetch 边界开始一次 attempt；本地校验失败、prepared 观察失败和发送前取消不记请求。每个新业务重试独立计量，Agent／Tools 不重复记录同一个请求。Search 继续通过应用薄桥接调用同一 collector，本批不迁移 Search Provider。

发送前失败可以保留受控诊断及已有请求关联，但不能为关联编造 Usage attempt，也不能记录成已发送请求。

SSE 观察保持有界、原字节顺序和背压，不 clone／tee 响应正文、不提前 drain。OpenAI／Anthropic 的累计 token、缓存子集和未知值规则不变；缺失指标保持 null，取消或失败保留已经得到的权威指标。重复终态和较晚片段不能覆盖已结束 attempt。

Usage recorder 失败继续按现有 best-effort 契约处理，不使模型请求失败；这与必须传播的 request observer 错误是两种不同边界。不得借抽取把记录失败静默当成投递成功，现有负确认与输送健康机制继续保留。

## 6. 错误与 HTTP 诊断

`ModelGatewayError` 保留 category、retryable、name、受控 message、diagnostic 和 `stage: "response_body"` 的职责。category 继续使用模型现有细分值；它与 Base.Errors 公共 category 不同，不强行继承 `BaseError` 或改写现有含义。分类不自动触发重试，应用仍负责将模型错误映射为既有 AppError 和用户提示。

安全入口与旧兼容入口引用同一个错误类，保持 `instanceof`；不能在旧壳重新定义同名类。本批不改 AppError／IPC 错误码、恢复动作或错误白名单，不传播原始 Provider message、header、URL、cause 或密钥。

未知错误同样只能输出受控分类与安全提示，不直接透出原始错误文本。

HTTP 非成功响应仍最多读取 clone 的 8KiB 前缀用于分类，支持 caller signal 终止；不等待可能依赖 sibling 的 tee cancellation，不阻塞 SDK 消费原响应。JSON 转义、截断或不可读正文不掩盖已知 HTTP 失败，前缀不保存到错误对象或 Usage。

Base 内部诊断只给受控 `httpStatus`、`reason`、可选 `toolIndex` 和已有 `rootObjectRequired: true` 事实。`toolIndex` 必须是本次请求 tools 名单内确认有效的整数索引；明确索引路径可直接核对，名称证据仅在本次名单中唯一匹配时转成索引。一般性 HTTP400 不猜工具或根对象类型。

应用用本次诊断请求的原 tools 名单将 toolIndex 转回名字，再按现有 `request_user_input/interaction_draft/propose_actions` 白名单构造 Settings DTO；索引不进入旧 IPC。`ModelDiagnosticSchema` 和字段形状保持原样，Base 不内置 Chat 工具名称。该内部变化通过应用适配吸收，不以放宽旧 Schema 换取兼容。

当前完整 HTTP 诊断主要用于 `completeTextResult`，流式路径已有响应体失败分类；迁移不顺带为流式增加新的 HTTP 读取和诊断行为。配置诊断仍携带当前真实 Chat 工具声明发送一次短请求，不执行工具。

响应体读取失败继续记录 `stream_failed`，网关保留 `response_body` 标记；`pi-default-runtime` 捕获当前轮故障，由原执行器映射为 stream_failed。每轮开始清空旧故障，HTTP／Provider 失败和其他提示处理异常不能沿用上一轮标记。

只有 caller signal 的取消确立取消终态；SDK 内部 abort、迭代器清理或协议错误不等于用户取消。caller 取消优先于 body failure；observer 失败不被 body diagnostic 覆盖；内部 body diagnostic 回调异常不改变原响应体错误。这些优先级及普通 completion 的现有取消外观保持不变。

## 7. 实际接线与兼容边界

主进程装配从 runtime 创建网关并注入本进程采集桥接，继续服务 ConfigurationService、连接检查、标题生成及 `model.execution.gateway`。公司识别仍通过现有宿主服务调用 completion，配置解析时机和业务自行重试的快照范围不变。

Worker Chat 继续经 message-loop 的 usage context、PiChatAgent、defaultPiRuntime 使用网关；Capability 继续经 `model.execution`、`usage.context` 和 `createCapabilityAgentRuntime` 接到同一底层。共享执行器和公司原始／结构化阶段策略不搬迁，不能只新增 Base 入口而让实际请求仍走旧实现。

旧 `shared/model-gateway.ts`、`model-request-observation.ts` 使用单向转出或注入薄壳；旧 usage 入口保留应用生命周期桥接，通用采集不再复制实现。SDK 使用精确类型 alias。Base 不能通过旧入口反向加载应用代码。纯转出入口在所有约定消费者清空后才可移除，应用装配职责本身不会因完成抽取而消失。

`model.execution`、`usage.context` 的服务名、原方法和事件形状保持。已使用本批前构建且未重新构建的公司包夹具，通过新 Base runtime，在隔离宿主、内存数据库及本地模拟传输中验证 main completion、Worker 请求观察、响应体失败和 caller 取消四个场景。冻结包字节校验保持一致，测试未使用用户配置或业务数据库。

该证据仅支持该冻结包的上述服务契约兼容范围；冻结旧包的完整生命周期、独立 OS Worker、其他包版本、数据库升级、其他服务、真实 Provider 和 GUI 仍未验证。

## 8. 当前验证与待验收范围

已完成安全入口浏览器打包边界、Base 依赖边界、类型检查和聚焦回归验证：安全入口不加载 Pi／Node，旧入口共享错误类；同快照跨网关 fallback revision 稳定，ALS 上下文隔离；每次实际 fetch 独立计量，未发送不计量；两协议用量、观察投影、原响应字节与背压、HTTP 诊断、取消及响应体故障优先级保持。SDK 泛型负向类型约束和第 7 节旧包服务场景已验证。

Worker assembly 的既有工具列表断言失败已在迁移前基线复现，相关装配与断言保持原样。生产边界已验证正常宿主构建图及移除 Capability 源码后的构建图，验收包已构建并通过隔离启动冒烟。

隔离打包副本已使用当前 DeepSeek `deepseek-flash` 与 Tavily 完成真实链路端测：配置诊断与保存、Chat 流式问答／搜索／关闭联网后历史复用，以及公司资料更新与完整两阶段调研均通过；请求、证据与 Usage 对齐且无重复计量。测试仅注入请求预算守卫，保留原请求与业务行为，退出后清理临时数据。用户体验验收、其他真实 Provider／模型及冻结旧包 GUI 仍待验证。Chat 无取消 UI，取消行为沿用已有本地回归证据。

回归保护覆盖共享 collector／ALS 接线、opaque token 身份稳定、请求／Usage 关联隔离、泛型 alias 兼容、toolIndex 到旧 DTO 的安全映射，以及实际公司 evidence 消费链。后续修改继续复用对应网关、HTTP 诊断、响应体故障、用量、观察与应用接线测试，行为断言保持原契约。

自动验证结合本地协议 fixture、临时数据和上述真实链路端测；真实调用证据限于已验证的 Provider、模型与入口，用户体验仍待验收。

主要风险是重复 collector／ALS、快照脱敏后的 fallback 身份漂移、错误类或 observer 类型分裂、运行时进入 UI，以及改变取消／故障优先级。通过限定入口、显式注入和对应回归验证控制。

本批迁移保持已验收的 Prompt、工具 schema 行为、Loop、收口策略及业务流程。
