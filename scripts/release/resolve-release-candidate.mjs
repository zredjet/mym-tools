import { appendFileSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_CI_CHECKS = [
  "lint-rust",
  "test-rust",
  "lint-frontend",
  "test-frontend",
  "build-tauri (macos-latest)",
  "build-tauri (windows-latest)",
];

export const CANDIDATE_ARTIFACT_NAMES = {
  macos: "release-candidate-macos",
  windows: "release-candidate-windows",
};

function fallback(reason) {
  return { reuseCandidate: false, reason };
}

function actionRunId(detailsUrl) {
  const match = String(detailsUrl ?? "").match(/\/actions\/runs\/(\d+)(?:\/|$)/);
  return match?.[1];
}

export function selectMergedPullRequest(pullRequests, releaseSha) {
  const matches = pullRequests.filter(
    (pullRequest) =>
      pullRequest.merged_at &&
      pullRequest.base?.ref === "main" &&
      pullRequest.merge_commit_sha === releaseSha,
  );
  if (matches.length !== 1) {
    return fallback(
      `tag commitに対応するmain向けmerged PRが1件ではありません: ${matches.length}件`,
    );
  }
  return { reuseCandidate: true, pullRequest: matches[0] };
}

export function selectRequiredCheckRun(checkRuns) {
  const selected = [];
  for (const checkName of REQUIRED_CI_CHECKS) {
    const matches = checkRuns.filter(
      (checkRun) => checkRun.name === checkName && checkRun.app?.slug === "github-actions",
    );
    if (matches.length !== 1) {
      return fallback(`required check ${checkName}が1件ではありません: ${matches.length}件`);
    }
    const [checkRun] = matches;
    if (checkRun.status !== "completed" || checkRun.conclusion !== "success") {
      return fallback(`required check ${checkName}が成功していません`);
    }
    const runId = actionRunId(checkRun.details_url);
    if (!runId) {
      return fallback(`required check ${checkName}からworkflow run IDを取得できません`);
    }
    selected.push({ ...checkRun, actionRunId: runId });
  }

  const runIds = new Set(selected.map((checkRun) => checkRun.actionRunId));
  const suiteIds = new Set(selected.map((checkRun) => checkRun.check_suite?.id));
  if (runIds.size !== 1 || suiteIds.size !== 1 || suiteIds.has(undefined)) {
    return fallback("required checkが同一workflow run / check suiteに属していません");
  }

  return { reuseCandidate: true, runId: selected[0].actionRunId };
}

export function selectCandidateArtifacts(artifacts, runId) {
  const selected = {};
  for (const [platform, artifactName] of Object.entries(CANDIDATE_ARTIFACT_NAMES)) {
    const matches = artifacts.filter(
      (artifact) => artifact.name === artifactName && String(artifact.workflow_run?.id) === runId,
    );
    if (matches.length !== 1) {
      return fallback(`artifact ${artifactName}が1件ではありません: ${matches.length}件`);
    }
    const [artifact] = matches;
    if (artifact.expired || Number(artifact.size_in_bytes) < 1) {
      return fallback(`artifact ${artifactName}が期限切れまたは空です`);
    }
    selected[platform] = artifact;
  }
  return { reuseCandidate: true, artifacts: selected };
}

export function selectCandidateMetadata({
  releaseSha,
  pullRequests,
  checkRuns,
  workflowRun,
  artifacts,
}) {
  const pullRequestSelection = selectMergedPullRequest(pullRequests, releaseSha);
  if (!pullRequestSelection.reuseCandidate) return pullRequestSelection;
  const { pullRequest } = pullRequestSelection;

  const checkSelection = selectRequiredCheckRun(checkRuns);
  if (!checkSelection.reuseCandidate) return checkSelection;
  const { runId } = checkSelection;

  if (
    String(workflowRun.id) !== runId ||
    workflowRun.name !== "CI (ref: ADR-0010)" ||
    workflowRun.path !== ".github/workflows/ci.yml" ||
    workflowRun.event !== "pull_request" ||
    workflowRun.status !== "completed" ||
    workflowRun.conclusion !== "success" ||
    workflowRun.head_sha !== pullRequest.head?.sha
  ) {
    return fallback("required checkのworkflow runが対象PRの成功したCI runではありません");
  }
  if (!Number.isSafeInteger(workflowRun.run_attempt) || workflowRun.run_attempt < 1) {
    return fallback("workflow run attemptが不正です");
  }

  const artifactSelection = selectCandidateArtifacts(artifacts, runId);
  if (!artifactSelection.reuseCandidate) return artifactSelection;

  return {
    reuseCandidate: true,
    reason: "対象PRのrequired CI成果物を再利用します",
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.head.sha,
    runId,
    runAttempt: workflowRun.run_attempt,
    macosArtifactId: artifactSelection.artifacts.macos.id,
    windowsArtifactId: artifactSelection.artifacts.windows.id,
  };
}

async function githubApi(fetchImpl, repository, token, path) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status}`);
  }
  return response.json();
}

export async function resolveReleaseCandidate({
  repository,
  releaseSha,
  token,
  fetchImpl = fetch,
}) {
  try {
    const pullRequests = await githubApi(
      fetchImpl,
      repository,
      token,
      `commits/${releaseSha}/pulls?per_page=100`,
    );
    const pullRequestSelection = selectMergedPullRequest(pullRequests, releaseSha);
    if (!pullRequestSelection.reuseCandidate) return pullRequestSelection;
    const pullRequest = pullRequestSelection.pullRequest;

    const checksResponse = await githubApi(
      fetchImpl,
      repository,
      token,
      `commits/${pullRequest.head.sha}/check-runs?filter=latest&per_page=100`,
    );
    const checkSelection = selectRequiredCheckRun(checksResponse.check_runs ?? []);
    if (!checkSelection.reuseCandidate) return checkSelection;

    const workflowRun = await githubApi(
      fetchImpl,
      repository,
      token,
      `actions/runs/${checkSelection.runId}`,
    );
    const artifactResponse = await githubApi(
      fetchImpl,
      repository,
      token,
      `actions/runs/${checkSelection.runId}/artifacts?per_page=100`,
    );

    return selectCandidateMetadata({
      releaseSha,
      pullRequests,
      checkRuns: checksResponse.check_runs ?? [],
      workflowRun,
      artifacts: artifactResponse.artifacts ?? [],
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return fallback(`candidate解決中にGitHub APIを利用できませんでした: ${details}`);
  }
}

function printGithubOutputs(result, outputPath) {
  const outputs = [
    `reuse_candidate=${result.reuseCandidate}`,
    `candidate_reason=${String(result.reason).replace(/[\r\n]/g, " ")}`,
  ];
  if (result.reuseCandidate) {
    outputs.push(
      `candidate_pr_number=${result.pullRequestNumber}`,
      `candidate_head_sha=${result.headSha}`,
      `candidate_run_id=${result.runId}`,
      `candidate_run_attempt=${result.runAttempt}`,
      `macos_artifact_id=${result.macosArtifactId}`,
      `windows_artifact_id=${result.windowsArtifactId}`,
    );
  }
  const text = `${outputs.join("\n")}\n`;
  if (outputPath) appendFileSync(outputPath, text, "utf8");
  process.stdout.write(text);
}

async function runCli(argv) {
  const [releaseSha] = argv;
  if (!releaseSha) throw new Error("release commit SHAは必須です");
  const result = await resolveReleaseCandidate({
    repository: process.env.GITHUB_REPOSITORY,
    releaseSha,
    token: process.env.GITHUB_TOKEN,
  });
  printGithubOutputs(result, process.env.GITHUB_OUTPUT);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
