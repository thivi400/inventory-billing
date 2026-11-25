import type { Role, StaffUser } from '../types';

export class ApiError extends Error {
  status: number;
  code?: string;
  lockedUntilMs?: number | null;
  details?: unknown;
  notPosted?: boolean;

  constructor(
    message: string,
    status: number,
    code?: string,
    lockedUntilMs?: number | null,
    details?: unknown,
    notPosted?: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.lockedUntilMs = lockedUntilMs;
    this.details = details;
    this.notPosted = notPosted;
  }
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    operationId?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.operationId) {
    headers['X-Operation-Id'] = options.operationId;
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError('Could not reach the shop server. Check connection and retry.', 0, 'network_error');
  }

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { error: text };
    }
  }

  if (!res.ok) {
    const msg =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.detail === 'string'
          ? parsed.detail
          : `Request failed (${res.status})`;
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    const lockedUntilMs =
      typeof parsed.lockedUntilMs === 'number' ? parsed.lockedUntilMs : null;
    const notPosted = parsed.not_posted === true;
    throw new ApiError(msg, res.status, code, lockedUntilMs, parsed, notPosted);
  }

  return parsed as T;
}

export interface AuthStatusResponse {
  initialized: boolean;
  trialMode: boolean;
  shopNameEn: string;
  shopNameTa: string;
  staff: StaffUser[];
}

export interface AuthSessionResponse {
  access_token: string;
  user: {
    id: string;
    name: string;
    name_ta?: string;
    role: Role;
  };
  trialMode?: boolean;
}

export const api = {
  get<T>(path: string, token?: string | null): Promise<T> {
    return request<T>(path, { method: 'GET', token });
  },

  post<T>(path: string, body: unknown, token?: string | null, operationId?: string): Promise<T> {
    return request<T>(path, { method: 'POST', body, token, operationId });
  },

  put<T>(path: string, body: unknown, token?: string | null): Promise<T> {
    return request<T>(path, { method: 'PUT', body, token });
  },

  getStatus(): Promise<AuthStatusResponse> {
    return request<AuthStatusResponse>('/auth/status');
  },

  bootstrapOwner(payload: {
    ownerName: string;
    ownerNameTa?: string;
    pin: string;
    shopNameEn: string;
    shopNameTa?: string;
    addressEn?: string;
    addressTa?: string;
    phone?: string;
    taxId?: string;
  }): Promise<AuthSessionResponse> {
    return request<AuthSessionResponse>('/auth/bootstrap-owner', {
      method: 'POST',
      body: payload,
    });
  },

  bootstrapTrial(): Promise<{ staff: Array<{ name: string; role: Role; pin: string }> }> {
    return request<{ staff: Array<{ name: string; role: Role; pin: string }> }>('/auth/bootstrap-trial', {
      method: 'POST',
      body: {},
    });
  },

  signIn(pin: string, roleOrStaffId: string, staffId?: string): Promise<AuthSessionResponse> {
    return request<AuthSessionResponse>('/auth/login', {
      method: 'POST',
      body: {
        pin,
        staffId: staffId || undefined,
        role: staffId ? undefined : roleOrStaffId,
      },
    });
  },

  verifyPin(pin: string, token: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/auth/verify-pin', {
      method: 'POST',
      body: { pin },
      token,
    });
  },

  signOut(token: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/auth/logout', {
      method: 'POST',
      body: {},
      token,
    });
  },
};
