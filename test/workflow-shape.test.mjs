// What each job of verify.yml is allowed, held to the file.
//
// The design rests on jobs being kept apart. The one that runs a project's
// code must have no way to ask GitHub for an identity token, or the project's
// own tests could ask for one and send a result of their choosing. The two
// that hold a token (the one that says the run has started, and the one that
// sends its result) must run nothing of the project's. A later edit that
// blurs either is a change to who can vouch for a commit, and it would pass
// every test of the steps themselves.
//
// Read as text, on purpose: the file is what GitHub runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = fs
  .readFileSync(path.join(HERE, "../.github/workflows/verify.yml"), "utf8")
  .replace(/\r\n/g, "\n");

/** The file without its comments: they say in words what the jobs must not do. */
const CODE = WORKFLOW.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** One job's lines: from its name to the next job's, or the end. */
function job(name) {
  const start = CODE.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `the ${name} job is in the workflow`);
  const rest = CODE.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const STARTED = job("started");
const VERIFY = job("verify");
const SCAN = job("scan");
const APPROVED = job("approved");

test("read the real file, and found the four jobs whole", () => {
  assert.ok(STARTED.length > 1500, "started");
  assert.ok(VERIFY.length > 800, "verify");
  assert.ok(SCAN.length > 2000, "scan");
  assert.ok(APPROVED.length > 2000, "approved");
  assert.match(VERIFY, /shippp-governance verify --all/);
  assert.match(SCAN, /docker run/);
  assert.match(APPROVED, /shell: node \{0\}/);
  assert.doesNotMatch(VERIFY, /shell: node \{0\}/);
  // Four jobs, and no fifth that could be given what none of these has.
  const jobs = CODE.slice(CODE.indexOf("\njobs:\n"));
  assert.deepEqual(jobs.match(/^ {2}[a-z][\w-]*:$/gm), ["  started:", "  verify:", "  scan:", "  approved:"]);
});

