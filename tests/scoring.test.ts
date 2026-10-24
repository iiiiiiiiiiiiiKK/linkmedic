import { describe, expect, it } from 'vitest';
import { finding, scoreFindings, severityToStatus } from '../shared/core/scoring';
import type { Finding, Severity } from '../shared/core/types';

const make = (severity: Severity, weightOverride?: number): Finding => {
  const result = finding({
    id: `${severity}-${Math.random().toString(36).slice(2, 8)}`,
    check: 'test',
    severity,
    title: { zh: 't', en: 't' },
    detail: { zh: 'd', en: 'd' },
    recommendation: { zh: 'r', en: 'r' },
  });
  return weightOverride === undefined ? result : { ...result, weight: weightOverride };
};

describe('severityToStatus', () => {
  it('maps severities to UI statuses', () => {
    expect(severityToStatus('critical')).toBe('fail');
    expect(severityToStatus('high')).toBe('fail');
    expect(severityToStatus('medium')).toBe('warn');
    expect(severityToStatus('low')).toBe('warn');
    expect(severityToStatus('info')).toBe('skip');
    expect(severityToStatus('pass')).toBe('pass');
  });
});

describe('scoreFindings', () => {
  it('gives 100 to a report with only passes', () => {
    const result = scoreFindings([make('pass'), make('pass')]);
    expect(result.value).toBe(100);
    expect(result.grade).toBe('A');
    expect(result.counts.pass).toBe(2);
  });

  it('never penalises informational findings', () => {
    const result = scoreFindings([make('info'), make('info'), make('pass')]);
    expect(result.value).toBe(100);
  });

  it('counts severities correctly', () => {
    const result = scoreFindings([
      make('critical'),
      make('high'),
      make('medium'),
      make('low'),
      make('pass'),
      make('info'),
    ]);
    expect(result.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 1, info: 1, pass: 1 });
  });

  it('caps the score when something critical is present', () => {
    const result = scoreFindings([make('critical')]);
    expect(result.value).toBeLessThanOrEqual(45);
    expect(result.grade).toBe('F');
  });

  it('is monotonic: more issues never score higher', () => {
    let previous = 101;
    const pool: Severity[] = ['low', 'low', 'medium', 'medium', 'high', 'high', 'critical'];
    const current: Finding[] = [];
    for (const severity of pool) {
      current.push(make(severity));
      const value = scoreFindings([...current]).value;
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('damps a long tail of low findings', () => {
    const singles = scoreFindings([make('low')]);
    const many = scoreFindings(Array.from({ length: 10 }, () => make('low')));
    expect(many.value).toBeLessThan(singles.value);
    // ...but ten cosmetic issues must not look as bad as one critical failure.
    expect(many.value).toBeGreaterThan(scoreFindings([make('critical')]).value);
  });

  it('assigns grades on the documented boundaries', () => {
    expect(scoreFindings([]).grade).toBe('A');
    const gradeFor = (value: number) => {
      // build a report whose damped deduction lands near the requested score
      const deduction = -55 * Math.log(1 - (100 - value) / 100);
      return scoreFindings([make('medium', deduction)]).grade;
    };
    expect(gradeFor(95)).toBe('A');
    expect(gradeFor(80)).toBe('B');
    expect(gradeFor(65)).toBe('C');
    expect(gradeFor(50)).toBe('D');
    expect(gradeFor(30)).toBe('F');
  });
});
