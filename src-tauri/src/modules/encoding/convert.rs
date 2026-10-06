//! 文字コード変換の本体。1 MiB ずつ 復号 → (Mac 記号の置換) → 符号化 → 改行の変換 と流し、
//! 一時ファイルへ書く。変換元の不正なバイトか、変換先で表せない文字が 1 つでもあれば
//! 一時ファイルを捨てて「拒否」として位置を返す (ADR-0024)。

use std::borrow::Cow;
use std::io::Write;

use encoding_rs::{Encoder, EncoderResult};
use serde::{Deserialize, Serialize};

use crate::modules::text_encoding::{
    ByteIssue, LineTracker, StreamDecoder, TextEncoding, MAX_ISSUES,
};

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetEncoding {
    Utf8,
    Utf8Bom,
    ShiftJis,
    EucJp,
}

impl TargetEncoding {
    fn text_encoding(self) -> TextEncoding {
        match self {
            Self::Utf8 | Self::Utf8Bom => TextEncoding::Utf8,
            Self::ShiftJis => TextEncoding::ShiftJis,
            Self::EucJp => TextEncoding::EucJp,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NewlineMode {
    Keep,
    Lf,
    Crlf,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct NewlineStats {
    pub crlf: u64,
    pub lf: u64,
    pub cr: u64,
}

/// 変換先で表せない文字。行と桁は 1 始まりで、桁はコードポイント単位。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CharIssue {
    pub code_point: String,
    pub char: String,
    pub line: u64,
    pub column: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WarningKind {
    /// encoder がエラーにせず別の文字に寄せる (¥ → 0x5C など)
    Substituted,
    /// 私用領域の文字 (外字) を UTF-8 にそのまま入れた
    PrivateUse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConvertWarning {
    pub kind: WarningKind,
    pub code_point: String,
    pub char: String,
    /// 変換後に読み戻したときの文字 (substituted のときだけ)
    pub replacement: Option<String>,
    pub count: u64,
    pub first_line: u64,
}

/// 変換で集めた結果。`malformed` / `unmappable` が 1 件でもあれば出力しない。
#[derive(Debug, Default)]
pub(crate) struct Report {
    pub malformed_count: u64,
    pub malformed: Vec<ByteIssue>,
    pub unmappable_count: u64,
    pub unmappable: Vec<CharIssue>,
    pub normalized_count: u64,
    pub warnings: Vec<ConvertWarning>,
    pub newlines: NewlineStats,
    pub bytes_written: u64,
}

impl Report {
    pub(crate) fn rejected(&self) -> bool {
        self.malformed_count > 0 || self.unmappable_count > 0
    }
}

pub(crate) struct ConvertOptions {
    pub source: TextEncoding,
    pub bom_len: usize,
    pub target: TargetEncoding,
    pub newline: NewlineMode,
    pub normalize_mac_symbols: bool,
}

/// 変換元と変換先が同じ文字コードで、Mac 記号の置換もしないなら、文字を往復させずに
/// バイトのまま改行と BOM だけを変える。往復させると NEC / IBM の重複コードが別の
/// コードに変わるため。CR / LF は UTF-8・Shift_JIS・EUC-JP の多バイト文字の中に現れない。
pub(crate) fn is_byte_copy(options: &ConvertOptions) -> bool {
    !options.normalize_mac_symbols && options.source == options.target.text_encoding()
}

/// `bytes` を変換して `sink` に書く。区切りごとに `check` を呼ぶ (取消し)。
pub(crate) fn convert(
    bytes: &[u8],
    options: &ConvertOptions,
    sink: &mut dyn Write,
    check: &dyn Fn() -> Result<(), crate::error::AppError>,
) -> Result<Report, crate::error::AppError> {
    let byte_copy = is_byte_copy(options);
    let mut report = Report::default();
    let mut decoder = StreamDecoder::new(bytes, options.source, options.bom_len);
    let mut encoder = TargetEncoder::new(options.target);
    let mut newline = NewlineTransform::new(options.newline);
    let mut encoded = Vec::new();
    let mut out = Vec::new();

    if options.target == TargetEncoding::Utf8Bom {
        sink.write_all(UTF8_BOM)?;
        report.bytes_written += UTF8_BOM.len() as u64;
    }
    while let Some((piece, range)) = decoder.next_piece() {
        check()?;
        out.clear();
        if byte_copy {
            newline.push(&bytes[range], &mut out);
        } else {
            let piece = if options.normalize_mac_symbols {
                normalize_mac_symbols(&piece, &mut report.normalized_count)
            } else {
                Cow::Borrowed(piece.as_str())
            };
            encoded.clear();
            encoder.encode(&piece, &mut encoded);
            newline.push(&encoded, &mut out);
        }
        sink.write_all(&out)?;
        report.bytes_written += out.len() as u64;
    }
    out.clear();
    newline.finish(&mut out);
    sink.write_all(&out)?;
    report.bytes_written += out.len() as u64;

    report.malformed_count = decoder.malformed_count;
    report.malformed = decoder.malformed;
    report.unmappable_count = encoder.unmappable_count;
    report.unmappable = encoder.unmappable;
    report.warnings = encoder.warnings;
    report.newlines = newline.stats;
    Ok(report)
}

/// Mac で入力されやすく、Shift_JIS / EUC-JP に無い記号を Windows で使われる形に寄せる。
fn mac_symbol_replacement(ch: char) -> Option<char> {
    Some(match ch {
        '\u{301C}' => '\u{FF5E}', // 〜 → ～
        '\u{2016}' => '\u{2225}', // ‖ → ∥
        '\u{2014}' => '\u{2015}', // — → ―
        '\u{00A2}' => '\u{FFE0}', // ¢ → ￠
        '\u{00A3}' => '\u{FFE1}', // £ → ￡
        '\u{00AC}' => '\u{FFE2}', // ¬ → ￢
        '\u{2212}' => '\u{FF0D}', // − → －
        _ => return None,
    })
}

fn normalize_mac_symbols<'a>(piece: &'a str, count: &mut u64) -> Cow<'a, str> {
    if !piece.chars().any(|ch| mac_symbol_replacement(ch).is_some()) {
        return Cow::Borrowed(piece);
    }
    Cow::Owned(
        piece
            .chars()
            .map(|ch| match mac_symbol_replacement(ch) {
                Some(replacement) => {
                    *count += 1;
                    replacement
                }
                None => ch,
            })
            .collect(),
    )
}

/// encoding_rs の Shift_JIS / EUC-JP encoder がエラーにせず寄せる文字と、読み戻したときの文字。
fn silent_substitution(ch: char) -> Option<char> {
    match ch {
        '\u{00A5}' => Some('\\'),       // ¥ → 0x5C
        '\u{203E}' => Some('~'),        // ‾ → 0x7E
        '\u{2212}' => Some('\u{FF0D}'), // − → －
        _ => None,
    }
}

fn is_private_use(ch: char) -> bool {
    ('\u{E000}'..='\u{F8FF}').contains(&ch)
}

fn format_code_point(ch: char) -> String {
    format!("U+{:04X}", ch as u32)
}

struct TargetEncoder {
    /// UTF-8 への変換では None (文字列のバイトをそのまま使う)
    encoder: Option<Encoder>,
    lines: LineTracker,
    unmappable_count: u64,
    unmappable: Vec<CharIssue>,
    warnings: Vec<ConvertWarning>,
}

impl TargetEncoder {
    fn new(target: TargetEncoding) -> Self {
        let encoder = match target {
            TargetEncoding::Utf8 | TargetEncoding::Utf8Bom => None,
            other => Some(other.text_encoding().encoding().new_encoder()),
        };
        Self {
            encoder,
            lines: LineTracker::default(),
            unmappable_count: 0,
            unmappable: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn encode(&mut self, piece: &str, out: &mut Vec<u8>) {
        let mut positions = Vec::new();
        match &mut self.encoder {
            None => out.extend_from_slice(piece.as_bytes()),
            Some(encoder) => {
                let mut src = piece;
                let mut done = 0;
                loop {
                    let reserve = encoder
                        .max_buffer_length_from_utf8_without_replacement(src.len())
                        .unwrap_or(src.len().saturating_mul(4).saturating_add(16));
                    out.reserve(reserve);
                    // Shift_JIS / EUC-JP の encoder は状態を持たないので、区切りごとに last にしてよい
                    let (result, read) =
                        encoder.encode_from_utf8_to_vec_without_replacement(src, out, true);
                    done += read;
                    src = &src[read..];
                    match result {
                        EncoderResult::InputEmpty => break,
                        EncoderResult::OutputFull => {}
                        EncoderResult::Unmappable(ch) => {
                            self.unmappable_count += 1;
                            if self.unmappable.len() + positions.len() < MAX_ISSUES {
                                positions.push(done - ch.len_utf8());
                            }
                        }
                    }
                }
            }
        }
        self.annotate(piece, &positions);
    }

    /// 表せない文字の行・桁と、警告の対象になる文字を 1 回の走査で拾う。
    fn annotate(&mut self, piece: &str, positions: &[usize]) {
        let legacy = self.encoder.is_some();
        let needs_warning = |ch: char| {
            if legacy {
                silent_substitution(ch).is_some()
            } else {
                is_private_use(ch)
            }
        };
        if positions.is_empty() && !piece.chars().any(needs_warning) {
            self.lines.advance(piece, piece.len());
            self.lines.end_piece();
            return;
        }
        let mut next = positions.iter().peekable();
        for (index, ch) in piece.char_indices() {
            if next.peek().is_some_and(|&&position| position == index) {
                next.next();
                self.lines.advance(piece, index);
                self.unmappable.push(CharIssue {
                    code_point: format_code_point(ch),
                    char: ch.to_string(),
                    line: self.lines.line,
                    column: self.lines.column,
                });
            } else if needs_warning(ch) {
                self.lines.advance(piece, index);
                self.warn(ch);
            }
        }
        self.lines.advance(piece, piece.len());
        self.lines.end_piece();
    }

    fn warn(&mut self, ch: char) {
        let (kind, key) = match silent_substitution(ch) {
            Some(_) if self.encoder.is_some() => (WarningKind::Substituted, Some(ch)),
            _ => (WarningKind::PrivateUse, None),
        };
        // 私用領域はまとめて 1 件、寄せる文字は文字ごとに 1 件
        let existing = self.warnings.iter_mut().find(|warning| {
            warning.kind == kind && (key.is_none() || warning.char == ch.to_string())
        });
        match existing {
            Some(warning) => warning.count += 1,
            None => self.warnings.push(ConvertWarning {
                kind,
                code_point: format_code_point(ch),
                char: ch.to_string(),
                replacement: key
                    .and_then(silent_substitution)
                    .map(|replacement| replacement.to_string()),
                count: 1,
                first_line: self.lines.line,
            }),
        }
    }
}

/// 改行を数え、指定の形に揃える。区切りの末尾の CR は次の区切りへ持ち越して CRLF を判定する。
pub(crate) struct NewlineTransform {
    mode: NewlineMode,
    pending_cr: bool,
    pub stats: NewlineStats,
}

impl NewlineTransform {
    pub(crate) fn new(mode: NewlineMode) -> Self {
        Self {
            mode,
            pending_cr: false,
            stats: NewlineStats::default(),
        }
    }

    pub(crate) fn push(&mut self, input: &[u8], out: &mut Vec<u8>) {
        out.reserve(input.len());
        for &byte in input {
            if self.pending_cr {
                self.pending_cr = false;
                if byte == b'\n' {
                    self.stats.crlf += 1;
                    self.emit(b"\r\n", out);
                    continue;
                }
                self.stats.cr += 1;
                self.emit(b"\r", out);
            }
            match byte {
                b'\r' => self.pending_cr = true,
                b'\n' => {
                    self.stats.lf += 1;
                    self.emit(b"\n", out);
                }
                _ => out.push(byte),
            }
        }
    }

    pub(crate) fn finish(&mut self, out: &mut Vec<u8>) {
        if self.pending_cr {
            self.pending_cr = false;
            self.stats.cr += 1;
            self.emit(b"\r", out);
        }
    }

    fn emit(&self, original: &[u8], out: &mut Vec<u8>) {
        out.extend_from_slice(match self.mode {
            NewlineMode::Keep => original,
            NewlineMode::Lf => b"\n",
            NewlineMode::Crlf => b"\r\n",
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::text_encoding::CHUNK_SIZE;
    use encoding_rs::{EUC_JP, SHIFT_JIS, UTF_16LE};

    fn run(bytes: &[u8], options: ConvertOptions) -> (Report, Vec<u8>) {
        let mut out = Vec::new();
        let report = convert(bytes, &options, &mut out, &|| Ok(())).unwrap();
        (report, out)
    }

    fn options(source: TextEncoding, target: TargetEncoding) -> ConvertOptions {
        ConvertOptions {
            source,
            bom_len: 0,
            target,
            newline: NewlineMode::Keep,
            normalize_mac_symbols: false,
        }
    }

    #[test]
    fn converts_shift_jis_to_utf8_with_bom_and_crlf() {
        let (sjis, _, _) = SHIFT_JIS.encode("見出し,値\n東京,1\r\n");
        let (report, out) = run(
            &sjis,
            ConvertOptions {
                newline: NewlineMode::Crlf,
                ..options(TextEncoding::ShiftJis, TargetEncoding::Utf8Bom)
            },
        );
        assert!(!report.rejected());
        assert_eq!(out, "\u{FEFF}見出し,値\r\n東京,1\r\n".as_bytes());
        assert_eq!(
            report.newlines,
            NewlineStats {
                crlf: 1,
                lf: 1,
                cr: 0
            }
        );
        assert_eq!(report.bytes_written, out.len() as u64);
    }

    #[test]
    fn converts_utf16_to_shift_jis() {
        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "日本\r\n".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        let (report, out) = run(
            &utf16,
            ConvertOptions {
                bom_len: 2,
                newline: NewlineMode::Lf,
                ..options(TextEncoding::Utf16Le, TargetEncoding::ShiftJis)
            },
        );
        assert!(!report.rejected());
        assert_eq!(out, SHIFT_JIS.encode("日本\n").0.as_ref());
        // UTF_16LE は encoder を持たないが、復号には使える
        assert_eq!(UTF_16LE.output_encoding(), encoding_rs::UTF_8);
    }

    #[test]
    fn rejects_unmappable_characters_with_positions() {
        let text = "ok\n〜と😀\n";
        let (report, _) = run(
            text.as_bytes(),
            options(TextEncoding::Utf8, TargetEncoding::ShiftJis),
        );
        assert!(report.rejected());
        assert_eq!(report.unmappable_count, 2);
        assert_eq!(
            report.unmappable[0],
            CharIssue {
                code_point: "U+301C".into(),
                char: "〜".into(),
                line: 2,
                column: 1,
            }
        );
        assert_eq!(report.unmappable[1].code_point, "U+1F600");
        assert_eq!(
            (report.unmappable[1].line, report.unmappable[1].column),
            (2, 3)
        );
    }

    #[test]
    fn normalizes_mac_symbols_before_encoding() {
        let text = "1〜2 — ‖ ¢£¬ −";
        let (report, out) = run(
            text.as_bytes(),
            ConvertOptions {
                normalize_mac_symbols: true,
                ..options(TextEncoding::Utf8, TargetEncoding::ShiftJis)
            },
        );
        assert!(!report.rejected(), "{:?}", report.unmappable);
        assert_eq!(report.normalized_count, 7);
        assert_eq!(SHIFT_JIS.decode(&out).0, "1～2 ― ∥ ￠￡￢ －");
        assert!(report.warnings.is_empty());
    }

    #[test]
    fn warns_about_silently_substituted_characters() {
        let (report, out) = run(
            "a\n¥100 ¥\n−".as_bytes(),
            options(TextEncoding::Utf8, TargetEncoding::EucJp),
        );
        assert!(!report.rejected());
        assert_eq!(EUC_JP.decode(&out).0, "a\n\\100 \\\n－");
        assert_eq!(report.warnings.len(), 2);
        assert_eq!(report.warnings[0].kind, WarningKind::Substituted);
        assert_eq!(report.warnings[0].char, "¥");
        assert_eq!(report.warnings[0].replacement.as_deref(), Some("\\"));
        assert_eq!(
            (report.warnings[0].count, report.warnings[0].first_line),
            (2, 2)
        );
        assert_eq!(report.warnings[1].first_line, 3);
    }

    #[test]
    fn warns_about_private_use_characters_in_utf8_output() {
        // Shift_JIS の外字 (F040) は私用領域 U+E000 になる
        let (report, out) = run(
            b"a\xF0\x40",
            options(TextEncoding::ShiftJis, TargetEncoding::Utf8),
        );
        assert!(!report.rejected());
        assert_eq!(out, "a\u{E000}".as_bytes());
        assert_eq!(report.warnings[0].kind, WarningKind::PrivateUse);
        assert_eq!(report.warnings[0].count, 1);
    }

    #[test]
    fn rejects_malformed_source_bytes() {
        let (report, _) = run(
            b"ab\x82",
            options(TextEncoding::ShiftJis, TargetEncoding::Utf8),
        );
        assert!(report.rejected());
        assert_eq!(report.malformed_count, 1);
        assert_eq!(report.malformed[0].offset, 2);
    }

    #[test]
    fn copies_bytes_when_only_newlines_change() {
        // NEC 選定 IBM 拡張 (ED40) は往復させると FA5C に変わるので、バイトのまま残す
        let input = b"\xED\x40\r\n\x82\xA0\n";
        let (report, out) = run(
            input,
            ConvertOptions {
                newline: NewlineMode::Crlf,
                ..options(TextEncoding::ShiftJis, TargetEncoding::ShiftJis)
            },
        );
        assert!(!report.rejected());
        assert_eq!(out, b"\xED\x40\r\n\x82\xA0\r\n");
        assert!(is_byte_copy(&options(
            TextEncoding::ShiftJis,
            TargetEncoding::ShiftJis
        )));
    }

    #[test]
    fn removes_or_adds_the_utf8_bom() {
        let input = b"\xEF\xBB\xBFabc";
        let (_, out) = run(
            input,
            ConvertOptions {
                bom_len: 3,
                ..options(TextEncoding::Utf8, TargetEncoding::Utf8)
            },
        );
        assert_eq!(out, b"abc");
        let (_, out) = run(b"abc", options(TextEncoding::Utf8, TargetEncoding::Utf8Bom));
        assert_eq!(out, b"\xEF\xBB\xBFabc");
    }

    #[test]
    fn keeps_crlf_split_across_chunks() {
        let mut input = vec![b'a'; CHUNK_SIZE - 1];
        input.extend_from_slice(b"\r\nb\r");
        let (report, out) = run(
            &input,
            ConvertOptions {
                newline: NewlineMode::Lf,
                ..options(TextEncoding::Utf8, TargetEncoding::ShiftJis)
            },
        );
        assert_eq!(
            report.newlines,
            NewlineStats {
                crlf: 1,
                lf: 0,
                cr: 1
            }
        );
        assert_eq!(&out[out.len() - 4..], b"a\nb\n");
    }

    #[test]
    fn stops_when_cancelled() {
        let mut out = Vec::new();
        let result = convert(
            b"abc",
            &options(TextEncoding::Utf8, TargetEncoding::ShiftJis),
            &mut out,
            &|| {
                Err(crate::error::AppError::Cancelled {
                    operation_id: "op".into(),
                })
            },
        );
        assert!(matches!(
            result,
            Err(crate::error::AppError::Cancelled { .. })
        ));
    }
}
