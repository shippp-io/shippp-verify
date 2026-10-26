// The scan of the pushed commits, run for real.
//
// The scan job has three steps, and each is taken out of verify.yml as GitHub
// would hand it to its shell, written to a file of its own, and run as a
// separate process:
//
//   range     which commits were pushed (bash and git);
//   scanner   the scanner over them (bash and docker, the image pinned);
//   decide    what the scan came to, in one of three words (Node).
//
// Every repository here is a real one, made with git in a folder of its own.
// Every scanner result is the real scanner's: nothing answers in its place.
// The string the tests plant is made when they run, so it is in no file of
// this repository, and it is a pattern only this workflow looks for.
//
// WHERE EACH PART RUNS
//
// `range` needs bash and git. `decide` needs what a scanner wrote, so it
// needs a scanner: docker, or the scanner's own program named in
// SHIPPP_TEST_SCANNER. The `scanner` step itself is one docker command and
// runs only where docker does, which is this repository's own CI. Where a
// part cannot run it is skipped and says so: it is never passed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = fs
  .readFileSync(path.join(HERE, "../.github/workflows/verify.yml"), "utf8")
  .replace(/\r\n/g, "\n");

/** The scan job's lines: from its name to the next job's. */
function scanJob() {
  const start = WORKFLOW.indexOf("\n  scan:\n");
  assert.notEqual(start, -1, "the scan job is in the workflow");
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** One step of the scan job, by its id: its lines, and the script under `run: |`. */
function step(id) {
  const job = scanJob();
  const at = job.indexOf(`        id: ${id}\n`);
  assert.notEqual(at, -1, `the scan job has a step with id ${id}`);
  const from = job.lastIndexOf("\n      - ", at) + 1;
  const end = job.indexOf("\n      - ", at);
  const text = end === -1 ? job.slice(from) : job.slice(from, end + 1);
  const run = text.indexOf("        run: |\n");
  assert.notEqual(run, -1, `step ${id} has a script`);
  const body = [];
  for (const line of text.slice(run + "        run: |\n".length).split("\n")) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return { text, script: body.join("\n") };
}

const RANGE = step("range");
const SCANNER = step("scanner");
const DECIDE = step("decide");

/** The image the workflow runs, as the file names it. */
const IMAGE = /^ {10}SCANNER: (\S+)$/m.exec(SCANNER.text)?.[1] ?? "";
/** The scanner's settings, as the step writes them to a file. */
const CONFIG = /<<'CONFIG'\n([\s\S]*?)\nCONFIG\n/.exec(SCANNER.script)?.[1] ?? "";

const has = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return !r.error && r.status === 0;
};
const BASH = has("bash", ["--version"]);
const DOCKER = has("docker", ["version"]);
const PROGRAM = process.env.SHIPPP_TEST_SCANNER ?? "";
const CAN_SCAN = DOCKER || (PROGRAM !== "" && fs.existsSync(PROGRAM));
const NO_BASH = BASH ? false : "bash is not on this machine";
const NO_SCANNER = CAN_SCAN ? NO_BASH : "no scanner here: needs docker, or the scanner's program named in SHIPPP_TEST_SCANNER";
const NO_DOCKER = DOCKER ? NO_BASH : "docker is not on this machine: the scanner step runs in this repository's CI";

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shippp-scan-job-"));
  fs.writeFileSync(path.join(root, "range.sh"), RANGE.script);
  fs.writeFileSync(path.join(root, "scanner.sh"), SCANNER.script);
  fs.writeFileSync(path.join(root, "decide.js"), DECIDE.script);
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ── real repositories ──────────────────────────────────────────────────────

