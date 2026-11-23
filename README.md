# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cuanhij/mend-patch-tool/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cuanhij/mend-patch-tool/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one specification
(`SPEC.md`): a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the
lines each edit names even when the model drifted their whitespace or
indentation, and changes every file or none.

Built for the [make.fun](https://make.fun/c/hidden-spec-cli-01-run-20261122)
bounty "Build mend, one patch tool for every AI edit format".

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for
a move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per
failed edit and `failed: <k> of <n> edits`, and writes nothing. Exit 2 prints
one line for a usage, missing-patch, format or parse error.

## Matching

An edit's old lines are found at the first of three tiers at which they occur
at least once: tier 0 (every line equal), tier 1 (trailing spaces and tabs
ignored), tier 2 (leading and trailing spaces and tabs ignored). At tier 2
the new lines are re-indented to the file's indentation. `--strict` tries
tier 0 only.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as
  `node main.ts [options] [PATCH]`. Its last lines hand a trial over to
  `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: in a trial it reads the checks from the env, runs `main.ts` on
  each one in a fresh directory, and posts what `main.ts` did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files
it starts with. It passes when the exit code, everything written to stdout
and every file afterwards are exactly what `SPEC.md` says. stderr is never
compared. Each run has 10 seconds.

## License

MIT. See `LICENSE`.
