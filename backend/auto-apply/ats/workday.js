// workday.js — Workday-specific application handler.
// Knows exactly how Workday works: account page, popups, resume parse, button dropdowns.

const { botState, STATES }    = require('../bot-state');

// Safe evaluate — swallows navigation/context errors gracefully
async function safeEval(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (e) {
    if (e.message && (
      e.message.includes('Execution context was destroyed') ||
      e.message.includes('navigation') ||
      e.message.includes('Target closed') ||
      e.message.includes('Session closed')
    )) {
      return null;
    }
    throw e;
  }
}
const { scanPage, detectNavigation, clickNavButton, clickNextByText, getPageTitle, fullPageDump } = require('../page-scanner');
const { getFieldAnswers, generateWorkExperienceDescription } = require('../field-ai');
const { fillAllFields, fillFile } = require('../field-filler');

// ── MAIN ENTRY ────────────────────────────────────────────────────────────────
async function handleWorkday({ page, profile, resumePath, jobDescription, companyName, position, generateAIContent, aiProvider, apiKey }) {
  let pageNum = 0;
  const maxPages = 25;
  let previousFieldKeys = '';
  let samePageRetries   = 0;

  while (pageNum < maxPages) {
    if (botState.state === STATES.IDLE || botState.state === STATES.ERROR) break;

    // ── PAUSE CHECK — respect human pause at every loop iteration ────────────
    if (botState.state === STATES.PAUSED) {
      botState._emit('Bot paused — waiting for Resume...');
      await botState.waitForUnpause();
      if (botState.state === STATES.IDLE || botState.state === STATES.ERROR) break;
      botState._emit('Resumed — re-reading page');
      pageNum = Math.max(0, pageNum - 1); // re-read current page after resume
    }

    pageNum++;
    botState.scanning(pageNum);

    // Wait for Workday to fully load
    await waitForWorkdayLoad(page);

    const currentUrl = page.url();
    botState._emit(`── Page ${pageNum} ──────────────────────────`);
    botState._emit(`URL: ${currentUrl.substring(0, 100)}`);

    // ── Navigation safety — catch mid-loop navigation errors ────────────────
    // If Workday navigates unexpectedly during any step, catch it and re-read the page
    try {

    // ── 1. Handle "Apply Manually" popup (appears RIGHT AFTER clicking Apply) ──
    // Must check popup BEFORE account page — popup can appear on any page
    const handledPopup = await handleWorkdayPopups(page);
    if (handledPopup) {
      await page.waitForTimeout(2000);
      pageNum--; // re-read after popup dismissed
      continue;
    }

    // ── 2. Handle Account / Login page (Create Account or Sign In) ────────────
    const onAccountPage = await isAccountOrLoginPage(page);
    if (onAccountPage) {
      await handleAccountPage(page, profile);
      await page.waitForTimeout(3000);
      pageNum--; // re-read after login/account creation
      continue;
    }

    // ── 3. Check if stuck (captcha, unexpected page) ──────────────────────────
    const stuck = await checkIfStuck(page);
    if (stuck) {
      const r = await botState.waitForResume();
      if (r === 'stopped' || botState.state === STATES.IDLE) break;
      pageNum--;
      continue;
    }

    // ── 4. Get page title ─────────────────────────────────────────────────────
    const pageTitle = await getPageTitle(page);
    botState._emit(`Page title: "${pageTitle}"`);

    // ── 5. Full page dump — shows EVERYTHING bot sees ─────────────────────────
    await logFullPageDump(page);

    // ── 6. Check for Submit button (last page) ────────────────────────────────
    const nav = await detectNavigation(page);
    botState._emit(`Navigation: next=${nav.nextButton ? 'YES' : 'NO'}, submit=${nav.submitButton ? 'YES' : 'NO'}`);

    if (nav.submitButton) {
      botState.waitingSubmit();
      botState._emit('');
      botState._emit('████████████████████████████████████████');
      botState._emit('  READY TO SUBMIT — DO NOT AUTO-SUBMIT');
      botState._emit('  Please click SUBMIT in the browser.');
      botState._emit('████████████████████████████████████████');
      botState._emit('');
      await waitForSubmissionOrStop(page);
      break;
    }

    // ── 7. Handle resume upload (My Experience page) ──────────────────────────
    await handleResumeUpload(page, pageTitle, resumePath);

    // ── 8. Detect page type ───────────────────────────────────────────────────
    const pageContext = detectPageContext(pageTitle, currentUrl);
    botState._emit(`Page context: ${pageContext}`);

    // ── 9. Scan all fields ────────────────────────────────────────────────────
    const fields = await scanPage(page);
    botState.fields = fields;

    // Duplicate page detection
    const currentFieldKeys = fields.map(f => f.key).sort().join(',');
    if (currentFieldKeys === previousFieldKeys && currentFieldKeys.length > 0) {
      samePageRetries++;
      botState._emit(`Same fields detected (retry ${samePageRetries}/3)`);

      const errors = await getValidationErrors(page);
      if (errors.length > 0) {
        botState._emit('Validation errors:');
        errors.forEach(e => botState._emit(`  ⚠ ${e}`));
      }

      if (samePageRetries >= 3) {
        botState.setStuck('Page has errors or bot cannot advance. Fix manually then Resume.');
        const r = await botState.waitForResume();
        if (r === 'stopped' || botState.state === STATES.IDLE) break;
        samePageRetries = 0;
        pageNum--;
        continue;
      }
    } else {
      samePageRetries = 0;
      previousFieldKeys = currentFieldKeys;
    }

    // Log scanned fields
    botState._emit(`Scanned ${fields.length} fields:`);
    for (const f of fields) {
      const pre = f.value ? ` [prefilled: "${String(f.value).substring(0, 25)}"]` : '';
      const opts = f.options ? ` [options: ${f.options.slice(0,4).map(o=>o.text||o).join(', ')}...]` : '';
      const req = f.required ? ' *' : '';
      botState._emit(`  [${f.type}] "${f.label}"${req}${pre}${opts}`);
    }

    // ── 10. Ask AI to answer all fields ───────────────────────────────────────
    if (fields.length > 0) {
      botState.aiThinking();
      botState._emit('Sending fields to AI...');

      const answers = await getFieldAnswers({
        fields, profile, jobDescription, companyName, position,
        generateAIContent, aiProvider, apiKey,
        pageTitle, pageContext
      });

      botState._emit(`AI returned ${Object.keys(answers).length} answers:`);
      for (const [key, val] of Object.entries(answers)) {
        if (val !== '__PREFILLED__' && val !== '__SKIP__') {
          botState._emit(`  "${key}" → "${String(val).substring(0, 60)}"`);
        }
      }

      // ── 11. Fill all fields ─────────────────────────────────────────────────
      botState.filling();
      const filledCount = await fillAllFields(page, fields, answers, resumePath);
      botState._emit(`Filled ${filledCount}/${fields.length} fields`);

      // Check validation errors after filling
      const errors = await getValidationErrors(page);
      if (errors.length > 0) {
        botState._emit(`${errors.length} validation issue(s) after filling:`);
        errors.forEach(e => botState._emit(`  ⚠ ${e}`));
      }
    }

    // ── 12. Pause for user review ─────────────────────────────────────────────
    botState.review(pageNum);
    botState._emit('Page done — check browser, fix any issues, then click Confirm in the dashboard.');
    const confirmResult = await botState.waitForConfirm();
    if (confirmResult === 'stopped') break;
    botState._emit('Confirmed — advancing...');

    // ── 13. Click Next ────────────────────────────────────────────────────────
    const advanced = await advanceWorkdayPage(page, nav, pageNum);
    if (advanced) {
      await page.waitForTimeout(2000);
      continue;
    }

    // Could not advance — ask user to navigate manually
    botState._emit('Could not find Next button. Please navigate manually in the browser, then click Pause and Resume.');
    const waitResult = await waitForPageChange(page, currentUrl);
    if (waitResult === 'stopped') break;
    if (waitResult === 'changed') {
      botState._emit('Page changed — re-reading...');
      continue;
    }

    botState.setStuck('Cannot advance to next page. Navigate manually then Resume.');
    const stuckResult = await botState.waitForResume();
    if (stuckResult === 'stopped' || botState.state === STATES.IDLE) break;
    pageNum--;

    } catch (loopErr) {
      if (loopErr.message && (
        loopErr.message.includes('Execution context was destroyed') ||
        loopErr.message.includes('navigation') ||
        loopErr.message.includes('Target closed')
      )) {
        botState._emit(`Page navigated unexpectedly — re-reading page`);
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);
        pageNum--;
        continue;
      }
      throw loopErr;
    }
  }

  return { pagesCompleted: pageNum };
}

