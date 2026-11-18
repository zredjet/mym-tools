//! payload v3 の契約 (`model/fixtures/payload-v3.json`、`model/limits.json`) と、v2 → v3 の変換、
//! 版が 3 のときの `upgrade_payload` / `validate_payload` の経路 (`docs/canvas-editor-design.md` §3)。

use super::scene::{search_text, validate, validate_v3, LIMITS};
use super::testing::{
    contract, resolve, valid_payload, vector_backend_at, VectorModuleAt, CURRENT,
};
use super::upgrade::{upgrade_v1, upgrade_v2};
use super::{validate_as, VectorModule};
use crate::module::{ModuleBackend, ModuleError};
use serde_json::{json, Value};

fn reason(result: Result<(), ModuleError>) -> String {
    match result {
        Err(ModuleError::ValidationFailed { reason }) => reason,
        other => panic!("expected ValidationFailed, got {other:?}"),
    }
}

fn cases(section: &str) -> &'static Vec<Value> {
    contract(3)[section].as_array().unwrap()
}

#[test]
fn limits_json_has_the_v3_limits() {
    // §3.5 の表の値
    assert_eq!(LIMITS.max_subpaths, 1000);
    assert_eq!(LIMITS.max_path_points, 10_000);
    assert_eq!(LIMITS.max_total_path_points, 100_000);
    assert_eq!(LIMITS.max_dash_count, 8);
    assert_eq!(LIMITS.max_dash_length, 10_000.0);
    let raw: Value = serde_json::from_str(include_str!(
        "../../../../src/modules/vector/editor/model/limits.json"
    ))
    .unwrap();
    // TypeScript も同じ値を読む。整数で書いてある (小数の表記にしない)
    for key in [
        "maxSubpaths",
        "maxPathPoints",
        "maxTotalPathPoints",
        "maxDashCount",
        "maxDashLength",
    ] {
        assert!(raw[key].is_u64(), "{key}");
    }
}

#[test]
fn contract_valid_cases_pass() {
    let valid = cases("valid");
    assert_eq!(valid.len(), 7, "契約データの valid が変わった");
    for case in valid {
        assert!(case["reason"].is_string(), "{}", case["name"]);
        let payload = resolve(contract(3), case);
        validate_v3(&payload).unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
        assert_eq!(search_text(&payload), payload["text"], "{}", case["name"]);
    }
}

