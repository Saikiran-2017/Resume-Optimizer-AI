async function scanPage(page) {
  const fields = await page.evaluate(() => {
    const results = [];
    let idx = 0;
    const usedKeys = new Set();

    function getLabel(el) {
      const id = el.id || el.getAttribute('data-automation-id') || '';
      if (id) {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl) return lbl.innerText.trim();
      }
      const parent = el.closest('.css-1x5ork5, .css-j7qwjs, [data-automation-id], .field, .form-group, .form-field');
      if (parent) {
        const lbl = parent.querySelector('label');
        if (lbl) return lbl.innerText.trim();
      }
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') return prev.innerText.trim();

      let container = el.parentElement;
      for (let i = 0; i < 3 && container; i++) {
        const lbl = container.querySelector('label, .label, [class*="label"]');
        if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
        const strong = container.querySelector('strong, b, h3, h4');
        if (strong && strong.innerText.trim().length < 100) return strong.innerText.trim();
        container = container.parentElement;
      }

      return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || id || '';
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function uniqueKey(baseKey) {
      if (!usedKeys.has(baseKey)) {
        usedKeys.add(baseKey);
        return baseKey;
      }
      let i = 2;
      while (usedKeys.has(`${baseKey}_${i}`)) i++;
      const k = `${baseKey}_${i}`;
      usedKeys.add(k);
      return k;
    }

    // Workday section context (to label fields within sections like "Work Experience")
    function getSectionContext(el) {
      const section = el.closest('[data-automation-id*="workExperience"], [data-automation-id*="education"], [data-automation-id*="address"]');
      if (section) {
        const sectionId = section.getAttribute('data-automation-id') || '';
        return sectionId;
      }
      return '';
    }

    // Text inputs
    document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="password"], input:not([type])').forEach(el => {
      if (!isVisible(el) || el.type === 'hidden' || el.type === 'file') return;
      const automationId = el.getAttribute('data-automation-id') || '';
      const baseKey = automationId || el.name || el.id || `text_${idx++}`;
      const section = getSectionContext(el);
      results.push({
        type: 'text',
        key: uniqueKey(baseKey),
        label: getLabel(el),
        selector: automationId ? `[data-automation-id="${automationId}"]` : (el.id ? `#${el.id}` : (el.name ? `input[name="${el.name}"]` : `input[type="${el.type || 'text'}"]`)),
        automationId,
        value: el.value,
        required: el.required || el.getAttribute('aria-required') === 'true',
        placeholder: el.placeholder || '',
        section
      });
    });

    // Reclassify text inputs that are actually Workday typeahead dropdowns.
    // Also detect pre-selected values by checking adjacent ul[role="listbox"].
    results.forEach(field => {
      if (field.type !== 'text') return;
      const aid = field.automationId || '';
      const label = (field.label || '').toLowerCase();

      const typeaheadIds = [
        'source--source',
        'phoneNumber--countryPhoneCode',
        'addressSection--countryRegion',
        'country',
        'countryRegion',
        'countryPhoneCode'
      ];

      const typeaheadLabels = [
        'how did you hear',
        'hear about us',
        'source',
        'country phone code',
        'phone code',
        'state',
        'province',
        'country of residence'
      ];

      const isTypeahead = typeaheadIds.some(id => aid.toLowerCase().includes(id.toLowerCase())) ||
                          typeaheadLabels.some(lbl => label.includes(lbl));

      if (isTypeahead) {
        field.type = 'workday-dropdown';
        field.automationId = field.automationId || aid;
      }
    });

    // Textareas
    document.querySelectorAll('textarea').forEach(el => {
      if (!isVisible(el)) return;
      const automationId = el.getAttribute('data-automation-id') || '';
      const baseKey = automationId || el.name || el.id || `textarea_${idx++}`;
      const section = getSectionContext(el);
      results.push({
        type: 'textarea',
        key: uniqueKey(baseKey),
        label: getLabel(el),
        selector: automationId ? `[data-automation-id="${automationId}"]` : (el.id ? `#${el.id}` : (el.name ? `textarea[name="${el.name}"]` : 'textarea')),
        automationId,
        value: el.value,
        required: el.required || el.getAttribute('aria-required') === 'true',
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        section
      });
    });

    // Native selects (relaxed visibility)
    document.querySelectorAll('select').forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return;
      if (el.options.length <= 1 && el.options[0]?.text.trim() === '') return;
      const automationId = el.getAttribute('data-automation-id') || '';
      const options = Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() }));
      const label = getLabel(el);
      const baseKey = automationId || el.name || el.id || `select_${idx++}`;
      results.push({
        type: 'select',
        key: uniqueKey(baseKey),
        label,
        selector: automationId ? `[data-automation-id="${automationId}"]` : (el.id ? `#${el.id}` : (el.name ? `select[name="${el.name}"]` : `select`)),
        automationId,
        options,
        value: el.value,
        required: el.required || el.getAttribute('aria-required') === 'true'
      });
    });

    // Workday custom dropdowns
    // Skip: selectedItemList (result container), promptOption (option items)
    const SKIP_AIDS = ['selectedItemList', 'promptOption', 'selectedItem', 'pill'];
    document.querySelectorAll('[data-automation-id][role="combobox"], [data-automation-id][role="listbox"], [data-automation-id$="Dropdown"], [data-automation-id$="dropdown"]').forEach(el => {
      if (!isVisible(el)) return;
      const automationId = el.getAttribute('data-automation-id') || '';
      // Skip result/output containers — these show selected items, not for input
      if (SKIP_AIDS.some(skip => automationId.toLowerCase().includes(skip.toLowerCase()))) return;
      // Skip if it's a UL/OL (list of selected items, not an input trigger)
      if (el.tagName === 'UL' || el.tagName === 'OL') return;
      if (results.some(f => f.automationId === automationId)) return;
      const baseKey = automationId || `wd_dropdown_${idx++}`;
      results.push({
        type: 'workday-dropdown',
        key: uniqueKey(baseKey),
        label: getLabel(el),
        automationId,
        currentValue: el.innerText.trim().substring(0, 50),
        required: el.getAttribute('aria-required') === 'true'
      });
    });

    // Radio groups
    const radioGroups = {};
    document.querySelectorAll('input[type="radio"]').forEach(el => {
      if (!isVisible(el)) return;
      const name = el.name || el.getAttribute('data-automation-id') || `radio_${idx++}`;
      if (!radioGroups[name]) {
        radioGroups[name] = {
          type: 'radio',
          key: name,
          label: getLabel(el),
          options: [],
          required: el.required || el.getAttribute('aria-required') === 'true'
        };
      }
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      radioGroups[name].options.push({
        value: el.value,
        text: lbl ? lbl.innerText.trim() : el.value,
        selected: el.checked
      });
    });
    Object.values(radioGroups).forEach(g => {
      g.key = uniqueKey(g.key);
      results.push(g);
    });

    // Checkboxes
    document.querySelectorAll('input[type="checkbox"]').forEach(el => {
      if (!isVisible(el)) return;
      const automationId = el.getAttribute('data-automation-id') || '';
      const baseKey = automationId || el.name || el.id || `checkbox_${idx++}`;
      results.push({
        type: 'checkbox',
        key: uniqueKey(baseKey),
        label: getLabel(el),
        selector: automationId ? `[data-automation-id="${automationId}"]` : (el.id ? `#${el.id}` : (el.name ? `input[name="${el.name}"]` : 'input[type="checkbox"]')),
        automationId,
        checked: el.checked,
        required: el.required
      });
    });

    // File inputs
    document.querySelectorAll('input[type="file"]').forEach(el => {
      const automationId = el.getAttribute('data-automation-id') || '';
      const baseKey = automationId || el.name || el.id || `file_${idx++}`;
      results.push({
        type: 'file',
        key: uniqueKey(baseKey),
        label: getLabel(el) || 'Resume Upload',
        selector: automationId ? `[data-automation-id="${automationId}"]` : (el.id ? `#${el.id}` : 'input[type="file"]'),
        automationId,
        accept: el.accept || '',
        required: el.required
      });
    });

    // Date inputs
    document.querySelectorAll('input[type="date"]').forEach(el => {
      if (!isVisible(el)) return;
      const automationId = el.getAttribute('data-automation-id') || '';
      const baseKey = automationId || el.name || el.id || `date_${idx++}`;
      results.push({
        type: 'date',
        key: uniqueKey(baseKey),
        label: getLabel(el),
        selector: automationId ? `[data-automation-id="${automationId}"]` : (el.id ? `#${el.id}` : (el.name ? `input[name="${el.name}"]` : 'input[type="date"]')),
        automationId,
        value: el.value,
        required: el.required
      });
    });

    return results;
  });

  // Post-scan: detect pre-selected values for Workday typeahead dropdowns
  // These dropdowns show selected items in ul[role="listbox"] near the input,
  // but the input's .value is empty. Check the DOM separately.
  const wdDropdowns = fields.filter(f => f.type === 'workday-dropdown' && !f.value);
  if (wdDropdowns.length > 0) {
    const aids = wdDropdowns.map(f => f.automationId).filter(Boolean);
    const selectedMap = await page.evaluate((aidList) => {
      const result = {};
      for (const aid of aidList) {
        // Find the input element for this field
        const input = document.querySelector(`input[data-automation-id="${aid}"]`);
        if (!input) continue;

        // Walk up from the input to find a UL[role="listbox"] with children
        let parent = input.parentElement;
        for (let depth = 0; depth < 10 && parent; depth++) {
          const uls = parent.querySelectorAll('ul[role="listbox"]');
          for (const ul of uls) {
            if (ul.children.length > 0) {
              const text = (ul.children[0].textContent || '').trim();
              if (text.length > 0) {
                result[aid] = text;
                break;
              }
            }
          }
          if (result[aid]) break;
          parent = parent.parentElement;
        }
      }
      return result;
    }, aids).catch(() => ({}));

    for (const f of wdDropdowns) {
      if (selectedMap[f.automationId]) {
        f.value = selectedMap[f.automationId];
      }
    }
  }

  return fields;
}

