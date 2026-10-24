/** Shared contracts between the API layer, the diagnostics engine and the UI. */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'pass';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** Text that ships in both UI languages. Reports keep both so they stay portable. */
export interface Bilingual {
  zh: string;
  en: string;
}

export interface NormalizedTarget {
  requestedUrl: string;
  host: string;
  hostname: string;
  port: number;
  protocol: 'http' | 'https';
  path: string;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
  method: 'GET' | 'HEAD';
  durationMs: number;
  ip: string | null;
  /** set when the hop was refused by the SSRF guard instead of being followed */
  blocked?: string;
}

export interface CertificateInfo {
  /** `null` means "could not be inspected on this runtime" — never guessed. */
  valid: boolean | null;
  source: 'tls-inspection' | 'edge-validation' | 'unavailable';
  subject?: string;
  issuer?: string;
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  protocol?: string;
  fingerprint?: string;
  error?: string;
  [key: string]: unknown;
}

export interface PageTiming {
  ttfbMs: number | null;
  totalMs: number;
}

export interface PageFetch {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
  truncated: boolean;
  redirects: RedirectHop[];
  timing: PageTiming;
  certificate: CertificateInfo;
  ip: string | null;
  contentType: string | null;
  charset: string | null;
}

export interface LinkRef {
  href: string;
  text: string;
  resolved: string | null;
  external: boolean;
}

export interface LinkCheck {
  url: string;
  text: string;
  status: number | null;
  ok: boolean;
  finalUrl: string | null;
  redirected: boolean;
  durationMs: number;
  error: string | null;
  skipped?: string;
}

export interface PageMetadata {
  title: string | null;
  titleLength: number;
  description: string | null;
  descriptionLength: number;
  canonical: string | null;
  canonicalIsCrossOrigin: boolean;
  robots: string | null;
  robotsDirectives: string[];
  lang: string | null;
  charset: string | null;
  viewport: string | null;
  h1: string[];
  imagesTotal: number;
  imagesMissingAlt: number;
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  favicon: string | null;
  hreflang: { lang: string; href: string }[];
  scripts: number;
  stylesheets: number;
  textLength: number;
}

export interface Finding {
  id: string;
  check: string;
  severity: Severity;
  status: CheckStatus;
  title: Bilingual;
  detail: Bilingual;
  recommendation: Bilingual;
  evidence?: string;
  weight: number;
}

export interface EngineInfo {
  runtime: 'cloudflare-workers' | 'node';
  transport: 'edge-fetch' | 'node-socket';
  /** connection target is pinned to the validated IP (true only on the node transport) */
  ipPinning: boolean;
  /** leaf certificate details (subject/issuer/expiry) are readable */
  certificateDetails: boolean;
}

export interface DiagnosticReport {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  engine: EngineInfo;
  input: {
    raw: string;
    normalizedUrl: string;
    linkCheckLimit: number;
    sameOriginLinksOnly: boolean;
  };
  target: NormalizedTarget;
  page: PageFetch | null;
  metadata: PageMetadata | null;
  links: {
    checked: LinkCheck[];
    totalFound: number;
    broken: number;
    skipped: number;
    truncated: boolean;
  };
  findings: Finding[];
  score: {
    value: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    counts: Record<Severity, number>;
  };
  timings: {
    totalMs: number;
    fetchMs: number | null;
    linkCheckMs: number | null;
  };
  warnings: Bilingual[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryAfter?: number;
  };
}

export const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info', 'pass'];

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 40,
  high: 20,
  medium: 8,
  low: 3,
  info: 0,
  pass: 0,
};