const forward = (p) => p.split(path.sep).join("/");
let made = 0;
/** A new folder under the tests' own. */
const folder = (name) => {
  const dir = path.join(root, `${name}-${++made}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function git(cwd, ...args) {
  const r = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.hooksPath=", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository with one commit, and a way to add more. */
function repository() {
  const dir = folder("repo");
  git(dir, "init", "-q", "-b", "trunk", ".");
  const commit = (files, message = "a change") => {
    for (const [name, text] of Object.entries(files)) {
      if (text === null) fs.rmSync(path.join(dir, name));
      else {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  const first = commit({ "README.md": "# A project\n" }, "first");
  return { dir, first, commit };
}

/** A string only this workflow looks for, made now, so it is in no file here. */
const canary = () => "shippp_canary_" + crypto.randomBytes(16).toString("hex");
const NONE = "0".repeat(40);

// ── running the steps ──────────────────────────────────────────────────────

/** What a step wrote for the steps after it. */
function outputs(file) {
  const said = {};
  if (!fs.existsSync(file)) return said;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) said[line.slice(0, at)] = line.slice(at + 1);
  }
  return said;
}

const baseEnv = () => ({ PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE });

/** The range step, as a runner runs a bash step. */
function range(dir, { before: BEFORE, pushed: PUSHED }) {
  const out = path.join(folder("out"), "range.txt");
  const env = { ...baseEnv(), BEFORE, PUSHED, GITHUB_OUTPUT: forward(out) };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", forward(path.join(root, "range.sh"))], { cwd: dir, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr, ...outputs(out) };
}

/** The flags the workflow gives the scanner, after the repository. */
const FLAGS = ["--json", "--no-update", "--fail-on-scan-errors"];

/**
 * The real scanner over a repository, writing the two files the decide step
 * reads. With docker, the workflow's own image; without, the same scanner's
 * program. `settings` is the scanner's settings file, the workflow's own
 * unless a test adds a detector to it.
 */
function scan(dir, { since, pushed, settings = CONFIG }) {
  const temp = folder("runner-temp");
  const config = path.join(temp, "shippp-scan.yml");
  fs.writeFileSync(config, settings + "\n");
  const range = ["--branch", pushed, ...(since ? ["--since-commit", since] : [])];
  const [program, args] = DOCKER
    ? ["docker", ["run", "--rm", "--network", "host", "-v", `${dir}:/repo:ro`, "-v", `${config}:/shippp-scan.yml:ro`, IMAGE, "git", "file:///repo", ...range, ...FLAGS, "--config", "/shippp-scan.yml"]]
    : [PROGRAM, ["git", "file://" + forward(dir), ...range, ...FLAGS, "--config", config]];
  // Not waited for in place: while the scanner runs, this process has to be
  // free to answer it, when a test has it ask a server here whether what it
  // found works.
  return new Promise((done, failed) => {
    const out = fs.openSync(path.join(temp, "shippp-scan.out"), "w");
    const log = fs.openSync(path.join(temp, "shippp-scan.log"), "w");
    const child = spawn(program, args, { stdio: ["ignore", out, log] });
    const closed = () => [out, log].forEach((file) => fs.closeSync(file));
    child.on("error", (err) => (closed(), failed(err)));
    child.on("close", (code) => (closed(), done({ temp, exit: String(code) })));
  });
}

/** The decide step, as a runner runs a Node step. */
function decide({ temp, commits, exit }) {
  const out = path.join(folder("out"), "decide.txt");
  const summary = path.join(folder("out"), "summary.md");
  const env = { ...baseEnv(), RUNNER_TEMP: temp, COMMITS: commits, SCANNER_EXIT: exit, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const r = spawnSync(process.execPath, [path.join(root, "decide.js")], { env, encoding: "utf8" });
  return {
    code: r.status,
    out: r.stdout + r.stderr,
    summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
    outcome: outputs(out).outcome,
  };
}

/** Range, the real scanner, then decide: the job, with the harness's scanner call. */
async function job(dir, pushedRange, settings) {
  const r = range(dir, pushedRange);
  assert.equal(r.code, 0, r.out);
  const s = await scan(dir, { since: r.since, pushed: pushedRange.pushed, settings });
  return { ...decide({ temp: s.temp, commits: r.commits, exit: s.exit }), range: r, temp: s.temp };
}

// ── the steps were found ───────────────────────────────────────────────────

test("the three steps were found in the workflow, whole", () => {
  assert.ok(RANGE.script.length > 300, "range");
  assert.ok(SCANNER.script.length > 300, "scanner");
  assert.ok(DECIDE.script.length > 1500, "decide");
  assert.match(RANGE.script, /git rev-list --count/);
  assert.match(SCANNER.script, /docker run/);
  assert.match(DECIDE.script, /^const fs = require\("fs"\);/);
  // It ends by itself, as the step that asks Shippp does.
  assert.doesNotMatch(DECIDE.script, /process\.exit\(/);
  assert.match(DECIDE.text, /\n {8}shell: node \{0\}\n/);
  assert.match(CONFIG, /shippp_canary_/);
});

test("the scanner is one exact image, named by what it holds and not by a tag that can move", () => {
  assert.match(IMAGE, /^ghcr\.io\/trufflesecurity\/trufflehog@sha256:[0-9a-f]{64}$/);
  // The one place in the file an image is named.
  assert.equal(WORKFLOW.match(/trufflehog/g).length, 1);
  assert.doesNotMatch(WORKFLOW, /trufflehog@(main|master|latest|v\d)/);
  assert.doesNotMatch(WORKFLOW, /trufflehog:[\w.]+/);
});

test("the scanner is given the repository to read and not to write, and the flags the tests give it", () => {
  assert.match(SCANNER.script, /-v "\$PWD:\/repo:ro"/);
  assert.match(SCANNER.script, /"\$SCANNER" git file:\/\/\/repo/);
  assert.match(SCANNER.script, /--branch "\$PUSHED" \$\{SINCE:\+--since-commit "\$SINCE"\}/);
  for (const flag of FLAGS) assert.ok(SCANNER.script.includes(flag), flag);
  assert.match(SCANNER.script, /--config \/shippp-scan\.yml/);
  // Every result is asked for. Which ones stop a commit is decided by the
  // next step: a filter here would drop the pattern the tests plant.
  assert.doesNotMatch(SCANNER.script, /--results|--only-verified|--no-verification/);
  // What it found goes to two files and nowhere a log shows.
  assert.match(SCANNER.script, /> "\$RUNNER_TEMP\/shippp-scan\.out" 2> "\$RUNNER_TEMP\/shippp-scan\.log"/);
  assert.match(SCANNER.script, /echo "exit=\$\?" >> "\$GITHUB_OUTPUT"/);
  // The scanner ending badly must not end the step: its result is written
  // down for the next step, which is the one that says what it means.
  assert.match(SCANNER.script, /\nset \+e\ndocker run /);
  assert.match(SCANNER.script, /2> "\$RUNNER_TEMP\/shippp-scan\.log"\necho "exit=\$\?"/);
  assert.doesNotMatch(SCANNER.script, /\bcat\b[^\n]*shippp-scan\.(out|log)/);
});

// ── which commits were pushed ──────────────────────────────────────────────

test("an ordinary push: the commits since the one the branch was at", { skip: NO_BASH }, () => {
  const repo = repository();
  repo.commit({ "a.txt": "one\n" });
  const pushed = repo.commit({ "b.txt": "two\n" });
  const r = range(repo.dir, { before: repo.first, pushed });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.since, repo.first);
  assert.equal(r.commits, "2");
});

test("a merge that was pushed: the commits it brought in are counted with it", { skip: NO_BASH }, () => {
  const repo = repository();
  git(repo.dir, "checkout", "-q", "-b", "feature");
  repo.commit({ "f1.txt": "one\n" });
  repo.commit({ "f2.txt": "two\n" });
  git(repo.dir, "checkout", "-q", "trunk");
  git(repo.dir, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  const pushed = git(repo.dir, "rev-parse", "HEAD");
  const r = range(repo.dir, { before: repo.first, pushed });
  assert.equal(r.since, repo.first);
  assert.equal(r.commits, "3");
});

for (const [why, beforeOf] of [
  ["a new branch, which GitHub gives no commit before", () => NONE],
  ["an event that names no commit before", () => ""],
  ["no word about before at all", () => undefined],
  ["a commit before that is not in the repository (the branch was rewritten)", () => "1".repeat(40)],
  ["something before that is not a commit id", () => "trunk"],
  ["an option where the commit before should be", () => "--all"],
]) {
  test(`every commit the pushed one grew from, for ${why}`, { skip: NO_BASH }, () => {
    const repo = repository();
    repo.commit({ "a.txt": "one\n" });
    const pushed = repo.commit({ "b.txt": "two\n" });
    const r = range(repo.dir, { before: beforeOf(), pushed });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.since, "");
    assert.equal(r.commits, "3");
  });
}

test("a shortened commit id, or a branch's name, is not taken for the commit before: only a whole id is", { skip: NO_BASH }, () => {
  // Git would follow either to a commit. GitHub sends a whole id or forty
  // zeros, so anything else did not come from GitHub's account of the push.
  const repo = repository();
  repo.commit({ "a.txt": "one\n" });
  git(repo.dir, "branch", "feed", repo.first);
  const pushed = repo.commit({ "b.txt": "two\n" });
  for (const before of [repo.first.slice(0, 12), repo.first.slice(0, 39), repo.first + "0", repo.first.toUpperCase(), "feed", "HEAD~2"]) {
    const r = range(repo.dir, { before, pushed });
    assert.equal(r.code, 0, before + r.out);
    assert.equal(r.since, "", before);
    assert.equal(r.commits, "3", before);
  }
});

test("every commit, when the commit before is here but the pushed one did not grow from it", { skip: NO_BASH }, () => {
  const repo = repository();
  git(repo.dir, "checkout", "-q", "-b", "old-tip");
  const old = repo.commit({ "old.txt": "was here\n" });
  git(repo.dir, "checkout", "-q", "trunk");
  const pushed = repo.commit({ "new.txt": "is here\n" });
  const r = range(repo.dir, { before: old, pushed });
  assert.equal(r.since, "");
  assert.equal(r.commits, "2");
});

test("runs nothing that is written where the commit before should be", { skip: NO_BASH }, () => {
  const repo = repository();
  const pushed = repo.commit({ "a.txt": "one\n" });
  for (const before of ["$(touch made-by-before)", "`touch made-by-before`", "x; touch made-by-before", "x && touch made-by-before"]) {
    const r = range(repo.dir, { before, pushed });
    assert.equal(r.code, 0, before + r.out);
    assert.equal(r.since, "", before);
  }
  assert.equal(fs.existsSync(path.join(repo.dir, "made-by-before")), false);
});

test("fails, and says how many commits to nobody, when the pushed commit is not in the repository", { skip: NO_BASH }, () => {
  const repo = repository();
  const r = range(repo.dir, { before: repo.first, pushed: "2".repeat(40) });
  assert.notEqual(r.code, 0);
  assert.equal(r.commits, undefined);
});

// ── what the scan came to, on what the real scanner wrote ──────────────────

test("a pushed commit holding the pattern: credential found, the job fails, and says where without saying what", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const planted = canary();
  const pushed = repo.commit({ "src/settings.js": `const mode = "live";\nconst note = "${planted}";\n` });
  const run = await job(repo.dir, { before: repo.first, pushed });

  assert.equal(run.outcome, "credential_found", run.out);
  assert.equal(run.code, 1, run.out);
  // Said as what it is: Shippp's own pattern, which no service issued. A
  // founder is not told to revoke something there is nothing to revoke of.
  assert.match(run.out, /^::error title=Shippp found its own test pattern in the pushed commits::This is the string Shippp's tests plant/m);
  assert.match(run.out, /^Secret scan: Shippp's own test pattern is in the pushed commits\.$/m);
  assert.doesNotMatch(run.out + run.summary, /Revoke it|live credential/);
  // Where: the file, the line and the commit.
  assert.ok(run.out.includes("src/settings.js, line 2, commit " + pushed.slice(0, 12)), run.out);
  // Never what. Not in the log, not on the run's page.
  assert.ok(!run.out.includes(planted), "the value is not in the log");
  assert.ok(!run.summary.includes(planted), "nor on the run's page");
  assert.ok(!(run.out + run.summary).includes(planted.slice(-12)), "nor the end of it");
  assert.match(run.summary, /^### Shippp: its own test pattern is in the pushed commits$/m);
});

test("a clean push: passed, and says how much was read", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  repo.commit({ "a.txt": "one\ntwo\n" });
  const pushed = repo.commit({ "b.txt": "three\n" });
  const run = await job(repo.dir, { before: repo.first, pushed });

  assert.equal(run.outcome, "passed", run.out);
  assert.equal(run.code, 0, run.out);
  const said = /^Secret scan: read (\d+) bytes of 2 commits\. No live credential was found\.$/m.exec(run.out);
  assert.ok(said, run.out);
  assert.ok(Number(said[1]) > 0);
  assert.doesNotMatch(run.out, /::error|::warning/);
});

test("one commit is said as one commit", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const pushed = repo.commit({ "a.txt": "one\n" });
  const run = await job(repo.dir, { before: repo.first, pushed });
  assert.match(run.out, /^Secret scan: read \d+ bytes of 1 commit\. No live credential was found\.$/m);
});

test("reads the commits that were pushed and no others: the pattern in an older commit does not stop this push", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const old = repo.commit({ "old.txt": canary() + "\n" });
  const pushed = repo.commit({ "new.txt": "nothing to see\n" });
  const run = await job(repo.dir, { before: old, pushed });
  assert.equal(run.outcome, "passed", run.out);
});

test("and when it cannot tell which were pushed it reads them all, and finds it", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  repo.commit({ "old.txt": canary() + "\n" });
  const pushed = repo.commit({ "new.txt": "nothing to see\n" });
  const run = await job(repo.dir, { before: NONE, pushed });
  assert.equal(run.range.since, "");
  assert.equal(run.outcome, "credential_found", run.out);
  assert.ok(run.out.includes("old.txt, line 1"), run.out);
});

test("the pattern removed again in a later commit of the same push is still found: it was pushed", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  repo.commit({ "oops.txt": canary() + "\n" });
  const pushed = repo.commit({ "oops.txt": null }, "take it out again");
  const run = await job(repo.dir, { before: repo.first, pushed });
  assert.equal(run.outcome, "credential_found", run.out);
});

test("names every place, each once, for two findings in one push", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const pushed = repo.commit({ "one.txt": canary() + "\n", "two.txt": "x\n" + canary() + "\n" });
  const run = await job(repo.dir, { before: repo.first, pushed });
  assert.equal(run.outcome, "credential_found", run.out);
  assert.equal(run.out.split(/\r?\n/).filter((l) => /^ {2}\S.*, line \d+, commit [0-9a-f]{12}$/.test(l)).length, 2, run.out);
  assert.ok(run.out.includes("one.txt, line 1"));
  assert.ok(run.out.includes("two.txt, line 2"));
});

// A file's name is the project's to choose, and on Linux it can hold a line
// break. Printed as it is, the rest of the name would start a line of its
// own, which a runner reads as a command.
const NO_SUCH_NAME = process.platform === "win32" ? "this file system cannot hold a line break in a file's name" : NO_SCANNER;
test("a file's name cannot start a line, and so a command, of its own in the log", { skip: NO_SUCH_NAME }, async () => {
  const repo = repository();
  const pushed = repo.commit({ "x\n::error title=made up::by a file name.txt": canary() + "\n" });
  const run = await job(repo.dir, { before: repo.first, pushed });
  assert.equal(run.outcome, "credential_found", run.out);
  const errors = run.out.split(/\r?\n/).filter((l) => l.startsWith("::error"));
  assert.equal(errors.length, 1, run.out);
  assert.match(errors[0], /^::error title=Shippp found its own test pattern in the pushed commits::/);
});

// A credential the scanner itself tried and found working. No real service
// is asked: the test adds a detector of its own to the scanner's settings,
// and the scanner asks a server on this machine whether what it found works.
// That is the scanner's own way of deciding "live", run for real.
let verifier;
let verifierUrl;
let live = new Set();
before(async () => {
  verifier = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead([...live].some((value) => raw.includes(value)) ? 200 : 401);
      res.end();
    });
  });
  await new Promise((done) => verifier.listen(0, "127.0.0.1", done));
  verifierUrl = `http://127.0.0.1:${verifier.address().port}/works`;
});
after(async () => {
  await new Promise((done) => verifier.close(done));
});
const withLiveDetector = () =>
  CONFIG +
  [
    "",
    "  - name: TestKey",
    "    keywords:",
    "      - testkey_",
    "    regex:",
    "      key: testkey_[0-9a-f]{32}",
    "    verify:",
    `      - endpoint: ${verifierUrl}`,
    "        unsafe: true",
  ].join("\n");
