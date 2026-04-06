const { botState, STATES } = require('../bot-state');
const { scanPage, detectNavigation } = require('../page-scanner');
const { getFieldAnswers } = require('../field-ai');
const { fillAllFields, fillFile } = require('../field-filler');

async function handleGreenhouse({ page, profile, resumePath, jobDescription, companyName, position, generateAIContent, aiProvider, apiKey }) {
  botState.scanning(1);
  botState._emit('Greenhouse application detected');

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // Upload resume first if file input exists
  if (resumePath) {
    const fileInput = await page.$('#resume_file, input[type="file"], [data-field="resume"]');
    if (fileInput) {
      botState._emit('Uploading resume...');
      await fileInput.setInputFiles(resumePath);
      await page.waitForTimeout(2000);
      botState._emit('Resume uploaded');
    }
  }

  // Fill basic known fields directly
  await fillBasicGreenhouseFields(page, profile);

  // Scan remaining fields
  const fields = await scanPage(page);
  botState.fields = fields;
  botState._emit(`Found ${fields.length} fields:`);
  for (const f of fields) {
    const prefill = f.value ? ` [prefilled: "${f.value.substring(0, 30)}"]` : '';
    botState._emit(`  FIELD: "${f.label}" (${f.type}, key=${f.key})${prefill}`);
  }

  if (fields.length > 0) {
    botState.aiThinking();
    botState._emit('Sending fields to AI...');
    const answers = await getFieldAnswers({
      fields, profile, jobDescription, companyName, position,
      generateAIContent, aiProvider, apiKey
    });
    botState._emit(`AI returned ${Object.keys(answers).length} answers:`);
    for (const [key, val] of Object.entries(answers)) {
      botState._emit(`  AI → ${key}: "${String(val).substring(0, 60)}"`);
    }

    botState.filling();
    const filledCount = await fillAllFields(page, fields, answers, resumePath);
    botState._emit(`Filled ${filledCount}/${fields.length} fields`);
  }

  // Pause for review
  botState.review(1);
  const result = await botState.waitForConfirm();
  if (result === 'stopped') return { pagesCompleted: 1 };

  // Check for submit button
  const submitBtn = await page.$('input[type="submit"], button[type="submit"], #submit_app');
  if (submitBtn) {
    botState.waitingSubmit();
    botState._emit('Submit button found — please click Submit in the browser');

    await waitForSubmission(page);
  }

  return { pagesCompleted: 1 };
}

async function fillBasicGreenhouseFields(page, profile) {
  const basicFields = {
    '#first_name': profile.personal.firstName,
    '#last_name': profile.personal.lastName,
    '#email': profile.personal.email,
    '#phone': profile.personal.phone,
    'input[name="job_application[first_name]"]': profile.personal.firstName,
    'input[name="job_application[last_name]"]': profile.personal.lastName,
    'input[name="job_application[email]"]': profile.personal.email,
    'input[name="job_application[phone]"]': profile.personal.phone
  };

  for (const [selector, value] of Object.entries(basicFields)) {
    try {
      const el = await page.$(selector);
      if (el) {
        const current = await el.inputValue().catch(() => '');
        if (!current || current.trim() === '') {
          await el.fill(value);
          botState._emit(`Filled: ${selector.replace(/[#[\]]/g, '')} → "${value}"`);
        }
      }
    } catch (_) {}
  }
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
        if (lower.includes('application submitted') || lower.includes('thank you') || lower.includes('successfully')) {
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

module.exports = { handleGreenhouse };
