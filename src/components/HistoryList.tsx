import { UI, formatDateTime, hostLabel, type Locale } from '../lib/i18n';
import type { HistoryEntry } from '../lib/history';

interface Props {
  entries: HistoryEntry[];
  locale: Locale;
  onOpen: (entry: HistoryEntry) => void;
  onClear: () => void;
}

export function HistoryList({ entries, locale, onOpen, onClear }: Props) {
  const t = UI[locale];

  return (
    <section className="panel panel--history" aria-labelledby="history-heading">
      <div className="panel__head">
        <h2 id="history-heading" className="panel__title">
          {t.history}
          {entries.length > 0 && <span className="panel__count">{entries.length}</span>}
        </h2>
        {entries.length > 0 && (
          <button type="button" className="button button--ghost button--small" onClick={onClear}>
            {t.clearHistory}
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <>
          <p className="empty">{t.noHistory}</p>
          <p className="panel__footnote">{t.historyNote}</p>
        </>
      ) : (
        <>
          <ul className="history">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="history__row" onClick={() => onOpen(entry)}>
                  <span className={`history__score history__score--${tone(entry.score)}`}>{entry.score}</span>
                  <span className="history__body">
                    <span className="history__url">{hostLabel(entry.url)}</span>
                    <span className="history__meta">
                      {formatDateTime(entry.createdAt, locale)}
                      {entry.issues > 0 && (
                        <>
                          {' · '}
                          {entry.issues} {t.issues}
                        </>
                      )}
                    </span>
                  </span>
                  <span className="history__grade">{entry.grade}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="panel__footnote">{t.historyNote}</p>
        </>
      )}
    </section>
  );
}

function tone(score: number): string {
  if (score >= 90) return 'pass';
  if (score >= 78) return 'ok';
  if (score >= 62) return 'warn';
  return 'high';
}
