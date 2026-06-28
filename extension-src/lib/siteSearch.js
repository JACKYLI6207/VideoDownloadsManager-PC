self.VDM = self.VDM || {};
{
const VDM = self.VDM;

VDM.SEARCH_FIELD_NAMES = [
  "keyword",
  "keywords",
  "q",
  "query",
  "search",
  "wd",
  "k",
  "search_query",
  "text",
  "s",
];

VDM.parseTxtList = (text) => {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.replace(/^\s*\d+[\.\)、]\s*/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
};

VDM.detectPageSearch = () => {
  const origin = location.origin;
  const fieldNames = VDM.SEARCH_FIELD_NAMES;

  try {
    const current = new URL(location.href);
    for (const key of fieldNames) {
      const val = current.searchParams.get(key);
      if (!val || val.length < 2) continue;
      const encoded = encodeURIComponent(val);
      let template = location.href;
      if (template.includes(encoded)) {
        template = template.split(encoded).join("{query}");
      } else {
        template = template.split(val).join("{query}");
      }
      return { mode: "url", template, field: key, origin, source: "current-url" };
    }
  } catch {
    /* ignore */
  }

  const localePrefix = () => {
    const pathMatch = location.pathname.match(/^(\/(?:cn|en|ja|ko|tw|zh))(?:\/|$)/i);
    if (pathMatch) return pathMatch[1];
    const searchPathMatch = location.pathname.match(/^(.*?)\/search(?:\/|$)/i);
    if (searchPathMatch) return searchPathMatch[1] || "";
    return "";
  };

  const alpineInput = document.querySelector('[x-ref="homeSearch"]');
  if (alpineInput) {
    const prefix = localePrefix();
    return {
      mode: "url",
      template: `${origin}${prefix}/search/{query}`,
      field: "path",
      origin,
      source: "alpine-homeSearch",
    };
  }

  for (const form of document.querySelectorAll("form")) {
    const html = form.outerHTML;
    if (
      !/@submit\.prevent\s*=\s*["']search\s*\(/i.test(html) &&
      !/x-on:submit\.prevent\s*=\s*["']search\s*\(/i.test(html)
    ) {
      continue;
    }
    const prefix = localePrefix();
    return {
      mode: "url",
      template: `${origin}${prefix}/search/{query}`,
      field: "path",
      origin,
      source: "alpine-form",
    };
  }

  const inputSelectors = [
    'input[type="search"]',
    'input[name*="keyword" i]',
    'input[name*="search" i]',
    'input[id*="search" i]',
    'input[placeholder*="搜" i]',
    'input[placeholder*="search" i]',
    'input[type="text"]',
  ];

  let searchInput = null;
  for (const sel of inputSelectors) {
    for (const inp of document.querySelectorAll(sel)) {
      if (inp.type === "hidden" || inp.disabled) continue;
      const hint = `${inp.name || ""} ${inp.id || ""} ${inp.placeholder || ""} ${inp.className || ""}`.toLowerCase();
      if (fieldNames.some((n) => hint.includes(n)) || /search|搜|検索/.test(hint)) {
        searchInput = inp;
        break;
      }
    }
    if (searchInput) break;
  }

  if (!searchInput) {
    for (const form of document.querySelectorAll("form")) {
      const hint = `${form.action || ""} ${form.id || ""} ${form.className || ""}`.toLowerCase();
      if (!/search|搜|検索/.test(hint)) continue;
      const inp = form.querySelector('input[type="search"], input[type="text"], input:not([type])');
      if (inp && inp.type !== "hidden") {
        searchInput = inp;
        break;
      }
    }
  }

  if (searchInput) {
    const form = searchInput.closest("form");
    const fieldName =
      searchInput.name ||
      searchInput.id ||
      (fieldNames.find((n) => (searchInput.name || searchInput.id || "").toLowerCase().includes(n)) ?? "keyword");

    if (form?.action) {
      try {
        const action = new URL(form.action, location.href);
        const method = (form.method || "get").toLowerCase();
        if (method === "get") {
          const params = new URLSearchParams(action.search);
          for (const el of form.querySelectorAll("input, select, textarea")) {
            if (!el.name || el === searchInput) continue;
            if (el.type === "submit" || el.type === "button" || el.type === "hidden") continue;
            if (el.value) params.set(el.name, el.value);
          }
          params.set(fieldName, "{query}");
          const qs = params.toString();
          const template = `${action.origin}${action.pathname}${qs ? `?${qs}` : ""}`;
          return { mode: "url", template, field: fieldName, origin: action.origin, source: "form" };
        }
      } catch {
        /* ignore */
      }
    }

    const guesses = [
      `${origin}${localePrefix()}/search/{query}`,
      `${origin}/search/{query}`,
      `${origin}/search?${fieldName}={query}`,
      `${origin}/search?keyword={query}`,
      `${origin}/search?q={query}`,
      `${origin}/?s={query}`,
      `${origin}/videos/search?${fieldName}={query}`,
    ];
    return { mode: "url", template: guesses[0], field: fieldName, origin, source: "input-guess", fallback: true };
  }

  const prefix = localePrefix();
  return {
    mode: "url",
    template: `${origin}${prefix}/search/{query}`,
    field: "path",
    origin,
    source: "default-guess",
    fallback: true,
  };
};

VDM.buildSearchUrl = (config, query) => {
  const q = encodeURIComponent(String(query || "").trim());
  if (!config?.template || !q) return "";
  return String(config.template).replace(/\{query\}/gi, q);
};

VDM.isLikelySearchResultsUrl = (url) => {
  try {
    const u = new URL(url);
    const pathAndSearch = u.pathname + u.search;
    if (/\/search(?:\/|$|\?)/i.test(pathAndSearch)) return true;
    for (const key of VDM.SEARCH_FIELD_NAMES) {
      const v = u.searchParams.get(key);
      if (v && String(v).trim().length >= 2) return true;
    }
    // 分頁參數（如 ?page=5）常出現在搜索／列表結果頁
    if (u.searchParams.has("page") || u.searchParams.has("p")) {
      if (/\/search|\/tags?\/|\/categories?\/|\/actress|\/actor|\/genre|\/videos?\/|\/cn\/|\/en\/|\/ja\//i.test(u.pathname)) {
        return true;
      }
    }
    // 路徑分頁：/search/keyword/5
    if (/\/search\/[^/]+\/\d+\/?$/i.test(u.pathname)) return true;
  } catch {
    /* ignore */
  }
  return false;
};

VDM.isUncertainSearchConfig = (config) => {
  if (!config?.template) return true;
  if (config.fallback) return true;
  const s = config.source || "";
  if (s === "current-url" || s === "manual-url" || s === "manual-path" || s === "form") return false;
  if (/guess|default|alpine/i.test(s)) return true;
  return false;
};

VDM.parseSearchUrlTemplate = (pageUrl) => {
  try {
    const u = new URL(pageUrl);
    const origin = u.origin;

    for (const key of VDM.SEARCH_FIELD_NAMES) {
      const val = u.searchParams.get(key);
      if (!val || String(val).trim().length < 2) continue;
      const encoded = encodeURIComponent(val);
      let template = pageUrl;
      if (template.includes(encoded)) template = template.split(encoded).join("{query}");
      else if (template.includes(val)) template = template.split(val).join("{query}");
      else continue;
      return { mode: "url", template, field: key, origin, source: "manual-url" };
    }

    const pathMatch = u.pathname.match(/^(.*\/search)\/([^/]+)\/?$/i);
    if (pathMatch) {
      return {
        mode: "url",
        template: `${origin}${pathMatch[1]}/{query}`,
        field: "path",
        origin,
        source: "manual-path",
      };
    }
  } catch {
    /* ignore */
  }
  return null;
};

VDM.searchConfigCacheKey = (origin) => `vdmSearchConfig_${origin}`;

VDM._resultLinkContext = () => {
  const bad =
    /\/search(?:\/|\?|$)|\/login|\/register|\/signup|\/tags?(?:\/|\?|$)|\/categories?(?:\/|\?|$)|\/actress|\/actor|\/genre|\/ranking|\/contact|\/about|\/help|#$|javascript:/i;
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return "";
    }
  };
  const sameOrigin = (u) => {
    try {
      return new URL(u).origin === location.origin;
    } catch {
      return false;
    }
  };
  const skipContainer = (el) =>
    !!el?.closest?.("header, nav, footer, .header, .nav, .footer, .menu, .navbar, .sidebar");
  const selectors = [
    ".grid a[href]",
    "article a[href]",
    ".video-item a[href]",
    ".item a[href]",
    ".grid-item a[href]",
    ".search-item a[href]",
    "a.title[href]",
    "a.video-link[href]",
    ".box a[href]",
    "div.item a[href]",
    'a[href*="/video/"]',
    'a[href*="/v/"]',
    'a[href*="/detail/"]',
    'a[href*="/movie/"]',
    'a[href*="/?v="]',
    'a[href*="/video?id="]',
  ];
  const main = document.querySelector("main, #main, .main, #content, .content, .search-result, .results");
  const scope = main || document.body;
  const normalizeHref = (a) => {
    if (skipContainer(a)) return "";
    const href = abs(a.getAttribute("href") || a.href);
    if (!href || !sameOrigin(href)) return "";
    if (bad.test(href)) return "";
    return href;
  };
  return { bad, abs, sameOrigin, skipContainer, selectors, scope, normalizeHref };
};

VDM.collectResultUrls = () => {
  const { selectors, scope, normalizeHref } = VDM._resultLinkContext();
  for (const sel of selectors) {
    const hrefs = [];
    const seen = new Set();
    for (const a of document.querySelectorAll(sel)) {
      const href = normalizeHref(a);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      hrefs.push(href);
    }
    if (hrefs.length) return hrefs;
  }

  const hrefs = [];
  const seen = new Set();
  for (const a of scope.querySelectorAll("a[href]")) {
    const href = normalizeHref(a);
    if (!href || seen.has(href)) continue;
    const text = (a.textContent || "").trim();
    let score = 1;
    if (text.length >= 3) score += 2;
    if (/\/video|\/v\/|\/detail|\/movie/i.test(href)) score += 5;
    if (score < 6) continue;
    seen.add(href);
    hrefs.push(href);
  }
  return hrefs;
};

VDM.pickFirstResultUrl = () => VDM.collectResultUrls()[0] || "";

VDM.collectResultNames = () => {
  const { skipContainer, selectors, normalizeHref } = VDM._resultLinkContext();
  const codePattern = /\b([A-Z]{2,6}-\d{3,6})\b/i;

  const extractNameFromRoot = (root) => {
    if (!root) return "";
    for (const sel of [".video-title strong", ".title strong", "[class*='title'] strong"]) {
      const el = root.querySelector(sel);
      if (el) {
        const text = (el.textContent || "").trim();
        if (text) return text.toUpperCase();
      }
    }
    for (const sel of [".video-title", ".title", "[class*='video-title']"]) {
      const el = root.querySelector(sel);
      if (el) {
        const text = (el.textContent || "").trim();
        const m = text.match(codePattern);
        if (m) return m[1].toUpperCase();
        const first = text.split(/\s+/)[0];
        if (first) return first.toUpperCase();
      }
    }
    return "";
  };

  const itemSelectors = [
    "div.item",
    ".item",
    ".video-item",
    ".search-item",
    ".grid-item",
    "article",
  ];

  for (const sel of itemSelectors) {
    const names = [];
    const seen = new Set();
    for (const item of document.querySelectorAll(sel)) {
      if (skipContainer(item)) continue;
      const name = extractNameFromRoot(item);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    if (names.length) return names;
  }

  // 與 collectResultUrls 相同連結選擇器，從 a.box / div.item 結構回退提取
  for (const sel of selectors) {
    const names = [];
    const seen = new Set();
    for (const a of document.querySelectorAll(sel)) {
      const href = normalizeHref(a);
      if (!href) continue;
      const root = a.closest(".item, .video-item, .search-item, .grid-item, article") || a;
      let name = extractNameFromRoot(root);
      if (!name) {
        const hint = (a.getAttribute("title") || a.textContent || "").trim();
        const m = hint.match(codePattern);
        if (m) name = m[1].toUpperCase();
      }
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    if (names.length) return names;
  }

  return [];
};
} // end block scope for VDM
