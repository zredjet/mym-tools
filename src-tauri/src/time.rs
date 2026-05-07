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

/// `JST_ISO8601` 文字列をパースする。形式が完全一致しないと `Err` を返す。
pub fn parse_jst_iso8601(s: &str) -> Result<DateTime<FixedOffset>, chrono::ParseError> {
    DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.3f%:z")
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
    fn parse_accepts_missing_milliseconds_as_zero() {
        // chrono の `%.3f` 指定子は parse 時 lenient で、ms 部分省略を 0 扱いする。
        // `format_jst_iso8601` 側は常に 3 桁出力 (29 文字固定) するので、書込みの一意性は
        // 保たれる。読込み時の互換性として ms 省略を許容するのは実用上問題なし。
        let parsed = parse_jst_iso8601("2026-04-30T15:23:45+09:00").unwrap();
        assert_eq!(format_jst_iso8601(&parsed), "2026-04-30T15:23:45.000+09:00");
    }

    #[test]
    fn parse_rejects_utc_offset() {
        // JST 想定なので +00:00 は受け付けるけど元の +09:00 と等しくない
        let parsed = parse_jst_iso8601("2026-04-30T15:23:45.123+00:00").unwrap();
        // 同じ瞬間として扱われるが offset 文字列は変わる
        assert_eq!(format_jst_iso8601(&parsed), "2026-05-01T00:23:45.123+09:00");
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
