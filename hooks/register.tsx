import { parseRemote, branchName, prWebUrl } from './lib/git';
import type { AdoRepoContext, GithubRepoContext, RepoContext } from './lib/git';
import { adoBaseUrl, toPullRequestSummary, ADO_API_VERSION, ADO_RESOURCE_ID } from './lib/ado';
import type { PullRequestSummary, PullRequestDetail } from './lib/ado';
import { buildFileTreeRows } from './lib/tree';
import type { FileChange } from './lib/tree';
import { cleanUnifiedDiff } from './lib/diff';

// Checked against the real generated claude-code.d.ts (via /plugin-types) —
// see README.md for what that changed vs. the first draft. Every `$` call
// stays a top-level function declaration in this file on purpose: `claude
// plugin validate` requires `$` to be followed only through functions
// declared at the top of the hooks module, never through an imported helper
// or a function nested inside another.

const TOKEN_STORE_KEY = 'prs:ado-token';
const PANE_ID = 'prs';
const MAX_DIFF_CHARS = 9000; // Markdown elements cap at 10000 chars

type RepoGroup = { label: string; root: string; ctx: RepoContext };

type CommitInfo = { sha: string; subject: string; body: string };

type ReviewTab = 'files' | 'commits';

type ViewState =
  | { mode: 'error'; message: string }
  | { mode: 'browser'; group: RepoGroup; prs: PullRequestSummary[] }
  | { mode: 'browser-all'; groups: { group: RepoGroup; prs: PullRequestSummary[] }[] }
  | {
      mode: 'review';
      group: RepoGroup;
      detail: PullRequestDetail;
      files: FileChange[];
      commits: CommitInfo[];
      activeTab: ReviewTab;
      expandedShas: Set<string>;
      selectedPath: string | null;
      diffCache: Map<string, string>;
      loadingDiff: boolean;
      checkoutMessage: string | null;
    };

let currentView: ViewState | null = null;
const repoRegistry = new Map<string, RepoGroup>();

function repoLabel(ctx: RepoContext): string {
  return ctx.provider === 'github' ? `${ctx.github.owner}/${ctx.github.repo}` : `${ctx.ado.project}/${ctx.ado.repo}`;
}

function parseArgs(e: any): string {
  const raw = e.args ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function ttlMinutesFrom(options: any): number {
  const parsed = Number(options?.tokenTtlMinutes ?? '45');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 45;
}

function summaryText(view: ViewState | null): string {
  if (!view) return '/prs: nothing to show';
  if (view.mode === 'error') return `/prs: ${view.message}`;
  if (view.mode === 'browser') return `/prs: ${view.prs.length} open PR(s) in ${view.group.label}`;
  if (view.mode === 'browser-all') {
    const total = view.groups.reduce((n, g) => n + g.prs.length, 0);
    return `/prs --all: ${total} open PR(s) across ${view.groups.length} repo(s)`;
  }
  return `/prs ${view.detail.pullRequestId}: ${view.detail.title}`;
}

// --- process / git ----------------------------------------------------

async function run($: any, argv: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return $.process.run(argv, cwd ? { cwd } : undefined);
}

async function resolveRepoContext($: any): Promise<{ root: string; ctx: RepoContext } | null> {
  const toplevel = await run($, ['git', 'rev-parse', '--show-toplevel']);
  if (toplevel.exitCode !== 0) return null;
  const root = toplevel.stdout.trim();
  const remote = await run($, ['git', 'remote', 'get-url', 'origin'], root);
  if (remote.exitCode !== 0) return null;
  const ctx = parseRemote(remote.stdout.trim());
  if (!ctx) return null;
  return { root, ctx };
}

async function ensureRepoGroup($: any): Promise<RepoGroup | null> {
  const resolved = await resolveRepoContext($);
  if (!resolved) return null;
  const existing = repoRegistry.get(resolved.root);
  if (existing) return existing;
  const group: RepoGroup = { label: repoLabel(resolved.ctx), root: resolved.root, ctx: resolved.ctx };
  repoRegistry.set(resolved.root, group);
  return group;
}

async function currentBranch($: any, cwd: string): Promise<string | null> {
  const res = await run($, ['git', 'branch', '--show-current'], cwd);
  const name = res.stdout.trim();
  return res.exitCode === 0 && name ? name : null;
}

async function fetchBranches($: any, root: string, branches: string[]): Promise<boolean> {
  const res = await run($, ['git', 'fetch', 'origin', ...branches], root);
  return res.exitCode === 0;
}

async function checkoutBranch($: any, root: string, branch: string): Promise<{ ok: boolean; message?: string }> {
  const checkout = await run($, ['git', 'checkout', branch], root);
  if (checkout.exitCode === 0) return { ok: true };
  // branch may not exist locally yet — try tracking the fetched remote ref
  const track = await run($, ['git', 'checkout', '-b', branch, `origin/${branch}`], root);
  if (track.exitCode === 0) return { ok: true };
  return { ok: false, message: (checkout.stderr || track.stderr).trim() || 'git checkout failed' };
}

async function gitDiffFiles($: any, root: string, target: string, source: string): Promise<FileChange[]> {
  const range = `origin/${target}...origin/${source}`;
  const [statusRes, numstatRes] = await Promise.all([
    run($, ['git', 'diff', '--name-status', range], root),
    run($, ['git', 'diff', '--numstat', range], root),
  ]);
  if (statusRes.exitCode !== 0) return [];

  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  if (numstatRes.exitCode === 0) {
    for (const line of numstatRes.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [addedStr, deletedStr, ...rest] = trimmed.split('\t');
      counts.set(rest.join('\t'), {
        added: addedStr === '-' ? null : Number(addedStr),
        deleted: deletedStr === '-' ? null : Number(deletedStr),
      });
    }
  }

  return statusRes.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line): FileChange => {
      const [status, ...rest] = line.split('\t');
      const path = rest.join('\t');
      const count = counts.get(path);
      return { path, status, added: count?.added ?? null, deleted: count?.deleted ?? null };
    });
}

