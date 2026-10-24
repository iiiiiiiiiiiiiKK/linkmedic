import type { CertificateInfo, Severity, Finding, CheckStatus, Bilingual } from './types';
import { SEVERITY_WEIGHT } from './types';

export interface FindingInput {
  id: string;
  check: string;
  severity: Severity;
  title: Bilingual;
  detail: Bilingual;
  recommendation: Bilingual;
  evidence?: string;
  status?: CheckStatus;
}

export function severityToStatus(severity: Severity): CheckStatus {
  if (severity === 'pass') return 'pass';
  if (severity === 'info') return 'skip';
  if (severity === 'critical' || severity === 'high') return 'fail';
  return 'warn';
}

export function finding(input: FindingInput): Finding {
  return {
    id: input.id,
    check: input.check,
    severity: input.severity,
    status: input.status ?? severityToStatus(input.severity),
    title: input.title,
    detail: input.detail,
    recommendation: input.recommendation,
    evidence: input.evidence,
    weight: SEVERITY_WEIGHT[input.severity],
  };
}

/**
 * Health score.
 *
 * Every finding carries a weight; the score is the share of possible deductions
 * we avoided, with diminishing returns so a long tail of cosmetic issues never
 * hides a hard failure. Checks that could not run (info) never deduct.
 */
export function scoreFindings(findings: Finding[]): {
  value: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  counts: Record<Severity, number>;
} {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    pass: 0,
  };
  let deduction = 0;
  for (const f of findings) {
    counts[f.severity] += 1;
    if (f.severity === 'pass' || f.severity === 'info') continue;
    deduction += f.weight;
  }

  const damped = deduction === 0 ? 0 : 100 * (1 - Math.exp(-deduction / 55));
  let value = Math.round(Math.max(0, Math.min(100, 100 - damped)));

  // A site that is down or does not really serve HTTPS can never grade out as
  // healthy: critical findings cap the score below the "F" boundary.
  if (findings.some((f) => f.severity === 'critical')) value = Math.min(value, 40);

  const grade: 'A' | 'B' | 'C' | 'D' | 'F' =
    value >= 90 ? 'A' : value >= 78 ? 'B' : value >= 62 ? 'C' : value >= 45 ? 'D' : 'F';

  return { value, grade, counts };
}

export function describeCertificate(cert: CertificateInfo): string {
  if (cert.valid === null) return cert.error ?? 'Certificate details are unavailable on this runtime.';
  if (cert.valid === false) return cert.error ?? 'The certificate was rejected during the TLS handshake.';
  const bits: string[] = [];
  if (cert.subject) bits.push(`subject=${cert.subject}`);
  if (cert.issuer) bits.push(`issuer=${cert.issuer}`);
  if (cert.validTo) bits.push(`expires=${cert.validTo}`);
  if (typeof cert.daysRemaining === 'number') bits.push(`daysLeft=${cert.daysRemaining}`);
  if (cert.protocol) bits.push(`protocol=${cert.protocol}`);
  return bits.join(' · ') || 'Certificate accepted by the TLS stack.';
}