const testKey = () => "testkey_" + crypto.randomBytes(16).toString("hex");

test("a credential the scanner tried and found working: credential found, named by its kind, never by its value", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const working = testKey();
  live = new Set([working]);
  const pushed = repo.commit({ "deploy/env.txt": `API_KEY=${working}\n` });
  const run = await job(repo.dir, { before: repo.first, pushed }, withLiveDetector());

  assert.equal(run.outcome, "credential_found", run.out);
  assert.equal(run.code, 1, run.out);
  assert.ok(run.out.includes("TestKey in deploy/env.txt, line 1, commit " + pushed.slice(0, 12)), run.out);
  // And what to do about it: the one thing that makes it stop being found.
  assert.match(run.out, /^Secret scan: 1 live credential in the pushed commits\.$/m);
  assert.match(
    run.out,
    /^::error title=Shippp found a live credential in the pushed commits::The scanner tried what it found against the service it belongs to, and it works\. Revoke it where it was issued, then run this job again/m,
  );
  assert.match(run.summary, /^### Shippp: a live credential is in the pushed commits$/m);
  assert.doesNotMatch(run.out + run.summary, /test pattern/);
  assert.ok(!(run.out + run.summary).includes(working));
});

test("a string that looks like a key and does not work does not stop the commit, and is counted, not shown", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const dead = testKey();
  live = new Set();
  const pushed = repo.commit({ "docs/example.txt": `API_KEY=${dead}\n` });
  const run = await job(repo.dir, { before: repo.first, pushed }, withLiveDetector());

  assert.equal(run.outcome, "passed", run.out);
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^::notice title=Shippp::1 string in the pushed commits looks like a credential and did not work when tried, or could not be tried\. It does not stop this commit\.$/m);
  assert.ok(!(run.out + run.summary).includes(dead));
  assert.ok(!run.out.includes("docs/example.txt"), "where it is, is not said either");
});

