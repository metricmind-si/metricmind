const BOT_UA = /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|lighthouse|pagespeed|prerender/i;

export function isLikelyBot(nav: Pick<Navigator, "userAgent" | "webdriver">, win: object): boolean {
  if (nav.webdriver) return true;
  if (BOT_UA.test(nav.userAgent || "")) return true;
  return "_phantom" in win || "callPhantom" in win || "__nightmare" in win;
}

const CRAWLER_UA = /bot|crawl|spider|slurp/i;

/** A search or AI crawler that runs JavaScript (Googlebot, Applebot…): reported as a crawler read, never as a visit. */
export const isCrawler = (userAgent: string) => CRAWLER_UA.test(userAgent);
