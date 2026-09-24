# queue.cancel

提供主题 itemId 与当前全局队列 batchId。确认后取消全局队列中所有未完成条目，可能涉及其他主题。若只取消一条，使用 queue.cancelEntry 或 task.cancel。