// Full page dump — logs EVERYTHING the bot can see
async function fullPageDump(page) {
  return await page.evaluate(() => {
    const dump = { sections: [], allElements: [], pageText: '' };

    // Page visible text
    dump.pageText = document.body ? document.body.innerText.substring(0, 1500) : '';

    // All Workday sections
    document.querySelectorAll('[data-automation-id]').forEach(el => {
      const id = el.getAttribute('data-automation-id');
      const tag = el.tagName.toLowerCase();
      const text = (el.innerText || '').substring(0, 80).replace(/\n/g, ' ');
      if (tag === 'div' || tag === 'section' || tag === 'fieldset') {
        dump.sections.push({ id, tag, text: text.substring(0, 60) });
      }
    });

    // Every form element
    const formEls = document.querySelectorAll('input, textarea, select, [role="combobox"], [role="listbox"], [contenteditable="true"]');
    formEls.forEach(el => {
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden';
      const rect = el.getBoundingClientRect();
      const automationId = el.getAttribute('data-automation-id') || '';

      let label = '';
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) label = lbl.innerText.trim().substring(0, 50);
      }
      if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';

      const info = {
        tag: el.tagName.toLowerCase(),
        type: el.type || el.getAttribute('role') || '',
        name: el.name || '',
        id: el.id || '',
        automationId,
        label: label.substring(0, 50),
        value: (el.value || el.innerText || '').substring(0, 30),
        visible,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        required: el.required || el.getAttribute('aria-required') === 'true'
      };

      if (el.tagName === 'SELECT') {
        info.optionCount = el.options ? el.options.length : 0;
        info.options = Array.from(el.options || []).slice(0, 5).map(o => o.text.trim());
      }

      dump.allElements.push(info);
    });

    // All buttons
    dump.buttons = [];
    document.querySelectorAll('button, input[type="submit"], a[role="button"]').forEach(el => {
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden';
      const automationId = el.getAttribute('data-automation-id') || '';
      dump.buttons.push({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || '').substring(0, 40).replace(/\n/g, ' '),
        automationId,
        visible
      });
    });

    return dump;
  });
}

