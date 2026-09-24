# Capability v2 开发指南

本指南对应当前仓库的 SDK、构建器和启动加载器。Capability 是自包含的本地业务包；Chat 通过公开动作使用它，UI、Worker、任务和产物均为可选部分。协议不限定业务领域。随仓库提供的 [`record-lookup`](../../examples/capabilities/record-lookup/README.md) 用三条固定记录演示最小的即时只读动作；它不是实际工单库产品。

## 1. 从最小包开始

在仓库根目录、Node 24.17+ 环境执行：

```sh
npm install
node -e 'import("./examples/capabilities/record-lookup/build.ts").then(async ({ buildPackage }) => { await buildPackage("/tmp/record-lookup-package"); })'
npx vitest run tests/capabilities/chat-protocol.test.ts
```

构建产物包含 `capability.json`、`package.json`、`dist/main.js` 和 `docs/actions/records.find.md`。只需分发整个产物目录，安装时无需 `npm install` 或编译 TypeScript。示例没有 `worker`、`ui`、`navigation`、`views` 和宿主服务需求；`npm run build:capabilities` 只构建仓库 `capabilities/` 下的正式包，不会自动安装此 `examples/` 示例。

源文件分工：

| 文件 | 作用 |
| --- | --- |
| `capability.json` | 非执行清单：稳定包 ID、语义化版本、协议与宿主 API 版本、入口和需求；源码中的 `actions` 留空，由构建填写。 |
| `actions.ts` | 用 `defineAction` 定义 ID、用途、影响、输入/输出 TypeBox Schema、说明路径、权限、确认规则和处理器。 |
| `main.ts` | `bootstrap(registrar, services)` 在 main 进程注册构建出的公开动作。 |
| `docs/actions/*.md` | 模型按需读取的操作说明；构建时与动作契约一起计算摘要。 |
| `docs/help.md` | 可选的面向用户的能力介绍；在清单 `help` 中声明路径，并随包一起构建。 |
| `build.ts` | 打包自带依赖的 ESM 入口，使用 `compileActionCatalog` 生成声明，再执行 `verifyBuiltActionCatalog`。 |

示例调用输入是 `{ "query": "交付", "limit": 1 }`，完成数据为 `{ "items": [{ "id": "sample-1", "text": "交付时间待客户确认" }], "truncated": false }`。两个参数必填。`limit` 为 1–50 的整数，`query` 长度为 1–200；多余字段被拒绝。开发自己的包时，从自己的领域服务中读取数据，保留相同的通用动作边界即可；不必沿用示例的记录模型。

## 2. SDK 与构建约定

当前公开 SDK `@deepfield/capability-sdk` 提供 `defineAction`、`ActionDefinition`、`CompiledActionDeclaration`、`CapabilityRegistrar`、`CapabilityHostServices`、`ActionOutcome`，以及可选任务、产物、页面的引用和 Provider 类型。Node 构建工具位于仓库的 `scripts/capabilities/build-actions.ts`，提供 `compileActionCatalog` 与 `verifyBuiltActionCatalog`；它们是构建期工具，不是运行时 SDK 导出。TypeBox 的 `Type` 用于同一份输入/输出 Schema。不要手写第二份动作 JSON Schema 或构建摘要。

v2 清单使用 `protocolVersion: 2`、`hostApiVersion: 2`。`entries.main` 必填；`entries.worker`、`entries.ui` 与 `help` 可省略。`requirements` 列出启动前必须存在的命名宿主服务；无需求时用空数组。当前 `CapabilityHostServices.version` 是 `1`，这是命名服务对象自身的版本，与清单的 `hostApiVersion: 2` 不同。主入口收到的 `registrar.registerAction` 是 v2 可选方法类型，包应检查其存在；注册声明必须与打包清单一致，否则激活失败。

动作指定 `mode: "immediate" | "task"`、`effects.data: "read" | "write" | "destructive"`、`effects.consumesResources`、`permissions` 和 `requiresConfirmation`。输入与输出都由宿主校验。`immediate` 处理器可返回 `{ status: "completed", data }`；异步任务返回 `accepted` 并需要包自己的任务提供器。写操作、破坏性操作和消耗资源的任务应按实际影响声明，确认由宿主可信通道管理，不能在输入里伪造 `confirmed: true`。调用身份、会话、`invocationId` 由宿主补充，包处理器不应从模型输入取这些值。

可选模块按实际需要添加：有页面才声明 `ui`/`views` 并注册页面解析器；有后台任务才声明 `worker` 或在 main 中接入自己的任务执行器并注册 TaskProvider；有可读长结果才注册 ArtifactProvider。小结果直接作为 `completed.data` 返回，不要求为它创建产物。LLM、Search、Usage 只能通过宿主明确提供的服务接口使用；不能读取整个配置或密钥。v1 旧包仍可服务原 UI，但不会自动获得 v2 Chat 动作入口。