async function gitDiffForFile($: any, root: string, target: string, source: string, path: string): Promise<string> {
  const res = await run($, ['git', 'diff', `origin/${target}...origin/${source}`, '--', path], root);
  return cleanUnifiedDiff(res.stdout);
}

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

/** Commits unique to the source branch (oldest first), the same way `gh`/ADO's
 * own "Commits" tab lists a PR — from git log, not another provider API call. */
async function gitCommitsBetween($: any, root: string, target: string, source: string): Promise<CommitInfo[]> {
  const format = `%H${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`;
  const res = await run($, ['git', 'log', '--reverse', `--format=${format}`, `origin/${target}..origin/${source}`], root);
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split(RECORD_SEP)
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec): CommitInfo => {
      const [sha, subject, body] = rec.split(FIELD_SEP);
      return { sha: sha ?? '', subject: subject ?? '', body: (body ?? '').trim() };
    });
}

// --- Azure DevOps REST (PR metadata only; diffs come from git) --------

async function getAdoAccessToken($: any, ttlMinutes: number): Promise<string> {
  const cached = (await $.store.get(TOKEN_STORE_KEY)) as { token: string; expiresAt: number } | undefined;
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.token;

  const loginCheck = await run($, ['az', 'account', 'show']);
  if (loginCheck.exitCode !== 0) {
    throw new Error('Not logged into Azure CLI. Run `az login` in a terminal, then retry /prs.');
  }

  const tokenRes = await run($, [
    'az', 'account', 'get-access-token',
    '--resource', ADO_RESOURCE_ID,
    '--query', 'accessToken',
    '-o', 'tsv',
  ]);
  const token = tokenRes.stdout.trim();
  if (tokenRes.exitCode !== 0 || !token) {
    throw new Error(`Failed to get an Azure DevOps access token via az CLI: ${tokenRes.stderr.trim()}`);
  }

  await $.store.set(TOKEN_STORE_KEY, { token, expiresAt: now + ttlMinutes * 60_000 });
  return token;
}

