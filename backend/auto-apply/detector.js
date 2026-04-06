const { botState } = require('./bot-state');

const ATS_PATTERNS = {
  workday:          ['myworkdayjobs.com', 'wd1.', 'wd3.', 'wd5.', 'myworkday.com'],
  greenhouse:       ['greenhouse.io', 'boards.greenhouse'],
  lever:            ['jobs.lever.co', 'lever.co'],
  icims:            ['icims.com'],
  taleo:            ['taleo.net'],
  smartrecruiters:  ['smartrecruiters.com'],
  jobvite:          ['jobvite.com'],
  ashby:            ['ashbyhq.com']
};

function detectATSFromUrl(url) {
  const u = url.toLowerCase();
  for (const [ats, patterns] of Object.entries(ATS_PATTERNS)) {
    if (patterns.some(p => u.includes(p))) return ats;
  }
  return null;
}

async function detectATSFromPage(page) {
  return await page.evaluate(() => {
    const html = document.documentElement.innerHTML.toLowerCase();
    const url  = window.location.href.toLowerCase();

    if (url.includes('myworkdayjobs') || html.includes('data-automation-id')) return 'workday';
    if (url.includes('greenhouse') || html.includes('greenhouse'))             return 'greenhouse';
    if (url.includes('lever.co')  || html.includes('lever-team'))             return 'lever';
    if (url.includes('icims'))    return 'icims';
    if (url.includes('taleo'))    return 'taleo';
    if (url.includes('smartrecruiters')) return 'smartrecruiters';
    if (url.includes('ashbyhq'))  return 'ashby';

    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      const src = (iframe.src || '').toLowerCase();
      if (src.includes('greenhouse'))     return 'greenhouse';
      if (src.includes('lever'))          return 'lever';
      if (src.includes('workday'))        return 'workday';
      if (src.includes('smartrecruiters')) return 'smartrecruiters';
    }
    return 'generic';
  });
}

async function clickApplyButton(page) {
  botState.clickingApply();

  const cssSelectors = [
    '[data-automation-id="applyButton"]',
    '[data-automation-id="Apply"]',
    '.btn--apply',
    '#apply_button',
    'a.apply-button',
    '.template-btn-submit',
    'a[href*="/apply"]',
    'a[href*="apply"]',
    '.apply-btn',
    '#apply-btn',
    '[class*="apply-button"]'
  ];

  for (const sel of cssSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        const text = await btn.innerText().catch(() => '');
        botState._emit(`Found Apply button: "${text.trim()}"`);
        await btn.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) {}
  }

  const clicked = await page.evaluate(() => {
    const keywords = ['apply now', 'apply for this job', 'apply for job', 'apply', 'submit application'];
    const elements = document.querySelectorAll('button, a, [role="button"]');
    for (const el of elements) {
      const text = (el.innerText || el.textContent || '').toLowerCase().trim();
      if (keywords.some(kw => text === kw || text.startsWith(kw))) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          el.click();
          return true;
        }
      }
    }
    return false;
  });

  if (clicked) {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    botState._emit('Clicked Apply button by text');
    return true;
  }

  botState._emit('No Apply button found — may already be on application form');
  return false;
}

function isApplicationFormUrl(url, atsType) {
  const u = url.toLowerCase();
  switch (atsType) {
    case 'workday':    return u.includes('/apply/') || u.includes('job-application');
    case 'greenhouse': return u.includes('/application') || u.includes('/jobs/');
    case 'lever':      return u.includes('/apply');
    default:           return false;
  }
}

async function detectAndNavigate(page, jdUrl) {
  botState._emit(`Navigating to: ${jdUrl.substring(0, 80)}...`);

  let atsType = detectATSFromUrl(jdUrl);
  if (atsType) {
    botState._emit(`ATS detected from URL: ${atsType}`);
    if (isApplicationFormUrl(jdUrl, atsType)) {
      return { atsType, alreadyOnForm: true };
    }
  }

  await page.goto(jdUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  if (!atsType) {
    atsType = await detectATSFromPage(page);
    botState._emit(`ATS detected from page: ${atsType}`);
  }

  const currentUrl = page.url();
  if (isApplicationFormUrl(currentUrl, atsType)) {
    return { atsType, alreadyOnForm: true };
  }

  const clicked = await clickApplyButton(page);
  await page.waitForTimeout(3000);

  const newUrl = page.url();
  if (newUrl !== currentUrl) {
    const newDetected = detectATSFromUrl(newUrl);
    if (newDetected) atsType = newDetected;
    else atsType = await detectATSFromPage(page);
  }

  return { atsType, alreadyOnForm: false, clicked };
}

module.exports = { detectAndNavigate, detectATSFromUrl, detectATSFromPage, ATS_PATTERNS };
