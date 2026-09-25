/**
 * ウィンドウを閉じる要求 (閉じるボタン / macOS の ⌘Q = Rust 側で `window.close()` に経路変更済)
 * を 1 か所で受ける調停役。
 *
 * `getCurrentWindow().onCloseRequested` は listener ごとに「`preventDefault` されなければ
 * `destroy()`」を実行するため、画面ごとに listener を登録すると、ある画面が閉じるのを
 * 止めても別の listener がウィンドウを破棄してしまう。そこで listener は App で 1 本だけ
 * 登録し、各画面は `registerCloseGuard` / `registerBeforeCloseTask` で参加する。
 */
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface CloseGuard {
  /** 閉じる要求を止めるべきか (未保存の変更がある等)。 */
  shouldBlock: () => boolean;
  /** 止めたときに呼ばれる。利用者が破棄を選んだら `proceed()` で閉じ直す。 */
  onBlocked: (proceed: () => void) => void;
}

/** 閉じる直前に待つ処理 (debounce 中の設定保存の flush 等)。失敗しても閉じる。 */
export type BeforeCloseTask = () => Promise<void>;

const guards = new Set<CloseGuard>();
const beforeCloseTasks = new Set<BeforeCloseTask>();
let closeConfirmed = false;

export function registerCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

export function registerBeforeCloseTask(task: BeforeCloseTask): () => void {
  beforeCloseTasks.add(task);
  return () => {
    beforeCloseTasks.delete(task);
  };
}

/**
 * 閉じる要求 1 回ぶんの処理。止めるなら `event.preventDefault()` を呼ぶ。
 * `closeWindow` はテスト用の差し替え口。
 */
export async function handleCloseRequested(
  event: { preventDefault: () => void },
  closeWindow: () => Promise<void> = () => getCurrentWindow().close(),
): Promise<void> {
  if (!closeConfirmed) {
    for (const guard of guards) {
      if (!guard.shouldBlock()) continue;
      event.preventDefault();
      guard.onBlocked(() => {
        closeConfirmed = true;
        void closeWindow().catch(() => {
          closeConfirmed = false;
        });
      });
      return;
    }
  }
  await Promise.allSettled([...beforeCloseTasks].map((task) => task()));
}

/** App 起動時に 1 度だけ呼ぶ。Tauri 外 (テスト / ブラウザ) では何もしない。 */
export function installWindowCloseCoordinator(): () => void {
  if (!isTauri()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void getCurrentWindow()
    .onCloseRequested((event) => handleCloseRequested(event))
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** テスト専用: モジュール状態を初期化する。 */
export function resetWindowCloseCoordinatorForTest(): void {
  guards.clear();
  beforeCloseTasks.clear();
  closeConfirmed = false;
}
