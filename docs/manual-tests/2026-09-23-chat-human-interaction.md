# Chat 人机交互手测（2026-09-23）

状态：离线联验后待在真实应用中执行。使用专门测试主题与少量测试公司；付费调研、资料补全和识别只在愿意产生实际用量时执行。记录每一步的会话、动作、预期与实际结果；后台“已提交”不等于报告完成。

## 快速路径

1. 在 Chat 请求一个有两项选择且允许文字补充的问题。分别用选项和自由文本回答；回答应恢复原会话，不直接批准后续写操作。
2. 让 Chat 新建一个测试研究主题，要求预填标题、范围和备注。右侧应打开原有主题表单；开始输入后左侧确认禁用，右侧点击确认会先等待字段同步，不能提交旧内容。让 Chat 只修改备注，再由用户改标题；两处应同时保留修改。试一次旧卡确认，应提示内容已更新、需要重新核对。再用左侧确认创建；另建测试主题用右侧表单确认；第三次用无附加条件的明确文字“确认执行”。每次只产生一个主题，不重复执行。
3. 再发起新建并取消；不应留下主题。输入“把备注改完再确认”或讨论“同意这个设计”，不应执行旧草稿。批准前切到别的会话，再从原关联表单回应；结果只出现在原会话。
4. 用测试数据走文本导入：识别文本须先单独确认，识别完成后再选择要添加的公司并另行确认；取消添加不应自动导入。走两家公司批量调研：选择、统一条件、逐公司修改可以前后切换，只有最终确认才入队。保存 Word 报告时选择原始/结构化内容，仍应出现系统保存对话框；取消保存不能显示导出成功。
5. 在两个会话分别留下一个待回答问题和一个待确认操作，然后重启。原会话仍显示待办；重启前未按下的确认不能自行执行。检查禁用公司调研并重启后表单入口不再显示，已有历史仍可读；再启用并重启。无需用真实业务数据验证。

## 当前包表单登记清单

源码 `capabilities/company-research/actions/form-bindings.ts` 当前登记八项；手测时逐项核对实际页面和动作，不把登记本身当作已验收：

| 表单 ID | 真实界面 | 公开动作 |
| --- | --- | --- |
| `topic` | ResearchItemModal | `topics.create`, `topics.update` |
| `companies-add` | AddCompaniesModal | `companies.add` |
| `companies-import` | ImportCompaniesModal | `companies.recognize`, `companies.add` |
| `company-profile` | CompanyProfileForm | `companies.update` |
| `company-identity` | CompanyIdentityConfirmationModal | `companies.confirmIdentity` |
| `research` | CompanyResearchModal | `research.submit`, `research.retryFailed` |
| `research-batch` | BatchCompanyResearchModal | `research.submitBatch` |
| `report-export` | WordExportChoiceModal | `reports.exportWord` |

简单删除复用原确认动作，不需要伪造编辑表单。若某入口不能打开真实组件、共同修改不同步、阶段跳过确认或结果未知却重跑写操作，记录停下的步骤与会话，暂停该路径的手测。
