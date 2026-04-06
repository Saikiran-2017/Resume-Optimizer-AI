const { botState, STATES } = require('../bot-state');
const { scanPage, detectNavigation, clickNavButton, clickNextByText, fullPageDump } = require('../page-scanner');
const { getFieldAnswers } = require('../field-ai');
const { fillAllFields } = require('../field-filler');

async function handleGeneric({ page, profile, resumePath, jobDescription, companyName, position, generateAIContent, aiProvider, apiKey }) {
  let pageNum = 0;
  const maxPages = 20;

  botState._emit('Generic ATS — using universal form handler');

  while (pageNum < maxPages) {
    if (botState.state === STATES.IDLE || botState.state === STATES.ERROR) break;

    pageNum++;
    botState.scanning(pageNum);

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    botState._emit(`Page ${pageNum} URL: ${currentUrl.substring(0, 80)}...`);

    // Upload resume on first page if file input exists
    if (pageNum <= 2 && resumePath) {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        botState._emit('Uploading resume...');
        await fileInput.setInputFiles(resumePath);
        await page.waitForTimeout(2000);
        botState._emit('Resume uploaded');
      }
    }

    // Scan fields
    const fields = await scanPage(page);
    botState.fields = fields;

    // Log every field that was found
    if (fields.length > 0) {
      botState._emit(`Page ${pageNum}: found ${fields.length} fields:`);
      for (const f of fields) {
        const prefill = f.value ? ` [prefilled: "${f.value.substring(0, 30)}"]` : '';
        botState._emit(`  FIELD: "${f.label}" (${f.type}, key=${f.key})${prefill}`);
      }
    } else {
      botState._emit(`Page ${pageNum}: found 0 fields — page may be informational or already filled`);
      try {
        const dump = await fullPageDump(page);
        botState._emit(`DEBUG — ${dump.allElements.length} form elements, ${dump.buttons.length} buttons`);
        for (const el of dump.allElements) {
          const vis = el.visible ? 'V' : 'H';
          botState._emit(`  ${vis} ${el.tag}[${el.type}] id="${el.automationId || el.id}" label="${el.label}" val="${el.value}"`);
        }
        for (const btn of dump.buttons) {
          botState._emit(`  BTN: "${btn.text}" visible=${btn.visible}`);
        }
        botState._emit(`  TEXT: ${dump.pageText.substring(0, 200).replace(/\n/g, ' | ')}`);
      } catch (_) {}
    }

    if (fields.length > 0) {
      botState.aiThinking();
      botState._emit('Sending fields to AI for answers...');

      const answers = await getFieldAnswers({
        fields, profile, jobDescription, companyName, position,
        generateAIContent, aiProvider, apiKey
      });

      // Log what AI returned
      botState._emit(`AI returned ${Object.keys(answers).length} answers:`);
      for (const [key, val] of Object.entries(answers)) {
        const displayVal = String(val).substring(0, 60);
        botState._emit(`  AI → ${key}: "${displayVal}"`);
      }

      botState.filling();
      const filledCount = await fillAllFields(page, fields, answers, resumePath);
      botState._emit(`Filled ${filledCount} of ${fields.length} fields on page ${pageNum}`);
    }

    // Detect navigation buttons
    const nav = await detectNavigation(page);
    botState._emit(`Navigation: next=${nav.nextButton ? 'YES' : 'NO'}, submit=${nav.submitButton ? 'YES' : 'NO'}`);

    // Submit button found — stop here
    if (nav.submitButton) {
      botState.review(pageNum);
      botState._emit('Submit button detected — review before submitting');
      const confirmResult = await botState.waitForConfirm();
      if (confirmResult === 'stopped') break;

      botState.waitingSubmit();
      botState._emit('Please click Submit in the browser — bot will NOT auto-submit');
      await waitForSubmission(page);
      break;
    }

    // Pause for user review before advancing
    botState.review(pageNum);
    const confirmResult = await botState.waitForConfirm();
    if (confirmResult === 'stopped') break;

    // Try to advance to next page
    const advanced = await advanceToNextPage(page, nav);
    if (!advanced) {
      // Page didn't change — user might need to manually navigate
      botState._emit('Could not auto-advance. If you navigated manually, click Pause then Resume so bot re-reads the page.');

      // Wait for user to pause+resume (which means they navigated manually)
      const waited = await waitForManualNavigation(page, currentUrl);
      if (waited === 'stopped') break;
      if (waited === 'same_page') {
        botState._emit('Page unchanged — bot cannot proceed further');
        break;
      }
      // Page changed — continue the loop
      botState._emit('Page changed — continuing...');
    }
  }

  return { pagesCompleted: pageNum };
}