test("one that works among ones that do not: found, and only the working one is named", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const working = testKey();
  live = new Set([working]);
  const pushed = repo.commit({ "a.txt": `k=${testKey()}\n`, "b.txt": `k=${working}\n`, "c.txt": `k=${testKey()}\n` });
  const run = await job(repo.dir, { before: repo.first, pushed }, withLiveDetector());
  assert.equal(run.outcome, "credential_found", run.out);
  assert.ok(run.out.includes("b.txt, line 1"));
  assert.ok(!run.out.includes("a.txt"));
  assert.ok(!run.out.includes("c.txt"));
});

// ── a scan that did not do its job is not a pass ───────────────────────────

test("a scanner that read nothing of commits that were pushed: not scanned, and the job fails", { skip: NO_SCANNER }, async () => {
  // The state the forensic review found (H-6): the scanner ran, ended well,
  // and had read 0 bytes. Asked here for the commits after the pushed one,
  // which is none, while two were pushed.
  const repo = repository();
  repo.commit({ "a.txt": "one\n" });
  const pushed = repo.commit({ "b.txt": canary() + "\n" });
  const s = await scan(repo.dir, { since: pushed, pushed });
  assert.equal(s.exit, "0", "the scanner itself ends well");
  const run = decide({ temp: s.temp, commits: "2", exit: s.exit });

  assert.equal(run.outcome, "not_scanned", run.out);
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^::error title=Shippp could not scan the pushed commits::The scanner read 0 bytes of 2 commits\./m);
  assert.doesNotMatch(run.out, /No live credential was found/);
});

