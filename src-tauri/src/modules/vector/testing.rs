//! テスト用の道具。vector の版に依存するテスト (ストレージ、バックアップ、エクスポート) が、版の定数
//! (`CURRENT_PAYLOAD_VERSION`) から期待値と契約データを選べるようにする (§3.9 の「契約データ」)。
//! 定数が 2 でも 3 でも同じテストが通るように書き、C1 は定数を変えるだけにする。
//!
//! `VectorModuleAt(n)` は、版の定数が `n` のときの `VectorModule` と同じ振る舞いをする。版が 2 の間も、
//! 版が 3 のときの経路 (v1 → v2 → v3、v2 → v3、`pre-payload-vector-v3`) を確かめるのに使う。

use super::{index_text, upgrade_from, validate_as, CURRENT_PAYLOAD_VERSION};
use crate::module::{ModuleBackend, ModuleError};
use serde_json::Value;
use std::sync::{Arc, LazyLock};

/// 今の版 (`VectorModule::current_payload_version` と同じ)。
pub(crate) const CURRENT: u32 = CURRENT_PAYLOAD_VERSION;

/// 今の版と v3 (重なれば 1 つ)。版が 3 のときの経路を、定数が 2 の間も確かめるテストが回す。
pub(crate) fn versions() -> Vec<u32> {
    let mut versions = vec![CURRENT, 3];
    versions.dedup();
    versions
}

/// 版の定数が `.0` のときの `VectorModule`。
pub(crate) struct VectorModuleAt(pub u32);
impl ModuleBackend for VectorModuleAt {
    fn id(&self) -> &'static str {
        "vector"
    }
    fn search_preview_field(&self) -> Option<&'static str> {
        Some("text")
    }
    fn current_payload_version(&self) -> u32 {
        self.0
    }
    fn upgrade_payload(&self, from_version: u32, payload: Value) -> Result<Value, ModuleError> {
        upgrade_from(self.0, from_version, &payload)
    }
    fn validate_payload(&self, payload: &Value) -> Result<(), ModuleError> {
        validate_as(self.0, payload)
    }
    fn index_text(&self, payload: &Value) -> String {
        index_text(payload)
    }
}

/// 版 `version` の vector のモジュール。今の版なら本物の `VectorModule`、ほかの版なら `VectorModuleAt`。
/// 今の版のテストが写しではなく本物を通るようにする。
pub(crate) fn vector_backend_at(version: u32) -> Arc<dyn ModuleBackend> {
    if version == CURRENT {
        Arc::new(super::VectorModule)
    } else {
        Arc::new(VectorModuleAt(version))
    }
}

/// 版 `version` のモジュールの一覧。今の版なら `registry::module_backends()` そのもの、ほかの版なら
/// vector だけを `VectorModuleAt(version)` に差し替えたもの。
pub(crate) fn module_backends_at(version: u32) -> Vec<Arc<dyn ModuleBackend>> {
    let modules = crate::modules::registry::module_backends();
    if version == CURRENT {
        return modules;
    }
    modules
        .into_iter()
        .map(|module| {
            if module.id() == "vector" {
                vector_backend_at(version)
            } else {
                module
            }
        })
        .collect()
}

/// 起動時のバックアップの接頭辞 (ADR-0027 の規則 1)。
pub(crate) fn pre_payload_prefix(version: u32) -> String {
    format!("pre-payload-vector-v{version}")
}

static CONTRACT_V2: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../src/modules/vector/editor/model/fixtures/payload-v2.json"
    ))
    .expect("checked-in canvas contract v2")
});

static CONTRACT_V3: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../src/modules/vector/editor/model/fixtures/payload-v3.json"
    ))
    .expect("checked-in canvas contract v3")
});

/// 版 `version` の契約データ (`payload-v2.json` / `payload-v3.json`)。
pub(crate) fn contract(version: u32) -> &'static Value {
    match version {
        2 => &CONTRACT_V2,
        3 => &CONTRACT_V3,
        other => panic!("no canvas contract for v{other}"),
    }
}

fn find<'a>(contract: &'a Value, section: &str, name: &str) -> &'a Value {
    contract[section]
        .as_array()
        .unwrap_or_else(|| panic!("contract section {section}"))
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("{section} case {name}"))
}

