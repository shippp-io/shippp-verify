// The step that tells Shippp a run has started, run for real.
//
// A founder's dashboard says "Checking" between a push and the run's result.
// Shippp can only say it of a run it knows about, so the first job of the
// workflow says the run has begun, with the run's own identity token.
//
// The step's script is taken out of verify.yml as GitHub would hand it to
// Node, written to a file of its own, and run as a separate process: the same
// lines, the same way. It talks over real HTTP to a server on this machine
// that answers the three questions the step asks: GitHub's "what does this
// file of the commit hold", GitHub's "give this run an identity token", and
// Shippp's "a run has started". What each answers is set by the test, from
// the answers the real ones are known to give (app/api/ci/runs in Shippp's
// own repository).
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
  const job = WORKFLOW.indexOf("\n  started:\n");
  assert.notEqual(job, -1, "the started job is in the workflow");
  const end = WORKFLOW.indexOf("\n  verify:\n", job);
  assert.notEqual(end, -1, "and it comes before the job that runs the check");
  const mine = WORKFLOW.slice(job, end);
  const marker = "        shell: node {0}\n";
  const from = mine.indexOf(marker);
  assert.notEqual(from, -1, "the step that runs as Node is in the started job");
  assert.equal(mine.indexOf(marker, from + 1), -1, "and it is the one step there that does");
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
const SHA = "c".repeat(40);
const RECORD_PATH = "/repos/acme/shop/contents/context/governance-version.json";

/** The install's own record, as init writes it into a project. */
const record = (over = {}) =>
  JSON.stringify({ version: "0.1.0", project: PROJECT, files: {}, ...over }, null, 2);

let server;
let base;
let dir;
let scriptFile;
/** Every request the step made, in order. */
let asked;
/** What each of the three answers next. */
let answers;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shippp-started-step-"));
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
      const answer =
        url.pathname === "/token"
          ? answers.token
          : url.pathname.startsWith("/api/")
            ? (answers.github[url.pathname.slice("/api".length)] ?? { status: 404, body: { message: "Not Found" } })
            : answers.runs;
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
    runs: { status: 201, body: { started: true } },
  };
});

/** Runs the step as its own process, with the environment a runner gives it. */
function runStep(over = {}) {
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    SHIPPP_RUNS_URL: `${base}/runs`,
    SHIPPP_AUDIENCE: AUDIENCE,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: ASK_KEY,
    GITHUB_API_URL: `${base}/api`,
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_SHA: SHA,
    GITHUB_TOKEN: READ_KEY,
    ...over,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return new Promise((done) => {
    const child = spawn(process.execPath, [scriptFile], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => done({ code, out }));
  });
}

const posts = () => asked.filter((a) => a.path === "/runs");
const tokenAsks = () => asked.filter((a) => a.path === "/token");
const reads = () => asked.filter((a) => a.path.startsWith("/api/"));
const NOTICE = /^::notice title=Shippp::/m;
const ALL_THE_SAME = /This commit is checked all the same, and its result is sent when the check has finished\.$/m;

test("the script was found in the workflow, whole", () => {
  assert.ok(SCRIPT.length > 1500, "long enough to be the step and not a fragment of it");
  assert.match(SCRIPT, /^const say = /);
  assert.match(SCRIPT, /^main\(\)\.catch\(/m);
  assert.match(SCRIPT, /\);\s*$/);
  // It ends by itself, and it never ends badly: see the last test.
  assert.doesNotMatch(SCRIPT, /process\.exit\(|process\.exitCode/);
});

test("a run that starts: reads which project the commit is for, asks GitHub for a token made out to Shippp, and says so", async () => {
  const run = await runStep();

  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^Shippp was told that this run has started\.$/m);
  assert.doesNotMatch(run.out, NOTICE);

  // The install's own record, of the commit that was pushed, read with this
  // run's own token, as the file's contents and not a description of it.
  assert.equal(reads().length, 1);
  assert.equal(reads()[0].path, "/api" + RECORD_PATH);
  assert.equal(reads()[0].ref, SHA);
  assert.equal(reads()[0].authorization, `Bearer ${READ_KEY}`);
  assert.equal(reads()[0].accept, "application/vnd.github.raw+json");

  // GitHub was asked once, with the runner's own key, for a token made out to Shippp.
  assert.equal(tokenAsks().length, 1);
  assert.equal(tokenAsks()[0].authorization, `bearer ${ASK_KEY}`);
  assert.equal(tokenAsks()[0].audience, AUDIENCE);

  // Shippp was told once, with that token, which project. Nothing else: the
  // commit, the repository and the run are the token's to say.
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].method, "POST");
  assert.equal(posts()[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(posts()[0].contentType, "application/json");
  assert.deepEqual(JSON.parse(posts()[0].body), { projectId: PROJECT });
});

