const { botState } = require('./bot-state');

const TYPING_DELAY = parseInt(process.env.BOT_TYPING_DELAY_MS) || 30;

// Safe evaluate — returns null instead of throwing when page navigates mid-call
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
      botState._emit('  Page navigated during eval — continuing');
      return null;
    }
    throw e;
  }
}

// Safe element evaluate — returns null on stale/detached element
async function safeElEval(el, fn) {
  try {
    return await el.evaluate(fn);
  } catch (e) {
    return null;
  }
}

async function fillText(page, field, value) {
  const selector = field.selector || `[data-automation-id="${field.automationId}"]`;
  const el = await page.$(selector);
  if (!el) {
    botState._emit(`  FILL FAIL: "${field.label}" — element not found (${selector})`);
    return false;
  }

  const current = await el.inputValue().catch(() => '');
  if (current && current.trim() !== '') {
    botState._emit(`Skipping pre-filled: ${field.label} = "${current.substring(0, 40)}"`);
    return true;
  }

  await el.fill('');
  await el.type(String(value), { delay: TYPING_DELAY });
  return true;
}

async function fillTextarea(page, field, value) {
  const selector = field.selector || `[data-automation-id="${field.automationId}"]`;
  const el = await page.$(selector);
  if (!el) {
    botState._emit(`  FILL FAIL: "${field.label}" — element not found (${selector})`);
    return false;
  }

  const current = await el.inputValue().catch(() => '');
  if (current && current.trim() !== '') {
    botState._emit(`Skipping pre-filled: ${field.label} = "${current.substring(0, 40)}..."`);
    return true;
  }

  await el.fill('');
  await el.type(String(value), { delay: Math.min(TYPING_DELAY, 20) });
  return true;
}

