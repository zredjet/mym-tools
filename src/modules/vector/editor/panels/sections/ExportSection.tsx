import { Download } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";

import { pngSize } from "../../export/png";
import { planExport } from "../../export/plan";
import { ExportError, runExport } from "../../export/run";
import {
  EXPORT_SCALES,
  type ExportFormat,
  type ExportPlan,
  type ExportScale,
} from "../../export/types";
import { useExportWriter } from "../../export/writer";
import type { CanvasDocument, NodeId, PageId } from "../../model/types";
import { canvasTextMeasurer } from "../../render/measureText";
import { editorStore, useEditorStore } from "../../state/store";
import { Section, Segmented } from "../fields/Section";

const FORMAT_OPTIONS: readonly { value: ExportFormat; label: string }[] = [
  { value: "svg", label: "SVG" },
  { value: "png", label: "PNG" },
];

const SCALE_OPTIONS = EXPORT_SCALES.map((scale) => ({
  value: String(scale) as `${ExportScale}`,
  label: `${scale}x`,
}));

/**
 * 文書・ページ・選択の組ごとに書き出しの対象を覚える (直前の 1 組だけ)。
 * store の購読はパンやホバーでも selector を呼ぶので、同じ組なら同じ結果を返して描き直さない。
 */
let lastPlan: {
  doc: CanvasDocument;
  pageId: PageId;
  selection: readonly NodeId[];
  plan: ExportPlan;
} | null = null;

function currentPlan(
  doc: CanvasDocument,
  pageId: PageId,
  selection: readonly NodeId[],
): ExportPlan {
  if (
    lastPlan &&
    lastPlan.doc === doc &&
    lastPlan.pageId === pageId &&
    lastPlan.selection === selection
  )
    return lastPlan.plan;
  const plan = planExport(doc, pageId, selection, canvasTextMeasurer);
  lastPlan = { doc, pageId, selection, plan };
  return plan;
}

/** 何を書き出すか (§5.3)。 */
function describe(plan: ExportPlan): string {
  if (plan.kind === "page") return "ページ全体を 1 ファイルに";
  if (plan.kind === "frames") {
    const count = plan.ok ? plan.targets.length : 0;
    return count <= 1 ? "フレームを 1 ファイルに" : `フレーム ${count} 個を 1 個ずつのファイルに`;
  }
  const count = plan.ok ? (plan.targets[0]?.nodeIds.length ?? 0) : 0;
  return count <= 1 ? "選択したノードを 1 ファイルに" : `選択した ${count} 個を 1 ファイルに`;
}

type Status =
  | { kind: "busy" }
  | { kind: "done"; message: string; plan: ExportPlan }
  | { kind: "error"; message: string; plan: ExportPlan };

function doneMessage(written: number, total: number): string {
  if (written === 0) return "書き出しを取り消しました。";
  if (written < total) return `${total} ファイルのうち ${written} ファイルを書き出しました。`;
  return total === 1 ? "書き出しました。" : `${total} ファイルを書き出しました。`;
}

/**
 * プロパティパネルの書き出しの節 (§4.9 / §5.3)。選択がなければページ全体を書き出す。
 * ファイルへの書き込みは登録された関数 (`export/writer.ts`) を通し、登録がない間はボタンを無効にする。
 */
export function ExportSection() {
  const plan = useEditorStore((s) => currentPlan(s.doc, s.pageId, s.selection));
  const writer = useExportWriter();
  const [format, setFormat] = useState<ExportFormat>("svg");
  const [scale, setScale] = useState<ExportScale>(2);
  const [status, setStatus] = useState<Status | null>(null);

  const busy = status?.kind === "busy";
  // 結果の表示は、そのときの対象のままの間だけ出す (選択や文書が変われば消す)
  const shownStatus = status && (status.kind === "busy" || status.plan === plan) ? status : null;

  let problem: string | null = plan.ok ? null : plan.reason;
  let sizeText: string | null = null;
  if (plan.ok) {
    if (format === "png") {
      for (const target of plan.targets) {
        const size = pngSize(target.bounds, scale);
        if (!size.ok) {
          problem = size.reason;
          break;
        }
      }
    }
    const [only] = plan.targets;
    if (plan.targets.length === 1 && only) {
      const factor = format === "png" ? scale : 1;
      sizeText = `${(only.bounds.width * factor).toLocaleString()} × ${(only.bounds.height * factor).toLocaleString()} px`;
    }
  }

  const run = async () => {
    if (!writer || busy) return;
    // 押した時点の文書と対象を使う (文書は変えない)
    const { doc, pageId, selection } = editorStore.getState();
    const target = currentPlan(doc, pageId, selection);
    setStatus({ kind: "busy" });
    try {
      const result = await runExport(doc, target, writer, {
        format,
        scale,
        measurer: canvasTextMeasurer,
      });
      setStatus({ kind: "done", message: doneMessage(result.written, result.total), plan: target });
    } catch (error) {
      const message =
        error instanceof ExportError
          ? error.message
          : `書き出しに失敗しました: ${error instanceof Error ? error.message : String(error)}`;
      setStatus({ kind: "error", message, plan: target });
    }
  };

  return (
    <Section title="書き出し">
      <Segmented<ExportFormat>
        label="書き出しの形式"
        options={FORMAT_OPTIONS}
        value={format}
        onChange={setFormat}
      />
      {format === "png" && (
        <Segmented
          label="倍率"
          options={SCALE_OPTIONS}
          value={String(scale) as `${ExportScale}`}
          onChange={(value) => setScale(Number(value) as ExportScale)}
        />
      )}
      <p className="text-[11px] leading-4 text-[var(--fg-muted)]">
        {describe(plan)}
        {sizeText !== null && (
          <>
            <br />
            <span className="tabular-nums">{sizeText}</span>
          </>
        )}
      </p>
      {problem !== null && (
        <p role="alert" className="text-[11px] leading-4 text-[var(--destructive)]">
          {problem}
        </p>
      )}
      <Button
        size="sm"
        className="w-full"
        disabled={writer === null || busy || problem !== null}
        title={writer === null ? "書き出し先が設定されていません" : undefined}
        onClick={() => void run()}
      >
        <Download size={14} aria-hidden />
        {busy ? "書き出し中…" : `${format.toUpperCase()} を書き出す`}
      </Button>
      {shownStatus?.kind === "done" && (
        <p role="status" className="text-[11px] leading-4 text-[var(--fg-muted)]">
          {shownStatus.message}
        </p>
      )}
      {shownStatus?.kind === "error" && (
        <p role="alert" className="text-[11px] leading-4 text-[var(--destructive)]">
          {shownStatus.message}
        </p>
      )}
    </Section>
  );
}