### 可选真实表单与 Chat 共同编辑

若公开动作已有真实编辑页，在 `bootstrap` 中与 `registerAction` 一起调用可选的 `registrar.registerFormProvider?.([{ id: "note-edit", actionIds: ["notes.save"], description: "编辑便签" }], provider)`。`actionIds` 必须是本包实际注册的公开动作；一个表单可覆盖多个阶段动作。提供方实现 `prepare/read/update/transition/validate/submission/release`，返回含 `DraftRef`、真实 `ViewRef`、当前值、输入约束、步骤、可转换项与可提交状态的快照。业务数据只存在包自己的草稿里，`submission` 从已校验草稿产生现有动作输入，实际执行仍经公共动作网关。多阶段流程可实现 `afterAction`，依据真实成功回执更新草稿并要求下一动作重新确认；普通步骤切换不执行动作。

关联页面收到可选 `interactionEditor` 时，先 `read()` 取得当前修订；用户开始编辑即调用 `beginEdit(revision)`（返回 `void`），成功后再 `read()` 取得本次锁的新修订并用于 `update` 或 `transition`。同步和校验完成后才允许 `respond(revision, "approve" | "cancel")`。模型修改同一草稿时也须带预期修订；冲突后重新读取，不覆盖用户修改。页面本地可留尚未同步的输入缓冲，但不能再保存一份独立的待执行参数。`interactionEditor` 已绑定一个会话内待办，包不能自行构造批准票据。普通人工入口没有该桥时，仍按原页面提交路径工作。

不提供表单绑定的 v2 包仍可被 Chat 调用；需确认动作显示只读摘要。损坏的可选声明不应让相应动作失效。请用 `tests/capabilities/form-protocol.test.ts` 的离线便签夹具核对发现、共享修改、网关提交与禁用后启动快照；该夹具不证明自己的 UI 组件已接线，实际页面和连续步骤仍应手测。

### 面向用户的说明与确认

动作的 `title` 和 `description` 应使用用户能理解的业务语言，但属于模型调用契约，不自动拼接成用户功能目录。开发者交付 Capability 时应提供面向用户的说明；v2 清单字段 `help` 可选仅为兼容旧包，缺失不阻止加载。新包应声明 `"help": "docs/help.md"`：路径须为包内相对路径，文件使用 UTF-8 Markdown，简洁说明用户能做什么、会得到什么，并给出自然语言示例；不要写动作 ID、参数、Schema 或权限架构。构建时须把该文件复制进包。未声明、缺失、空白或无法安全读取时，功能目录仅显示包名，不退回技术动作说明。包应维护“业务按钮 → 公开动作、任务控制或页面导航”的对应关系，UI 与 Chat 委托同一业务服务；不要通过模拟点击或自动公开全部内部 IPC 来补齐功能。

`/help` 直接读取本轮工具与 ready 能力的用户帮助快照；自然语言询问“有哪些工具、功能、能力”时，主 Agent 应先调用只读“查看可用功能”工具，再按同一目录简洁回答。两条路径使用同一模板；帮助正文可在启动时缓存，但不逐轮塞入系统提示，只在查询时展示。具体业务操作应继续执行。机器参数、ID、引用和游标用于内部调用，普通答复写用户看得懂的名称、动作与真实结果；用户明确要求技术细节时可以解释。不要用全局正则删 UUID，以免损坏代码、链接或业务内容。

需要确认的动作提供运行时 `presentInput(input)`，返回 `{ title, fields: [{ label, value }] }`，也支持异步查询目标名称。用它展示公司名、范围、日期、删除影响等实际业务参数，而不是打印原始 JSON。标题最多 120 字符、字段最多 12 个、标签最多 60 字符、值最多 4000 字符；内容必须非空。写入、删除或消耗资源的动作缺少该投影时，宿主不允许用空确认卡批准执行。投影失败或不合法时也拒绝继续，不静默截断待确认目标。该函数不进入编译清单，授权仍绑定原始输入和调用身份，不绑定展示文字。

业务可选提供运行时 `presentOperation(input)`，在输入与权限校验后返回不改变业务数据的预览 `{ text, linkLabel?, target?, autoOpen? }`；也可在动作结果（四种状态）与 `TaskSnapshot` 中返回同形态 `presentation`，说明真实进度和结果。`text` 非空、最多 1000 字符，`linkLabel` 非空、最多 80 字符。`target` 只能是本包的 `ViewRef` 或 `DraftRef`，必须经已有页面解析器校验；`autoOpen` 没有 target 不生效。不要在预览回调中创建主题、入队、导出或提交，更不能模拟用户确认。它不进入编译清单摘要，也不参与授权。缺失、抛错或非法的可选呈现只会被丢弃，不阻断业务调用；必要的 `presentInput` 安全确认仍单独生效。宿主只对新发起、当前会话且未被用户手动导航打断的操作尝试自动打开一次，后台进度不会反复抢焦点。没有可选呈现的动作不生成专属操作卡。