test("the token is never printed, and is masked before anything else is", async () => {
  const run = await runStep();
  const lines = run.out.split("\n");
  const mask = lines.findIndex((l) => l === "::add-mask::" + TOKEN);
  assert.notEqual(mask, -1, "the runner is told to mask it");
  assert.equal(lines.filter((l) => l.includes(TOKEN)).length, 1, "and that is the only line it is on");
  // GitHub's own token, which the record is read with, is never sent to Shippp.
  assert.ok(posts().every((p) => !p.authorization.includes(READ_KEY) && !p.body.includes(READ_KEY)));
});

test("the read token is not sent to GitHub's token endpoint, and the identity token is not sent to GitHub's API", async () => {
  await runStep();
  assert.ok(tokenAsks().every((a) => !a.authorization.includes(READ_KEY)));
  assert.ok(reads().every((a) => !a.authorization.includes(TOKEN)));
});

for (const [what, github] of [
  ["a commit with no record of an install", {}],
  ["a record that is not JSON", { [RECORD_PATH]: { status: 200, body: "not json {" } }],
  ["a record with no project", { [RECORD_PATH]: { status: 200, body: record({ project: undefined }) } }],
  ["a record whose project is not shaped like one", { [RECORD_PATH]: { status: 200, body: record({ project: "tallyboard" }) } }],
  ["a record whose project is not text", { [RECORD_PATH]: { status: 200, body: record({ project: { id: PROJECT } }) } }],
  ["GitHub refusing the read", { [RECORD_PATH]: { status: 403, body: { message: "Resource not accessible by integration" } } }],
]) {
  test(`${what}: Shippp is told nothing, no token is asked for, and the job still ends well`, async () => {
    answers.github = github;
    const run = await runStep();
    assert.equal(run.code, 0, run.out);
    assert.equal(tokenAsks().length, 0, "no token for a start nobody can address");
    assert.equal(posts().length, 0);
    assert.match(run.out, NOTICE);
    assert.match(run.out, /could not read which Shippp project this commit belongs to/);
    assert.match(run.out, ALL_THE_SAME);
  });
}

test("a project id is sent only as the record holds it, never changed to fit", async () => {
  answers.github = { [RECORD_PATH]: { status: 200, body: record({ project: PROJECT.toUpperCase() }) } };
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(JSON.parse(posts()[0].body), { projectId: PROJECT.toUpperCase() });
});

test("no way to ask GitHub for a token: says the calling job needs the permission, and ends well", async () => {
  const run = await runStep({ ACTIONS_ID_TOKEN_REQUEST_URL: undefined, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined });
  assert.equal(run.code, 0, run.out);
  assert.equal(posts().length, 0);
  assert.match(run.out, NOTICE);
  assert.match(run.out, /`permissions: id-token: write`/);
  assert.match(run.out, ALL_THE_SAME);
});

test("GitHub gives no token: Shippp is told nothing, and the job ends well", async () => {
  answers.token = { status: 500, body: { message: "try later" } };
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.equal(posts().length, 0);
  assert.match(run.out, /GitHub did not give this run an identity token \(it answered 500\)/);
  assert.match(run.out, ALL_THE_SAME);
});

for (const [status, body, said] of [
  [404, { error: "This project has no repository linked to it. Its founder links one, signed in to Shippp." }, /This project has no repository linked to it\. Its founder links one, signed in to Shippp\./],
  [403, { error: "This project is linked to a different repository from the one this job ran in." }, /linked to a different repository/],
  [403, { error: "This job did not run a workflow Shippp accepts results from. Results count only from Shippp's own workflow, called from the project's." }, /did not run a workflow Shippp accepts/],
  [401, { error: "Not a GitHub Actions identity token Shippp accepts.", reason: "expired" }, /Not a GitHub Actions identity token Shippp accepts\./],
  [429, { error: "Rate limit exceeded" }, /Rate limit exceeded/],
  [500, "<html>oops</html>", /Shippp answered 500\./],
]) {
  test(`Shippp answers ${status}: says what it said, once, and the job still ends well`, async () => {
    answers.runs = { status, body };
    const run = await runStep();
    assert.equal(run.code, 0, run.out);
    assert.equal(posts().length, 1, "asked once and not again: the check does not wait on this");
    assert.match(run.out, NOTICE);
    assert.match(run.out, said);
    assert.match(run.out, ALL_THE_SAME);
    assert.doesNotMatch(run.out, /^::error/m);
  });
}

test("Shippp cannot be reached: says so, and the job ends well", async () => {
  // A port nothing listens on.
  const run = await runStep({ SHIPPP_RUNS_URL: "http://127.0.0.1:9/runs" });
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /Shippp could not be reached to be told that this run has started\./);
  assert.match(run.out, ALL_THE_SAME);
});

test("nothing it prints is an error: a start that was not said stops no commit", async () => {
  for (const break_ of [
    () => (answers.github = {}),
    () => (answers.token = { status: 200, body: {} }),
    () => (answers.runs = { status: 503, body: {} }),
  ]) {
    break_();
    const run = await runStep();
    assert.equal(run.code, 0, run.out);
    assert.doesNotMatch(run.out, /^::error/m);
    assert.doesNotMatch(run.out, /^::warning/m);
  }
});
