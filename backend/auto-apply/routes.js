const path = require('path');
const fs = require('fs');
const { botState, STATES } = require('./bot-state');
const { runPipeline, closeBrowser } = require('./pipeline');

const PROFILE_PATH = path.join(__dirname, 'profile.json');

function registerAutoApplyRoutes(app, { pool, generateAIContent, wss, WebSocket }) {

  // ── Status ───────────────────────────────────────────
  app.get('/api/auto-apply/status', (req, res) => {
    res.json(botState.snapshot());
  });

  // ── Start ────────────────────────────────────────────
  app.post('/api/auto-apply/start', async (req, res) => {
    try {
      const {
        applicationId, companyName, position,
        jdUrl, resumeLink, resumeFile,
        jobDescription, aiProvider, trigger
      } = req.body;

      if (botState.isRunning()) {
        return res.status(409).json({ error: 'Bot is already running. Stop it first.', state: botState.snapshot() });
      }
      if (!jdUrl) {
        return res.status(400).json({ error: 'Job post URL is required' });
      }

      const provider = aiProvider || 'chatgpt';
      const apiKey = provider === 'chatgpt'
        ? (process.env.CHATGPT_API_KEY || process.env.OPENAI_API_KEY)
        : process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(400).json({ error: `No API key found for ${provider}` });
      }

      const sessionId = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await closeBrowser();

      runPipeline({
        sessionId,
        applicationId: applicationId || null,
        companyName: companyName || 'Unknown',
        position: position || 'Unknown',
        jdUrl,
        resumeLink: resumeLink || null,
        resumeFile: resumeFile || null,
        jobDescription: jobDescription || '',
        generateAIContent,
        aiProvider: provider,
        apiKey,
        pool,
        trigger: trigger || 'manual'
      }).catch(err => {
        console.error('Pipeline error:', err.message);
        if (botState.state !== STATES.ERROR) {
          botState.setError(err.message);
        }
      });

      res.json({ success: true, sessionId, state: botState.snapshot() });
    } catch (err) {
      console.error('Auto-apply start error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Confirm page ─────────────────────────────────────
  app.post('/api/auto-apply/confirm', (req, res) => {
    const ok = botState.confirm();
    res.json({ success: ok, state: botState.snapshot() });
  });

  // ── Pause ────────────────────────────────────────────
  app.post('/api/auto-apply/pause', (req, res) => {
    const ok = botState.pause('User requested pause');
    res.json({ success: ok, state: botState.snapshot() });
  });

  // ── Resume ───────────────────────────────────────────
  app.post('/api/auto-apply/resume', (req, res) => {
    const ok = botState.resume();
    res.json({ success: ok, state: botState.snapshot() });
  });

  // ── Stop ─────────────────────────────────────────────
  app.post('/api/auto-apply/stop', async (req, res) => {
    botState.stop();
    await closeBrowser();
    res.json({ success: true, state: botState.snapshot() });
  });

  // ── Sessions list ────────────────────────────────────
  app.get('/api/auto-apply/sessions', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM bot_sessions ORDER BY started_at DESC LIMIT 50');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Session detail ───────────────────────────────────
  app.get('/api/auto-apply/session/:id', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM bot_sessions WHERE id = $1 OR session_id = $1', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Profile GET ──────────────────────────────────────
  app.get('/api/auto-apply/profile', (req, res) => {
    try {
      const data = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Could not read profile: ' + err.message });
    }
  });

  // ── Profile POST ─────────────────────────────────────
  app.post('/api/auto-apply/profile', (req, res) => {
    try {
      fs.writeFileSync(PROFILE_PATH, JSON.stringify(req.body, null, 2));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Could not save profile: ' + err.message });
    }
  });

  // ── WebSocket broadcast ──────────────────────────────
  if (wss && WebSocket) {
    botState.on('update', (snapshot) => {
      const msg = JSON.stringify({ type: 'bot_state', data: snapshot });
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
      });
    });
  }

  console.log('Auto-apply routes registered');
}

async function createBotSessionsTable(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id               SERIAL PRIMARY KEY,
        session_id       VARCHAR(255) UNIQUE,
        application_id   INTEGER,
        company_name     VARCHAR(255),
        position         VARCHAR(255),
        jd_url           TEXT,
        ats_type         VARCHAR(50),
        trigger_source   VARCHAR(50),
        resume_link      TEXT,
        fields_scanned   INTEGER DEFAULT 0,
        fields_filled    INTEGER DEFAULT 0,
        fields_flagged   INTEGER DEFAULT 0,
        flagged_details  JSONB DEFAULT '[]',
        pages_completed  INTEGER DEFAULT 0,
        status           VARCHAR(50) DEFAULT 'pending',
        error_message    TEXT,
        started_at       TIMESTAMP DEFAULT NOW(),
        completed_at     TIMESTAMP,
        duration_sec     INTEGER
      )
    `);
    console.log('bot_sessions table ready');
  } catch (err) {
    console.error('bot_sessions table error:', err.message);
  }
}

module.exports = { registerAutoApplyRoutes, createBotSessionsTable };
