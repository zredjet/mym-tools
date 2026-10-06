//! テキストファイルの文字コードを判定・復号する共通処理 (ADR-0024)。
//!
//! M-文字コード変換 (`encoding`) と M-CSV ビューア (`csvview`) が使う。置換文字で黙って
//! 壊さないため、encoding_rs の `_without_replacement` 系だけを使い、不正なバイトは位置を
//! 付けて呼び出し側へ返す。文字コードは閉じた enum で受け取り、`Encoding::for_label` は
//! 使わない (未知のラベルが REPLACEMENT 符号化に解決されるのを避ける)。

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::ops::Range;
use std::path::Path;

use encoding_rs::{
    Decoder, DecoderResult, Encoding, EUC_JP, ISO_2022_JP, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;

/// 読み込み・復号・符号化を区切る単位。区切りごとに取消しを確かめる (ADR-0009)。
pub(crate) const CHUNK_SIZE: usize = 1024 * 1024;
/// 位置を返す問題の件数の上限。件数そのものは最後まで数える。
pub(crate) const MAX_ISSUES: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    ShiftJis,
    EucJp,
    Iso2022Jp,
}

impl TextEncoding {
    pub(crate) fn encoding(self) -> &'static Encoding {
        match self {
            Self::Utf8 => UTF_8,
            Self::Utf16Le => UTF_16LE,
            Self::Utf16Be => UTF_16BE,
            Self::ShiftJis => SHIFT_JIS,
            Self::EucJp => EUC_JP,
            Self::Iso2022Jp => ISO_2022_JP,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf16Le => "UTF-16LE",
            Self::Utf16Be => "UTF-16BE",
            Self::ShiftJis => "Shift_JIS",
            Self::EucJp => "EUC-JP",
            Self::Iso2022Jp => "ISO-2022-JP",
        }
    }

    fn from_bom_encoding(encoding: &'static Encoding) -> Option<Self> {
        if encoding == UTF_8 {
            Some(Self::Utf8)
        } else if encoding == UTF_16LE {
            Some(Self::Utf16Le)
        } else if encoding == UTF_16BE {
            Some(Self::Utf16Be)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceEncoding {
    Auto,
    Utf8,
    Utf16Le,
    Utf16Be,
    ShiftJis,
    EucJp,
    Iso2022Jp,
}

impl SourceEncoding {
    fn explicit(self) -> Option<TextEncoding> {
        match self {
            Self::Auto => None,
            Self::Utf8 => Some(TextEncoding::Utf8),
            Self::Utf16Le => Some(TextEncoding::Utf16Le),
            Self::Utf16Be => Some(TextEncoding::Utf16Be),
            Self::ShiftJis => Some(TextEncoding::ShiftJis),
            Self::EucJp => Some(TextEncoding::EucJp),
            Self::Iso2022Jp => Some(TextEncoding::Iso2022Jp),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    /// BOM で決まった
    Bom,
    /// ASCII だけ、ISO-2022-JP のエスケープ、正しい UTF-8 のいずれかで決まった
    Exact,
    /// Shift_JIS / EUC-JP として読めたものから推定した
    Guess,
    /// どの候補でも読めなかった
    None,
}

/// 変換元として読めないバイト列。`offset` はファイル先頭からのバイト位置 (0 始まり)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ByteIssue {
    pub offset: u64,
    pub line: u64,
    /// 16 進表記 (例: `"82 FF"`)
    pub bytes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Candidate {
    pub encoding: TextEncoding,
    pub ok: bool,
    pub malformed_count: u64,
    pub first_error: Option<ByteIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Detection {
    pub encoding: Option<TextEncoding>,
    pub confidence: Confidence,
    /// すべて ASCII で、UTF-8 として扱った
    pub ascii_only: bool,
    /// Shift_JIS / EUC-JP を試したときの各候補の結果。BOM などで決まったときは空
    pub candidates: Vec<Candidate>,
}

/// 文字コードを確定させた結果。`encoding` が None なら判定できなかった。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Resolution {
    pub encoding: Option<TextEncoding>,
    /// 先頭の BOM のバイト数 (無ければ 0)
    pub bom_len: usize,
    pub bom: Option<TextEncoding>,
    /// 自動判定したときだけ Some
    pub detection: Option<Detection>,
}

/// モジュール ID・取消し・エラーをまとめて受け渡す。
pub(crate) struct Ctx<'a> {
    pub module_id: &'static str,
    pub token: &'a CancellationToken,
    pub operation_id: &'a str,
}

impl Ctx<'_> {
    pub(crate) fn check(&self) -> Result<(), AppError> {
        if self.token.is_cancelled() {
            Err(AppError::Cancelled {
                operation_id: self.operation_id.to_string(),
            })
        } else {
            Ok(())
        }
    }

    pub(crate) fn invalid(&self, reason: impl Into<String>) -> AppError {
        AppError::Validation {
            module_id: self.module_id.into(),
            reason: reason.into(),
        }
    }
}

/// ファイルを `max_bytes` まで 1 MiB ずつ読む。読んでいる間に大きくなった場合も上限で止める。
pub(crate) fn read_file(path: &Path, max_bytes: u64, ctx: &Ctx<'_>) -> Result<Vec<u8>, AppError> {
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::Io(format!("{} を確認できません: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(ctx.invalid("ファイルを指定してください。"));
    }
    let too_large = || {
        ctx.invalid(format!(
            "ファイルが {} を超えています。",
            format_mib(max_bytes)
        ))
    };
    if metadata.len() > max_bytes {
        return Err(too_large());
    }
    let file = File::open(path)
        .map_err(|error| AppError::Io(format!("{} を開けません: {error}", path.display())))?;
    let mut reader = BufReader::with_capacity(CHUNK_SIZE, file);
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    let mut chunk = vec![0_u8; CHUNK_SIZE];
    loop {
        ctx.check()?;
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        if bytes.len().saturating_add(read) as u64 > max_bytes {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok(bytes)
}

fn format_mib(bytes: u64) -> String {
    format!("{} MiB", bytes / (1024 * 1024))
}

pub(crate) fn bom_of(bytes: &[u8]) -> Option<(TextEncoding, usize)> {
    let (encoding, len) = Encoding::for_bom(bytes)?;
    Some((TextEncoding::from_bom_encoding(encoding)?, len))
}

/// 変換元を確定させる。自動なら判定し、手動の指定が BOM と食い違えば拒否する。
pub(crate) fn resolve(
    bytes: &[u8],
    source: SourceEncoding,
    ctx: &Ctx<'_>,
) -> Result<Resolution, AppError> {
    let bom = bom_of(bytes);
    let bom_len = bom.map_or(0, |(_, len)| len);
    let bom_encoding = bom.map(|(encoding, _)| encoding);
    match source.explicit() {
        Some(encoding) => {
            if let Some(found) = bom_encoding {
                if found != encoding {
                    return Err(ctx.invalid(format!(
                        "ファイルの先頭に {} の BOM があります。変換元は {} を選んでください。",
                        found.label(),
                        found.label()
                    )));
                }
            }
            Ok(Resolution {
                encoding: Some(encoding),
                bom_len,
                bom: bom_encoding,
                detection: None,
            })
        }
        None => {
            let detection = detect(bytes, ctx)?;
            Ok(Resolution {
                encoding: detection.encoding,
                bom_len,
                bom: bom_encoding,
                detection: Some(detection),
            })
        }
    }
}

/// 判定の順番 (ADR-0024):
/// 1. BOM があれば確定
/// 2. BOM の無い NUL を含めば拒否 (バイナリか、BOM の無い UTF-16)
/// 3. すべて ASCII なら ISO-2022-JP のエスケープを探し、無ければ ASCII (UTF-8 として扱う)
/// 4. 正しい UTF-8 なら UTF-8
/// 5. Shift_JIS と EUC-JP を厳密に復号し、片方だけ読めればそれ、両方読めれば点数で選ぶ
/// 6. どれでも読めなければ判定できない
pub(crate) fn detect(bytes: &[u8], ctx: &Ctx<'_>) -> Result<Detection, AppError> {
    let exact = |encoding, ascii_only| Detection {
        encoding: Some(encoding),
        confidence: Confidence::Exact,
        ascii_only,
        candidates: Vec::new(),
    };
    if let Some((encoding, _)) = bom_of(bytes) {
        return Ok(Detection {
            encoding: Some(encoding),
            confidence: Confidence::Bom,
            ascii_only: false,
            candidates: Vec::new(),
        });
    }
    if bytes.contains(&0) {
        return Err(ctx.invalid(
            "NUL (0x00) を含むため、テキストとして判定できません。バイナリか、BOM の無い UTF-16 の可能性があります。UTF-16 なら変換元を手動で選んでください。",
        ));
    }
    if bytes.is_ascii() {
        if has_iso_2022_jp_escape(bytes) {
            return Ok(exact(TextEncoding::Iso2022Jp, false));
        }
        return Ok(exact(TextEncoding::Utf8, true));
    }
    if std::str::from_utf8(bytes).is_ok() {
        return Ok(exact(TextEncoding::Utf8, false));
    }

    let mut candidates = Vec::new();
    let mut scores = Vec::new();
    for encoding in [TextEncoding::ShiftJis, TextEncoding::EucJp] {
        let mut decoder = StreamDecoder::new(bytes, encoding, 0);
        let mut score: i64 = 0;
        while let Some((piece, _)) = decoder.next_piece() {
            ctx.check()?;
            score += japanese_score(&piece);
        }
        let ok = decoder.malformed_count == 0;
        if ok {
            scores.push((encoding, score));
        }
        candidates.push(Candidate {
            encoding,
            ok,
            malformed_count: decoder.malformed_count,
            first_error: decoder.malformed.into_iter().next(),
        });
    }
    // 同点なら Shift_JIS (先に入れた方) を選ぶ
    let chosen = scores
        .iter()
        .fold(
            None::<(TextEncoding, i64)>,
            |best, &(encoding, score)| match best {
                Some((_, best_score)) if best_score >= score => best,
                _ => Some((encoding, score)),
            },
        )
        .map(|(encoding, _)| encoding);
    Ok(Detection {
        encoding: chosen,
        confidence: if chosen.is_some() {
            Confidence::Guess
        } else {
            Confidence::None
        },
        ascii_only: false,
        candidates,
    })
}

fn has_iso_2022_jp_escape(bytes: &[u8]) -> bool {
    const ESCAPES: [&[u8]; 4] = [b"\x1b$B", b"\x1b$@", b"\x1b(J", b"\x1b(I"];
    bytes.windows(3).any(|window| ESCAPES.contains(&window))
}

/// Shift_JIS と EUC-JP の両方で読めたときの点数。かな・漢字を加点し、
/// 半角カナと私用領域 (外字) を減点する。
fn japanese_score(text: &str) -> i64 {
    text.chars()
        .map(|ch| match ch {
            '\u{3041}'..='\u{3096}' | '\u{30A1}'..='\u{30FA}' | '\u{4E00}'..='\u{9FFF}' => 1,
            '\u{FF61}'..='\u{FF9F}' => -2,
            '\u{E000}'..='\u{F8FF}' => -4,
            _ => 0,
        })
        .sum()
}

/// 復号した全文と、読めなかったバイト。
#[derive(Debug)]
pub(crate) struct Decoded {
    pub text: String,
    pub malformed_count: u64,
    pub malformed: Vec<ByteIssue>,
}

/// `start` (BOM の後ろ) から最後まで厳密に復号する。
pub(crate) fn decode_all(
    bytes: &[u8],
    encoding: TextEncoding,
    start: usize,
    max_text_bytes: usize,
    ctx: &Ctx<'_>,
) -> Result<Decoded, AppError> {
    let mut decoder = StreamDecoder::new(bytes, encoding, start);
    let mut text = String::new();
    while let Some((piece, _)) = decoder.next_piece() {
        ctx.check()?;
        if text.len().saturating_add(piece.len()) > max_text_bytes {
            return Err(ctx.invalid(format!(
                "復号した文字列が {} を超えています。",
                format_mib(max_text_bytes as u64)
            )));
        }
        text.push_str(&piece);
    }
    Ok(Decoded {
        text,
        malformed_count: decoder.malformed_count,
        malformed: decoder.malformed,
    })
}

/// 1 MiB ずつ厳密に復号する。読めないバイトは数えて飛ばし、先頭 20 件の位置を残す。
pub(crate) struct StreamDecoder<'a> {
    bytes: &'a [u8],
    decoder: Decoder,
    consumed: usize,
    finished: bool,
    lines: LineTracker,
    pub malformed_count: u64,
    pub malformed: Vec<ByteIssue>,
}

impl<'a> StreamDecoder<'a> {
    pub(crate) fn new(bytes: &'a [u8], encoding: TextEncoding, start: usize) -> Self {
        Self {
            bytes,
            decoder: encoding.encoding().new_decoder_without_bom_handling(),
            consumed: start.min(bytes.len()),
            finished: false,
            lines: LineTracker::default(),
            malformed_count: 0,
            malformed: Vec::new(),
        }
    }

    /// 次の区切りを復号し、文字列と元のバイト範囲を返す。最後まで済んでいれば None。
    pub(crate) fn next_piece(&mut self) -> Option<(String, Range<usize>)> {
        if self.finished {
            return None;
        }
        let begin = self.consumed;
        let end = begin.saturating_add(CHUNK_SIZE).min(self.bytes.len());
        let last = end == self.bytes.len();
        let mut src = &self.bytes[begin..end];
        let mut piece = String::new();
        loop {
            let reserve = self
                .decoder
                .max_utf8_buffer_length_without_replacement(src.len())
                .unwrap_or(src.len().saturating_mul(3).saturating_add(16));
            piece.reserve(reserve);
            let (result, read) = self
                .decoder
                .decode_to_string_without_replacement(src, &mut piece, last);
            self.consumed += read;
            src = &src[read..];
            match result {
                DecoderResult::InputEmpty => break,
                DecoderResult::OutputFull => {}
                DecoderResult::Malformed(len, after) => {
                    let len = usize::from(len);
                    let offset = self
                        .consumed
                        .saturating_sub(usize::from(after))
                        .saturating_sub(len);
                    self.lines.advance(&piece, piece.len());
                    self.record(offset, len);
                }
            }
        }
        self.lines.advance(&piece, piece.len());
        self.lines.end_piece();
        self.finished = last;
        Some((piece, begin..end))
    }

    fn record(&mut self, offset: usize, len: usize) {
        self.malformed_count += 1;
        if self.malformed.len() < MAX_ISSUES {
            let end = offset.saturating_add(len).min(self.bytes.len());
            let bytes = self.bytes[offset.min(end)..end]
                .iter()
                .map(|byte| format!("{byte:02X}"))
                .collect::<Vec<_>>()
                .join(" ");
            self.malformed.push(ByteIssue {
                offset: offset as u64,
                line: self.lines.line,
                bytes,
            });
        }
    }
}

/// 区切りごとの文字列を順に読み、行と桁 (どちらも 1 始まり、桁はコードポイント単位) を追う。
/// CRLF・単独の CR・LF をそれぞれ 1 つの改行として数える。
#[derive(Debug, Clone)]
pub(crate) struct LineTracker {
    pub line: u64,
    pub column: u64,
    index: usize,
    prev_cr: bool,
}

impl Default for LineTracker {
    fn default() -> Self {
        Self {
            line: 1,
            column: 1,
            index: 0,
            prev_cr: false,
        }
    }
}

impl LineTracker {
    /// `piece` の `to` バイト目の直前まで進める。`to` は文字の境界であること。
    pub(crate) fn advance(&mut self, piece: &str, to: usize) {
        if to <= self.index {
            return;
        }
        for ch in piece[self.index..to].chars() {
            match ch {
                '\r' => {
                    self.line += 1;
                    self.column = 1;
                    self.prev_cr = true;
                    continue;
                }
                '\n' if self.prev_cr => {}
                '\n' => {
                    self.line += 1;
                    self.column = 1;
                }
                _ => self.column += 1,
            }
            self.prev_cr = false;
        }
        self.index = to;
    }

    /// 次の区切りの先頭から数え直す (行と桁は続きから)。
    pub(crate) fn end_piece(&mut self) {
        self.index = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(token: &CancellationToken) -> Ctx<'_> {
        Ctx {
            module_id: "encoding",
            token,
            operation_id: "op",
        }
    }

    /// 全体を復号し、文字列と読めなかったバイトを返す。
    fn decode(bytes: &[u8], encoding: TextEncoding) -> (String, StreamDecoder<'_>) {
        let mut decoder = StreamDecoder::new(bytes, encoding, 0);
        let mut text = String::new();
        while let Some((piece, _)) = decoder.next_piece() {
            text.push_str(&piece);
        }
        (text, decoder)
    }

    fn detect_bytes(bytes: &[u8]) -> Result<Detection, AppError> {
        let token = CancellationToken::new();
        detect(bytes, &ctx(&token))
    }

    #[test]
    fn detects_bom() {
        for (bytes, expected) in [
            (&b"\xEF\xBB\xBFabc"[..], TextEncoding::Utf8),
            (&b"\xFF\xFEa\0"[..], TextEncoding::Utf16Le),
            (&b"\xFE\xFF\0a"[..], TextEncoding::Utf16Be),
        ] {
            let detection = detect_bytes(bytes).unwrap();
            assert_eq!(detection.encoding, Some(expected));
            assert_eq!(detection.confidence, Confidence::Bom);
        }
    }

    #[test]
    fn rejects_nul_without_bom() {
        assert!(matches!(
            detect_bytes(b"a\0b\0"),
            Err(AppError::Validation { .. })
        ));
    }

    #[test]
    fn detects_ascii_and_iso_2022_jp() {
        let ascii = detect_bytes(b"hello\r\n").unwrap();
        assert_eq!(ascii.encoding, Some(TextEncoding::Utf8));
        assert!(ascii.ascii_only);
        assert_eq!(ascii.confidence, Confidence::Exact);

        let (jis, _, _) = ISO_2022_JP.encode("こんにちは");
        let detection = detect_bytes(&jis).unwrap();
        assert_eq!(detection.encoding, Some(TextEncoding::Iso2022Jp));
        assert!(!detection.ascii_only);
    }

    #[test]
    fn detects_utf8() {
        let detection = detect_bytes("日本語".as_bytes()).unwrap();
        assert_eq!(detection.encoding, Some(TextEncoding::Utf8));
        assert_eq!(detection.confidence, Confidence::Exact);
    }

    #[test]
    fn guesses_shift_jis_and_euc_jp() {
        let text = "日本語のテキストです。半角ｶﾅも少し。";
        let (sjis, _, _) = SHIFT_JIS.encode(text);
        let detection = detect_bytes(&sjis).unwrap();
        assert_eq!(detection.encoding, Some(TextEncoding::ShiftJis));
        assert_eq!(detection.confidence, Confidence::Guess);
        assert_eq!(detection.candidates.len(), 2);

        let (euc, _, _) = EUC_JP.encode(text);
        let detection = detect_bytes(&euc).unwrap();
        assert_eq!(detection.encoding, Some(TextEncoding::EucJp));
        assert_eq!(detection.confidence, Confidence::Guess);
    }

    #[test]
    fn prefers_euc_jp_when_shift_jis_reads_it_as_half_width_kana() {
        // EUC-JP のかなは Shift_JIS では半角カナの並びとしても読める
        let (euc, _, _) = EUC_JP.encode("あいうえお");
        let detection = detect_bytes(&euc).unwrap();
        assert!(detection.candidates.iter().all(|candidate| candidate.ok));
        assert_eq!(detection.encoding, Some(TextEncoding::EucJp));
    }

    #[test]
    fn reports_undetectable_bytes_with_candidates() {
        let detection = detect_bytes(b"\x81\x20\x8F\xFF").unwrap();
        assert_eq!(detection.encoding, None);
        assert_eq!(detection.confidence, Confidence::None);
        assert!(detection.candidates.iter().all(|candidate| !candidate.ok));
        assert!(detection.candidates[0].first_error.is_some());
    }

    #[test]
    fn resolve_rejects_source_conflicting_with_bom() {
        let token = CancellationToken::new();
        let error =
            resolve(b"\xEF\xBB\xBFabc", SourceEncoding::ShiftJis, &ctx(&token)).unwrap_err();
        assert!(matches!(error, AppError::Validation { .. }));
        let resolution = resolve(b"\xEF\xBB\xBFabc", SourceEncoding::Utf8, &ctx(&token)).unwrap();
        assert_eq!(resolution.bom_len, 3);
        assert_eq!(resolution.encoding, Some(TextEncoding::Utf8));
    }

    #[test]
    fn decoder_reports_malformed_bytes_with_offsets_and_lines() {
        let mut bytes = SHIFT_JIS.encode("一行目\r\n二行目\n").0.into_owned();
        bytes.extend_from_slice(b"ab\x82\xFFc");
        let (text, decoder) = decode(&bytes, TextEncoding::ShiftJis);
        assert_eq!(decoder.malformed_count, 1);
        let issue = &decoder.malformed[0];
        assert_eq!(issue.line, 3);
        assert_eq!(issue.offset, bytes.len() as u64 - 3);
        assert!(issue.bytes.starts_with("82"));
        assert!(text.starts_with("一行目\r\n二行目\nab"));
    }

    #[test]
    fn decoder_handles_multibyte_characters_across_chunks() {
        let mut source = "a".repeat(CHUNK_SIZE - 1);
        source.push_str("あい");
        let (sjis, _, _) = SHIFT_JIS.encode(&source);
        let (text, decoder) = decode(&sjis, TextEncoding::ShiftJis);
        assert_eq!(decoder.malformed_count, 0);
        assert_eq!(text, source);
    }

    #[test]
    fn decoder_skips_the_bom_and_returns_byte_ranges() {
        let bytes = b"\xEF\xBB\xBFabc";
        let mut decoder = StreamDecoder::new(bytes, TextEncoding::Utf8, 3);
        assert_eq!(decoder.next_piece(), Some(("abc".to_string(), 3..6)));
        assert_eq!(decoder.next_piece(), None);
        // 空の本文でも 1 回は区切りを返す
        let mut decoder = StreamDecoder::new(bytes, TextEncoding::Utf8, 6);
        assert_eq!(decoder.next_piece(), Some((String::new(), 6..6)));
        assert_eq!(decoder.next_piece(), None);
    }

    #[test]
    fn detection_stops_when_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        let (sjis, _, _) = SHIFT_JIS.encode("日本語");
        let error = detect(&sjis, &ctx(&token)).unwrap_err();
        assert!(matches!(error, AppError::Cancelled { .. }));
    }

    #[test]
    fn decode_all_returns_the_text_and_malformed_bytes() {
        let token = CancellationToken::new();
        let decoded = decode_all(
            b"\xEF\xBB\xBFa\x80b",
            TextEncoding::Utf8,
            3,
            usize::MAX,
            &ctx(&token),
        )
        .unwrap();
        assert_eq!(decoded.text, "ab");
        assert_eq!(decoded.malformed_count, 1);
        assert_eq!(decoded.malformed[0].offset, 4);
    }

    #[test]
    fn decode_all_stops_at_the_text_limit() {
        let token = CancellationToken::new();
        let error = decode_all(b"abcdef", TextEncoding::Utf8, 0, 3, &ctx(&token)).unwrap_err();
        assert!(matches!(error, AppError::Validation { .. }));
    }

    #[test]
    fn decode_all_stops_when_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        let error =
            decode_all(b"abc", TextEncoding::Utf8, 0, usize::MAX, &ctx(&token)).unwrap_err();
        assert!(matches!(error, AppError::Cancelled { .. }));
    }

    #[test]
    fn line_tracker_counts_crlf_cr_and_lf_once_each() {
        let mut tracker = LineTracker::default();
        let piece = "a\r\nb\rc\nd";
        tracker.advance(piece, piece.len());
        assert_eq!((tracker.line, tracker.column), (4, 2));

        // 区切りをまたぐ CRLF も 1 つ
        let mut tracker = LineTracker::default();
        tracker.advance("x\r", 2);
        tracker.end_piece();
        tracker.advance("\ny", 2);
        assert_eq!((tracker.line, tracker.column), (2, 2));
    }
}