// ── Account / Login page detection ───────────────────────────────────────────
// Workday shows this page AFTER clicking Apply — before any form.
// It has: email + password + (sometimes verify password) + terms checkbox + button
async function isAccountOrLoginPage(page) {
  return await safeEval(page, () => {
    const url = window.location.href.toLowerCase();
    // Workday account URLs
    if (url.includes('signin') || url.includes('login') || url.includes('createaccount')) return true;
    // Has a password field = account/login page
    const pwdField = document.querySelector('input[type="password"]');
    return !!pwdField;
  });
}

// ── Detect whether page is Create Account or Sign In ─────────────────────────
// KEY INSIGHT: Sign In page has "Create Account" as a LINK (not the submit button).
// We must only look at the PRIMARY submit button — not all buttons on the page.
async function detectAccountPageType(page) {
  return await page.evaluate(() => {
    const pwdCount = document.querySelectorAll('input[type="password"]').length;

    // Rule 1: 2 password fields = definitely Create Account
    if (pwdCount >= 2) return 'create_account';

    // Rule 2: Check the PRIMARY submit button only.
    // Workday's submit button has data-automation-id="click_filter" AND role="button"
    // It's the large colored button at the bottom of the form — not links/secondary buttons.
    // Strategy: find the button with the highest visual prominence (largest, in form footer)
    const submitCandidates = document.querySelectorAll(
      'button[type="submit"], [role="button"][data-automation-id="click_filter"], [role="button"][aria-label]'
    );

    for (const el of submitCandidates) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      // Only consider reasonably sized buttons (not tiny links)
      if (rect.width < 80 || rect.height < 30) continue;

      const text = (
        (el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')
      ).toLowerCase().trim();

      if (text.includes('create account')) return 'create_account';
      if (text === 'sign in' || text === 'log in' || text.includes('sign in')) return 'sign_in';
    }

    // Rule 3: Check form heading — most reliable page identity
    const headings = document.querySelectorAll('h1, h2, h3, [data-automation-id*="header"], [data-automation-id*="title"]');
    for (const h of headings) {
      const text = (h.innerText || '').toLowerCase();
      if (text.includes('create account') || text.includes('create your account')) return 'create_account';
      if (text.includes('sign in') || text.includes('log in') || text.includes('welcome back')) return 'sign_in';
    }

    // Rule 4: 1 password field = Sign In (Create Account always has 2)
    if (pwdCount === 1) return 'sign_in';

    return 'unknown';
  });
}

