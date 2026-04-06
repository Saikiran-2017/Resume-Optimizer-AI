// ai-agent.js — Agentic AI loop for form filling.
// READ page → THINK (AI decides) → ACT (execute) → REMEMBER → REPEAT

const { botState, STATES } = require('./bot-state');
const { readPage, formatPageForAI } = require('./page-reader');
const { executeActions } = require('./agent-executor');

const MAX_STEPS = 30;

async function runAgent({ page, profile, resumePath, jobDescription, companyName, position, generateAIContent, aiProvider, apiKey }) {
  const credentials = {
    email: process.env.WORKDAY_EMAIL || profile.personal.email,
    password: process.env.WORKDAY_PASSWORD || ''
  };

  let step = 0;
  let lastPageSignature = '';
  let samePageCount = 0;
  let lastAIActions = '';

  while (step < MAX_STEPS) {
    if (botState.state === STATES.IDLE || botState.state === STATES.ERROR) break;

    step++;
    botState.scanning(step);
    botState._emit(`── STEP ${step} ──────────────────────────`);

    // ── 1. READ ──
    botState._emit('Reading page...');

    // Detect "Something went wrong" and auto-refresh
    const pageText = await page.textContent('body').catch(() => '');
    if (pageText && /something went wrong|unexpected error|page not found|try again/i.test(pageText) && pageText.length < 500) {
      botState._emit('Detected error page — refreshing...');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    const pageSnapshot = await readPage(page);

    const formFields = pageSnapshot.elements.filter(e =>
      e.tag === 'input' || e.tag === 'textarea' || e.tag === 'select' ||
      e.type === 'workday-dropdown' || e.type === 'checkbox' || e.type === 'workday-button-dropdown'
    );
    const clickables = pageSnapshot.elements.filter(e =>
      e.type === 'button' || e.type === 'submit-button' || e.type === 'link'
    );

    botState._emit(`Page: "${pageSnapshot.pageHeader || pageSnapshot.title}" — ${formFields.length} fields, ${clickables.length} buttons`);
    botState._emit(`URL: ${pageSnapshot.url.substring(0, 100)}`);

    for (const el of formFields) {
      const val = el.value ? ` = "${el.value.substring(0, 25)}"` : '';
      const chk = el.checked !== undefined ? (el.checked ? ' [✓]' : ' [ ]') : '';
      botState._emit(`  [${el.idx}] ${el.tag}[${el.type}]: "${el.label}"${chk}${val}`);
    }
    if (formFields.length === 0) botState._emit('No form fields — only buttons/links');
    for (const el of clickables) {
      botState._emit(`  [${el.idx}] ${el.type}: "${el.text}"`);
    }

    // ── Same page detection ──
    const pageSignature = `${pageSnapshot.url}|${pageSnapshot.elements.length}|${formFields.map(f => f.label).join(',')}`;
    let repetitionWarning = '';
    if (pageSignature === lastPageSignature) {
      samePageCount++;
      if (samePageCount >= 5) {
        botState._emit('Stuck on same page for 5 steps');
        botState.setStuck('Bot stuck. Navigate manually, then Resume.');
        const r = await botState.waitForResume();
        if (r === 'stopped' || botState.state === STATES.IDLE) break;
        samePageCount = 0;
        step--;
        continue;
      }
      repetitionWarning = `\n⚠️ WARNING: SAME PAGE as last ${samePageCount} step(s). Previous actions "${lastAIActions}" did NOT work. Try DIFFERENT approach. If "Create Account" failed, try "Sign In" instead.`;
    } else {
      samePageCount = 1;
    }
    lastPageSignature = pageSignature;

    // ── 2. THINK ──
    botState.aiThinking();
    botState._emit('AI analyzing...');

    const pageForAI = formatPageForAI(pageSnapshot);
    const memorySummary = botState.getMemorySummary();

    const aiResponse = await askAI({
      pageForAI, profile, jobDescription, companyName, position,
      memorySummary, step, totalElements: pageSnapshot.elements.length,
      generateAIContent, aiProvider, apiKey, credentials, repetitionWarning
    });

    botState._emit(`AI: ${aiResponse.message}`);
    botState._emit(`Intent: ${aiResponse.intent}, ${aiResponse.actions.length} actions`);
    for (const a of aiResponse.actions) {
      botState._emit(`  → ${a.action} [${a.elementIdx}] ${a.label || ''} ${a.value ? '"' + String(a.value).substring(0, 35) + '"' : ''}`);
    }
    lastAIActions = aiResponse.actions.map(a => `${a.action} "${a.label || ''}"`).join(', ');

    // Validate
    const maxIdx = pageSnapshot.elements.length - 1;
    const validActions = aiResponse.actions.filter(a => {
      if (a.action === 'wait' || a.action === 'scroll') return true;
      if (a.elementIdx === undefined || a.elementIdx === null) return false;
      if (a.elementIdx < 0 || a.elementIdx > maxIdx) {
        botState._emit(`  SKIP: [${a.elementIdx}] out of range`);
        return false;
      }
      return true;
    });

    // Handle intents
    if (aiResponse.intent === 'DONE') {
      botState.done(aiResponse.message || 'Application completed!');
      break;
    }
    if (aiResponse.intent === 'STUCK') {
      botState.setStuck(aiResponse.message || 'AI cannot proceed');
      const r = await botState.waitForResume();
      if (r === 'stopped' || botState.state === STATES.IDLE) break;
      step--;
      continue;
    }
    if (aiResponse.intent === 'WAIT_SUBMIT') {
      botState.waitingSubmit();
      botState._emit(aiResponse.message || 'Click Submit in browser');
      await waitForSubmission(page);
      break;
    }

    // ── 3. ACT ──
    if (validActions.length > 0) {
      botState.filling();
      const results = await executeActions(page, validActions, pageSnapshot, resumePath);
      const filled = results.filter(r => r.success && !r.skipped).length;
      const failed = results.filter(r => !r.success).length;
      const skipped = results.filter(r => r.skipped).length;
      botState._emit(`Result: ${filled} OK, ${failed} failed, ${skipped} skipped`);
    }

    // ── 4. REMEMBER ──
    botState.addMemory({
      pageUrl: pageSnapshot.url,
      pageTitle: pageSnapshot.pageHeader || pageSnapshot.title,
      formFields: formFields.length,
      aiIntent: aiResponse.intent,
      actionsCount: validActions.length,
      aiMessage: aiResponse.message
    });

    // ── 5. Post-action ──
    const hadClick = validActions.some(a => a.action === 'click' || a.action === 'clickAndSelect');
    if (hadClick) {
      botState._emit('Waiting for page after click...');
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    if (aiResponse.intent === 'FILL_AND_NEXT') continue;

    if (formFields.length > 0 || aiResponse.intent === 'FILL_AND_REVIEW') {
      botState.review(step);
      botState._emit(`Step ${step} done. Check browser, then Confirm.`);
      const confirmResult = await botState.waitForConfirm();
      if (confirmResult === 'stopped') break;
      botState._emit('Confirmed — re-reading page...');
    }
  }

  return { stepsCompleted: step };
}

async function askAI({ pageForAI, profile, jobDescription, companyName, position, memorySummary, step, totalElements, generateAIContent, aiProvider, apiKey, credentials, repetitionWarning }) {
  const escapedPassword = credentials.password.replace(/"/g, '\\"');

  const prompt = `You are an AI agent filling a job application in a browser. Think like a HUMAN applicant — what would a human click on this page?

APPLYING TO: ${position} at ${companyName}
JOB: ${(jobDescription || '').substring(0, 800)}

CANDIDATE:
${JSON.stringify(profile, null, 2)}

LOGIN: email="${credentials.email}" password="${escapedPassword}"

MEMORY:
${memorySummary || 'First step'}
${repetitionWarning}

STEP ${step}:
${pageForAI}

═══════ RULES (follow strictly) ═══════

1. ELEMENT INDICES: Only use [0] to [${totalElements - 1}]. Never invent.

2. ACTION TYPES:
   type → INPUT[text/email/tel/url/number] or TEXTAREA
   select → native SELECT element
   click → BUTTON/SUBMIT-BUTTON/LINK
   check → INPUT[checkbox] or DIV[checkbox]
   clickAndSelect → BUTTON[workday-button-dropdown] (click opens dropdown, then pick option)
   typeAndSelect → INPUT/workday-dropdown for typeahead search fields
   upload → INPUT[file]

3. POPUP/MODAL → HIGHEST PRIORITY:
   If "Apply Manually" / "Autofill with Resume" / "Use My Last Application" visible → click "Apply Manually" FIRST.
   Do NOT click cookies, do NOT re-click "Apply" if modal is showing.
   ONLY deal with the popup. One action: click "Apply Manually". Intent: FILL_AND_NEXT.

4. COOKIES → LOWEST PRIORITY:
   Only click "Accept Cookies" if there is NO popup/modal AND no form to fill. Never prioritize cookies.

5. CREATE ACCOUNT PAGE (email + password + verify password fields):
   a) Type email into Email Address field
   b) Type password "${escapedPassword}" into Password field (EXACT, including #)
   c) Type password "${escapedPassword}" into Verify/Confirm Password field
   d) If there is a checkbox (terms/conditions/agreement) → check it with "check" action
   e) Click "Create Account" button as LAST action
   f) NEVER click "Forgot your password?" or "Careers Privacy Policy" or "Sign In" on create account page
   g) Intent: FILL_AND_NEXT

6. SIGN IN PAGE (email + password, no verify field):
   a) Type email into Email field
   b) Type password "${escapedPassword}" into Password field
   c) Click "Sign In" button as LAST action
   d) Intent: FILL_AND_NEXT

7. IF SAME PAGE REPEATS after Create Account → try "Sign In" instead (account may exist).

8. REQUIRED FIELDS (*): Fields marked with * or (REQUIRED) MUST be filled. Never skip them.

9. HONEYPOT: "This input is for robots only" → SKIP. Do not fill.

10. PRE-FILLED: If value="..." already shown → skip that field.

11. ALWAYS END WITH SUBMIT: After filling, ALWAYS click Save and Continue / Next / Submit / Create Account / Sign In as the LAST action.

12. WORKDAY BUTTON DROPDOWNS (type="workday-button-dropdown"):
    Questions like "Are you 18?", "High school diploma?", "Authorized to work?" show as button dropdowns labeled "Select One".
    Use action "clickAndSelect" with the button's element index.
    Set "value" to the answer: "Yes", "No", etc.
    Example: {"action": "clickAndSelect", "elementIdx": 15, "label": "Are you 18 years or older?", "value": "Yes"}

13. "HOW DID YOU HEAR ABOUT US?" → typeAndSelect, search "${companyName} Careers" first. If not found, try "LinkedIn", then "Other".
    {"action": "typeAndSelect", "elementIdx": N, "label": "How Did You Hear About Us?", "value": "${companyName} Careers", "selectText": "${companyName}"}

14. COMMON ANSWERS:
    Are you 18? → Yes | High school diploma? → Yes | Legally authorized? → Yes
    Require sponsorship? → Yes | Salary → 120000 | Notice → 0 / Immediately
    Worked here before? → No | Available days → All / Monday-Friday | Shifts → All / Day

15. WORK EXPERIENCE: Use candidate's ACTUAL history, NOT the company being applied to.

16. COMPLETION: "Application Submitted" / "Thank You" → DONE. Submit button ready → WAIT_SUBMIT. CAPTCHA → STUCK.

17. THINK LIKE A HUMAN: Never click error messages, privacy policies, or forgot password links. A human would fill the form and click the submit button.

═══════ RESPONSE (JSON only, no text) ═══════
{
  "intent": "FILL_AND_NEXT | FILL_AND_REVIEW | STUCK | DONE | WAIT_SUBMIT",
  "message": "What I see and will do",
  "actions": [...]
}
INTENTS: FILL_AND_NEXT = simple (login, cookie, popup). FILL_AND_REVIEW = complex form. STUCK = blocked. DONE = submitted. WAIT_SUBMIT = ready for human submit.

JSON:`;

  console.log(`[AI-AGENT] Step ${step}: ${totalElements} elements, prompt ${prompt.length} chars`);
  const raw = await generateAIContent(prompt, aiProvider, apiKey);
  console.log(`[AI-AGENT] Step ${step}: response:`, (raw || '').substring(0, 500));

  const response = parseAIResponse(raw, totalElements);

  // Post-process: force-correct password values
  for (const action of response.actions) {
    if (action.action === 'type' && action.label) {
      const lbl = action.label.toLowerCase();
      if (lbl.includes('password') || lbl.includes('verify')) {
        if (credentials.password && action.value !== credentials.password) {
          action.value = credentials.password;
        }
      }
    }
  }

  return response;
}

function parseAIResponse(raw, totalElements) {
  const fallback = { intent: 'STUCK', message: 'Failed to parse AI response', actions: [] };
  if (!raw) return fallback;

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {}
    }
    if (!parsed) {
      console.error('[AI-AGENT] Parse fail:', cleaned.substring(0, 300));
      return fallback;
    }
  }

  const actions = (Array.isArray(parsed.actions) ? parsed.actions : []).filter(a => {
    if (!a.action) return false;
    if (a.elementIdx !== undefined && (a.elementIdx < 0 || a.elementIdx >= totalElements)) return false;
    return true;
  });

  return {
    intent: parsed.intent || 'FILL_AND_REVIEW',
    message: parsed.message || '',
    actions
  };
}

async function waitForSubmission(page) {
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
        if (['application submitted', 'thank you for applying', 'successfully submitted'].some(s => text.includes(s))) {
          cleanup(); botState.done('Application submitted!'); resolve('done');
        }
      } catch (_) {}
    }, 3000);
    setTimeout(() => { cleanup(); resolve('timeout'); }, 30 * 60 * 1000);
  });
}

module.exports = { runAgent };
