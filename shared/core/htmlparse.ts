import type { LinkRef, PageMetadata } from './types';

/**
 * A tolerant HTML tag scanner.
 *
 * We deliberately avoid bundling a full DOM parser into the Worker: the
 * diagnostics only need attributes from a handful of tags, and every value is
 * treated as untrusted *text* (never re-interpreted as markup). Anything exotic
 * is reported as "not found" rather than guessed.
 */

interface Tag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  inner: string;
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  middot: '·',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = parseInt(body.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      if (body.startsWith('#')) {
        const code = parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    })
    .trim();
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (name === '') continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
    if (ATTR_RE.lastIndex === match.index) ATTR_RE.lastIndex += 1;
  }
  return attrs;
}

/**
 * Remove the contents of `<script>`, `<style>` and HTML comments before any other
 * analysis: a string inside a script is not a link, a heading or a meta tag.
 */
function stripNonMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '<style></style>')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Walk every tag (opening and closing) and record the ones we care about. */
function scanTags(html: string, wanted: Set<string>): Tag[] {
  const tags: Tag[] = [];
  const openStack: { name: string; tag: Tag; start: number }[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const rawAttrs = match[3] ?? '';

    if (closing) {
      const index = openStack.map((entry) => entry.name).lastIndexOf(name);
      if (index >= 0) {
        const open = openStack[index];
        open.tag.inner = html.slice(open.start, match.index);
        openStack.splice(index, 1);
      }
      continue;
    }

    const selfClosing = /\/\s*$/.test(rawAttrs);
    const attrs = parseAttrs(selfClosing ? rawAttrs.replace(/\/\s*$/, '') : rawAttrs);

    if (wanted.has(name)) {
      const tag: Tag = { name, attrs, selfClosing: selfClosing || VOID_TAGS.has(name), inner: '' };
      tags.push(tag);
      if (!tag.selfClosing) openStack.push({ name, tag, start: tagRe.lastIndex });
    }
  }

  // Unterminated containers keep whatever they captured.
  for (const open of openStack) open.tag.inner = html.slice(open.start);
  return tags;
}