// ── Handle Workday Create Account page ───────────────────────────────────────
// Fields: Email Address, Password, Verify Password, Terms checkbox, Create Account button
async function handleCreateAccountPage(page, email, password) {
  botState._emit('CREATE ACCOUNT page — filling email, password, verify password...');

  // Step 1: Fill Email
  const emailField = await page.$('input[type="email"], input[data-automation-id*="email"], input[id*="email"], input[placeholder*="email" i]');
  if (emailField) {
    const current = await emailField.inputValue().catch(() => '');
    if (!current) {
      await emailField.fill('');
      await emailField.type(email, { delay: 40 });
      botState._emit(`  Filled email: ${email}`);
    } else {
      botState._emit(`  Email already filled: ${current}`);
    }
  } else {
    botState._emit('  WARNING: Could not find email field');
  }

  await page.waitForTimeout(300);

  // Step 2: Fill all password fields (Password + Verify Password)
  const pwdFields = await page.$$('input[type="password"]');
  botState._emit(`  Found ${pwdFields.length} password field(s)`);

  for (let i = 0; i < pwdFields.length; i++) {
    try {
      const current = await pwdFields[i].inputValue().catch(() => '');
      if (!current) {
        await pwdFields[i].fill('');
        await pwdFields[i].type(password, { delay: 40 });
        botState._emit(`  Filled password field ${i + 1}`);
      } else {
        botState._emit(`  Password field ${i + 1} already filled`);
      }
      await page.waitForTimeout(200);
    } catch (e) {
      botState._emit(`  Password field ${i + 1} error: ${e.message}`);
    }
  }

  // Step 3: Check terms/conditions checkbox (if unchecked)
  try {
    const checkboxes = await page.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const isChecked = await cb.isChecked().catch(() => false);
      if (!isChecked) {
        // Use force:true because Workday hides the actual checkbox input
        await cb.click({ force: true }).catch(async () => {
          // Fallback: click the label
          const cbId = await cb.getAttribute('id');
          if (cbId) {
            const lbl = await page.$(`label[for="${cbId}"]`);
            if (lbl) await lbl.click();
          }
        });
        await page.waitForTimeout(300);
        botState._emit('  Checked terms/conditions checkbox');
        break;
      }
    }
  } catch (_) {}

  // Step 4: Click "Create Account" button using Playwright (not page.evaluate)
  botState._emit('  Clicking Create Account button...');

  // Find exact button text — avoid clicking "Sign In" on same page
  // Include div[role="button"] — Workday uses these instead of real <button> elements
  const allBtns = await page.$$('button, input[type="submit"], [role="button"]');
  let createAccountBtn = null;
  for (const btn of allBtns) {
    const text = (await btn.innerText().catch(() => '') || await btn.getAttribute('aria-label').catch(() => '') || '').toLowerCase().trim();
    const visible = await btn.isVisible().catch(() => false);
    if (visible && (text === 'create account' || text.includes('create account'))) {
      createAccountBtn = btn;
      botState._emit(`  Found button: "${text}"`);
      break;
    }
  }

  if (createAccountBtn) {
    // Use JavaScript click — Workday uses div[role="button"] which intercepts pointer events
    await createAccountBtn.evaluate(el => el.click());
    botState._emit('  Clicked Create Account (JS click)');
  } else {
    // Fallback: find by aria-label or data-automation-id
    const jsClicked = await page.evaluate(() => {
      const candidates = document.querySelectorAll(
        'button, [role="button"], input[type="submit"], [data-automation-id*="create"], [aria-label*="Create Account" i]'
      );
      for (const el of candidates) {
        const text = (el.innerText || el.getAttribute('aria-label') || el.value || '').toLowerCase();
        if (text.includes('create account')) {
          el.click();
          return el.innerText || el.getAttribute('aria-label') || 'clicked';
        }
      }
      return null;
    });
    if (jsClicked) {
      botState._emit(`  JS fallback clicked: "${jsClicked}"`);
    } else {
      botState._emit('  WARNING: No Create Account button found');
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Check for errors
  const errMsg = await page.evaluate(() => {
    const selectors = ['[data-automation-id="errorMessage"]', '.error', '[class*="error"]', '[role="alert"]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 3) return el.innerText.trim();
    }
    return '';
  });

  if (errMsg) {
    botState._emit(`  Account creation result: "${errMsg.substring(0, 150)}"`);
    // If account already exists, switch to Sign In
    if (/already|exists|registered|taken/i.test(errMsg)) {
      botState._emit('  Account exists — switching to Sign In...');
      // Look for Sign In link/button — must NOT click Create Account again
      const buttons = await page.$$('button, a');
      for (const btn of buttons) {
        const text = (await btn.innerText().catch(() => '')).toLowerCase().trim();
        const visible = await btn.isVisible().catch(() => false);
        if (visible && (text === 'sign in' || text === 'log in' || text.includes('sign in'))) {
          await btn.click();
          await page.waitForTimeout(2000);
          break;
        }
      }
    }
  } else {
    botState._emit('  Account created (no error shown) — page should advance');
  }
}

// ── Handle Workday Sign In page ───────────────────────────────────────────────
// Fields: Email, Password, Sign In button
async function handleSignInPage(page, email, password) {
  botState._emit('SIGN IN page — filling email and password...');

  // Fill email
  const emailField = await page.$('input[type="email"], input[data-automation-id*="email"], input[id*="email"], input[placeholder*="email" i]');
  if (emailField) {
    const current = await emailField.inputValue().catch(() => '');
    if (!current) {
      await emailField.fill('');
      await emailField.type(email, { delay: 40 });
      botState._emit(`  Filled email: ${email}`);
    } else {
      botState._emit(`  Email already filled: ${current}`);
    }
  }

  await page.waitForTimeout(300);

  // Fill password (only ONE field on Sign In page)
  const pwdField = await page.$('input[type="password"]');
  if (pwdField) {
    const current = await pwdField.inputValue().catch(() => '');
    if (!current) {
      await pwdField.fill('');
      await pwdField.type(password, { delay: 40 });
      botState._emit('  Filled password');
    } else {
      botState._emit('  Password already filled');
    }
  }

  await page.waitForTimeout(300);

  // Click Sign In button using Playwright (not page.evaluate)
  botState._emit('  Clicking Sign In button...');

  const signInTexts = ['sign in', 'log in', 'signin', 'login'];
  // Include div[role="button"] — Workday uses these
  const allBtns2 = await page.$$('button, input[type="submit"], [role="button"]');
  let signInBtn = null;

  for (const btn of allBtns2) {
    const text = (await btn.innerText().catch(() => '') || await btn.getAttribute('aria-label').catch(() => '') || '').toLowerCase().trim();
    const visible = await btn.isVisible().catch(() => false);
    if (visible && signInTexts.includes(text)) {
      signInBtn = btn;
      botState._emit(`  Found button: "${text}"`);
      break;
    }
  }

  if (signInBtn) {
    // Use JavaScript click — Workday uses div[role="button"] which intercepts pointer events
    await signInBtn.evaluate(el => el.click());
    botState._emit('  Clicked Sign In (JS click)');
  } else {
    // Fallback: find by aria-label or role
    const jsClicked = await page.evaluate(() => {
      const candidates = document.querySelectorAll(
        'button, [role="button"], input[type="submit"], [aria-label*="Sign In" i], [aria-label*="Log In" i]'
      );
      for (const el of candidates) {
        const text = (el.innerText || el.getAttribute('aria-label') || el.value || '').toLowerCase().trim();
        if (text === 'sign in' || text === 'log in' || text === 'signin' || text === 'login') {
          el.click();
          return text;
        }
      }
      return null;
    });
    if (jsClicked) {
      botState._emit(`  JS fallback clicked: "${jsClicked}"`);
    } else {
      botState._emit('  WARNING: No Sign In button found');
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Check for errors
  const errMsg = await page.evaluate(() => {
    const selectors = ['[data-automation-id="errorMessage"]', '.error', '[class*="error"]', '[role="alert"]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 3) return el.innerText.trim();
    }
    return '';
  });

  if (errMsg) {
    botState._emit(`  Sign in result: "${errMsg.substring(0, 150)}"`);
    if (/incorrect|wrong|invalid|failed/i.test(errMsg)) {
      botState.setStuck(`Sign in failed: "${errMsg}" — fix in browser then Resume`);
    }
  } else {
    botState._emit('  Signed in successfully');
  }
}

// ── Master account page handler ───────────────────────────────────────────────
async function handleAccountPage(page, profile) {
  const email    = process.env.WORKDAY_EMAIL    || profile.personal.email;
  const password = process.env.WORKDAY_PASSWORD || '';

  if (!password) {
    botState.setStuck('WORKDAY_PASSWORD not set in .env — add it then Resume');
    await botState.waitForResume();
    return;
  }

  const pageType = await detectAccountPageType(page);
  botState._emit(`Account page type: ${pageType}`);

  if (pageType === 'create_account') {
    await handleCreateAccountPage(page, email, password);
  } else if (pageType === 'sign_in') {
    await handleSignInPage(page, email, password);
  } else {
    // Unknown — try create account first (has more fields visible)
    botState._emit('Unknown account page type — trying Create Account flow');
    const pwdCount = (await page.$$('input[type="password"]')).length;
    if (pwdCount >= 2) {
      await handleCreateAccountPage(page, email, password);
    } else {
      await handleSignInPage(page, email, password);
    }
  }
}

// ── Handle Workday popups (Apply Manually / Autofill) ────────────────────────
// This popup appears RIGHT AFTER clicking Apply on the job post.
// Must click "Apply Manually" — otherwise Workday tries to autofill and fails.
async function handleWorkdayPopups(page) {
  const popupTexts = [
    'apply manually',
    'start fresh',
    'apply without resume',
    'fill out manually'
  ];

  // Try data-automation-id first (most reliable for Workday)
  const aidSelectors = [
    '[data-automation-id="useManuallyButton"]',
    '[data-automation-id="startFreshButton"]',
    '[data-automation-id="applyManuallyButton"]'
  ];

  for (const sel of aidSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        const text = await btn.innerText().catch(() => sel);
        botState._emit(`Popup: clicking "${text}"`);
        await btn.click();
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) {}
  }

  // Try by button text content
  const clicked = await page.evaluate((keywords) => {
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'));
    for (const kw of keywords) {
      for (const btn of buttons) {
        const text = (btn.innerText || '').toLowerCase().trim();
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (text === kw || text.includes(kw)) {
          btn.click();
          return text;
        }
      }
    }
    return null;
  }, popupTexts);

  if (clicked) {
    botState._emit(`Popup: clicked "${clicked}" by text`);
    await page.waitForTimeout(2000);
    return true;
  }

  // Check for "Use My Last Application" popup
  const lastAppBtn = await page.$('[data-automation-id="useLastApplicationButton"]');
  if (lastAppBtn && await lastAppBtn.isVisible()) {
    botState._emit('Last application popup — looking for Apply Manually option');
    const freshBtn = await page.$('[data-automation-id="useManuallyButton"], [data-automation-id="startFreshButton"]');
    if (freshBtn) {
      const text = await freshBtn.innerText().catch(() => 'Start Fresh');
      botState._emit(`  Clicking "${text}"`);
      await freshBtn.click();
    } else {
      await lastAppBtn.click();
    }
    await page.waitForTimeout(2000);
    return true;
  }

  return false;
}

// ── Handle resume upload ──────────────────────────────────────────────────────
async function handleResumeUpload(page, pageTitle, resumePath) {
  if (!resumePath) return;

  const title = (pageTitle || '').toLowerCase();
  const isResumePage = title.includes('resume') || title.includes('my experience') || title.includes('experience');
  if (!isResumePage) return;

  // Check if already uploaded
  const existingFile = await page.$('[data-automation-id="file-upload-delete-button"], .file-name, [class*="fileName"]');
  if (existingFile) {
    botState._emit('Resume already uploaded — skipping');
    return;
  }

  const fileInput = await page.$('[data-automation-id="file-upload-input-ref"], input[type="file"]');
  if (!fileInput) return;

  botState._emit('Uploading resume...');
  await fileInput.setInputFiles(resumePath);

  // Wait for Workday to parse the resume (loading spinner)
  botState._emit('Waiting for Workday to parse resume (up to 30 seconds)...');
  await page.waitForTimeout(2000);

  try {
    await page.waitForSelector('[data-automation-id="loadingSpinner"]', { timeout: 5000 });
    await page.waitForSelector('[data-automation-id="loadingSpinner"]', { state: 'hidden', timeout: 30000 });
    botState._emit('Resume parsed by Workday');
  } catch (_) {
    await page.waitForTimeout(3000);
    botState._emit('Resume upload complete');
  }
}

// ── Detect page context ───────────────────────────────────────────────────────
function detectPageContext(pageTitle, url) {
  const t = (pageTitle || '').toLowerCase();
  const u = (url || '').toLowerCase();

  if (t.includes('experience') || t.includes('work history') || t.includes('employment')) return 'work_experience';
  if (t.includes('education') || t.includes('school')) return 'education';
  if (t.includes('my information') || t.includes('personal') || t.includes('contact')) return 'personal_info';
  if (t.includes('voluntary') || t.includes('eeo') || t.includes('diversity') || t.includes('disclosure')) return 'eeo';
  if (t.includes('questions') || t.includes('application')) return 'application_questions';
  if (t.includes('review') || t.includes('summary')) return 'review';
  if (t.includes('resume')) return 'resume_upload';
  return 'unknown';
}

// ── Validation error detection ────────────────────────────────────────────────
async function getValidationErrors(page) {
  return await safeEval(page, () => {
    const errors = [];
    const selectors = [
      '[data-automation-id="errorMessage"]',
      '[data-automation-id*="error"]',
      '.error-message',
      '[class*="fieldError"]',
      '[role="alert"]'
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.innerText.trim();
        if (text && text.length > 5 && text.length < 500 &&
            !text.toLowerCase().includes('successfully') &&
            !text.toLowerCase().includes('uploaded')) {
          errors.push(text.substring(0, 120));
        }
      });
    }
    return [...new Set(errors)].slice(0, 10);
  });
}

