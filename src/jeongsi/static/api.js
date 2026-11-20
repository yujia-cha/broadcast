// 로컬 API 호출. 값을 바꾸는 요청에는 X-Jeongsi-Client 헤더가 필요하다.
const CLIENT_HEADER = { "X-Jeongsi-Client": "1" };

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api(method, path, body) {
  const options = { method, headers: { ...CLIENT_HEADER } };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError("앱과 연결할 수 없습니다. 앱이 실행 중인지 확인하세요.", 0);
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(data?.error || `요청을 처리하지 못했습니다 (${response.status}).`, response.status, data);
  }
  return data;
}

export const get = (path) => api("GET", path);
export const post = (path, body) => api("POST", path, body ?? {});
export const put = (path, body) => api("PUT", path, body);
export const patch = (path, body) => api("PATCH", path, body);
export const del = (path) => api("DELETE", path);
