// page-reader.js — Reads the entire page and structures it for AI consumption.
// Handles main frame, iframes, Workday overlays/modals.

async function readPage(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);

  let snapshot = await readFrame(page);

  // If no form elements found, check iframes
  const formElementCount = snapshot.elements.filter(e =>
    e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select'
  ).length;

  if (formElementCount === 0) {
    const frames = page.frames();
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;
      try {
        const frameSnapshot = await readFrame(frame);
        const frameFormCount = frameSnapshot.elements.filter(e =>
          e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select'
        ).length;
        if (frameFormCount > 0) {
          snapshot.elements = [...snapshot.elements, ...frameSnapshot.elements.map((e, i) => ({
            ...e, idx: snapshot.elements.length + i, inIframe: true
          }))];
          snapshot.visibleText += '\n--- IFRAME CONTENT ---\n' + frameSnapshot.visibleText;
          snapshot.iframeUrl = frame.url();
          break;
        }
      } catch (_) {}
    }
  }

  // Re-index all elements sequentially
  snapshot.elements.forEach((el, i) => { el.idx = i; });

  return snapshot;
}

async function readFrame(frame) {
  return await frame.evaluate(() => {
    const result = {
      url: window.location.href,
      title: document.title,
      pageHeader: '',
      visibleText: '',
      elements: []
    };

    const headerEl = document.querySelector('[data-automation-id="page-header-title"], h1, h2.page-title');
    if (headerEl) result.pageHeader = headerEl.innerText.trim();
    result.visibleText = (document.body?.innerText || '').substring(0, 3000);

    let elIdx = 0;

    function getLabel(el) {
      const id = el.id || el.getAttribute('data-automation-id') || '';
      if (id) {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl) return lbl.innerText.trim();
      }
      const parent = el.closest('[data-automation-id], .field, .form-group, .form-field, .css-1x5ork5');
      if (parent) {
        const lbl = parent.querySelector('label');
        if (lbl) return lbl.innerText.trim();
      }
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') return prev.innerText.trim();
      let container = el.parentElement;
      for (let i = 0; i < 5 && container; i++) {
        const lbl = container.querySelector('label, .label, [class*="label"]');
        if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
        const heading = container.querySelector('strong, b, h3, h4, legend');
        if (heading && heading.innerText.trim().length < 100) return heading.innerText.trim();
        container = container.parentElement;
      }
      return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || id || '';
    }

    function getVisibility(el) {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none') return 'hidden';
        if (style.visibility === 'hidden') return 'hidden';
        if (style.opacity === '0') return 'hidden';
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return 'zero-size';
        return 'visible';
      } catch (_) { return 'unknown'; }
    }

    function getSection(el) {
      const sec = el.closest('[data-automation-id*="section"], [data-automation-id*="Section"], fieldset, [role="group"]');
      if (sec) {
        const legend = sec.querySelector('legend, h3, h4, [data-automation-id*="header"]');
        return legend ? legend.innerText.trim().substring(0, 50) : (sec.getAttribute('data-automation-id') || '');
      }
      return '';
    }

    function buildSelector(el) {
      const aid = el.getAttribute('data-automation-id');
      if (aid) return `[data-automation-id="${aid}"]`;
      if (el.id) return `#${el.id}`;
      if (el.name && el.tagName) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      return null;
    }

    // ─── FORM ELEMENTS ───
    // Inputs (include checkboxes even if hidden — Workday hides the native input)
    document.querySelectorAll('input').forEach(el => {
      const vis = getVisibility(el);
      const isCheckbox = el.type === 'checkbox' || el.type === 'radio';

      // Skip hidden non-file, non-checkbox inputs
      if (vis === 'hidden' && el.type !== 'file' && !isCheckbox) return;

      // Skip honeypot fields
      const label = getLabel(el);
      if (label.toLowerCase().includes('robot') || label.toLowerCase().includes('honeypot')) return;

      result.elements.push({
        idx: elIdx++,
        tag: 'input',
        type: el.type || 'text',
        name: el.name || '',
        id: el.id || '',
        automationId: el.getAttribute('data-automation-id') || '',
        label: label,
        value: el.value || '',
        placeholder: el.placeholder || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
        checked: isCheckbox ? el.checked : undefined,
        visibility: vis,
        section: getSection(el),
        selector: buildSelector(el)
      });
    });

    // Textareas
    document.querySelectorAll('textarea').forEach(el => {
      if (getVisibility(el) === 'hidden') return;
      result.elements.push({
        idx: elIdx++,
        tag: 'textarea',
        type: 'textarea',
        name: el.name || '',
        id: el.id || '',
        automationId: el.getAttribute('data-automation-id') || '',
        label: getLabel(el),
        value: el.value || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        visibility: 'visible',
        section: getSection(el),
        selector: buildSelector(el)
      });
    });

    // Selects
    document.querySelectorAll('select').forEach(el => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return;
      const options = Array.from(el.options).map(o => o.text.trim());
      result.elements.push({
        idx: elIdx++,
        tag: 'select',
        type: 'select',
        name: el.name || '',
        id: el.id || '',
        automationId: el.getAttribute('data-automation-id') || '',
        label: getLabel(el),
        value: el.options[el.selectedIndex]?.text.trim() || '',
        options,
        required: el.required || el.getAttribute('aria-required') === 'true',
        visibility: 'visible',
        section: getSection(el),
        selector: buildSelector(el)
      });
    });

    // Custom checkboxes (Workday uses div[role="checkbox"])
    document.querySelectorAll('[role="checkbox"]').forEach(el => {
      if (getVisibility(el) === 'hidden') return;
      const aid = el.getAttribute('data-automation-id') || '';
      if (result.elements.some(e => e.automationId === aid && aid)) return;
      const isChecked = el.getAttribute('aria-checked') === 'true';
      result.elements.push({
        idx: elIdx++,
        tag: 'div',
        type: 'checkbox',
        automationId: aid,
        label: getLabel(el),
        checked: isChecked,
        required: el.getAttribute('aria-required') === 'true',
        visibility: 'visible',
        section: getSection(el),
        selector: aid ? `[data-automation-id="${aid}"]` : `[role="checkbox"]`
      });
    });

    // Workday custom dropdowns (combobox/listbox)
    document.querySelectorAll('[role="combobox"], [role="listbox"], [data-automation-id$="Dropdown"], [data-automation-id$="dropdown"]').forEach(el => {
      if (getVisibility(el) === 'hidden') return;
      const aid = el.getAttribute('data-automation-id') || '';
      if (result.elements.some(e => e.automationId === aid && aid)) return;
      result.elements.push({
        idx: elIdx++,
        tag: 'div',
        type: 'workday-dropdown',
        automationId: aid,
        label: getLabel(el),
        value: el.innerText.trim().substring(0, 50),
        required: el.getAttribute('aria-required') === 'true',
        visibility: 'visible',
        section: getSection(el),
        selector: aid ? `[data-automation-id="${aid}"]` : null
      });
    });

    // Workday button-style dropdowns ("Select One" buttons with a question label)
    document.querySelectorAll('button').forEach(el => {
      const text = (el.innerText || '').trim();
      if (text !== 'Select One' && text !== 'Select one') return;
      if (getVisibility(el) === 'hidden') return;

      // Already captured?
      const aid = el.getAttribute('data-automation-id') || '';
      if (result.elements.some(e => e.selector === buildSelector(el))) return;

      // Find the question label from parent container
      let questionLabel = '';
      let container = el.parentElement;
      for (let i = 0; i < 6 && container; i++) {
        const lbl = container.querySelector('label, legend, h3, h4, [data-automation-id*="label"]');
        if (lbl) {
          questionLabel = lbl.innerText.trim();
          break;
        }
        const dataAid = container.getAttribute('data-automation-id');
        if (dataAid && (dataAid.includes('formField') || dataAid.includes('question'))) {
          const txt = container.querySelector('label, legend, [data-automation-id*="label"]');
          if (txt) { questionLabel = txt.innerText.trim(); break; }
        }
        container = container.parentElement;
      }

      if (!questionLabel) {
        // Try previous sibling text
        let prev = el.previousElementSibling;
        if (prev && prev.innerText) questionLabel = prev.innerText.trim().substring(0, 80);
      }

      result.elements.push({
        idx: elIdx++,
        tag: 'button',
        type: 'workday-button-dropdown',
        automationId: aid,
        label: questionLabel || 'Unknown question',
        value: 'Select One',
        required: true,
        visibility: 'visible',
        section: getSection(el),
        selector: buildSelector(el)
      });
    });

    // ─── CLICKABLE ELEMENTS (buttons, links) ───
    // Filter out noise: error buttons, "Select One", "Forgot password", privacy policy
    const noisePatterns = [
      /^error/i, /^errors found/i, /^select one$/i,
      /forgot.*password/i, /privacy policy/i,
      /^skip to/i, /^search for jobs$/i
    ];

    document.querySelectorAll('button, a[role="button"], input[type="submit"], a[href]').forEach(el => {
      if (getVisibility(el) === 'hidden') return;
      const text = (el.innerText || el.value || '').trim();
      if (!text || text.length > 100) return;

      // Skip noise elements
      if (noisePatterns.some(p => p.test(text))) return;

      const aid = el.getAttribute('data-automation-id') || '';
      const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
      result.elements.push({
        idx: elIdx++,
        tag: el.tagName.toLowerCase(),
        type: el.type === 'submit' ? 'submit-button' : (el.tagName === 'BUTTON' ? 'button' : 'link'),
        text: text.substring(0, 60),
        automationId: aid,
        href: href.substring(0, 80),
        visibility: 'visible',
        selector: buildSelector(el)
      });
    });

    return result;
  }).catch(() => ({
    url: '', title: '', pageHeader: '', visibleText: '', elements: []
  }));
}

