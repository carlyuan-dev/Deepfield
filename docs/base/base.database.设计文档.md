# Deepfield Base.Database 设计文档

状态：通用底座已实现，桌面宿主及现有仓储已接入。公司仓储搬入能力包、`database.v1` 注入和停用撤销接线属于下一批。

## 公开接口与生命周期

`@deepfield/base/database` 仅导出中立契约，`@deepfield/base/database/runtime` 提供 Node SQLite 实现。`openDatabase(path)` 返回宿主独占的 owner，保持 `foreign_keys=ON` 与 WAL。owner 的 `database` 是 `version: 1` 视图；`scope(namespace)` 创建同一连接上的可撤销视图，namespace 由宿主固定，例如 `app:chat`、`base:usage`、`capability:company-research`。清理先落盘，随后 `revoke()`，最终由 owner 关闭连接。撤销后已取得的 statement/table 也失效。

消费者视图没有路径、native 或 close。`prepare/get/all/run/exec` 执行可信调用方提供的 SQL，不是表级安全沙箱；namespace 限定迁移账本归属，不隔离 SQL 表访问。原生兼容桥 `owner.legacy(callback)` 仅供可信宿主执行历史迁移；`adoptDatabase(native)` 复用宿主已有连接，按连接缓存 owner，避免各仓储出现独立事务状态。宿主直接持有 owner；旧 persistence 开库入口为旧宿主／测试调用方保留原生返回值，仓储入口立即转换为 Base view。

## 参数化读写与受控单表 CRUD

`SqlValue` 显式包含 null、string、有限 number、bigint、Uint8Array。运行时拒绝 undefined、boolean、任意对象与非有限数；布尔值及 JSON 由仓储明确编码。`get` 无行返回 undefined，`all` 返回数组；`run` 使用驱动 bigint 模式读取 `changes/lastInsertRowid`，安全整数范围内返回 number 兼容已有仓储，超出范围保留 bigint，不截断精度。

`table({name, columns, primaryKey})` 复制并冻结声明，验证并引用标识符。`findById/insert/update/delete` 只接受已声明字段，值始终绑定。未知字段、空插入、空条件、空 patch 和 undefined 被拒绝，条件中的 null 编译为 IS NULL。复杂查询继续使用参数化 SQL。现有研究主题仓储已使用这些单表助手；领域校验、数据映射和关联删除仍归仓储。

## 同步事务

`transaction(work)` 在同一连接执行 BEGIN IMMEDIATE / COMMIT，失败 ROLLBACK。嵌套事务（含另一 scope）被拒绝；async 函数在调用前拒绝，普通函数返回 thenable 则回滚并抛错。调用方不能把异步操作混入同步回调。已有内部 SAVEPOINT 用于局部恢复，与外层同一连接共存。

回滚失败保留最初异常，并尽力附加只含阶段和安全驱动 code 的 rollbackDiagnostic；不以回滚错误覆盖原失败。raw SQL 为可信接口，调用方不得在 transaction 回调中手动结束它管理的事务。

## 历史兼容与模块迁移

`packages/persistence/src/migrations.ts` 的历史 1–32 序列保留不变，由宿主通过 legacy 执行；不依赖已安装的公司包。历史序列完成作为模块基线 0，新模块真实迁移从 1 开始。Base 不含业务 DDL。

scope 的 `migrate(migrations, checkBaseline)` 验证连续版本、唯一且稳定的 key，并核对数据库账本为声明的完整前缀。数据库 head 高于声明支持版本会拒绝，空列表也不能跳过该检查。调用方 baseline 检查负责证明旧数据满足模块要求；模块声明负责自己的后续 DDL。

`module_schema_migrations(namespace, version, migration_key, applied_at)` 使用 namespace/version 主键及 namespace/key 唯一约束。同一 namespace 的全部 pending 迁移与账本记录在一笔同步事务内执行；失败全部回滚，其他 namespace 已提交历史保留。诊断保留 namespace、version、stage 和安全驱动 code，不附带 SQL、绑定数据或原始 driver message/cause。禁用模块不执行其新迁移，不删除其旧数据。

## Usage 与当前验收边界

`@deepfield/base/usage/sqlite` 接受 Database view，安全 Usage 入口不导入 SQLite 实现。初始化恢复与批量删除通过 Base 同步事务执行；probeStorage 仍在 SAVEPOINT 内真实读取并 UPDATE 健康表，再回滚／释放，以检测不可写存储。旧 persistence Usage 入口只做适配。

本批使用临时数据库验证参数绑定、事务、撤销、模块迁移、旧库重开、Usage 和证据原子性；GUI／真实模型请求不属于数据库单批验证。公司仓储仍位于 persistence，并通过 Base view 实际执行读写；归属及 Capability 注入的后续验收见 [抽取设计](base.extraction.设计文档.md)。