// ── Stuck detection ───────────────────────────────────────────────────────────
async function checkIfStuck(page) {
  const captcha = await page.$('iframe[src*="recaptcha"], .cf-challenge, .h-captcha');
  if (captcha) {
    botState.setStuck('CAPTCHA detected — solve it in the browser then click Resume');
    return true;
  }

  // Generic error page
  const bodyText = await page.textContent('body').catch(() => '');
  if (bodyText && /something went wrong|unexpected error/i.test(bodyText) && bodyText.length < 1000) {
    botState._emit('Error page detected — refreshing...');
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);
    return false; // not stuck, just refresh
  }

  return false;
}

// ── Page navigation ───────────────────────────────────────────────────────────
async function advanceWorkdayPage(page, nav, pageNum) {
  // Workday standard next button
  if (nav.nextButton) {
    botState._emit(`Clicking Next → page ${pageNum + 1}`);
    const clicked = await clickNavButton(page, nav.nextButton);
    if (clicked) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      return true;
    }
  }

  // Fallback: click by text
  const clickedText = await clickNextByText(page);
  if (clickedText) {
    botState._emit(`Clicked "${clickedText}" button`);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return true;
  }

  // Workday-specific alternate selectors
  const altSelectors = [
    '[data-automation-id="pageFooterNextButton"]',
    '[data-automation-id="continueButton"]',
    'button[data-automation-id*="next"]',
    'button[data-automation-id*="continue"]',
    'button[data-automation-id*="Next"]'
  ];

  for (const sel of altSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        botState._emit(`Clicking alternate: ${sel}`);
        await btn.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2500);
        return true;
      }
    } catch (_) {}
  }

  return false;
}

