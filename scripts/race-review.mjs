// Race accessibility review — GitHub Action entry point.
//
// Triggered by a `/race` comment on an issue or PR. It reuses the extension's review
// engine (lib/reviewer.js heuristic + lib/ai-reviewer.js Copilot/OpenAI-compatible LLM),
// reviews the issue text against the WCAG dataset, and posts the result back as a comment
// via the GitHub REST API.
//
// Required environment (provided by the workflow):
//   GITHUB_TOKEN       - token with issues:write / pull-requests:write (and models:read
//                        when using GitHub Models for the LLM). Used to post the comment.
//   GITHUB_EVENT_PATH  - path to the issue_comment event payload (set by Actions).
//   GITHUB_REPOSITORY  - "owner/repo" (set by Actions).
// Optional:
//   MODEL_ENDPOINT     - OpenAI-compatible chat/completions URL.
//                        Defaults to GitHub Models (https://models.github.ai/inference/chat/completions).
//   MODEL_NAME         - model id (default "openai/gpt-4o").
//   MODEL_TOKEN        - credential for the model endpoint (defaults to GITHUB_TOKEN so
//                        GitHub Models works with no extra secret).
//   SHARED_DATASET_URL - fetch the shared/central dataset instead of the bundled copy.
//   DISABLE_AI         - set to "1"/"true" to force the offline heuristic only.

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { reviewIssue, reviewerInternals } from "../lib/reviewer.js";
import { reviewIssueWithAI, DEFAULT_AI_CONFIG } from "../lib/ai-reviewer.js";

const COMMAND = "/race";
const GITHUB_MODELS_ENDPOINT = "https://models.github.ai/inference/chat/completions";
const __dirname = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readEventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) fail("GITHUB_EVENT_PATH is not set; this must run inside GitHub Actions.");
  return readFile(path, "utf8").then((raw) => JSON.parse(raw));
}

// Pulls a fenced code block (if any) out of the markdown body.
export function extractCodeSnippet(body) {
  const match = String(body || "").match(/```[\w-]*\n([\s\S]*?)```/);
  return match ? match[1].trim() : "";
}

// Turns the raw issue/PR text into the input shape the review engine expects, reusing the
// same section/WCAG/severity parsers the extension uses.
export function buildReviewInput(issue) {
  const body = issue.body || "";
  const { extractIssueSection, extractWcag, extractSeverity } = reviewerInternals;
  const citedWcag = extractWcag(`${issue.title} ${body}`).map((id) => `WCAG ${id}`).join(", ");
  return {
    bugId: String(issue.number || ""),
    title: issue.title || "",
    body,
    actualResult: extractIssueSection(body, "Actual Result"),
    expectedResult: extractIssueSection(body, "Expected Result"),
    codeSnippet: extractCodeSnippet(body),
    citedWcag,
    citedSeverity: extractSeverity(`${issue.title} ${body}`) || "",
    alternateSeverityReasoning: "",
    labels: (issue.labels || []).map((label) => (typeof label === "string" ? label : label.name))
  };
}

async function loadDataset() {
  const url = process.env.SHARED_DATASET_URL;
  if (url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Shared dataset fetch failed (${response.status}).`);
    return response.json();
  }
  const raw = await readFile(join(__dirname, "..", "data", "dataset.json"), "utf8");
  return JSON.parse(raw);
}

function resolveAiConfig() {
  if (/^(1|true|yes)$/i.test(process.env.DISABLE_AI || "")) return null;
  const token = process.env.MODEL_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return null;
  return {
    ...DEFAULT_AI_CONFIG,
    enabled: true,
    provider: "custom",
    endpoint: process.env.MODEL_ENDPOINT || GITHUB_MODELS_ENDPOINT,
    model: process.env.MODEL_NAME || "openai/gpt-4o",
    token
  };
}

async function runReview(input, dataset) {
  const aiConfig = resolveAiConfig();
  if (aiConfig) {
    try {
      return await reviewIssueWithAI(input, dataset, aiConfig);
    } catch (error) {
      console.error(`::warning::Copilot review failed (${error.message}); using the offline heuristic.`);
    }
  }
  return reviewIssue(input, dataset);
}

function referenceWcagSeverity(bug) {
  if (!bug) return "";
  return bug.updated || [bug.reportedWcag, bug.reportedSeverity].filter(Boolean).join(", ");
}

// Renders the review result as a GitHub-flavoured markdown comment.
export function formatComment(result, input) {
  const lines = [];
  lines.push("## ♿ Race accessibility review");
  lines.push("");
  lines.push(`**Issue reviewed:** ${input.title || `#${input.bugId}`}`);
  lines.push(`**Validity:** ${result.validity}`);
  if (result.classification) {
    const reason = result.classificationReason ? ` — ${result.classificationReason}` : "";
    lines.push(`**Cross-validation:** ${result.classification}${reason}`);
  }
  lines.push("");

  if (result.validity !== "Invalid") {
    const bug = result.reference;
    const wcagSeverity = referenceWcagSeverity(bug);
    lines.push("| | Cited | Suggested |");
    lines.push("| --- | --- | --- |");
    lines.push(`| **WCAG** | ${result.citedWcag || "—"} | ${result.suggestedWcag || "—"} |`);
    lines.push(`| **Severity** | ${result.citedSeverity || "—"} | ${result.suggestedSeverity || "—"} |`);
    lines.push("");
    if (bug) {
      lines.push(`**Reference bug:** #${bug.id}${wcagSeverity ? ` (${wcagSeverity})` : ""}`);
      lines.push("");
    }
  }

  const feedback = String(result.feedback || "").split("\n").filter(Boolean);
  if (feedback.length) {
    lines.push("**Feedback / Suggestion**");
    lines.push("");
    for (const line of feedback) lines.push(`- ${line}`);
    lines.push("");
  }

  const confidence = result.confidence != null ? ` · confidence: ${result.confidence}%` : "";
  lines.push(`<sub>Posted by the \`${COMMAND}\` slash command · source: ${result.source || "heuristic"}${confidence}</sub>`);
  return lines.join("\n");
}

async function postComment(owner, repo, issueNumber, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN is not set; cannot post the review comment.");
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "race-slash-command"
      },
      body: JSON.stringify({ body })
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    fail(`Failed to post comment (${response.status}). ${detail.slice(0, 300)}`);
  }
}

export async function main() {
  const event = await readEventPayload();
  const commentBody = event.comment?.body || "";
  if (!new RegExp(`(^|\\s)${COMMAND}\\b`, "i").test(commentBody)) {
    console.log(`No ${COMMAND} command found in the comment; nothing to do.`);
    return;
  }
  const issue = event.issue;
  if (!issue) fail("The event payload has no issue/PR to review.");

  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
  if (!owner || !repo) fail("GITHUB_REPOSITORY is not set to owner/repo.");

  const input = buildReviewInput(issue);
  const dataset = await loadDataset();
  const result = await runReview(input, dataset);
  const comment = formatComment(result, input);

  await postComment(owner, repo, issue.number, comment);
  console.log(`Posted Race review on #${issue.number} (validity: ${result.validity}).`);
}

// Only auto-run when invoked directly (node scripts/race-review.mjs), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error.stack || error.message));
}