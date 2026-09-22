import { test, expect } from 'claude-code/testing';
import { register } from './register';

const REMOTE_URL = 'https://dev.azure.com/aether-engineering/app-deployments/_git/web-frontend';

const PR_318 = {
  pullRequestId: 318,
  title: 'feat: trial campaign admin UI',
  status: 'active',
  createdBy: { displayName: 'ambareesha.vittal' },
  sourceRefName: 'refs/heads/feature/trial-campaign',
  targetRefName: 'refs/heads/main',
  creationDate: '2026-09-21',
  isDraft: false,
};

const GITHUB_PR_42 = {
  number: 42,
  title: 'fix: retry flaky upload',
  author: { login: 'octocat' },
  headRefName: 'fix/retry-upload',
  baseRefName: 'main',
  createdAt: '2026-09-20T00:00:00Z',
  isDraft: false,
  state: 'OPEN',
};

function installMocks(on: any, opts: { checkoutSucceeds?: boolean; remoteUrl?: string } = {}) {
  const checkoutSucceeds = opts.checkoutSucceeds ?? true;
  const remoteUrl = opts.remoteUrl ?? REMOTE_URL;

  on('process.run', async ($: any, e: any, next: any) => {
    const [cmd, ...rest] = e.argv as string[];

    if (cmd === 'git' && rest[0] === 'rev-parse') {
      return { value: { exitCode: 0, stdout: '/repo\n', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'remote') {
      return { value: { exitCode: 0, stdout: remoteUrl + '\n', stderr: '' } };
    }
    if (cmd === 'gh' && rest[0] === 'pr' && rest[1] === 'list') {
      return { value: { exitCode: 0, stdout: JSON.stringify([GITHUB_PR_42]), stderr: '' } };
    }
    if (cmd === 'gh' && rest[0] === 'pr' && rest[1] === 'view') {
      return {
        value: { exitCode: 0, stdout: JSON.stringify({ ...GITHUB_PR_42, body: 'Retries the upload once on 5xx.' }), stderr: '' },
      };
    }
    if (cmd === 'git' && rest[0] === 'branch') {
      return { value: { exitCode: 0, stdout: 'feature/trial-campaign\n', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'fetch') {
      return { value: { exitCode: 0, stdout: '', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'checkout') {
      return checkoutSucceeds
        ? { value: { exitCode: 0, stdout: '', stderr: '' } }
        : { value: { exitCode: 1, stdout: '', stderr: 'already checked out in another worktree' } };
    }
    if (cmd === 'git' && rest[0] === 'log') {
      const SEP1 = '\x1f';
      const SEP2 = '\x1e';
      const commits = [
        { sha: 'a1b2c3d4e5f6', subject: 'fix upload retry', body: 'Retries once on a 5xx before giving up.' },
        { sha: 'b2c3d4e5f6a1', subject: 'add test for retry path', body: '' },
      ];
      return {
        value: {
          exitCode: 0,
          stdout: commits.map((c) => `${c.sha}${SEP1}${c.subject}${SEP1}${c.body}${SEP2}`).join(''),
          stderr: '',
        },
      };
    }
    if (cmd === 'git' && rest[0] === 'diff' && rest.includes('--name-status')) {
      return { value: { exitCode: 0, stdout: 'M\tsrc/app.ts\nA\tsrc/new-file.ts\n', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'diff' && rest.includes('--numstat')) {
      return { value: { exitCode: 0, stdout: '3\t1\tsrc/app.ts\n5\t0\tsrc/new-file.ts\n', stderr: '' } };
    }
    if (cmd === 'git' && rest[0] === 'diff') {
      return {
        value: {
          exitCode: 0,
          stdout:
            'diff --git a/src/new-file.ts b/src/new-file.ts\n' +
            'index 0000000..387c90f 100644\n' +
            '--- /dev/null\n' +
            '+++ b/src/new-file.ts\n' +
            '@@ -1,2 +1,2 @@\n-old line\n+new line\n',
          stderr: '',
        },
      };
    }
    if (cmd === 'az' && rest.join(' ') === 'account show') {
      return { value: { exitCode: 0, stdout: '{}', stderr: '' } };
    }
    if (cmd === 'az' && rest[0] === 'account') {
      return { value: { exitCode: 0, stdout: 'fake-token\n', stderr: '' } };
    }
    return { value: { exitCode: 1, stdout: '', stderr: `unmocked argv: ${e.argv.join(' ')}` } };
  });

  on('store.get', async () => ({ value: undefined }));
  on('store.set', async () => ({ value: undefined }));
  on('ui.open', async () => ({ value: undefined }));

  on('http.fetch', async ($: any, e: any, next: any) => {
    const url = e.url as string;
    if (url.includes('/pullrequests?')) {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ value: [PR_318] }) } };
    }
    if (/\/pullrequests\/318\?/.test(url)) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({ ...PR_318, description: 'Adds the admin UI for trial campaigns.' }),
        },
      };
    }
    return { value: { status: 404, ok: false, headers: {}, text: 'not found' } };
  });
}

const PANE_PROPS = {
  title: 'PRs',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
};

test('command.run pr reports a clear error outside an ADO repo', async ($: any, on: any) => {
  register(on, {});
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'not a git repository' } }));

  const result = await $.command.run({ command: 'prs', args: '' });
  expect(result.text).toContain("isn't a GitHub or Azure DevOps repo");
});

