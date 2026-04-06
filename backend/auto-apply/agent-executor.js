// agent-executor.js — Executes AI-generated actions on the page.

const { botState } = require('./bot-state');
const TYPING_DELAY = parseInt(process.env.BOT_TYPING_DELAY_MS) || 30;

async function executeActions(page, actions, pageSnapshot, resumePath) {
  const results = [];

  for (const action of actions) {
    if (botState.state === 'idle' || botState.state === 'error') break;

    // Check if browser is still alive
    try { await page.evaluate(() => true); } catch (_) {
      botState._emit('Browser closed — stopping actions');
      break;
    }

    while (botState.state === 'paused') {
      botState._emit('Paused — waiting to resume...');
      await botState.waitForUnpause();
      botState._emit('Resumed — continuing actions');
    }

    const result = await executeAction(page, action, pageSnapshot, resumePath);
    results.push(result);

    const valStr = action.value ? '"' + String(action.value).substring(0, 40) + '"' : action.action;
    botState._emit(`${result.success ? 'OK' : 'FAIL'}: ${action.action} [${action.elementIdx}] "${action.label || ''}" → ${valStr}`);

    if (result.success && ['type', 'select', 'upload', 'typeAndSelect', 'clickAndSelect', 'check'].includes(action.action)) {
      botState.fieldFilled({ label: action.label || `element[${action.elementIdx}]`, answer: String(action.value || '').substring(0, 50) });
    } else if (!result.success && action.action !== 'click') {
      botState.fieldFlagged({ label: action.label || `element[${action.elementIdx}]` }, result.error || 'Action failed');
    }

    try { await page.waitForTimeout(200); } catch (_) { break; }
  }

  return results;
}

async function executeAction(page, action, pageSnapshot, resumePath) {
  try {
    const element = pageSnapshot.elements.find(e => e.idx === action.elementIdx);
    if (!element && !['wait', 'scroll'].includes(action.action)) {
      return { success: false, error: `Element [${action.elementIdx}] not found in snapshot` };
    }

    const selector = resolveSelector(element, action);

    // typeAndSelect: Workday typeahead dropdowns (type text → wait for dropdown → select option)
    if (action.action === 'typeAndSelect') {
      return await doTypeAndSelect(page, selector, element, action);
    }

    // clickAndSelect: Workday button dropdowns (click "Select One" → pick option from popup)
    if (action.action === 'clickAndSelect') {
      return await doClickAndSelect(page, selector, element, action);
    }

    if (!selector && !['click', 'check', 'wait', 'scroll'].includes(action.action)) {
      if (element && (action.action === 'type' || action.action === 'select')) {
        const fallbackResult = await fillByLabel(page, element, action);
        if (fallbackResult) return fallbackResult;
      }
      return { success: false, error: `No selector for element [${action.elementIdx}]` };
    }

    switch (action.action) {
      case 'type':
        return await doType(page, selector, element, String(action.value));
      case 'select':
        return await doSelect(page, selector, element, String(action.value));
      case 'click':
        return await doClick(page, selector, element, action);
      case 'upload':
        return await doUpload(page, selector, resumePath);
      case 'check': {
        // Wrap in timeout to prevent hanging — checkbox must not block Create Account click
        const checkPromise = doCheck(page, selector, element, action.value);
        const timeoutPromise = new Promise(resolve =>
          setTimeout(() => resolve({ success: false, error: 'Check timed out after 8s' }), 8000)
        );
        return await Promise.race([checkPromise, timeoutPromise]);
      }
      case 'wait':
        await page.waitForTimeout(action.value || 2000);
        return { success: true };
      case 'scroll':
        await page.evaluate(() => window.scrollBy(0, 400));
        return { success: true };
      default:
        return { success: false, error: `Unknown action: ${action.action}` };
    }
  } catch (err) {
    return { success: false, error: err.message.substring(0, 150) };
  }
}

function resolveSelector(element, action) {
  if (!element) return null;
  if (element.selector) return element.selector;
  if (element.automationId) return `[data-automation-id="${element.automationId}"]`;
  if (element.id) return `#${element.id}`;
  if (element.name && element.tag) return `${element.tag}[name="${element.name}"]`;
  if (['button', 'submit-button', 'link'].includes(element.type)) return null;
  return null;
}

