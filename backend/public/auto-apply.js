let ws = null;
let botSnapshot = null;

// ── Initialization ────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  prefillFromParams();
  connectWebSocket();
  fetchInitialStatus();
});

function prefillFromParams() {
  const params = new URLSearchParams(window.location.search);
  const jdUrlEl = document.getElementById('jdUrl') || document.getElementById('autoApplyJdUrl');
  const resumeEl = document.getElementById('resumeLink') || document.getElementById('autoApplyResumeLink');
  const jdTextEl = document.getElementById('jobDescription');

  if (jdUrlEl && params.get('jdUrl')) jdUrlEl.value = params.get('jdUrl');
  if (resumeEl && params.get('resumeLink')) resumeEl.value = params.get('resumeLink');
  if (jdTextEl && params.get('jobDescription')) jdTextEl.value = params.get('jobDescription');
}

async function fetchInitialStatus() {
  try {
    const res = await fetch('/api/auto-apply/status');
    botSnapshot = await res.json();
    renderAll(botSnapshot);
  } catch (e) {}
}

// ── WebSocket ─────────────────────────────────────────
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${location.host}/ws/auto-apply`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => console.log('WebSocket connected');

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'bot_state') {
        botSnapshot = msg.data;
        renderAll(botSnapshot);
      }
    } catch (e) {}
  };

  ws.onclose = () => setTimeout(connectWebSocket, 3000);
  ws.onerror = () => ws.close();
}

// ── Resume type toggle ────────────────────────────────
function toggleResumeInput() {
  const linkInput = document.getElementById('resumeLink');
  const fileInput = document.getElementById('resumeFile');
  if (!linkInput || !fileInput) return;

  const isLink = document.querySelector('input[name="resumeType"]:checked')?.value === 'link';
  linkInput.style.display = isLink ? 'block' : 'none';
  fileInput.style.display = isLink ? 'none' : 'block';
}

// ── Start bot (from auto-apply.html, Trigger 3) ──────
async function startBot() {
  const jdUrl = (document.getElementById('jdUrl') || {}).value?.trim();
  const jobDescription = (document.getElementById('jobDescription') || {}).value?.trim();
  const resumeLink = (document.getElementById('resumeLink') || {}).value?.trim();

  if (!jdUrl) { alert('Please enter the job posting URL'); return; }
  if (!jobDescription) { alert('Please enter the job description'); return; }

  const btn = document.getElementById('startBtn');
  if (btn) { btn.textContent = 'LAUNCHING...'; btn.disabled = true; }

  try {
    const res = await fetch('/api/auto-apply/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jdUrl,
        resumeLink: resumeLink || null,
        jobDescription,
        aiProvider: 'chatgpt',
        trigger: 'manual'
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to start bot');
      if (btn) { btn.textContent = 'START AUTO APPLY'; btn.disabled = false; }
      return;
    }

    // Show live panel, hide form
    const formCard = document.getElementById('formCard');
    if (formCard) formCard.style.display = 'none';

    const panel = document.getElementById('botLivePanel');
    if (panel) panel.classList.remove('hidden');

  } catch (e) {
    alert('Failed to start bot: ' + e.message);
    if (btn) { btn.textContent = 'START AUTO APPLY'; btn.disabled = false; }
  }
}

// ── Start bot (from application.html, Trigger 2) ─────
async function startAutoApply() {
  const jdUrl = (document.getElementById('autoApplyJdUrl') || {}).value?.trim();
  const resumeLink = (document.getElementById('autoApplyResumeLink') || {}).value?.trim();
  const aiProvider = (document.getElementById('autoApplyProvider') || {}).value || 'chatgpt';

  if (!jdUrl) { alert('Please enter the job posting URL'); return; }
  if (!resumeLink) { alert('Please enter the resume Google Docs link'); return; }

  const btn = document.getElementById('autoApplyStartBtn');
  if (btn) { btn.textContent = 'Launching...'; btn.disabled = true; }

  // Get app data from the page
  const appId = location.pathname.split('/').pop();
  let appData = null;
  try {
    const r = await fetch(`/api/applications/${appId}`);
    appData = await r.json();
  } catch (_) {}

  try {
    const res = await fetch('/api/auto-apply/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        applicationId: appId,
        companyName: appData?.company_name || '',
        position: appData?.position_applied || '',
        jdUrl,
        resumeLink,
        jobDescription: appData?.jd_text || '',
        aiProvider,
        trigger: 'application_page'
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to start bot');
      if (btn) { btn.textContent = 'Launch Bot'; btn.disabled = false; }
      return;
    }

    closeAutoApplyModal();
    const panel = document.getElementById('botLivePanel');
    if (panel) panel.classList.remove('hidden');
    const badge = document.getElementById('botStatusBadge');
    if (badge) badge.style.display = 'block';

  } catch (e) {
    alert('Failed to start bot: ' + e.message);
    if (btn) { btn.textContent = 'Launch Bot'; btn.disabled = false; }
  }
}

// ── Bot controls ──────────────────────────────────────
async function confirmPage() {
  await fetch('/api/auto-apply/confirm', { method: 'POST' });
}

async function pauseBot() {
  await fetch('/api/auto-apply/pause', { method: 'POST' });
}

async function resumeBot() {
  await fetch('/api/auto-apply/resume', { method: 'POST' });
}

async function stopBot() {
  if (!confirm('Stop the bot and close the browser?')) return;
  await fetch('/api/auto-apply/stop', { method: 'POST' });
  const panel = document.getElementById('botLivePanel');
  if (panel) panel.classList.add('hidden');

  // Re-show form if on auto-apply page
  const formCard = document.getElementById('formCard');
  if (formCard) formCard.style.display = 'block';

  const btn = document.getElementById('startBtn');
  if (btn) { btn.textContent = 'START AUTO APPLY'; btn.disabled = false; }
}

// ── Modal controls (application.html) ─────────────────
function launchAutoApply() {
  const overlay = document.getElementById('autoApplyOverlay');
  if (!overlay) return;

  // Pre-fill from app data
  try {
    const jdLinkEl = document.getElementById('jdLink');
    const resumeLinkEl = document.getElementById('resumeLink');
    const jdUrlInput = document.getElementById('autoApplyJdUrl');
    const resumeInput = document.getElementById('autoApplyResumeLink');

    if (jdUrlInput && jdLinkEl) jdUrlInput.value = jdLinkEl.href || '';
    if (resumeInput && resumeLinkEl) resumeInput.value = resumeLinkEl.href || '';
  } catch (_) {}

  overlay.classList.remove('hidden');
}

function closeAutoApplyModal() {
  const overlay = document.getElementById('autoApplyOverlay');
  if (overlay) overlay.classList.add('hidden');
}

// ── Render everything ─────────────────────────────────
function renderAll(state) {
  if (!state) return;
  renderBotStatus(state);
  renderLivePanel(state);
}

function renderBotStatus(state) {
  const badge = document.getElementById('botStatusBadge');
  const statusEl = document.getElementById('botCurrentStatus');
  const applyBtn = document.getElementById('autoApplyBtn');

  if (badge && statusEl) {
    const isActive = !['idle', 'done', 'error'].includes(state.state);
    badge.style.display = isActive ? 'block' : 'none';
    statusEl.textContent = state.state.toUpperCase();

    const colors = {
      detecting: '#f59e0b', clicking_apply: '#f59e0b',
      scanning: '#3b82f6', ai_thinking: '#3b82f6',
      filling: '#8b5cf6', paused: '#ef4444', stuck: '#ef4444',
      reviewing: '#f59e0b', waiting_submit: '#10b981',
      done: '#10b981', error: '#ef4444', idle: '#6b7280'
    };
    statusEl.style.color = colors[state.state] || '#6b7280';
  }

  if (applyBtn) {
    const isActive = !['idle', 'done', 'error'].includes(state.state);
    if (isActive) {
      applyBtn.textContent = 'Bot Running';
      applyBtn.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
      applyBtn.onclick = stopBot;
    } else {
      applyBtn.textContent = 'Launch Auto Apply';
      applyBtn.style.background = 'linear-gradient(135deg, #8b5cf6, #6d28d9)';
      applyBtn.onclick = launchAutoApply;
    }
  }
}

function renderLivePanel(state) {
  const panel = document.getElementById('botLivePanel');
  if (!panel) return;

  const isActive = !['idle'].includes(state.state);
  if (!isActive && state.state !== 'done' && state.state !== 'error') {
    if (!panel.classList.contains('hidden') && typeof IS_LIVE_PAGE === 'undefined') return;
  }

  if (isActive || state.state === 'done' || state.state === 'error') {
    panel.classList.remove('hidden');
  }

  // State header
  const stateEl = document.getElementById('liveState');
  if (stateEl) {
    const icons = {
      idle: '', detecting: 'DETECTING', clicking_apply: 'CLICKING APPLY',
      scanning: 'SCANNING', ai_thinking: 'AI THINKING', filling: 'FILLING',
      paused: 'PAUSED', stuck: 'STUCK', reviewing: 'REVIEWING',
      waiting_submit: 'READY TO SUBMIT', done: 'DONE', error: 'ERROR'
    };
    let text = icons[state.state] || state.state.toUpperCase();
    if (state.atsType) text += ` | ${state.atsType.toUpperCase()}`;
    stateEl.textContent = text;
  }

  const atsEl = document.getElementById('liveAts');
  if (atsEl) atsEl.textContent = '';

  // Page indicator
  const pageEl = document.getElementById('livePage');
  if (pageEl && state.currentPage > 0) {
    pageEl.textContent = `Page ${state.currentPage}`;
  }

  // Counts
  const filledEl = document.getElementById('liveFilled');
  const flaggedEl = document.getElementById('liveFlagged');
  if (filledEl) filledEl.textContent = state.filled || 0;
  if (flaggedEl) flaggedEl.textContent = state.flagged || 0;

  // Current action
  const currentEl = document.getElementById('liveCurrent');
  if (currentEl) {
    if (state.currentField) {
      currentEl.innerHTML = `<strong>${state.currentField.label}</strong> → ${state.currentField.answer || '...'}`;
    } else if (state.state === 'ai_thinking') {
      currentEl.textContent = 'AI is analyzing fields...';
    } else if (state.state === 'scanning') {
      currentEl.textContent = 'Reading form fields...';
    } else if (state.state === 'detecting') {
      currentEl.textContent = 'Detecting ATS type...';
    } else if (state.state === 'waiting_submit') {
      currentEl.textContent = 'All pages filled! Click Submit in the browser.';
    } else if (state.state === 'done') {
      currentEl.textContent = 'Application completed!';
    } else if (state.state === 'error') {
      currentEl.textContent = 'Error: ' + (state.error || 'Unknown error');
    }
  }

  // Flagged fields
  const flaggedListEl = document.getElementById('liveFlaggedList');
  if (flaggedListEl && state.flaggedList) {
    if (state.flaggedList.length > 0) {
      flaggedListEl.innerHTML = `
        <div class="flagged-header">NEEDS YOUR ATTENTION (${state.flaggedList.length})</div>
        ${state.flaggedList.map(f => `
          <div class="flagged-item">
            <span class="flagged-label">${f.label || ''}</span>
            <span class="flagged-reason">${f.reason || ''}</span>
          </div>
        `).join('')}
      `;
      flaggedListEl.classList.remove('hidden');
    } else {
      flaggedListEl.classList.add('hidden');
    }
  }

  // Log
  const logEl = document.getElementById('liveLog');
  if (logEl && state.log) {
    logEl.innerHTML = state.log.slice().reverse().map(entry =>
      `<div class="log-entry"><span class="log-time">${entry.time}</span>${entry.message}</div>`
    ).join('');
  }

  // Control buttons
  renderControlButtons(state);
}

function renderControlButtons(state) {
  const el = document.getElementById('liveControls');
  if (!el) return;

  let html = '';

  switch (state.state) {
    case 'detecting':
    case 'clicking_apply':
    case 'scanning':
    case 'ai_thinking':
    case 'filling':
      html = `
        <div class="control-hint">Bot is working...</div>
        <div class="control-buttons">
          <button class="bot-btn bot-btn-pause" onclick="pauseBot()">Pause</button>
          <button class="bot-btn bot-btn-stop" onclick="stopBot()">Stop</button>
        </div>
      `;
      break;

    case 'paused':
      html = `
        <div class="control-hint">Bot is paused.</div>
        <div class="control-buttons">
          <button class="bot-btn bot-btn-resume" onclick="resumeBot()">Resume</button>
          <button class="bot-btn bot-btn-stop" onclick="stopBot()">Stop</button>
        </div>
      `;
      break;

    case 'stuck':
      html = `
        <div class="control-hint" style="color:#ef4444;">STUCK: ${state.stuckReason || 'Unknown issue'}. Please help in the browser then click Resume.</div>
        <div class="control-buttons">
          <button class="bot-btn bot-btn-resume" onclick="resumeBot()">Resume After Fixing</button>
          <button class="bot-btn bot-btn-stop" onclick="stopBot()">Stop</button>
        </div>
      `;
      break;

    case 'reviewing':
      html = `
        <div class="control-hint">Page ${state.currentPage} filled. Check the browser — fix anything wrong — then confirm.</div>
        <div class="control-buttons">
          <button class="bot-btn bot-btn-confirm" onclick="confirmPage()">Confirm &amp; Go to Next Page</button>
          <button class="bot-btn bot-btn-pause" onclick="pauseBot()">Pause</button>
          <button class="bot-btn bot-btn-stop" onclick="stopBot()">Stop</button>
        </div>
      `;
      break;

    case 'waiting_submit':
      html = `
        <div class="control-hint">All pages filled! Please click SUBMIT in the browser.<br>The bot will NOT click Submit — you must click it.</div>
        <div class="control-buttons">
          <button class="bot-btn bot-btn-stop" onclick="stopBot()">Close Bot</button>
        </div>
      `;
      break;

    case 'done':
      html = `
        <div class="control-hint" style="color:#10b981;">Application submitted successfully!</div>
        <div class="control-buttons">
          <button class="bot-btn" onclick="dismissPanel()" style="background:#6b7280;">Close</button>
        </div>
      `;
      break;

    case 'error':
      html = `
        <div class="control-hint" style="color:#ef4444;">Error: ${state.error || 'Unknown error'}</div>
        <div class="control-buttons">
          <button class="bot-btn bot-btn-confirm" onclick="retryBot()">Retry</button>
          <button class="bot-btn" onclick="dismissPanel()" style="background:#6b7280;">Close</button>
        </div>
      `;
      break;
  }

  el.innerHTML = html;
}

function dismissPanel() {
  const panel = document.getElementById('botLivePanel');
  if (panel) panel.classList.add('hidden');

  const formCard = document.getElementById('formCard');
  if (formCard) formCard.style.display = 'block';

  const btn = document.getElementById('startBtn');
  if (btn) { btn.textContent = 'START AUTO APPLY'; btn.disabled = false; }
}

function retryBot() {
  dismissPanel();
  const formCard = document.getElementById('formCard');
  if (formCard) {
    formCard.style.display = 'block';
  } else {
    launchAutoApply();
  }
}