test("a scanner that could not read the commits it was asked for: not scanned", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const pushed = repo.commit({ "a.txt": "one\n" });
  const s = await scan(repo.dir, { since: "1".repeat(40), pushed });
  assert.notEqual(s.exit, "0");
  const run = decide({ temp: s.temp, commits: "1", exit: s.exit });
  assert.equal(run.outcome, "not_scanned", run.out);
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /^::error title=Shippp could not scan the pushed commits::The scanner did not finish/m);
});

test("a scanner that ended badly after reading is still not a pass", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const pushed = repo.commit({ "a.txt": "one\n" });
  const s = await scan(repo.dir, { since: repo.first, pushed });
  assert.equal(s.exit, "0");
  for (const exit of ["1", "137", "", undefined, "zero"]) {
    const run = decide({ temp: s.temp, commits: "1", exit });
    assert.equal(run.outcome, "not_scanned", String(exit) + run.out);
    assert.equal(run.code, 1, String(exit));
  }
});

test("without knowing how many commits were pushed, a scan cannot be called a pass", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const pushed = repo.commit({ "a.txt": "one\n" });
  const s = await scan(repo.dir, { since: repo.first, pushed });
  for (const commits of ["", undefined, "many", "-1", "1.5", " "]) {
    const run = decide({ temp: s.temp, commits, exit: s.exit });
    assert.equal(run.outcome, "not_scanned", String(commits) + run.out);
    assert.equal(run.code, 1, String(commits));
    assert.match(run.out, /could not work out which commits were pushed/);
  }
});

