---
name: deepfield-delivery
description: Use when carrying out authorized development or fixes in the Deepfield repository. General consultation and read-only analysis do not authorize code changes.
---

# Deepfield 交付路由

本文件以仓库根目录为基准。先读 `AGENTS.md`，沿用用户已确认的范围、方案与授权；已有清晰结论时直接推进，不重新发起脑暴或重复批准。

## 批次与路由

每批通过对话简述目标与可见成果、关键不变量、最少有效验证和暂停条件。按任务触发场景查阅 `docs/engineering-lessons.md` 的相关 ID，再读条目所链接的正式设计、实现与测试；常规运行和交付见 `docs/development.md`，选测见 `docs/testing.md`。无需遍历旧计划寻找当前规则。

## 执行与暂停

依 `AGENTS.md` 派工。每个子 Agent 任务带上该任务的实现／正式文档入口、相关经验 ID、预期结果及失败停止条件；没有适用经验时明确说明。实现、审查、自验发现的问题持续定位、修复并重验原失败场景，直到达到本批交付条件。

只在范围实质变化、安全或不可逆数据操作、系统权限、超出授权额度及真实阻塞需要用户决策时询问。失败后的重试先核对证据与相关条目的停止条件，权限与启动保护沿用原文约束。

异常已有取证、对应保护已通过且代码、环境、输入未变时复用现有证据，不重复测试。

## 收尾

收尾时检查是否产生有复发价值、高影响或难发现的已证实经验，按 `docs/engineering-lessons.md` 的收录规则更新、合并或淘汰旧结论。具体契约仍链接正式文档，保持单一真源。用对话报告成果、验证证据与局限，按 `AGENTS.md` 的既有交付规则完成收尾。

尚未完成定位或验证的结论保留在对话排查，不写入正式经验。
