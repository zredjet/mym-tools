/**
 * フロント側モジュールレジストリ (`docs/architecture.md` §5.1 / `docs/module-contract.md` §11)。
 *
 * 新モジュール追加時はここに `<id>Module` を 1 行追加するだけ。
 * Shell / Sidebar / Router はこの配列を読んで動的にモジュール群を組み立てる
 * (Phase 1 着手時の Shell 実装で利用)。
 */
import type { ModuleDefinition } from "@/modules/types";
import { hashModule } from "@/modules/hash";

export const modules: readonly ModuleDefinition[] = [
  hashModule,
  // 新モジュールはここに 1 行追加する
];