test("what the scanner wrote, cut short, is not read as nothing found", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const pushed = repo.commit({ "a.txt": canary() + "\n" });
  const s = await scan(repo.dir, { since: repo.first, pushed });
  const whole = fs.readFileSync(path.join(s.temp, "shippp-scan.out"), "utf8");
  assert.ok(whole.trim().startsWith("{"), "the scanner wrote a finding");
  // Half a line: what a full disk or a killed process leaves.
  fs.writeFileSync(path.join(s.temp, "shippp-scan.out"), whole.slice(0, Math.floor(whole.length / 2)));
  const run = decide({ temp: s.temp, commits: "1", exit: s.exit });
  assert.equal(run.outcome, "not_scanned", run.out);
  assert.equal(run.code, 1);
});

test("a working credential and Shippp's pattern in one push: said as a live credential, counted as one, both places named", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const works = testKey();
  live = new Set([works]);
  const pushed = repo.commit({ "env.txt": `K=${works}\n`, "notes.txt": canary() + "\n" });
  const run = await job(repo.dir, { before: repo.first, pushed }, withLiveDetector());
  assert.equal(run.outcome, "credential_found", run.out);
  assert.match(run.out, /^Secret scan: 1 live credential in the pushed commits\.$/m);
  assert.match(run.out, /^::error title=Shippp found a live credential in the pushed commits::/m);
  assert.ok(run.out.includes("TestKey in env.txt, line 1"), run.out);
  assert.ok(run.out.includes("Shippp's test pattern in notes.txt, line 1"), run.out);
});