async function fillSelect(page, field, value) {
  const selector = field.selector || `[data-automation-id="${field.automationId}"]`;
  const el = await page.$(selector);
  if (!el) {
    botState._emit(`  FILL FAIL: "${field.label}" — <select> not found (${selector})`);
    return false;
  }

  const options = await el.$$eval('option', opts => opts.map(o => ({ value: o.value, text: o.text.trim() })));
  botState._emit(`  SELECT "${field.label}": ${options.length} options: [${options.map(o => o.text).join(', ')}]`);

  const valLower = String(value).toLowerCase();
  const match = options.find(o => o.text.toLowerCase() === valLower)
    || options.find(o => o.value.toLowerCase() === valLower)
    || options.find(o => o.text.toLowerCase().includes(valLower))
    || options.find(o => valLower.includes(o.text.toLowerCase()) && o.text.toLowerCase() !== 'select one' && o.text !== '');

  if (match) {
    botState._emit(`  SELECT "${field.label}": matched → "${match.text}" (value="${match.value}")`);
    await el.selectOption(match.value);
    // Dispatch change event to trigger Workday validation
    await el.evaluate(select => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    return true;
  }

  botState._emit(`  SELECT FAIL: "${field.label}" — no match for "${value}" in [${options.map(o => o.text).join(', ')}]`);
  return false;
}

// ── Workday typeahead dropdown ────────────────────────────────────────────────
// Used for: "How Did You Hear About Us?", "Country Phone Code", "State", "Country"
// Flow: click field → find input inside → type search text → press Enter → wait for
//       dropdown list → pick best matching option.
async function fillWorkdayDropdown(page, field, value) {
  const automationId = field.automationId || field.key;
  const valStr = String(value).trim();
  const valLower = valStr.toLowerCase();
  const labelText = (field.label || '').replace(/\*/g, '').trim();

  botState._emit(`  WD-DROPDOWN "${field.label}" → "${valStr}" (aid="${automationId}")`);

  // Build search terms based on field type
  const label = (field.label || '').toLowerCase();
  let searchTerms;
  if (label.includes('hear about') || label.includes('source') || label.includes('referral')) {
    const terms = [];
    if (valStr && valStr.toLowerCase() !== 'linkedin') terms.push(valStr);
    terms.push('career', 'LinkedIn', 'Job Board', 'Other');
    searchTerms = terms;
  } else if (label.includes('country phone') || label.includes('phone code')) {
    searchTerms = ['United States', '+1'];
  } else if (label.includes('state') || label.includes('province')) {
    searchTerms = [valStr];
  } else if (label.includes('country')) {
    searchTerms = ['United States'];
  } else {
    searchTerms = [valStr, valStr.split(' ')[0]].filter(Boolean);
  }

  // ── Step 1: Find and activate the input via browser DOM API ───────────────
  // page.$() sometimes can't find Workday inputs, so we use page.evaluate()
  // which accesses the browser's native DOM directly.
  const inputFound = await page.evaluate((aid) => {
    // Try multiple ways to find the input
    let input = document.querySelector(`input[data-automation-id="${aid}"]`);
    if (!input) {
      const container = document.querySelector(`[data-automation-id="${aid}"]`);
      if (container && container.tagName !== 'INPUT') {
        input = container.querySelector('input');
      }
    }
    if (!input) {
      // Search all inputs for matching automation ID
      for (const inp of document.querySelectorAll('input')) {
        if (inp.getAttribute('data-automation-id') === aid) { input = inp; break; }
      }
    }
    if (!input) return { found: false };

    // Scroll into view, focus, and click to activate
    input.scrollIntoView({ block: 'center' });
    input.focus();
    input.click();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    return {
      found: true,
      tag: input.tagName,
      type: input.type,
      visible: window.getComputedStyle(input).display !== 'none'
    };
  }, automationId).catch(() => ({ found: false }));

  if (!inputFound.found) {
    botState._emit(`  FAIL: input not found in DOM for "${field.label}"`);
    return false;
  }
  botState._emit(`  Input found (${inputFound.tag}[${inputFound.type}], visible=${inputFound.visible})`);
  await page.waitForTimeout(500);

  // ── Step 2: Type search terms and select from dropdown ────────────────────
  const POPUP_SEL = '[data-automation-id="promptOption"], [role="option"], li[role="option"], [data-automation-id*="listItem"], [data-automation-id="dropdownValue"]';

  for (const term of searchTerms) {
    botState._emit(`  Trying: "${term}"`);

    // Re-focus the input and clear it (all via browser DOM)
    await page.evaluate((aid) => {
      const input = document.querySelector(`input[data-automation-id="${aid}"]`)
        || (document.querySelector(`[data-automation-id="${aid}"]`) || {}).querySelector?.('input');
      if (input) {
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, automationId).catch(() => {});
    await page.waitForTimeout(200);

    // Type using real keystrokes via page.keyboard (works on whatever element has focus)
    await page.keyboard.type(term, { delay: 100 });

    // Wait for dropdown options (Workday fetches as you type)
    let optionCount = 0;
    for (let wait = 0; wait < 8; wait++) {
      await page.waitForTimeout(400);
      optionCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, POPUP_SEL).catch(() => 0);
      if (optionCount > 0) break;
    }

    // If no options from typing alone, press Enter to trigger server search
    if (optionCount === 0) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      optionCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, POPUP_SEL).catch(() => 0);
    }

    if (optionCount === 0) {
      botState._emit(`  No options for "${term}"`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      // Re-focus the input for the next search term
      await page.evaluate((aid) => {
        const input = document.querySelector(`input[data-automation-id="${aid}"]`);
        if (input) { input.focus(); input.click(); }
      }, automationId).catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }

    // Read option texts for logging
    const optionTexts = await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(sel))
        .map(el => el.innerText.trim()).filter(t => t.length > 0);
    }, POPUP_SEL).catch(() => []);
    botState._emit(`  ${optionTexts.length} options: [${optionTexts.slice(0, 5).join(' | ')}]`);

    // Pick the best matching option and click it (via browser DOM)
    const picked = await page.evaluate(({ sel, tl, vl }) => {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length === 0) return null;
      let best = null, bestScore = -1;
      for (const el of els) {
        const text = (el.innerText || '').trim().toLowerCase();
        if (!text) continue;
        let score = 0;
        if (text === tl) score = 100;
        else if (text === vl) score = 95;
        else if (text.includes('career') && tl === 'career') score = 90;
        else if (text.includes(tl)) score = 70;
        else if (tl.includes(text) && text.length > 2) score = 60;
        if (score > bestScore) { bestScore = score; best = el; }
      }
      if (!best) best = els[0];
      const resultText = best.innerText.trim();
      best.click();
      return resultText;
    }, { sel: POPUP_SEL, tl: term.toLowerCase(), vl: valLower }).catch(() => null);

    if (picked) {
      await page.waitForTimeout(500);
      botState._emit(`  Selected: "${picked}"`);
      return true;
    }

    // Keyboard fallback: arrow down + enter to select first option
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    botState._emit(`  Selected via keyboard`);
    return true;
  }

  botState._emit(`  FAIL: no dropdown options for any search term`);
  return false;
}


