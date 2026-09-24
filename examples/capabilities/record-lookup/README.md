# record-lookup：最小 Capability v2 示例

这是固定三条记录的接口示例，不是实际工单库产品。只有 main 入口和即时只读动作 `records.find`；没有 UI、Worker、数据库、LLM、Search、后台任务或产物提供器。

从仓库根目录构建到隔离目录：

```sh
node -e 'import("./examples/capabilities/record-lookup/build.ts").then(async ({ buildPackage }) => { await buildPackage("/tmp/record-lookup-package"); })'
```

产物目录内的 `capability.json`、`package.json`、`dist/main.js`、`docs/actions/records.find.md` 必须一起交付。包入口已打包所需依赖，只保留 Node 内置模块为外部依赖。更多安装与更新步骤见 [开发指南](../../../docs/capabilities/capability.开发指南.md)。
