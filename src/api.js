export class ApiError extends Error {
  constructor(response, body) {
    super(body?.error?.message || `请求失败：${response.status}`);
    this.name = 'ApiError';
    this.status = response.status;
    this.code = body?.error?.code || 'HTTP_ERROR';
    this.body = body;
  }
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function apiFetch(path, options = {}) {
  const simulateOffline = globalThis.localStorage?.getItem('offline-forms-demo-offline') === '1';
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
      ...(simulateOffline ? { 'X-Simulate-Offline': 'true' } : {})
    }
  });

  const body = await parseJson(response);
  if (!response.ok) throw new ApiError(response, body);
  return body;
}

export function getForms(signal) {
  return apiFetch('/api/forms', { signal });
}

export function patchForm(formId, payload, failureMode = null) {
  const headers = failureMode ? { 'X-Demo-Failure': failureMode } : {};
  return apiFetch(`/api/forms/${encodeURIComponent(formId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(payload)
  });
}

export function applyRemoteEdit(formId, changes, actor) {
  return apiFetch(`/api/forms/${encodeURIComponent(formId)}/remote-edit`, {
    method: 'POST',
    body: JSON.stringify({ changes, actor })
  });
}
