// pipeline.js — Orchestrates the full auto-apply flow.
// Uses ATS-specific handlers. No ai-agent.

const { chromium } = require('playwright');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const axios = require('axios');

const { botState, STATES }     = require('./bot-state');
const { detectAndNavigate }    = require('./detector');
const { loadProfile }          = require('./field-ai');
const { handleWorkday }        = require('./ats/workday');
const { handleGreenhouse }     = require('./ats/greenhouse');
const { handleGeneric }        = require('./ats/generic');

let browser       = null;
let currentContext = null;
let tempResumeFile = null;

// ── Download resume PDF from Google Docs ─────────────────────────────────────
async function downloadResumePdf(resumeLink) {
  if (!resumeLink) return null;

  const match = resumeLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Invalid Google Docs URL — cannot extract file ID');

  const fileId = match[1];
  const pdfUrl = `https://docs.google.com/document/d/${fileId}/export?format=pdf`;

  botState._emit('Downloading resume PDF from Google Docs...');

  const response = await axios.get(pdfUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  const tmpPath = path.join(os.tmpdir(), `resume_${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, response.data);
  botState._emit(`Resume PDF saved: ${path.basename(tmpPath)}`);
  return tmpPath;
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
async function runPipeline({
  sessionId, applicationId, companyName, position, jdUrl,
  resumeLink, resumeFile, jobDescription,
  generateAIContent, aiProvider, apiKey, pool, trigger
}) {
  let resumePath = null;
  let atsType    = 'generic';

  try {
    botState.start({ sessionId, companyName, position });

    // ── Step 1: Get resume PDF ───────────────────────────────────────────────
    if (resumeFile && fs.existsSync(resumeFile)) {
      resumePath = resumeFile;
      botState._emit(`Using uploaded resume: ${path.basename(resumePath)}`);
    } else if (resumeLink) {
      resumePath = await downloadResumePdf(resumeLink);
      tempResumeFile = resumePath;
    } else {
      botState._emit('No resume provided — file upload fields will be skipped');
    }

    // ── Step 2: Load profile ─────────────────────────────────────────────────
    const profile = loadProfile();
    botState._emit(`Profile loaded: ${profile.personal.fullName}`);

    // ── Step 3: Launch visible browser ───────────────────────────────────────
    botState._emit('Launching browser...');
    browser = await chromium.launch({
      headless: false,
      slowMo: parseInt(process.env.BOT_TYPING_DELAY_MS) || 30,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    currentContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    // Hide automation flags
    await currentContext.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await currentContext.newPage();

    // ── Step 4: Navigate and detect ATS ──────────────────────────────────────
    const detected = await detectAndNavigate(page, jdUrl);
    atsType = detected.atsType;
    botState.setATS(atsType);
    botState._emit(`ATS: ${atsType}`);

    // ── Step 5: Run ATS handler ───────────────────────────────────────────────
    const handlerArgs = {
      page, profile, resumePath, jobDescription,
      companyName, position,
      generateAIContent, aiProvider, apiKey
    };

    let result;
    switch (atsType) {
      case 'workday':
        result = await handleWorkday(handlerArgs);
        break;
      case 'greenhouse':
        result = await handleGreenhouse(handlerArgs);
        break;
      default:
        botState._emit(`No specific handler for "${atsType}" — using generic`);
        result = await handleGeneric(handlerArgs);
    }

    // ── Step 6: Log session ───────────────────────────────────────────────────
    if (pool) {
      await logBotSession(pool, {
        sessionId, applicationId, companyName, position, jdUrl,
        atsType, trigger, resumeLink: resumeLink || resumeFile || '',
        fieldsFilled:   botState.filled.length,
        fieldsFlagged:  botState.flagged.length,
        flaggedDetails: botState.flagged,
        pagesCompleted: botState.currentPage,
        status:         botState.state,
        errorMessage:   botState.error
      });
    }

    return result;

  } catch (err) {
    console.error('[PIPELINE] Error:', err);
    if (botState.state !== STATES.DONE) {
      botState.setError(err.message);
    }

    if (pool) {
      await logBotSession(pool, {
        sessionId, applicationId, companyName, position, jdUrl,
        atsType, trigger, resumeLink: resumeLink || resumeFile || '',
        fieldsFilled:   botState.filled.length,
        fieldsFlagged:  botState.flagged.length,
        flaggedDetails: botState.flagged,
        pagesCompleted: botState.currentPage,
        status:         'error',
        errorMessage:   err.message
      }).catch(() => {});
    }

    throw err;

  } finally {
    cleanup();
  }
}

// ── Cleanup temp files ────────────────────────────────────────────────────────
function cleanup() {
  if (tempResumeFile) {
    try { fs.unlinkSync(tempResumeFile); } catch (_) {}
    tempResumeFile = null;
  }
}

// ── Close browser ─────────────────────────────────────────────────────────────
async function closeBrowser() {
  cleanup();
  if (currentContext) {
    try { await currentContext.close(); } catch (_) {}
    currentContext = null;
  }
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
  }
  botState._emit('Browser closed');
}

// ── Log to DB ─────────────────────────────────────────────────────────────────
async function logBotSession(pool, data) {
  try {
    await pool.query(`
      INSERT INTO bot_sessions (
        session_id, application_id, company_name, position, jd_url,
        ats_type, trigger_source, resume_link,
        fields_filled, fields_flagged, flagged_details,
        pages_completed, status, error_message,
        completed_at, duration_sec
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        NOW(),
        EXTRACT(EPOCH FROM (NOW() - $15::timestamp))::int
      )
      ON CONFLICT (session_id) DO UPDATE SET
        fields_filled    = EXCLUDED.fields_filled,
        fields_flagged   = EXCLUDED.fields_flagged,
        flagged_details  = EXCLUDED.flagged_details,
        pages_completed  = EXCLUDED.pages_completed,
        status           = EXCLUDED.status,
        error_message    = EXCLUDED.error_message,
        completed_at     = NOW()
    `, [
      data.sessionId,
      data.applicationId,
      data.companyName,
      data.position,
      data.jdUrl,
      data.atsType,
      data.trigger,
      data.resumeLink,
      data.fieldsFilled,
      data.fieldsFlagged,
      JSON.stringify(data.flaggedDetails || []),
      data.pagesCompleted,
      data.status,
      data.errorMessage,
      botState.startedAt || new Date()
    ]);
  } catch (err) {
    console.error('[PIPELINE] Failed to log session:', err.message);
  }
}

module.exports = { runPipeline, closeBrowser };