/** Only complete, unambiguous human phrases can grant authority. */
export function classifyExplicitDecision(text: string): "approve" | "cancel" | null {
  const normalized = text.trim().replace(/[。.!！]+$/u, "").trim().toLowerCase();
  if (["确认", "确认无误", "同意", "同意执行", "批准", "确认执行", "approve", "confirm"].includes(normalized)) return "approve";
  if (["取消", "取消操作", "不执行", "cancel"].includes(normalized)) return "cancel";
  return null;
}
