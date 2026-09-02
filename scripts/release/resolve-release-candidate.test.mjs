import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

import {
  CANDIDATE_ARTIFACT_NAMES,
  REQUIRED_CI_CHECKS,
  selectCandidateMetadata,
} from "./resolve-release-candidate.mjs";

const RELEASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const RUN_ID = "12345";

function fixture() {
  const pullRequests = [
    {
      number: 82,
      merged_at: "2026-09-01T00:00:00Z",
      merge_commit_sha: RELEASE_SHA,
      base: { ref: "main" },
      head: { sha: HEAD_SHA },
    },
  ];
  const checkRuns = REQUIRED_CI_CHECKS.map((name, index) => ({
    id: index + 1,
    name,
    status: "completed",
    conclusion: "success",
    details_url: `https://github.com/zredjet/mym-tools/actions/runs/${RUN_ID}/job/${index + 10}`,
    app: { slug: "github-actions" },
    check_suite: { id: 777 },
  }));
  const workflowRun = {
    id: Number(RUN_ID),
    name: "CI (ref: ADR-0010)",
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: HEAD_SHA,
    run_attempt: 2,
  };
  const artifacts = Object.values(CANDIDATE_ARTIFACT_NAMES).map((name, index) => ({
    id: 900 + index,
    name,
    expired: false,
    size_in_bytes: 100,
    workflow_run: { id: Number(RUN_ID) },
  }));
  return { releaseSha: RELEASE_SHA, pullRequests, checkRuns, workflowRun, artifacts };
}

describe("selectCandidateMetadata", () => {
  it("branch protection用のbuild-tauri check名を固定する", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("name: build-tauri (${{ matrix.os }})");
  });

  it("同じrequired CI runの2成果物だけを選ぶ", () => {
    expect(selectCandidateMetadata(fixture())).toEqual({
      reuseCandidate: true,
      reason: "対象PRのrequired CI成果物を再利用します",
      pullRequestNumber: 82,
      headSha: HEAD_SHA,
      runId: RUN_ID,
      runAttempt: 2,
      macosArtifactId: 900,
      windowsArtifactId: 901,
    });
  });

  it("tag commitに対応するmerged PRが一意でない場合はfallbackする", () => {
    const input = fixture();
    input.pullRequests.push({ ...input.pullRequests[0], number: 83 });

    expect(selectCandidateMetadata(input)).toMatchObject({
      reuseCandidate: false,
      reason: expect.stringContaining("1件ではありません"),
    });
  });

  it("required check失敗時はfallbackする", () => {
    const input = fixture();
    input.checkRuns[0].conclusion = "failure";

    expect(selectCandidateMetadata(input)).toMatchObject({
      reuseCandidate: false,
      reason: expect.stringContaining("成功していません"),
    });
  });

  it("required checkが複数runに分かれている場合はfallbackする", () => {
    const input = fixture();
    input.checkRuns[0].details_url =
      "https://github.com/zredjet/mym-tools/actions/runs/99999/job/10";

    expect(selectCandidateMetadata(input)).toMatchObject({
      reuseCandidate: false,
      reason: expect.stringContaining("同一workflow run"),
    });
  });

  it("artifactが期限切れならfallbackする", () => {
    const input = fixture();
    input.artifacts[0].expired = true;

    expect(selectCandidateMetadata(input)).toMatchObject({
      reuseCandidate: false,
      reason: expect.stringContaining("期限切れ"),
    });
  });

  it("artifactが別runに属する場合はfallbackする", () => {
    const input = fixture();
    input.artifacts[0].workflow_run.id = 99999;

    expect(selectCandidateMetadata(input)).toMatchObject({
      reuseCandidate: false,
      reason: expect.stringContaining("1件ではありません"),
    });
  });

  it("run attemptが不正ならfallbackする", () => {
    const input = fixture();
    input.workflowRun.run_attempt = 0;

    expect(selectCandidateMetadata(input)).toMatchObject({
      reuseCandidate: false,
      reason: expect.stringContaining("attempt"),
    });
  });
});