async function doType(page, selector, element, value) {
  const el = await page.$(selector);
  if (!el) return { success: false, error: `Element not found: ${selector}` };

  const current = await el.inputValue().catch(() => '');
  if (current && current.trim() !== '') {
    return { success: true, skipped: true, note: `Pre-filled: "${current.substring(0, 30)}"` };
  }

  await el.fill('');
  const delay = element.tag === 'textarea' ? Math.min(TYPING_DELAY, 15) : TYPING_DELAY;
  await el.type(value, { delay });
  return { success: true };
}

async function doSelect(page, selector, element, value) {
  const el = await page.$(selector);
  if (!el) return { success: false, error: `Select not found: ${selector}` };

  const tag = await el.evaluate(e => e.tagName.toLowerCase());

  if (tag === 'select') {
    const options = await el.$$eval('option', opts => opts.map(o => ({ value: o.value, text: o.text.trim() })));
    const valLower = value.toLowerCase();
    const match = options.find(o => o.text.toLowerCase() === valLower)
      || options.find(o => o.value.toLowerCase() === valLower)
      || options.find(o => o.text.toLowerCase().includes(valLower))
      || options.find(o => valLower.includes(o.text.toLowerCase()) && o.text !== '' && o.text.toLowerCase() !== 'select one');

    if (!match) return { success: false, error: `No match for "${value}" in [${options.map(o => o.text).join(', ')}]` };

    await el.selectOption(match.value);
    await el.evaluate(s => {
      s.dispatchEvent(new Event('change', { bubbles: true }));
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    return { success: true, matched: match.text };
  }

  // Workday custom dropdown — click to open, search, select
  await el.click();
  await page.waitForTimeout(500);

  const searchInput = await page.$('[data-automation-id="searchBox"], input[role="combobox"]');
  if (searchInput) {
    await searchInput.type(value.substring(0, 5), { delay: 50 });
    await page.waitForTimeout(800);
  }

  try {
    await page.waitForSelector('[data-automation-id="promptOption"], [role="option"]', { timeout: 3000 });
  } catch (_) {}

  const optEls = await page.$$('[data-automation-id="promptOption"], [role="option"]');
  for (const opt of optEls) {
    const text = await opt.innerText().catch(() => '');
    if (text.toLowerCase().trim() === value.toLowerCase().trim() || text.toLowerCase().includes(value.toLowerCase())) {
      await opt.click();
      await page.waitForTimeout(300);
      return { success: true, matched: text.trim() };
    }
  }

  await page.keyboard.press('Escape');
  return { success: false, error: `No dropdown match for "${value}"` };
}

/**
 * Workday typeahead/search dropdown: type text into a field, wait for dropdown
 * options to appear, then select the right one.
 * Used for "How did you hear about this position?" and similar fields.
 */
async function doTypeAndSelect(page, selector, element, action) {
  const typeValue = String(action.value || '');
  const selectText = String(action.selectText || action.value || '');

  // 1. Find the input element — try multiple approaches
  let inputEl = null;
  if (selector) {
    inputEl = await page.$(selector);
  }

  // If the selector points to a non-input (e.g. a container), look for input inside
  if (inputEl) {
    const tagName = await inputEl.evaluate(e => e.tagName.toLowerCase());
    if (!['input', 'textarea'].includes(tagName)) {
      const childInput = await inputEl.$('input, textarea, [contenteditable="true"]');
      if (childInput) inputEl = childInput;
    }
  }

  // Try common Workday selectors for typeahead fields
  if (!inputEl) {
    const typeaheadSelectors = [
      'input[role="combobox"]',
      '[data-automation-id="searchBox"]',
      `input[aria-label*="${(element.label || '').substring(0, 20)}"]`,
    ];
    for (const s of typeaheadSelectors) {
      inputEl = await page.$(s).catch(() => null);
      if (inputEl) break;
    }
  }

  // Try label-based lookup
  if (!inputEl && element) {
    inputEl = await findInputByLabel(page, element.label || action.label || '');
  }

  if (!inputEl) {
    // Click on the element area to activate the field first
    if (element && element.text) {
      try {
        await page.evaluate((text) => {
          const els = document.querySelectorAll('label, div, span, button');
          for (const el of els) {
            if ((el.innerText || '').toLowerCase().includes(text.toLowerCase())) {
              el.click();
              return true;
            }
          }
          return false;
        }, element.label || element.text);
        await page.waitForTimeout(500);
        // After clicking, look for newly focused input
        inputEl = await page.$(':focus');
        const focusedTag = inputEl ? await inputEl.evaluate(e => e.tagName.toLowerCase()) : '';
        if (!['input', 'textarea'].includes(focusedTag)) inputEl = null;
      } catch (_) {}
    }
  }

  if (!inputEl) {
    return { success: false, error: `No input found for typeAndSelect on [${action.elementIdx}]` };
  }

  // 2. Clear existing text and type the search value
  try {
    await inputEl.click();
    await page.waitForTimeout(300);
    await inputEl.fill('');
  } catch (_) {
    try { await inputEl.click({ clickCount: 3 }); } catch (__) {}
  }

  await inputEl.type(typeValue, { delay: 80 });
  botState._emit(`  TypeAndSelect: typed "${typeValue}", waiting for dropdown...`);

  // 3. Wait for dropdown options
  await page.waitForTimeout(1500);

  // Press Enter to trigger dropdown (some Workday fields need this)
  await inputEl.press('Enter');
  await page.waitForTimeout(1000);

  // 4. Look for dropdown options
  const dropdownSelectors = [
    '[data-automation-id="promptOption"]',
    '[role="option"]',
    '[role="listbox"] [role="option"]',
    '.css-1dbjc4n [role="option"]',
    '[data-automation-id="selectWidget"] [role="option"]',
    'ul[role="listbox"] li',
    '.wd-popup li',
  ];

  let selectedText = null;
  for (const ds of dropdownSelectors) {
    const optEls = await page.$$(ds);
    if (optEls.length === 0) continue;

    botState._emit(`  Found ${optEls.length} dropdown options`);

    // Try to find exact or partial match for selectText
    const selectLower = selectText.toLowerCase().trim();
    for (const opt of optEls) {
      const text = await opt.innerText().catch(() => '');
      const textLower = text.toLowerCase().trim();
      if (textLower === selectLower || textLower.includes(selectLower) || selectLower.includes(textLower)) {
        await opt.click();
        selectedText = text.trim();
        botState._emit(`  Selected: "${selectedText}"`);
        await page.waitForTimeout(500);
        return { success: true, matched: selectedText };
      }
    }

    // No exact match — try first option if only a few
    if (optEls.length <= 5) {
      const firstText = await optEls[0].innerText().catch(() => '');
      botState._emit(`  No exact match for "${selectText}", trying first: "${firstText.substring(0, 40)}"`);
      await optEls[0].click();
      await page.waitForTimeout(500);
      return { success: true, matched: firstText.trim(), note: 'first-option-fallback' };
    }

    break;
  }

  // 5. If no dropdown appeared, try typing "Other" as fallback
  if (!selectedText && selectText.toLowerCase() !== 'other') {
    botState._emit('  No dropdown found, trying "Other" fallback...');
    try {
      await inputEl.click({ clickCount: 3 });
      await page.waitForTimeout(200);
      await inputEl.type('Other', { delay: 80 });
      await page.waitForTimeout(1000);
      await inputEl.press('Enter');
      await page.waitForTimeout(1000);

      for (const ds of dropdownSelectors) {
        const optEls = await page.$$(ds);
        for (const opt of optEls) {
          const text = await opt.innerText().catch(() => '');
          if (text.toLowerCase().includes('other')) {
            await opt.click();
            await page.waitForTimeout(500);
            return { success: true, matched: text.trim(), note: 'fallback-to-other' };
          }
        }
      }
    } catch (_) {}
  }

  // 6. Last resort — press Escape to close any open dropdown
  await page.keyboard.press('Escape');
  return { success: false, error: `typeAndSelect: dropdown not found for "${typeValue}"` };
}

/**
 * Workday button-style dropdown: click "Select One" button → dropdown popup appears → select option.
 * Used for yes/no questions, multi-choice, etc.
 */
async function doClickAndSelect(page, selector, element, action) {
  const answerValue = String(action.value || '').trim();
  if (!answerValue) return { success: false, error: 'No value for clickAndSelect' };

  // 1. Click the "Select One" button to open the dropdown
  let clicked = false;
  if (selector) {
    try {
      await page.click(selector);
      clicked = true;
    } catch (_) {}
  }

  if (!clicked && element) {
    // Try clicking by finding the button near the question label
    try {
      clicked = await page.evaluate((label) => {
        const containers = document.querySelectorAll('[data-automation-id*="formField"], [data-automation-id*="question"], fieldset, [role="group"]');
        for (const c of containers) {
          const lbl = c.querySelector('label, legend, h3, h4');
          if (!lbl || !lbl.innerText.toLowerCase().includes(label.toLowerCase())) continue;
          const btn = c.querySelector('button');
          if (btn) { btn.click(); return true; }
        }
        return false;
      }, element.label || action.label || '');
    } catch (_) {}
  }

  if (!clicked) {
    return { success: false, error: `Could not click dropdown for "${element?.label}"` };
  }

  botState._emit(`  Opened dropdown for "${element?.label || action.label}", looking for "${answerValue}"...`);
  await page.waitForTimeout(1000);

  // 2. Wait for dropdown options to appear
  const optionSelectors = [
    '[data-automation-id="promptOption"]',
    '[role="option"]',
    '[role="listbox"] [role="option"]',
    '[data-automation-id="selectWidget"] [role="option"]',
    'ul[role="listbox"] li',
    '.wd-popup li',
  ];

  for (const os of optionSelectors) {
    try {
      await page.waitForSelector(os, { timeout: 2000 });
    } catch (_) { continue; }

    const optEls = await page.$$(os);
    if (optEls.length === 0) continue;

    botState._emit(`  Found ${optEls.length} options`);
    const answerLower = answerValue.toLowerCase();

    // Exact match first
    for (const opt of optEls) {
      const text = await opt.innerText().catch(() => '');
      if (text.toLowerCase().trim() === answerLower) {
        await opt.click();
        await page.waitForTimeout(500);
        return { success: true, matched: text.trim() };
      }
    }

    // Partial match
    for (const opt of optEls) {
      const text = await opt.innerText().catch(() => '');
      if (text.toLowerCase().includes(answerLower) || answerLower.includes(text.toLowerCase().trim())) {
        await opt.click();
        await page.waitForTimeout(500);
        return { success: true, matched: text.trim() };
      }
    }

    // If "Yes"/"No" → try matching by first character
    if (answerLower === 'yes' || answerLower === 'no') {
      for (const opt of optEls) {
        const text = (await opt.innerText().catch(() => '')).trim();
        if (text.toLowerCase().startsWith(answerLower.charAt(0)) && text.length < 10) {
          await opt.click();
          await page.waitForTimeout(500);
          return { success: true, matched: text };
        }
      }
    }

    // Log available options for debugging
    const availableOpts = [];
    for (const opt of optEls) {
      availableOpts.push(await opt.innerText().catch(() => '?'));
    }
    botState._emit(`  Available: [${availableOpts.map(o => o.trim()).join(', ')}]`);
    break;
  }

  // Close dropdown if nothing matched
  await page.keyboard.press('Escape');
  return { success: false, error: `No option "${answerValue}" in dropdown for "${element?.label}"` };
}

async function doClick(page, selector, element, action) {
  if (selector) {
    try {
      await page.click(selector);
      await page.waitForTimeout(500);
      return { success: true };
    } catch (_) {}
  }

  if (element && element.text) {
    const clicked = await page.evaluate((targetText) => {
      const els = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
      for (const el of els) {
        const text = (el.innerText || el.value || '').trim();
        if (text.toLowerCase().includes(targetText.toLowerCase())) {
          el.click();
          return true;
        }
      }
      return false;
    }, element.text);

    if (clicked) {
      await page.waitForTimeout(500);
      return { success: true, clickedByText: element.text };
    }
  }

  return { success: false, error: 'Could not click element' };
}

async function doUpload(page, selector, resumePath) {
  if (!resumePath) return { success: false, error: 'No resume file available' };
  let el = selector ? await page.$(selector) : null;
  if (!el) el = await page.$('[data-automation-id="file-upload-input-ref"]');
  if (!el) el = await page.$('input[type="file"]');
  if (!el) return { success: false, error: 'File input not found' };
  await el.setInputFiles(resumePath);
  await page.waitForTimeout(2000);
  return { success: true };
}

async function doCheck(page, selector, element, shouldCheck) {
  const check = shouldCheck === true || shouldCheck === 'true' || shouldCheck === 'Yes';
  const labelText = element?.label || '';

  // Strategy 1: Playwright check/uncheck with force (safest — no side effects)
  if (selector) {
    try {
      if (check) {
        await page.check(selector, { force: true, timeout: 3000 });
      } else {
        await page.uncheck(selector, { force: true, timeout: 3000 });
      }
      await page.waitForTimeout(300);
      botState._emit(`  Checked via playwright check()`);
      return { success: true, method: 'playwright-check' };
    } catch (_) {}
  }

  // Strategy 2: Force-click the hidden input directly
  if (selector) {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.click({ force: true });
        await page.waitForTimeout(300);
        botState._emit(`  Checked via force-click input`);
        return { success: true, method: 'force-click' };
      }
    } catch (_) {}
  }

  // Strategy 3: Find checkbox by label and use JS to toggle it
  try {
    const toggled = await page.evaluate(({ labelText, shouldCheck }) => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
      for (const cb of checkboxes) {
        let container = cb.parentElement;
        for (let i = 0; i < 6 && container; i++) {
          const text = (container.innerText || '').toLowerCase();
          if (text.includes(labelText.substring(0, 30).toLowerCase())) {
            if (cb.tagName === 'INPUT') {
              cb.checked = shouldCheck;
              cb.dispatchEvent(new Event('change', { bubbles: true }));
              cb.dispatchEvent(new Event('click', { bubbles: true }));
              return 'js-toggle';
            } else {
              cb.click();
              return 'custom-click';
            }
          }
          container = container.parentElement;
        }
      }
      return null;
    }, { labelText, shouldCheck: check });

    if (toggled) {
      await page.waitForTimeout(300);
      botState._emit(`  Checked via ${toggled}`);
      return { success: true, method: toggled };
    }
  } catch (_) {}

  // Strategy 4: Click the label[for] element
  try {
    const clicked = await page.evaluate((labelText) => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      for (const cb of checkboxes) {
        if (!cb.id) continue;
        const lbl = document.querySelector(`label[for="${cb.id}"]`);
        if (lbl && lbl.innerText.toLowerCase().includes(labelText.substring(0, 30).toLowerCase())) {
          lbl.click();
          return true;
        }
      }
      return false;
    }, labelText);

    if (clicked) {
      await page.waitForTimeout(300);
      botState._emit(`  Checked via label[for]`);
      return { success: true, method: 'label-for' };
    }
  } catch (_) {}

  // Strategy 5: Click the checkbox's parent label or container (not the terms text itself)
  try {
    const clicked = await page.evaluate((labelSnippet) => {
      const checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
      for (const cb of checkboxes) {
        // Check if this checkbox is near the matching label text
        const parent = cb.closest('label, div, span, li');
        if (!parent) continue;
        const parentText = (parent.innerText || '').toLowerCase();
        if (!parentText.includes(labelSnippet.toLowerCase())) continue;

        // Click the checkbox's immediate parent label, or the checkbox itself
        const label = cb.closest('label');
        if (label) { label.click(); return 'parent-label'; }
        cb.click();
        return 'checkbox-direct';
      }

      // Fallback: find any clickable element right before/after a checkbox
      for (const cb of checkboxes) {
        const prev = cb.previousElementSibling;
        const next = cb.nextElementSibling;
        if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN')) {
          if ((prev.innerText || '').toLowerCase().includes(labelSnippet.toLowerCase())) {
            prev.click(); return 'sibling';
          }
        }
        if (next && (next.tagName === 'LABEL' || next.tagName === 'SPAN')) {
          if ((next.innerText || '').toLowerCase().includes(labelSnippet.toLowerCase())) {
            next.click(); return 'sibling';
          }
        }
      }
      return null;
    }, labelText.substring(0, 30));

    if (clicked) {
      await page.waitForTimeout(300);
      botState._emit(`  Checked via ${clicked}`);
      return { success: true, method: clicked };
    }
  } catch (_) {}

  // Strategy 6: Playwright locator force-click the checkbox input
  try {
    const cbLocator = page.locator('input[type="checkbox"]').first();
    if (await cbLocator.count() > 0) {
      await cbLocator.click({ force: true, timeout: 3000 });
      await page.waitForTimeout(300);
      botState._emit(`  Checked via locator force-click`);
      return { success: true, method: 'locator-force' };
    }
  } catch (_) {}

  // Strategy 7: Click the label at its LEFT edge (checkbox icon area, avoids link text)
  if (labelText) {
    try {
      const labelEl = await page.evaluateHandle((snippet) => {
        const labels = document.querySelectorAll('label');
        for (const lbl of labels) {
          if (lbl.innerText.toLowerCase().includes(snippet.toLowerCase())) return lbl;
        }
        return null;
      }, labelText.substring(0, 25));

      if (labelEl && !(await labelEl.evaluate(e => !e).catch(() => true))) {
        // Click at position (5, 5) from label's top-left — this hits the checkbox icon, not the link
        await labelEl.click({ position: { x: 5, y: 5 }, timeout: 3000 });
        await page.waitForTimeout(500);
        botState._emit(`  Checked via label position click`);
        return { success: true, method: 'label-position' };
      }
    } catch (_) {}
  }

  // Strategy 8: Last resort — use Playwright getByLabel
  if (labelText) {
    try {
      const loc = page.getByLabel(labelText.substring(0, 30), { exact: false });
      if (await loc.count() > 0) {
        await loc.check({ force: true, timeout: 3000 });
        await page.waitForTimeout(300);
        botState._emit(`  Checked via getByLabel`);
        return { success: true, method: 'getByLabel' };
      }
    } catch (_) {}
  }

  return { success: false, error: `Could not check: "${labelText}"` };
}

