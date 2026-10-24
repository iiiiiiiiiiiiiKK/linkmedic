import { useMemo, useState } from 'react';
import type { DiagnosticReport, Severity } from '../../shared/core/types';
import { UI, type Locale } from '../lib/i18n';

interface Props {
  report: DiagnosticReport;
  locale: Locale;
}

type Filter = 'all' | 'issues' | 'pass';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info', 'pass'];

export function FindingList({ report, locale }: Props) {
  const t = UI[locale];
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const findings = useMemo(() => {
    const sorted = [...report.findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
    if (filter === 'issues') return sorted.filter((f) => f.severity !== 'pass' && f.severity !== 'info');
    if (filter === 'pass') return sorted.filter((f) => f.severity === 'pass');
    return sorted;
  }, [report.findings, filter]);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const issueCount = report.findings.filter((f) => f.severity !== 'pass' && f.severity !== 'info').length;
  const passCount = report.findings.filter((f) => f.severity === 'pass').length;

  return (
    <section className="panel" aria-labelledby="findings-heading">
      <div className="panel__head">
        <h2 id="findings-heading" className="panel__title">
          {t.findings}
          <span className="panel__count">{report.findings.length}</span>
        </h2>
        <div className="tabs" role="tablist" aria-label={t.findings}>
          {(
            [
              ['all', t.filterAll, report.findings.length],
              ['issues', t.filterIssues, issueCount],
              ['pass', t.filterPass, passCount],
            ] as [Filter, string, number][]
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`tab-${key}`}
              aria-selected={filter === key}
              aria-controls="findings-panel"
              className={`tab${filter === key ? ' tab--active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
              <span className="tab__count">{count}</span>
            </button>
          ))}
        </div>
      </div>

      <div id="findings-panel" role="tabpanel" aria-labelledby={`tab-${filter}`}>
        {findings.length === 0 ? (
          <p className="empty">
            {filter === 'issues'
              ? locale === 'zh'
                ? '没有需要处理的问题。'
                : 'No issues to fix.'
              : locale === 'zh'
                ? '这一分类下没有条目。'
                : 'Nothing in this category.'}
          </p>
        ) : (
          <ul className="findings">
            {findings.map((finding) => {
              const isOpen = open.has(finding.id);
              const panelId = `finding-${finding.id}`;
              return (
                <li key={finding.id} className={`finding finding--${finding.severity}`}>
                  <button
                    type="button"
                    className="finding__head"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggle(finding.id)}
                  >
                    <span className={`badge badge--${finding.severity}`}>{t.severity[finding.severity]}</span>
                    <span className="finding__title">{finding.title[locale]}</span>
                    <span className="finding__check">{t.checks[finding.check] ?? finding.check}</span>
                    <Chevron open={isOpen} />
                  </button>

                  <div className="finding__body" id={panelId} hidden={!isOpen}>
                    <p className="finding__detail">{finding.detail[locale]}</p>

                    {finding.evidence && (
                      <div className="finding__evidence">
                        <span className="finding__label">{t.evidence}</span>
                        <pre className="code-block">{finding.evidence}</pre>
                      </div>
                    )}

                    {finding.severity !== 'pass' && (
                      <div className="finding__rec">
                        <span className="finding__label">{t.recommendation}</span>
                        <p>{finding.recommendation[locale]}</p>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron${open ? ' chevron--open' : ''}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