async function detectNavigation(page) {
  return await page.evaluate(() => {
    const result = { nextButton: null, submitButton: null, backButton: null };

    const wdNext = document.querySelector('[data-automation-id="bottom-navigation-next-button"]');
    if (wdNext) result.nextButton = '[data-automation-id="bottom-navigation-next-button"]';

    const wdSubmit = document.querySelector('[data-automation-id="bottom-navigation-submit-button"]');
    if (wdSubmit) result.submitButton = '[data-automation-id="bottom-navigation-submit-button"]';

    const wdBack = document.querySelector('[data-automation-id="bottom-navigation-previous-button"]');
    if (wdBack) result.backButton = '[data-automation-id="bottom-navigation-previous-button"]';

    if (result.nextButton || result.submitButton) return result;

    function buildSelector(el) {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('data-automation-id')) return `[data-automation-id="${el.getAttribute('data-automation-id')}"]`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\s+/).filter(c => c && !c.startsWith('css-')).slice(0, 2).join('.');
        if (cls) {
          const sel = `${el.tagName.toLowerCase()}.${cls}`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }
      const text = (el.innerText || el.value || '').trim().substring(0, 30);
      return `__TEXT__${text}`;
    }

    const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], a.btn, a[class*="button"], a[class*="btn"]'));
    for (const btn of allBtns) {
      const text = (btn.innerText || btn.value || '').toLowerCase().trim();
      const style = window.getComputedStyle(btn);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      if (!result.submitButton && (text.includes('submit application') || (text.includes('submit') && !text.includes('next')))) {
        result.submitButton = buildSelector(btn);
      }
      if (!result.nextButton && (text === 'next' || text === 'continue' || text === 'save and continue' || text === 'next step' || text === 'proceed' || text === 'save & continue' || text === 'save & next')) {
        result.nextButton = buildSelector(btn);
      }
    }

    return result;
  });
}

