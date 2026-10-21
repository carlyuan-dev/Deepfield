# research.prepare

提供主题、公司、研究模块 moduleIds（从四组目录跨组选 1–5 个不同模块）、截止日期 asOfDate 和可选重点范围 focusScope。非法、重复或超限模块直接拒绝，合法选择按目录顺序规范化。只校验并保存草稿，不启动付费调研。返回 draftRef、规范化参数及同包 research.submit 的 proposedAction；Chat 据此立即创建待确认操作并打开其真实表单。收到 awaiting_user 后等待用户通过文字或任一确认按钮批准；该批准由宿主直接提交，无需再次调用 research.submit 或再问一次确认。修改使用当前绑定草稿及修订号。旧方向草稿已过期，需重新准备。
