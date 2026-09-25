import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleCloseRequested,
  registerBeforeCloseTask,
  registerCloseGuard,
  resetWindowCloseCoordinatorForTest,
} from "./windowClose";

describe("window close coordinator", () => {
  beforeEach(() => resetWindowCloseCoordinatorForTest());

  it("runs before-close tasks and lets the window close when nothing blocks", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    registerBeforeCloseTask(task);
    registerCloseGuard({ shouldBlock: () => false, onBlocked: vi.fn() });
    const event = { preventDefault: vi.fn() };

    await handleCloseRequested(event, vi.fn());

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(task).toHaveBeenCalledOnce();
  });

  it("still closes when a before-close task fails", async () => {
    registerBeforeCloseTask(() => Promise.reject(new Error("disk full")));
    const event = { preventDefault: vi.fn() };
    await expect(handleCloseRequested(event, vi.fn())).resolves.toBeUndefined();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("blocks once for a dirty guard and closes again after the user confirms", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    registerBeforeCloseTask(task);
    let proceed: (() => void) | undefined;
    registerCloseGuard({ shouldBlock: () => true, onBlocked: (next) => (proceed = next) });
    const closeWindow = vi.fn().mockResolvedValue(undefined);

    const first = { preventDefault: vi.fn() };
    await handleCloseRequested(first, closeWindow);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(task).not.toHaveBeenCalled();

    proceed?.();
    expect(closeWindow).toHaveBeenCalledOnce();

    // close() が発行した 2 回目の要求は止めず、保存 flush は実行する
    const second = { preventDefault: vi.fn() };
    await handleCloseRequested(second, closeWindow);
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(task).toHaveBeenCalledOnce();
  });

  it("stops consulting a guard after it unregisters", async () => {
    const unregister = registerCloseGuard({ shouldBlock: () => true, onBlocked: vi.fn() });
    unregister();
    const event = { preventDefault: vi.fn() };
    await handleCloseRequested(event, vi.fn());
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
