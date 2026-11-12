// The step that sends a build quality measurement to Shippp, run for real.
//
// It holds the run's identity token, so it runs none of the project's code:
// it is handed the figures the measuring job kept, reads which project the
// commit is for from the install's own record, asks GitHub for a token made
// out to Shippp, and sends the figures with it. The figures come from a job
// that ran the project's code, so they are rebuilt here field by field, and
// anything that is not one of them, in its form, is not sent.
//
// The step's script is taken out of verify.yml as GitHub would hand it to
// Node, written to a file of its own, and run as a separate process. It talks
// over real HTTP to a server on this machine that answers its three
// questions: GitHub's "what does this file of the commit hold", GitHub's
// "give this run an identity token", and Shippp's "here is a measurement".
// What each answers is set by the test, from the answers the real ones give
// (app/api/ci/quality in Shippp's own repository).
//
// What this cannot show is that GitHub's real token is accepted by Shippp's
// real server. That is shown by a run of this workflow from a linked
// repository.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = fs
  .readFileSync(path.join(HERE, "../.github/workflows/verify.yml"), "utf8")
  .replace(/\r\n/g, "\n");

/** The lines under the step's `run: |`, with the YAML's indent taken off. */
function stepScript() {
  const job = WORKFLOW.indexOf("\n  quality-report:\n");
  assert.notEqual(job, -1, "the quality-report job is in the workflow");
  const mine = WORKFLOW.slice(job);
  const marker = "        shell: node {0}\n";
  const from = mine.indexOf(marker);
  assert.notEqual(from, -1);
  assert.equal(mine.indexOf(marker, from + 1), -1, "it is the one step there");
  const run = mine.indexOf("        run: |\n", from);
  assert.notEqual(run, -1);
  const lines = mine.slice(run + "        run: |\n".length).split("\n");
  const body = [];
  for (const line of lines) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const SCRIPT = stepScript();
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmVkLWJ5LWdpdGh1Yi1mb3ItdGhpcy1ydW4";
const ASK_KEY = "runner-key-for-asking";
const READ_KEY = "run-token-for-reading";
const AUDIENCE = "https://shippp.io/api/ci/results";
const PROJECT = "8f3a1c2d-4b5e-4f70-8192-a3b4c5d6e7f8";
const SHA = "d".repeat(40);
const RECORD_PATH = "/repos/acme/shop/contents/context/governance-version.json";

const FIGURES = {
  files: 42,
  lines: 1340,
  complexFunctions: 0,
  duplicatedPercent: 8.26319816373374,
  importLoops: 0,
  tests: { kind: "measured", caught: 364, made: 676 },
};

/** What the measuring job hands on: its kept JSON, in base64. */
const handed = (kept = { formula: 1, figures: FIGURES }) =>
  Buffer.from(JSON.stringify(kept)).toString("base64");

const record = (over = {}) =>
  JSON.stringify({ version: "0.16.0", project: PROJECT, files: {}, ...over }, null, 2);

let server;
let base;
let dir;
let scriptFile;
let asked;
/** What each answers next. `quality` is a list: one answer per post, the last one repeating. */
let answers;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shippp-quality-report-"));
  scriptFile = path.join(dir, "step.js");
  fs.writeFileSync(scriptFile, SCRIPT);

  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      asked.push({
        method: req.method,
        path: url.pathname,
        ref: url.searchParams.get("ref"),
        audience: url.searchParams.get("audience"),
        authorization: req.headers.authorization ?? null,
        accept: req.headers.accept ?? null,
        contentType: req.headers["content-type"] ?? null,
        body: raw,
      });
      let answer;
      if (url.pathname === "/token") answer = answers.token;
      else if (url.pathname.startsWith("/api/")) {
        answer = answers.github[url.pathname.slice("/api".length)] ?? { status: 404, body: { message: "Not Found" } };
      } else {
        answer = answers.quality.length > 1 ? answers.quality.shift() : answers.quality[0];
      }
      res.writeHead(answer.status, { "content-type": "application/json", ...(answer.headers ?? {}) });
      res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((done) => server.close(done));
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  asked = [];
  answers = {
    token: { status: 200, body: { value: TOKEN } },
    github: { [RECORD_PATH]: { status: 200, body: record() } },
    quality: [{ status: 201, body: { recorded: true } }],
  };
});

