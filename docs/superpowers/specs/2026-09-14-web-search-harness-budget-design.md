# Web Search Harness 预算与终止设计

## 背景

Deepfield 的 Chat 采用自建 `web_search` 与 `read_webpage` 工具，而不是依赖某个 LLM Provider 的原生联网能力。LLM 负责选择工具和参数，Deepfield Harness 负责权限、执行、预算、循环、持久化和最终回答。

当前实现能在 ToolRunner 中阻止超过额度的外部调用，但存在三个缺口：

1. 模型在决策前不知道当前剩余额度，可能在一个 assistant turn 中生成超过额度的工具批次。
2. 预算只在单个工具开始执行时检查，导致同批超额调用逐个显示为失败；模型要等整批结束后才能看到这些结果。
3. 任一类别出现 `budget_exceeded` 后，Chat 会关闭全部工具，没有保留搜索与网页读取的独立额度语义。

本设计为 Chat 建立可复用的预算感知 Harness。未来的单公司调研和行业调研可以复用底层控制结构，再增加 Planner、证据覆盖和来源质量策略。

## 目标

- 在每次 LLM 工具决策前暴露准确的剩余预算。
- 在任何外部请求开始前完成整批工具调用的准入与裁剪。
- `web_search` 与 `read_webpage` 使用独立、共存的额度。
- 已准入并进入外部执行的调用，无论成功、超时、限流或服务商失败，都消耗一次对应额度。
- 执行前被 Harness 裁掉或复用缓存的调用不消耗额度。
- 工具失败原因安全、结构化地返回模型。
- 始终保留一次关闭工具后的最终回答轮，并流式输出最终回答。
- 工具批次、轮次、失败、跳过和复用状态可持久化与恢复显示。
- Search Provider 保持纯能力层，不感知 Agent、Prompt、额度或循环。

## 非目标

第一版不实现：

- 语义相似查询去重；
- LLM 检索 Planner；
- 多 Search Provider 自动降级；
- 根据任务复杂度自动调整预算；
- 来源权威性自动评分；
- Token 或人民币成本路由；
- 调研阶段专用 Harness。

## 架构原则

调用关系为：

```text
Chat / Research Harness
        ↓
AgentRunControl
        ↓
ToolBatchAdmission
        ↓
ToolRunner
        ↓
Search Provider
```

各层职责：

- Chat/Research Harness：选择策略并驱动一次 Agent run。
- `AgentRunControl`：管理阶段、模型轮数、期限、预算快照和证据状态。
- `ToolBatchAdmission`：对模型生成的整个工具批次执行去重、复用、准入和裁剪。
- `ToolBudgetLedger`：唯一权威记账器，提供原子预留和只读快照。
- `ToolRunner`：执行已准入的工具，落实权限、超时和审计。
- Pi Tool Adapter：只转换模型工具协议与标准结果，不自行决定业务预算。
- Search Provider：接收标准化请求并返回标准化结果或错误，不知道上层如何使用结果。

## 运行状态机

一次联网 Chat run 使用四个状态：

```text
DECIDING → EXECUTING → DECIDING → SYNTHESIZING → DONE
```

- `DECIDING`：模型根据历史、工具结果和剩余预算决定调用哪些工具。
- `EXECUTING`：Harness 先规划整个批次，再执行获准的调用。
- `SYNTHESIZING`：移除全部工具，模型基于已有证据生成最终回答。
- `DONE`：最终结果已经完成或运行被明确取消。

进入 `SYNTHESIZING` 后不可返回工具阶段。

满足以下任一条件时进入 `SYNTHESIZING`：

- 模型没有生成工具调用；
- 搜索与网页读取额度均耗尽；
- 搜索耗尽，且上下文中没有用户提供或工具获得的可读 URL；
- 达到工具决策轮上限；
- 达到 run 总时间上限；
- 当前仍可用的工具发生不可恢复的配置或鉴权错误；
- 连续两批没有产生新证据；
- 模型已经决定使用现有证据回答。

最终综合回答本身调用失败，才将整个 Chat run 标记为失败。工具阶段的部分失败不得阻止综合回答。

## 运行时状态

运行状态只属于当前 request/trace，不写入长期对话上下文：

```ts
type AgentPhase = "deciding" | "executing" | "synthesizing" | "done";

interface AgentRunControl {
  phase: AgentPhase;
  turns: {
    toolDecisionUsed: number;
    toolDecisionMax: number;
    synthesisReserved: 1;
  };
  budgets: {
    search: BudgetCounter;
    fetch: BudgetCounter;
  };
  deadlineAt: number;
  evidence: {
    successfulSearches: number;
    successfulFetches: number;
    knownUrls: Set<string>;
    consecutiveEmptyBatches: number;
  };
}

interface BudgetCounter {
  limit: number;
  reserved: number;
  consumed: number;
  remaining: number;
  exhausted: boolean;
}
```

