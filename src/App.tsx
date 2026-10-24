import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, analyze, fetchHealth, type HealthInfo } from './lib/api';
import { UI, type Locale, STORAGE_KEYS, formatDateTime, hostLabel } from './lib/i18n';
import {
  addHistoryEntry,
  copyText,
  downloadFile,
  loadHistory,
  toCsvFile,
  toJsonFile,
  toPlainText,
  type HistoryEntry,
} from './lib/history';
import { ScorePanel } from './components/ScorePanel';
import { FindingList } from './components/FindingList';
import { OverviewPanel } from './components/Overview';
import { LinkTable } from './components/LinkTable';
import { HistoryList } from './components/HistoryList';
import type { DiagnosticReport } from '../shared/core/types';

type Phase = 'idle' | 'running' | 'done' | 'error';

interface Failure {
  code: string;
  message: string;
}

const MAX_LINKS = 25;

function readInitialUrl(): string {
  const hash = window.location.hash;
  if (!hash.startsWith('#/r/')) return '';
  try {
    return decodeURIComponent(hash.slice(4));
  } catch {
    return '';
  }
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.locale);
    if (stored === 'zh' || stored === 'en') return stored;
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  });
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(() => {
    const stored = localStorage.getItem(STORAGE_KEYS.theme);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  });

  const [input, setInput] = useState<string>(readInitialUrl);
  const [linkLimit, setLinkLimit] = useState(10);
  const [sameOriginOnly, setSameOriginOnly] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const t = UI[locale];

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    localStorage.setItem(STORAGE_KEYS.locale, locale);
  }, [locale]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.theme, theme);
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal).then(setHealth);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  // A shared link opens the report it points at when it is already in history.
  useEffect(() => {
    const shared = readInitialUrl();
    if (!shared || report) return;
    const match = history.find((entry) => entry.url === shared || entry.finalUrl === shared);
    if (match) {
      setReport(match.report);
      setPhase('done');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    async (rawUrl: string) => {
      const target = rawUrl.trim();
      if (target === '') return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setPhase('running');
      setFailure(null);
      setReport(null);

      try {
        const result = await analyze(
          { url: target, linkCheckLimit: linkLimit, sameOriginLinksOnly: sameOriginOnly },
          controller.signal,
        );
        setReport(result);
        setPhase('done');
        setHistory((current) => addHistoryEntry(current, result));
        window.history.replaceState(null, '', `#/r/${encodeURIComponent(result.target.requestedUrl || target)}`);
        requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'cancelled') {
            setPhase('idle');
            return;
          }
          // A 422 carries a report describing the invalid input.
          if (err.report) {
            setReport(err.report);
            setPhase('done');
            return;
          }
          setFailure({ code: err.code, message: err.message });
        } else {
          setFailure({ code: 'unknown', message: (err as Error).message });
        }
        setPhase('error');
      }
    },
    [linkLimit, sameOriginOnly],
  );

  const cancel = () => {
    abortRef.current?.abort();
    setPhase('idle');
  };

  const reset = () => {
    setReport(null);
    setFailure(null);
    setPhase('idle');
    window.history.replaceState(null, '', window.location.pathname);
  };

  const onExport = (kind: 'json' | 'csv') => {
    if (!report) return;
    downloadFile(kind === 'json' ? toJsonFile(report) : toCsvFile(report, locale));
    setToast(kind === 'json' ? 'JSON ✓' : 'CSV ✓');
  };

  const onCopy = async () => {
    if (!report) return;
    const ok = await copyText(toPlainText(report, locale));
    setToast(ok ? t.copied : t.copyFailed);
  };

  const onShare = async () => {
    if (!report) return;
    const url = `${window.location.origin}/#/r/${encodeURIComponent(report.target.requestedUrl || report.input.raw)}`;
    const ok = await copyText(url);
    setToast(ok ? t.shareCopied : t.copyFailed);
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {locale === 'zh' ? '跳到主要内容' : 'Skip to main content'}
      </a>

      <header className="masthead">
        <div className="masthead__inner">
          <div className="brand">
            <LogoMark />
            <div className="brand__text">
              <span className="brand__name">{t.appName}</span>
              <span className="brand__tag">{t.tagline}</span>
            </div>
          </div>

          <nav className="masthead__nav" aria-label={locale === 'zh' ? '站点导航' : 'Site navigation'}>
            <a
              className="author-link"
              href="https://x.com/0xkillcoin"
              target="_blank"
              rel="noopener noreferrer"
              title={t.author}
            >
              <XIcon />
              <span>@0xkillcoin</span>
            </a>
            <button
              type="button"
              className="icon-button"
              onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
              aria-label={t.localeToggle}
              title={t.localeToggle}
            >
              {locale === 'zh' ? 'EN' : '中文'}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
              aria-label={t.themeToggle}
              title={`${t.themeToggle}: ${theme}`}
            >
              {theme === 'dark' ? <MoonIcon /> : theme === 'light' ? <SunIcon /> : <AutoIcon />}
            </button>
          </nav>
        </div>
      </header>

      <main id="main" className="main">
        <section className="hero" aria-labelledby="hero-title">
          <h1 id="hero-title" className="hero__title">
            {locale === 'zh' ? '给一个网址做一次急诊' : 'A quick triage for any URL'}
          </h1>
          <p className="hero__lede">{t.lede}</p>
        </section>

        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(input);
          }}
          aria-busy={phase === 'running'}
        >
          <div className="form__row">
            <label className="form__label" htmlFor="url-input">
              {t.urlLabel}
            </label>
            <div className="form__field">
              <input
                id="url-input"
                className="input"
                type="text"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                placeholder={t.urlPlaceholder}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={phase === 'running'}
                aria-describedby="url-hint"
              />
              {phase === 'running' ? (
                <button type="button" className="button button--ghost" onClick={cancel}>
                  {t.cancel}
                </button>
              ) : (
                <button type="submit" className="button button--primary" disabled={input.trim() === ''}>
                  {t.run}
                </button>
              )}
            </div>
            <p id="url-hint" className="form__hint">
              {locale === 'zh'
                ? '支持 example.com、https://example.com/path；协议会自动补全，内网地址会被拒绝。'
                : 'Accepts example.com or https://example.com/path; the scheme is filled in and private addresses are rejected.'}
            </p>
          </div>

          <div className="form__options">
            <div className="option">
              <label className="option__label" htmlFor="link-limit">
                {t.linkLimit}
              </label>
              <div className="option__control">
                <input
                  id="link-limit"
                  className="range"
                  type="range"
                  min={0}
                  max={MAX_LINKS}
                  step={1}
                  value={linkLimit}
                  onChange={(event) => setLinkLimit(Number(event.target.value))}
                  disabled={phase === 'running'}
                />
                <output className="option__value" htmlFor="link-limit">
                  {linkLimit}
                </output>
              </div>
              <p className="option__hint">{t.linkLimitHint}</p>
            </div>

            <div className="option">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={sameOriginOnly}
                  onChange={(event) => setSameOriginOnly(event.target.checked)}
                  disabled={phase === 'running'}
                />
                <span>{t.sameOrigin}</span>
              </label>
              <p className="option__hint">{t.sameOriginHint}</p>
            </div>
          </div>

          <div className="form__examples">
            <span className="form__examples-label">{t.example}:</span>
            {['example.com', 'https://github.com', 'https://expired.badssl.com'].map((sample) => (
              <button
                key={sample}
                type="button"
                className="chip"
                onClick={() => {
                  setInput(sample);
                  void run(sample);
                }}
                disabled={phase === 'running'}
              >
                {sample.replace(/^https:\/\//, '')}
              </button>
            ))}
          </div>
        </form>

        <div aria-live="polite" aria-atomic="true" className="live">
          {phase === 'running' && <RunningState label={t.running} />}
        </div>

        {phase === 'error' && failure && (
          <section className="card card--error" role="alert">
            <h2 className="card__title">{t.errorTitle}</h2>
            <p className="card__body">{failure.message}</p>
            <p className="mono muted">code: {failure.code}</p>
            <div className="card__actions">
              <button type="button" className="button button--primary" onClick={() => void run(input)}>
                {t.retry}
              </button>
              <button type="button" className="button button--ghost" onClick={reset}>
                {t.newCheck}
              </button>
            </div>
          </section>
        )}

        {phase === 'done' && report && (
          <div ref={resultRef} className="result" tabIndex={-1}>
            <div className="result__bar">
              <div className="result__meta">
                <h2 className="result__title">{report.page ? hostLabel(report.page.finalUrl) : report.input.raw}</h2>
                <p className="result__sub mono">
                  {t.generatedAt} {formatDateTime(report.createdAt, locale)} · {t.reportId} {report.id}
                </p>
              </div>
              <div className="result__actions">
                <button type="button" className="button button--ghost" onClick={onCopy}>
                  {t.copyReport}
                </button>
                <button type="button" className="button button--ghost" onClick={() => onExport('json')}>
                  {t.exportJson}
                </button>
                <button type="button" className="button button--ghost" onClick={() => onExport('csv')}>
                  {t.exportCsv}
                </button>
                <button type="button" className="button button--ghost" onClick={onShare}>
                  {t.shareLink}
                </button>
                <button type="button" className="button button--primary" onClick={reset}>
                  {t.newCheck}
                </button>
              </div>
            </div>

            {report.warnings.length > 0 && (
              <div className="notice" role="status">
                <strong>{t.partialWarnings}:</strong> {report.warnings.map((warning) => warning[locale]).join(' · ')}
              </div>
            )}

            <ScorePanel report={report} locale={locale} />
            <OverviewPanel report={report} locale={locale} health={health} />
            <FindingList report={report} locale={locale} />
            <LinkTable report={report} locale={locale} />
          </div>
        )}

        {(phase === 'idle' || phase === 'done' || phase === 'error') && (
          <HistoryList
            entries={history}
            locale={locale}
            onOpen={(entry) => {
              setReport(entry.report);
              setPhase('done');
              setInput(entry.url);
              requestAnimationFrame(() => resultRef.current?.scrollIntoView({ block: 'start' }));
            }}
            onClear={() => {
              setHistory([]);
              localStorage.removeItem(STORAGE_KEYS.history);
              localStorage.removeItem('linkmedic.history');
            }}
          />
        )}
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <p className="footer__usage">{t.usage}</p>
          <p className="footer__meta">
            <span>
              {t.engine}: {health ? (health.runtime === 'cloudflare-workers' ? t.engineEdge : t.engineNode) : '—'}
            </span>
            <span aria-hidden="true">·</span>
            <a href="https://x.com/0xkillcoin" target="_blank" rel="noopener noreferrer">
              <XIcon /> @0xkillcoin
            </a>
          </p>
        </div>
      </footer>

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}

function RunningState({ label }: { label: string }) {
  return (
    <div className="running">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
      <span className="running__steps">
        <span>DNS → TLS → headers → HTML → links</span>
      </span>
    </div>
  );
}

function LogoMark() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true" width="30" height="30">
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M9 16h5.5l2-4.5 3 9 2-4.5H23"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M20.7 14.6a8.7 8.7 0 0 1-11.3-11 9 9 0 1 0 11.3 11z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path
        d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-13.5v2M12 18.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M6.7 17.3l1.4-1.4M15.9 8.1l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AutoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
    </svg>
  );
}
