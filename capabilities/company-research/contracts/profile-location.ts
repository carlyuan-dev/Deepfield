/** Keep the public string contract while preserving only supplied geographic precision. */
export function normalizeHeadquarters(value: string): string {
  const parts = value.split(/[／/]/u).map(part => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !part || /[,，、]/u.test(part))) {
    throw new Error("总部请填写“国家／省或一级行政区／市或区”，末段可省略");
  }
  return parts.join("／");
}