async function findInputByLabel(page, labelText) {
  if (!labelText) return null;
  try {
    return await page.evaluateHandle((label) => {
      const labels = Array.from(document.querySelectorAll('label'));
      for (const lbl of labels) {
        if (!lbl.innerText.toLowerCase().includes(label.toLowerCase())) continue;
        const forId = lbl.getAttribute('for');
        let input = forId ? document.getElementById(forId) : null;
        if (!input) input = lbl.querySelector('input, textarea, select');
        if (!input) {
          const parent = lbl.closest('.form-group, .field, [data-automation-id]');
          if (parent) input = parent.querySelector('input, textarea, select');
        }
        if (input) return input;
      }
      return null;
    }, labelText);
  } catch (_) {
    return null;
  }
}

async function fillByLabel(page, element, action) {
  const label = element.label || action.label || '';
  if (!label) return null;

  try {
    const result = await page.evaluate(({ label, value, actionType }) => {
      const labels = Array.from(document.querySelectorAll('label'));
      for (const lbl of labels) {
        if (!lbl.innerText.toLowerCase().includes(label.toLowerCase())) continue;
        const forId = lbl.getAttribute('for');
        let input = forId ? document.getElementById(forId) : null;
        if (!input) input = lbl.querySelector('input, textarea, select');
        if (!input) {
          const parent = lbl.closest('.form-group, .field, [data-automation-id]');
          if (parent) input = parent.querySelector('input, textarea, select');
        }
        if (!input) continue;

        if (actionType === 'type' && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, method: 'label-lookup' };
        }
        if (actionType === 'select' && input.tagName === 'SELECT') {
          const opt = Array.from(input.options).find(o => o.text.toLowerCase().includes(value.toLowerCase()));
          if (opt) {
            input.value = opt.value;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true, method: 'label-lookup', matched: opt.text };
          }
        }
      }
      return null;
    }, { label, value: action.value, actionType: action.action });

    return result;
  } catch (_) {
    return null;
  }
}

module.exports = { executeActions };
