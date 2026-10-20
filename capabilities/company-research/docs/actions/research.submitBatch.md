# research.submitBatch

提供主题 itemId 与 entries，每家公司各有 companyId 和独立 input（moduleIds、asOfDate、可选 focusScope）。每条选择 1–4 个不同模块，可跨四组目录，按固定目录顺序执行。确认后作为一次提交入现有队列；返回整个提交集合的 taskRef。取消该 taskRef 只取消这次提交的未完成条目。右侧固定展示主题公司与队列，进度用该提交实际完成、失败、取消数量更新，不逐公司跳页。
