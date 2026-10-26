// The step that asks Shippp whether a project's plan is paid, run for real.
//
// Shippp is rented, not owned (ADR-043 in Shippp's own repository). When a
// project's plan has ended, the check stands aside and the commit's status
// passes, saying Shippp is off. This step is what decides that, and it says
// "off" only when Shippp itself answers that the account has no active plan.
// Every other answer, an outage included, is a commit checked as before.
//
// The step's script is taken out of verify.yml as GitHub would hand it to
// Node, written to a file of its own, and run as a separate process. It talks
// over real HTTP to a server on this machine that answers the two questions
// the step asks: GitHub's "what does this file of the commit hold", and
// Shippp's "is this project's plan paid" (POST /api/mcp/pass in Shippp's own
// repository, whose answers these are).
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
  const job = WORKFLOW.indexOf("\n  plan:\n");
  assert.notEqual(job, -1, "the plan job is in the workflow");
  const end = WORKFLOW.indexOf("\n  verify:\n", job);
  assert.notEqual(end, -1, "and it comes before the job that runs the check");
  const mine = WORKFLOW.slice(job, end);
  const run = mine.indexOf("        run: |\n");
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
const KEY = "shippp_live_the-projects-own-key";
const READ_KEY = "run-token-for-reading";
const PROJECT = "8f3a1c2d-4b5e-4f70-8192-a3b4c5d6e7f8";
const SHA = "c".repeat(40);
const RECORD_PATH = "/repos/acme/shop/contents/context/governance-version.json";

const record = (over = {}) =>
  JSON.stringify({ version: "0.3.0", project: PROJECT, files: {}, ...over }, null, 2);

let server;
let base;
let dir;
let scriptFile;
let asked;
let answers;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shippp-plan-step-"));
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
        authorization: req.headers.authorization ?? null,
        project: req.headers["x-project-id"] ?? null,
        body: raw,
      });
      const answer = url.pathname.startsWith("/api/")
        ? (answers.github[url.pathname.slice("/api".length)] ?? { status: 404, body: { message: "Not Found" } })
        : answers.pass;
      res.writeHead(answer.status, { "content-type": "application/json" });
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
    github: { [RECORD_PATH]: { status: 200, body: record() } },
    pass: { status: 402, body: { error: "No active subscription for this account.", reason: "no_plan" } },
  };
});

/** Runs the step as its own process, with the environment a runner gives it. */
function runStep(over = {}) {
  const output = path.join(dir, `output-${Math.random().toString(16).slice(2)}`);
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    SHIPPP_PASS_URL: `${base}/pass`,
    SHIPPP_API_KEY: KEY,
    GITHUB_API_URL: `${base}/api`,
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_SHA: SHA,
    GITHUB_TOKEN: READ_KEY,
    GITHUB_OUTPUT: output,
    ...over,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return new Promise((done) => {
    const child = spawn(process.execPath, [scriptFile], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) =>
      done({ code, out, said: fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "" }),
    );
  });
}

const passAsks = () => asked.filter((a) => a.path === "/pass");

test("the script was found in the workflow, whole", () => {
  assert.ok(SCRIPT.length > 1500, "long enough to be the step and not a fragment of it");
  assert.match(SCRIPT, /^const fs = require\("fs"\);/);
  assert.match(SCRIPT, /^main\(\)\.catch\(/m);
  assert.doesNotMatch(SCRIPT, /process\.exit\(|process\.exitCode/);
});

test("a plan that has ended: asks Shippp with the project's key, for the commit's project, and says off", async () => {
  const run = await runStep();

  assert.equal(run.code, 0, run.out);
  assert.equal(run.said, "off=true\n");
  assert.match(run.out, /Shippp says this project's account has no active plan, so Shippp is off for this commit\./);

  // The project, from the install's own record in the pushed commit.
  const reads = asked.filter((a) => a.path.startsWith("/api/"));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].ref, SHA);
  assert.equal(reads[0].authorization, `Bearer ${READ_KEY}`);

  // Shippp, once, with the project's key and the project, and no body.
  assert.equal(passAsks().length, 1);
  assert.equal(passAsks()[0].method, "POST");
  assert.equal(passAsks()[0].authorization, `Bearer ${KEY}`);
  assert.equal(passAsks()[0].project, PROJECT);
  assert.equal(passAsks()[0].body, "");
});

test("a paid plan: says on", async () => {
  answers.pass = { status: 200, body: { pass: { alg: "ed25519" }, publicKey: "key" } };
  const run = await runStep();

  assert.equal(run.code, 0, run.out);
  assert.equal(run.said, "off=false\n");
  assert.match(run.out, /Shippp confirmed this project's plan\./);
});

test("says off for Shippp's no-plan answer alone: every other answer is a commit checked as before", async () => {
  for (const answer of [
    { status: 402, body: { error: "No active subscription for this account." } },
    { status: 402, body: "<html>Payment Required</html>" },
    { status: 401, body: { error: "Unauthorised", reason: "key_refused" } },
    { status: 404, body: { error: "No such project for this account.", reason: "not_owned" } },
    { status: 404, body: "<html>Not Found</html>" },
    { status: 500, body: { error: "Something went wrong" } },
    { status: 503, body: { error: "Shippp cannot issue a pass right now." } },
  ]) {
    answers.pass = answer;
    const run = await runStep();
    assert.equal(run.code, 0, run.out);
    assert.equal(run.said, "off=false\n", JSON.stringify(answer));
    assert.match(run.out, /This commit is checked as it always is\.$/m);
  }
});

test("Shippp out of reach: a commit checked as before", async () => {
  const run = await runStep({ SHIPPP_PASS_URL: "http://127.0.0.1:1/pass" });

  assert.equal(run.code, 0, run.out);
  assert.equal(run.said, "off=false\n");
  assert.match(run.out, /Shippp could not be reached to ask about the plan\./);
});

test("without the project's key, asks nothing and checks as before", async () => {
  const run = await runStep({ SHIPPP_API_KEY: "" });

  assert.equal(run.code, 0, run.out);
  assert.equal(run.said, "off=false\n");
  assert.deepEqual(asked, []);
});

test("without the install's record in the commit, asks Shippp nothing and checks as before", async () => {
  answers.github = {};
  const run = await runStep();

  assert.equal(run.code, 0, run.out);
  assert.equal(run.said, "off=false\n");
  assert.equal(passAsks().length, 0);

  answers.github = { [RECORD_PATH]: { status: 200, body: record({ project: "not-a-project" }) } };
  const again = await runStep();
  assert.equal(again.said, "off=false\n");
  assert.equal(passAsks().length, 0);
});

test("never prints the project's key", async () => {
  const run = await runStep();
  assert.doesNotMatch(run.out, new RegExp(KEY));
  assert.doesNotMatch(run.out, new RegExp(READ_KEY));
});
