use crate::module::ModuleBackend;
pub struct CharCountModule;
impl ModuleBackend for CharCountModule {
    fn id(&self) -> &'static str {
        "charcount"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}

/// フロントの Shift_JIS バイト数表 (`src/modules/charcount/sjisTable.json`) が
/// encoding_rs の Shift_JIS encoder と一致することを確かめる。
///
/// 表を作り直すときは `MYM_REGENERATE_SJIS_TABLE=1 cargo test sjis_table` で書き出す。
#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use encoding_rs::{EncoderResult, SHIFT_JIS};
    use serde::{Deserialize, Serialize};

    const TABLE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/modules/charcount/sjisTable.json"
    );
    const TABLE_JSON: &str = include_str!("../../../../src/modules/charcount/sjisTable.json");

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SjisTable {
        description: String,
        double_byte_bitmap: String,
    }

    /// BMP の 1 文字を Shift_JIS にしたときのバイト数。表せなければ None。
    fn encoded_len(ch: char) -> Option<usize> {
        let mut encoder = SHIFT_JIS.new_encoder();
        let mut source = String::new();
        source.push(ch);
        let mut buffer = [0u8; 8];
        let (result, _, written) =
            encoder.encode_from_utf8_without_replacement(&source, &mut buffer, true);
        match result {
            EncoderResult::InputEmpty => Some(written),
            _ => None,
        }
    }

    fn bmp_chars() -> impl Iterator<Item = char> {
        (0u32..=0xFFFF).filter_map(char::from_u32)
    }

    fn build_bitmap() -> Vec<u8> {
        let mut bitmap = vec![0u8; 0x10000 / 8];
        for ch in bmp_chars() {
            if encoded_len(ch) == Some(2) {
                let code = ch as usize;
                bitmap[code >> 3] |= 1 << (code & 7);
            }
        }
        bitmap
    }

    #[test]
    fn sjis_table_matches_encoding_rs() {
        let bitmap = build_bitmap();
        if std::env::var_os("MYM_REGENERATE_SJIS_TABLE").is_some() {
            let table = SjisTable {
                description: "encoding_rs の SHIFT_JIS encoder で 2 バイトになる BMP 文字のビットマップ (base64、U+n は byte n>>3 の bit n&7)。1 バイトの文字は charCount.ts の規則で判定する。src-tauri/src/modules/charcount/mod.rs のテストで検査・再生成する".into(),
                double_byte_bitmap: STANDARD.encode(&bitmap),
            };
            let json = serde_json::to_string_pretty(&table).unwrap() + "\n";
            std::fs::write(TABLE_PATH, json).unwrap();
            return;
        }
        let table: SjisTable = serde_json::from_str(TABLE_JSON).unwrap();
        let committed = STANDARD.decode(table.double_byte_bitmap).unwrap();
        assert!(
            committed == bitmap,
            "sjisTable.json が encoding_rs と一致しません。MYM_REGENERATE_SJIS_TABLE=1 で作り直してください"
        );
    }

    /// 1 バイトになる文字は charCount.ts の `isSjisSingleByte` と同じ規則で決まる。
    #[test]
    fn sjis_single_byte_rule_matches_encoding_rs() {
        let rule = |code: u32| {
            code <= 0x80 || code == 0xA5 || code == 0x203E || (0xFF61..=0xFF9F).contains(&code)
        };
        for ch in bmp_chars() {
            assert_eq!(
                encoded_len(ch) == Some(1),
                rule(ch as u32),
                "U+{:04X}",
                ch as u32
            );
        }
    }

    #[test]
    fn non_bmp_chars_are_not_encodable() {
        assert_eq!(encoded_len('😀'), None);
        assert_eq!(encoded_len('𠮷'), None);
    }
}
