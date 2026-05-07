/**
 * フロント側 ModuleDefinition / 関連型定義 (`docs/module-contract.md` §4)。
 *
 * Q-22 PoC では最小の構造のみ定義。Phase 1 で Shell / SearchAdapter / ItemRow を
 * 本実装する際に拡張する。
 */
import type { ComponentType } from "react";

/** モジュール定義 (id がバックエンドの ModuleBackend と一致する必要がある) */
export interface ModuleDefinition {
  /** ModuleBackend.id() と完全一致しなければならない */
  readonly id: string;

  /** UI に表示する名前 (例: "ハッシュ計算") */
  readonly displayName: string;

  /** サイドバー等のアイコン */
  readonly icon: ComponentType<{ className?: string }>;

  /** Phase 1 では将来拡張用のメタ情報。実体としての enable/disable UI は提供しない */
  readonly enabledByDefault: boolean;

  /** Backend の is_stateless と一致させる */
  readonly isStateless: boolean;

  /** モジュール内画面のルート定義 (Phase 1 着手時に拡張) */
  readonly routes: readonly ModuleRoute[];

  /** モジュールに入った直後に開くデフォルトルート */
  readonly defaultRoute: string;
}

/** モジュール内画面のルート (`docs/module-contract.md` §4.1) */
export interface ModuleRoute {
  /** モジュールルート相対のパス (例: "/", "/edit/:itemId") */
  readonly path: string;
  /** 描画するコンポーネント */
  readonly component: ComponentType;
}
