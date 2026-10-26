# shippp-verify

Shippp's check of a pushed commit, as a workflow a project's CI calls.

A project holds a few lines that call `.github/workflows/verify.yml` here. What
runs is decided in this repository and cannot be changed from the project.

- **started** runs none of the project's code. It tells Shippp that the run
  has begun, with an identity token for the run, so that a founder's dashboard
  can say "Checking" until the result arrives. It decides nothing, nothing
  waits for it, and it cannot fail the run.
- **verify** checks out the commit and runs every layer of the Shippp check on
  it. Before any layer, it asks whether Shippp's own files in the commit are
  what Shippp installs, and says one of two words: `intact` or `changed`. The
  project's code runs in this job and in no other, and it has no way to ask
  GitHub for an identity token.
- **scan** reads the commits that were pushed for live credentials. It runs
  none of the project's code and is given nothing but leave to read the
  repository. It says one of three words: `passed`, `credential_found` or
  `not_scanned`.
- **approved** runs none of the project's code. It asks GitHub for an identity
  token for the run and sends what `verify` found, and what `scan` came to, to
  Shippp with it. Shippp's answer is this job's result: the status
  `Shippp / approved`. It also asks GitHub which branch is the default one and
  who that branch's required checks bind (everyone, everyone but
  administrators, or nobody), and sends that beside the result. It reads the
  branch with the run's own token, which is no administrator's; when GitHub
  does not answer, the commit is judged all the same and Shippp is told
  nothing about the branch.

## The app's test settings

- **What it is.** One optional secret, `SHIPPP_APP_ENV`: the lines of a `.env`
  file (`NAME=value`) as one value. What the app needs to start in test mode,
  and the test account its journeys sign in with. A runner has no
  `.env.local`; this is what stands where that file does on a founder's
  machine.
- **Who is given it.** The one step that runs the check, in `verify`. No other
  step of that job, and no other job. The check hands the settings to an app
  it starts and to the browser that walks the journeys, and to nothing else
  it runs.
- **Named, never inherited.** A project's file names the two secrets it hands
  on. This file is never given every secret a repository has, so what a run
  of the project's code can see is what its founder put in this one.
- **What the check does not take from it.** A setting that names a database:
  the check has its own, to use and throw away. A setting the check or the
  runner decides. A setting the step already has.
- **A live key.** The check uses none of the settings when one is a provider's
  live key, and says which setting, never its value. It sends an app requests
  it must refuse and walks its journeys, so it runs with test keys only.
- **What is shown.** Names. The check leaves the values out of its log and out
  of the report the next job sends.
- **A project that has not filled it** hands on an empty value, and is checked
  as it is without one.

All of that but the second and third is the check's doing, and its tests are
in Shippp's own repository. What this repository holds is who is given the
secret.

## A run's start

- **What is sent.** Which Shippp project the commit belongs to, and nothing
  else. The repository, the commit, the branch and the run are in the identity
  token, which GitHub signs and Shippp checks as it checks a result's.
- **Where the project comes from.** `context/governance-version.json` in the
  pushed commit, the record Shippp's install keeps, read as one file's
  contents through GitHub's API with the run's own token. Nothing is checked
  out and nothing of the project's is run.
- **What it decides.** Nothing. Shippp holds it to the repository the
  project's founder linked, keeps it, and shows the commit as being checked.
  No layer is cleared by it and no verdict reads it.
- **When it cannot be said.** No record in the commit, no token, Shippp out of
  reach, or Shippp refusing it: the job prints a notice and ends well. The
  commit is checked all the same.
- **A run that never reports.** Shippp stops waiting an hour after the start,
  which is longer than the 45 minutes `verify` is given and the 5 `approved`
  is. That hour is kept in Shippp's own repository, so a change to either
  limit here is a change to make there as well.

## The scan

