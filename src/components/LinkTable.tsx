import type { DiagnosticReport } from '../../shared/core/types';
import { UI, formatMs, type Locale } from '../lib/i18n';

interface Props {
  report: DiagnosticReport;
  locale: Locale;
}

export function LinkTable({ report, locale }: Props) {
  const t = UI[locale];
  const { checked, totalFound, broken, skipped, truncated } = report.links;

  if (totalFound === 0) {
    return (
      <section className="panel" aria-labelledby="links-heading">
        <h2 id="links-heading" className="panel__title">
          {t.linkResults}
        </h2>
        <p className="empty">{t.noLinks}</p>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="links-heading">
      <div className="panel__head">
        <h2 id="links-heading" className="panel__title">
          {t.linkResults}
        </h2>
        <ul className="link-stats">
          <li>
            <span className="link-stats__num">{totalFound}</span>
            <span className="link-stats__label">{t.linkTotal}</span>
          </li>
          <li>
            <span className="link-stats__num">{checked.length}</span>
            <span className="link-stats__label">{t.linkChecked}</span>
          </li>
          <li>
            <span className={`link-stats__num${broken > 0 ? ' bad' : ''}`}>{broken}</span>
            <span className="link-stats__label">{t.linkBroken}</span>
          </li>
          {skipped > 0 && (
            <li>
              <span className="link-stats__num">{skipped}</span>
              <span className="link-stats__label">{t.linkSkipped}</span>
            </li>
          )}
          {truncated && (
            <li>
              <span className="link-stats__badge">{t.linkTruncated}</span>
            </li>
          )}
        </ul>
      </div>

      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">{t.linkResults}</caption>
          <thead>
            <tr>
              <th scope="col">{locale === 'zh' ? '状态' : 'Status'}</th>
              <th scope="col">{locale === 'zh' ? '链接' : 'Link'}</th>
              <th scope="col">{locale === 'zh' ? '锚文本' : 'Anchor'}</th>
              <th scope="col">{locale === 'zh' ? '耗时' : 'Time'}</th>
            </tr>
          </thead>
          <tbody>
            {checked.map((link, index) => (
              <tr key={`${link.url}-${index}`} className={link.ok ? undefined : 'table__row--bad'}>
                <td>
                  <span className={`status-pill status-pill--${link.ok ? 'pass' : 'high'}`}>
                    {link.status ?? 'ERR'}
                  </span>
                </td>
                <td className="table__url">
                  <a href={link.url} target="_blank" rel="noopener noreferrer nofollow">
                    {link.url}
                  </a>
                  {link.error && <span className="table__error">{link.error}</span>}
                </td>
                <td className="table__anchor">{link.text || <span className="muted">—</span>}</td>
                <td className="mono">{formatMs(link.durationMs)}</td>
              </tr>
            ))}
            {report.links.checked.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  {locale === 'zh'
                    ? '所有候选链接都因安全策略或时间预算被跳过。'
                    : 'Every candidate link was skipped for safety or budget reasons.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
