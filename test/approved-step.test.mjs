// The step that asks Shippp whether a commit is approved, run for real.
//
// The step's script is taken out of verify.yml as GitHub would hand it to
// Node, written to a file of its own, and run as a separate process: the same
// lines, the same way. It talks over real HTTP to a server on this machine
// that answers the two questions the step asks: GitHub's "give this run an
// identity token" and Shippp's "here is a result". What each answers is set
// by the test, from the answers the real ones are known to give
// (app/api/ci/results/answer.ts in Shippp's own repository).
//
// What this cannot show is that GitHub's real token is accepted by Shippp's
// real server. That is shown by a run of this workflow from a linked
// repository, and by the suite in Shippp's repository that checks a token
// GitHub signed for its own CI.
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
  const job = WORKFLOW.indexOf("\n  approved:\n");
  assert.notEqual(job, -1, "the approved job is in the workflow");
  const marker = "        shell: node {0}\n";
  const from = WORKFLOW.indexOf(marker, job);
  assert.notEqual(from, -1, "the step that runs as Node is in the approved job");
  assert.equal(WORKFLOW.indexOf(marker, from + 1), -1, "and it is the one step there that does");
  const run = WORKFLOW.indexOf("        run: |\n", from);
  assert.notEqual(run, -1);
  const lines = WORKFLOW.slice(run + "        run: |\n".length).split("\n");
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

const REPORT = {
  projectId: "8f3a1c2d-4b5e-4f70-8192-a3b4c5d6e7f8",
  verifierVersion: "governance/0.1.0",
  layers: [
    { layer: 2, status: "checked", checks: [], evidenceSha256: null },
    { layer: 5, status: "failed", checks: [], evidenceSha256: null },
    { layer: 10, status: "blocked", checks: [], evidenceSha256: null },
  ],
  // What the verify job found of Shippp's own files in the commit, as the
  // package writes it into the report.
  integrity: "intact",
};
const NAMES = { 2: "No stand-in code", 5: "Secret protection", 10: "Reversible upgrades" };
const verdict = (over) => ({
  commitSha: "c".repeat(40),
  verdict: "approved",
  passes: true,
  exceptions: 0,
  layers: [
    { layer: 2, state: "checked", status: "checked", waived: false, reportedLocally: false },
    { layer: 5, state: "verified", status: "verified", waived: false, reportedLocally: false },
    { layer: 10, state: "not_applicable", status: "not_applicable", waived: false, reportedLocally: false },
  ],
  blocking: [],
  scan: "passed",
  integrity: "intact",
  ...over,
});

let server;
let base;
let dir;
let scriptFile;
/** Every request the step made, in order. */
let asked;
/** What the two endpoints answer next. Results answers are taken in turn. */
let answers;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shippp-approved-step-"));
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
        audience: url.searchParams.get("audience"),
        authorization: req.headers.authorization ?? null,
        contentType: req.headers["content-type"] ?? null,
        body: raw,
      });
      const answer =
        url.pathname === "/token"
          ? answers.token
          : url.pathname.startsWith("/api/")
            ? (answers.github[url.pathname.slice("/api".length)] ?? { status: 404, body: { message: "Not Found" } })
            : (answers.results.shift() ?? { status: 500, body: { error: "The test gave no more answers." } });
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

/** What GitHub says of a branch, in the shape it says it to any reader. */
const branchSaid = (name, level, contexts) => ({
  status: 200,
  body: {
    name,
    protected: level !== "off",
    protection: {
      enabled: level !== "off",
      required_status_checks: { enforcement_level: level, contexts, checks: contexts.map((context) => ({ context, app_id: 15368 })) },
    },
  },
});
/** A repository whose default branch has that name and that protection. */
const repositorySaid = (name, level, contexts) => ({
  "/repos/acme/shop": { status: 200, body: { full_name: "acme/shop", default_branch: name } },
  [`/repos/acme/shop/branches/${name}`]: branchSaid(name, level, contexts),
});

/** What the step is expected to tell Shippp about the default answers below. */
const BRANCH = { name: "trunk", enforcement: "non_admins", requiredChecks: ["Shippp / approved", "verify"] };

beforeEach(() => {
  asked = [];
  answers = {
    token: { status: 200, body: { value: TOKEN } },
    results: [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }],
    github: repositorySaid("trunk", "non_admins", ["Shippp / approved", "verify"]),
  };
});

/** Runs the step as its own process, with the environment a runner gives it. */
function runStep(over = {}) {
  const summaryFile = path.join(dir, `summary-${Math.random().toString(16).slice(2)}.md`);
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    REPORT: Buffer.from(JSON.stringify(REPORT)).toString("base64"),
    // What the scan job said, as the workflow hands it to this step.
    SCAN: "passed",
    SHIPPP_RESULTS_URL: `${base}/results`,
    SHIPPP_AUDIENCE: AUDIENCE,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: ASK_KEY,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_API_URL: `${base}/api`,
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_TOKEN: READ_KEY,
    ...over,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return new Promise((done) => {
    const child = spawn(process.execPath, [scriptFile], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) =>
      done({
        code,
        out,
        summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, "utf8") : "",
      }),
    );
  });
}

