import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptQueueList } from "../PromptQueueList";

const queue = [{ id: "q1", prompt: "keep me pending", timestamp: 1 }];

describe("PromptQueueList recovery gate", () => {
  it("visibly and accessibly disables every queue mutation control", () => {
    const onCancel = vi.fn();
    const onEdit = vi.fn();
    const onSendNow = vi.fn();

    const { container } = render(
      <PromptQueueList
        queue={queue}
        disabled
        onCancel={onCancel}
        onEdit={onEdit}
        onSendNow={onSendNow}
      />
    );

    expect(
      container
        .querySelector(".prompt-queue-list")
        ?.getAttribute("aria-disabled")
    ).toBe("true");
    expect(
      container
        .querySelector(".prompt-queue-list")
        ?.getAttribute("data-controls-disabled")
    ).toBe("true");
    const controls = screen.getAllByRole("button");
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
      expect(control.getAttribute("title")).toBe(
        "Unavailable while model recovery completes"
      );
      fireEvent.click(control);
    }
    expect(onCancel).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    expect(onSendNow).not.toHaveBeenCalled();
  });

  it("restores the same controls after recovery", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <PromptQueueList queue={queue} disabled onCancel={onCancel} />
    );

    rerender(<PromptQueueList queue={queue} onCancel={onCancel} />);
    const cancel = screen.getByTitle("Cancel this prompt");
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledWith("q1");
  });
});
