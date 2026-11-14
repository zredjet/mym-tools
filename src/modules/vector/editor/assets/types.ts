/**
 * 画像と SVG の取込 (§4.8) で、ファイルを読む関数が返すもの。
 *
 * 切替 PR では、ファイル選択 (`plugin-dialog`) で選んだ path を Rust の
 * `vector_read_image(path)` (data URL) と `vector_read_file(path)` (`{ svg, text, notices }`) に渡し、
 * 戻り値をそのまま入れる。検証 (大きさ、種類、SVG ポリシー、draw.io の変換) は Rust が行う。
 */

/** PNG / JPEG / WebP。`vector_read_image` の戻り値 (`data:image/png;base64,...`) をそのまま入れる。 */
export interface ImportedImage {
  kind: "image";
  dataUrl: string;
  /** ノードの名前に使う (拡張子を除いたファイル名)。省けば「画像」 */
  name?: string;
}

/** SVG。`vector_read_file` の戻り値 (`svg` `text` `notices`) をそのまま入れる。 */
export interface ImportedSvg {
  kind: "svg";
  /** SVG ポリシーを通った SVG (draw.io の SVG は変換済み) */
  svg: string;
  /** Rust が抽出した検索用テキスト。エディタも抽出し、一致しなければ取り込まない */
  text: string;
  /** 取込のときに行った変換の説明 (draw.io の SVG など)。エディタは表示するだけ */
  notices?: readonly string[];
  /** ノードの名前に使う (拡張子を除いたファイル名)。省けば「SVG」 */
  name?: string;
}

export type ImportedFile = ImportedImage | ImportedSvg;

/**
 * ファイル選択を開き、選んだファイルを読む関数。取り消したら null。
 * 読めなければ例外 (Rust のエラーをそのまま) を投げる。エディタが理由を表示する。
 *
 * ブラウザの `<input type="file">` は利用者の操作の中で開く必要があるので、エディタは
 * ボタンやクリックのハンドラの中で、待たずにすぐ呼ぶ。
 */
export type ImportFileReader = () => Promise<ImportedFile | null>;