const posts = () => asked.filter((a) => a.path === "/results");
const tokenAsks = () => asked.filter((a) => a.path === "/token");

test("the script was found in the workflow, whole", () => {
  assert.ok(SCRIPT.length > 2000, "long enough to be the step and not a fragment of it");
  assert.match(SCRIPT, /^const fs = require\("fs"\);/);
  assert.match(SCRIPT, /^main\(\)\.catch\(/m);
  assert.match(SCRIPT, /\}\);\s*$/);
  // It ends by itself. Stopping it part-way through can lose what it wrote,
  // and on Windows it crashes Node while a connection is still closing.
  assert.doesNotMatch(SCRIPT, /process\.exit\(/);
});

test("an approved commit: asks GitHub for a token for Shippp, sends the result with it, and passes", async () => {
  const run = await runStep();

  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^Shippp: approved \(commit cccccccccccc\)$/m);

  // GitHub was asked once, with the runner's own key, for a token made out to Shippp.
  assert.equal(tokenAsks().length, 1);
  assert.equal(tokenAsks()[0].authorization, `bearer ${ASK_KEY}`);
  assert.equal(tokenAsks()[0].audience, AUDIENCE);

  // Shippp was sent the report, with what GitHub said of the default branch
  // beside it, with that token and nothing else to say who is calling.
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].method, "POST");
  assert.equal(posts()[0].authorization, `Bearer ${TOKEN}`);
  assert.match(posts()[0].contentType, /^application\/json/);
  assert.deepEqual(JSON.parse(posts()[0].body), { ...REPORT, scan: "passed", defaultBranch: BRANCH });
});

const reads = () => asked.filter((a) => a.path.startsWith("/api/"));
const sentBranch = () => JSON.parse(posts()[0].body).defaultBranch;

test("asks GitHub which branch is the default one, then about that branch, with the run's own token", async () => {
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(
    reads().map((a) => [a.method, a.path, a.authorization]),
    [
      ["GET", "/api/repos/acme/shop", `Bearer ${READ_KEY}`],
      ["GET", "/api/repos/acme/shop/branches/trunk", `Bearer ${READ_KEY}`],
    ],
  );
  // After the identity token, so a run with no leave to report asks nothing.
  assert.ok(asked.indexOf(tokenAsks()[0]) < asked.indexOf(reads()[0]));
  assert.ok(asked.indexOf(reads()[1]) < asked.indexOf(posts()[0]));
});