function runStep(over = {}) {
  const summary = path.join(fs.mkdtempSync(path.join(dir, "run-")), "summary.md");
  fs.writeFileSync(summary, "");
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    FIGURES: handed(),
    SHIPPP_QUALITY_URL: `${base}/quality`,
    SHIPPP_AUDIENCE: AUDIENCE,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: ASK_KEY,
    GITHUB_API_URL: `${base}/api`,
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_SHA: SHA,
    GITHUB_TOKEN: READ_KEY,
    GITHUB_STEP_SUMMARY: summary,
    ...over,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return new Promise((done) => {
    const child = spawn(process.execPath, [scriptFile], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => done({ code, out, summary: fs.readFileSync(summary, "utf8") }));
  });
}

const posts = () => asked.filter((a) => a.path === "/quality");
const tokenAsks = () => asked.filter((a) => a.path === "/token");
const reads = () => asked.filter((a) => a.path.startsWith("/api/"));
const ERROR = /^::error title=Shippp did not take this measurement::/m;

test("the script was found in the workflow, whole", () => {
  assert.ok(SCRIPT.length > 3000);
  assert.match(SCRIPT, /^const fs = require\("fs"\);/);
  assert.match(SCRIPT, /^main\(\)\.catch\(/m);
});

test("sends the project, the formula and the figures, with a token made out to Shippp, and says so", async () => {
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^Shippp has this measurement\. Your dashboard shows its score\.$/m);
  assert.doesNotMatch(run.out, ERROR);
  assert.match(run.summary, /### Shippp: build quality sent/);

  // The install's own record, of the measured commit, read with this run's own token.
  assert.equal(reads().length, 1);
  assert.equal(reads()[0].path, "/api" + RECORD_PATH);
  assert.equal(reads()[0].ref, SHA);
  assert.equal(reads()[0].authorization, `Bearer ${READ_KEY}`);
  assert.equal(reads()[0].accept, "application/vnd.github.raw+json");

  assert.equal(tokenAsks().length, 1);
  assert.equal(tokenAsks()[0].authorization, `bearer ${ASK_KEY}`);
  assert.equal(tokenAsks()[0].audience, AUDIENCE);

  // Once, with that token. The body is the project and the measurement and
  // nothing about the run: the repository, commit, branch and event are the
  // token's to say.
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].method, "POST");
  assert.equal(posts()[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(posts()[0].contentType, "application/json");
  assert.deepEqual(JSON.parse(posts()[0].body), { projectId: PROJECT, formula: 1, figures: FIGURES });
});

test("the token is masked before anything else is printed, and is printed nowhere", async () => {
  const run = await runStep();
  const lines = run.out.split("\n");
  assert.notEqual(lines.indexOf("::add-mask::" + TOKEN), -1);
  assert.equal(lines.filter((l) => l.includes(TOKEN)).length, 1);
  // GitHub's own token, which the record is read with, is never sent to Shippp.
  assert.ok(!posts()[0].body.includes(READ_KEY));
  assert.ok(posts().every((p) => p.authorization !== `Bearer ${READ_KEY}`));
});

test("sends each of the three ways test strength comes out", async () => {
  for (const tests of [
    { kind: "measured", caught: 0, made: 0 },
    { kind: "none", reason: "the app has no tests" },
    { kind: "not-measured", reason: "the mutation run did not finish within 40 minutes" },
  ]) {
    asked = [];
    const run = await runStep({ FIGURES: handed({ formula: 1, figures: { ...FIGURES, tests } }) });
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(JSON.parse(posts()[0].body).figures.tests, tests);
  }
});

test("sends nothing the measuring job handed on that is not a figure, in its form", async () => {
  const odd = [
    "",
    "not base64 json",
    handed({ formula: "1", figures: FIGURES }),
    handed({ figures: FIGURES }),
    handed({ formula: 1, figures: { ...FIGURES, lines: -3 } }),
    handed({ formula: 1, figures: { ...FIGURES, duplicatedPercent: "8" } }),
    handed({ formula: 1, figures: { ...FIGURES, tests: { kind: "measured", caught: 7, made: 2 } } }),
    handed({ formula: 1, figures: { ...FIGURES, tests: { kind: "none", reason: "a\nsrc/secret.ts" } } }),
    handed({ formula: 1, figures: { ...FIGURES, tests: { kind: "none", reason: "y".repeat(201) } } }),
  ];
  for (const FIG of odd) {
    asked = [];
    const run = await runStep({ FIGURES: FIG });
    assert.equal(run.code, 1, FIG.slice(0, 40));
    assert.match(run.out, /The measure handed on figures this job does not recognise, so none were sent\./);
    assert.equal(posts().length, 0);
    assert.equal(tokenAsks().length, 0, "no token is asked for a report that will not be sent");
  }
});

test("leaves out whatever else the measuring job put beside the figures", async () => {
  const run = await runStep({
    FIGURES: handed({
      formula: 1,
      files: ["src/billing/charge.ts"],
      repository: "someone/else",
      figures: { ...FIGURES, files_measured: ["src/billing/charge.ts"], tests: { ...FIGURES.tests, note: "x" } },
    }),
  });
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(JSON.parse(posts()[0].body), { projectId: PROJECT, formula: 1, figures: FIGURES });
});

test("says which project could not be read, and sends nothing, when the install's record is missing", async () => {
  answers.github = {};
  const run = await runStep();
  assert.equal(run.code, 1);
  assert.match(run.out, ERROR);
  assert.match(run.out, /could not read which Shippp project this commit belongs to/);
  assert.equal(posts().length, 0);

  asked = [];
  answers.github = { [RECORD_PATH]: { status: 200, body: record({ project: "not-a-project" }) } };
  const odd = await runStep();
  assert.equal(odd.code, 1);
  assert.equal(posts().length, 0);
});

test("says the job needs leave to ask for a token when it has none", async () => {
  const run = await runStep({ ACTIONS_ID_TOKEN_REQUEST_URL: undefined });
  assert.equal(run.code, 1);
  assert.match(run.out, /needs `permissions: id-token: write`/);
  assert.equal(posts().length, 0);

  asked = [];
  answers.token = { status: 500, body: {} };
  const refused = await runStep();
  assert.equal(refused.code, 1);
  assert.match(refused.out, /GitHub did not give this run an identity token \(it answered 500\)/);
  assert.equal(posts().length, 0);
});

test("tries again when Shippp is busy or waking, and no more than three times", async () => {
  answers.quality = [
    { status: 503, body: { error: "waking" }, headers: { "Retry-After": "1" } },
    { status: 201, body: { recorded: true } },
  ];
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.equal(posts().length, 2);

  asked = [];
  answers.quality = [{ status: 429, body: { error: "Rate limit exceeded" }, headers: { "Retry-After": "1" } }];
  const busy = await runStep();
  assert.equal(busy.code, 1);
  assert.equal(posts().length, 3);
  assert.match(busy.out, /Rate limit exceeded/);
});

test("says Shippp's own words when it refuses, and fails the job, once", async () => {
  answers.quality = [
    {
      status: 404,
      body: { error: "This project has no repository linked to it. Its founder links one, signed in to Shippp." },
    },
  ];
  const run = await runStep();
  assert.equal(run.code, 1);
  assert.match(
    run.out,
    /^::error title=Shippp did not take this measurement::This project has no repository linked to it\. Its founder links one, signed in to Shippp\.$/m,
  );
  assert.match(run.summary, /### Shippp: build quality not sent/);
  // A refusal is not tried again: the same report would be refused the same way.
  assert.equal(posts().length, 1);
});
