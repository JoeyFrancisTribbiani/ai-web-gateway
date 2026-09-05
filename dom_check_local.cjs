const { chromium } = require("playwright");
(async () => {
  try {
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
    const contexts = browser.contexts();
    const pages = contexts[0]?.pages() || [];
    let p = null;
    for (const pg of pages) {
      if (pg.url().includes("chatgpt.com")) { p = pg; break; }
    }
    if (!p) { console.log("no chatgpt page found, open chatgpt.com first"); process.exit(0); }
    console.log("Page URL:", p.url());
    const html = await p.evaluate(() => {
      const turns = document.querySelectorAll("[data-message-author-role=assistant]");
      if (!turns.length) return "no assistant turns";
      const last = turns[turns.length - 1];
      // 输出完整的 outerHTML 看结构
      return last.outerHTML.substring(0, 5000);
    });
    console.log("=== Assistant HTML ===");
    console.log(html);
  } catch(e) { console.log("ERR:", e.message); }
  process.exit(0);
})();