test("no branch name is built in: master, trunk and a name with a slash are each asked about as named", async () => {
  for (const name of ["master", "trunk", "release/2026"]) {
    asked = [];
    answers.results = [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
    answers.github = repositorySaid(name, "everyone", ["Shippp / approved"]);
    const run = await runStep();
    assert.equal(run.code, 0, name + run.out);
    assert.equal(reads()[1].path, `/api/repos/acme/shop/branches/${name}`, name);
    assert.deepEqual(sentBranch(), { name, enforcement: "everyone", requiredChecks: ["Shippp / approved"] }, name);
  }
  assert.doesNotMatch(SCRIPT, /["'/]main["'/]|["'/]master["'/]/);
});

test("says who the required checks bind as GitHub says it: everyone, everyone but administrators, or nobody", async () => {
  for (const [level, sent] of [
    ["everyone", "everyone"],
    ["non_admins", "non_admins"],
    ["off", "off"],
    // A word GitHub does not use today is not read as enforced.
    ["some_new_level", "off"],
  ]) {
    asked = [];
    answers.results = [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
    answers.github = repositorySaid("master", level, level === "off" ? [] : ["verify"]);
    await runStep();
    assert.equal(sentBranch().enforcement, sent, level);
  }
});

test("a branch nothing protects is sent as that, with no checks", async () => {
  answers.github = {
    "/repos/acme/shop": { status: 200, body: { default_branch: "master" } },
    "/repos/acme/shop/branches/master": { status: 200, body: { name: "master", protected: false } },
  };
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(sentBranch(), { name: "master", enforcement: "off", requiredChecks: [] });
});

test("sends no more about the branch than Shippp takes", async () => {
  const many = Array.from({ length: 150 }, (_, i) => `check ${i}`);
  answers.github = repositorySaid("master", "non_admins", ["x".repeat(201), "", 7, null, "verify", ...many]);
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  const { requiredChecks } = sentBranch();
  assert.equal(requiredChecks.length, 100);
  assert.equal(requiredChecks[0], "verify");
  assert.ok(requiredChecks.every((c) => typeof c === "string" && c.length >= 1 && c.length <= 200));
});

test("the three numbers it trims to are the ones Shippp's schema takes", async () => {
  // DEFAULT_BRANCH_LIMITS in Shippp's types/ci-results.ts: a name of 255, a
  // hundred checks, each of 200. Exactly that much is sent and no more.
  const longest = "c".repeat(200);
  const exactly = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(200, "x"));
  answers.github = repositorySaid("b".repeat(255), "everyone", [longest, ...exactly]);
  await runStep();
  assert.equal(sentBranch().name.length, 255);
  assert.equal(sentBranch().requiredChecks.length, 100);
  assert.equal(sentBranch().requiredChecks[0], longest);
});

test("leaves out a check whose name holds a line break or another control character, and keeps the rest", async () => {
  answers.github = repositorySaid("master", "everyone", ["two\nlines", "tab\there", "bell\u0007", "del\u007f", "Shippp / approved", "build (ubuntu-latest)"]);
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.deepEqual(sentBranch().requiredChecks, ["Shippp / approved", "build (ubuntu-latest)"]);
});

/** Shippp's answer for an approved commit, with what it read of the branch. */
const answered = (mergeWaits, over = {}) => [
  { status: 201, body: { stored: 3, verdict: verdict(over), names: NAMES, ...(mergeWaits === undefined ? {} : { mergeWaits }) } },
];

test("says whether a merge has to wait for the status, as Shippp read it: for everyone", async () => {
  answers.results = answered({ branch: "trunk", enforcement: "everyone" });
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^A merge into trunk has to wait for this status, whoever makes it\.$/m);
  assert.match(run.summary, /A merge into trunk has to wait for this status, whoever makes it\./);
  assert.doesNotMatch(run.out, /::warning/);
});

test("says an administrator is not held to it, where GitHub leaves administrators out", async () => {
  answers.results = answered({ branch: "master", enforcement: "except_administrators" });
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^A merge into master has to wait for this status, except an administrator's: an administrator can still push straight to master\.$/m);
  assert.doesNotMatch(run.out, /::warning/);
});

test("warns, on an approved commit too, when nothing makes a merge wait for the status", async () => {
  answers.results = answered({ branch: "master", enforcement: "not_required" });
  const run = await runStep();
  // Still the commit's own verdict: approved, and the job passes.
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^Shippp: approved \(commit/m);
  const line = "Nothing on GitHub makes a merge into master wait for this status. A commit Shippp has not approved can still be merged.";
  assert.ok(run.out.split(/\r?\n/).includes(line), run.out);
  assert.ok(run.out.split(/\r?\n/).includes("::warning title=Shippp / approved is not a required check::" + line), run.out);
  assert.ok(run.summary.includes(line));
});

test("says it for a commit that is not approved as well, and still fails the job", async () => {
  answers.results = answered({ branch: "master", enforcement: "not_required" }, { verdict: "not_approved", passes: false, blocking: [5] });
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^Nothing on GitHub makes a merge into master wait for this status\./m);
  assert.match(run.out, /::error title=Shippp did not approve this commit::/);
});

test("a branch's name cannot end the warning early or start a command of its own", async () => {
  answers.results = answered({ branch: "release,v2%0A::error::x", enforcement: "not_required" });
  const run = await runStep();
  const warnings = run.out.split(/\r?\n/).filter((l) => l.startsWith("::warning"));
  assert.equal(warnings.length, 1);
  // The name is in the message, where a comma is only a comma, and its
  // percent sign is written so a runner reads it as one.
  assert.match(warnings[0], /^::warning title=Shippp \/ approved is not a required check::Nothing on GitHub makes a merge into release,v2%250A::error::x wait/);
  assert.equal(run.out.split(/\r?\n/).filter((l) => l.startsWith("::error")).length, 0);
});

test("says nothing about merges when Shippp was not told, or says something this file does not know", async () => {
  for (const mergeWaits of [
    undefined,
    { branch: null, enforcement: "not_reported" },
    { branch: "master", enforcement: "some_new_word" },
    { branch: "master", enforcement: "constructor" },
    { branch: "master" },
  ]) {
    asked = [];
    answers.results = answered(mergeWaits);
    const run = await runStep();
    const label = JSON.stringify(mergeWaits);
    assert.equal(run.code, 0, label + run.out);
    // Neither in the log nor on the run's page, and nothing that is not a
    // sentence: a word such as "constructor" must not be looked up as if it
    // were one of the three answers.
    assert.doesNotMatch(run.out + run.summary, /A merge into|Nothing on GitHub makes|::warning|undefined|function/i, label);
  }
});

test("without a branch name in the answer, speaks of the default branch", async () => {
  answers.results = answered({ branch: null, enforcement: "everyone" });
  const run = await runStep();
  assert.match(run.out, /^A merge into the default branch has to wait for this status, whoever makes it\.$/m);
});

test("when GitHub does not answer about the branch, the commit is judged all the same and Shippp is told nothing of it", async () => {
  for (const github of [
    {},
    { "/repos/acme/shop": { status: 403, body: { message: "Resource not accessible by integration" } } },
    { "/repos/acme/shop": { status: 200, body: { default_branch: "master" } } },
    { "/repos/acme/shop": { status: 200, body: { default_branch: "master" } }, "/repos/acme/shop/branches/master": { status: 500, body: "not json" } },
    { "/repos/acme/shop": { status: 200, body: { full_name: "acme/shop" } } },
    { "/repos/acme/shop": { status: 200, body: { default_branch: "b".repeat(256) } } },
  ]) {
    asked = [];
    answers.results = [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
    answers.github = github;
    const run = await runStep();
    const label = JSON.stringify(github).slice(0, 80);
    assert.equal(run.code, 0, label + run.out);
    assert.match(run.out, /^Shippp: approved \(commit/m, label);
    assert.deepEqual(JSON.parse(posts()[0].body), { ...REPORT, scan: "passed" }, label);
    assert.match(run.out, /::notice title=Shippp::GitHub did not say which branch is the default one/, label);
  }
});

test("a name longer than Shippp takes is not sent, and that branch is not asked about", async () => {
  // GitHub answers for it here, so the only thing keeping it out of the
  // report is the step's own limit. One character under, it is sent.
  for (const [length, sent] of [
    [256, false],
    [255, true],
  ]) {
    asked = [];
    answers.results = [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
    answers.github = repositorySaid("b".repeat(length), "everyone", ["Shippp / approved"]);
    const run = await runStep();
    assert.equal(run.code, 0, length + run.out);
    assert.equal(reads().length, sent ? 2 : 1, String(length));
    assert.equal(sentBranch()?.name?.length, sent ? 255 : undefined, String(length));
  }
});

test("with nothing to read with, asks GitHub's API nothing and still reports", async () => {
  for (const missing of ["GITHUB_API_URL", "GITHUB_REPOSITORY", "GITHUB_TOKEN"]) {
    asked = [];
    answers.results = [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
    const run = await runStep({ [missing]: undefined });
    assert.equal(run.code, 0, missing + run.out);
    assert.deepEqual(reads(), [], missing);
    assert.deepEqual(JSON.parse(posts()[0].body), { ...REPORT, scan: "passed" }, missing);
  }
});

test("the token it reads with goes to GitHub only, and is never printed", async () => {
  const run = await runStep();
  assert.doesNotMatch(run.out + run.summary, new RegExp(READ_KEY));
  assert.doesNotMatch(posts()[0].body, new RegExp(READ_KEY));
  assert.equal(posts()[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(tokenAsks()[0].authorization, `bearer ${ASK_KEY}`);
});

test("says each layer by its name, with what it came to", async () => {
  const run = await runStep();
  assert.match(run.out, /^ {2}No stand-in code {5}Checked$/m);
  assert.match(run.out, /^ {2}Secret protection {4}Verified$/m);
  assert.match(run.out, /^ {2}Reversible upgrades {2}Nothing to check$/m);
  assert.doesNotMatch(run.out, /\blayer \d|Layer \d/);

  assert.match(run.summary, /^### Shippp: approved$/m);
  assert.match(run.summary, /^\| Secret protection \| Verified \|$/m);
});

test("never prints the token, except to tell GitHub to hide it", async () => {
  const run = await runStep();
  const lines = run.out.split(/\r?\n/).filter((l) => l.includes(TOKEN));
  assert.deepEqual(lines, [`::add-mask::${TOKEN}`]);
  assert.doesNotMatch(run.summary, new RegExp(TOKEN.slice(0, 20)));
  assert.doesNotMatch(run.out, new RegExp(ASK_KEY));
});

test("a commit let through by a founder's exception passes, and says so", async () => {
  answers.results = [
    {
      status: 201,
      body: {
        stored: 3,
        names: NAMES,
        verdict: verdict({
          verdict: "approved_with_exceptions",
          exceptions: 1,
          layers: [
            { layer: 2, state: "checked", status: "checked", waived: false, reportedLocally: false },
            { layer: 5, state: "founder_exception", status: "failed", waived: true, reportedLocally: false },
            { layer: 10, state: "checked", status: "checked", waived: false, reportedLocally: false },
          ],
        }),
      },
    },
  ];
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^Shippp: approved, with 1 founder exception \(commit/m);
  assert.match(run.out, /^ {2}Secret protection {4}Founder exception$/m);
  assert.doesNotMatch(run.out, /^Shippp: approved \(/m);
});

test("counts founder exceptions in the plural when there are two", async () => {
  answers.results = [
    { status: 201, body: { stored: 3, names: NAMES, verdict: verdict({ verdict: "approved_with_exceptions", exceptions: 2 }) } },
  ];
  const run = await runStep();
  assert.match(run.out, /^Shippp: approved, with 2 founder exceptions \(commit/m);
});

test("a commit that is not approved fails the job, and says which layers stand in the way", async () => {
  answers.results = [
    {
      status: 201,
      body: {
        stored: 3,
        names: NAMES,
        verdict: verdict({
          verdict: "not_approved",
          passes: false,
          blocking: [5, 10],
          layers: [
            { layer: 2, state: "checked", status: "checked", waived: false, reportedLocally: false },
            { layer: 5, state: "failed", status: "failed", waived: false, reportedLocally: false },
            { layer: 10, state: "blocked", status: "blocked", waived: false, reportedLocally: false },
          ],
        }),
      },
    },
  ];
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^Shippp: not approved \(commit/m);
  assert.match(run.out, /^ {2}Secret protection {4}Check failed$/m);
  assert.match(run.out, /^ {2}Reversible upgrades {2}Waiting: an earlier layer failed$/m);
  assert.match(run.out, /^::error title=Shippp did not approve this commit::/m);
  assert.match(run.summary, /^### Shippp: not approved$/m);
});

// The scan of the pushed commits. The scan job says one of three words; this
// step sends it beside the layers, and says what Shippp read it as.
const sentScan = () => JSON.parse(posts()[0].body).scan;

for (const word of ["passed", "credential_found", "not_scanned"]) {
  test(`sends what the scan job said, in its own word: ${word}`, async () => {
    await runStep({ SCAN: word });
    assert.equal(posts().length, 1);
    assert.equal(sentScan(), word);
  });
}

test("a scan job that ended without a word, or with one this file does not know, is sent as not scanned", async () => {
  for (const said of [undefined, "", " ", "success", "PASSED", "passed ", "true", "skipped", "constructor", "not_reported"]) {
    asked = [];
    answers.results = [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
    await runStep({ SCAN: said });
    assert.equal(sentScan(), "not_scanned", JSON.stringify(said));
  }
});

test("always says what its scan came to: a report is never sent without the word", async () => {
  // Shippp reads a report with no word as a commit nobody scanned. This
  // workflow has a scan job, so it always has something to say.
  for (const github of [{}, repositorySaid("trunk", "everyone", ["Shippp / approved"])]) {
    asked = [];
    answers.results = [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
    answers.github = github;
    await runStep();
    assert.ok(Object.hasOwn(JSON.parse(posts()[0].body), "scan"));
  }
});

const stoppedBy = (over) => [{ status: 201, body: { stored: 3, names: NAMES, verdict: verdict({ verdict: "not_approved", passes: false, ...over }) } }];

test("says the scan passed, on an approved commit, in the log and on the run's page", async () => {
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  const line = "Secret scan: the pushed commits were read, and no live credential was found.";
  assert.ok(run.out.split(/\r?\n/).includes(line), run.out);
  assert.ok(run.summary.includes(line));
});

test("a commit every layer of which cleared, stopped by a live credential: fails, and does not send anyone to look at layers", async () => {
  answers.results = stoppedBy({ blocking: [], scan: "credential_found" });
  const run = await runStep({ SCAN: "credential_found" });
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^Shippp: not approved \(commit/m);
  assert.match(run.out, /^Secret scan: a live credential is in the pushed commits\. The scan job says where\. Revoke it where it was issued, then run this again: a credential that no longer works is not reported\.$/m);
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.deepEqual(errors, ["::error title=Shippp did not approve this commit::Every layer cleared. The secret scan stands in the way: see the line above, and the scan job."]);
  assert.match(run.summary, /Secret scan: a live credential is in the pushed commits\./);
});

test("a commit stopped because its commits were not read says that, and that running again is the way on", async () => {
  answers.results = stoppedBy({ blocking: [], scan: "not_scanned" });
  const run = await runStep({ SCAN: "not_scanned" });
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^Secret scan: the pushed commits were not read, so nobody can say they hold no live credential\. The scan job says why\. Run this again\.$/m);
  assert.match(run.out, /^::error title=Shippp did not approve this commit::Every layer cleared\. The secret scan stands in the way/m);
});

test("stopped by layers and by the scan: says both", async () => {
  answers.results = stoppedBy({ blocking: [5], scan: "not_scanned" });
  const run = await runStep({ SCAN: "not_scanned" });
  assert.equal(run.code, 1, run.out);
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.deepEqual(errors, [
    "::error title=Shippp did not approve this commit::The layers above that did not pass stand in the way. Each one's own output is in the verify job. So does the secret scan: see the line above, and the scan job.",
  ]);
});

test("stopped by layers alone: the scan is said to have passed, and is not blamed", async () => {
  answers.results = stoppedBy({ blocking: [5], scan: "passed" });
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^Secret scan: the pushed commits were read, and no live credential was found\.$/m);
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.deepEqual(errors, ["::error title=Shippp did not approve this commit::The layers above that did not pass stand in the way. Each one's own output is in the verify job."]);
});

test("goes by what Shippp read the scan as, not by what this step sent", async () => {
  // Sent as passed, read as not reported: a server that did not take the
  // word. The commit is not approved and the step does not claim a scan.
  answers.results = stoppedBy({ blocking: [], scan: "not_reported" });
  const run = await runStep({ SCAN: "passed" });
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^Secret scan: Shippp was not told what it came to, and does not approve a commit nobody scanned\.$/m);
  assert.doesNotMatch(run.out, /no live credential was found/);
});

test("a word for the scan this file does not know, or none, is never said as a pass", async () => {
  for (const scan of ["something_from_a_later_version", "constructor", "toString", undefined, null, 7]) {
    asked = [];
    answers.results = stoppedBy({ blocking: [], scan });
    const run = await runStep();
    const label = JSON.stringify(scan);
    assert.equal(run.code, 1, label + run.out);
    assert.match(run.out, /^Secret scan: Shippp was not told what it came to/m, label);
    assert.doesNotMatch(run.out + run.summary, /no live credential was found|undefined|function/i, label);
    assert.match(run.out, /The secret scan stands in the way/, label);
  }
});

// Shippp's own files in the commit. The verify job's check says one of two
// words in the report it leaves; this step sends the report as it was
// written, and says what Shippp read the word as.
const sent = () => JSON.parse(posts()[0].body);
const reportSaying = (integrity) => {
  const report = { ...REPORT };
  if (integrity === undefined) delete report.integrity;
  else report.integrity = integrity;
  return Buffer.from(JSON.stringify(report)).toString("base64");
};
const INTACT = "Shippp's own files: the hooks in this commit are what Shippp installs.";
const CHANGED =
  "Shippp's own files: a hook, or another file Shippp installed, is not what Shippp installs. The verify job says which, and the command that puts it back.";
const NOT_SAID =
  "Shippp's own files: Shippp was not told whether they are what it installs, and does not approve a commit on a run that did not say. The verify job is where that is said.";

for (const word of ["intact", "changed"]) {
  test(`sends what the verify job said of Shippp's own files, in its own word: ${word}`, async () => {
    await runStep({ REPORT: reportSaying(word) });
    assert.equal(posts().length, 1);
    assert.equal(sent().integrity, word);
  });
}

test("a report with no word for them is sent as it is: its layers still reach Shippp, and nothing is said in its place", async () => {
  // What a project whose package is from before the check leaves.
  await runStep({ REPORT: reportSaying(undefined) });
  assert.equal(posts().length, 1);
  assert.equal(Object.hasOwn(sent(), "integrity"), false);
  assert.deepEqual(sent().layers, REPORT.layers);
});

test("a word this file does not know is left out, so that the layers are not refused with it", async () => {
  // Shippp refuses a whole report over one word it does not take. Left out,
  // the layers are kept and the commit is answered as one nobody vouched for.
  for (const said of ["", " ", "INTACT", "intact ", "ok", "passed", "true", true, 1, null, ["intact"], { word: "intact" }, "constructor", "not_reported"]) {
    asked = [];
    answers.results = [{ status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
    await runStep({ REPORT: reportSaying(said) });
    const label = JSON.stringify(said);
    assert.equal(posts().length, 1, label);
    assert.equal(Object.hasOwn(sent(), "integrity"), false, label);
    assert.deepEqual(sent().layers, REPORT.layers, label);
  }
});

test("never makes the word up: this step runs no check of its own, and says only what the verify job wrote", async () => {
  await runStep({ REPORT: reportSaying(undefined), SCAN: "passed" });
  assert.equal(sent().scan, "passed");
  assert.equal(Object.hasOwn(sent(), "integrity"), false);
});

test("says the files are what Shippp installs, on an approved commit, in the log and on the run's page", async () => {
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.ok(run.out.split(/\r?\n/).includes(INTACT), run.out);
  assert.ok(run.summary.includes(INTACT));
});

test("a commit every layer of which cleared and whose scan passed, stopped by changed files: fails, and does not send anyone to look at layers or the scan", async () => {
  answers.results = stoppedBy({ blocking: [], integrity: "changed" });
  const run = await runStep({ REPORT: reportSaying("changed") });
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^Shippp: not approved \(commit/m);
  assert.ok(run.out.split(/\r?\n/).includes(CHANGED), run.out);
  assert.ok(run.summary.includes(CHANGED));
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.deepEqual(errors, [
    "::error title=Shippp did not approve this commit::Every layer cleared. Shippp's own files stand in the way: see their line above, and the verify job.",
  ]);
  assert.doesNotMatch(errors[0], /secret scan/i);
});

test("stopped by layers and by the files: says both", async () => {
  answers.results = stoppedBy({ blocking: [5], integrity: "changed" });
  const run = await runStep({ REPORT: reportSaying("changed") });
  assert.equal(run.code, 1, run.out);
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.deepEqual(errors, [
    "::error title=Shippp did not approve this commit::The layers above that did not pass stand in the way. Each one's own output is in the verify job. So do Shippp's own files: see their line above, and the verify job.",
  ]);
});

test("stopped by the scan and by the files, with every layer clear: says both, and not the layers", async () => {
  answers.results = stoppedBy({ blocking: [], scan: "credential_found", integrity: "changed" });
  const run = await runStep({ SCAN: "credential_found", REPORT: reportSaying("changed") });
  assert.equal(run.code, 1, run.out);
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.deepEqual(errors, [
    "::error title=Shippp did not approve this commit::Every layer cleared. The secret scan stands in the way: see the line above, and the scan job. So do Shippp's own files: see their line above, and the verify job.",
  ]);
});

test("stopped by all three: says all three, once each", async () => {
  answers.results = stoppedBy({ blocking: [5, 10], scan: "not_scanned", integrity: "changed" });
  const run = await runStep({ SCAN: "not_scanned", REPORT: reportSaying("changed") });
  assert.equal(run.code, 1, run.out);
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.deepEqual(errors, [
    "::error title=Shippp did not approve this commit::The layers above that did not pass stand in the way. Each one's own output is in the verify job. So does the secret scan: see the line above, and the scan job. So do Shippp's own files: see their line above, and the verify job.",
  ]);
});

test("stopped by layers alone: the files are said to be what Shippp installs, and are not blamed", async () => {
  answers.results = stoppedBy({ blocking: [5] });
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.ok(run.out.split(/\r?\n/).includes(INTACT), run.out);
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.deepEqual(errors, ["::error title=Shippp did not approve this commit::The layers above that did not pass stand in the way. Each one's own output is in the verify job."]);
});

test("goes by what Shippp read of the files, not by what this step sent", async () => {
  // Sent as intact, read as not reported: a server that did not take the
  // word. The commit is not approved and the step does not claim the files.
  answers.results = stoppedBy({ blocking: [], integrity: "not_reported" });
  const run = await runStep({ REPORT: reportSaying("intact") });
  assert.equal(run.code, 1, run.out);
  assert.ok(run.out.split(/\r?\n/).includes(NOT_SAID), run.out);
  assert.doesNotMatch(run.out, /are what Shippp installs\.$/m);
  assert.match(run.out, /^::error title=Shippp did not approve this commit::Every layer cleared\. Shippp's own files stand in the way/m);
});

test("a word for the files this file does not know, or none, is never said as intact", async () => {
  for (const integrity of ["something_from_a_later_version", "constructor", "toString", "passed", undefined, null, 7]) {
    asked = [];
    answers.results = stoppedBy({ blocking: [], integrity });
    const run = await runStep();
    const label = JSON.stringify(integrity);
    assert.equal(run.code, 1, label + run.out);
    assert.ok(run.out.split(/\r?\n/).includes(NOT_SAID), label + run.out);
    assert.doesNotMatch(run.out + run.summary, /are what Shippp installs\.|undefined|function/i, label);
    assert.match(run.out, /Shippp's own files stand in the way/, label);
  }
});

test("a verdict that does not pass and names nothing in the way still fails, with a sentence", async () => {
  answers.results = stoppedBy({ verdict: "not_checked", blocking: [], scan: "passed" });
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^::error title=Shippp did not approve this commit::Shippp's answer for this commit is not an approval\.$/m);
});

test("goes by whether the verdict passes, not by the word it carries", async () => {
  // A verdict this step does not know the word for is not a pass.
  answers.results = [
    { status: 201, body: { stored: 3, names: NAMES, verdict: verdict({ verdict: "not_checked", passes: false }) } },
  ];
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^Shippp: not approved/m);
});

test("says every state a layer can come to in words, and an unknown one as not reported", async () => {
  const states = {
    verified: "Verified",
    checked: "Checked",
    not_applicable: "Nothing to check",
    failed: "Check failed",
    blocked: "Waiting: an earlier layer failed",
    manual_action_required: "Needs you: a check could not run",
    escalated: "Left unresolved",
    not_checked: "Not reported",
    founder_exception: "Founder exception",
    a_state_from_a_later_version: "Not reported",
  };
  const entries = Object.entries(states);
  answers.results = [
    {
      status: 201,
      body: {
        stored: entries.length,
        names: Object.fromEntries(entries.map(([state], i) => [100 + i, `Layer called ${state}`])),
        verdict: verdict({
          verdict: "not_approved",
          passes: false,
          layers: entries.map(([state], i) => ({ layer: 100 + i, state })),
        }),
      },
    },
  ];
  const run = await runStep();
  for (const [state, word] of entries) {
    assert.match(run.out, new RegExp(`^ {2}Layer called ${state} +${word}$`, "m"), state);
  }
});

test("calls a layer Shippp sent no name for a layer of the check, never a number", async () => {
  answers.results = [{ status: 201, body: { stored: 3, verdict: verdict() } }];
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^ {2}A layer of the check {2}Checked$/m);
  assert.doesNotMatch(run.out, /^ {2}(2|5|10)\b/m);
});

test("with no result from the layer check, fails without asking anyone anything", async () => {
  for (const REPORT_GIVEN of ["", "not base64 json", Buffer.from("{}").toString("base64"), Buffer.from('{"layers":[]}').toString("base64")]) {
    asked = [];
    const run = await runStep({ REPORT: REPORT_GIVEN });
    assert.equal(run.code, 1, REPORT_GIVEN);
    assert.match(run.out, /The layer check left no result for this commit/, REPORT_GIVEN);
    assert.deepEqual(asked, [], REPORT_GIVEN);
  }
});

test("without leave to ask GitHub for a token, fails saying what the calling job needs, and sends nothing", async () => {
  for (const missing of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) {
    asked = [];
    const run = await runStep({ [missing]: undefined });
    assert.equal(run.code, 1, missing);
    assert.match(run.out, /needs `permissions: id-token: write`/, missing);
    assert.deepEqual(asked, [], missing);
  }
});

test("when GitHub gives no token, fails and sends nothing to Shippp", async () => {
  for (const token of [
    { status: 500, body: { message: "no" } },
    // A refusal is a refusal whatever came with it.
    { status: 500, body: { value: TOKEN } },
    { status: 200, body: {} },
    { status: 200, body: { value: "" } },
    { status: 200, body: "not json" },
  ]) {
    asked = [];
    answers.token = token;
    const run = await runStep();
    assert.equal(run.code, 1, JSON.stringify(token));
    assert.match(run.out, /GitHub did not give this run an identity token/);
    assert.equal(posts().length, 0);
  }
});

for (const [status, error] of [
  [401, "Not a GitHub Actions identity token Shippp accepts."],
  [403, "This job did not run a workflow Shippp accepts results from. Results count only from Shippp's own workflow, called from the project's."],
  [403, "This project is linked to a different repository from the one this job ran in."],
  [404, "This project has no repository linked to it. Its founder links one, signed in to Shippp."],
  [409, "This run attempt has already reported. Re-run the job to report again."],
  [422, "Send a report of the layers this run checked"],
  [429, "Rate limit exceeded"],
  [500, "Something went wrong"],
]) {
  test(`when Shippp refuses with ${status}, fails with Shippp's own sentence and does not ask twice: ${error.slice(0, 40)}`, async () => {
    answers.results = [{ status, body: { error } }];
    const run = await runStep();
    assert.equal(run.code, 1, run.out);
    assert.ok(run.out.includes(`::error title=Shippp did not approve this commit::${error}`), run.out);
    assert.doesNotMatch(run.out, /^Shippp: approved/m);
    assert.equal(posts().length, 1);
  });
}

test("a refusal with no sentence in it still fails, naming the status", async () => {
  answers.results = [{ status: 418, body: "not json at all" }];
  const run = await runStep();
  assert.equal(run.code, 1);
  assert.match(run.out, /Shippp answered 418\./);
});

test("an answer of 201 with no verdict in it is not an approval", async () => {
  answers.results = [{ status: 201, body: { stored: 3 } }];
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.doesNotMatch(run.out, /^Shippp: approved/m);
  // Said as what it is, and not as the step having broken.
  assert.match(run.out, /::error title=Shippp did not approve this commit::Shippp answered 201\./);
  assert.doesNotMatch(run.out, /stopped before it had an answer/);
});

test("an approval that arrives with any status but 201 is not one", async () => {
  answers.results = [{ status: 200, body: { stored: 3, verdict: verdict(), names: NAMES } }];
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.doesNotMatch(run.out, /^Shippp: approved/m);
});

test("asks again when Shippp says it may succeed later, with the same token and report", async () => {
  answers.results = [
    { status: 503, headers: { "retry-after": "0" }, body: { error: "Shippp could not fetch GitHub's signing keys to check this token. Run the job again." } },
    { status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } },
  ];
  const run = await runStep();
  assert.equal(run.code, 0, run.out);
  assert.equal(posts().length, 2);
  assert.equal(posts()[1].authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(posts()[1].body), { ...REPORT, scan: "passed", defaultBranch: BRANCH });
  assert.equal(posts()[1].body, posts()[0].body);
  assert.equal(tokenAsks().length, 1);
  // GitHub is asked about the branch once, not once for each try.
  assert.equal(reads().length, 2);
});

test("gives up after three tries, with what Shippp said", async () => {
  const later = { status: 503, headers: { "retry-after": "0" }, body: { error: "Shippp could not fetch GitHub's signing keys to check this token. Run the job again." } };
  answers.results = [later, later, later, { status: 201, body: { stored: 3, verdict: verdict(), names: NAMES } }];
  const run = await runStep();
  assert.equal(run.code, 1, run.out);
  assert.equal(posts().length, 3);
  assert.match(run.out, /could not fetch GitHub's signing keys/);
});

test("when Shippp cannot be reached at all, fails saying the commit was not judged", { timeout: 60_000 }, async () => {
  // A port nothing listens on: opened, read, closed.
  const closed = await new Promise((done) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
  const run = await runStep({ SHIPPP_RESULTS_URL: `http://127.0.0.1:${closed}/results` });
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /Shippp could not be reached, so this commit was not judged\./);
  assert.doesNotMatch(run.out, /^Shippp: approved/m);
});