test('bare /pr auto-detects the PR and opens a pane, with no inline text', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  const result = await $.command.run({ command: 'prs', args: '' });
  expect(result.text).toBeUndefined();
});

test('a GitHub-remote repo lists and opens PRs via gh, not az/ADO', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { remoteUrl: 'https://github.com/octocat/widgets.git' });

  const result = await $.command.run({ command: 'prs', args: '42' });
  expect(result.text).toBeUndefined();

  const ui = await $.ui.mount({
    plugin: 'prs',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'prs',
    props: PANE_PROPS,
  });
  expect(await ui.find({ text: /retry flaky upload/ })).toBeDefined();
  expect(await ui.find({ text: /octocat/ })).toBeDefined();
  await ui.unmount();
});

test('review view surfaces a checkout failure without erroring the command', async ($: any, on: any) => {
  register(on, {});
  installMocks(on, { checkoutSucceeds: false });

  const result = await $.command.run({ command: 'prs', args: '318' });
  expect(result.text).toBeUndefined();
});

test('the docked pane draws the file list and reacts to a file press', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'prs', args: '318' });

  const ui = await $.ui.mount({
    plugin: 'prs',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'prs',
    props: PANE_PROPS,
  });

  expect(await ui.find({ text: /trial campaign admin UI/ })).toBeDefined();
  expect(await ui.find({ text: /app\.ts/ })).toBeDefined();
  expect(await ui.find({ text: /new-file\.ts/ })).toBeDefined();
  expect(await ui.find({ text: '+3' })).toBeDefined();
  expect(await ui.find({ text: '-1' })).toBeDefined();
  expect(await ui.find({ text: /^─{10,}$/ })).toBeDefined();
  expect(
    await ui.find({ text: /open PR #318 in browser.*dev\.azure\.com\/aether-engineering\/app-deployments\/_git\/web-frontend\/pullrequest\/318/ }),
  ).toBeDefined();

  await ui.press({ key: 'file:src/new-file.ts' });
  expect(await ui.find({ text: /new line/ })).toBeDefined();
  expect(await ui.find({ text: /diff --git/ })).toBeUndefined();
  expect(await ui.find({ text: /^index /m })).toBeUndefined();

  await ui.unmount();
});

test('the commits tab lists commits compactly and expands one on press', async ($: any, on: any) => {
  register(on, {});
  installMocks(on);

  await $.command.run({ command: 'prs', args: '318' });

  const ui = await $.ui.mount({
    plugin: 'prs',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'prs',
    props: PANE_PROPS,
  });

  await ui.press({ key: 'tab:commits' });
  expect(await ui.find({ text: /fix upload retry/ })).toBeDefined();
  expect(await ui.find({ text: /Retries once on a 5xx/ })).toBeUndefined();

  await ui.press({ key: 'commit:a1b2c3d4e5f6' });
  expect(await ui.find({ text: /Retries once on a 5xx/ })).toBeDefined();

  await ui.press({ key: 'commit:a1b2c3d4e5f6' });
  expect(await ui.find({ text: /Retries once on a 5xx/ })).toBeUndefined();

  await ui.unmount();
});
