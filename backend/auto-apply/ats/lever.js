const { botState, STATES } = require('../bot-state');
const { scanPage } = require('../page-scanner');
const { getFieldAnswers } = require('../field-ai');
const { fillAllFields } = require('../field-filler');

async function handleLever({ page, profile, resumePath, jobDescription, companyName, position, generateAIContent, aiProvider, apiKey }) {
  botState.scanning(1);
  botState._emit('Lever application detected');

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  // Fill standard Lever fields
  await fillBasicLeverFields(page, profile);

  // Upload resume
  if (resumePath) {
    const fileInput = await page.$('input[type="file"], input[name="resume"]');
    if (fileInput) {
      botState._emit('Uploading resume...');
      await fileInput.setInputFiles(resumePath);
      await page.waitForTimeout(2000);
      botState._emit('Resume uploaded');
    }
  }

  // Scan and fill remaining (custom questions)
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

  // Wait for manual submit
  const submitBtn = await page.$('button[type="submit"], .template-btn-submit, input[type="submit"]');
  if (submitBtn) {
    botState.waitingSubmit();
    botState._emit('Submit button found — please click Submit in the browser');
    await waitForSubmission(page);
  }

  return { pagesCompleted: 1 };
}

async function fillBasicLeverFields(page, profile) {
  const fields = {
    'input[name="name"]': profile.personal.fullName,
    'input[name="email"]': profile.personal.email,
    'input[name="phone"]': profile.personal.phone,
    'input[name="urls[LinkedIn]"]': profile.personal.linkedin,
    'input[name="urls[GitHub]"]': profile.personal.github,
    'input[name="urls[Portfolio]"]': profile.personal.portfolio,
    'input[name="org"]': profile.employment.currentEmployer
  };

  for (const [selector, value] of Object.entries(fields)) {
    try {
      const el = await page.$(selector);
      if (el) {
        const current = await el.inputValue().catch(() => '');
        if (!current || current.trim() === '') {
          await el.fill(value);
          botState._emit(`Filled: ${selector.split('"')[1] || selector} → "${value}"`);
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
        if (lower.includes('application submitted') || lower.includes('thank you') || lower.includes('application received')) {
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

module.exports = { handleLever };
