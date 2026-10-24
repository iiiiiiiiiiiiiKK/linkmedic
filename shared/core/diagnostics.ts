import { resolveAndValidate, BlockedTargetError } from './dns';
import { parseHtml } from './htmlparse';
import { finding, scoreFindings } from './scoring';
import type { Transport } from './transport';
import { sanitizeMessage, type HopResult } from './transport';
import { InputError, charsetFromContentType, isHtmlContentType, normalizeUrl, resolveLocation } from './url';
import type {
  Bilingual,
  CertificateInfo,
  DiagnosticReport,
  Finding,
  LinkCheck,
  NormalizedTarget,
  PageFetch,
  PageMetadata,
  Severity,
} from './types';

export interface DiagnosticsOptions {
  /** how many links to check (0 disables the check) */
  linkCheckLimit: number;
  /** only probe links on the same origin as the page */
  sameOriginLinksOnly: boolean;
  /** total wall-clock budget for the whole run */
  budgetMs: number;
  /** per-request timeout for the main page */
  pageTimeoutMs: number;
  /** per-request timeout for each link probe */
  linkTimeoutMs: number;
  /** max bytes read from the page */
  maxPageBytes: number;
  /** max concurrent link probes */
  linkConcurrency: number;
  locale?: 'zh' | 'en';
}

export const DEFAULT_OPTIONS: DiagnosticsOptions = {
  linkCheckLimit: 10,
  sameOriginLinksOnly: false,
  budgetMs: 25_000,
  pageTimeoutMs: 15_000,
  linkTimeoutMs: 8_000,
  maxPageBytes: 512 * 1024,
  linkConcurrency: 4,
};

export const MAX_LINK_CHECK_LIMIT = 25;

const USER_AGENT =
  'LinkMedicBot/1.0 (+https://github.com/iiiiiiiiiiiKK/linkmedic; URL diagnostics; on-demand, no crawling)';

const b = (zh: string, en: string): Bilingual => ({ zh, en });

interface HopStep {
  url: string;
  status: number;
  location: string | null;
  method: 'GET' | 'HEAD';
  durationMs: number;
  ip: string | null;
}

/**
 * Follow one URL through its redirect chain, validating every hop.
 *
 * Each hop re-runs the full SSRF gate (scheme, port, literal address, DNS
 * answers) before the request is issued — a redirect to `http://169.254.169.254/`
 * is refused exactly like a direct request would be.
 */
async function followRedirects(
  transport: Transport,
  startUrl: string,
  opts: { maxHops: number; timeoutMs: number; maxBytes: number; deadline: number },
): Promise<{ result: HopResult; hops: HopStep[]; blocked: string | null }> {
  const hops: HopStep[] = [];
  let current = startUrl;

  for (let hop = 0; hop <= opts.maxHops; hop++) {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 250) {
      return {
        result: timeoutResult(),
        hops,
        blocked: null,
      };
    }

    const target = new URL(current);
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    try {
      await resolveAndValidate(transport, hostname);
    } catch (err) {
      return {
        result: {
          status: 0,
          headers: {},
          body: '',
          bodyBytes: 0,
          truncated: false,
          durationMs: 0,
          ttfbMs: null,
          ip: null,
          certificate: null,
          error: {
            code: 'blocked_target',
            message: err instanceof BlockedTargetError ? err.message : 'That redirect target was blocked.',
          },
        },
        hops,
        blocked: err instanceof BlockedTargetError ? err.message : 'redirect-target-blocked',
      };
    }

    const result = await transport.request(current, {
      method: 'GET',
      timeoutMs: Math.min(opts.timeoutMs, remaining),
      maxBytes: opts.maxBytes,
      userAgent: USER_AGENT,
    });

    hops.push({
      url: current,
      status: result.status,
      location: result.headers.location ?? null,
      method: 'GET',
      durationMs: result.durationMs,
      ip: result.ip,
    });

    const isRedirect = result.status >= 300 && result.status < 400 && result.headers.location;
    if (!isRedirect) {
      return { result, hops, blocked: null };
    }

    let next: string;
    try {
      next = resolveLocation(current, result.headers.location as string);
    } catch {
      return { result, hops, blocked: null };
    }
    // Guard against redirect loops.
    if (hops.some((h) => h.url === next)) {
      return {
        result: {
          ...result,
          error: { code: 'redirect_loop', message: 'The site redirects to a URL it already visited (redirect loop).' },
        },
        hops,
        blocked: null,
      };
    }
    current = next;
  }

  return {
    result: {
      status: 0,
      headers: {},
      body: '',
      bodyBytes: 0,
      truncated: false,
      durationMs: 0,
      ttfbMs: null,
      ip: null,
      certificate: null,
      error: {
        code: 'too_many_redirects',
        message: `The URL redirects more than ${opts.maxHops} times.`,
      },
    },
    hops,
    blocked: null,
  };
}

function timeoutResult(): HopResult {
  return {
    status: 0,
    headers: {},
    body: '',
    bodyBytes: 0,
    truncated: false,
    durationMs: 0,
    ttfbMs: null,
    ip: null,
    certificate: null,
    error: { code: 'budget_exhausted', message: 'The overall time budget for this diagnosis was exhausted.' },
  };
}

