export const MAX_DRAWIO_MESSAGE_CHARS = 28 * 1024 * 1024;
export type DrawioExportFormat = "svg" | "png";

export type DrawioEvent =
  | { event: "init" }
  | { event: "load"; xml?: string }
  | { event: "autosave"; xml: string }
  | { event: "save"; xml: string }
  | { event: "textContent"; data: string; requestId?: string }
  | { event: "export"; data: string; format?: string; filename?: string; requestId?: string }
  | { event: "openLink"; href: string };

export function drawioEditorUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.pathname !== "/index.html"
  ) {
    throw new Error("ダイアグラムエディタのローカルURLが不正です。");
  }
  const parameters = new URLSearchParams({
    embed: "1",
    proto: "json",
    spin: "1",
    libraries: "1",
    lang: "ja",
    noSaveBtn: "1",
    noExitBtn: "1",
    saveAndExit: "0",
    local: "1",
    offline: "1",
    lockdown: "1",
    suppressNewWindows: "1",
    returnbounds: "1",
  });
  url.search = parameters.toString();
  return url.toString();
}

export function drawioTargetOrigin(editorUrl: string): string {
  return new URL(editorUrl).origin;
}

export function isTrustedDrawioOrigin(origin: string, expectedOrigin: string): boolean {
  return origin === expectedOrigin;
}

export function parseDrawioMessage(data: unknown): DrawioEvent | null {
  if (typeof data !== "string" || data.length > MAX_DRAWIO_MESSAGE_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.event !== "string") return null;

  switch (value.event) {
    case "init":
      return { event: "init" };
    case "load":
      return { event: "load", ...(typeof value.xml === "string" ? { xml: value.xml } : {}) };
    case "autosave":
    case "save":
      return typeof value.xml === "string" ? { event: value.event, xml: value.xml } : null;
    case "textContent": {
      if (typeof value.data !== "string") return null;
      const requestId = nestedRequestId(value.message);
      return {
        event: "textContent",
        data: value.data,
        ...(requestId == null ? {} : { requestId }),
      };
    }
    case "export": {
      if (typeof value.data !== "string") return null;
      const requestId = nestedRequestId(value.message);
      return {
        event: "export",
        data: value.data,
        ...(typeof value.format === "string" ? { format: value.format } : {}),
        ...(typeof value.filename === "string" ? { filename: value.filename } : {}),
        ...(requestId == null ? {} : { requestId }),
      };
    }
    case "openLink":
      return typeof value.href === "string" ? { event: "openLink", href: value.href } : null;
    default:
      return null;
  }
}

export function drawioLoadMessage(xml: string, title: string): string {
  return JSON.stringify({
    action: "load",
    xml,
    title,
    autosave: 1,
    exportProtocol: true,
    noSaveBtn: 1,
    noExitBtn: 1,
    saveAndExit: 0,
  });
}

export function drawioExportMessage(format: DrawioExportFormat, requestId: string): object {
  return {
    action: "export",
    format,
    requestId,
    ...(format === "svg" ? { asText: true, embedImages: true, embedFonts: true } : {}),
    ...(format === "png" ? { scale: 2, border: 0, transparent: false, currentPage: true } : {}),
  };
}

export interface DrawioMenuExportTarget {
  format: "drawio" | "svg" | "png";
  extensions: string[];
  label: string;
}

/**
 * Formats that draw.io's own export dialog may hand to the parent. Only the
 * formats accepted by `diagram_write_file` (ADR-0017) are saved.
 */
export function drawioMenuExportTarget(format: string | undefined): DrawioMenuExportTarget | null {
  switch (format) {
    case "png":
      return { format: "png", extensions: ["png"], label: "PNG" };
    case "svg":
      return { format: "svg", extensions: ["svg"], label: "SVG" };
    case "xml":
      return { format: "drawio", extensions: ["drawio", "xml"], label: "XML" };
    default:
      return null;
  }
}

function nestedRequestId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.requestId === "string" ? value.requestId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
