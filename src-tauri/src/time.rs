//! JST タイムスタンプヘルパ (ADR-0005 / `data-model.md` §6.4)。
//!
//! 不変条件 (CLAUDE.md):
//! - **すべての時刻は JST 固定** (`Asia/Tokyo`, +09:00)
//! - **アプリ側で生成する** (SQLite の `CURRENT_TIMESTAMP` は禁止 / UTC 生成のため)
//! - 形式は ISO8601 拡張: `YYYY-MM-DDTHH:MM:SS.sss+09:00` (固定 29 文字)
//! - 文字列のまま辞書順ソート可能
//!
//! 用語 (`data-model.md` §13.7 改訂済):
//! - `JST_ISO8601`: DB / JSON 用 (`+09:00` 付き、29 文字)
//! - `JST_FILENAME_TIMESTAMP`: バックアップファイル名用 (`:` を `-` に、TZ オフセット省略)

use chrono::{DateTime, FixedOffset, Utc};

#[cfg(test)]
use chrono::{NaiveDateTime, TimeZone};

/// JST (Asia/Tokyo, +09:00) のオフセット。
pub fn jst_offset() -> FixedOffset {
    FixedOffset::east_opt(9 * 3600).expect("9*3600 is a valid FixedOffset")
}

/// 現在時刻を JST_ISO8601 形式 (29 文字) で返す。
///
/// 例: `2026-04-30T15:23:45.123+09:00`
pub fn now_jst_iso8601() -> String {
    let now: DateTime<FixedOffset> = Utc::now().with_timezone(&jst_offset());
    format_jst_iso8601(&now)
}

/// `DateTime<FixedOffset>` を JST_ISO8601 形式 (29 文字) で返す。
/// `tz` がたまたま JST でない場合でも、内部で JST に変換してから整形する。
pub fn format_jst_iso8601(dt: &DateTime<FixedOffset>) -> String {
    let in_jst = dt.with_timezone(&jst_offset());
    // chrono の format spec: 4桁年-月-日T時:分:秒.ミリ秒+09:00
    in_jst.format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string()
}

/// 現在時刻を JST_FILENAME_TIMESTAMP 形式で返す。
///
/// `JST_ISO8601` の `:` を `-` に置換し TZ オフセットを省略した、ファイル名で安全な形:
///   `YYYY-MM-DDTHH-MM-SS-sss` (23 文字)。バックアップファイル名等で使う (ADR-0007 §13)。
///
/// 例: `2026-04-30T15-23-45-123`
pub fn now_jst_filename_timestamp() -> String {
    let now: DateTime<FixedOffset> = Utc::now().with_timezone(&jst_offset());
    format_jst_filename_timestamp(&now)
}

/// `DateTime<FixedOffset>` を JST_FILENAME_TIMESTAMP 形式で返す。
pub fn format_jst_filename_timestamp(dt: &DateTime<FixedOffset>) -> String {
    let in_jst = dt.with_timezone(&jst_offset());
    in_jst.format("%Y-%m-%dT%H-%M-%S-%3f").to_string()
}

/// `JST_ISO8601` 形式 (固定 29 文字 / `+09:00` 終端) のパースエラー。
#[derive(Debug, thiserror::Error)]
pub enum ParseJstError {
    #[error("invalid length: expected 29 chars (canonical JST_ISO8601), got {actual}")]
    InvalidLength { actual: usize },

    #[error("non-JST offset: input must end with '+09:00', got: {input:?}")]
    NonJstOffset { input: String },

