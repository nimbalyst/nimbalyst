// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DeviceInventoryPanel } from "../DeviceInventoryPanel";
afterEach(cleanup);
it("hides selected offline devices, restores them, and keeps the rendered account on writes", async () => {
  let hidden = false;
  const invoke = vi.fn(async (channel, update) => {
    if (channel === "sync:update-devices") hidden = update.hidden;
    return {
      success: true,
      accountId: "account-a",
      inventoryVersion: 1,
      devices: [
        {
          deviceId: "old",
          name: "Previous Mac",
          platform: "macos",
          isOnline: false,
          inventoryHidden: hidden,
        },
        {
          deviceId: "live",
          name: "Live Mac",
          platform: "macos",
          isOnline: true,
        },
      ],
    };
  });
  window.electronAPI = { invoke } as any;
  render(<DeviceInventoryPanel enabled />);
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Select Previous Mac" })
  );
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Select Live Mac",
      }) as HTMLInputElement
    ).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Hide selected" }));
  await screen.findByRole("button", { name: "Restore" });
  expect(invoke).toHaveBeenCalledWith("sync:update-devices", {
    accountId: "account-a",
    deviceIds: ["old"],
    hidden: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Name for Previous Mac" }),
    { target: { value: "Dev profile" } }
  );
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("sync:update-devices", {
      accountId: "account-a",
      deviceIds: ["old"],
      label: "Dev profile",
    })
  );
});
it("keeps inventory readable when the server lacks mutation support", async () => {
  window.electronAPI = {
    invoke: vi.fn(async () => ({
      success: true,
      devices: [{ deviceId: "old", name: "Old Mac", isOnline: false }],
    })),
  } as any;
  render(<DeviceInventoryPanel enabled />);
  await screen.findByText("Inventory changes require an updated sync server.");
  expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
});
