/* GitHub API：读写私有仓库里的配置、读取 data 分支上的运行状态、触发 Actions。
 * token 只保存在本机浏览器里，只发给 api.github.com。 */
import { S } from './store.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function gh(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {
    Authorization: `Bearer ${S.token}`,
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
    });
  } catch {
    throw new ApiError('连不上 GitHub，检查一下网络', 0);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.message) message += `：${j.message}`;
    } catch { /* 非 JSON */ }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

const q = encodeURIComponent;
const WORKFLOW = 'pipeline.yml';

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export async function fetchRepo() {
  return gh(`/repos/${S.repo}`);
}

export async function fetchUser() {
  try {
    const u = await gh('/user');
    return { login: u.login, name: u.name || '' };
  } catch {
    return null;
  }
}

export async function readConfig(name) {
  const j = await gh(`/repos/${S.repo}/contents/config/${name}?ref=${q(S.branch)}`);
  return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
}

export async function writeConfig(name, data, sha, message) {
  const body = { message, content: b64encode(`${JSON.stringify(data, null, 2)}\n`), branch: S.branch };
  if (sha) body.sha = sha; // 没有 sha 表示新建文件
  const j = await gh(`/repos/${S.repo}/contents/config/${name}`, { method: 'PUT', body });
  return j.content.sha;
}

/** data 分支上的文件（运行状态）。还没运行过时不存在，返回 null。 */
export async function readData(path) {
  try {
    return JSON.parse(await gh(`/repos/${S.repo}/contents/${path}?ref=data`, { raw: true }));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function listWorkflowRuns(perPage = 10) {
  const j = await gh(`/repos/${S.repo}/actions/workflows/${WORKFLOW}/runs?per_page=${perPage}`);
  return j.workflow_runs || [];
}

export async function dispatchWorkflow() {
  await gh(`/repos/${S.repo}/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: S.branch } });
}

/** 把 API 错误翻译成人话。 */
export function explain(error) {
  const status = error?.status;
  if (status === 401) return 'token 已失效或过期，请重新登录。';
  if (status === 403) return 'token 权限不够：需要这个仓库的 Contents 和 Actions 读写权限。';
  if (status === 404) return '找不到对应的内容：检查仓库名，或者这个仓库还没有这项数据。';
  if (status === 409 || status === 422) return '配置在别处被改过了，请放弃本页的更改后重试。';
  return error?.message || String(error);
}
