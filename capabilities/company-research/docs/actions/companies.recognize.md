# companies.recognize

提供主题 itemId 和待识别 text。识别会调用模型，不会自动导入。返回候选总数与前 20 家；若显示 truncated，应将原文本分段重新识别剩余候选。将选定候选传给 companies.add 才加入主题。
# 连续识别与导入

连续任务可同时显式声明 companies.recognize 和 companies.add 两条范围规则，限定同一已有主题或同一个新建主题的成功回执。识别文本可按声明动态确定，导入名单可在已确认范围内采用识别结果；宿主沿用同一个表单的 afterAction 和执行回执自动导入，不再次请求相同范围确认。未授权导入时，识别仍停在候选确认卡。已知公司名称直接调用 companies.add。
