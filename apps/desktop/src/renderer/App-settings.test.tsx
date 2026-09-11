// @vitest-environment jsdom
import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import { makeFakeApi } from "./renderer-test-helpers.js";

it("opens the modular settings surface", async () => {
  const fake = makeFakeApi();
  render(<App api={fake} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "设置" }));
  expect(await screen.findByRole("navigation", { name: "设置模块" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "LLM" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
});