// ── Workday button-style dropdown (Select One) ────────────────────────────────
// Used for Yes/No questions — click button → list pops up → click answer
async function fillWorkdayButtonDropdown(page, field, value) {
  const selector = field.selector || `[data-automation-id="${field.automationId}"]`;
  const valLower = String(value).toLowerCase().trim();

  botState._emit(`  BTN-DROPDOWN "${field.label}" → "${value}"`);

  // Click the "Select One" button using JS (avoids pointer event interception)
  const opened = await safeEval(page, (sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return false;
    btn.click();
    return true;
  }, selector) ?? false;

  if (!opened) {
    botState._emit(`  FAIL: button dropdown not found (${selector})`);
    return false;
  }

  await page.waitForTimeout(600);

  // Wait for option list
  const OPTION_SELECTORS = '[data-automation-id="promptOption"], [role="option"], [data-automation-id*="listItem"]';
  try {
    await page.waitForSelector(OPTION_SELECTORS, { timeout: 3000 });
  } catch (_) {
    botState._emit(`  FAIL: no options appeared for "${field.label}"`);
    return false;
  }

  const options = await page.$$(OPTION_SELECTORS);
  const optTexts = [];
  for (const o of options.slice(0, 6)) {
    optTexts.push((await o.innerText().catch(() => '')).trim());
  }
  botState._emit(`  Options: [${optTexts.join(' | ')}]`);

  // Find and click matching option — use JS click to avoid stale handle issues
  const clicked = await page.evaluate((opts, val) => {
    const els = document.querySelectorAll('[data-automation-id="promptOption"], [role="option"], [data-automation-id*="listItem"]');
    const vl = val.toLowerCase().trim();
    // Exact match first
    for (const el of els) {
      if ((el.innerText || '').toLowerCase().trim() === vl) { el.click(); return el.innerText.trim(); }
    }
    // Partial match
    for (const el of els) {
      const t = (el.innerText || '').toLowerCase().trim();
      if (t.includes(vl) || vl.includes(t)) { el.click(); return el.innerText.trim(); }
    }
    return null;
  }, null, valLower);

  if (clicked) {
    await page.waitForTimeout(300);
    botState._emit(`  Selected: "${clicked}"`);
    return true;
  }

  await page.keyboard.press('Escape');
  botState._emit(`  FAIL: no match for "${value}" in [${optTexts.join(', ')}]`);
  return false;
}

async function fillRadio(page, field, value) {
  const radios = await page.$$(`input[name="${field.key}"], input[type="radio"]`);
  const valLower = String(value).toLowerCase();

  for (const radio of radios) {
    const label = await radio.evaluate(el => {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      return lbl ? lbl.innerText.trim() : el.value;
    });
    if (label.toLowerCase().includes(valLower)) {
      await radio.click();
      return true;
    }
  }

  const labels = await page.$$('label');
  for (const lbl of labels) {
    const text = await lbl.innerText().catch(() => '');
    if (text.toLowerCase().includes(valLower)) {
      await lbl.click();
      return true;
    }
  }

  botState._emit(`  RADIO FAIL: "${field.label}" — no match for "${value}"`);
  return false;
}

async function fillCheckbox(page, field, shouldCheck) {
  const selector = field.selector || `[data-automation-id="${field.automationId}"]`;
  const el = await page.$(selector);
  if (!el) {
    botState._emit(`  FILL FAIL: "${field.label}" — checkbox not found (${selector})`);
    return false;
  }

  const isChecked = await el.isChecked();
  if (shouldCheck && !isChecked) await el.click();
  else if (!shouldCheck && isChecked) await el.click();
  return true;
}

