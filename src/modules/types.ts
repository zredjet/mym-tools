/**
 * フロント側 ModuleDefinition / 関連型定義 (`docs/module-contract.md` §4)。
 *
 * Shell / Router / Search が同じ registry を共有できるよう、UI 登録情報を一か所にまとめる。
 */
import type { ComponentType } from "react";

import type { Item, ModuleId } from "@/lib/types";

export type ModuleCategoryId = "manage" | "design" | "text" | "web" | "generate" | "time" | "other";

export interface ModuleCategoryDefinition {
  readonly id: ModuleCategoryId;
  readonly displayName: string;
}

/** モジュール定義 (id がバックエンドの ModuleBackend と一致する必要がある) */
export interface ModuleDefinition {
  /** ModuleBackend.id() と完全一致しなければならない */
  readonly id: ModuleId;

  /** UI に表示する名前 (例: "ハッシュ計算") */
  readonly displayName: string;

  /** サイドバー等のアイコン */
  readonly icon: ComponentType<{ className?: string }>;

  /** サイドバー上の表示分類。省略時は other。機能境界には使わない。 */
  readonly category?: ModuleCategoryId;

  /** 設定が未指定のときの有効状態 */
  readonly enabledByDefault: boolean;

  /** Backend の is_stateless と一致させる */
  readonly isStateless: boolean;

  /** モジュール内画面のルート定義 */
  readonly routes: readonly ModuleRoute[];

  /** モジュールに入った直後に開くデフォルトルート */
  readonly defaultRoute: string;

  /** 横断検索結果の表示と遷移先。stateful module では必須。 */
  readonly searchAdapter?: SearchAdapter;
}

/** モジュール内画面のルート (`docs/module-contract.md` §4.1) */
export interface ModuleRoute {
  /** モジュールルート相対のパス (例: "/", "/edit/:itemId") */
  readonly path: string;
  /** 描画するコンポーネント */
  readonly component: ComponentType;
}

export interface SearchAdapter {
  formatResult(item: Item): SearchResultView;
}

export interface SearchResultView {
  title: string;
  subtitle?: string;
  /** モジュールルート相対パス。`/` は一覧、`/<itemId>` は詳細。 */
  targetPath: string;
}
