// GitHub Trending 页面抓取 — 解析 trending repo 列表

export interface TrendingRepo {
  owner: string;
  repo: string;
  url: string;
  description: string;
  language: string;
  starsToday: number;
  fetchedAt: number;
}

/** 抓取 GitHub Trending 页面，返回 repo 列表 */
export async function fetchTrendingRepos(language?: string): Promise<TrendingRepo[]> {
  const url = language
    ? `https://github.com/trending/${encodeURIComponent(language)}?since=daily`
    : 'https://github.com/trending?since=daily';

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'ButcherWiki/1.0',
      'Accept': 'text/html',
      ...(process.env.GITHUB_TOKEN ? { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub Trending fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  return parseTrendingHTML(html);
}

/** 从 HTML 中解析 trending repo 列表 */
function parseTrendingHTML(html: string): TrendingRepo[] {
  const repos: TrendingRepo[] = [];
  const now = Date.now();

  // 匹配每个 article.Box-row
  const articleRegex = /<article class="Box-row">([\s\S]*?)<\/article>/g;
  let match;

  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1];

    // 提取 owner/repo: <h2> 内的 <a href="/owner/repo">（href 可能不是第一个属性）
    const h2Match = block.match(/<h2[\s\S]*?<\/h2>/);
    if (!h2Match) continue;
    const hrefMatch = h2Match[0].match(/href="\/([^"]+)"/);
    if (!hrefMatch) continue;
    const fullName = hrefMatch[1].replace(/\s/g, '');
    const parts = fullName.split('/');
    if (parts.length !== 2) continue;

    // 提取描述
    const descMatch = block.match(/<p class="[^"]*col-9[^"]*">([\s\S]*?)<\/p>/);
    const description = descMatch ? descMatch[1].trim().replace(/\s+/g, ' ') : '';

    // 提取语言
    const langMatch = block.match(/itemprop="programmingLanguage">([\s\S]*?)<\/span>/);
    const language = langMatch ? langMatch[1].trim() : '';

    // 提取今日 star 数
    const starsMatch = block.match(/(\d[\d,]*)\s+stars?\s+today/i);
    const starsToday = starsMatch ? parseInt(starsMatch[1].replace(/,/g, ''), 10) : 0;

    repos.push({
      owner: parts[0],
      repo: parts[1],
      url: `https://github.com/${parts[0]}/${parts[1]}`,
      description,
      language,
      starsToday,
      fetchedAt: now,
    });
  }

  return repos;
}
