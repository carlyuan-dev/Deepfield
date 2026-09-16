// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type {
  CapabilityItem,
  CapabilityItemId,
  CompanyId,
  ItemCompanyView,
  ResearchRun,
  ResearchRunId,
  CompanyResearchState,
} from "@deepfield/contracts";
import { researchRun, researchSummary, activeResearch } from "./features/industry-research/company-research-test-fixtures.js";
import { App } from "./App.js";
import { configuredSettings } from "./features/settings/settings-test-fixtures.js";
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

function companyViewFixture(id: string, name: string, itemId: CapabilityItemId): ItemCompanyView {
  return {
    id: id as CompanyId,
    itemId,
    name,
    normalizedName: name.toLocaleLowerCase(),
    profileStatus: "ready",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
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
    expect(screen.queryByRole("heading", { name: "研究主题" })).toBeNull();
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

    // 2) Direct 研究主题 click opens the Capability and collapses Chat.
    await user.click(screen.getByRole("button", { name: "研究主题" }));
    expect(screen.getByRole("heading", { name: "研究主题" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "新建主题" })).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "研究主题" })).toBeTruthy();

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
    expect(screen.getByRole("heading", { name: "研究主题" })).toBeTruthy();

    // 6) A Conversation click re-expands Chat while the Capability remains mounted.
    await user.click(screen.getByRole("button", { name: "收起 Chat" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    await user.click(screen.getByRole("button", { name: "对话乙" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");
    expect(screen.getByRole("button", { name: "收起 Chat" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "研究主题" })).toBeTruthy();
    // the switched Conversation is usable and open beside the Capability
    expect(screen.getByLabelText("消息输入")).toBeTruthy();

    // 7) Closing is shell state: it removes Capability and expands Chat.
    await user.click(screen.getByRole("button", { name: "关闭 Capability" }));
    expect(document.querySelector(".capability-pane")).toBeNull();
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");

  });

  it("keeps research breadcrumbs, close, and contextual return outside the scrolling body", async () => {
    const fake = makeFakeApi();
    const active = conversation("c-navigation", "导航验证", true);
    const item = capabilityItem({
      id: "item-navigation",
      industry: "一个很长的研究主题名称，用于验证窄面板导航不会挤掉关闭按钮",
    });
    const company = companyViewFixture("company-navigation", "导航公司", item.id);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockResolvedValue([company]);
    const { user } = await renderApp(fake);
    await chatReady();

    await user.click(screen.getByRole("button", { name: "研究主题" }));
    const navigation = document.querySelector(".capability-navigation");
    const body = document.querySelector(".capability-body");
    const close = screen.getByRole("button", { name: "关闭 Capability" });
    expect(navigation).toBeTruthy();
    expect(body).toBeTruthy();
    expect(navigation?.contains(close)).toBe(true);
    expect(body?.contains(close)).toBe(false);
    expect(screen.getAllByRole("button", { name: "关闭 Capability" })).toHaveLength(1);

    await user.click(await screen.findByRole("button", { name: /^一个很长的研究主题名称/ }));
    const itemBack = screen.getByRole("button", { name: /返回调研列表/ });
    expect(navigation?.contains(itemBack)).toBe(true);
    expect(body?.contains(itemBack)).toBe(false);

    await user.click(screen.getByRole("button", { name: "查看 导航公司" }));
    const companyBack = screen.getByRole("button", { name: /返回公司列表/ });
    expect(navigation?.contains(companyBack)).toBe(true);
    expect(body?.contains(companyBack)).toBe(false);
    await user.click(companyBack);
    expect(await screen.findByRole("heading", { name: item.industry })).toBeTruthy();

    await user.click(close);
    expect(document.querySelector(".capability-pane")).toBeNull();
  });

  it("routes a missing Search key to Settings and preserves the launch draft until manual retry", async () => {
    const fake = makeFakeApi();
    const active = conversation("c-recovery", "恢复验证", true);
    const item = capabilityItem({ id: "item-recovery", industry: "研究恢复" });
    const company = companyViewFixture("company-recovery", "恢复公司", item.id);
    const settings = configuredSettings();
    settings.search.profiles[0]!.hasCredential = false;
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockResolvedValue([company]);
    fake.settings.get.mockImplementation(async () => settings);
    fake.settings.saveSearchProfile.mockImplementation(async (draft) => {
      settings.search.profiles[0]!.hasCredential = Boolean(draft.apiKey?.trim());
      return settings;
    });
    fake.companyResearch.getState.mockResolvedValue({ runs: [], globalActiveRun: null });
    fake.companyResearch.start.mockResolvedValue(researchRun({
      itemId: item.id,
      companyId: company.id,
      status: "researching",
    }));
    const { user } = await renderApp(fake);
    await chatReady();

    await user.click(screen.getByRole("button", { name: "研究主题" }));
    await user.click(await screen.findByRole("button", { name: /^研究恢复/ }));
    await user.click(screen.getByRole("button", { name: "查看 恢复公司" }));
    await user.click(await screen.findByRole("button", { name: "开始调研" }));
    const dialog = screen.getByRole("dialog", { name: "公司调研" });
    const focus = within(dialog).getByLabelText("关注范围（可选）") as HTMLTextAreaElement;
    await user.type(focus, "必须保留的恢复草稿");
    await user.click(within(dialog).getByRole("button", { name: "开始调研" }));
    expect(fake.companyResearch.start).not.toHaveBeenCalled();
    await user.click(await within(dialog).findByRole("button", { name: "前往设置" }));

    expect(screen.getByRole("button", { name: "Search" }).getAttribute("aria-current")).toBe("page");
    await user.type(screen.getByLabelText(/^API Key/), "mock-search-key");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(fake.settings.saveSearchProfile).toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("navigation", { name: "设置导航" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "‹ 返回" }));

    const restored = screen.getByRole("dialog", { name: "公司调研" });
    expect((within(restored).getByLabelText("关注范围（可选）") as HTMLTextAreaElement).value).toBe("必须保留的恢复草稿");
    expect(fake.companyResearch.start).not.toHaveBeenCalled();
    await user.click(within(restored).getByRole("button", { name: "开始调研" }));
    await waitFor(() => expect(fake.companyResearch.start).toHaveBeenCalledTimes(1));
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
    const companyView = (name: string, headquarters?: string, note?: string): ItemCompanyView => ({
      id: `company-${++companySequence}` as CompanyId,
      itemId: createdItem.id as CapabilityItemId,
      name,
      normalizedName: name.toLocaleLowerCase(),
      profileStatus: "ready",
      ...(headquarters !== undefined ? { headquarters } : {}),
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
        companyView(draft.name, undefined, draft.note),
      );
      companies = [...companies, ...added];
      return added;
    });
    fake.industryResearch.addCompany.mockImplementation(async (_itemId, draft) => {
      const added = companyView(draft.name);
      companies = [...companies, added];
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

    await user.click(screen.getByRole("button", { name: "研究主题" }));
    expect(await screen.findByText("还没有研究主题")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "新建主题" }));

    const createDialog = screen.getByRole("dialog", { name: "新建主题" });
    await user.type(screen.getByLabelText("主题名称"), "人形机器人");
    await user.type(screen.getByLabelText("研究范围（可选）"), "中国市场");
    await user.type(screen.getByLabelText("备注（可选）"), "关注量产进度");
    await user.click(createDialog.querySelector('button[type="submit"]') as HTMLButtonElement);

    expect(await screen.findByRole("heading", { name: "人形机器人" })).toBeTruthy();
    expect(screen.getByText("中国市场")).toBeTruthy();
    expect(screen.getByText("关注量产进度")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /返回调研列表/ }));
    await user.click(screen.getByRole("button", { name: "编辑 人形机器人" }));
    const editDialog = screen.getByRole("dialog", { name: "编辑主题" });
    await user.clear(screen.getByLabelText("主题名称"));
    await user.type(screen.getByLabelText("主题名称"), "具身智能");
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
    expect(screen.queryByLabelText(/国籍|备注/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "添加到待确认" }));
    await user.click(screen.getByRole("button", { name: "确认新增" }));
    expect(await screen.findByText("优必选")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "查看 优必选" }));
    expect(screen.getByRole("heading", { name: "优必选" })).toBeTruthy();
    expect(await screen.findByText("还没有调研报告。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除公司" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /返回公司列表/ }));

    const removeCompany = screen.getByRole("button", { name: "删除公司 优必选" });
    expect(removeCompany.className).not.toContain("danger-button");
    await user.click(removeCompany);
    expect(screen.getByRole("dialog", { name: "移除公司" }).textContent).toContain("确认从“具身智能”主题移除“优必选”吗？");
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
    expect(screen.getByRole("dialog", { name: "批量移除公司" }).textContent).toContain("确认从“具身智能”主题移除已选的 2 家公司吗？");
    await user.click(within(screen.getByRole("dialog", { name: "批量移除公司" })).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "删除已选（2）" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "删除已选（2）" }));
    await user.click(screen.getByRole("button", { name: "确认移除 2 家公司" }));
    await waitFor(() => expect(screen.getByText("暂无公司，可手动添加或从文本识别。")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: /返回调研列表/ }));
    await user.click(screen.getByRole("button", { name: "删除主题" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 具身智能" }));
    await user.click(screen.getByRole("button", { name: "确认删除（1）" }));
    expect(screen.getByRole("dialog", { name: "删除主题" }).textContent).toContain("具身智能");
    await user.click(within(screen.getByRole("dialog", { name: "删除主题" })).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("button", { name: "确认删除（1）" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "确认删除（1）" }));
    await user.click(screen.getByRole("button", { name: "确认删除 1 个主题" }));
    expect(await screen.findByText("还没有研究主题")).toBeTruthy();
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
      .mockResolvedValueOnce([{ name: "公司甲" }])
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce([
        { name: "公司甲" },
        { name: "公司乙" },
      ]);
    fake.industryResearch.addCompanies.mockImplementation(async (_itemId, drafts) => {
      companies = drafts.map((draft, index) => ({
        id: `imported-${index}` as CompanyId,
        itemId: item.id,
        normalizedName: draft.name.toLocaleLowerCase(),
        createdAt: "2026-09-08T10:00:00.000Z",
        updatedAt: "2026-09-08T10:00:00.000Z",
        profileStatus: "ready",
        ...draft,
      }));
      return companies;
    });
    const { user } = await renderApp(fake);
    await chatReady();
    await user.click(screen.getByRole("button", { name: "研究主题" }));
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
    expect(screen.queryByLabelText(/国籍|备注/)).toBeNull();
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

  it("renders persisted per-company completion states and refreshes one ready profile", async () => {
    const fake = makeFakeApi();
    const active = conversation("c-profile", "资料状态", true);
    const item = capabilityItem({ id: "item-profile", industry: "机器人" });
    let companies: ItemCompanyView[] = [
      { ...companyViewFixture("pending", "待处理公司", item.id), profileStatus: "pending" },
      { ...companyViewFixture("enriching", "补全中公司", item.id), profileStatus: "enriching" },
      { ...companyViewFixture("failed", "失败公司", item.id), profileStatus: "failed" },
      { ...companyViewFixture("ready", "已有公司", item.id), profileStatus: "ready", headquarters: "北京" },
    ];
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockImplementation(async () => [...companies]);
    const { user } = await renderApp(fake);
    await chatReady();
    await user.click(screen.getByRole("button", { name: "研究主题" }));
    await user.click(await screen.findByRole("button", { name: /^机器人/ }));

    expect((screen.getByRole("button", { name: "查看 待处理公司" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "查看 补全中公司" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("待处理公司 基本信息补全中")).toBeNull();
    const activeSpinner = screen.getByLabelText("补全中公司 基本信息补全中");
    expect(activeSpinner).toBeTruthy();
    expect(screen.getByLabelText("失败公司 基本信息补全失败")).toBeTruthy();
    const retryButton = screen.getByRole("button", { name: "重试补全 失败公司" });
    expect(retryButton.compareDocumentPosition(screen.getByLabelText("失败公司 基本信息补全失败")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((screen.getByRole("button", { name: "查看 失败公司" }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).not.toMatch(/正在补全\s*\d+\s*\/\s*\d+/u);

    fake.industryResearch.retryCompanyProfile.mockImplementation(async (companyId) => {
      companies = companies.map((company) => company.id === companyId
        ? { ...company, profileStatus: "pending" }
        : company);
      await fake.emitProfile({ companyId: companyId as CompanyId, status: "pending" });
      return true;
    });
    await user.click(retryButton);
    expect(screen.queryByLabelText("失败公司 基本信息补全中")).toBeNull();
    await act(async () => fake.emitProfile({ companyId: "failed", status: "enriching" }));
    expect(screen.getByLabelText("失败公司 基本信息补全中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试补全 失败公司" })).toBeNull();

    companies = companies.map((company) => company.name === "待处理公司"
      ? { ...company, profileStatus: "ready", headquarters: "上海" }
      : company);
    await act(async () => fake.emitProfile({ companyId: "pending", status: "ready" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "查看 待处理公司" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("上海")).toBeTruthy();
  });

  it("keeps an early enrichment event and shows a spinner only for the active queued company", async () => {
    const fake = makeFakeApi();
    const active = conversation("c-profile-race", "队列状态", true);
    const item = capabilityItem({ id: "item-profile-race", industry: "智能眼镜" });
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockResolvedValue([]);
    fake.industryResearch.addCompanies.mockImplementation(async (_itemId, drafts) => {
      const added = drafts.map((draft, index) => ({
        ...companyViewFixture(`queued-${index}`, draft.name, item.id),
        profileStatus: "pending" as const,
      }));
      fake.emitProfile({ companyId: added[0]!.id, status: "enriching" });
      return added;
    });
    const { user } = await renderApp(fake);
    await chatReady();
    await user.click(screen.getByRole("button", { name: "研究主题" }));
    await user.click(await screen.findByRole("button", { name: /^智能眼镜/ }));
    await user.click(screen.getByRole("button", { name: "添加公司" }));
    await user.type(screen.getByLabelText("公司名称"), "公司甲");
    await user.click(screen.getByRole("button", { name: "添加到待确认" }));
    await user.type(screen.getByLabelText("公司名称"), "公司乙");
    await user.click(screen.getByRole("button", { name: "添加到待确认" }));
    await user.click(screen.getByRole("button", { name: "确认新增" }));

    expect(await screen.findByLabelText("公司甲 基本信息补全中")).toBeTruthy();
    expect(screen.queryByLabelText("公司乙 基本信息补全中")).toBeNull();
    expect((screen.getByRole("button", { name: "查看 公司甲" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "查看 公司乙" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("edits company basic information inline without opening a modal", async () => {
    const fake = makeFakeApi();
    const active = conversation("c-profile-edit", "公司资料", true);
    const item = capabilityItem({ id: "item-profile-edit", industry: "智能眼镜" });
    let company = {
      ...companyViewFixture("company-inline", "Google", item.id),
      profileStatus: "ready" as const,
      headquarters: "Mountain View, California, USA",
      businessTags: ["人工智能"],
    };
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockImplementation(async () => [company]);
    fake.industryResearch.updateCompany.mockImplementation(async (_companyId, input) => {
      company = { ...company, ...input, profileStatus: "ready" };
      return company;
    });
    const { user } = await renderApp(fake);
    await chatReady();
    await user.click(screen.getByRole("button", { name: "研究主题" }));
    await user.click(await screen.findByRole("button", { name: /^智能眼镜/ }));
    await act(async () => fake.emitProfile({ companyId: company.id, status: "failed" }));
    await user.click(screen.getByRole("button", { name: "查看 Google" }));

    const editInformation = screen.getByRole("button", { name: "编辑信息" });
    const deleteCompany = screen.getByRole("button", { name: "删除公司" });
    expect(editInformation.className).toContain("company-detail-action");
    expect(deleteCompany.className).toContain("company-detail-action");
    await user.click(editInformation);
    expect(screen.queryByRole("dialog", { name: "编辑公司基本信息" })).toBeNull();
    const headquarters = screen.getByLabelText("总部（可选）");
    await user.clear(headquarters);
    await user.type(headquarters, "山景城，美国");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("山景城，美国")).toBeTruthy();
    expect(screen.queryByLabelText("总部（可选）")).toBeNull();

    await user.click(screen.getByRole("button", { name: /返回公司列表/ }));
    await user.click(screen.getByRole("button", { name: /返回调研列表/ }));
    await user.click(screen.getByRole("button", { name: /^智能眼镜/ }));
    expect(await screen.findByRole("button", { name: "查看 Google" })).toBeTruthy();
    expect(screen.queryByLabelText("Google 基本信息补全失败")).toBeNull();
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

    await user.click(screen.getByRole("button", { name: "研究主题" }));
    expect(document.querySelector(".chat-pane-header")).toBeTruthy();
    expect(document.querySelector(".chat-pane-header")?.className).toContain("collapsed");

    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    const settingsNavigation = screen.getByRole("navigation", { name: "设置导航" });
    expect(settingsNavigation).toBeTruthy();
    expect(screen.getByRole("button", { name: "‹ 返回" })).toBeTruthy();
    expect(within(settingsNavigation).getByText("设置")).toBeTruthy();
    expect(screen.getByRole("button", { name: "LLM" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(await screen.findByRole("heading", { name: "模型与搜索" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "‹ 返回" }));
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "研究主题" })).toBeTruthy();
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");

    await user.click(screen.getByRole("button", { name: "展开 Chat" }));
    expect(document.querySelector(".chat-pane-header")?.className).toContain("expanded");
    expect(document.querySelector(".chat-pane-title")?.textContent).toBe("对话甲");
  });

  it("streams a company report and retains two selectable rerun versions", async () => {
    const fake = makeFakeApi();
    fake.settings.get.mockResolvedValue(configuredSettings());
    const activeConversation = conversation("c-research", "调研对话", true);
    const item = capabilityItem({ id: "item-research", industry: "智能眼镜" });
    const company: ItemCompanyView = {
      id: "company-research" as CompanyId,
      itemId: item.id,
      name: "小米",
      normalizedName: "小米",
      profileStatus: "ready",
      headquarters: "中国",
      note: "重点候选",
      createdAt: "2026-09-09T08:00:00.000Z",
      updatedAt: "2026-09-09T08:00:00.000Z",
    };
    let state: CompanyResearchState = { runs: [], globalActiveRun: null };
    const details = new Map<string, ResearchRun>();
    let sequence = 0;
    fake.conversations.openInitial.mockResolvedValue({
      active: activeConversation,
      recent: [activeConversation],
    });
    fake.industryResearch.listItems.mockResolvedValue([item]);
    fake.industryResearch.listCompanies.mockResolvedValue([company]);
    fake.companyResearch.getState.mockImplementation(async () => state);
    fake.companyResearch.getRun.mockImplementation(async (_item, _company, id) => details.get(id));
    fake.companyResearch.start.mockImplementation(async (_itemId, _companyId, input) => {
      const run = researchRun({ id: `run-${++sequence}` as ResearchRunId, status: "researching", ...input });
      state = { ...activeResearch(run), runs: state.runs };
      details.set(run.id, run);
      return run;
    });

    const { user } = await renderApp(fake);
    const chatInput = await chatReady();
    await user.click(screen.getByRole("button", { name: "研究主题" }));
    await user.click(await screen.findByRole("button", { name: /^智能眼镜/ }));
    await user.click(screen.getByRole("button", { name: "查看 小米" }));
    await user.click(await screen.findByRole("button", { name: "开始调研" }));

    const dialog = screen.getByRole("dialog", { name: "公司调研" });
    expect(within(dialog).getByText("智能眼镜")).toBeTruthy();
    expect(within(dialog).getByText("小米")).toBeTruthy();
    expect((screen.getByLabelText("研究方向") as HTMLSelectElement).options).toHaveLength(4);
    await user.selectOptions(screen.getByLabelText("研究方向"), "product_and_technology");
    await user.type(screen.getByLabelText("关注范围（可选）"), "关注新品");
    await user.click(within(screen.getByRole("dialog", { name: "公司调研" })).getByRole(
      "button",
      { name: "开始调研" },
    ));
    const firstRun = state.active!.run;
    expect(fake.companyResearch.start).toHaveBeenCalledWith(item.id, company.id, expect.objectContaining({ direction: "product_and_technology", focusScope: "关注新品" }));
    act(() => {
      fake.emitResearch({
        requestId: "request-1",
        runId: firstRun.id,
        type: "text_delta",
        stage: "raw",
        delta: "第一版报告\n来源：https://example.com/one",
      });
    });
    await waitFor(() => expect(screen.getByText(/第一版报告/)).toBeTruthy());
    expect(screen.queryByText(/%/)).toBeNull();

    await user.type(chatInput, "同时整理采访提纲");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(fake.chat.send).toHaveBeenCalledTimes(1);

    const firstCompleted = researchRun({ id: firstRun.id, rawReportText: "第一版报告\n来源：https://example.com/one" });
    details.set(firstRun.id, firstCompleted);
    state = { runs: [researchSummary(firstCompleted)], globalActiveRun: null };
    act(() => {
      fake.emitResearch({
        runId: firstRun.id,
        itemId: item.id, companyId: company.id, type: "state_changed",
      });
    });
    await user.click(await screen.findByRole("tab", { name: "结构化报告" }));
    expect(await screen.findByText("核心结论")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "原始调研报告" }));
    const firstLink = await screen.findByRole("link", { name: "https://example.com/one" });
    expect(firstLink.getAttribute("rel")).toContain("noopener");

    await user.click(screen.getByRole("button", { name: "新的调研" }));
    expect((screen.getByLabelText("关注范围（可选）") as HTMLTextAreaElement).value).toBe("关注新品");
    await user.click(within(screen.getByRole("dialog", { name: "公司调研" })).getByRole(
      "button",
      { name: "开始调研" },
    ));
    const secondRun = state.active!.run;
    const secondCompleted = researchRun({ id: secondRun.id, rawReportText: "第二版报告" });
    details.set(secondRun.id, secondCompleted);
    state = { runs: [researchSummary(secondCompleted), researchSummary(firstCompleted)], globalActiveRun: null };
    act(() => {
      fake.emitResearch({
        runId: secondRun.id,
        itemId: item.id, companyId: company.id, type: "state_changed",
      });
    });

    expect(await screen.findByText("第二版报告")).toBeTruthy();
    await user.click(await screen.findByRole("tab", { name: "结构化报告" }));
    expect(await screen.findByText("核心结论")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "原始调研报告" }));
    expect(await screen.findByText("第二版报告")).toBeTruthy();
    const history = screen.getByLabelText("报告版本") as HTMLSelectElement;
    expect(history.options).toHaveLength(2);
    await user.selectOptions(history, firstCompleted.id);
    await waitFor(() => expect(fake.companyResearch.getRun).toHaveBeenLastCalledWith(item.id, company.id, firstCompleted.id));
    await user.click(await screen.findByRole("tab", { name: "原始调研报告" }));
    expect(await screen.findByText(/第一版报告/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.queryByRole("combobox", { name: "报告版本" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "研究主题" }));
    expect((screen.getByLabelText("报告版本") as HTMLSelectElement).value).toBe(firstCompleted.id);
    expect(screen.getByRole("tab", { name: "原始调研报告" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText(/第一版报告/)).toBeTruthy();
  });
});