test("a working credential it wrote down is said as one even when the scanner never said it had finished", { skip: NO_SCANNER }, async () => {
  // The finding is there and the scanner's closing count is not: a scanner
  // that was stopped after it found something. It still found it.
  const repo = repository();
  const works = testKey();
  live = new Set([works]);
  const pushed = repo.commit({ "env.txt": `K=${works}\n` });
  const s = await scan(repo.dir, { since: repo.first, pushed, settings: withLiveDetector() });
  fs.writeFileSync(path.join(s.temp, "shippp-scan.log"), "");
  const run = decide({ temp: s.temp, commits: "1", exit: "137" });
  assert.equal(run.outcome, "credential_found", run.out);
  assert.match(run.out, /^Secret scan: 1 live credential in the pushed commits\.$/m);
  assert.match(run.out, /^::error title=Shippp found a live credential in the pushed commits::/m);
});

test("the scanner's own count of working credentials is believed even when its findings are gone", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const working = testKey();
  live = new Set([working]);
  const pushed = repo.commit({ "env.txt": `K=${working}\n` });
  const s = await scan(repo.dir, { since: repo.first, pushed, settings: withLiveDetector() });
  fs.writeFileSync(path.join(s.temp, "shippp-scan.out"), "");
  const run = decide({ temp: s.temp, commits: "1", exit: s.exit });
  assert.equal(run.outcome, "credential_found", run.out);
  assert.equal(run.code, 1);
  // And as a working credential, which is what the scanner counted.
  assert.match(run.out, /^::error title=Shippp found a live credential in the pushed commits::/m);
});

