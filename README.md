# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jhonrudi12/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jhonrudi12/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It reads unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON, finds the lines
each edit names even when the model drifted their whitespace or indentation, and changes every
file or none — atomically. `SPEC.md` is the whole contract.

## Run it

```sh
node main.ts [options] [PATCH]
```

`main.ts` runs on Node 22 with the standard library alone — no installs. The working directory is
the root of the tree of text files; the patch comes from the `PATCH` file, or from standard input
when it is absent or `-`. `--format=auto` (the default) detects the format; `--check` reports what
would change without writing; `--strict` matches lines exactly.

## The files

- `main.ts`: the CLI.
- `runner.ts`: the kit's trial runner (kept as the kit has it). When `MAKEFUN_ENV_URL` is set,
  `main.ts` hands over to it: it reads the trial's checks, runs `main.ts` on each one in a fresh
  directory, and posts what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