async function clickNavButton(page, selector) {
  if (!selector) return false;

  if (selector.startsWith('__TEXT__')) {
    const buttonText = selector.replace('__TEXT__', '');
    return await page.evaluate((target) => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], a.btn, a[class*="button"], a[class*="btn"]'));
      for (const b of btns) {
        const t = (b.innerText || b.value || '').trim();
        if (t.toLowerCase() === target.toLowerCase() || t.toLowerCase().includes(target.toLowerCase())) {
          b.click();
          return true;
        }
      }
      return false;
    }, buttonText);
  }

  try {
    await page.click(selector);
    return true;
  } catch (e) {
    return false;
  }
}

async function clickNextByText(page) {
  return await page.evaluate(() => {
    const keywords = ['continue', 'next', 'next step', 'proceed', 'save and continue', 'save & continue', 'save & next', 'submit'];
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], a.btn, a[class*="button"], a[class*="btn"]'));
    for (const kw of keywords) {
      for (const b of btns) {
        const text = (b.innerText || b.value || '').toLowerCase().trim();
        const style = window.getComputedStyle(b);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (text === kw || text.includes(kw)) {
          b.click();
          return kw;
        }
      }
    }
    return null;
  });
}

async function getPageTitle(page) {
  const title = await page.$eval('[data-automation-id="page-header-title"]', el => el.innerText.trim()).catch(() => null);
  if (title) return title;
  return await page.title();
}

module.exports = { scanPage, detectNavigation, clickNavButton, clickNextByText, getPageTitle, fullPageDump };