/// 版 `version` の契約データの valid の文書 (`base` と `patch` で書いたものは当てた結果)。
pub(crate) fn valid_payload(version: u32, name: &str) -> Value {
    resolve(contract(version), find(contract(version), "valid", name))
}

/// valid / invalid の 1 件を文書にする。`payload` があればそれ、なければ `base` (valid の名前) の文書に
/// `patch` を順に当てる。
pub(crate) fn resolve(contract: &Value, case: &Value) -> Value {
    if let Some(payload) = case.get("payload") {
        return payload.clone();
    }
    let base = case["base"].as_str().expect("case.base");
    let mut payload = resolve(contract, find(contract, "valid", base));
    for patch in case["patch"].as_array().expect("case.patch") {
        apply(&mut payload, patch);
    }
    payload
}

/// v1 の作品を版 `version` まで変換する例: (v1 の payload、変換の結果)。v2 の契約データは
/// `{ v1, v2 }`、v3 は `{ from: 1, input, v3 }`。名前は両方の契約データで同じ。
pub(crate) fn v1_upgrade_case(version: u32, name: &str) -> (Value, Value) {
    let case = find(contract(version), "upgrade", name);
    match version {
        2 => (case["v1"].clone(), case["v2"].clone()),
        3 => {
            assert_eq!(case["from"], 1, "{name}");
            (case["input"].clone(), case["v3"].clone())
        }
        other => panic!("no canvas contract for v{other}"),
    }
}

/// 両方の契約データにある v1 → 今の版の例の名前。
pub(crate) const V1_UPGRADE_CASES: [&str; 5] = [
    "svgedit-document",
    "size-from-viewbox",
    "size-fallback",
    "text-renormalized",
    "stale-v1-text",
];

/// `module` の今の版まで、`from` の payload を段ごとに変換する (ストレージと同じ呼び方)。
pub(crate) fn upgrade_to_current(module: &dyn ModuleBackend, from: u32, payload: Value) -> Value {
    (from..module.current_payload_version()).fold(payload, |payload, version| {
        module
            .upgrade_payload(version, payload)
            .unwrap_or_else(|e| panic!("upgrade v{version}: {e}"))
    })
}

/// 契約データの patch を当てる。op は set (path の位置へ value を置く) / remove (path の位置を消す) /
/// append (path の配列の末尾へ value を足す) / repeat (path の位置へ value を count 個並べた配列を置く)。
/// path は文字列 (キー) と整数 (添字)。
pub(crate) fn apply(target: &mut Value, patch: &Value) {
    let path = patch["path"].as_array().expect("patch.path");
    let (last, parents) = path.split_last().expect("non-empty path");
    let mut parent = &mut *target;
    for step in parents {
        parent = match step {
            Value::String(key) => parent.get_mut(key.as_str()),
            Value::Number(index) => parent.get_mut(index.as_u64().unwrap() as usize),
            _ => panic!("bad path step {step}"),
        }
        .unwrap_or_else(|| panic!("missing path {path:?}"));
    }
    let value = match patch["op"].as_str().expect("patch.op") {
        "set" => patch["value"].clone(),
        "repeat" => {
            let count = patch["count"].as_u64().expect("patch.count") as usize;
            Value::Array(vec![patch["value"].clone(); count])
        }
        "remove" => {
            match last {
                Value::String(key) => {
                    parent.as_object_mut().unwrap().remove(key).unwrap();
                }
                Value::Number(index) => {
                    parent
                        .as_array_mut()
                        .unwrap()
                        .remove(index.as_u64().unwrap() as usize);
                }
                _ => panic!("bad path step {last}"),
            }
            return;
        }
        "append" => {
            let array = match last {
                Value::String(key) => parent.get_mut(key.as_str()),
                Value::Number(index) => parent.get_mut(index.as_u64().unwrap() as usize),
                _ => None,
            };
            array
                .and_then(Value::as_array_mut)
                .unwrap_or_else(|| panic!("append target {path:?}"))
                .push(patch["value"].clone());
            return;
        }
        op => panic!("unknown op {op}"),
    };
    match last {
        Value::String(key) => {
            parent.as_object_mut().unwrap().insert(key.clone(), value);
        }
        Value::Number(index) => {
            parent[index.as_u64().unwrap() as usize] = value;
        }
        _ => panic!("bad path step {last}"),
    }
}