function formatPageForAI(snapshot) {
  let out = `PAGE URL: ${snapshot.url}\n`;
  out += `PAGE TITLE: ${snapshot.title}\n`;
  if (snapshot.pageHeader) out += `PAGE HEADER: ${snapshot.pageHeader}\n`;
  if (snapshot.iframeUrl) out += `IFRAME URL: ${snapshot.iframeUrl}\n`;

  const formEls = snapshot.elements.filter(e =>
    e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select' ||
    e.type === 'workday-dropdown' || e.type === 'checkbox' || e.type === 'workday-button-dropdown'
  );
  const clickEls = snapshot.elements.filter(e =>
    e.type === 'button' || e.type === 'submit-button' || e.type === 'link'
  );

  out += `\n--- FORM FIELDS (${formEls.length}) ---\n`;
  if (formEls.length === 0) {
    out += '(No form fields found on this page)\n';
  }
  for (const el of formEls) {
    out += `[${el.idx}] ${el.tag.toUpperCase()}[${el.type}]: label="${el.label}"`;
    if (el.required) out += ' (REQUIRED)';
    if (el.checked !== undefined) out += el.checked ? ' [CHECKED]' : ' [UNCHECKED]';
    if (el.value && el.type !== 'workday-button-dropdown') out += ` value="${el.value.substring(0, 40)}"`;
    if (el.type === 'workday-button-dropdown') out += ' → CLICK to open dropdown, then select answer';
    if (el.options) out += ` options=[${el.options.slice(0, 8).join(', ')}]`;
    if (el.placeholder) out += ` placeholder="${el.placeholder}"`;
    if (el.section) out += ` section="${el.section}"`;
    out += '\n';
  }

  out += `\n--- BUTTONS & LINKS (${clickEls.length}) ---\n`;
  for (const el of clickEls) {
    out += `[${el.idx}] ${el.type.toUpperCase()}: "${el.text}"`;
    if (el.automationId) out += ` aid="${el.automationId}"`;
    out += '\n';
  }

  out += '\n--- PAGE TEXT (first 800 chars) ---\n';
  out += snapshot.visibleText.substring(0, 800);

  return out;
}

module.exports = { readPage, formatPageForAI };
