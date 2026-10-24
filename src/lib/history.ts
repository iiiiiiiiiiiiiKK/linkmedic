import type { DiagnosticReport } from '../../shared/core/types';

/** Local history entry — stored in localStorage only, never uploaded. */
export interface HistoryEntry {
  id: string;
  url: string;
  finalUrl: string;
  score: number;
  grade: string;
  issues: number;
  createdAt: string;
  /** kept so a row can be re-opened without re-running the diagnosis */
  report: DiagnosticReport;
}

const MAX_ENTRIES = 12;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem('linkmedic.history');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is HistoryEntry => {
        const entry = item as HistoryEntry;
        return !!entry && typeof entry.id === 'string' && typeof entry.url === 'string' && !!entry.report;
      })
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem('linkmedic.history', JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage full or disabled — history is a convenience, not a requirement */
  }
}

export function addHistoryEntry(entries: HistoryEntry[], report: DiagnosticReport): HistoryEntry[] {
  const entry: HistoryEntry = {
    id: report.id,
    url: report.target.requestedUrl || report.input.raw,
    finalUrl: report.page?.finalUrl ?? '',
    score: report.score.value,
    grade: report.score.grade,
    issues: report.findings.filter((f) => f.severity !== 'pass' && f.severity !== 'info').length,
    createdAt: report.createdAt,
    report,
  };
  const next = [entry, ...entries.filter((item) => item.id !== entry.id)].slice(0, MAX_ENTRIES);
  saveHistory(next);
  return next;
}

/* ------------------------------------------------------------------------- */
/* Export helpers                                                            */
/* ------------------------------------------------------------------------- */

export function toJsonFile(report: DiagnosticReport): { filename: string; content: string; mime: string } {
  return {
    filename: `linkmedic-${hostSlug(report)}-${stamp(report)}.json`,
    content: JSON.stringify(report, null, 2),
    mime: 'application/json',
  };
}

/**
 * CSV export: one row per finding, plus a leading metadata block. Values are
 * quoted per RFC 4180 and any embedded quotes are doubled.
 */
export function toCsvFile(
  report: DiagnosticReport,
  locale: 'zh' | 'en',
): { filename: string; content: string; mime: string } {
  const rows: string[][] = [];
  const pick = (value: { zh: string; en: string } | undefined) => (value ? value[locale] : '');

  rows.push(['report_id', report.id]);
  rows.push(['created_at', report.createdAt]);
  rows.push(['requested_url', report.target.requestedUrl || report.input.raw]);
  rows.push(['final_url', report.page?.finalUrl ?? '']);
  rows.push(['http_status', String(report.page?.status ?? '')]);
  rows.push(['score', String(report.score.value)]);
  rows.push(['grade', report.score.grade]);
  rows.push(['engine_runtime', report.engine.runtime]);
  rows.push(['ip_pinning', String(report.engine.ipPinning)]);
  rows.push([]);

  rows.push(['severity', 'status', 'check', 'title', 'detail', 'recommendation', 'evidence']);
  for (const finding of report.findings) {
    rows.push([
      finding.severity,
      finding.status,
      finding.check,
      pick(finding.title),
      pick(finding.detail),
      pick(finding.recommendation),
      finding.evidence ?? '',
    ]);
  }

  if (report.links.checked.length > 0) {
    rows.push([]);
    rows.push(['link_url', 'link_text', 'status', 'ok', 'final_url', 'duration_ms', 'error', 'skipped']);
    for (const link of report.links.checked) {
      rows.push([
        link.url,
        link.text,
        String(link.status ?? ''),
        String(link.ok),
        link.finalUrl ?? '',
        String(link.durationMs),
        link.error ?? '',
        link.skipped ?? '',
      ]);
    }
  }

  const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  return {
    filename: `linkmedic-${hostSlug(report)}-${stamp(report)}.csv`,
    content,
    mime: 'text/csv',
  };
}

function csvCell(value: string): string {
  const text = value ?? '';
  // Guard against spreadsheet formula injection in exported cells.
  const neutralized = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function hostSlug(report: DiagnosticReport): string {
  const host = report.target.host || 'report';
  return (
    host
      .replace(/[^a-z0-9.-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}

function stamp(report: DiagnosticReport): string {
  return report.createdAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** Plain-text report used by the "copy report" button. */
export function toPlainText(report: DiagnosticReport, locale: 'zh' | 'en'): string {
  const t =
    locale === 'zh'
      ? {
          header: 'LinkMedic 诊断报告',
          url: '地址',
          score: '健康度',
          grade: '等级',
          findings: '结论',
          rec: '建议',
          evidence: '证据',
          links: '链接',
          generated: '生成时间',
        }
      : {
          header: 'LinkMedic diagnosis',
          url: 'URL',
          score: 'Health',
          grade: 'Grade',
          findings: 'Findings',
          rec: 'Recommendation',
          evidence: 'Evidence',
          links: 'Links',
          generated: 'Generated',
        };

  const lines: string[] = [];
  lines.push(`${t.header} — ${t.generated} ${report.createdAt}`);
  lines.push(`${t.url}: ${report.target.requestedUrl || report.input.raw}`);
  if (report.page) lines.push(`Final: ${report.page.finalUrl} (HTTP ${report.page.status})`);
  lines.push(`${t.score}: ${report.score.value}/100 (${report.score.grade})`);
  lines.push('');
  for (const finding of report.findings) {
    const title = finding.title[locale];
    const detail = finding.detail[locale];
    const recommendation = finding.recommendation[locale];
    lines.push(`[${finding.severity.toUpperCase()}] ${title}`);
    if (detail) lines.push(`  ${detail}`);
    if (finding.evidence) lines.push(`  ${t.evidence}: ${finding.evidence.replace(/\n/g, ' | ')}`);
    if (recommendation) lines.push(`  ${t.rec}: ${recommendation}`);
    lines.push('');
  }
  if (report.links.checked.length > 0) {
    lines.push(`${t.links} (${report.links.checked.length}):`);
    for (const link of report.links.checked) {
      lines.push(`  ${link.ok ? 'OK ' : 'ERR'} ${link.status ?? '—'} ${link.url}`);
    }
  }
  return lines.join('\n');
}

export function downloadFile(file: { filename: string; content: string; mime: string }): void {
  const blob = new Blob([file.content], { type: `${file.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
