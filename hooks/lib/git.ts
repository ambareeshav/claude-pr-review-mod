// Pure parsing only — nothing here touches `$`. Anything that runs `git`
// itself lives in register.tsx (the validator requires every `$` call to
// be textually in the hooks module file, not reached through an import).

export type AdoRepoContext = {
  org: string;
  project: string;
  repo: string;
};

const DEV_AZURE_RE =
  /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i;
const SSH_RE = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i;
const VS_RE = /^https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i;

export function parseAdoRemote(url: string): AdoRepoContext | null {
  const trimmed = url.trim();

  let m = trimmed.match(DEV_AZURE_RE);
  if (m) return { org: decodeURIComponent(m[1]), project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };

  m = trimmed.match(SSH_RE);
  if (m) return { org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };

  m = trimmed.match(VS_RE);
  if (m) return { org: m[1], project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };

  return null;
}

export function branchName(ref: string): string {
  return ref.replace('refs/heads/', '');
}
