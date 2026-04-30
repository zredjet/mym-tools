/**
 * MyMyTools のフロントエントリ。
 *
 * Phase 1 着手時にこのコンポーネントを Shell (サイドバー / 検索バー / モジュールルート) に
 * 差し替える。現在は CI の `npm run build` / `cargo tauri build --no-bundle` を通すための
 * 最小プレースホルダ。
 *
 * 設計の正典は:
 * - docs/architecture.md §2 / §4
 * - docs/ui-design.md §6 (画面スケルトン)
 * - docs/module-contract.md §4 (ModuleDefinition)
 */
function App() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">MyMyTools</h1>
        <p className="mt-2 text-sm opacity-70">
          Phase 1 着手前の最小骨格。実装は順次追加されます。
        </p>
      </div>
    </main>
  );
}

export default App;