// ── Wait for page change ──────────────────────────────────────────────────────
async function waitForPageChange(page, originalUrl) {
  return new Promise((resolve) => {
    let checkCount = 0;
    let resolved   = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(checkInterval);
      botState.removeListener('update', onUpdate);
    };

    const onUpdate = (snapshot) => {
      if (snapshot.state === STATES.IDLE || snapshot.state === STATES.ERROR) { cleanup(); resolve('stopped'); }
      if (snapshot.state === STATES.SCANNING) { cleanup(); resolve('changed'); }
    };

    botState.on('update', onUpdate);

    const checkInterval = setInterval(async () => {
      checkCount++;
      try {
        if (page.url() !== originalUrl) { cleanup(); resolve('changed'); return; }
      } catch (_) {}
      if (checkCount >= 40) { cleanup(); resolve('timeout'); }
    }, 5000);
  });
}

// ── Wait for submission ───────────────────────────────────────────────────────
async function waitForSubmissionOrStop(page) {
  return new Promise((resolve) => {
    let checkInterval;
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (checkInterval) clearInterval(checkInterval);
      botState.removeListener('update', onUpdate);
    };

    const onUpdate = (snapshot) => {
      if (snapshot.state === STATES.IDLE || snapshot.state === STATES.ERROR) { cleanup(); resolve('stopped'); }
    };

    botState.on('update', onUpdate);

    checkInterval = setInterval(async () => {
      try {
        const text = (await page.textContent('body').catch(() => '')).toLowerCase();
        const submitted = [
          'application submitted',
          'thank you for applying',
          'application received',
          'successfully submitted',
          'thank you for your application'
        ].some(s => text.includes(s));

        if (submitted) {
          cleanup();
          botState.done('Application submitted successfully!');
          resolve('done');
        }
      } catch (_) {}
    }, 3000);

    // 30 minute max wait
    setTimeout(() => { cleanup(); resolve('timeout'); }, 30 * 60 * 1000);
  });
}

