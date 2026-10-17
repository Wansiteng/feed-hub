/* 管理页面的数据接口，两种模式，导出的函数一样：
 * - GitHub（默认）：读写私有仓库里的配置、读取 data 分支上的运行状态、触发 Actions。token 只保存在本机浏览器里，只发给 api.github.com
 * - 本机（config.js 里 mode 是 local，由本地服务 feedhub/server.py 提供，见 docs/local-run.md）：同样的事改成调本地服务的 api/，
 *   口令只保存在本机浏览器里，只发给这个本地服务 */
import { S } from './store.js';

export const LOCAL = (window.FEEDHUB || {}).mode === 'local';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(url, headers, { method = 'GET', body, raw = false } = {}, offline) {
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch {
    throw new ApiError(offline, 0);
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

export async function gh(path, opts = {}) {
  return call(`https://api.github.com${path}`, {
    Authorization: `Bearer ${S.token}`,
    Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }, opts, '连不上 GitHub，检查一下网络');
}

/** 本地服务的接口。相对地址：管理页面就是这个服务提供的 */
function local(path, opts = {}) {
  return call(`api/${path}`, { Authorization: `Bearer ${S.token}` }, opts, '连不上这台 Mac 上的 Feed Hub 服务，检查一下网络，或者服务是不是停了');
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

/** 本机模式下登录时拿到的信息（订阅用的 key 等）；GitHub 模式下一直是 null */
let session = null;

async function localSession() {
  // 顺便让服务发一个只能打开站点页面的 cookie（简报、译文、运行日志在新标签页里打开时用）
  session = await local('session');
  return session;
}

export async function fetchRepo() {
  if (LOCAL) {
    await localSession(); // 口令不对在这里就 401
    return { default_branch: 'main', full_name: S.repo };
  }
  return gh(`/repos/${S.repo}`);
}

export async function fetchUser() {
  try {
    if (LOCAL) {
      const s = session || await localSession();
      return { login: s.login, name: s.name || '' };
    }
    const u = await gh('/user');
    return { login: u.login, name: u.name || '' };
  } catch {
    return null;
  }
}

/** 订阅地址里要带的 key（只有本机模式有；RSS 阅读器带不了口令和 cookie） */
export function feedKey() {
  return session?.feed_key || '';
}

export async function readConfig(name) {
  if (LOCAL) return local(`config/${q(name)}`);
  const j = await gh(`/repos/${S.repo}/contents/config/${name}?ref=${q(S.branch)}`);
  return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
}

export async function writeConfig(name, data, sha, message, { compact = false } = {}) {
  // compact：不缩进，给会越记越多的文件（阅读记录）省地方
  const text = `${JSON.stringify(data, null, compact ? 0 : 2)}\n`;
  if (LOCAL) {
    const j = await local(`config/${q(name)}`, { method: 'PUT', body: { content: text, sha: sha || undefined, message } });
    return j.sha;
  }
  const body = { message, content: b64encode(text), branch: S.branch };
  if (sha) body.sha = sha; // 没有 sha 表示新建文件
  const j = await gh(`/repos/${S.repo}/contents/config/${name}`, { method: 'PUT', body });
  return j.content.sha;
}

/** data 分支上的文件（运行状态）。还没运行过时不存在，返回 null。 */
export async function readData(path) {
  try {
    if (LOCAL) return await local(`state/${path}`);
    return JSON.parse(await gh(`/repos/${S.repo}/contents/${path}?ref=data`, { raw: true }));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function listWorkflowRuns(perPage = 10) {
  const j = LOCAL
    ? await local(`runs?per_page=${perPage}`)
    : await gh(`/repos/${S.repo}/actions/workflows/${WORKFLOW}/runs?per_page=${perPage}`);
  return j.workflow_runs || [];
}

export async function dispatchWorkflow() {
  if (LOCAL) {
    await local('runs', { method: 'POST' });
    return;
  }
  await gh(`/repos/${S.repo}/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: S.branch } });
}

/** 把 API 错误翻译成人话。 */
export function explain(error) {
  const status = error?.status;
  if (LOCAL && status === 401) return '口令不对或者已经换过了，请重新登录。';
  if (LOCAL && status === 429) return '口令错了太多次，过 10 分钟再试。';
  if (status === 401) return 'token 已失效或过期，请重新登录。';
  if (status === 403) return 'token 权限不够：需要这个仓库的 Contents 和 Actions 读写权限。';
  if (status === 404) return '找不到对应的内容：检查仓库名，或者这个仓库还没有这项数据。';
  if (status === 409 || status === 422) return '配置在别处被改过了，请放弃本页的更改后重试。';
  return error?.message || String(error);
}
