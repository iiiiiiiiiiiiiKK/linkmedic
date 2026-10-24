import { useState } from 'react';
import type { DiagnosticReport } from '../../shared/core/types';
import { UI, formatBytes, formatMs, type Locale } from '../lib/i18n';
import type { HealthInfo } from '../lib/api';

interface Props {
  report: DiagnosticReport;
  locale: Locale;
  health: HealthInfo | null;
}

export function OverviewPanel({ report, locale, health }: Props) {
  const t = UI[locale];
  const page = report.page;
  const cert = page?.certificate ?? null;
  const [showHeaders, setShowHeaders] = useState(false);

  const headerRows = page ? Object.entries(page.headers).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <>
      <section className="panel" aria-labelledby="overview-heading">
        <h2 id="overview-heading" className="panel__title">
          {t.overview}
        </h2>

        <dl className="facts">
          <Fact label={t.finalUrl} mono wide>
            {page?.finalUrl ?? report.target.requestedUrl}
          </Fact>
          <Fact label={t.status}>
            {page ? (
              <span className={`status-pill status-pill--${statusTone(page.status)}`}>HTTP {page.status}</span>
            ) : (
              <span className="muted">{locale === 'zh' ? '无响应' : 'No response'}</span>
            )}
          </Fact>
          <Fact label={t.redirects}>{page ? page.redirects.length - 1 : 0}</Fact>
          <Fact label={t.ttfb}>{formatMs(page?.timing.ttfbMs)}</Fact>
          <Fact label={t.total}>{formatMs(page?.timing.totalMs)}</Fact>
          <Fact label={t.size}>{formatBytes(page?.bodyBytes)}</Fact>
          <Fact label={t.contentType} mono>
            {page?.contentType ?? '—'}
          </Fact>
          <Fact label={t.ipPinning}>
            <span className={report.engine.ipPinning ? 'ok' : 'muted'}>
              {report.engine.ipPinning ? t.ipPinningOn : t.ipPinningOff}
            </span>
          </Fact>
        </dl>

        {page && page.redirects.length > 1 && (
          <div className="redirects">
            <h3 className="subhead">{t.redirects}</h3>
            <ol className="redirect-chain">
              {page.redirects.map((hop, index) => (
                <li key={`${hop.url}-${index}`} className="redirect-chain__item">
                  <span className="redirect-chain__status mono">{hop.status}</span>
                  <span className="redirect-chain__url mono">{hop.url}</span>
                  {hop.location && <span className="redirect-chain__loc mono">→ {hop.location}</span>}
                  <span className="redirect-chain__time mono">{formatMs(hop.durationMs)}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="cert-heading">
        <h2 id="cert-heading" className="panel__title">
          {t.certificate}
        </h2>

        {!cert || cert.valid === null ? (
          <p className="empty">{t.certUnavailable}</p>
        ) : (
          <dl className="facts">
            <Fact label={t.grade}>
              <span className={cert.valid ? 'ok' : 'bad'}>
                {cert.valid ? (locale === 'zh' ? '有效' : 'Valid') : locale === 'zh' ? '无效' : 'Invalid'}
              </span>
            </Fact>
            {cert.subject && (
              <Fact label={t.subject} mono>
                {cert.subject}
              </Fact>
            )}
            {cert.issuer && (
              <Fact label={t.issuer} mono>
                {cert.issuer}
              </Fact>
            )}
            {cert.validTo && (
              <Fact label={t.validity} mono>
                {cert.validTo}
              </Fact>
            )}
            {typeof cert.daysRemaining === 'number' && <Fact label={t.daysLeft}>{cert.daysRemaining}</Fact>}
            {cert.protocol && (
              <Fact label={t.protocol} mono>
                {cert.protocol}
              </Fact>
            )}
            {cert.error && (
              <Fact label={t.evidence} wide>
                {cert.error}
              </Fact>
            )}
          </dl>
        )}

        <p className="panel__footnote">{report.engine.certificateDetails ? t.certDetailsOn : t.certDetailsOff}</p>
      </section>

      {report.metadata && (
        <section className="panel" aria-labelledby="meta-heading">
          <h2 id="meta-heading" className="panel__title">
            {t.metadata}
          </h2>
          <dl className="facts">
            <Fact label={t.title} wide>
              {report.metadata.title ?? <span className="muted">—</span>}
            </Fact>
            <Fact label={t.description} wide>
              {report.metadata.description ?? <span className="muted">—</span>}
            </Fact>
            <Fact label={t.canonical} mono wide>
              {report.metadata.canonical ?? <span className="muted">—</span>}
            </Fact>
            <Fact label={t.lang} mono>
              {report.metadata.lang ?? <span className="muted">—</span>}
            </Fact>
            <Fact label={t.robots} mono>
              {report.metadata.robots ?? <span className="muted">—</span>}
            </Fact>
            <Fact label={t.viewport} mono>
              {report.metadata.viewport ?? <span className="muted">—</span>}
            </Fact>
            <Fact label={t.h1} wide>
              {report.metadata.h1.length > 0 ? report.metadata.h1.join(' | ') : <span className="muted">—</span>}
            </Fact>
            <Fact label={t.images}>
              {report.metadata.imagesTotal} / {report.metadata.imagesMissingAlt}
            </Fact>
            <Fact label={t.openGraph}>
              {Object.keys(report.metadata.openGraph).length > 0
                ? Object.keys(report.metadata.openGraph).join(', ')
                : '—'}
            </Fact>
            <Fact label={t.twitter}>
              {Object.keys(report.metadata.twitter).length > 0 ? Object.keys(report.metadata.twitter).join(', ') : '—'}
            </Fact>
          </dl>
        </section>
      )}

      {headerRows.length > 0 && (
        <section className="panel" aria-labelledby="headers-heading">
          <div className="panel__head">
            <h2 id="headers-heading" className="panel__title">
              {t.headers}
              <span className="panel__count">{headerRows.length}</span>
            </h2>
            <button
              type="button"
              className="button button--ghost button--small"
              aria-expanded={showHeaders}
              onClick={() => setShowHeaders((value) => !value)}
            >
              {showHeaders ? (locale === 'zh' ? '收起' : 'Hide') : locale === 'zh' ? '展开' : 'Show'}
            </button>
          </div>
          {showHeaders && (
            <div className="headers">
              {headerRows.map(([key, value]) => (
                <div key={key} className="headers__row">
                  <span className="headers__key mono">{key}</span>
                  <span className="headers__value mono">{value}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="engine-heading">
        <h2 id="engine-heading" className="panel__title">
          {t.engine}
        </h2>
        <dl className="facts">
          <Fact label={t.engine} wide>
            {report.engine.runtime === 'cloudflare-workers' ? t.engineEdge : t.engineNode}
          </Fact>
          <Fact label={t.ipPinning} wide>
            {report.engine.ipPinning ? t.ipPinningOn : t.ipPinningOff}
          </Fact>
          <Fact label={t.certDetails} wide>
            {report.engine.certificateDetails ? t.certDetailsOn : t.certDetailsOff}
          </Fact>
          {health && (
            <Fact label={locale === 'zh' ? '速率限制' : 'Rate limit'} wide>
              {health.limits.rateLimitPerMinute} / min ·{' '}
              {health.limits.rateLimitEnforced
                ? locale === 'zh'
                  ? '已启用'
                  : 'enforced'
                : locale === 'zh'
                  ? '未启用（无 KV 存储）'
                  : 'not enforced (no KV store)'}
            </Fact>
          )}
        </dl>
      </section>
    </>
  );
}

function Fact({
  label,
  children,
  mono,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`fact${wide ? ' fact--wide' : ''}`}>
      <dt className="fact__label">{label}</dt>
      <dd className={`fact__value${mono ? ' mono' : ''}`}>{children}</dd>
    </div>
  );
}

function statusTone(status: number): string {
  if (status >= 500) return 'critical';
  if (status >= 400) return 'high';
  if (status >= 300) return 'medium';
  return 'pass';
}