async function adoJson($: any, ttlMinutes: number, url: string): Promise<any> {
  const token = await getAdoAccessToken($, ttlMinutes);
  const res = await $.http.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Azure DevOps API ${res.status} on ${url.split('?')[0]}: ${(res.text ?? '').slice(0, 300)}`);
  }
  return JSON.parse(res.text);
}

async function listAdoPullRequests($: any, ctx: AdoRepoContext, ttlMinutes: number): Promise<PullRequestSummary[]> {
  const url = `${adoBaseUrl(ctx)}/pullrequests?searchCriteria.status=active&api-version=${ADO_API_VERSION}`;
  const body = await adoJson($, ttlMinutes, url);
  return (body.value ?? []).map(toPullRequestSummary);
}

async function getAdoPullRequest($: any, ctx: AdoRepoContext, ttlMinutes: number, id: number): Promise<PullRequestDetail> {
  const url = `${adoBaseUrl(ctx)}/pullrequests/${id}?api-version=${ADO_API_VERSION}`;
  const pr = await adoJson($, ttlMinutes, url);
  return { ...toPullRequestSummary(pr), description: pr.description ?? '' };
}

// --- GitHub (via the already-authenticated `gh` CLI; no token plumbing needed) --

function toGithubSummary(pr: any): PullRequestSummary {
  return {
    pullRequestId: pr.number,
    title: pr.title,
    status: (pr.state ?? 'open').toLowerCase(),
    createdBy: pr.author?.login ?? 'unknown',
    sourceRefName: `refs/heads/${pr.headRefName}`,
    targetRefName: `refs/heads/${pr.baseRefName}`,
    creationDate: pr.createdAt,
    isDraft: !!pr.isDraft,
  };
}

async function listGithubPullRequests($: any, gh: GithubRepoContext): Promise<PullRequestSummary[]> {
  const res = await run($, [
    'gh', 'pr', 'list',
    '--repo', `${gh.owner}/${gh.repo}`,
    '--state', 'open',
    '--json', 'number,title,author,headRefName,baseRefName,createdAt,isDraft',
  ]);
  if (res.exitCode !== 0) throw new Error(`gh pr list failed: ${(res.stderr || res.stdout).trim()}`);
  return (JSON.parse(res.stdout) as any[]).map(toGithubSummary);
}

async function getGithubPullRequest($: any, gh: GithubRepoContext, id: number): Promise<PullRequestDetail> {
  const res = await run($, [
    'gh', 'pr', 'view', String(id),
    '--repo', `${gh.owner}/${gh.repo}`,
    '--json', 'number,title,author,headRefName,baseRefName,createdAt,isDraft,state,body',
  ]);
  if (res.exitCode !== 0) throw new Error(`gh pr view failed: ${(res.stderr || res.stdout).trim()}`);
  const pr = JSON.parse(res.stdout);
  return { ...toGithubSummary(pr), description: pr.body ?? '' };
}

// --- provider dispatch ------------------------------------------------

async function listPullRequests($: any, group: RepoGroup, ttlMinutes: number): Promise<PullRequestSummary[]> {
  return group.ctx.provider === 'github'
    ? listGithubPullRequests($, group.ctx.github)
    : listAdoPullRequests($, group.ctx.ado, ttlMinutes);
}

async function getPullRequest($: any, group: RepoGroup, ttlMinutes: number, id: number): Promise<PullRequestDetail> {
  return group.ctx.provider === 'github'
    ? getGithubPullRequest($, group.ctx.github, id)
    : getAdoPullRequest($, group.ctx.ado, ttlMinutes, id);
}

// --- view construction --------------------------------------------------

async function openReview($: any, ttlMinutes: number, group: RepoGroup, prId: number): Promise<void> {
  const detail = await getPullRequest($, group, ttlMinutes, prId);
  const source = branchName(detail.sourceRefName);
  const target = branchName(detail.targetRefName);

  const fetched = await fetchBranches($, group.root, [source, target]);
  const [files, commits] = fetched
    ? await Promise.all([gitDiffFiles($, group.root, target, source), gitCommitsBetween($, group.root, target, source)])
    : [[], []];

  let checkoutMessage: string | null = null;
  if (!fetched) {
    checkoutMessage = `couldn't fetch ${source}/${target} from origin`;
  } else {
    const outcome = await checkoutBranch($, group.root, source);
    if (!outcome.ok) checkoutMessage = `couldn't check out ${source}: ${outcome.message}`;
  }

  const view: ViewState = {
    mode: 'review',
    group,
    detail,
    files,
    commits,
    activeTab: 'files',
    expandedShas: new Set(),
    selectedPath: files[0]?.path ?? null,
    diffCache: new Map(),
    loadingDiff: false,
    checkoutMessage,
  };
  currentView = view;

  if (view.selectedPath) await loadDiffForSelected($, view);
}

async function goBackToBrowser($: any, ttlMinutes: number, group: RepoGroup): Promise<void> {
  currentView = { mode: 'browser', group, prs: await listPullRequests($, group, ttlMinutes) };
}

async function loadDiffForSelected($: any, view: Extract<ViewState, { mode: 'review' }>): Promise<void> {
  if (!view.selectedPath || view.diffCache.has(view.selectedPath)) return;
  view.loadingDiff = true;
  try {
    const diffText = await gitDiffForFile(
      $,
      view.group.root,
      branchName(view.detail.targetRefName),
      branchName(view.detail.sourceRefName),
      view.selectedPath,
    );
    view.diffCache.set(view.selectedPath, diffText);
  } finally {
    view.loadingDiff = false;
  }
}

