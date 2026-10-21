/** Only complete, unambiguous human phrases can grant authority. */
export function classifyExplicitDecision(text: string): "approve" | "cancel" | null {
  const normalized = text.trim().replace(/[。.!！]+$/u, "").trim().toLowerCase();
  if (["确认", "确认无误", "同意", "同意执行", "批准", "确认执行", "approve", "confirm"].includes(normalized)) return "approve";
  if (["取消", "取消操作", "不执行", "cancel"].includes(normalized)) return "cancel";
  // A closed grammar: readiness followed only by an unconditional execution request.
  // Anchoring the whole message excludes quoted, conditional and mixed edit requests.
  if (/^(?:(?:选好了|选择好了|已选好|没问题|确认无误)[，,\s]*)?(?:请|你)?(?:执行|提交)(?:吧)?$/u.test(normalized)) return "approve";
  return null;
}