    #[error("chrono parse failed: {0}")]
    Chrono(#[from] chrono::ParseError),
}

/// `JST_ISO8601` 文字列を **strict** にパースする。
///
/// canonical 形式 (固定 29 文字、`YYYY-MM-DDTHH:MM:SS.sss+09:00`) のみを受理し、以下を拒否する:
/// - 文字数が 29 でない (例: ms 部分省略 → 25 文字)
/// - 末尾が `+09:00` でない (例: `+00:00` を受け取って黙って JST に変換するのを防ぐ)
///
/// `data-model.md` §6.4 / ADR-0005 の「**JST 固定 29 文字**」前提を gate として実装している
/// 入力検証の役割を果たす。DB から読んだ値や export/import で外部から来た値の妥当性確認に使う。
pub fn parse_jst_iso8601(s: &str) -> Result<DateTime<FixedOffset>, ParseJstError> {
    if s.len() != 29 {
        return Err(ParseJstError::InvalidLength { actual: s.len() });
    }
    if !s.ends_with("+09:00") {
        return Err(ParseJstError::NonJstOffset {
            input: s.to_string(),
        });
    }
    let dt = DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.3f%:z")?;
    Ok(dt)
}

/// テスト・デバッグ用: 任意の Y/M/D/h/m/s/ms (JST 想定) から `JST_ISO8601` を作る。
#[cfg(test)]
fn build_jst(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, ms: u32) -> DateTime<FixedOffset> {
    let naive = NaiveDateTime::new(
        chrono::NaiveDate::from_ymd_opt(y, mo, d).unwrap(),
        chrono::NaiveTime::from_hms_milli_opt(h, mi, s, ms).unwrap(),
    );
    jst_offset()
        .from_local_datetime(&naive)
        .single()
        .expect("local datetime should be unambiguous in fixed-offset JST")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_jst_iso8601_is_29_chars() {
        let s = now_jst_iso8601();
        // 29 文字: YYYY-MM-DDTHH:MM:SS.sss+09:00
        assert_eq!(s.len(), 29, "got: {s}");
        assert!(s.ends_with("+09:00"), "got: {s}");
        assert_eq!(&s[10..11], "T");
    }

    #[test]
    fn format_specific_jst_yields_expected_string() {
        let dt = build_jst(2026, 4, 30, 15, 23, 45, 123);
        assert_eq!(format_jst_iso8601(&dt), "2026-04-30T15:23:45.123+09:00");
    }

    #[test]
    fn format_zero_milliseconds_still_three_digits() {
        let dt = build_jst(2026, 1, 1, 0, 0, 0, 0);
        assert_eq!(format_jst_iso8601(&dt), "2026-01-01T00:00:00.000+09:00");
    }

    #[test]
    fn lexicographic_order_matches_chronological() {
        let earlier = format_jst_iso8601(&build_jst(2026, 4, 30, 15, 23, 45, 123));
        let later = format_jst_iso8601(&build_jst(2026, 4, 30, 15, 23, 45, 124));
        assert!(earlier < later, "{earlier} < {later}");
        let across_day_earlier = format_jst_iso8601(&build_jst(2026, 4, 30, 23, 59, 59, 999));
        let across_day_later = format_jst_iso8601(&build_jst(2026, 5, 1, 0, 0, 0, 0));
        assert!(
            across_day_earlier < across_day_later,
            "{across_day_earlier} < {across_day_later}"
        );
    }

    #[test]
    fn parse_round_trip() {
        let original = "2026-04-30T15:23:45.123+09:00";
        let parsed = parse_jst_iso8601(original).unwrap();
        assert_eq!(format_jst_iso8601(&parsed), original);
    }

    #[test]
    fn parse_rejects_missing_milliseconds() {
        // 25 文字 (ms 省略) → InvalidLength
        let err = parse_jst_iso8601("2026-04-30T15:23:45+09:00").unwrap_err();
        match err {
            ParseJstError::InvalidLength { actual } => assert_eq!(actual, 25),
            other => panic!("expected InvalidLength, got: {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_utc_offset() {
        // 29 文字だが末尾 +00:00 → NonJstOffset (黙って JST 変換しない)
        let err = parse_jst_iso8601("2026-04-30T15:23:45.123+00:00").unwrap_err();
        match err {
            ParseJstError::NonJstOffset { input } => {
                assert!(input.ends_with("+00:00"));
            }
            other => panic!("expected NonJstOffset, got: {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_too_long_string() {
        let err = parse_jst_iso8601("2026-04-30T15:23:45.123+09:00 trailing").unwrap_err();
        assert!(matches!(err, ParseJstError::InvalidLength { .. }));
    }

    #[test]
    fn parse_rejects_non_iso8601_garbage_with_correct_length() {
        // 29 文字で末尾 +09:00 だが、形式自体は壊れている
        let bogus = "2026-13-99T99:99:99.999+09:00"; // 29 chars, ends with +09:00, invalid date
        assert_eq!(bogus.len(), 29);
        assert!(bogus.ends_with("+09:00"));
        let err = parse_jst_iso8601(bogus).unwrap_err();
        assert!(matches!(err, ParseJstError::Chrono(_)));
    }

    #[test]
    fn filename_timestamp_no_colons() {
        let dt = build_jst(2026, 4, 30, 15, 23, 45, 123);
        let s = format_jst_filename_timestamp(&dt);
        assert_eq!(s, "2026-04-30T15-23-45-123");
        assert!(!s.contains(':'));
    }

    #[test]
    fn now_filename_timestamp_no_colons() {
        let s = now_jst_filename_timestamp();
        assert!(!s.contains(':'));
        assert_eq!(s.len(), 23);
    }
}
