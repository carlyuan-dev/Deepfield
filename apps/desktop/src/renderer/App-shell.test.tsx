// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type {
  CapabilityItem,
  CapabilityItemId,
  CompanyId,
  ItemCompanyView,
} from "@deepfield/contracts";
import { App } from "./App.js";
import {
  capabilityItem,
  chatMessage,
  conversation,
  makeFakeApi,
  type FakeDesktopApi,
} from "./renderer-test-helpers.js";

const REQUEST_ID = "fixed-req";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} requestIdFactory={() => REQUEST_ID} />);
  return { user, ...utils };
}

async function chatReady(): Promise<HTMLTextAreaElement> {
  let input: HTMLTextAreaElement | undefined;
  await waitFor(() => {
    input = screen.getByLabelText("消息输入") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
  });
  return input as HTMLTextAreaElement;
}

describe("app three-pane shell", () => {
  it("submits with Enter, keeps Shift+Enter and IME input, and aligns the user label", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话甲", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.listMessages.mockResolvedValue([chatMessage("m1", "user", "历史问题")]);
    const { user } = await renderApp(fake);
    const input = await chatReady();

    const userRole = document.querySelector(".message.user .message-role") as HTMLDivElement;
    expect(userRole.textContent).toBe("我");
    expect(userRole.className).toContain("user-message-role");

    await user.type(input, "第一行");
    await user.keyboard("{Shift>}{Enter}{/Shift}第二行");
    expect(input.value).toBe("第一行\n第二行");
    expect(fake.chat.send).not.toHaveBeenCalled();

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    expect(fake.chat.send).not.toHaveBeenCalled();
    expect(input.value).toBe("第一行\n第二行");

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fake.chat.send).toHaveBeenCalledTimes(1));
    expect(fake.chat.send.mock.calls[0]?.[1]).toBe("第一行\n第二行");
  });

  it("keeps a stable split, closes the Capability, selects history, and preserves scroll intent", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话甲", true);
    const older = conversation("c2", "对话乙", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active, older] });
    fake.chat.listMessages.mockImplementation(async (conversationId) =>
      conversationId === "c1"
        ? [
            chatMessage("m1", "user", "已有很长的一段历史消息"),
            chatMessage("m2", "assistant", "历史回复"),
          ]
        : [],
    );
    const { user } = await renderApp(fake);

    // 1) Initial state: no Capability, Chat fills the workspace.
    const input = await chatReady();
    expect(screen.queryByRole("heading", { name: "行业研究" })).toBeNull();
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");
    expect(document.querySelector(".capability-pane")).toBeNull();

    // Recent history is selected as a stable page selection, while the new-chat
    // action remains a normal action button.
    expect(screen.getByRole("button", { name: "对话甲" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "对话甲" }).className).toContain("active");
    expect(screen.getByRole("button", { name: "＋ 新对话" }).className).not.toContain("active");

    const messages = document.querySelector(".messages") as HTMLDivElement;
    Object.defineProperties(messages, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    messages.scrollTop = 400;
    fireEvent.scroll(messages);

    // 2) Direct 行业研究 click opens the Capability and collapses Chat.
    await user.click(screen.getByRole("button", { name: "行业研究" }));
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "添加行业" })).toBeTruthy();
    expect(document.querySelector(".workspace-panes")?.className).toContain("with-capability");
    expect(document.querySelector(".workspace-panes")?.className).toContain("collapsed");
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    expect(screen.getByRole("button", { name: "展开 Chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭 Capability" })).toBeTruthy();

    // 3) The arrow expands Chat into the fixed 520px split.
    await user.click(screen.getByRole("button", { name: "展开 Chat" }));
    expect(document.querySelector(".workspace-panes")?.className).toContain("expanded");
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");

    // 4) Very long messages stay inside the Chat scroll container.
    expect(document.querySelector(".messages")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();

    // 5) Stream a reply, collapse mid-flight, keep streaming, re-expand: the draft survives.
    await user.type(input, "研究目标");
    await user.click(screen.getByRole("button", { name: "发送" }));
    fake.emit({ requestId: REQUEST_ID, type: "started" });
    fake.emit({ requestId: REQUEST_ID, type: "text_delta", delta: "测" });
    await waitFor(() => expect(screen.getByText("测")).toBeTruthy());
    expect(messages.scrollTop).toBe(500);

    // Once the user scrolls up, later streaming updates must not pull them back.
    messages.scrollTop = 100;
    fireEvent.scroll(messages);
    fake.emit({ requestId: REQUEST_ID, type: "text_delta", delta: "不应强拉" });
    await waitFor(() => expect(screen.getByText("测不应强拉")).toBeTruthy());
    expect(messages.scrollTop).toBe(100);

    await user.click(screen.getByRole("button", { name: "收起 Chat" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    // ChatView stays mounted: further deltas still arrive while collapsed.
    fake.emit({ requestId: REQUEST_ID, type: "text_delta", delta: "试回" });
    await user.click(screen.getByRole("button", { name: "展开 Chat" }));
    fake.emit({ requestId: REQUEST_ID, type: "completed", text: "测试回复" });
    await waitFor(() => expect(screen.getByText("测试回复")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();

    // 6) A Conversation click re-expands Chat while the Capability remains mounted.
    await user.click(screen.getByRole("button", { name: "收起 Chat" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    await user.click(screen.getByRole("button", { name: "对话乙" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");
    expect(screen.getByRole("button", { name: "收起 Chat" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();
    // the switched Conversation is usable and open beside the Capability
    expect(screen.getByLabelText("消息输入")).toBeTruthy();

    // 7) Closing is shell state: it removes Capability and expands Chat.
    await user.click(screen.getByRole("button", { name: "关闭 Capability" }));
    expect(document.querySelector(".capability-pane")).toBeNull();
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");

  });

  it("creates, edits, navigates, and deletes research items and companies", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话甲", true);
    const createdItem = capabilityItem({
      id: "item-new",
      industry: "人形机器人",
      researchScope: "中国市场",
      notes: "关注量产进度",
      createdAt: "2026-09-08T08:00:00.000Z",
      updatedAt: "2026-09-08T08:00:00.000Z",
    });
    const items: CapabilityItem[] = [];
    let companies: ItemCompanyView[] = [];
    let companySequence = 0;
    const companyView = (name: string, countryOrRegion?: string, note?: string): ItemCompanyView => ({
      id: `company-${++companySequence}` as CompanyId,
      itemId: createdItem.id as CapabilityItemId,
      name,
      normalizedName: name.toLocaleLowerCase(),
      ...(countryOrRegion !== undefined ? { countryOrRegion } : {}),
      ...(note !== undefined ? { note } : {}),
      createdAt: "2026-09-08T08:00:00.000Z",
      updatedAt: "2026-09-08T08:00:00.000Z",
    });

    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.industryResearch.listItems.mockImplementation(async () => [...items]);
    fake.industryResearch.createItem.mockImplementation(async (input) => {
      const item = {
        ...createdItem,
        industry: input.industry,
        ...(input.researchScope !== undefined ? { researchScope: input.researchScope } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      };
      items.push(item);
      return item;
    });
    fake.industryResearch.updateItem.mockImplementation(async (itemId, input) => {
      const updated = {
        ...createdItem,
        id: itemId as CapabilityItemId,
        industry: input.industry,
        ...(input.researchScope !== undefined ? { researchScope: input.researchScope } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        updatedAt: "2026-09-08T09:00:00.000Z",
      };
      items.splice(0, items.length, updated);
      return updated;
    });
    fake.industryResearch.deleteItem.mockImplementation(async (itemId) => {
      const index = items.findIndex((item) => item.id === itemId);
      if (index >= 0) items.splice(index, 1);
    });
    fake.industryResearch.deleteItems.mockImplementation(async (itemIds) => {
      items.splice(0, items.length, ...items.filter((item) => !itemIds.includes(item.id)));
    });
    fake.industryResearch.listCompanies.mockImplementation(async () => [...companies]);
    fake.industryResearch.addCompanies.mockImplementation(async (_itemId, drafts) => {
      const added = drafts.map((draft) =>
        companyView(draft.name, draft.countryOrRegion, draft.note),
      );
      companies = [...companies, ...added];
      return added;
    });
    fake.industryResearch.removeCompany.mockImplementation(async (_itemId, companyId) => {
      companies = companies.filter((company) => company.id !== companyId);
    });
    fake.industryResearch.removeCompanies.mockImplementation(async (_itemId, companyIds) => {
      companies = companies.filter((company) => !companyIds.includes(company.id));
    });
    const { user } = await renderApp(fake);
    await chatReady();

    await user.click(screen.getByRole("button", { name: "行业研究" }));
    expect(await screen.findByText("还没有行业研究条目")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "添加行业" }));

    const createDialog = screen.getByRole("dialog", { name: "添加行业" });
    await user.type(screen.getByLabelText("行业"), "人形机器人");
    await user.type(screen.getByLabelText("研究范围（可选）"), "中国市场");
    await user.type(screen.getByLabelText("备注（可选）"), "关注量产进度");
    await user.click(createDialog.querySelector('button[type="submit"]') as HTMLButtonElement);

    expect(await screen.findByRole("heading", { name: "人形机器人" })).toBeTruthy();
    expect(screen.getByText("中国市场")).toBeTruthy();
    expect(screen.getByText("关注量产进度")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /返回调研列表/ }));
    await user.click(screen.getByRole("button", { name: "编辑 人形机器人" }));
    const editDialog = screen.getByRole("dialog", { name: "编辑行业" });
    await user.clear(screen.getByLabelText("行业"));
    await user.type(screen.getByLabelText("行业"), "具身智能");
    await user.clear(screen.getByLabelText("研究范围（可选）"));
    await user.type(screen.getByLabelText("研究范围（可选）"), "全球市场");
    await user.click(editDialog.querySelector('button[type="submit"]') as HTMLButtonElement);
    expect(await screen.findByRole("button", { name: /^具身智能/ })).toBeTruthy();
    expect(screen.getByText("全球市场")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^具身智能/ }));
    expect(screen.queryByRole("button", { name: "编辑调研" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除调研" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "添加公司" }));
    expect(screen.getByRole("dialog", { name: "添加公司" })).toBeTruthy();
    await user.type(screen.getByLabelText("公司名称"), "优必选");
    await user.type(screen.getByLabelText("国籍/地区（可选）"), "中国");
    await user.type(screen.getByLabelText("候选备注（可选）"), "重点跟踪");
    await user.click(screen.getByRole("button", { name: "添加到待确认" }));
    await user.click(screen.getByRole("button", { name: "确认新增" }));
    expect(await screen.findByText("优必选")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "查看 优必选" }));
    expect(screen.getByRole("heading", { name: "优必选" })).toBeTruthy();
    expect(screen.getByText("公司调研内容将在下一阶段生成")).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除公司" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /返回公司列表/ }));

    const removeCompany = screen.getByRole("button", { name: "删除公司 优必选" });
    expect(removeCompany.className).not.toContain("danger-button");
    await user.click(removeCompany);
    expect(screen.getByRole("dialog", { name: "移除公司" }).textContent).toContain("确认从“具身智能”行业删除“优必选”吗？");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("优必选")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "删除公司 优必选" }));
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(screen.queryByText("优必选")).toBeNull());

    await user.click(screen.getByRole("button", { name: "添加公司" }));
    await user.type(screen.getByLabelText("公司名称"), "公司甲");
    await user.click(screen.getByRole("button", { name: "添加到待确认" }));
    await user.type(screen.getByLabelText("公司名称"), "公司乙");
    await user.click(screen.getByRole("button", { name: "添加到待确认" }));
    await user.click(screen.getByRole("button", { name: "确认新增" }));
    expect(await screen.findByText("公司甲")).toBeTruthy();
    expect(screen.getByText("公司乙")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "批量删除" }));
    await user.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByRole("button", { name: "删除已选（2）" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "删除已选（2）" }));
    expect(screen.getByRole("dialog", { name: "批量移除公司" }).textContent).toContain("确认从“具身智能”行业删除已选的 2 家公司吗？");
    await user.click(within(screen.getByRole("dialog", { name: "批量移除公司" })).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "删除已选（2）" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "删除已选（2）" }));
    await user.click(screen.getByRole("button", { name: "确认移除 2 家公司" }));
    await waitFor(() => expect(screen.getByText("暂无公司，可手动添加或从文本识别。")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /返回调研列表/ }));
    await user.click(screen.getByRole("button", { name: "删除行业" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 具身智能" }));
    await user.click(screen.getByRole("button", { name: "确认删除（1）" }));
    expect(screen.getByRole("dialog", { name: "删除行业" }).textContent).toContain("具身智能");
    await user.click(within(screen.getByRole("dialog", { name: "删除行业" })).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "确认删除（1）" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认删除（1）" }));
    await user.click(screen.getByRole("button", { name: "确认删除 1 个行业" }));
    expect(await screen.findByText("还没有行业研究条目")).toBeTruthy();
    expect(fake.industryResearch.removeCompanies).toHaveBeenCalledTimes(1);
    expect(fake.industryResearch.deleteItems).toHaveBeenCalledWith([createdItem.id]);
    expect(fake.industryResearch.deleteItem).not.toHaveBeenCalled();
  });

  it("recognizes long text sequentially and resumes from the failed chunk", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话甲", true);
    const item = capabilityItem({ id: "item-import", industry: "AI 芯片" });
    let companies: ItemCompanyView[] = [];
    const firstChunk = `${"甲".repeat(3999)}\n`;
    const secondChunk = "乙".repeat(10);
    const sourceText = `${firstChunk}${secondChunk}`;
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockImplementation(async () => [...companies]);
    fake.industryResearch.recognizeCompanies
      .mockResolvedValueOnce([{ name: "公司甲", countryOrRegion: "中国", note: "首块" }])
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce([
        { name: "公司甲", countryOrRegion: "美国", note: "重复项" },
        { name: "公司乙", countryOrRegion: "日本", note: "次块" },
      ]);
    fake.industryResearch.addCompanies.mockImplementation(async (_itemId, drafts) => {
      companies = drafts.map((draft, index) => ({
        id: `imported-${index}` as CompanyId,
        itemId: item.id,
        normalizedName: draft.name.toLocaleLowerCase(),
        createdAt: "2026-09-08T10:00:00.000Z",
        updatedAt: "2026-09-08T10:00:00.000Z",
        ...draft,
      }));
      return companies;
    });
    const { user } = await renderApp(fake);
    await chatReady();
    await user.click(screen.getByRole("button", { name: "行业研究" }));
    await user.click(await screen.findByRole("button", { name: /^AI 芯片/ }));
    await user.click(screen.getByRole("button", { name: "一键导入公司" }));
    const source = screen.getByLabelText("公司文本") as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: sourceText } });
    await user.click(screen.getByRole("button", { name: "识别公司" }));
    expect((await screen.findByRole("alert")).textContent).toBe("识别失败，请重试");
    expect(source.value).toBe(sourceText);
    expect(screen.getByRole("button", { name: "重试识别" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/第\s*2\s*段|2\/2|分段|chunk|游标/iu);
    expect((screen.getByRole("button", { name: "确认导入" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fake.industryResearch.recognizeCompanies.mock.calls.map((call) => call[1])).toEqual([
      firstChunk,
      secondChunk,
    ]);

    await user.click(screen.getByRole("button", { name: "重试识别" }));
    expect(await screen.findByText("公司1")).toBeTruthy();
    expect(screen.queryByText("候选 1 公司名称")).toBeNull();
    expect(screen.getAllByLabelText("公司名称")[0]).toBeTruthy();
    expect(fake.industryResearch.recognizeCompanies.mock.calls.map((call) => call[1])).toEqual([
      firstChunk,
      secondChunk,
      secondChunk,
    ]);
    expect((screen.getAllByLabelText("国籍/地区")[0] as HTMLInputElement).value).toBe("中国");
    expect((screen.getByRole("button", { name: "确认导入" }) as HTMLButtonElement).disabled).toBe(false);
    const firstCandidateName = screen.getAllByLabelText("公司名称")[0]!;
    await user.clear(firstCandidateName);
    await user.type(firstCandidateName, "公司甲（已校对）");
    await user.click(screen.getByRole("button", { name: "删除公司 2" }));
    await user.click(screen.getByRole("button", { name: "确认导入" }));
    expect(await screen.findByText("公司甲（已校对）")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "一键导入公司" }));
    const oversizedSource = screen.getByLabelText("公司文本");
    fireEvent.change(oversizedSource, { target: { value: "长".repeat(48001) } });
    await user.click(screen.getByRole("button", { name: "识别公司" }));
    expect((await screen.findByRole("alert")).textContent).toContain("文本过长，请缩短至 48000 个字符以内");
    expect(fake.industryResearch.recognizeCompanies).toHaveBeenCalledTimes(3);

  });

  it("keeps the Chat top bar and assistant semantics stable across settings navigation", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话甲", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.listMessages.mockResolvedValue([
      chatMessage("m1", "user", "问题"),
      chatMessage("m2", "assistant", "回答"),
    ]);
    const { user } = await renderApp(fake);

    await chatReady();
    expect(document.querySelector(".chat-pane-header")).toBeTruthy();
    expect(document.querySelector(".chat-pane-title")?.textContent).toBe("对话甲");
    expect(document.querySelector(".chat-header")).toBeNull();
    expect(document.querySelector(".message.assistant")).toBeTruthy();
    expect(document.querySelector(".message.assistant .assistant-content")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "行业研究" }));
    expect(document.querySelector(".chat-pane-header")).toBeTruthy();
    expect(document.querySelector(".chat-pane-header")?.className).toContain("collapsed");

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("navigation", { name: "设置导航" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "‹ 返回" })).toBeTruthy();
    expect(screen.getByText("设置")).toBeTruthy();
    expect(screen.getByRole("button", { name: "模型与密钥" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("heading", { name: "模型与密钥" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "‹ 返回" }));
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");

    await user.click(screen.getByRole("button", { name: "展开 Chat" }));
    expect(document.querySelector(".chat-pane-header")?.className).toContain("expanded");
    expect(document.querySelector(".chat-pane-title")?.textContent).toBe("对话甲");
  });
});