function renderView($: any, e: any, options: any, view: ViewState) {
  const { Box, Text, Markdown, Button } = $.ui.resolve(e);
  const ttlMinutes = ttlMinutesFrom(options);
  // A visible section rule — `gap` on Box produced no visible blank row here.
  const dividerWidth = Math.max(1, (e.props as any)?.bodyColumns ?? 60);
  const Divider = () => <Text dimColor>{'─'.repeat(dividerWidth)}</Text>;

  if (view.mode === 'error') {
    return <Markdown text={`**/prs error:** ${view.message}`} />;
  }

  if (view.mode === 'browser' || view.mode === 'browser-all') {
    const groups = view.mode === 'browser' ? [{ group: view.group, prs: view.prs }] : view.groups;
    return (
      <Box flexDirection="column">
        {groups.map(({ group, prs }, i) => (
          <Box key={`group:${group.label}`} flexDirection="column">
            {i > 0 && <Divider />}
            <Markdown text={`### ${group.label}`} />
            {prs.length === 0 && <Markdown text="_no active pull requests_" />}
            {prs.map((pr) => (
              <Button
                key={`open:${group.label}:${pr.pullRequestId}`}
                label={`#${pr.pullRequestId} ${pr.title} — ${pr.createdBy}${pr.isDraft ? ' (draft)' : ''}`}
                onPress={() => {
                  openReview($, ttlMinutes, group, pr.pullRequestId).then(() => $.ui.invalidate('ui.render'));
                }}
              />
            ))}
          </Box>
        ))}
      </Box>
    );
  }

  const tabButton = (tab: ReviewTab, label: string) => (
    <Button
      key={`tab:${tab}`}
      plain
      label={view.activeTab === tab ? `● ${label}` : label}
      onPress={() => {
        view.activeTab = tab;
        $.ui.invalidate('ui.render');
      }}
    />
  );

  let content: any;
  if (view.activeTab === 'commits') {
    content = (
      <Box flexDirection="column">
        {view.commits.length === 0 && <Markdown text="_no commits on this branch_" />}
        {view.commits.map((c, i) => {
          const expanded = view.expandedShas.has(c.sha);
          return (
            <Box key={`commit:${c.sha}`} flexDirection="column">
              {i > 0 && <Divider />}
              <Button
                key={`commit:${c.sha}`}
                plain
                label={`${c.sha.slice(0, 7)}  ${c.subject}`}
                onPress={() => {
                  if (expanded) view.expandedShas.delete(c.sha);
                  else view.expandedShas.add(c.sha);
                  $.ui.invalidate('ui.render');
                }}
              />
              {expanded && (c.body ? <Markdown text={c.body} /> : <Text dimColor>  (no description)</Text>)}
            </Box>
          );
        })}
      </Box>
    );
  } else {
    const diffBody = view.selectedPath ? view.diffCache.get(view.selectedPath) : undefined;
    const truncated = !!diffBody && diffBody.length > MAX_DIFF_CHARS;
    const diffText = diffBody
      ? '```diff\n' + diffBody.slice(0, MAX_DIFF_CHARS) + (truncated ? '\n… (truncated)' : '') + '\n```'
      : view.loadingDiff
        ? '_loading diff…_'
        : '_select a file_';

    const treeRows = buildFileTreeRows(view.files);

    content = (
      <Box flexDirection="column">
        <Box flexDirection="column">
          {treeRows.map((row) =>
            row.kind === 'dir' ? (
              <Text key={`dir:${row.depth}:${row.name}`} dimColor>
                {'  '.repeat(row.depth) + row.name + '/'}
              </Text>
            ) : (
              <Box key={`file:${row.file.path}`} flexDirection="row" columnGap={1}>
                <Button
                  key={`file:${row.file.path}`}
                  plain
                  label={
                    '  '.repeat(row.depth) +
                    row.name +
                    (row.file.path === view.selectedPath ? ' •' : '')
                  }
                  onPress={() => {
                    view.selectedPath = row.file.path;
                    loadDiffForSelected($, view).then(() => $.ui.invalidate('ui.render'));
                  }}
                />
                {row.file.added !== null && <Text color="green">+{row.file.added}</Text>}
                {row.file.deleted !== null && <Text color="red">-{row.file.deleted}</Text>}
                {row.file.added === null && <Text dimColor>({row.file.status})</Text>}
              </Box>
            ),
          )}
        </Box>
        <Divider />
        <Markdown text={diffText} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Button
        key="back"
        plain
        label="‹ back to PR list"
        onPress={() => {
          goBackToBrowser($, ttlMinutes, view.group).then(() => $.ui.invalidate('ui.render'));
        }}
      />
      <Divider />
      <Markdown text={`#${view.detail.pullRequestId} ${view.detail.title}`} />
      <Divider />
      <Markdown
        text={`${branchName(view.detail.sourceRefName)} → ${branchName(view.detail.targetRefName)} · ${view.detail.createdBy} · ${view.detail.status}${view.detail.isDraft ? ' · draft' : ''}`}
      />
      <Markdown text={`[↗ open PR #${view.detail.pullRequestId} in browser](${prWebUrl(view.group.ctx, view.detail.pullRequestId)})`} />
      {view.checkoutMessage && (
        <>
          <Divider />
          <Text color="yellow">{view.checkoutMessage}</Text>
        </>
      )}
      <Divider />
      <Markdown text={view.detail.description || '_no description_'} />
      <Divider />
      <Box flexDirection="row" columnGap={2}>
        {tabButton('files', 'Files')}
        {tabButton('commits', `Commits (${view.commits.length})`)}
      </Box>
      <Divider />
      {content}
    </Box>
  );
}

async function handleCommandRun($: any, e: any, options: any): Promise<{ text: string }> {
  const args = parseArgs(e);
  const ttlMinutes = ttlMinutesFrom(options);

  try {
    if (args === '--all') {
      const groups: { group: RepoGroup; prs: PullRequestSummary[] }[] = [];
      for (const group of repoRegistry.values()) {
        groups.push({ group, prs: await listPullRequests($, group, ttlMinutes) });
      }
      currentView =
        groups.length === 0
          ? { mode: 'error', message: 'no GitHub or Azure DevOps repos seen yet this session — run /prs once from inside one first' }
          : { mode: 'browser-all', groups };
    } else if (/^\d+$/.test(args)) {
      const group = await ensureRepoGroup($);
      if (!group) {
        currentView = { mode: 'error', message: "current directory isn't a GitHub or Azure DevOps repo (no parseable origin remote)" };
      } else {
        await openReview($, ttlMinutes, group, Number(args));
      }
    } else if (args.length === 0) {
      const group = await ensureRepoGroup($);
      if (!group) {
        currentView = { mode: 'error', message: "current directory isn't a GitHub or Azure DevOps repo (no parseable origin remote)" };
      } else {
        const branch = await currentBranch($, group.root);
        const prs = await listPullRequests($, group, ttlMinutes);
        const match = branch ? prs.find((pr) => branchName(pr.sourceRefName) === branch) : undefined;
        if (match) {
          await openReview($, ttlMinutes, group, match.pullRequestId);
        } else {
          currentView = { mode: 'browser', group, prs };
        }
      }
    } else {
      currentView = { mode: 'error', message: `unrecognized arguments "${args}" — use /prs, /prs <id>, or /prs --all` };
    }
  } catch (err: any) {
    currentView = { mode: 'error', message: err?.message ?? String(err) };
  }

  if (currentView?.mode === 'error') {
    return { text: summaryText(currentView) };
  }

  await $.ui
    .open({ id: PANE_ID, title: 'PRs', focus: true, closeOnEscape: true })
    .catch((err: any) => $.ui.log(`prs: couldn't open the panel: ${err}`));
  return {};
}

async function handlePaneRender($: any, e: any, options: any, next: any): Promise<any> {
  if (e.requestId !== PANE_ID || !currentView) return next(e);
  return renderView($, e, options, currentView);
}

async function handleSessionStart($: any, e: any, next: any): Promise<any> {
  const r = await next(e);
  await $.command
    .register({
      name: 'prs',
      description: 'Browse and review Azure DevOps pull requests',
      argumentHint: '[id|--all]',
    })
    .catch((err: any) => $.ui.log(`prs: /prs not registered: ${err}`));
  return r;
}

export function register(on: any, options: any) {
  on('session.start', ($: any, e: any, next: any) => handleSessionStart($, e, next));
  on('command.run', { command: 'prs' }, ($: any, e: any) => handleCommandRun($, e, options));
  on('ui.render', { component: 'Pane' }, ($: any, e: any, next: any) => handlePaneRender($, e, options, next));
}