async function fillFile(page, field, filePath) {
  const selector = field.selector || '[data-automation-id="file-upload-input-ref"]';
  let el = await page.$(selector);
  if (!el) {
    el = await page.$('input[type="file"]');
  }
  if (!el) {
    botState._emit(`  FILL FAIL: "${field.label}" — file input not found`);
    return false;
  }
  await el.setInputFiles(filePath);
  await page.waitForTimeout(2000);
  return true;
}

async function fillDate(page, field, value) {
  const selector = field.selector || `[data-automation-id="${field.automationId}"]`;
  const el = await page.$(selector);
  if (!el) {
    botState._emit(`  FILL FAIL: "${field.label}" — date input not found (${selector})`);
    return false;
  }

  await el.fill(String(value));
  await page.keyboard.press('Tab');
  return true;
}

async function fillField(page, field, value, resumePath) {
  if (!value || value === '__SKIP__' || value === '__PREFILLED__') return false;

  try {
    switch (field.type) {
      case 'text':
        return await fillText(page, field, value);
      case 'textarea':
        return await fillTextarea(page, field, value);
      case 'select':
        return await fillSelect(page, field, value);
      case 'workday-dropdown':
        return await fillWorkdayDropdown(page, field, value);
      case 'workday-button-dropdown':
        return await fillWorkdayButtonDropdown(page, field, value);
      case 'radio':
        return await fillRadio(page, field, value);
      case 'checkbox': {
        // Default: always tick checkboxes unless explicitly told No/false
        const noValues = ['false', 'no', 'unchecked', 'uncheck', '0'];
        const check = !noValues.includes(String(value).toLowerCase().trim());
        return await fillCheckbox(page, field, check);
      }
      case 'file':
        if (resumePath) return await fillFile(page, field, resumePath);
        return false;
      case 'date':
        return await fillDate(page, field, value);
      default:
        return await fillText(page, field, String(value));
    }
  } catch (err) {
    botState._emit(`  FILL ERROR: "${field.label}" — ${err.message}`);
    console.error(`Error filling ${field.label}:`, err.message);
    return false;
  }
}

async function fillAllFields(page, fields, answers, resumePath) {
  let filledCount = 0;

  for (const field of fields) {
    if (botState.state === 'idle' || botState.state === 'error') break;

    while (botState.state === 'paused') {
      await botState.waitForUnpause();
    }

    const answer = answers[field.key];
    if (answer === '__FILE__' && resumePath) {
      botState.setCurrentField({ label: field.label, answer: 'uploading resume...' });
      const ok = await fillFile(page, field, resumePath);
      if (ok) {
        botState.fieldFilled({ label: field.label, answer: 'Resume uploaded' });
        filledCount++;
      } else {
        botState.fieldFlagged(field, 'File upload failed');
      }
      continue;
    }

    if (!answer || answer === '__SKIP__') {
      if (field.required) {
        botState.fieldFlagged(field, 'No AI answer — fill manually');
        botState._emit(`  NO ANSWER for required: "${field.label}" (key=${field.key})`);
      }
      continue;
    }

    if (answer === '__PREFILLED__') continue;

    botState.setCurrentField({ label: field.label, answer: String(answer).substring(0, 50) });

    let ok = false;
    try {
      ok = await fillField(page, field, answer, resumePath);
    } catch (e) {
      if (e.message && (e.message.includes('navigation') || e.message.includes('context was destroyed') || e.message.includes('Target closed'))) {
        botState._emit(`  Page navigated while filling "${field.label}" — stopping fill loop`);
        break;
      }
      botState._emit(`  Unexpected error filling "${field.label}": ${e.message}`);
    }
    if (ok) {
      botState.fieldFilled({ label: field.label, answer: String(answer).substring(0, 50) });
      filledCount++;
    } else if (ok === false) {
      botState.fieldFlagged(field, `Could not fill — answer was "${String(answer).substring(0, 30)}"`);
    }

    await page.waitForTimeout(200).catch(() => {});
  }

  return filledCount;
}

module.exports = { fillField, fillAllFields, fillFile, fillText, fillSelect, fillWorkdayDropdown, fillWorkdayButtonDropdown, fillRadio, fillTextarea };