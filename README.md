# prs

A Claude Code mod that browses and reviews Azure DevOps pull requests from
inside a session, in a docked side panel — the same kind of panel `/diff`
opens, via `/prs`.

## Install

```
claude plugin marketplace add ambareeshav/claude-pr-review-mod
claude plugin install prs@prs
```

Restart Claude Code (a full quit/relaunch — plugins load at session start,
not into an already-running session) and `/prs` is available.

## What it does (v0.1 — read-only slice)

- `/prs` — auto-detects the PR for the current branch and opens it in a
  docked panel; falls back to a browsable list of open PRs for the current
  repo if there isn't one.
- `/prs <id>` — opens that PR directly.
- `/prs --all` — a merged list across every Azure DevOps repo this session
  has visited (only repos already resolved via a prior `/prs` call — there's
  no cross-repo discovery).
- The panel: a `‹ back to PR list` button, the PR title/description/status,
  changed files as an indented folder tree with green/red `+N`/`-M` counts,
  and the selected file's diff (git's own hunks, boilerplate stripped).
- Opening a PR also best-effort checks out its source branch locally.

Not yet implemented: posting comments, replying to threads, voting
(approve/reject/wait). These need write scopes and are a deliberate next
slice, not an oversight.

## Setup

1. Logged into Azure CLI: `az login` (checked at runtime; the mod never
   calls it for you).
2. Run from inside a git repo whose `origin` remote is an Azure DevOps URL
   (`dev.azure.com/<org>/<project>/_git/<repo>`, the SSH form, or the legacy
   `<org>.visualstudio.com` form).

For local development instead of the marketplace install above:
`claude --plugin-dir /path/to/claude-pr-review-mod`, or symlink this folder
into `~/.claude/skills/prs` to auto-load every session.

## Design notes (why it's built this way)

- **The panel is a real docked `Pane`** (`$.ui.open({ id, title, focus,
  closeOnEscape })`, drawn from a `ui.render` hook matched on `{component:
  'Pane'}`), not a `CommandOutput` row. `CommandOutput` always draws inline
  in the transcript and grows the chat log on every run — a `Pane` is what
  gives `/diff`-style behavior: docked beside the transcript, not scrolling
  past.
- **A `command.run` matcher alone does not create a slash command.** It only
  handles one that's already registered. `/prs` has to be registered
  explicitly with `$.command.register({ name, description, argumentHint })`
  in a `session.start` hook — found by comparing against a working mod
  (`tetris`) that does this and has no `commands/*.md` file. Without it,
  Claude Code falls back to treating a `commands/<name>.md` file (if one
  exists) as a markdown "Skill" — running its text as instructions for the
  model to improvise with Bash — rather than ever reaching the hook. This
  plugin has no `commands/` folder at all; the hook is the only source of
  truth for `/prs`.
- **Diffs and the file tree come from `git diff`, not the ADO REST API.**
  Both branches are already fetched locally for the checkout step, so `git
  diff origin/<target>...origin/<source>` gives `--numstat` (per-file
  `+`/`-` counts), `--name-status` (the file list), and each file's unified
  diff for free. The unified diff's `diff --git`/`index`/`---`/`+++`
  boilerplate is stripped (`lib/diff.ts`), keeping only the `@@` hunks.
  Earlier drafts fetched raw file content via ADO's `items` endpoint and
  hand-rolled an LCS line diff — unnecessary once checkout was already
  fetching the same refs, and git's own diff algorithm is better anyway.
- **The file list renders as a real folder tree** (`lib/tree.ts`, pure):
  changed files are grouped into a directory tree, single-child directory
  chains are compressed onto one line (`src/components/admin`), and each
  file is a `plain` `Button` (no bracket chrome) with colored `+`/`-` counts
  as separate `Text` elements alongside it (a Button's label is plain text
  only, so the counts can't be colored *inside* the button).
- **Every `$` call lives in `register.tsx` as a top-level function.**
  `claude plugin validate` enforces this: a `$` call is only tracked when
  it's textually inside the hooks module, in a function declared at the
  file's top level — not through an imported helper, and not through a
  function nested inside another. Only pure logic (`parseAdoRemote`,
  `branchName`, `toPullRequestSummary`, URL building, the diff cleaner, the
  tree builder) lives in `hooks/lib/`.
- **No global `ui.press` hook.** A `Button`'s `onPress` runs directly "in
  the plugin's own environment" per the generated types — it's a plain
  closure over `$`, no separate event-dispatch/hotkey-matching layer
  needed. State mutation + `$.ui.invalidate('ui.render')` inside `onPress`
  is enough to get a redraw.
- **Diff text is capped at 9000 chars.** `Markdown` elements cap at 10000
  characters; a large file's diff is truncated with a note rather than
  silently failing to render.

## Verifying this plugin

- `claude plugin validate .` — static check: confirms the manifest, that
  every `$` call is reachable the way the engine requires, and lists
  exactly what the plugin hooks and calls.
- `claude plugin test .` — runs `hooks/register.test.ts` against the real
  engine (mocked `process.run`/`http.fetch`/`store.*`), including a
  `$.ui.mount` test that mounts the `Pane`, presses a file button, and
  checks the diff panel re-renders with the boilerplate stripped and the
  right `+`/`-` counts shown.
- `.claude/types/claude-code.d.ts` (not committed — regenerate with
  `/plugin-types` in a session) is what all of the above and the code
  itself were checked against, for Claude Code 2.1.278. Regenerate it after
  an engine update rather than trusting a stale copy — this is an
  early-access API that can change between releases.

## Known limitations / next steps

- **Not yet exercised end-to-end by more than one person.** Validated with
  `claude plugin validate`/`claude plugin test`, and manually against a real
  Azure DevOps org — but this is early-access (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`)
  and the API can shift between releases.
- **Worktrees:** `git checkout <branch>` inside a git worktree fails if
  that branch is already checked out in another worktree. The mod reports
  this as a non-fatal note in the panel and still shows the diff (which
  comes from fetched refs, not the working tree) — but you won't get a
  local checkout to poke at until the other worktree moves off that branch.
- **`--all` only knows repos visited this session** (in-memory registry,
  reset on plugin reload) — there's no repo auto-discovery.
- Comments, replies, and voting are unimplemented (next slice).