`AgentRunControl` 中的预算数据是 `ToolBudgetLedger` 的只读快照，不建立第二套可独立修改的计数器。

- `reserved`：批次已经占住、但尚未完成执行前校验的额度；用于防止同批过量准入。
- `consumed`：已经真正向外部服务发出请求的额度。
- 权限、参数或安全策略在外部请求前拒绝调用时，释放预留且不增加 `consumed`。
- 一旦外部请求发出，无论结果成功、超时、限流还是服务商错误，都增加 `consumed`。

## 默认 Chat 策略

第一版保持当前量级：

```yaml
toolDecisionTurns: 5
reservedSynthesisTurns: 1

budgets:
  webSearch: 4
  readWebpage: 3

termination:
  consecutiveEmptyBatches: 2
```

该 YAML 仅表达策略，不要求成为新的用户配置文件。是否开放联网仍由本轮用户选择和 Harness 决定，与 LLM Profile、Search Profile 分离。

未开启联网时不注册 `web_search` 和 `read_webpage`，不初始化联网预算，普通回答直接流式输出。

## 动态预算上下文与工具集

每次模型调用前重新构造运行时部分，不能向历史 Prompt 反复追加余额文本。模型输入由以下部分组成：

```text
稳定基础 Prompt
+ 当前日期与运行环境
+ 当前阶段规则
+ 当前预算快照
+ 当前可用工具说明
```

工具决策阶段包含简短、稳定的预算块：

```text
<runtime_budget>
phase: deciding
web_search: remaining 2 of 4
read_webpage: remaining 3 of 3
tool_decision_turns: remaining 3
final_answer_turns_reserved: 1
</runtime_budget>

只规划剩余额度允许的调用。两类工具额度独立。
不要重复完全相同的查询或网址。
```

综合回答阶段替换为：

```text
<runtime_budget>
phase: synthesizing
available_tools: none
</runtime_budget>

工具阶段已经结束。基于已有结果输出最终答案。
不得提出新的工具调用或搜索计划。
```

动态工具集规则：

| 搜索余额 | 读取余额 | 暴露给模型的联网工具 |
|---:|---:|---|
| > 0 | > 0 | `web_search`, `read_webpage` |
| 0 | > 0 | `read_webpage` |
| > 0 | 0 | `web_search` |
| 0 | 0 | 无 |

`read_webpage` 不要求本轮必须先搜索，因为用户或历史消息可能已经提供 URL。

Prompt 是减少超额决策的引导，批次准入才是不可突破的边界。

## 批次准入

模型生成工具调用后，Harness 在任何 Provider 请求之前生成批次计划：

```ts
interface ToolBatchPlan {
  batchId: string;
  turnIndex: number;
  admitted: PlannedToolCall[];
  skipped: SkippedToolCall[];
  reused: ReusedToolCall[];
  budgetBefore: ToolBudgetSnapshot;
  budgetAfterAdmission: ToolBudgetSnapshot;
}
```

按模型生成的原始顺序处理调用：

- `admitted`：原子预留对应类别额度，然后进入 ToolRunner；真正向外部服务发出请求时提交消费；
- `skipped`：因剩余额度不足而不执行，不消耗额度；
- `reused`：复用同一 run 内已有成功结果，不执行且不消耗额度。

例如剩余 `search=2, fetch=3`，模型生成四个搜索和两个网页读取时，只准入前两个搜索，裁掉后两个搜索，并准入两个网页读取。搜索耗尽不会连带关闭网页读取。

## 重复调用

第一版只做确定性重复识别：

- 同一 run 内完全相同的标准化 query 成功后再次出现，复用成功结果；
- 完全相同的规范化 URL 成功读取后再次出现，复用成功结果；
- 同批完全相同调用只执行一次；
- 非重试型失败的相同调用直接复用失败原因；
- 可重试型失败允许重新执行，并消耗新的对应额度。

第一版不判断两个不同查询是否语义相似。

## 工具结果协议

每个模型生成的 `tool_call_id` 都必须有一条对应结果，不能只返回批次汇总。

完成结果：

```json
{"status":"completed","data":{}}
```

执行失败：

```json
{
  "status":"failed",
  "code":"timeout",
  "message":"搜索服务在限定时间内未响应",
  "retryable":true,
  "budgetConsumed":true
}
```