// ── Workday load wait ─────────────────────────────────────────────────────────
async function waitForWorkdayLoad(page) {
  try {
    await page.waitForSelector('[data-automation-id], form, input, button', { timeout: 15000 });
  } catch (_) {}
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
}

// ── Full page dump for debugging ──────────────────────────────────────────────
async function logFullPageDump(page) {
  try {
    const { fullPageDump } = require('../page-scanner');
    const dump = await fullPageDump(page);

    botState._emit('--- PAGE DUMP ---');
    botState._emit(`${dump.allElements.length} form elements, ${dump.buttons.length} buttons`);

    for (const el of dump.allElements) {
      if (!el.visible) continue; // only log visible elements
      const req = el.required ? ' *REQUIRED*' : '';
      const val = el.value ? ` val="${el.value}"` : '';
      const opts = el.options ? ` opts=[${el.options.slice(0, 4).join(',')}]` : '';
      botState._emit(`  ${el.tag}[${el.type}] id="${el.automationId || el.id}" label="${el.label}"${req}${val}${opts}`);
    }

    for (const btn of dump.buttons) {
      if (!btn.visible) continue;
      botState._emit(`  BTN: "${btn.text}" aid="${btn.automationId}"`);
    }
    botState._emit('--- END DUMP ---');
  } catch (e) {
    botState._emit(`Page dump error: ${e.message}`);
  }
}

module.exports = { handleWorkday };