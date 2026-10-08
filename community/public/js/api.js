// community/public/js/api.js — the typed-ish client for /api/*.
// Every call throws `ApiError` (with `code` and `status`) so views can branch on a stable code.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || '请求失败');
    this.status = status;
    this.code = code || 'ERROR';
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络连接失败，请稍后重试');
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    const err = data && data.error;
    throw new ApiError(res.status, err?.code, err?.message || `请求失败（${res.status}）`);
  }
  return data ?? {};
}

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap'),
  me: () => request('GET', '/api/auth/me'),
  login: (loginName, password) => request('POST', '/api/auth/login', { loginName, password }),
  logout: () => request('POST', '/api/auth/logout'),

  listServers: ({ probe = false } = {}) => request('GET', `/api/servers${probe ? '?probe=1' : ''}`),
  getServer: (id) => request('GET', `/api/servers/${id}`),
  createServer: (payload) => request('POST', '/api/servers', payload),
  updateServer: (id, payload) => request('PUT', `/api/servers/${id}`, payload),
  deleteServer: (id) => request('DELETE', `/api/servers/${id}`),

  listAccounts: () => request('GET', '/api/accounts'),
  createAccount: (payload) => request('POST', '/api/accounts', payload),
  updateAccount: (id, payload) => request('PUT', `/api/accounts/${id}`, payload),
  resetAccountPassword: (id, password) => request('POST', `/api/accounts/${id}/password`, { password }),
  deleteAccount: (id) => request('DELETE', `/api/accounts/${id}`),
};