执行前裁剪：

```json
{
  "status":"skipped",
  "code":"budget_trimmed",
  "message":"该调用超出本轮剩余搜索额度，未向服务商发送请求",
  "budgetConsumed":false
}
```

批次完成后，由 Harness 在下一次模型调用的运行时上下文中提供汇总：

```json
{
  "batchSummary": {
    "requested": 6,
    "executed": 4,
    "reused": 1,
    "skipped": 1,
    "remaining": {
      "web_search": 0,
      "read_webpage": 2
    },
    "availableToolsNextTurn": ["read_webpage"]
  }
}
```

批次摘要不是额外的 `tool_result`，不虚构 `tool_call_id`。每个原始工具调用仍有独立匹配结果；摘要只帮助模型快速理解整批状态。

模型可以看到安全错误原因，但不能看到 API Key、原始异常栈或内部网络信息。

## 失败与重试

第一版不做隐藏的自动 Search Provider 重试。每次重新发给 Provider 的请求都是新的工具调用，并消耗新的对应额度。Provider SDK 自带自动重试应关闭。

| 错误 | Harness 行为 |
|---|---|
| `timeout`, `network_unavailable` | 将原因返回模型；剩余额度允许时可重新调用 |
| `rate_limited` | 不立即自动重试；返回安全等待信息并允许使用已有结果 |
| `authentication_failed` | 请求已经发出并消耗额度；关闭对应工具，避免继续产生无意义请求 |
| `invalid_input` | 在外部请求前返回模型修正参数；释放预留且不消耗额度 |
| `url_blocked`, `parse_failed` | 当前 URL 失败，允许读取其他来源 |
| `budget_trimmed` | 不执行、不消耗；同批超额调用不得再次准入 |

整批全部失败时：

- 全部属于不可恢复错误：关闭对应工具；若无其他有效工具则进入综合回答。
- 存在可恢复错误且仍有额度：最多再允许一次模型决策。
- 连续两批没有产生任何新证据：进入综合回答，防止循环改写相同查询。

最终回答要区分已验证信息和无法确认的信息，但不展示内部协议、异常栈或调试文本。

## 持久化与呈现

工具活动与审计记录增加：

```text
requestId
agentTurnIndex
batchId
toolCallId
toolName
status
errorCode
budgetConsumed
startedAt
finishedAt
durationMs
```

状态扩展为：

```text
running | completed | failed | skipped | reused
```

- `skipped` 和 `reused` 也需要持久化，但不能伪装成真正的 Provider 执行记录。
- 切换对话后，Renderer 从持久化数据恢复工具轮次和批次。
- 成功使用绿色；真实执行失败使用红色；预算裁剪使用灰色或黄色；复用使用中性灰色。
- 同批多个预算裁剪默认合并显示，例如“7 个搜索请求中执行 4 个，3 个因本轮额度跳过”。
- 展开批次后仍能看到每个原始调用及其状态。

## 验收场景

### 同批超额

模型一次生成八个搜索时，只允许四个请求真正进入 Provider；其余四个为 `skipped`。下一轮不再暴露 `web_search`，UI 只显示一条裁剪摘要。

### 独立额度

搜索耗尽但存在 URL 且网页读取仍有两次额度时，下一轮只暴露 `read_webpage`，不提前综合回答。

### 工具失败

已准入搜索出现超时、限流或空结果时，对应额度被消耗，安全原因返回模型。达到结束条件后仍生成中文、可独立阅读的流式最终回答。

### 不可恢复错误

首个搜索返回鉴权失败时立即关闭搜索工具，不再产生另外三个鉴权失败；如有可用网页读取和 URL，可以继续读取，否则进入综合回答。

### 对话恢复

执行期间切换对话再返回时，当前批次、轮次、成功、失败、跳过和复用状态完整恢复，最终流式输出可以继续显示。

### 非联网回归

关闭联网时不出现联网工具，有明确思考反馈，最终回答流式输出，且不受联网 Harness 状态机影响。

## 实现范围与顺序

第一版按以下顺序实现：

1. 运行状态与预算只读快照；
2. 动态 Prompt 与动态工具集；
3. 批次准入、裁剪和确定性复用；
4. 错误分类与终止状态机；
5. 持久化契约和迁移；
6. Renderer 批次呈现；
7. 针对性测试、构建和应用打包。

测试集中覆盖验收场景，不扩展与本次状态机无关的细节测试。Search Provider 的现有连接诊断和五个 Provider 适配接口不因本设计改变。
