# Deepfield Base.Errors 设计文档

版本：0.1 · 更新日期：2026-10-13

状态：设计及首批实施边界已获用户确认，尚未实现。当前错误实现仍在 `packages/contracts/src/errors.ts`；本文件是长期契约，不包含开发派工和逐步执行记录。

## 1. 职责与取舍

目标入口为 `@deepfield/base/errors`。它统一中立错误结构、错误分类、受控公开转换和成功／失败结果包装，不集中所有业务错误码，不承担重试、日志、UI 文案或 HTTP 映射。

各模块自行定义错误码、上下文及边界校验器；新增业务码不要求修改 Base。当前应用的固定码表继续保留在 contracts，作为既有 IPC 出口的白名单，而不是所有未来模块的全局注册表。

`configuration/external/input/business/resource/storage/internal` 描述故障类别，不代表可重试性。例如认证失败与超时同属 external，但恢复动作不同；恢复策略由各模块决定。

依赖方向：调用方 → contracts 兼容适配 → Base.Errors。新模块可直接使用 Base.Errors；Base 不导入 contracts、Capability SDK、Chat、业务仓储或 Electron。

## 2. 目标公开契约

以下是已批准的目标接口，不表示当前包已经导出这些符号：

```ts
type ErrorCategory = "configuration" | "external" | "input" | "business"
  | "resource" | "storage" | "internal";
interface ErrorIdentity<C extends string = string, X = unknown> {
  code: C;
  category: ErrorCategory;
  context?: X;
}
class BaseError<C extends string = string, X = unknown> extends Error {
  readonly code: C;
  readonly category: ErrorCategory;
  readonly context?: X;
  constructor(code: C, category: ErrorCategory, context?: X, options?: ErrorOptions);
}
interface PublicErrorCodec<E extends ErrorIdentity> {
  parse(candidate: unknown): E | undefined;
  unknown(): E;
}
function serializeError<E extends ErrorIdentity>(value: unknown, codec: PublicErrorCodec<E>): E;
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
function captureResult<T, E>(work: () => T | Promise<T>, toError: (error: unknown) => E): Promise<Result<T, E>>;
```

`BaseError` 的 name 为 `BaseError`、message 为 code，保留 ErrorOptions 的 cause 供内部定位。context 只是候选信息，不意味着其任意字段均获准公开。不添加自动 `toJSON`、全局错误注册中心或庞大异常子类树。

## 3. 公开转换与安全边界

- `serializeError` 对普通 Error 只投影 code、category 和存在的 context；不要求它来自同一个 AppError 类。非 Error 候选对象原样交给 codec，不能先删掉非法字段再冒充合法 DTO。
- codec 是调用方提供的局部校验／复制策略。`parse` 完整验证候选值；不匹配返回 undefined，匹配后仅构造允许字段的独立 DTO。`unknown` 每次返回新的安全兜底对象。
- cause、原始 message、stack、API Key 不进入公开结果。新模块的上下文须由自己的出口校验并复制；Base 不猜测业务字段，也不提供通用递归脱敏承诺。
- 扩展错误码不代表自动通过所有传输边界。模块本地 codec 可以识别其新码，既有应用 IPC 对不在自身白名单的码仍回退为 `INTERNAL.UNKNOWN`。
- codec 的程序异常不再次被吞掉。`captureResult` 捕获 work 的同步抛错／异步拒绝，但转换回调自身失败仍拒绝，不能将适配器缺陷伪装为已处理的业务失败。不扩展对任意 getter、Proxy 或跨 realm 对象的不抛错保证。

## 4. 首批兼容要求

`packages/contracts/src/errors.ts` 保留以下公开接口、码表与 Schema：

- `AppError(code, context?, options?)` 改为继承 BaseError，但 name 仍为 `AppError`、message 仍为 code。
- `toPublicError(value)` 委托中立转换器；现有 code/category 配对、仅含 llm/search 的 context service、额外字段拒绝及 UNKNOWN 规则不变。
- `appResult(work)` 委托结果包装器，`AppResult<T>` 使用同一 Result 结构；不留下第二份通用实现。
- IPC 继续只公开 `{ code, category, context? }`；缺省 context 不变成空对象，输出 context 不共享输入引用。

不借本批统一 SDK、Tool、Model 或 Search 既有独立错误协议，不改变用户恢复入口、诊断提示或自动重试行为。只有 Base 核心可导入还不算完成，现有调用链必须实际复用新实现。

## 5. 后续维护

实现完成后更新本页状态和真实导出，使用必要的独立错误码、兼容转换、敏感信息隔离及既有 IPC 检查验证。具体派工、测试运行输出和命令执行清单只留本地，不作为本页的依赖。

其他能力域的归属与迁移边界见 [Base 抽取设计](base.extraction.设计文档.md)，总目录见 [Base 总览](base.overview.设计文档.md)。未来确需扩展传输协议时单独设计，不能通过放宽旧白名单“顺便兼容”。
