import type { CompanyDraft } from "../contracts/index.js";
import type { CompanyRecognizer } from "../host-ports.js";

export class FakeCompanyRecognizer implements CompanyRecognizer {
  async recognize(text: string): Promise<CompanyDraft[]> {
    if (text.trim().length === 0) {
      return [];
    }
    return [{ name: "Deepfield 演示公司" }];
  }
}