async function advanceToNextPage(page, nav) {
  const urlBefore = page.url();

  // Try the detected Next button first
  if (nav.nextButton) {
    botState._emit(`Clicking navigation button...`);
    const clicked = await clickNavButton(page, nav.nextButton);
    if (clicked) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      if (page.url() !== urlBefore) return true;
      // URL same but page content might have changed (SPA)
      return true;
    }
  }

  // Fallback: try clicking any Continue/Next button by text
  botState._emit('Trying to find Continue/Next button by text...');
  const clickedText = await clickNextByText(page);
  if (clickedText) {
    botState._emit(`Clicked "${clickedText}" button`);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return true;
  }

  botState._emit('No Continue/Next button found on this page');
  return false;
}

async function waitForManualNavigation(page, originalUrl) {
  botState._emit('Waiting for you to navigate or Pause+Resume...');

  return new Promise((resolve) => {
    let checkCount = 0;
    const maxChecks = 60; // 5 minutes

    const checkInterval = setInterval(async () => {
      checkCount++;

      if (botState.state === STATES.IDLE || botState.state === STATES.ERROR) {
        clearInterval(checkInterval);
        botState.removeListener('update', onUpdate);
        resolve('stopped');
        return;
      }

      // Check if URL changed (user navigated manually)
      try {
        const currentUrl = page.url();
        if (currentUrl !== originalUrl) {
          clearInterval(checkInterval);
          botState.removeListener('update', onUpdate);
          resolve('page_changed');
          return;
        }
      } catch (_) {}

      if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        botState.removeListener('update', onUpdate);
        resolve('same_page');
      }
    }, 5000);

    const onUpdate = (snapshot) => {
      // If user paused and then resumed, treat as "re-scan"
      if (snapshot.state === STATES.SCANNING || snapshot.state === STATES.FILLING) {
        clearInterval(checkInterval);
        botState.removeListener('update', onUpdate);
        resolve('page_changed');
      }
      if (snapshot.state === STATES.IDLE || snapshot.state === STATES.ERROR) {
        clearInterval(checkInterval);
        botState.removeListener('update', onUpdate);
        resolve('stopped');
      }
    };

    botState.on('update', onUpdate);
  });
}

async function waitForSubmission(page) {
  return new Promise((resolve) => {
    let checkInterval;

    const onUpdate = (snapshot) => {
      if (snapshot.state === STATES.IDLE || snapshot.state === STATES.ERROR) {
        clearInterval(checkInterval);
        botState.removeListener('update', onUpdate);
        resolve('stopped');
      }
    };

    botState.on('update', onUpdate);

    checkInterval = setInterval(async () => {
      try {
        const text = await page.textContent('body').catch(() => '');
        const lower = text.toLowerCase();
        if (lower.includes('application submitted') || lower.includes('thank you for applying') || lower.includes('successfully submitted') || lower.includes('thank you for your application')) {
          clearInterval(checkInterval);
          botState.removeListener('update', onUpdate);
          botState.done('Application submitted successfully!');
          resolve('done');
        }
      } catch (_) {}
    }, 3000);

    setTimeout(() => {
      clearInterval(checkInterval);
      botState.removeListener('update', onUpdate);
      resolve('timeout');
    }, 30 * 60 * 1000);
  });
}

module.exports = { handleGeneric };
