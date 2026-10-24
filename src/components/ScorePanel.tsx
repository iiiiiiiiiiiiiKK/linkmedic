import type { DiagnosticReport } from '../../shared/core/types';
import { UI, type Locale } from '../lib/i18n';

interface Props {
  report: DiagnosticReport;
  locale: Locale;
}

const GRADE_TEXT: Record<string, { zh: string; en: string }> = {
  A: { zh: '状态良好', en: 'Healthy' },
  B: { zh: '基本健康', en: 'Mostly healthy' },
  C: { zh: '需要关注', en: 'Needs attention' },
  D: { zh: '问题较多', en: 'Several problems' },
  F: { zh: '严重问题', en: 'Serious problems' },
};

export function ScorePanel({ report, locale }: Props) {
  const t = UI[locale];
  const { value, grade, counts } = report.score;
  const issues = counts.critical + counts.high + counts.medium + counts.low;
  const tone = value >= 90 ? 'pass' : value >= 78 ? 'ok' : value >= 62 ? 'warn' : value >= 45 ? 'high' : 'critical';

  return (
    <section className={`score score--${tone}`} aria-labelledby="score-heading">
      <div className="score__gauge">
        <div
          className="score__dial"
          role="img"
          aria-label={`${t.score}: ${value}/100, ${t.grade} ${grade}`}
          style={{ ['--value' as string]: `${value}` }}
        >
          <span className="score__value">{value}</span>
          <span className="score__unit">/100</span>
        </div>
        <div className="score__grade">
          <span className="score__grade-letter">{grade}</span>
          <span className="score__grade-text">{GRADE_TEXT[grade][locale]}</span>
        </div>
      </div>

      <div className="score__summary">
        <h2 id="score-heading" className="score__heading">
          {issues === 0
            ? locale === 'zh'
              ? '没有发现需要处理的问题'
              : 'Nothing needs fixing'
            : locale === 'zh'
              ? `${issues} 个问题需要处理`
              : `${issues} issue${issues === 1 ? '' : 's'} to fix`}
        </h2>
        <ul className="score__counts">
          {(['critical', 'high', 'medium', 'low', 'pass'] as const).map((severity) => (
            <li key={severity} className={`count count--${severity}`}>
              <span className="count__num">{counts[severity]}</span>
              <span className="count__label">{t.severity[severity]}</span>
            </li>
          ))}
        </ul>
        <p className="score__note">
          {locale === 'zh'
            ? '评分按问题严重度加权，并对重复项做衰减，因此一两处轻微问题不会拉低整体判断。'
            : 'The score weights severity with diminishing returns, so a couple of cosmetic issues cannot mask the real picture.'}
        </p>
      </div>
    </section>
  );
}