确认后即时执行的动作，可在输出 Schema 中声明 `data.summary` 并返回简洁、真实的业务结果，宿主会把结果关联到原 Chat 轮次，供用户查看及后续对话使用。取消保存不能返回“导出成功”；异步任务应返回任务回执，不能提前宣称完成。涉及收费的即时操作也应显式要求确认；例如文本识别和添加后自动补全，不能只因不是长任务就忽略消耗。

## 3. 安装、启用与更新

先完全退出应用。将整个构建产物目录复制到该应用实例的 `userData/capabilities/<包目录>/`，例如：

```sh
export DEEPFIELD_USER_DATA='/实际的应用数据目录'
mkdir -p "$DEEPFIELD_USER_DATA/capabilities"
cp -R /tmp/record-lookup-package "$DEEPFIELD_USER_DATA/capabilities/record-lookup"
```

`DEEPFIELD_USER_DATA` 必须换成当前安装实例的真实应用数据目录；不要复制到开发仓库的 `capabilities/` 源码目录或已签名应用内。安装新包后启动应用，在“设置 → 能力”勾选“示例记录查询”，再重启应用。新放入的包默认关闭；勾选只改变下次启动配置。启动时读取清单并生成快照，运行期间不会热加载。缺入口、缺说明、路径越界、重复 ID、协议不兼容或缺宿主服务会使该包不可用，其他包与 Chat 仍可运行。

更新已有包时，先退出应用并保留旧产物备份，然后用新构建的完整目录替换对应包目录，启动后核对版本与状态；需要回滚时退出应用、恢复旧目录再启动。已有安装不会自动被应用内置副本覆盖。新增兼容动作提高次版本；删除、改名或不兼容参数变更提高主版本；修复与说明更新提高补丁版本。每次构建都会重新计算动作及说明摘要，旧会话中的过期说明或动作调用需要重新核对，不会自动映射到新语义。禁用或移除包后，历史对话和业务数据不会因此自动删除。

只安装自己编写或经用户审阅认可的可信本地包。包的 main/Worker 入口是运行代码；当前宿主不提供不可信代码沙箱、在线更新或插件市场。这个信任约束与业务领域无关，任何方向的业务都可以按相同接口接入。

## 4. 最小验收

可选的具体操作提案：在可批量确认的 immediate 非破坏性动作上声明 `taskAuthorization: { family: "your-family", mode: "exact_input" }`，重新构建使声明进入契约摘要。`presentInput` 必须完整说明对象、目标、实际影响和资源消耗；不要只显示数量或内部 ID。模型用 `propose_actions` 提交至多 10 个同包同 family 的完整调用，宿主先展示，再接受真实用户的按钮或文字确认。字段只是提案准入声明，绝不是免确认或整个 family 的权限。

每项仍按原动作网关执行。当前表单编辑后生成新的提案版本；确认旧修订不能执行。`afterAction` 产生的动态输入不会自然继承权限，只有与预先列明的下一项完整输入相同时才可继续。不要为用户尚未见到的模型识别结果声明宽泛授权；先显示具体候选再确认。未声明此扩展的包无需修改。

1. 在隔离目录构建，检查产物的清单、入口、说明和动作摘要能通过 `verifyBuiltActionCatalog`。
2. 只把该包放进隔离扫描目录；启用后目录仅出现预期动作。执行 `describe` 获取契约，再用真实网关 `invoke`，检查校验后的 `completed.data`。本仓库的 `tests/capabilities/chat-protocol.test.ts` 覆盖这条记录查询路径，不依赖公司调研包。
3. 输入非法 `query`/`limit` 应被拒绝；没有 UI/Worker/任务的包不应要求这些模块。
4. 从隔离扫描目录移除包，再启动应得到空目录；核心 Chat 可在零包状态运行。不要为测试扫描、覆盖或删除真实用户数据。
5. 若自己的包声明写操作、确认、任务、产物或页面，再分别验证真实宿主边界；记录查询示例不声称覆盖这些能力。当前 Chat 页面在需要确认时显示“操作确认”卡和“确认执行”按钮，任务接收后显示“任务”卡；“完成后分析”由用户选择。公司调研的“确认 → 队列 → 报告读取”由同一测试文件中的离线集成路径验证。
