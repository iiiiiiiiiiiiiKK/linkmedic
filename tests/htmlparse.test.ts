import { describe, expect, it } from 'vitest';
import { parseHtml, stripTags, decodeEntities } from '../shared/core/htmlparse';

const BASE = 'https://example.com/blog/post';

describe('parseHtml — metadata', () => {
  it('extracts the standard head metadata', () => {
    const html = `<!doctype html><html lang="zh-CN"><head>
      <title>  Hello &amp; Welcome  </title>
      <meta name="description" content="A page about links and how they break.">
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="robots" content="index, follow">
      <link rel="canonical" href="/blog/post">
      <meta property="og:title" content="Hello">
      <meta property="og:image" content="https://example.com/og.png">
      <meta name="twitter:card" content="summary_large_image">
    </head><body><h1>Main heading</h1><img src="a.png" alt="x"><img src="b.png"></body></html>`;

    const { metadata } = parseHtml(html, BASE);
    expect(metadata.title).toBe('Hello & Welcome');
    expect(metadata.titleLength).toBe(15);
    expect(metadata.description).toBe('A page about links and how they break.');
    expect(metadata.charset).toBe('utf-8');
    expect(metadata.viewport).toBe('width=device-width, initial-scale=1');
    expect(metadata.robots).toBe('index, follow');
    expect(metadata.robotsDirectives).toEqual(['index', 'follow']);
    expect(metadata.canonical).toBe('https://example.com/blog/post');
    expect(metadata.canonicalIsCrossOrigin).toBe(false);
    expect(metadata.lang).toBe('zh-CN');
    expect(metadata.h1).toEqual(['Main heading']);
    expect(metadata.imagesTotal).toBe(2);
    expect(metadata.imagesMissingAlt).toBe(1);
    expect(metadata.openGraph['og:title']).toBe('Hello');
    expect(metadata.openGraph['og:image']).toBe('https://example.com/og.png');
    expect(metadata.twitter['twitter:card']).toBe('summary_large_image');
  });

  it('detects cross-origin canonicals', () => {
    const html = '<html><head><link rel="canonical" href="https://mirror.example.org/post"></head></html>';
    const { metadata } = parseHtml(html, BASE);
    expect(metadata.canonical).toBe('https://mirror.example.org/post');
    expect(metadata.canonicalIsCrossOrigin).toBe(true);
  });

  it('reports missing metadata as null rather than guessing', () => {
    const { metadata } = parseHtml('<html><body><p>hi</p></body></html>', BASE);
    expect(metadata.title).toBeNull();
    expect(metadata.description).toBeNull();
    expect(metadata.canonical).toBeNull();
    expect(metadata.lang).toBeNull();
    expect(metadata.viewport).toBeNull();
    expect(metadata.h1).toEqual([]);
    expect(metadata.openGraph).toEqual({});
  });

  it('honours a <base href> when resolving canonicals and links', () => {
    const html = `<html><head><base href="https://cdn.example.net/site/">
      <link rel="canonical" href="page.html"></head>
      <body><a href="other.html">x</a></body></html>`;
    const { metadata, links } = parseHtml(html, BASE);
    expect(metadata.canonical).toBe('https://cdn.example.net/site/page.html');
    expect(links[0].resolved).toBe('https://cdn.example.net/site/other.html');
  });

  it('reads hreflang alternates', () => {
    const html = `<html><head>
      <link rel="alternate" hreflang="en" href="https://example.com/en/post">
      <link rel="alternate" hreflang="zh" href="https://example.com/zh/post">
    </head></html>`;
    const { metadata } = parseHtml(html, BASE);
    expect(metadata.hreflang).toHaveLength(2);
    expect(metadata.hreflang[0]).toEqual({ lang: 'en', href: 'https://example.com/en/post' });
  });

  it('prefers a declared favicon', () => {
    const html = '<html><head><link rel="icon" href="/fav.ico"></head></html>';
    expect(parseHtml(html, BASE).metadata.favicon).toBe('https://example.com/fav.ico');
  });
});

describe('parseHtml — links', () => {
  it('resolves, deduplicates and classifies links', () => {
    const html = `<html><body>
      <a href="/a">A</a>
      <a href="/a">A duplicate</a>
      <a href="https://other.com/x">External</a>
      <a href="#anchor">Anchor</a>
      <a href="mailto:x@example.com">Mail</a>
      <a href="javascript:void(0)">JS</a>
      <a href="">Empty</a>
      <a href="tel:+123">Phone</a>
      <a>No href</a>
      <a href="relative/page">Relative</a>
    </body></html>`;

    const { links } = parseHtml(html, BASE);
    const resolved = links.map((link) => link.resolved);

    expect(resolved).toContain('https://example.com/a');
    expect(resolved).toContain('https://other.com/x');
    expect(resolved).toContain('https://example.com/blog/relative/page');
    // in-page fragment, mailto, javascript, tel, empty and no-href anchors are dropped
    expect(resolved).not.toContain(null);
    expect(links.filter((link) => link.resolved === 'https://example.com/a')).toHaveLength(1);

    const external = links.find((link) => link.resolved === 'https://other.com/x');
    expect(external?.external).toBe(true);
    const internal = links.find((link) => link.resolved === 'https://example.com/a');
    expect(internal?.external).toBe(false);
  });

  it('strips tags out of anchor text', () => {
    const html = '<html><body><a href="/x"><span>Inner</span> <b>Text</b></a></body></html>';
    const { links } = parseHtml(html, BASE);
    expect(links[0].text).toBe('Inner Text');
  });

  it('keeps links inside script/style out of the anchor list', () => {
    const html = `<html><body>
      <script>var s = '<a href="https://evil.example/x">fake</a>';</script>
      <a href="https://real.example/">real</a>
    </body></html>`;
    const { links } = parseHtml(html, BASE);
    const hrefs = links.map((link) => link.resolved);
    expect(hrefs).toContain('https://real.example/');
    expect(hrefs).not.toContain('https://evil.example/x');
  });
});

describe('parseHtml — robustness', () => {
  it('does not throw on unbalanced markup', () => {
    const html = '<html><head><title>Unclosed<title><body><a href="/x">y';
    expect(() => parseHtml(html, BASE)).not.toThrow();
  });

  it('leaves unterminated titles empty-safe', () => {
    const { metadata } = parseHtml('<html><head><title>', BASE);
    // An unterminated <title> captures the remaining (empty) content.
    expect(metadata.title).toBe('');
    expect(metadata.titleLength).toBe(0);
  });

  it('handles attribute values containing angle brackets and quotes', () => {
    const html = `<meta name="description" content="a &lt;b&gt; c &#65; &quot;d&quot;">`;
    const { metadata } = parseHtml(html, BASE);
    expect(metadata.description).toBe('a <b> c A "d"');
  });

  it('treats script content as non-markup', () => {
    const html = '<html><head><script>if (1 < 2 && 3 > 2) { }</script><title>T</title></head></html>';
    const { metadata } = parseHtml(html, BASE);
    expect(metadata.title).toBe('T');
  });
});

describe('text helpers', () => {
  it('strips tags and collapses whitespace', () => {
    expect(stripTags('<p>a  <b>b</b>\n c</p>')).toBe('a b c');
    expect(stripTags('<script>x</script>visible')).toBe('visible');
  });

  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a&amp;b')).toBe('a&b');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>');
  });
});