export function stripTags(html: string): string {
  return decodeEntities(stripNonMarkup(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absolutize(href: string, base: string): string | null {
  const value = href.trim();
  if (
    value === '' ||
    value.startsWith('#') ||
    /^(javascript|mailto|tel|data|sms|whatsapp|viber|intent|blob|about):/i.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function metaMap(tags: Tag[], prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of tags) {
    if (tag.name !== 'meta') continue;
    const key = (tag.attrs.property ?? tag.attrs.name ?? '').toLowerCase();
    if (!key.startsWith(prefix)) continue;
    if (tag.attrs.content !== undefined && !(key in out)) out[key] = tag.attrs.content.trim();
  }
  return out;
}

export interface ParsedDocument {
  metadata: PageMetadata;
  links: LinkRef[];
  /** anchors whose target is not an http(s) URL and therefore cannot be checked */
  uncheckedLinks: number;
}

export function parseHtml(rawHtml: string, baseUrl: string): ParsedDocument {
  const html = stripNonMarkup(rawHtml);
  const tags = scanTags(html, new Set(['title', 'meta', 'link', 'a', 'h1', 'img', 'html', 'base']));

  const htmlTag = tags.find((tag) => tag.name === 'html');
  const baseTag = tags.find((tag) => tag.name === 'base' && tag.attrs.href);
  const effectiveBase = baseTag ? (absolutize(baseTag.attrs.href, baseUrl) ?? baseUrl) : baseUrl;

  const titleTag = tags.find((tag) => tag.name === 'title');
  const title = titleTag ? stripTags(titleTag.inner) : null;

  const metas = tags.filter((tag) => tag.name === 'meta');
  const findMeta = (...keys: string[]): string | null => {
    for (const tag of metas) {
      const name = (tag.attrs.name ?? tag.attrs.property ?? '').toLowerCase();
      if (keys.includes(name) && tag.attrs.content !== undefined) return tag.attrs.content.trim();
    }
    return null;
  };

  const description = findMeta('description');
  const robots = findMeta('robots', 'googlebot', 'bingbot');
  const viewport = findMeta('viewport');
  const charsetMeta =
    metas.find((tag) => tag.attrs.charset !== undefined)?.attrs.charset ??
    /charset=([\w-]+)/i.exec(
      metas.find((tag) => (tag.attrs['http-equiv'] ?? '').toLowerCase() === 'content-type')?.attrs.content ?? '',
    )?.[1] ??
    null;

  const linkTags = tags.filter((tag) => tag.name === 'link');
  const canonicalHref = linkTags.find((tag) => (tag.attrs.rel ?? '').toLowerCase() === 'canonical')?.attrs.href ?? null;
  const canonical = canonicalHref ? absolutize(canonicalHref, effectiveBase) : null;

  let canonicalIsCrossOrigin = false;
  if (canonical) {
    try {
      canonicalIsCrossOrigin = new URL(canonical).origin !== new URL(baseUrl).origin;
    } catch {
      canonicalIsCrossOrigin = false;
    }
  }

  const faviconHref = linkTags.find((tag) => /(^|\s)icon(\s|$)/i.test(tag.attrs.rel ?? ''))?.attrs.href ?? null;
  const favicon = faviconHref ? absolutize(faviconHref, effectiveBase) : null;

  const hreflang = linkTags
    .filter((tag) => (tag.attrs.rel ?? '').toLowerCase() === 'alternate' && tag.attrs.hreflang && tag.attrs.href)
    .map((tag) => ({ lang: tag.attrs.hreflang, href: absolutize(tag.attrs.href, effectiveBase) ?? tag.attrs.href }));

  const h1 = tags
    .filter((tag) => tag.name === 'h1')
    .map((tag) => stripTags(tag.inner))
    .filter((text) => text !== '');

  const images = tags.filter((tag) => tag.name === 'img');
  const imagesMissingAlt = images.filter(
    (tag) => tag.attrs.alt === undefined && tag.attrs['aria-hidden'] !== 'true' && tag.attrs.role !== 'presentation',
  ).length;

  const baseOrigin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return '';
    }
  })();

  const seen = new Set<string>();
  const anchors: LinkRef[] = [];
  let uncheckedLinks = 0;

  for (const tag of tags) {
    if (tag.name !== 'a') continue;
    const href = tag.attrs.href;
    if (href === undefined) continue;
    const trimmedHref = href.trim();
    if (trimmedHref === '' || trimmedHref === '#') continue;

    const resolved = absolutize(trimmedHref, effectiveBase);
    if (resolved === null) {
      // mailto:, tel:, javascript:, in-page fragments — real links, but not
      // something an HTTP checker can verify.
      uncheckedLinks += 1;
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    let external: boolean;
    try {
      external = new URL(resolved).origin !== baseOrigin;
    } catch {
      external = false;
    }
    anchors.push({ href: trimmedHref, text: stripTags(tag.inner).slice(0, 120), resolved, external });
  }

  const metadata: PageMetadata = {
    title,
    titleLength: title ? title.length : 0,
    description,
    descriptionLength: description ? description.length : 0,
    canonical,
    canonicalIsCrossOrigin,
    robots,
    robotsDirectives: robots
      ? robots
          .toLowerCase()
          .split(/\s*,\s*/)
          .filter(Boolean)
      : [],
    lang: htmlTag?.attrs.lang?.trim() || null,
    charset: charsetMeta ? charsetMeta.toLowerCase() : null,
    viewport,
    h1,
    imagesTotal: images.length,
    imagesMissingAlt,
    openGraph: metaMap(tags, 'og:'),
    twitter: metaMap(tags, 'twitter:'),
    favicon,
    hreflang,
    scripts: (rawHtml.match(/<script\b/gi) ?? []).length,
    stylesheets: linkTags.filter((tag) => (tag.attrs.rel ?? '').toLowerCase() === 'stylesheet').length,
    textLength: stripTags(rawHtml).length,
  };

  return { metadata, links: anchors, uncheckedLinks };
}