/** Probe a single link. HEAD first (cheap), GET as a fallback for HEAD-hostile servers. */
async function checkLink(
  transport: Transport,
  link: { url: string; text: string },
  opts: { timeoutMs: number; deadline: number; maxBytes: number },
): Promise<LinkCheck> {
  const started = Date.now();
  const remaining = Math.max(500, Math.min(opts.timeoutMs, opts.deadline - Date.now()));

  let hostname: string;
  try {
    hostname = new URL(link.url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return {
      url: link.url,
      text: link.text,
      status: null,
      ok: false,
      finalUrl: null,
      redirected: false,
      durationMs: 0,
      error: 'Malformed URL',
      skipped: 'malformed',
    };
  }

  try {
    await resolveAndValidate(transport, hostname);
  } catch {
    return {
      url: link.url,
      text: link.text,
      status: null,
      ok: false,
      finalUrl: null,
      redirected: false,
      durationMs: Date.now() - started,
      error: null,
      skipped: 'blocked_target',
    };
  }

  let head = await transport.request(link.url, {
    method: 'HEAD',
    timeoutMs: remaining,
    maxBytes: 0,
    userAgent: USER_AGENT,
  });

  const needsGet =
    head.error !== null || head.status === 405 || head.status === 403 || head.status === 501 || head.status === 0;

  if (needsGet) {
    const getResult = await transport.request(link.url, {
      method: 'GET',
      timeoutMs: Math.max(500, Math.min(opts.timeoutMs, opts.deadline - Date.now())),
      maxBytes: 16 * 1024,
      userAgent: USER_AGENT,
    });
    if (getResult.status !== 0 || getResult.error === null) head = getResult;
  }

  const finalUrl = head.headers.location ?? null;
  return {
    url: link.url,
    text: link.text,
    status: head.status === 0 ? null : head.status,
    ok: head.error === null && head.status > 0 && head.status < 400,
    finalUrl: finalUrl ? safeResolve(link.url, finalUrl) : null,
    redirected: head.status >= 300 && head.status < 400 && !!finalUrl,
    durationMs: Date.now() - started,
    error: head.error ? head.error.message : null,
  };
}

function safeResolve(base: string, location: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

export interface DiagnosticsResult {
  report: DiagnosticReport;
  error?: { code: string; message: string };
}

/**
 * Run the full diagnosis. This never throws for network reasons: a failed page
 * load still produces a report whose findings explain what failed.
 */
export async function runDiagnostics(
  transport: Transport,
  rawInput: string,
  partialOptions: Partial<DiagnosticsOptions> = {},
): Promise<DiagnosticsResult> {
  const options: DiagnosticsOptions = { ...DEFAULT_OPTIONS, ...partialOptions };
  const startedAt = Date.now();
  const deadline = startedAt + options.budgetMs;

  let target: NormalizedTarget;
  try {
    target = normalizeUrl(rawInput);
  } catch (err) {
    if (err instanceof InputError) {
      return {
        report: emptyReport(transport, rawInput, options, err.code, err.message),
        error: { code: err.code, message: err.message },
      };
    }
    throw err;
  }

  const findings: Finding[] = [];
  const warnings: Bilingual[] = [];

  const limit = Math.max(0, Math.min(MAX_LINK_CHECK_LIMIT, Math.floor(options.linkCheckLimit)));

  let hops: HopStep[] = [];
  let hopResult: HopResult;
  let blocked: string | null = null;

  try {
    const followed = await followRedirects(transport, target.requestedUrl, {
      maxHops: 5,
      timeoutMs: options.pageTimeoutMs,
      maxBytes: options.maxPageBytes,
      deadline,
    });
    hops = followed.hops;
    hopResult = followed.result;
    blocked = followed.blocked;
  } catch (err) {
    hopResult = {
      status: 0,
      headers: {},
      body: '',
      bodyBytes: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      ttfbMs: null,
      ip: null,
      certificate: null,
      error: { code: 'internal_error', message: sanitizeMessage(err) },
    };
  }

  const finalUrl = hops.length > 0 ? hops[hops.length - 1].url : target.requestedUrl;
  const contentType = hopResult.headers['content-type'] ?? null;
  const html = isHtmlContentType(contentType);
  // A hop that carried a transport-level failure (timeout, blocked target,
  // redirect loop, too many redirects) never counts as a loaded page, even when
  // an intermediate response had a status code.
  const pageLoaded = hopResult.status > 0 && hopResult.error === null;

  let metadata: PageMetadata | null = null;
  let anchors: { href: string; text: string; resolved: string | null; external: boolean }[] = [];
  if (html && hopResult.body !== '') {
    try {
      const parsed = parseHtml(hopResult.body, finalUrl);
      metadata = parsed.metadata;
      anchors = parsed.links;
    } catch {
      warnings.push(
        b('HTML 解析失败，元数据检测已跳过。', 'The HTML could not be parsed, so metadata checks were skipped.'),
      );
    }
  }

  // ---------------- link checks ----------------
  const links: LinkCheck[] = [];
  let linksTruncated = false;
  let linksSkipped = 0;
  const linkCheckStarted = Date.now();

  if (limit > 0 && anchors.length > 0) {
    const origin = new URL(finalUrl).origin;
    const candidates = anchors
      .filter((a) => a.resolved !== null)
      .filter((a) => (options.sameOriginLinksOnly ? a.resolved!.startsWith(origin) : true));
    // De-duplicate by resolved URL, keeping the first anchor text.
    const unique: typeof candidates = [];
    const seenUrls = new Set<string>();
    for (const anchor of candidates) {
      if (seenUrls.has(anchor.resolved!)) continue;
      seenUrls.add(anchor.resolved!);
      unique.push(anchor);
    }
    const uniqueCandidates = unique;

    linksTruncated = uniqueCandidates.length > limit;
    const chosen = uniqueCandidates.slice(0, limit);

    const results: LinkCheck[] = new Array(chosen.length);
    await runWithConcurrency(chosen, options.linkConcurrency, async (link) => {
      const index = chosen.indexOf(link);
      if (Date.now() >= deadline - 500) {
        results[index] = {
          url: link.resolved!,
          text: link.text,
          status: null,
          ok: false,
          finalUrl: null,
          redirected: false,
          durationMs: 0,
          error: null,
          skipped: 'budget_exhausted',
        };
        return;
      }
      results[index] = await checkLink(
        transport,
        { url: link.resolved!, text: link.text },
        { timeoutMs: options.linkTimeoutMs, deadline, maxBytes: 16 * 1024 },
      );
    });

    for (const result of results) {
      if (!result) continue;
      if (result.skipped) linksSkipped++;
      else links.push(result);
    }
  }

  const linkCheckMs = Date.now() - linkCheckStarted;
  const broken = links.filter((l) => !l.ok);

  // ---------------- certificate ----------------
  const certificate: CertificateInfo = hopResult.certificate ?? {
    valid: null,
    source: 'unavailable',
    error: transport.certificateDetails
      ? 'The certificate could not be read for this response.'
      : 'Certificate details are not readable on the edge runtime; only the validity verdict is available.',
  };

  // ---------------- findings ----------------
  const status = hopResult.status;
  const isHttps = finalUrl.startsWith('https:');
  const redirectCount = Math.max(0, hops.length - 1);

  if (blocked) {
    findings.push(
      finding({
        id: 'blocked-target',
        check: 'security',
        severity: 'info',
        title: b('目标被安全策略拦截', 'Target blocked by the safety policy'),
        detail: b(blocked, blocked),
        recommendation: b(
          'LinkMedic 只检测公网可访问的网站。请检查该地址是否指向内网、回环或云元数据地址。',
          'LinkMedic only checks publicly reachable websites. Check whether the address points at an internal, loopback or cloud-metadata host.',
        ),
        evidence: finalUrl,
      }),
    );
  }

  if (!pageLoaded) {
    const errCode = hopResult.error?.code ?? 'network_error';
    const timeouts = errCode === 'timeout' || errCode === 'budget_exhausted';

    if (errCode === 'redirect_loop' || errCode === 'too_many_redirects') {
      findings.push(
        finding({
          id: errCode === 'redirect_loop' ? 'redirect-loop' : 'too-many-redirects',
          check: 'redirects',
          severity: 'critical',
          title:
            errCode === 'redirect_loop'
              ? b('检测到重定向死循环', 'The redirect chain loops')
              : b('重定向次数过多', 'Too many redirects'),
          detail: b(
            hopResult.error?.message ?? '跳转链没有抵达最终页面。',
            hopResult.error?.message ?? 'The redirect chain never reached a final page.',
          ),
          recommendation: b(
            '检查 301/302 规则是否互相指向，尤其是 HTTP → HTTPS 与 www → 非 www 同时配置时。浏览器会直接报 ERR_TOO_MANY_REDIRECTS。',
            'Check for 301/302 rules that point at each other, especially when HTTP→HTTPS and www→apex are both configured. Browsers show ERR_TOO_MANY_REDIRECTS here.',
          ),
          evidence: hops.map((hop) => `${hop.status} ${hop.url}`).join('\n'),
        }),
      );
    }

    if (errCode !== 'redirect_loop' && errCode !== 'too_many_redirects') {
      findings.push(
        finding({
          id: 'page-unreachable',
          check: 'availability',
          severity: 'critical',
          title: b('网站无法访问', 'The site could not be reached'),
          detail: b(hopResult.error?.message ?? '请求失败。', hopResult.error?.message ?? 'The request failed.'),
          recommendation: timeouts
            ? b(
                '目标在超时时间内没有响应。检查服务器负载、防火墙规则或 CDN 回源配置；如果站点较慢，可以稍后重试。',
                'The target did not answer before the timeout. Check server load, firewall rules or CDN origin settings, then retry.',
              )
            : b(
                '确认域名解析正确、服务器在线且 80/443 端口可达。若刚更换 DNS，请等待 TTL 生效。',
                'Confirm the domain resolves, the server is online and ports 80/443 are reachable. If DNS was just changed, wait for the TTL.',
              ),
          evidence: `${errCode}: ${hopResult.error?.message ?? ''}`.trim(),
        }),
      );
    }
  } else if (status >= 500) {
    // Cloudflare fronts inject their own 5xx codes; 526 specifically means "the
    // origin certificate could not be validated", which is a TLS finding, not an
    // application error. Route it to the certificate check so the advice matches.
    const edgeCertRejection = status === 526 && certificate.valid === false && certificate.source === 'edge-validation';
    findings.push(
      finding({
        id: edgeCertRejection ? 'certificate-invalid' : 'server-error',
        check: edgeCertRejection ? 'tls' : 'availability',
        severity: 'critical',
        title: edgeCertRejection
          ? b('HTTPS 证书无效（边缘返回 526）', 'Invalid HTTPS certificate (edge reported 526)')
          : b(`服务器返回 ${status}`, `Server returned ${status}`),
        detail: edgeCertRejection
          ? b(
              'CDN 边缘在回源时无法验证源站证书，因此返回 526。真实访客会看到安全警告页。',
              'The CDN edge could not validate the origin certificate and returned 526. Real visitors see a security warning page.',
            )
          : b(
              `首页响应为 ${status}，说明服务端处理失败。`,
              `The homepage answered with ${status}, which means the server failed to handle the request.`,
            ),
        recommendation: edgeCertRejection
          ? b(
              '续期或重新签发源站证书，确认域名与 SAN 匹配并补全中间证书链，然后重新部署 CDN。',
              'Renew or reissue the origin certificate, make sure the hostname matches the SAN list and ship the intermediate chain, then redeploy the CDN.',
            )
          : b(
              '查看服务端错误日志与应用监控；如果是上游依赖故障，配置重试与降级页面。',
              'Inspect the server error log and application monitoring; add retries or a fallback page if an upstream dependency is failing.',
            ),
        evidence: edgeCertRejection
          ? `${certificate.error ?? 'certificate rejected'} · HTTP ${status}`
          : `HTTP ${status}`,
      }),
    );
  } else if (status >= 400) {
    findings.push(
      finding({
        id: 'client-error',
        check: 'availability',
        severity: 'high',
        title: b(`首页返回 ${status}`, `Homepage returned ${status}`),
        detail: b(
          `服务器拒绝了该请求（${status}），页面无法正常展示。`,
          `The server rejected the request (${status}), so the page cannot be shown.`,
        ),
        recommendation:
          status === 403
            ? b(
                '403 常见于 WAF/反爬策略拦截。确认是否误伤了搜索引擎或普通访客，并检查 IP/UA 规则。',
                '403 often means a WAF or bot rule blocked the request. Check whether the rule also blocks real visitors and search engines.',
              )
            : status === 404
              ? b(
                  '404 说明路径不存在。检查该 URL 是否已迁移，必要时配置 301 重定向。',
                  '404 means the path does not exist. Check whether the URL moved and add a 301 redirect if it did.',
                )
              : b(
                  '检查路由配置与鉴权逻辑，确认普通访客可以直接访问该页面。',
                  'Check the routing and authentication logic so an anonymous visitor can load the page.',
                ),
        evidence: `HTTP ${status}`,
      }),
    );
  } else if (status >= 300) {
    findings.push(
      finding({
        id: 'redirect-unresolved',
        check: 'redirects',
        severity: 'medium',
        title: b('重定向未能完成', 'The redirect chain did not resolve'),
        detail: b(
          `最终响应仍是 ${status}，跳转链没有抵达 200 页面。`,
          `The final response is still ${status}, so the chain never reached a 200 page.`,
        ),
        recommendation: b(
          '检查跳转目标是否自身又返回 3xx，避免跳转环或缺失的最终页面。',
          'Check whether the redirect target itself answers with 3xx, which would create a loop or a missing final page.',
        ),
        evidence: `HTTP ${status} → ${hopResult.headers.location ?? '(no Location)'}`,
      }),
    );
  }

  if (pageLoaded && isHttps && certificate.valid === false) {
    findings.push(
      finding({
        id: 'certificate-invalid',
        check: 'tls',
        severity: 'critical',
        title: b('HTTPS 证书无效', 'The HTTPS certificate is invalid'),
        detail: b(
          certificate.error ?? 'TLS 握手时证书校验失败。',
          certificate.error ?? 'Certificate validation failed during the TLS handshake.',
        ),
        recommendation: b(
          '续期或重新签发证书，确保域名与证书 SAN 一致，并补全中间证书链。浏览器会直接拦截无效证书的页面。',
          'Renew or reissue the certificate, make sure the hostname matches the SAN list and ship the intermediate chain. Browsers block pages with invalid certificates.',
        ),
        evidence: [certificate.subject, certificate.issuer, certificate.validTo, certificate.error]
          .filter(Boolean)
          .join(' · '),
      }),
    );
  } else if (pageLoaded && isHttps && certificate.valid === true) {
    if (typeof certificate.daysRemaining === 'number' && certificate.daysRemaining <= 14) {
      findings.push(
        finding({
          id: 'certificate-expiring',
          check: 'tls',
          severity: certificate.daysRemaining <= 5 ? 'high' : 'medium',
          title: b(
            `证书将在 ${certificate.daysRemaining} 天后过期`,
            `Certificate expires in ${certificate.daysRemaining} days`,
          ),
          detail: b(
            `证书有效期至 ${certificate.validTo ?? '未知'}。`,
            `The certificate is valid until ${certificate.validTo ?? 'an unknown date'}.`,
          ),
          recommendation: b(
            '确认自动续期（ACM E/Let’s Encrypt/certbot）正常运行，避免到期后全站不可访问。',
            'Verify automatic renewal (ACM E, Let’s Encrypt, certbot) is running so the site does not go dark on expiry.',
          ),
          evidence: `validTo=${certificate.validTo ?? 'unknown'}`,
        }),
      );
    }
    findings.push(
      finding({
        id: 'certificate-valid',
        check: 'tls',
        severity: 'pass',
        title: b('HTTPS 证书有效', 'HTTPS certificate is valid'),
        detail:
          certificate.source === 'tls-inspection'
            ? b(
                'TLS 握手成功，证书链与域名校验通过。',
                'The TLS handshake succeeded and the chain plus hostname verified.',
              )
            : b(
                '传输层完成了证书校验，握手未被打断。',
                'The transport completed certificate validation and the handshake was not rejected.',
              ),
        recommendation: b('保持自动续期与证书监控。', 'Keep automatic renewal and certificate monitoring in place.'),
        evidence: [certificate.subject, certificate.issuer, certificate.validTo, certificate.protocol]
          .filter(Boolean)
          .join(' · '),
      }),
    );
  } else if (pageLoaded && isHttps && certificate.valid === null) {
    findings.push(
      finding({
        id: 'certificate-unknown',
        check: 'tls',
        severity: 'info',
        title: b('证书详情不可用', 'Certificate details unavailable'),
        detail: b(
          '当前运行环境只能确认 HTTPS 连接成功，无法读取证书主体与到期时间。',
          'This runtime can confirm the HTTPS connection but cannot read the certificate subject or expiry.',
        ),
        recommendation: b(
          '如需完整证书信息（签发者、到期日、SAN），请使用自带 Node 服务端部署。',
          'For full certificate details (issuer, expiry, SANs), deploy the bundled Node server.',
        ),
        evidence: certificate.error,
      }),
    );
  }

  if (pageLoaded && !isHttps) {
    findings.push(
      finding({
        id: 'no-https',
        check: 'tls',
        severity: 'critical',
        title: b('站点未使用 HTTPS', 'The site is not served over HTTPS'),
        detail: b(
          '首页通过明文 HTTP 传输，内容可被中间人读取或篡改。',
          'The homepage was delivered over plain HTTP, so intermediaries can read or modify it.',
        ),
        recommendation: b(
          '部署 TLS 证书并把 HTTP 全量 301 跳转到 HTTPS，同时开启 HSTS。',
          'Install a TLS certificate, 301-redirect all HTTP traffic to HTTPS and enable HSTS.',
        ),
        evidence: finalUrl,
      }),
    );
  }

  if (pageLoaded && isHttps && target.protocol === 'http') {
    findings.push(
      finding({
        id: 'http-input-upgraded',
        check: 'tls',
        severity: 'info',
        title: b('输入的 HTTP 地址已被升级到 HTTPS', 'The HTTP input was upgraded to HTTPS'),
        detail: b(
          '该地址会 301 跳转到 HTTPS，说明升级配置已生效。',
          'This address 301-redirects to HTTPS, so the upgrade is already configured.',
        ),
        recommendation: b(
          '可以的话直接把站内链接写成 https://。',
          'Where possible, write in-site links with https:// directly.',
        ),
        evidence: `${target.requestedUrl} → ${finalUrl}`,
      }),
    );
  }

  if (hops.length > 1) {
    const slow = hops.slice(0, -1).reduce((sum, hop) => sum + hop.durationMs, 0);
    findings.push(
      finding({
        id: 'redirect-chain',
        check: 'redirects',
        severity: redirectCount > 2 ? 'medium' : redirectCount > 1 ? 'low' : 'info',
        title: b(
          `发生 ${redirectCount} 次重定向`,
          `${redirectCount} redirect${redirectCount === 1 ? '' : 's'} before the final page`,
        ),
        detail: b(
          `跳转链共 ${hops.length} 跳，额外耗时约 ${slow}ms。`,
          `The chain has ${hops.length} hops and costs about ${slow}ms in extra round-trips.`,
        ),
        recommendation: b(
          '把常用的多级跳转合并为一次 301，直接指向最终地址，可减少移动端首屏延迟。',
          'Collapse multi-step redirects into a single 301 to the final URL to cut first-paint latency, especially on mobile.',
        ),
        evidence: hops.map((hop) => `${hop.status} ${hop.url}`).join('\n'),
      }),
    );
  }

  if (pageLoaded && hopResult.ttfbMs !== null) {
    const ttfb = hopResult.ttfbMs;
    const severity: Severity = ttfb > 2000 ? 'high' : ttfb > 1000 ? 'medium' : ttfb > 600 ? 'low' : 'pass';
    findings.push(
      finding({
        id: 'ttfb',
        check: 'performance',
        severity,
        title:
          severity === 'pass'
            ? b(`首字节时间 ${ttfb}ms，表现良好`, `Time to first byte is ${ttfb}ms, which is healthy`)
            : b(`首字节时间偏慢：${ttfb}ms`, `Slow time to first byte: ${ttfb}ms`),
        detail: b(
          `从发起请求到收到首页首个字节耗时 ${ttfb}ms（判定阈值：600 / 1000 / 2000ms）。`,
          `The homepage took ${ttfb}ms from request to first byte (thresholds: 600 / 1000 / 2000ms).`,
        ),
        recommendation:
          severity === 'pass'
            ? b('保持当前缓存与 CDN 配置。', 'Keep the current caching and CDN configuration.')
            : b(
                '检查回源链路、数据库慢查询与依赖服务；为 HTML 配置 CDN 边缘缓存或缩短动态渲染耗时。',
                'Inspect origin latency, slow database queries and upstream services; add edge caching for HTML or shorten dynamic rendering.',
              ),
        evidence: `ttfb=${ttfb}ms · total=${hopResult.durationMs}ms · bytes=${hopResult.bodyBytes}`,
      }),
    );
  }

  if (pageLoaded && hopResult.truncated) {
    findings.push(
      finding({
        id: 'body-truncated',
        check: 'performance',
        severity: 'info',
        title: b('页面体积超出读取上限', 'The page is larger than the read limit'),
        detail: b(
          `只读取了前 ${Math.round(hopResult.bodyBytes / 1024)}KB，链接与元数据检测基于这部分内容。`,
          `Only the first ${Math.round(hopResult.bodyBytes / 1024)}KB was read; link and metadata checks used that portion.`,
        ),
        recommendation: b(
          'HTML 超过 512KB 通常意味着内联了大量数据或样式，考虑服务端渲染精简与资源拆分。',
          'An HTML document above 512KB usually means inlined data or styles; consider slimming server rendering and splitting assets.',
        ),
        evidence: `read=${hopResult.bodyBytes}B truncated=true`,
      }),
    );
  }

  if (html && metadata) {
    const m = metadata;

    if (!m.title) {
      findings.push(
        finding({
          id: 'title-missing',
          check: 'metadata',
          severity: 'high',
          title: b('缺少 <title>', 'Missing <title>'),
          detail: b(
            '页面没有标题，搜索结果与浏览器标签页都无法识别该页面。',
            'The page has no title, so search results and browser tabs cannot identify it.',
          ),
          recommendation: b(
            '为每个页面添加唯一标题，建议 30–60 个字符，把核心关键词放在前面。',
            'Give every page a unique title, ideally 30–60 characters with the primary keyword first.',
          ),
          evidence: '<title> not found',
        }),
      );
    } else if (m.titleLength < 10 || m.titleLength > 60) {
      findings.push(
        finding({
          id: 'title-length',
          check: 'metadata',
          severity: 'low',
          title: b(`标题长度不理想（${m.titleLength} 字符）`, `Title length is off (${m.titleLength} characters)`),
          detail: b(
            m.titleLength < 10 ? '标题过短，信息量不足。' : '标题过长，搜索结果中会被截断。',
            m.titleLength < 10
              ? 'The title is too short to carry meaning.'
              : 'The title is long enough to be truncated in search results.',
          ),
          recommendation: b('把标题控制在 30–60 个字符之间。', 'Keep the title between 30 and 60 characters.'),
          evidence: m.title,
        }),
      );
    } else {
      findings.push(
        finding({
          id: 'title-ok',
          check: 'metadata',
          severity: 'pass',
          title: b('标题长度合适', 'Title length is in range'),
          detail: b(`${m.titleLength} 字符。`, `${m.titleLength} characters.`),
          recommendation: b('无需处理。', 'No action needed.'),
          evidence: m.title,
        }),
      );
    }

    if (!m.description) {
      findings.push(
        finding({
          id: 'description-missing',
          check: 'metadata',
          severity: 'medium',
          title: b('缺少 meta description', 'Missing meta description'),
          detail: b(
            '没有描述信息，搜索引擎只能自行截取正文作为摘要。',
            'Without a description, search engines invent a snippet from the body text.',
          ),
          recommendation: b(
            '添加 70–160 字符的描述，说明页面能提供什么。',
            'Add a 70–160 character description that states what the page offers.',
          ),
          evidence: 'meta[name=description] not found',
        }),
      );
    } else if (m.descriptionLength > 175 || m.descriptionLength < 50) {
      findings.push(
        finding({
          id: 'description-length',
          check: 'metadata',
          severity: 'low',
          title: b(
            `描述长度不理想（${m.descriptionLength} 字符）`,
            `Description length is off (${m.descriptionLength} characters)`,
          ),
          detail: b(
            m.descriptionLength > 175 ? '描述过长，搜索结果中会被截断。' : '描述过短，信息量不足。',
            m.descriptionLength > 175
              ? 'The description will be truncated in search results.'
              : 'The description is too short to be useful.',
          ),
          recommendation: b('控制在 70–160 个字符之间。', 'Keep it between 70 and 160 characters.'),
          evidence: m.description,
        }),
      );
    }
  }

  if (html && metadata) {
    const m = metadata;
    if (!m.canonical) {
      findings.push(
        finding({
          id: 'canonical-missing',
          check: 'seo',
          severity: 'low',
          title: b('缺少 canonical', 'Missing canonical link'),
          detail: b(
            '没有声明规范地址，带参数或多域名的版本可能被搜索引擎视为重复内容。',
            'No canonical URL is declared, so parameterised or multi-domain variants can be treated as duplicate content.',
          ),
          recommendation: b(
            '在 <head> 中加入指向自身规范地址的 <link rel="canonical">。',
            'Add a <link rel="canonical"> pointing at the page’s own canonical URL.',
          ),
          evidence: 'link[rel=canonical] not found',
        }),
      );
    } else if (m.canonicalIsCrossOrigin) {
      findings.push(
        finding({
          id: 'canonical-cross-origin',
          check: 'seo',
          severity: 'medium',
          title: b('canonical 指向其他域名', 'Canonical points at another origin'),
          detail: b(
            `规范地址为 ${m.canonical}，与当前页面不同源。`,
            `The canonical URL is ${m.canonical}, a different origin from the page.`,
          ),
          recommendation: b(
            '确认这是有意的合并策略；否则将该页的权重错误地转移给了另一个域名。',
            'Confirm this merge is intentional; otherwise the page is handing its ranking signals to a different domain.',
          ),
          evidence: m.canonical,
        }),
      );
    }

    if (m.robotsDirectives.includes('noindex')) {
      findings.push(
        finding({
          id: 'robots-noindex',
          check: 'seo',
          severity: 'medium',
          title: b('页面被标记为 noindex', 'The page is marked noindex'),
          detail: b(
            'meta robots 中包含 noindex，搜索引擎不会收录该页面。',
            'The meta robots tag contains noindex, so search engines will not index this page.',
          ),
          recommendation: b(
            '如果希望被收录，移除 noindex；如果是有意为之，请忽略。',
            'Remove noindex if the page should be indexed; ignore this if it is intentional.',
          ),
          evidence: m.robots ?? '',
        }),
      );
    }

    if (!m.lang) {
      findings.push(
        finding({
          id: 'lang-missing',
          check: 'accessibility',
          severity: 'low',
          title: b('<html> 缺少 lang 属性', 'The <html> element has no lang attribute'),
          detail: b(
            '没有声明页面语言，屏幕阅读器可能使用错误的发音规则。',
            'Without a declared language, screen readers may use the wrong pronunciation rules.',
          ),
          recommendation: b(
            '按内容设置，例如 <html lang="zh-CN">。',
            'Set it to match the content, for example <html lang="zh-CN">.',
          ),
          evidence: '<html> without lang',
        }),
      );
    }

    if (!m.viewport) {
      findings.push(
        finding({
          id: 'viewport-missing',
          check: 'mobile',
          severity: 'high',
          title: b('缺少 viewport 设置', 'Missing viewport meta tag'),
          detail: b(
            '移动端浏览器会以 980px 默认宽度渲染，页面通常会缩小到无法阅读。',
            'Mobile browsers fall back to a 980px viewport, so the page renders zoomed out and unreadable.',
          ),
          recommendation: b(
            '加入 <meta name="viewport" content="width=device-width, initial-scale=1"> 并确认布局确实自适应。',
            'Add <meta name="viewport" content="width=device-width, initial-scale=1"> and confirm the layout actually adapts.',
          ),
          evidence: 'meta[name=viewport] not found',
        }),
      );
    }

    if (m.h1.length === 0) {
      findings.push(
        finding({
          id: 'h1-missing',
          check: 'seo',
          severity: 'low',
          title: b('缺少 H1 标题', 'No H1 heading'),
          detail: b(
            '页面没有一级标题，内容层级不清晰。',
            'The page has no top-level heading, so the content hierarchy is unclear.',
          ),
          recommendation: b('为页面添加一个描述主题的 H1。', 'Add one H1 that describes the page topic.'),
          evidence: 'h1 count = 0',
        }),
      );
    } else if (m.h1.length > 1) {
      findings.push(
        finding({
          id: 'h1-multiple',
          check: 'seo',
          severity: 'low',
          title: b(`存在 ${m.h1.length} 个 H1`, `${m.h1.length} H1 headings found`),
          detail: b('多个一级标题会削弱页面主题。', 'Multiple H1s dilute the page topic.'),
          recommendation: b('保留一个主标题，其余降级为 H2。', 'Keep one main heading and demote the rest to H2.'),
          evidence: m.h1.slice(0, 3).join(' | '),
        }),
      );
    }

    if (m.imagesTotal > 0 && m.imagesMissingAlt > 0) {
      findings.push(
        finding({
          id: 'img-alt',
          check: 'accessibility',
          severity: m.imagesMissingAlt / m.imagesTotal > 0.3 ? 'medium' : 'low',
          title: b(`${m.imagesMissingAlt} 张图片缺少 alt`, `${m.imagesMissingAlt} image(s) missing alt text`),
          detail: b(
            `共 ${m.imagesTotal} 张图片，其中 ${m.imagesMissingAlt} 张没有 alt 属性。`,
            `${m.imagesMissingAlt} of ${m.imagesTotal} images have no alt attribute.`,
          ),
          recommendation: b(
            '为有信息量的图片写描述性 alt，纯装饰图片使用 alt=""。',
            'Write descriptive alt text for informative images and alt="" for purely decorative ones.',
          ),
          evidence: `images=${m.imagesTotal} missingAlt=${m.imagesMissingAlt}`,
        }),
      );
    }

    const ogKeys = Object.keys(m.openGraph);
    if (ogKeys.length === 0) {
      findings.push(
        finding({
          id: 'og-missing',
          check: 'social',
          severity: 'medium',
          title: b('缺少 Open Graph 元数据', 'Missing Open Graph metadata'),
          detail: b(
            '分享到社交平台时不会显示标题、描述和缩略图。',
            'Shared links on social platforms will have no title, description or thumbnail.',
          ),
          recommendation: b(
            '至少添加 og:title、og:description、og:image（建议 1200×630）与 og:url。',
            'At minimum add og:title, og:description, og:image (1200×630 recommended) and og:url.',
          ),
          evidence: 'og:* tags not found',
        }),
      );
    } else {
      const missing = ['og:title', 'og:description', 'og:image'].filter((key) => !(key in m.openGraph));
      if (missing.length > 0) {
        findings.push(
          finding({
            id: 'og-incomplete',
            check: 'social',
            severity: 'low',
            title: b(
              `Open Graph 不完整（缺少 ${missing.join('、')}）`,
              `Open Graph is incomplete (missing ${missing.join(', ')})`,
            ),
            detail: b('部分分享场景会退化成纯文本链接。', 'Some share targets will fall back to a plain text link.'),
            recommendation: b(
              '补齐 og:title、og:description、og:image。',
              'Add the missing og:title, og:description and og:image tags.',
            ),
            evidence: missing.join(', '),
          }),
        );
      } else {
        findings.push(
          finding({
            id: 'og-ok',
            check: 'social',
            severity: 'pass',
            title: b('Open Graph 元数据完整', 'Open Graph metadata is complete'),
            detail: b(`已声明 ${ogKeys.length} 个 og 字段。`, `${ogKeys.length} og fields are declared.`),
            recommendation: b('无需处理。', 'No action needed.'),
            evidence: Object.keys(m.openGraph).join(', '),
          }),
        );
      }
    }
  }

  // ---------------- response headers ----------------
  if (pageLoaded) {
    const h = hopResult.headers;
    if (isHttps && !h['strict-transport-security']) {
      findings.push(
        finding({
          id: 'hsts-missing',
          check: 'security-headers',
          severity: 'medium',
          title: b('缺少 HSTS 头', 'Missing Strict-Transport-Security header'),
          detail: b(
            '浏览器不会强制后续访问使用 HTTPS，首次明文请求仍可被劫持。',
            'Browsers are not told to force HTTPS on later visits, so the first plain-HTTP request can be hijacked.',
          ),
          recommendation: b(
            '添加 Strict-Transport-Security: max-age=31536000; includeSubDomains。',
            'Add Strict-Transport-Security: max-age=31536000; includeSubDomains.',
          ),
          evidence: 'strict-transport-security: (absent)',
        }),
      );
    }
    if (!h['content-security-policy']) {
      findings.push(
        finding({
          id: 'csp-missing',
          check: 'security-headers',
          severity: 'low',
          title: b('缺少 CSP', 'Missing Content-Security-Policy'),
          detail: b(
            '没有内容安全策略，XSS 一旦发生就没有第二道防线。',
            'Without a content security policy there is no second line of defence once XSS occurs.',
          ),
          recommendation: b(
            '从 Content-Security-Policy-Report-Only 开始，逐步收敛 script-src 与 object-src。',
            'Start with Content-Security-Policy-Report-Only and tighten script-src and object-src over time.',
          ),
          evidence: 'content-security-policy: (absent)',
        }),
      );
    }
    if (!h['x-content-type-options']) {
      findings.push(
        finding({
          id: 'xcto-missing',
          check: 'security-headers',
          severity: 'low',
          title: b('缺少 X-Content-Type-Options', 'Missing X-Content-Type-Options'),
          detail: b('浏览器可能对资源做 MIME 嗅探。', 'Browsers may MIME-sniff resources.'),
          recommendation: b('添加 X-Content-Type-Options: nosniff。', 'Add X-Content-Type-Options: nosniff.'),
          evidence: 'x-content-type-options: (absent)',
        }),
      );
    }
    if (!h['referrer-policy']) {
      findings.push(
        finding({
          id: 'referrer-policy-missing',
          check: 'security-headers',
          severity: 'low',
          title: b('缺少 Referrer-Policy', 'Missing Referrer-Policy'),
          detail: b(
            '完整 URL（可能含查询参数）会随外链请求泄露。',
            'Full URLs, including query parameters, leak to external sites.',
          ),
          recommendation: b(
            '添加 Referrer-Policy: strict-origin-when-cross-origin。',
            'Add Referrer-Policy: strict-origin-when-cross-origin.',
          ),
          evidence: 'referrer-policy: (absent)',
        }),
      );
    }

    const encoding = h['content-encoding'] ?? '';
    const declaredLength = Number(h['content-length'] ?? '0');
    if (!encoding && declaredLength > 50 * 1024) {
      findings.push(
        finding({
          id: 'no-compression',
          check: 'performance',
          severity: 'medium',
          title: b('响应未压缩', 'The response is not compressed'),
          detail: b(
            `HTML 响应 ${Math.round(declaredLength / 1024)}KB 且没有 Content-Encoding。`,
            `The HTML response is ${Math.round(declaredLength / 1024)}KB with no Content-Encoding.`,
          ),
          recommendation: b(
            '开启 gzip 或 brotli 压缩，通常可减少 60%–80% 传输体积。',
            'Enable gzip or brotli; it typically cuts transfer size by 60–80%.',
          ),
          evidence: `content-length=${declaredLength} content-encoding=(none)`,
        }),
      );
    }

    const cacheControl = h['cache-control'] ?? '';
    if (html && /no-store|no-cache|max-age=0/i.test(cacheControl) && encoding === '') {
      findings.push(
        finding({
          id: 'html-uncacheable',
          check: 'performance',
          severity: 'info',
          title: b('HTML 未被缓存', 'The HTML is not cacheable'),
          detail: b(
            `Cache-Control 为 "${cacheControl}"，每次访问都要回源。`,
            `Cache-Control is "${cacheControl}", so every visit hits the origin.`,
          ),
          recommendation: b(
            '如果内容允许，给 HTML 设置较短的 s-maxage 并配合 CDN 边缘缓存。',
            'If the content allows it, set a short s-maxage on HTML and let the CDN cache it at the edge.',
          ),
          evidence: `cache-control: ${cacheControl}`,
        }),
      );
    }

    if (contentType && charsetFromContentType(contentType) === null && isHtmlContentType(contentType)) {
      findings.push(
        finding({
          id: 'charset-missing',
          check: 'encoding',
          severity: 'low',
          title: b('Content-Type 未声明字符集', 'Content-Type does not declare a charset'),
          detail: b(
            `当前为 "${contentType}"，非 ASCII 文本可能乱码。`,
            `The value is "${contentType}", so non-ASCII text may be mis-decoded.`,
          ),
          recommendation: b(
            '返回 Content-Type: text/html; charset=utf-8。',
            'Return Content-Type: text/html; charset=utf-8.',
          ),
          evidence: `content-type: ${contentType}`,
        }),
      );
    }

    if (!html && pageLoaded && !/^(image|font|video|audio)\//.test(contentType ?? '')) {
      findings.push(
        finding({
          id: 'not-html',
          check: 'content',
          severity: 'info',
          title: b('该地址返回的不是 HTML', 'This URL does not return HTML'),
          detail: b(
            `Content-Type 为 ${contentType ?? '未声明'}，因此页面元数据与链接检测被跳过。`,
            `Content-Type is ${contentType ?? 'undeclared'}, so page metadata and link checks were skipped.`,
          ),
          recommendation: b(
            '如果这里应该是一个网页，请检查路由与响应头。',
            'If this should be a web page, check the routing and response headers.',
          ),
          evidence: `content-type: ${contentType ?? '(absent)'}`,
        }),
      );
    }
  }

  // ---------------- links ----------------
  if (limit > 0 && anchors.length > 0) {
    if (broken.length > 0) {
      findings.push(
        finding({
          id: 'broken-links',
          check: 'links',
          severity: broken.length >= 3 ? 'high' : 'medium',
          title: b(
            `发现 ${broken.length} 个失效链接`,
            `${broken.length} broken link${broken.length === 1 ? '' : 's'} found`,
          ),
          detail: b(
            `检查了 ${links.length} 个链接，其中 ${broken.length} 个返回错误状态或无法访问。`,
            `${broken.length} of ${links.length} checked links returned an error or could not be reached.`,
          ),
          recommendation: b(
            '修正或移除失效链接；对已迁移的页面配置 301，避免访客与爬虫走进死路。',
            'Fix or remove the broken links; add 301 redirects for pages that moved so visitors and crawlers do not hit dead ends.',
          ),
          evidence: broken
            .slice(0, 8)
            .map((link) => `${link.status ?? 'ERR'} ${link.url}${link.error ? ` (${link.error})` : ''}`)
            .join('\n'),
        }),
      );
    } else if (links.length > 0) {
      findings.push(
        finding({
          id: 'links-ok',
          check: 'links',
          severity: 'pass',
          title: b(`${links.length} 个链接全部可访问`, `All ${links.length} checked links respond`),
          detail: b('抽查范围内的站内/站外链接均返回成功状态。', 'Every sampled link returned a success status.'),
          recommendation: b('无需处理。', 'No action needed.'),
          evidence: links.map((link) => `${link.status} ${link.url}`).join('\n'),
        }),
      );
    }

    if (linksSkipped > 0) {
      findings.push(
        finding({
          id: 'links-skipped',
          check: 'links',
          severity: 'info',
          title: b(`${linksSkipped} 个链接被跳过`, `${linksSkipped} link(s) were skipped`),
          detail: b(
            '这些链接指向内网/非 HTTP 协议，或超出了本次检测的时间预算。',
            'Those links point at private hosts, use a non-HTTP scheme, or exceeded the time budget.',
          ),
          recommendation: b(
            '跳过属于安全策略的正常行为，无需处理。',
            'Skipping is expected safety behaviour; no action needed.',
          ),
          evidence: 'skipped=policy-or-budget',
        }),
      );
    }

    if (linksTruncated) {
      findings.push(
        finding({
          id: 'links-truncated',
          check: 'links',
          severity: 'info',
          title: b('链接检测已取样', 'Link checking sampled a subset'),
          detail: b(
            `页面共有 ${anchors.length} 个不同的 http(s) 链接，本次只检查了 ${limit} 个（可在界面调整上限，最大 ${MAX_LINK_CHECK_LIMIT}）。`,
            `The page has ${anchors.length} distinct http(s) links; only ${limit} were checked (the limit is adjustable up to ${MAX_LINK_CHECK_LIMIT}).`,
          ),
          recommendation: b(
            '提高上限可以覆盖更多链接，但会延长检测时间。',
            'A higher limit covers more links but takes longer.',
          ),
          evidence: `found=${anchors.length} checked=${limit}`,
        }),
      );
    }
  }

  // A site that answered 2xx/3xx with HTML but has zero findings would score 100.
  if (pageLoaded && status < 400 && findings.length === 0) {
    findings.push(
      finding({
        id: 'baseline-ok',
        check: 'summary',
        severity: 'pass',
        title: b('未发现明显问题', 'No obvious problems found'),
        detail: b(
          '可用性、TLS、元数据与响应头检查全部通过。',
          'Availability, TLS, metadata and header checks all passed.',
        ),
        recommendation: b('继续监控可用性与证书到期时间。', 'Keep monitoring availability and certificate expiry.'),
        evidence: `HTTP ${status} in ${hopResult.durationMs}ms`,
      }),
    );
  }

  const page: PageFetch | null = pageLoaded
    ? {
        requestedUrl: target.requestedUrl,
        finalUrl,
        status,
        headers: hopResult.headers,
        body: '',
        bodyBytes: hopResult.bodyBytes,
        truncated: hopResult.truncated,
        redirects: hops.map((hop) => ({
          url: hop.url,
          status: hop.status,
          location: hop.location,
          method: hop.method,
          durationMs: hop.durationMs,
          ip: hop.ip,
        })),
        timing: { ttfbMs: hopResult.ttfbMs, totalMs: hopResult.durationMs },
        certificate,
        ip: hopResult.ip,
        contentType,
        charset: charsetFromContentType(contentType),
      }
    : null;

  const report: DiagnosticReport = {
    schemaVersion: 1,
    id: makeId(),
    createdAt: new Date(startedAt).toISOString(),
    engine: {
      runtime: transport.runtime,
      transport: transport.kind,
      ipPinning: transport.ipPinning,
      certificateDetails: transport.certificateDetails,
    },
    input: {
      raw: rawInput,
      normalizedUrl: target.requestedUrl,
      linkCheckLimit: limit,
      sameOriginLinksOnly: options.sameOriginLinksOnly,
    },
    target,
    page,
    metadata: html ? metadata : null,
    links: {
      checked: links,
      totalFound: anchors.length,
      broken: broken.length,
      skipped: linksSkipped,
      truncated: linksTruncated,
    },
    findings,
    score: scoreFindings(findings),
    timings: {
      totalMs: Date.now() - startedAt,
      fetchMs: hopResult.durationMs,
      linkCheckMs,
    },
    warnings,
  };

  return { report };
}

function makeId(): string {
  const bytes = new Uint8Array(9);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A report shell used when the input never became a valid URL. */
export function emptyReport(
  transport: Transport,
  rawInput: string,
  options: DiagnosticsOptions,
  code: string,
  message: string,
): DiagnosticReport {
  const findingList: Finding[] = [
    finding({
      id: `input-${code}`,
      check: 'input',
      severity: 'high',
      title: b('URL 不合法', 'The URL is not valid'),
      detail: b(message, message),
      recommendation: b(
        '请输入形如 https://example.com/path 的完整地址；协议会自动补全为 https。',
        'Enter a full address such as https://example.com/path; the scheme is filled in as https when omitted.',
      ),
      evidence: rawInput.slice(0, 200),
    }),
  ];

  return {
    schemaVersion: 1,
    id: makeId(),
    createdAt: new Date().toISOString(),
    engine: {
      runtime: transport.runtime,
      transport: transport.kind,
      ipPinning: transport.ipPinning,
      certificateDetails: transport.certificateDetails,
    },
    input: {
      raw: rawInput,
      normalizedUrl: '',
      linkCheckLimit: options.linkCheckLimit,
      sameOriginLinksOnly: options.sameOriginLinksOnly,
    },
    target: {
      requestedUrl: '',
      host: '',
      hostname: '',
      port: 443,
      protocol: 'https',
      path: '/',
    },
    page: null,
    metadata: null,
    links: { checked: [], totalFound: 0, broken: 0, skipped: 0, truncated: false },
    findings: findingList,
    score: scoreFindings(findingList),
    timings: { totalMs: 0, fetchMs: null, linkCheckMs: null },
    warnings: [],
  };
}

// Small helper so `b()` reads nicely inside conditional arguments.