test("with nothing from a scanner at all, not scanned: no step needs a scanner to say so", () => {
  for (const exit of ["0", "", undefined]) {
    const run = decide({ temp: folder("empty-temp"), commits: "3", exit });
    assert.equal(run.outcome, "not_scanned", run.out);
    assert.equal(run.code, 1, run.out);
    // Said as what it is, and not as this step having broken.
    assert.match(run.out, /^::error title=Shippp could not scan the pushed commits::The scanner did not finish reading the pushed commits\./m);
    assert.match(run.summary, /^### Shippp: the pushed commits were not scanned$/m);
  }
});

test("says its word to the next job before it fails, and only ever one of the three", { skip: NO_SCANNER }, async () => {
  const repo = repository();
  const pushed = repo.commit({ "a.txt": canary() + "\n" });
  const found = await job(repo.dir, { before: repo.first, pushed });
  const clean = await job(repo.dir, { before: pushed, pushed: repo.commit({ "b.txt": "fine\n" }) });
  const none = decide({ temp: folder("empty-temp"), commits: "1", exit: "0" });
  assert.deepEqual([found.outcome, clean.outcome, none.outcome], ["credential_found", "passed", "not_scanned"]);
  assert.deepEqual([found.code, clean.code, none.code], [1, 0, 1]);
});

// ── the scanner step itself: docker, the pinned image ──────────────────────

/** Range, the workflow's own scanner step, then decide: the job as GitHub runs it. */
function realJob(dir, pushedRange) {
  const r = range(dir, pushedRange);
  assert.equal(r.code, 0, r.out);
  const temp = folder("runner-temp");
  const out = path.join(folder("out"), "scanner.txt");
  const ran = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", path.join(root, "scanner.sh")], {
    cwd: dir,
    env: { ...baseEnv(), SCANNER: IMAGE, SINCE: r.since, PUSHED: pushedRange.pushed, RUNNER_TEMP: temp, GITHUB_OUTPUT: out },
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, "the step itself ends well whatever the scanner found: " + ran.stdout + ran.stderr);
  return { ...decide({ temp, commits: r.commits, exit: outputs(out).exit }), scannerSaid: ran.stdout + ran.stderr, temp };
}

test("the job as GitHub runs it, on a repository holding the pattern: the scanner really reads bytes, and finds it", { skip: NO_DOCKER }, () => {
  const repo = repository();
  const planted = canary();
  const pushed = repo.commit({ "config/app.yml": `mode: live\nnote: ${planted}\n` });
  const run = realJob(repo.dir, { before: repo.first, pushed });

  assert.equal(run.outcome, "credential_found", run.out);
  assert.equal(run.code, 1);
  assert.ok(run.out.includes("config/app.yml, line 2, commit " + pushed.slice(0, 12)), run.out);
  // The scanner step prints nothing of what was found.
  assert.ok(!run.scannerSaid.includes(planted));
  assert.ok(!run.out.includes(planted));
});

test("the job as GitHub runs it, on a clean push: passed, having read something", { skip: NO_DOCKER }, () => {
  const repo = repository();
  const pushed = repo.commit({ "a.txt": "one\n" });
  const run = realJob(repo.dir, { before: repo.first, pushed });
  assert.equal(run.outcome, "passed", run.out);
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /^Secret scan: read [1-9]\d* bytes of 1 commit\./m);
});

test("the job as GitHub runs it, on a new branch: every commit is read", { skip: NO_DOCKER }, () => {
  const repo = repository();
  repo.commit({ "old.txt": canary() + "\n" });
  const pushed = repo.commit({ "new.txt": "fine\n" });
  const run = realJob(repo.dir, { before: NONE, pushed });
  assert.equal(run.outcome, "credential_found", run.out);
});