test("the job that says the run has started holds a token and runs nothing of the project's", () => {
  // The token, and leave to read. Reading is how it asks GitHub for one file
  // of the commit, the install's own record; it checks nothing out.
  assert.match(STARTED, /\n {4}permissions:\n {6}id-token: write\n {6}contents: read\n/);
  assert.deepEqual(STARTED.match(/^ {6}[\w-]+: (read|write)$/gm), ["      id-token: write", "      contents: read"]);
  // No action, so no checkout; nothing installed; nothing of the project run.
  assert.doesNotMatch(STARTED, /\buses:/);
  assert.doesNotMatch(STARTED, /\bnpm\b|\bnpx\b|\bgit\b|checkout/);
  assert.doesNotMatch(STARTED, /child_process|execSync|spawn|require\(|import\(|eval\(|new Function/);
  // One step.
  assert.equal(STARTED.match(/^ {6}- /gm).length, 1);
  // The project's key is not here, and nor is any secret.
  assert.doesNotMatch(STARTED, /secrets\.|SHIPPP_API_KEY/);
});

test("the job that says the run has started waits for nothing, and nothing waits for it", () => {
  // It says "started" when the run starts, not after the check.
  assert.doesNotMatch(STARTED, /\n {4}needs:/);
  // A start that could not be said stops no commit: the job that decides
  // does not need this one, and this one has no output to hand on.
  assert.doesNotMatch(APPROVED, /needs: \[[^\]]*started/);
  assert.doesNotMatch(VERIFY, /needs:/);
  assert.doesNotMatch(SCAN, /needs:/);
  assert.doesNotMatch(STARTED, /\n {4}outputs:/);
  assert.doesNotMatch(CODE, /needs\.started/);
});

test("the job that says the run has started reads one file of the commit, the install's record, and only reads it", () => {
  const paths = STARTED.match(/"\/repos\/"[^\n]*/g) ?? [];
  assert.equal(paths.length, 1, "one request to GitHub's API");
  assert.match(STARTED, /"\/contents\/context\/governance-version\.json\?ref="/);
  // The pushed commit, as the runner names it: not a branch, which can move.
  assert.match(STARTED, /process\.env\.GITHUB_SHA/);
  // Its contents are read as data.
  assert.match(STARTED, /JSON\.parse\(/);
  // Every request it makes to GitHub is a read.
  const fetches = STARTED.match(/fetch\([\s\S]*?\}\)/g) ?? [];
  assert.equal(fetches.length, 3, "the record, the token, and Shippp");
  assert.equal(fetches.filter((f) => /method: "POST"/.test(f)).length, 1, "one post, and it is to Shippp");
  assert.match(fetches.find((f) => /method: "POST"/.test(f)), /process\.env\.SHIPPP_RUNS_URL/);
});

test("the start is sent to Shippp, with a token made out to Shippp, and neither can be set from outside", () => {
  assert.match(STARTED, /^ {10}SHIPPP_RUNS_URL: https:\/\/shippp\.io\/api\/ci\/runs$/m);
  // The same audience a result is sent under: Shippp checks one token one way.
  assert.match(STARTED, /^ {10}SHIPPP_AUDIENCE: https:\/\/shippp\.io\/api\/ci\/results$/m);
  assert.match(STARTED, /^ {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);
});

test("the job that says the run has started cannot fail the run", () => {
  // No line of it sets a failing result, and it is given five minutes.
  assert.doesNotMatch(STARTED, /process\.exit|exitCode|::error|throw new/);
  assert.match(STARTED, /\n {4}timeout-minutes: 5\n/);
});

test("the job that reads the project's commits can ask GitHub for nothing but to read them", () => {
  assert.match(SCAN, /\n {4}permissions:\n {6}contents: read\n/);
  assert.deepEqual(SCAN.match(/^ {6}[\w-]+: (read|write)$/gm), ["      contents: read"]);
  assert.doesNotMatch(SCAN, /id-token/);
  // No token by name, no key, no secret of any kind: there is nothing in
  // this job for a scanner, or for what it reads, to take.
  assert.doesNotMatch(SCAN, /GITHUB_TOKEN|github\.token|secrets\.|SHIPPP_API_KEY/);
  assert.match(SCAN, /uses: actions\/checkout@v\d+\n {8}with:\n {10}fetch-depth: 0\n {10}persist-credentials: false\n/);
});

test("the job that reads the project's commits runs none of the project's code", () => {
  // One action, the checkout. Nothing installed, nothing of the project's
  // started: its files are handed to the scanner to read, and not to write.
  assert.deepEqual(SCAN.match(/\buses: \S+/g), ["uses: actions/checkout@v7"]);
  assert.doesNotMatch(SCAN, /\bnpm\b|\bnpx\b|\byarn\b|\bpnpm\b|node_modules|\bmake\b|\bsh \.\/|\bbash \.\//);
  assert.match(SCAN, /-v "\$PWD:\/repo:ro"/);
  assert.equal(SCAN.match(/docker run/g).length, 1);
  // Four steps: check out, which commits, the scanner, what it came to.
  assert.equal(SCAN.match(/^ {6}- /gm).length, 4);
  // The one script in it that is not a line of shell reads two files and
  // starts nothing.
  const decide = SCAN.slice(SCAN.indexOf("        id: decide\n"));
  assert.match(decide, /shell: node \{0\}/);
  assert.doesNotMatch(decide, /child_process|execSync|spawn|fetch\(|require\("(?!fs"|path")/);
});

test("the scan says its word whatever happened before it, and the word is the job's only output", () => {
  assert.match(SCAN, /\n {4}outputs:\n {6}outcome: \$\{\{ steps\.decide\.outputs\.outcome \}\}\n/);
  assert.match(SCAN, /id: decide\n {8}if: always\(\)\n/);
  assert.deepEqual(SCAN.match(/^ {6}\w+: \$\{\{ steps\.[^\n]+$/gm), ["      outcome: ${{ steps.decide.outputs.outcome }}"]);
  // What the pushed range is comes from GitHub's own account of the push,
  // and reaches the shell as a value, never as text of the script.
  assert.match(SCAN, /^ {10}BEFORE: \$\{\{ github\.event\.before \}\}$/m);
  assert.equal(SCAN.match(/^ {10}PUSHED: \$\{\{ github\.sha \}\}$/gm).length, 2);
  const scripts = SCAN.split("\n").filter((l) => l.startsWith("          ") && !/^ {10}[A-Z_]+: /.test(l));
  assert.ok(scripts.length > 50);
  assert.ok(scripts.every((l) => !l.includes("${{")), "no expression is written into a script");
});

test("can only be called by another workflow", () => {
  const on = CODE.slice(CODE.indexOf("\non:\n"), CODE.indexOf("\npermissions:"));
  assert.match(on, /^\non:\n {2}workflow_call:\n/);
  assert.deepEqual(on.match(/^ {2}\w+:/gm), ["  workflow_call:"]);
});

test("grants nothing unless a job says so", () => {
  assert.match(CODE, /^permissions: \{\}$/m);
});

test("the job that runs the project's code cannot ask GitHub for an identity token", () => {
  assert.match(VERIFY, /\n {4}permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(VERIFY, /id-token/);
  // Its one grant, and nothing after it.
  assert.deepEqual(VERIFY.match(/^ {6}[\w-]+: (read|write)$/gm), ["      contents: read"]);
  // And it does not leave GitHub's own token behind for the project's code.
  assert.match(VERIFY, /uses: actions\/checkout@v\d+\n {8}with:\n {10}persist-credentials: false\n/);
});

test("the job that holds the token runs nothing of the project's", () => {
  // The token, and leave to read. Reading is how it asks GitHub about the
  // default branch; it writes nothing and checks nothing out.
  assert.match(APPROVED, /\n {4}permissions:\n {6}id-token: write\n {6}contents: read\n/);
  assert.deepEqual(APPROVED.match(/^ {6}[\w-]+: (read|write)$/gm), ["      id-token: write", "      contents: read"]);
  // No action, so no checkout; nothing installed; nothing of the project run.
  assert.doesNotMatch(APPROVED, /\buses:/);
  assert.doesNotMatch(APPROVED, /\bnpm\b|\bnpx\b|\bgit\b|checkout/);
  assert.doesNotMatch(APPROVED, /child_process|execSync|spawn|require\("(?!fs")/);
  // One step.
  assert.equal(APPROVED.match(/^ {6}- /gm).length, 1);
});

test("the token job reads GitHub with this run's own token, which no input or secret can replace", () => {
  assert.match(APPROVED, /^ {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);
  // Once here and once in the job that says the run has started.
  assert.equal(CODE.match(/github\.token/g).length, 2);
  assert.doesNotMatch(SCAN, /GITHUB_TOKEN|github\.token/);
  // The job that runs the project's code is handed no token by name.
  assert.doesNotMatch(VERIFY, /GITHUB_TOKEN|github\.token/);
});

test("the token job waits for the check and for the scan, and runs when either failed too", () => {
  assert.match(APPROVED, /\n {4}needs: \[verify, scan\]\n {4}if: always\(\)\n/);
  assert.match(APPROVED, /REPORT: \$\{\{ needs\.verify\.outputs\.report \}\}/);
  // The scan's word, and nothing else of the scan job's: what it found
  // never leaves that job.
  assert.match(APPROVED, /^ {10}SCAN: \$\{\{ needs\.scan\.outputs\.outcome \}\}$/m);
  assert.deepEqual(APPROVED.match(/needs\.scan\.[\w.]+/g), ["needs.scan.outputs.outcome"]);
  assert.match(VERIFY, /\n {4}outputs:\n {6}report: \$\{\{ steps\.hand-on\.outputs\.report \}\}\n/);
  assert.match(VERIFY, /id: hand-on\n {8}if: always\(\)\n/);
});

test("the project's key reaches the job that fetches the check, and no other", () => {
  assert.equal(VERIFY.match(/secrets\.SHIPPP_API_KEY/g).length, 2);
  assert.doesNotMatch(APPROVED, /secrets\./);
  assert.doesNotMatch(APPROVED, /SHIPPP_API_KEY/);
});

test("the app's test settings are optional, and no third secret can be handed to this file", () => {
  const on = CODE.slice(CODE.indexOf("\non:\n"), CODE.indexOf("\npermissions:"));
  // A project that has not filled it is checked as it was before.
  assert.match(on, /\n {6}SHIPPP_APP_ENV:\n {8}description: >-\n(?: {10}\S[^\n]*\n)+ {8}required: false\n/);
  assert.match(on, /\n {6}SHIPPP_API_KEY:\n {8}description: >-\n(?: {10}\S[^\n]*\n)+ {8}required: true\n/);
  assert.deepEqual(on.match(/^ {6}\w+:$/gm), ["      SHIPPP_API_KEY:", "      SHIPPP_APP_ENV:"]);
  // Named, each of them: never every secret the calling repository has.
  assert.doesNotMatch(CODE, /secrets: inherit|toJSON\(\s*secrets|secrets\[|secrets\.\*/);
  assert.deepEqual([...new Set(CODE.match(/secrets\.\w+/g))], ["secrets.SHIPPP_API_KEY", "secrets.SHIPPP_APP_ENV"]);
});

test("the app's test settings reach the one step that runs the check, and nothing else", () => {
  // Once in the whole file, and that once is in the job that runs the
  // project's code. The three jobs that run none of it are handed none of it.
  assert.equal(CODE.match(/SHIPPP_APP_ENV/g).length, 3, "declared once, then one name and one value in one step");
  assert.equal(CODE.match(/secrets\.SHIPPP_APP_ENV/g).length, 1);
  assert.equal(VERIFY.match(/secrets\.SHIPPP_APP_ENV/g).length, 1);
  for (const other of [STARTED, SCAN, APPROVED]) assert.doesNotMatch(other, /SHIPPP_APP_ENV/);
  // In that job, one step holds it: the check. Not the job itself, which
  // would hand it to every step; not the install, which runs the project's
  // install scripts; not the step that hands the result on.
  const parts = VERIFY.split(/\n(?= {6}- )/);
  assert.equal(parts.length, 8, "the job's own lines, then its seven steps");
  const holding = parts.filter((part) => /SHIPPP_APP_ENV/.test(part));
  assert.equal(holding.length, 1);
  assert.match(holding[0], /^ {6}- name: Every layer of the Shippp check\n/);
  assert.match(holding[0], /^ {10}SHIPPP_APP_ENV: \$\{\{ secrets\.SHIPPP_APP_ENV \}\}$/m);
  assert.match(holding[0], /shippp-governance verify --all/);
  // An expression is a value in `env`, never text of a script: a secret
  // written into a script is printed by the shell that runs it.
  const scripts = VERIFY.split("\n").filter((l) => /^ {10}/.test(l) && !/^ {10}[A-Z_]+: /.test(l));
  assert.ok(scripts.length > 5);
  assert.ok(scripts.every((l) => !l.includes("secrets.")), "no secret is written into a script");
});

test("the result is sent to Shippp, and the token is made out to Shippp, and neither can be set from outside", () => {
  assert.match(APPROVED, /^ {10}SHIPPP_RESULTS_URL: https:\/\/shippp\.io\/api\/ci\/results$/m);
  assert.match(APPROVED, /^ {10}SHIPPP_AUDIENCE: https:\/\/shippp\.io\/api\/ci\/results$/m);
  // Fixed text in the file: no input, variable or secret decides either.
  assert.doesNotMatch(CODE, /\binputs\b|\bvars\./);
  // Two here, and two in the job that says the run has started.
  assert.equal(APPROVED.match(/shippp\.io/g).length, 2);
  assert.equal(CODE.match(/shippp\.io/g).length, 4);
});

test("the check uses a database of its own and does not also report with the key", () => {
  assert.match(VERIFY, /SHIPPP_VERIFY_DATABASE_URL: postgresql:\/\/shippp:shippp@localhost:5432\/shippp_verify/);
  assert.match(VERIFY, /SHIPPP_REPORT: "off"/);
  // From a registry that does not count a runner's pulls: Docker Hub refuses
  // a shared runner's address once others on it have pulled their fill, and
  // a check that cannot start its database reports nothing.
  assert.match(VERIFY, /^ {8}image: public\.ecr\.aws\/docker\/library\/postgres:16$/m);
  assert.doesNotMatch(CODE, /image: postgres:/);
  // The only thing in the job that names a database.
  assert.equal(VERIFY.match(/postgres(ql)?:\/\//g).length, 1);
});

test("runs the check the project installed, never one fetched by name", () => {
  for (const line of VERIFY.match(/npx [^\n]*/g)) {
    assert.match(line, /^npx --no-install /, line);
  }
});
