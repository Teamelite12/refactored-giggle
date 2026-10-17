import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReviewInput, extractCodeSnippet, formatComment, main, resolveAiConfig } from "../scripts/race-review.mjs";
import { reviewIssueWithAI } from "../lib/ai-reviewer.js";

const issue = {
  number: 42,
  title: "Keyboard focus is not visible on the submit button",
  body: [
    "Actual Result:",
    "No visible focus indicator when tabbing to the button. This looks like WCAG 2.4.7 and is Sev-2.",
    "",
    "Expected Result:",
    "A clearly visible focus indicator.",
    "",
    "```css",
    "button:focus { outline: none; }",
    "```"
  ].join("\n"),
  labels: [{ name: "accessibility" }]
};

test("extractCodeSnippet pulls a fenced code block", () => {
  assert.equal(extractCodeSnippet(issue.body), "button:focus { outline: none; }");
  assert.equal(extractCodeSnippet("no code here"), "");
});

test("buildReviewInput parses sections, WCAG and severity from the body", () => {
  const input = buildReviewInput(issue);
  assert.equal(input.bugId, "42");
  assert.match(input.actualResult, /No visible focus indicator/);
  assert.match(input.expectedResult, /clearly visible focus indicator/);
  assert.equal(input.codeSnippet, "button:focus { outline: none; }");
  assert.match(input.citedWcag, /2\.4\.7/);
  assert.match(input.citedSeverity, /2/);
  assert.deepEqual(input.labels, ["accessibility"]);
});

test("formatComment renders a valid review with the comparison table and cross-validation", () => {
  const result = {
    validity: "Valid",
    classification: "Actual accessibility issue",
    classificationReason: "The app removes the focus outline in its own CSS.",
    citedWcag: "WCAG 2.4.7",
    suggestedWcag: "2.4.7 Focus Visible",
    citedSeverity: "Severity-2",
    suggestedSeverity: "Severity-2",
    reference: { id: "9339", updated: "WCAG 2.4.7 Focus Visible, Sev-2" },
    feedback: "Cross-validation: Actual accessibility issue\nJustification: Focus outline removed.",
    confidence: 90,
    source: "copilot"
  };
  const md = formatComment(result, buildReviewInput(issue));
  assert.match(md, /## ♿ Race accessibility review/);
  assert.match(md, /\*\*Validity:\*\* Valid/);
  assert.match(md, /\*\*Cross-validation:\*\* Actual accessibility issue/);
  assert.match(md, /\| \*\*WCAG\*\* \| WCAG 2\.4\.7 \| 2\.4\.7 Focus Visible \|/);
  assert.match(md, /\*\*Reference bug:\*\* #9339/);
  assert.match(md, /confidence: 90%/);
});

test("formatComment omits the table for invalid issues", () => {
  const result = {
    validity: "Invalid",
    classification: "Expected behaviour of the screen reader/control",
    feedback: "Invalid bug justification: Works as designed.",
    source: "copilot"
  };
  const md = formatComment(result, buildReviewInput(issue));
  assert.doesNotMatch(md, /\| \*\*WCAG\*\*/);
  assert.match(md, /\*\*Validity:\*\* Invalid/);
  assert.match(md, /Expected behaviour of the screen reader\/control/);
});

test("resolveAiConfig requires an endpoint and model credential without using GITHUB_TOKEN", () => {
  for (const env of [
    {},
    { GITHUB_TOKEN: "test-github-credential" },
    { MODEL_TOKEN: "test-model-credential" },
    { MODEL_ENDPOINT: "https://model.example/chat/completions", GITHUB_TOKEN: "test-github-credential" },
    { MODEL_ENDPOINT: " ", MODEL_TOKEN: "test-model-credential" },
    { MODEL_ENDPOINT: "https://model.example/chat/completions", MODEL_TOKEN: " " }
  ]) {
    assert.throws(() => resolveAiConfig(env), /RACE_MODEL_ENDPOINT.*RACE_MODEL_TOKEN.*GitHub Models has been retired/);
  }
});

test("resolveAiConfig uses the configured provider and model", () => {
  const env = {
    MODEL_ENDPOINT: "https://model.example/chat/completions",
    MODEL_TOKEN: "test-model-credential",
    GITHUB_TOKEN: "test-github-credential"
  };
  const config = resolveAiConfig(env);
  assert.equal(config.endpoint, env.MODEL_ENDPOINT);
  assert.equal(config.token, env.MODEL_TOKEN);
  assert.equal(config.model, "gpt-4o");
  assert.equal(config.provider, "custom");
  assert.equal(resolveAiConfig({ ...env, MODEL_NAME: "custom-model" }).model, "custom-model");
});

test("reviewIssueWithAI diagnoses the plain-text OK response from the failed job", async () => {
  await assert.rejects(
    reviewIssueWithAI({}, { bugs: [] }, { token: "test-model-credential" }, async () => new Response("OK\n")),
    /non-JSON response \(HTTP 200\).*MODEL_ENDPOINT/
  );
});

test("reviewIssueWithAI still rejects HTTP failures and empty model responses", async () => {
  await assert.rejects(
    reviewIssueWithAI({}, { bugs: [] }, { token: "test-model-credential" }, async () => new Response("Unavailable", { status: 503 })),
    /Copilot request failed \(503\)/
  );
  await assert.rejects(
    reviewIssueWithAI({}, { bugs: [] }, { token: "test-model-credential" }, async () => Response.json({ choices: [] })),
    /Copilot returned an empty response/
  );
});

test("main posts an AI review with a configured provider and never falls back on non-JSON responses", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "race-review-"));
  const eventPath = join(dir, "event.json");
  const previousEnv = { ...process.env };
  t.after(async () => {
    process.env = previousEnv;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(eventPath, JSON.stringify({ comment: { body: "/race" }, issue }));
  Object.assign(process.env, {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_TOKEN: "test-github-credential",
    MODEL_ENDPOINT: "https://model.example/chat/completions",
    MODEL_TOKEN: "test-model-credential",
    MODEL_NAME: "custom-model"
  });
  delete process.env.SHARED_DATASET_URL;
  const requests = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    if (url === process.env.MODEL_ENDPOINT) {
      assert.equal(options.headers.Authorization, ["Bearer", process.env.MODEL_TOKEN].join(" "));
      assert.equal(JSON.parse(options.body).model, "custom-model");
      return Response.json({
        choices: [{ message: { content: JSON.stringify({
          validity: "Valid",
          classification: "Actual accessibility issue",
          suggestedWcag: "2.4.7",
          suggestedSeverity: "Severity-2",
          justification: "The focus indicator is missing.",
          confidence: 90
        }) } }]
      });
    }
    assert.equal(url, "https://api.github.com/repos/owner/repo/issues/42/comments");
    assert.equal(options.headers.Authorization, `token ${process.env.GITHUB_TOKEN}`);
    assert.match(JSON.parse(options.body).body, /source: copilot/);
    return Response.json({}, { status: 201 });
  });
  await main();
  assert.equal(requests.length, 2);

  fetchMock.mock.mockImplementation(async () => new Response("OK\n"));
  await assert.rejects(main(), /non-JSON response/);
  assert.equal(fetchMock.mock.callCount(), 3);

  delete process.env.MODEL_TOKEN;
  await assert.rejects(main(), /RACE_MODEL_ENDPOINT.*RACE_MODEL_TOKEN/);
  assert.equal(fetchMock.mock.callCount(), 3);
});
