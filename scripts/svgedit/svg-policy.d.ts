export interface SvgPolicy {
  elements: string[];
  cssProperties: string[];
}
export const MAX_SVG_BYTES: number;
export const MAX_TEXT_BYTES: number;
export const MAX_PNG_SIDE: number;
export const MAX_PNG_PIXELS: number;
export const SVG_NS: string;
export function utf8Size(value: string): number;
export function validateCss(value: string): void;
export function validateImageData(value: string): void;
export function validateSvg(svg: string, policy: SvgPolicy): { svg: string; text: string };
export function renderPng(svg: string, policy: SvgPolicy): Promise<string>;