- **Which commits.** The ones the push brought: from the commit the branch was
  at before, when GitHub names one, it is in the repository, and the pushed
  commit grew from it. Otherwise (a new branch, a branch that was rewritten)
  every commit the pushed one grew from. A credential that was added and taken
  out again in the same push is found: it was pushed.
- **What stops a commit.** A credential the scanner tried against the service
  it belongs to, and found working. A string that only looks like a credential
  is counted in the log and stops nothing. The way past a finding is to revoke
  the credential and run the job again.
- **What is never printed.** The credential. The job says the kind, the file,
  the line and the commit.
- **A scan that read nothing has not passed.** A scanner that ends well having
  read 0 bytes of commits that were pushed is `not_scanned`, and so is one
  that did not finish. Shippp does not approve a commit nobody scanned.
- **The scanner is one exact image**, named in `verify.yml` by its digest. A
  tag can be moved to something else; a digest cannot. Changing the scanner is
  a change to that line, and to a tag of this repository.
- **Shippp's own pattern.** The scanner is also given one pattern no service
  issues, `shippp_canary_` followed by 32 hexadecimal characters. It always
  stops a commit. It is how this repository's tests show that the scanner
  really reads what it is given.

What the scan does not do: read commits that were pushed before a project had
this workflow. Only a push whose range reaches them does, which a new branch's
first push is.

## Shippp's own files

- **What is asked.** Whether the hooks in the commit are what the project's
  release of Shippp installs, the files made from its blueprint are as the
  install recorded them, and the hooks are still wired. It is the check
  `shippp-governance verify-gates` runs, and a founder can run that on their
  own machine for the same answer.
- **Who asks.** The `verify` job, as the package's `verify --all --ci-report`
  does it, and writes one word in the report it leaves. The `approved` job
  runs no check of its own: it sends the report as it was written, and never
  makes the word up.
- **What stops a commit.** Anything but `intact`. A report with no word, which
  is what a package from before the check leaves, is sent as it is: its layers
  are kept, and Shippp answers the commit as not approved. A word this file
  does not know is left out for the same reason.
- **Where it is said.** The `approved` job says what Shippp read the word as,
  under the layers and the scan. Which file it was, and the command that puts
  it back, are in the `verify` job's log.
- **How far it is trusted.** As far as a layer's result is. The word is worked
  out in the job that runs the project's code.

## Tests

`node --test`

- `test/approved-step.test.mjs` takes the step's script out of `verify.yml`
  and runs it as its own process, over real HTTP, against a server on the same
  machine that answers as GitHub's token endpoint, GitHub's repository and
  branch endpoints, and Shippp's results endpoint are known to.
- `test/started-step.test.mjs` does the same for the step that says a run has
  started: GitHub's file contents and token endpoints, and Shippp's endpoint
  for a start. Every way it can go wrong ends with the job passing.
- `test/scan-job.test.mjs` takes the scan job's three steps out of
  `verify.yml` and runs each as its own process, on real repositories made
  with git, with the real scanner. The string it plants is made when the test
  runs and is in no file here. A credential "found working" is the scanner's
  own verdict: the test adds a detector to the scanner's settings, and the
  scanner asks a server on the same machine whether what it found works.
- `test/workflow-shape.test.mjs` holds each job to what it is allowed.

Where each part of the scan's tests can run:

| Part                                         | Needs                                             |
| -------------------------------------------- | ------------------------------------------------- |
| which commits were pushed                    | bash and git                                      |
| what the scan came to, on a scanner's output | docker, or the scanner's program named in `SHIPPP_TEST_SCANNER` |
| the scanner step itself, the pinned image    | docker: this repository's own CI                  |

A part that cannot run is skipped and says why. It is never counted as passed.

Not shown by these: that a token GitHub really signed is accepted by Shippp's
real server, which takes a run from a repository a founder has linked. And
that a credential a real service issued is reported as live, which would take
a real, working credential in a test.

## Releases

A project calls a tag (`@v1`). Shippp accepts results only from the tags it
lists, so a change here reaches nobody until a tag is moved or added and
Shippp's list names it.