#[test]
fn contract_valid_large_cases_reach_the_limits() {
    let points = |payload: &Value| -> Vec<usize> {
        payload["nodes"]
            .as_object()
            .unwrap()
            .values()
            .map(|node| {
                node["subpaths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|subpath| subpath["points"].as_array().unwrap().len())
                    .sum()
            })
            .collect()
    };
    let subpaths = valid_payload(3, "max-subpaths");
    assert_eq!(
        subpaths["nodes"]["p1"]["subpaths"]
            .as_array()
            .unwrap()
            .len(),
        LIMITS.max_subpaths
    );
    let per_path = points(&valid_payload(3, "max-path-points"));
    assert_eq!(per_path.iter().max(), Some(&LIMITS.max_path_points));
    let total = points(&valid_payload(3, "max-total-path-points"));
    assert_eq!(total.iter().sum::<usize>(), LIMITS.max_total_path_points);
    assert!(total.iter().all(|n| *n <= LIMITS.max_path_points));
}

/// 各 invalid が、reason に書いた規則で落ちる (別の規則で偶然落ちていない) ことを、拒否の理由で確かめる。
#[test]
fn contract_invalid_cases_fail_for_the_documented_reason() {
    let expected = [
        // §3 の規則 (payload-v2.json の invalid と同じ例。理由も v2 の検証と同じ)
        ("pages-empty", "ページは"),
        ("page-id-duplicate", "重複"),
        ("child-referenced-twice", "2 か所以上"),
        ("orphan-node", "参照されていません"),
        ("child-missing", "存在しないノード"),
        ("node-key-mismatch", "キーと一致しません"),
        ("unknown-node-type", "の type は"),
        ("unknown-field", "未知のフィールド skew"),
        ("missing-field", "radius がありません"),
        ("bad-id", "ノードの ID"),
        ("bad-color", "#RRGGBB"),
        ("opacity-out-of-range", "opacity"),
        ("negative-size", "width"),
        ("coordinate-out-of-range", " x は"),
        ("number-as-string", "数値"),
        ("group-empty", "1 個以上"),
        ("gradient-one-stop", "stops"),
        ("gradient-stops-unsorted", "昇順"),
        ("font-weight-invalid", "fontWeight"),
        ("text-sizing-invalid", "sizing"),
        ("asset-missing", "存在しないアセット"),
        ("asset-unreferenced", "参照されていません"),
        ("image-asset-size-zero", "width は 0 より大きく"),
        ("svg-asset-size-zero", "height は 0 より大きく"),
        ("asset-kind-mismatch", "別の種類"),
        ("image-data-mime-mismatch", "画像の形式と内容"),
        ("svg-asset-policy-violation", "未対応のSVG要素"),
        ("svg-asset-raw-nel", "U+0085"),
        (
            "svg-asset-control-character-reference",
            "使えない文字の参照",
        ),
        ("svg-asset-text-mismatch", "SVGと一致しません"),
        ("text-mismatch", "文書と一致しません"),
        ("guide-axis-invalid", "axis"),
        ("top-level-unknown-field", "未知のフィールド version"),
        // §3.5 の規則
        (
            "rotation-above-max",
            "rect1」の rotation は -180 以上 180 以下",
        ),
        (
            "rotation-below-min",
            "text1」の rotation は -180 以上 180 以下",
        ),
        ("rotation-not-number", "rect1」の rotation は数値"),
        ("rotation-missing", "frame1」に rotation がありません"),
        (
            "rotation-missing-on-path",
            "path1」に rotation がありません",
        ),
        ("rotation-on-line", "line1」に未知のフィールド rotation"),
        ("rotation-on-group", "group1」に未知のフィールド rotation"),
        ("rotation-on-boolean", "bool1」に未知のフィールド rotation"),
        ("stroke-v2-shape", "rect1」の stroke に cap がありません"),
        (
            "stroke-dash-missing",
            "line1」の stroke に dash がありません",
        ),
        ("stroke-cap-invalid", "の cap は butt / round / square"),
        ("stroke-join-invalid", "の join は miter / round / bevel"),
        ("dash-too-many", "の dash は 8 個以下"),
        ("dash-negative", "の dash は 0 以上 10000 以下の数値の配列"),
        ("dash-too-long", "の dash は 0 以上 10000 以下の数値の配列"),
        ("dash-all-zero", "の dash は空か、合計が 0 より大きい配列"),
        (
            "dash-not-number",
            "の dash は 0 以上 10000 以下の数値の配列",
        ),
        ("dash-null", "path1」の stroke の dash は配列"),
        (
            "stroke-unknown-field",
            "bool1」の stroke に未知のフィールド miterLimit",
        ),
        ("path-subpaths-empty", "path1」の subpaths は 1〜1000 個"),
        ("path-subpaths-too-many", "p1」の subpaths は 1〜1000 個"),
        ("path-points-empty", "path1」の輪郭 2の points は 1 個以上"),
        ("path-points-too-many", "p1」の点は合計 10000 個以下"),
        (
            "path-total-points-too-many",
            "文書のパスの点は合計 100000 個以下",
        ),
        ("path-point-coordinate", "輪郭 1の点 1の x は"),
        ("path-handle-coordinate", "輪郭 1の点 2の in の y は"),
        (
            "path-handle-missing-component",
            "輪郭 1の点 2の out に y がありません",
        ),
        (
            "path-handle-not-object",
            "輪郭 1の点 1の in はオブジェクトにしてください",
        ),
        (
            "path-point-missing-handle",
            "輪郭 1の点 1に in がありません",
        ),
        (
            "path-point-unknown-field",
            "輪郭 1の点 1に未知のフィールド corner",
        ),
        (
            "path-mirror-invalid",
            "の mirror は none / angle / angle-length",
        ),
        ("path-closed-not-boolean", "輪郭 1の closed は真偽値"),
        ("path-fill-rule-invalid", "の fillRule は nonzero / evenodd"),
        ("path-width-negative", "path1」の width は"),
        ("path-height-too-large", "path1」の height は"),
        ("path-radius-unknown", "path1」に未知のフィールド radius"),
        (
            "boolean-op-invalid",
            "の op は union / subtract / intersect / exclude",
        ),
        ("boolean-op-missing", "bool1」に op がありません"),
        ("boolean-children-empty", "bool1」の children は 1 個以上"),
        (
            "boolean-child-line",
            "の子「line1」は rect / ellipse / path / boolean",
        ),
        (
            "boolean-child-text",
            "の子「text1」は rect / ellipse / path / boolean",
        ),
        (
            "boolean-child-group",
            "の子「group1」は rect / ellipse / path / boolean",
        ),
        (
            "boolean-child-frame",
            "の子「brect」は rect / ellipse / path / boolean",
        ),
        ("boolean-child-referenced-twice", "brect」が 2 か所以上"),
        ("boolean-box-unknown", "bool1」に未知のフィールド x"),
        ("unknown-node-type-star", "path1」の type は"),
        ("subpath-closed-missing", "輪郭 1に closed がありません"),
        ("subpath-unknown-field", "輪郭 1に未知のフィールド fill"),
        (
            "path-handle-unknown-field",
            "輪郭 1の点 2の in に未知のフィールド z",
        ),
        ("path-point-y-out-of-range", "輪郭 1の点 1の y は"),
        ("path-point-not-number", "輪郭 1の点 1の x は数値"),
        ("path-subpaths-not-array", "path1」の subpaths は配列"),
        ("path-stroke-missing", "path1」に stroke がありません"),
        ("boolean-shadow-missing", "bool1」に shadow がありません"),
        (
            "boolean-child-image",
            "の子「image1」は rect / ellipse / path / boolean",
        ),
        (
            "boolean-child-svg",
            "の子「svg1」は rect / ellipse / path / boolean",
        ),
    ];
    let invalid = cases("invalid");
    assert_eq!(
        invalid.len(),
        expected.len(),
        "契約データの invalid が変わった"
    );
    for (case, (name, needle)) in invalid.iter().zip(expected) {
        assert_eq!(case["name"], name, "契約データの invalid の順");
        assert!(case["reason"].is_string(), "{name}");
        let payload = resolve(contract(3), case);
        let reason = reason(validate_v3(&payload));
        assert!(reason.contains(needle), "{name}: {reason}");
    }
}

#[test]
fn contract_upgrade_cases() {
    let upgrade = cases("upgrade");
    assert_eq!(upgrade.len(), 8, "契約データの upgrade が変わった");
    // 版が 3 なら本物の VectorModule、2 の間は VectorModuleAt(3)
    let module = vector_backend_at(3);
    for case in upgrade {
        let name = &case["name"];
        assert!(case["reason"].is_string(), "{name}");
        let from = case["from"].as_u64().unwrap() as u32;
        assert!(from == 1 || from == 2, "{name}");
        // ストレージと同じく段ごとに upgrade_payload を呼ぶ
        let mut payload = case["input"].clone();
        for version in from..3 {
            payload = module
                .upgrade_payload(version, payload)
                .unwrap_or_else(|e| panic!("{name}: {e}"));
        }
        assert_eq!(payload, case["v3"], "{name}");
        validate_v3(&payload).unwrap_or_else(|e| panic!("{name}: {e}"));
        module.validate_payload(&payload).unwrap();
        // 検索用テキストは変わらない
        assert_eq!(search_text(&payload), payload["text"], "{name}");
        // 入力だけで決まる
        let again = (from..3).fold(case["input"].clone(), |payload, version| {
            module.upgrade_payload(version, payload).unwrap()
        });
        assert_eq!(
            serde_json::to_string(&again).unwrap(),
            serde_json::to_string(&payload).unwrap()
        );
    }
}

/// from が 1 の例は、v2 の契約データの同じ名前の例の v2 を v2 → v3 したもの。
#[test]
fn v1_cases_agree_with_the_v2_contract() {
    let v2_cases = contract(2)["upgrade"].as_array().unwrap();
    let v1_cases: Vec<_> = cases("upgrade")
        .iter()
        .filter(|case| case["from"] == 1)
        .collect();
    assert_eq!(v1_cases.len(), v2_cases.len());
    for (v3_case, v2_case) in v1_cases.iter().zip(v2_cases) {
        assert_eq!(v3_case["name"], v2_case["name"]);
        assert_eq!(v3_case["input"], v2_case["v1"]);
        let v2 = upgrade_v1(&v2_case["v1"]).unwrap();
        assert_eq!(v2, v2_case["v2"]);
        assert_eq!(upgrade_v2(&v2).unwrap(), v3_case["v3"]);
    }
}

#[test]
fn v2_to_v3_adds_only_rotation_and_stroke_defaults() {
    for case in cases("upgrade").iter().filter(|case| case["from"] == 2) {
        let input = &case["input"];
        let output = upgrade_v2(input).unwrap();
        // 足したものを消すと入力に戻る
        let mut stripped = output.clone();
        for node in stripped["nodes"].as_object_mut().unwrap().values_mut() {
            let node = node.as_object_mut().unwrap();
            let kind = node["type"].as_str().unwrap().to_string();
            let rotated = matches!(
                kind.as_str(),
                "frame" | "rect" | "ellipse" | "text" | "image" | "svg"
            );
            assert_eq!(node.get("rotation"), rotated.then_some(&json!(0)), "{kind}");
            node.remove("rotation");
            if let Some(stroke) = node.get_mut("stroke").and_then(Value::as_object_mut) {
                assert_eq!(stroke.remove("cap"), Some(json!("butt")));
                assert_eq!(stroke.remove("join"), Some(json!("miter")));
                assert_eq!(stroke.remove("dash"), Some(json!([])));
            }
        }
        assert_eq!(&stripped, input, "{}", case["name"]);
        // rotation は整数の 0 (serde_json は 0 と 0.0 を別の値として比べる)
        let text = serde_json::to_string(&output).unwrap();
        assert!(!text.contains("\"rotation\":0.0"));
    }
}

#[test]
fn every_v2_contract_document_upgrades() {
    for case in contract(2)["valid"].as_array().unwrap() {
        let v3 = upgrade_v2(&case["payload"]).unwrap();
        validate_v3(&v3).unwrap();
        assert_eq!(v3["text"], case["payload"]["text"]);
    }
}

/// 壊れた v2 (v2 の検証を通らないもの) は変換を失敗にし、v2 のまま残す (§3.9)。v3 の形を先取りした
/// 行 (rotation を持つ v2) も、v3 として通してしまわない。
#[test]
fn broken_v2_is_an_upgrade_error() {
    let full = valid_payload(2, "full");
    let mut with_rotation = full.clone();
    with_rotation["nodes"]["rect1"]["rotation"] = json!(45);
    let mut wrong_text = full.clone();
    wrong_text["text"] = json!("forged");
    let mut v3_stroke = full.clone();
    v3_stroke["nodes"]["rect1"]["stroke"]["cap"] = json!("round");
    for (payload, needle) in [
        (with_rotation, "未知のフィールド rotation"),
        (wrong_text, "文書と一致しません"),
        (v3_stroke, "未知のフィールド cap"),
        (json!({ "svg": "<svg/>", "text": "" }), "pages がありません"),
        (json!(null), "オブジェクト"),
        (valid_payload(3, "full"), "type は"),
    ] {
        let Err(ModuleError::UpgradeFailed { reason }) = upgrade_v2(&payload) else {
            panic!("expected UpgradeFailed for {needle}");
        };
        assert!(
            reason.starts_with("v2 の文書が検証を通りません"),
            "{reason}"
        );
        assert!(reason.contains(needle), "{reason}");
    }
}

#[test]
fn v3_rejects_v2_shaped_documents_and_v2_rejects_v3_documents() {
    // empty は両方の版で同じ形
    validate(&valid_payload(2, "empty")).unwrap();
    validate_v3(&valid_payload(3, "empty")).unwrap();
    assert!(reason(validate_v3(&valid_payload(2, "full"))).contains("rotation がありません"));
    for name in ["full", "boundaries", "eleven-paths"] {
        assert!(validate(&valid_payload(3, name)).is_err(), "{name}");
    }
    // v2 の type の一覧に path / boolean は無い
    let mut v2 = valid_payload(2, "full");
    v2["nodes"]["rect1"]["type"] = json!("path");
    assert!(reason(validate(&v2)).contains("line / text / image / svg のいずれか"));
}

#[test]
fn search_text_goes_into_booleans_like_groups() {
    // ブーリアンの子は文字を持てないので、拾う文字は変わらない。たどる順だけを確かめる
    let mut payload = valid_payload(3, "full");
    payload["nodes"]["bool1"]["children"] = json!(["brect", "bellipse", "bpath", "bbool"]);
    assert_eq!(search_text(&payload), payload["text"]);
    // 子に text を入れた (検証は通らない) 文書でも、group と同じく子をたどって拾う
    payload["nodes"]["group1"]["children"] = json!(["line1"]);
    payload["nodes"]["bool1"]["children"] = json!(["brect", "text1"]);
    assert_eq!(
        search_text(&payload),
        "ホーム画面 旧作品 バナー 見出し テキスト 2 行目"
    );
}

#[test]
fn version_routes() {
    // 版が 2: v1 → v2 だけ。v2 → v3 は呼ばない
    let at2 = VectorModuleAt(2);
    assert!(matches!(
        at2.upgrade_payload(2, valid_payload(2, "full")),
        Err(ModuleError::UnknownPayloadVersion(2))
    ));
    at2.validate_payload(&valid_payload(2, "full")).unwrap();
    assert!(at2.validate_payload(&valid_payload(3, "full")).is_err());

    // 版が 3: v1 → v2 (v2 の検証) → v3 (v3 の検証)
    let at3 = vector_backend_at(3);
    let v1 = &cases("upgrade")[0]["input"];
    let v2 = at3.upgrade_payload(1, v1.clone()).unwrap();
    validate(&v2).unwrap();
    assert!(validate_v3(&v2).is_err());
    let v3 = at3.upgrade_payload(2, v2).unwrap();
    at3.validate_payload(&v3).unwrap();
    assert!(at3.validate_payload(&valid_payload(2, "full")).is_err());
    for from in [0, 3, 4] {
        assert!(matches!(
            at3.upgrade_payload(from, json!({})),
            Err(ModuleError::UnknownPayloadVersion(n)) if n == from
        ));
    }
    assert!(matches!(
        validate_as(4, &json!({})),
        Err(ModuleError::UnknownPayloadVersion(4))
    ));

    // 本物のモジュールは版の定数どおり
    assert_eq!(VectorModule.current_payload_version(), CURRENT);
    VectorModule
        .validate_payload(&valid_payload(CURRENT, "full"))
        .unwrap();
}
