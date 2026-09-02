//! NativeAOT sidecarとフロントChannelの公開契約。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NrbfNode {
    pub id: u32,
    pub parent_id: Option<u32>,
    pub display_name: String,
    pub raw_name: String,
    pub kind: String,
    pub type_name: Option<String>,
    pub assembly_name: Option<String>,
    pub formatted_value: Option<String>,
    pub record_id: Option<String>,
    pub reference_target_id: Option<u32>,
    pub shape: Option<Vec<i32>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NrbfSummary {
    pub path: String,
    pub file_name: String,
    pub file_size_bytes: u64,
    pub root_type: Option<String>,
    pub node_count: u32,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarResponse {
    pub ok: bool,
    pub nodes: Vec<NrbfNode>,
    pub summary: Option<NrbfSummary>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum NrbfProgress {
    Started { file_size_bytes: u64 },
    Nodes { nodes: Vec<NrbfNode> },
    Done { summary: NrbfSummary },
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_response_uses_camel_case_contract() {
        let response: SidecarResponse = serde_json::from_value(serde_json::json!({
            "ok": true,
            "nodes": [{
                "id": 1, "parentId": null, "displayName": "$", "rawName": "$",
                "kind": "scalar", "typeName": "System.String", "assemblyName": null,
                "formattedValue": "値", "recordId": "1", "referenceTargetId": null,
                "shape": null
            }],
            "summary": {
                "path": "/tmp/a.bin", "fileName": "a.bin", "fileSizeBytes": 32,
                "rootType": "System.String", "nodeCount": 1, "warnings": [], "durationMs": 2
            },
            "error": null
        }))
        .unwrap();
        assert!(response.ok);
        assert_eq!(response.nodes[0].formatted_value.as_deref(), Some("値"));
        assert_eq!(response.summary.unwrap().file_size_bytes, 32);
    }

    #[test]
    fn progress_serializes_as_discriminated_union() {
        let value = serde_json::to_value(NrbfProgress::Started {
            file_size_bytes: 64,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "type": "started", "fileSizeBytes": 64 })
        );
    }
}
