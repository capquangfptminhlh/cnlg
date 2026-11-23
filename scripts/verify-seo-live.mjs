#!/usr/bin/env node
// Read-only production SEO smoke test. Usage:
// node scripts/verify-seo-live.mjs https://example.com https://example.com/blog/post https://example.com/images/post.svg
// Optional: EXPECTED_DEPLOY_SHA=<sha> and DEPLOY_SHA_HEADER=<header> for deployment provenance.
const [originArg, articleArg, imageArg] = process.argv.slice(2);
if (!originArg || !articleArg || !imageArg) {
  console.error('Usage: node scripts/verify-seo-live.mjs <site-origin> <article-url> <image-url>');
  process.exit(2);
}
const origin = new URL(originArg).origin;
const article = new URL(articleArg, origin);
const image = new URL(imageArg, origin);
if ([article, image].some(u => u.origin !== origin)) {
  console.error('HOLD: article and image must belong to the production origin');
  process.exit(2);
}
const results = [];
async function get(url, label) {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'WebsiteOS-SEO-Readback/1.0' } });
    const body = await response.text();
    results.push({ label, url: response.url, status: response.status, ok: response.status === 200 });
    return { response, body };
  } catch (error) {
    results.push({ label, url: String(url), ok: false, error: String(error) });
    return null;
  }
}
const page = await get(article, 'article');
const img = await get(image, 'image');
const sitemap = await get(new URL('/sitemap.xml', origin), 'sitemap');
const canonical = page?.body.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0] || page?.body.match(/<link\b[^>]*href=["'][^"']+["'][^>]*rel=["']canonical["'][^>]*>/i)?.[0];
const href = canonical?.match(/href=["']([^"']+)["']/i)?.[1];
const canonicalOk = !!href && new URL(href, origin).href === article.href;
const imageOk = !!img && /^image\//i.test(img.response.headers.get('content-type') || '') && img.response.status === 200;
const sitemapOk = !!sitemap && sitemap.response.status === 200 && sitemap.body.includes(article.pathname);
const thumbnailOk = !!page && (page.body.includes(image.href) || page.body.includes(image.pathname));
const expectedSha = process.env.EXPECTED_DEPLOY_SHA;
const shaHeader = process.env.DEPLOY_SHA_HEADER;
const actualSha = page?.response.headers.get(shaHeader || 'x-deploy-sha');
const shaOk = !!expectedSha && !!actualSha && actualSha === expectedSha;
const checks = { article200: page?.response.status === 200, image200: imageOk, imageReferenced: thumbnailOk, canonicalSelf: canonicalOk, sitemapContainsArticle: sitemapOk, deployShaVerified: shaOk };
console.log(JSON.stringify({ origin, article: article.href, image: image.href, checks, results, expectedSha: expectedSha || 'UNKNOWN', actualSha: actualSha || 'UNKNOWN' }, null, 2));
if (!Object.values(checks).every(Boolean)) {
  console.error('HOLD: production readback incomplete; never count this article as published');
  process.exit(1);
}
console.log('PASS: verified production readback');
