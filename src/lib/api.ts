import type { DiagnosticReport } from '../../shared/core/types';

export interface ApiSuccess {
  report: DiagnosticReport;
}

export interface ApiFailure {
  error: { code: string; message: string; retryAfter?: number };
  report?: DiagnosticReport;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;
  readonly report?: DiagnosticReport;

  constructor(
    message: string,
    code: string,
    status: number,
    options: { retryAfter?: number; report?: DiagnosticReport } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfter = options.retryAfter;
    this.report = options.report;
  }
}

export interface AnalyzeRequest {
  url: string;
  linkCheckLimit: number;
  sameOriginLinksOnly: boolean;
}

/**
 * Call the diagnosis endpoint.
 *
 * A 422 means "the URL itself is invalid" and still carries a report, so it is
 * surfaced as an ApiError with `report` attached rather than as a network error.
 */
export async function analyze(body: AnalyzeRequest, signal?: AbortSignal): Promise<DiagnosticReport> {
  let response: Response;
  try {
    response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ApiError('The request was cancelled.', 'cancelled', 0);
    }
    throw new ApiError(
      'The browser could not reach the LinkMedic API. Check your connection and try again.',
      'network_error',
      0,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      `The API returned a non-JSON response (HTTP ${response.status}).`,
      'bad_response',
      response.status,
    );
  }

  const body429 = payload as ApiFailure;
  if (!response.ok) {
    const error = body429?.error ?? {
      code: 'unknown',
      message: `The request failed with HTTP ${response.status}.`,
    };
    throw new ApiError(error.message, error.code, response.status, {
      retryAfter: error.retryAfter,
      report: body429.report,
    });
  }

  const success = payload as ApiSuccess;
  if (!success.report) {
    throw new ApiError('The API response was missing the report payload.', 'bad_response', response.status);
  }
  return success.report;
}

export interface HealthInfo {
  status: string;
  version: string;
  runtime: string;
  capabilities: {
    ipPinning: boolean;
    certificateDetails: boolean;
    certificateVerdict: boolean;
    linkChecking: boolean;
    history: boolean;
    sameOriginFilter: boolean;
  };
  limits: { rateLimitPerMinute: number; maxLinks: number; rateLimitEnforced: boolean };
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthInfo | null> {
  try {
    const response = await fetch('/api/health', { signal });
    if (!response.ok) return null;
    return (await response.json()) as HealthInfo;
  } catch {
    return null;
  }
}
