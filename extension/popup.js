// Backend server URLs
const BACKEND_URL = 'http://localhost:3000';
const ANALYSIS_URL = 'http://localhost:3001';

// Global state to track current mode
let currentMode = null; // 'paste' or 'url'
let currentAction = 'optimize'; // 'analyze' or 'optimize'

// Wait for DOM to be fully loaded
document.addEventListener('DOMContentLoaded', function () {
  // DOM elements - States
  const modeSelectionState = document.getElementById('modeSelectionState');
  const actionSelectionState = document.getElementById('actionSelectionState');
  const pasteJdState = document.getElementById('pasteJdState');
  const urlModeState = document.getElementById('urlModeState');
  const loadingState = document.getElementById('loadingState');
  const successState = document.getElementById('successState');
  const errorState = document.getElementById('errorState');
  const settingsRequired = document.getElementById('settingsRequired');

  // Action selection buttons
  const selectAnalyzeMode = document.getElementById('selectAnalyzeMode');
  const selectOptimizeMode = document.getElementById('selectOptimizeMode');

  // Mode selection buttons
  const selectPasteMode = document.getElementById('selectPasteMode');
  const selectUrlMode = document.getElementById('selectUrlMode');

  // Paste mode elements
  const optimizePasteBtn = document.getElementById('optimizePasteBtn');
  const backFromPaste = document.getElementById('backFromPaste');
  const jobDescriptionInput = document.getElementById('jobDescriptionInput');
  const charCount = document.getElementById('charCount');
  const charWarning = document.getElementById('charWarning');

  // URL mode elements
  const optimizeUrlBtn = document.getElementById('optimizeUrlBtn');
  const backFromUrl = document.getElementById('backFromUrl');
  const currentUrl = document.getElementById('currentUrl');

  // Other buttons
  const settingsBtn = document.getElementById('settingsBtn');
  const dashboardBtn = document.getElementById('dashboardBtn');
  const retryBtn = document.getElementById('retryBtn');
  const optimizeAnother = document.getElementById('optimizeAnother');
  const backToModeSelection = document.getElementById('backToModeSelection');

  // Display elements
  const loadingStep = document.getElementById('loadingStep');
  const viewLink = document.getElementById('viewLink');
  const pdfLink = document.getElementById('pdfLink');
  const errorMessage = document.getElementById('errorMessage');
  const optimizationCount = document.getElementById('optimizationCount');
  const serverStatus = document.getElementById('serverStatus');
  const serverText = document.getElementById('serverText');
  const currentProvider = document.getElementById('currentProvider');

  // Check settings and server status on load
  checkSettings();
  checkServerStatus();

  // Action selection listeners
  if (selectAnalyzeMode) {
    selectAnalyzeMode.addEventListener('click', () => {
      currentAction = 'analyze';
      showState('modeSelection');
      updateButtonTexts();
    });
  }

  if (selectOptimizeMode) {
    selectOptimizeMode.addEventListener('click', () => {
      currentAction = 'optimize';
      showState('modeSelection');
      updateButtonTexts();
    });
  }

  // Mode selection event listeners
  if (selectPasteMode) {
    selectPasteMode.addEventListener('click', () => {
      currentMode = 'paste';
      showState('pasteJd');
    });
  }

  if (selectUrlMode) {
    selectUrlMode.addEventListener('click', async () => {
      currentMode = 'url';
      await updateCurrentUrl();
      showState('urlMode');
    });
  }

  // Back buttons
  if (backFromPaste) {
    backFromPaste.addEventListener('click', () => {
      currentMode = null;
      showState('actionSelection');
      // Clear input
      if (jobDescriptionInput) jobDescriptionInput.value = '';
      if (charCount) charCount.textContent = '0';
      if (charWarning) charWarning.style.display = 'none';
    });
  }

  if (backFromUrl) {
    backFromUrl.addEventListener('click', () => {
      currentMode = null;
      showState('actionSelection');
    });
  }

  if (backToModeSelection) {
    backToModeSelection.addEventListener('click', () => {
      currentMode = null;
      currentAction = 'optimize';
      showState('actionSelection');
    });
  }

  // Optimize buttons
  if (optimizePasteBtn) optimizePasteBtn.addEventListener('click', () => optimizeResume('paste'));
  if (optimizeUrlBtn) optimizeUrlBtn.addEventListener('click', () => optimizeResume('url'));
  if (retryBtn) retryBtn.addEventListener('click', () => optimizeResume(currentMode));
  if (optimizeAnother) {
    optimizeAnother.addEventListener('click', () => {
      currentMode = null;
      currentAction = 'optimize';
      showState('actionSelection');
    });
  }

  if (dashboardBtn) {
    dashboardBtn.addEventListener('click', () => {
      chrome.tabs.create({
        url: 'http://localhost:3000/dashboard'
      });
    });
  }


  // Settings button
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // Close button — closes the window (works whether opened as popup or tab)
  const closeBtn = document.getElementById('closeBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }

  // Character counter for job description
  if (jobDescriptionInput) {
    jobDescriptionInput.addEventListener('input', () => {
      const text = jobDescriptionInput.value;
      const length = text.length;

      if (charCount) charCount.textContent = length.toLocaleString();

      if (charWarning) {
        if (length < 100) {
          charWarning.textContent = 'Needs at least 100 characters';
          charWarning.style.display = 'inline';
          charWarning.style.color = '#ef4444';
        } else if (length < 300) {
          charWarning.textContent = 'Consider adding more details';
          charWarning.style.display = 'inline';
          charWarning.style.color = '#f59e0b';
        } else {
          charWarning.style.display = 'none';
        }
      }
    });
  }

  // Update button texts based on current action
  function updateButtonTexts() {
    const pasteBtnText = document.getElementById('pasteBtnText');
    const urlBtnText = document.getElementById('urlBtnText');
    const loadingTitle = document.getElementById('loadingTitle');

    if (currentAction === 'analyze') {
      if (pasteBtnText) pasteBtnText.textContent = '📊 Analyze Resume';
      if (urlBtnText) urlBtnText.textContent = '📊 Analyze Resume';
      if (loadingTitle) loadingTitle.textContent = 'Analyzing Your Resume';
    } else {
      if (pasteBtnText) pasteBtnText.textContent = '⚡ Optimize Resume';
      if (urlBtnText) urlBtnText.textContent = '⚡ Optimize Resume';
      if (loadingTitle) loadingTitle.textContent = 'Optimizing Your Resume';
    }
  }

  // Show specific state
  function showState(stateName) {
    // Map of state names to elements
    const states = {
      'actionSelection': actionSelectionState,
      'modeSelection': modeSelectionState,
      'pasteJd': pasteJdState,
      'urlMode': urlModeState,
      'loading': loadingState,
      'success': successState,
      'error': errorState,
      'settingsRequired': settingsRequired,
      'fitCheck': document.getElementById('fitCheckState')
    };

    // Hide all states
    Object.values(states).forEach(state => {
      if (state) state.style.display = 'none';
    });

    // Show requested state
    const targetState = states[stateName];
    if (targetState) {
      targetState.style.display = 'block';
    }
  }

  // Check if settings are configured
  function checkSettings() {
    chrome.storage.local.get([
      'aiProvider', 'geminiKey1', 'geminiKey2', 'geminiKey3',
      'chatgptApiKey', 'chatgptKey2', 'chatgptKey3'
    ], (result) => {
      const provider = result.aiProvider;

      // Update provider badge
      if (currentProvider) {
        if (provider === 'gemini') {
          currentProvider.textContent = 'Gemini AI';
        } else if (provider === 'chatgpt') {
          currentProvider.textContent = 'ChatGPT';
        } else {
          currentProvider.textContent = 'Not configured';
        }
      }

      // Check if keys are set
      const hasKeys = provider === 'gemini'
        ? (result.geminiKey1 && result.geminiKey2 && result.geminiKey3)
        : (result.chatgptApiKey && result.chatgptKey2 && result.chatgptKey3);

      if (provider && hasKeys) {
        showState('actionSelection');
      } else {
        showState('settingsRequired');
      }
    });
  }

  // Check server status
  async function checkServerStatus() {
    try {
      const [optResponse, anaResponse] = await Promise.all([
        fetch(`${BACKEND_URL}/health`, { method: 'GET', signal: AbortSignal.timeout(5000) }).catch(() => null),
        fetch(`${ANALYSIS_URL}/health`, { method: 'GET', signal: AbortSignal.timeout(5000) }).catch(() => null)
      ]);

      const optOk = optResponse?.ok;
      const anaOk = anaResponse?.ok;

      if (serverStatus && serverText) {
        if (optOk && anaOk) {
          serverStatus.style.background = '#10b981';
          serverText.textContent = 'Both servers online';
        } else if (optOk) {
          serverStatus.style.background = '#f59e0b';
          serverText.textContent = 'Optimize ready';
        } else if (anaOk) {
          serverStatus.style.background = '#f59e0b';
          serverText.textContent = 'Analysis ready';
        } else {
          serverStatus.style.background = '#ef4444';
          serverText.textContent = 'Servers offline';
        }
      }
    } catch (error) {
      if (serverStatus && serverText) {
        serverStatus.style.background = '#ef4444';
        serverText.textContent = 'Servers offline';
      }
    }
  }

  // Get current tab URL
  async function getCurrentTabUrl() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          resolve(tabs[0].url);
        } else {
          resolve(null);
        }
      });
    });
  }

  // Update current URL display
  async function updateCurrentUrl() {
    const url = await getCurrentTabUrl();
    if (currentUrl) {
      currentUrl.textContent = url || 'Could not get URL';
    }
  }

  // Update loading step
  function updateLoadingStep(message, progress) {
    console.log(`🔄 Progress: ${progress}% - ${message}`);
    
    if (loadingStep) {
      loadingStep.textContent = message;
    }

    // Update progress bar
    const progressFill = document.getElementById('progressFill');
    if (progressFill) {
      progressFill.style.width = progress + '%';
    }

    // Update progress percentage text
    const progressText = document.getElementById('progressText');
    if (progressText) {
      progressText.textContent = Math.round(progress) + '%';
    }

    // Update step indicators
    const steps = [
      document.getElementById('step1'),
      document.getElementById('step2'),
      document.getElementById('step3'),
      document.getElementById('step4')
    ];

    const activeStep = Math.ceil(progress / 25);
    steps.forEach((step, index) => {
      if (step) {
        if (index < activeStep) {
          step.classList.add('active');
        } else {
          step.classList.remove('active');
        }
      }
    });
  }

  // CONTINUED IN PART 2...
  // PART 2 - Main Functions

  // Handle Analysis (NEW FUNCTION)
async function handleAnalyze(jobDescription, jobUrl) {
  try {
    // Step 1: Initialize
    updateStep(1, 'active');
    updateLoadingStep('Initializing analysis...', 10);
    await sleep(500);
    updateStep(1, 'done');

    // Step 2: Prepare data
    updateStep(2, 'active');
    updateLoadingStep('Preparing resume and JD...', 25);
    await sleep(800);
    
    const settings = await chrome.storage.local.get([
      'aiProvider', 'geminiKey1', 'geminiKey2', 'geminiKey3',
      'chatgptApiKey', 'chatgptKey2', 'chatgptKey3'
    ]);
    updateStep(2, 'done');

    // Step 3: Send to server
    updateStep(3, 'active');
    updateLoadingStep('Analyzing with AI...', 50);

    const response = await fetch(`${ANALYSIS_URL}/api/analyze-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobUrl: jobUrl || null,
        currentPageUrl: jobUrl || null,
        aiProvider: settings.aiProvider,
        geminiKey1: settings.geminiKey1,
        geminiKey2: settings.geminiKey2,
        geminiKey3: settings.geminiKey3,
        chatgptApiKey: settings.chatgptApiKey,
        chatgptKey2: settings.chatgptKey2,
        chatgptKey3: settings.chatgptKey3,
        manualJobDescription: jobDescription || null
      })
    });

    updateStep(3, 'done');

    // Step 4: Process results
    updateStep(4, 'active');
    updateLoadingStep('Processing results...', 75);
    await sleep(600);

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Analysis failed');
    }

    updateLoadingStep('Complete!', 100);
    updateStep(4, 'done');
    await sleep(500);

    console.log('Analysis data:', data);

    // Store data in chrome.storage for results page
    await chrome.storage.local.set({ analysisResults: data });

    // Open results in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL('results.html')
    });

    // Close popup after a moment
    setTimeout(() => window.close(), 500);

  } catch (error) {
    console.error('Analysis error:', error);
    showError(`Analysis failed: ${error.message}`);
  }
}

// Helper function for delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Update step visual state
function updateStep(stepNum, state) {
  const stepEl = document.getElementById(`step${stepNum}`);
  if (!stepEl) return;
  
  const dot = stepEl.querySelector('.step-dot');
  
  stepEl.classList.remove('active', 'done');
  
  if (state === 'active') {
    stepEl.classList.add('active');
  } else if (state === 'done') {
    stepEl.classList.add('done');
    if (dot) dot.textContent = '✓';
  }
}

  // Main optimization function
  async function optimizeResume(mode) {
    // Validate mode
    if (!mode) {
      showError('Invalid mode');
      return;
    }

    // Get job description based on mode
    let jobDescription = null;
    let jobUrl = null;

    if (mode === 'paste') {
      if (!jobDescriptionInput) {
        showError('Job description input not found');
        return;
      }

      jobDescription = jobDescriptionInput.value.trim();

      if (!jobDescription) {
        showError('Please paste a job description');
        return;
      }

      if (jobDescription.length < 100) {
        showError('Job description is too short. Please paste the complete description (at least 100 characters).');
        return;
      }

      // Get current tab URL for tracking in Excel
      jobUrl = await getCurrentTabUrl();
      console.log('📋 Paste mode - Current tab URL:', jobUrl);

    } else if (mode === 'url') {
      jobUrl = await getCurrentTabUrl();

      if (!jobUrl) {
        showError('Could not get current page URL');
        return;
      }
    }

    // Show loading state
    showState('loading');
    updateLoadingStep('Preparing...', 0);

    // Check if this is analysis or optimization
    if (currentAction === 'analyze') {
      return await handleAnalyze(jobDescription, jobUrl);
    }

    // Continue with optimization...
    try {
      // Step 1: Get settings (0-10%)
      updateLoadingStep('⚙️ Loading configuration...', 5);

      const settings = await chrome.storage.local.get([
        'aiProvider', 'geminiKey1', 'geminiKey2', 'geminiKey3',
        'chatgptApiKey', 'chatgptKey2', 'chatgptKey3'
      ]);

      if (!settings.aiProvider) {
        throw new Error('AI provider not configured');
      }

      updateLoadingStep('✅ Configuration loaded', 10);

      // Build request body
      const requestBody = {
        aiProvider: settings.aiProvider,
        geminiKey1: settings.geminiKey1 || null,
        geminiKey2: settings.geminiKey2 || null,
        geminiKey3: settings.geminiKey3 || null,
        chatgptApiKey: settings.chatgptApiKey || null,
        chatgptKey2: settings.chatgptKey2 || null,
        chatgptKey3: settings.chatgptKey3 || null,
      };

      if (mode === 'paste') {
        requestBody.manualJobDescription = jobDescription;
        requestBody.jobUrl = null;
        requestBody.currentPageUrl = jobUrl || 'Manual Input';
        console.log('📋 Sending paste mode request with URL:', requestBody.currentPageUrl);
      } else {
        requestBody.manualJobDescription = null;
        requestBody.jobUrl = jobUrl;
        requestBody.currentPageUrl = jobUrl;
        console.log('🌐 Sending URL mode request with URL:', requestBody.currentPageUrl);
      }

      // Step 2: Send request and wait for FULL backend response
      // NOTE: response.json() must be called BEFORE any fake delays
      // because the fit check gate (WARN/NO) returns early from the backend
      // and we need to intercept it immediately — not after 1.4s of setTimeout
      updateLoadingStep('📄 Sending request to server...', 15);

      const response = await fetch(`${BACKEND_URL}/api/optimize-resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      // Parse JSON immediately — before any fake progress delays
      const data = await response.json();

      // ── Fit Check Gate ─────────────────────────────────────────────────────
      // Must happen RIGHT after parsing — backend returns early for WARN/NO
      // and does NOT run the full optimization pipeline

      if (data.fitCheckFailed === true) {
        // Hard blocker (APPLY: NO) — stop entirely, show blocked UI
        showFitCheckBlocked(data);
        return;
      }

      if (data.requiresConfirmation === true) {
        // Soft warning (APPLY: WARN) — pause, ask user to confirm
        showFitCheckWarn(data, requestBody, mode);
        return;
      }
      // ───────────────────────────────────────────────────────────────────────

      if (!response.ok) {
        throw new Error(data.error || data.details || 'Optimization failed');
      }

      // Fit check passed (APPLY: YES) — now show fake progress
      // Safe to do this AFTER parsing since the full optimization already ran
      updateLoadingStep('✅ Job description extracted', 25);

      updateLoadingStep('🔍 Analyzing job requirements...', 30);
      await new Promise(resolve => setTimeout(resolve, 800));

      updateLoadingStep('🎯 Selecting best resume type...', 40);
      await new Promise(resolve => setTimeout(resolve, 600));

      updateLoadingStep('✅ Analysis complete', 50);

      // Step 4: Simulate optimization phase (50-75%)
      updateLoadingStep('⚡ Generating optimization points...', 55);
      await new Promise(resolve => setTimeout(resolve, 700));
      
      updateLoadingStep('✨ Adding missing JD skills...', 65);
      await new Promise(resolve => setTimeout(resolve, 600));
      
      updateLoadingStep('✅ Optimization complete', 75);

      // Step 5: Simulate generation phase (75-100%)
      updateLoadingStep('📝 Creating optimized resume...', 80);
      await new Promise(resolve => setTimeout(resolve, 800));
      
      updateLoadingStep('☁️ Uploading to Google Drive...', 90);
      await new Promise(resolve => setTimeout(resolve, 600));
      
      updateLoadingStep('✅ Resume generated!', 100);

      // Brief pause before showing success
      await new Promise(resolve => setTimeout(resolve, 500));


      // Show success state
      showSuccess(data);

    } catch (error) {
      console.error('Optimization error:', error);
      showError(error.message || 'An error occurred');
    }
  }

  // Show success state
  function showSuccess(data) {
    console.log('✅ Success data:', data);
    showState('success');

    // Update optimization count
    if (optimizationCount && data.optimizationPoints) {
      optimizationCount.textContent = `${data.optimizationPoints} optimization points applied`;
    }

    // Update company name
    const companyEl = document.getElementById('companyName');
    if (companyEl) {
      companyEl.textContent = data.companyName || data.company || 'N/A';
    }

    // Update position
    const positionEl = document.getElementById('positionName');
    if (positionEl) {
      positionEl.textContent = data.position || 'N/A';
    }

    // Update resume type (NEW)
    const resumeTypeEl = document.getElementById('resumeType');
    if (resumeTypeEl) {
      resumeTypeEl.textContent = data.resumeType || data.selectedResume || 'Full Stack';
    }

    // Update file name
    if (data.fileName) {
      const fileNameEl = document.getElementById('fileName');
      if (fileNameEl) fileNameEl.textContent = `📄 ${data.fileName}`;
    }

    // Update links
    if (data.links) {
      if (viewLink && data.links.editInGoogleDocs) {
        viewLink.href = data.links.editInGoogleDocs;
      }

      if (pdfLink && data.links.downloadPDF) {
        pdfLink.href = data.links.downloadPDF;
      }

      // Optional: tracking sheet
      const trackingLink = document.getElementById('trackingSheetLink');
      if (trackingLink && data.links.trackingSheet) {
        trackingLink.href = data.links.trackingSheet;
        trackingLink.style.display = 'block';
      }
    }

    // =====================================================
    // AUTO APPLY BUTTON — Show after successful optimization
    // =====================================================
    const autoApplyBtn = document.getElementById('autoApplyBtn');
    if (autoApplyBtn && data.links && data.links.editInGoogleDocs) {
      autoApplyBtn.style.display = 'block';
      autoApplyBtn.onclick = async () => {
        const jdUrl = await getCurrentTabUrl();
        const resumeLink = data.links.editInGoogleDocs;
        const company = data.companyName || data.company || '';
        const position = data.position || '';

        autoApplyBtn.textContent = 'Launching Bot...';
        autoApplyBtn.disabled = true;

        try {
          await fetch('http://localhost:3000/api/auto-apply/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              trigger: 'extension',
              jdUrl: jdUrl || '',
              resumeLink: resumeLink,
              jobDescription: '',
              companyName: company,
              position: position,
              aiProvider: 'chatgpt'
            })
          });
        } catch (e) {
          console.error('Failed to start bot:', e);
        }

        chrome.tabs.create({
          url: 'http://localhost:3000/auto-apply/live'
        });
      };
    }
  }

  // Show error state
  function showError(message) {
    console.error('❌ Error:', message);
    showState('error');

    if (errorMessage) {
      // Make error messages more helpful
      let displayMessage = message || 'An unknown error occurred';
      
      if (message.includes('fetch') || message.includes('Failed to fetch')) {
        displayMessage = '🔌 Cannot connect to server. Please make sure the backend is running on http://localhost:3000';
      } else if (message.includes('timeout') || message.includes('timed out')) {
        displayMessage = '⏱️ Request timed out. The server might be processing a large job description. Please try again.';
      } else if (message.includes('API') || message.includes('key')) {
        displayMessage = '🔑 API key error. Please check your AI provider settings.';
      } else if (message.includes('too large')) {
        displayMessage = '📄 Job description is too large. Please try using Manual Input mode instead.';
      } else if (message.includes('not configured')) {
        displayMessage = '⚙️ AI provider not configured. Please set up your API keys in Settings.';
      }
      
      errorMessage.textContent = displayMessage;
    }
  }

});

// =====================================================
// FIT CHECK HANDLERS
// =====================================================

// Called when backend returns fitCheckFailed: true (hard NO)
function showFitCheckBlocked(data) {
  const fitCheck = data.fitCheck || {};

  const reasonEl  = document.getElementById('fitBlockReason');
  const detailEl  = document.getElementById('fitBlockDetail');
  const backBtn   = document.getElementById('fitBlockBack');

  if (reasonEl) reasonEl.textContent = fitCheck.reason || 'This role is not a match.';
  if (detailEl) {
    detailEl.innerHTML =
      `<strong>Blocker:</strong> ${fitCheck.blocker || 'Unknown'}<br>` +
      `<strong>Fit Score:</strong> ${fitCheck.fitScore ?? '—'}/100<br><br>` +
      `No resume changes can overcome this. Save your API calls for better-matched roles.`;
  }

  // Show blocked card, hide warn card
  const blocked = document.getElementById('fitCheckBlocked');
  const warn    = document.getElementById('fitCheckWarn');
  if (blocked) blocked.style.display = 'block';
  if (warn)    warn.style.display    = 'none';

  // Wire back button
  if (backBtn) {
    backBtn.onclick = () => {
      currentMode   = null;
      currentAction = 'optimize';
      showState('actionSelection');
    };
  }

  showState('fitCheck');
}

// Called when backend returns requiresConfirmation: true (WARN)
function showFitCheckWarn(data, originalRequestBody, mode) {
  const fitCheck = data.fitCheck || {};

  const reasonEl  = document.getElementById('fitWarnReason');
  const detailEl  = document.getElementById('fitWarnDetail');
  const scoreEl   = document.getElementById('fitScorePill');
  const proceedBtn = document.getElementById('fitWarnProceed');
  const backBtn   = document.getElementById('fitWarnBack');

  if (reasonEl) reasonEl.textContent = fitCheck.reason || 'This role has some concerns.';
  if (detailEl) {
    detailEl.innerHTML =
      `<strong>Concern:</strong> ${fitCheck.blocker || 'Weak stack or domain match'}<br><br>` +
      `Resume will still be generated and optimized. Just be prepared for a lower response rate.`;
  }
  if (scoreEl) {
    const score = fitCheck.fitScore ?? 0;
    scoreEl.textContent = `Fit Score: ${score}/100`;
    // Color by score
    if (score >= 60) {
      scoreEl.style.background = '#fefce8';
      scoreEl.style.color = '#854d0e';
    } else {
      scoreEl.style.background = '#fef2f2';
      scoreEl.style.color = '#991b1b';
      scoreEl.style.borderColor = '#fca5a5';
    }
  }

  // Show warn card, hide blocked card
  const blocked = document.getElementById('fitCheckBlocked');
  const warn    = document.getElementById('fitCheckWarn');
  if (blocked) blocked.style.display = 'none';
  if (warn)    warn.style.display    = 'block';

  // Wire "Proceed Anyway" — re-send request with forceApply + sessionId
  if (proceedBtn) {
    proceedBtn.onclick = async () => {
      proceedBtn.disabled = true;
      proceedBtn.textContent = 'Generating resume...';

      try {
        const forceBody = {
          ...originalRequestBody,
          forceApply:    true,
          resumeSessionId: data.sessionId || null
        };

        showState('loading');
        updateLoadingStep('⚡ Proceeding with optimization...', 10);

        const res = await fetch(`${BACKEND_URL}/api/optimize-resume`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(forceBody)
        });

        updateLoadingStep('✅ Resume optimizing...', 50);
        const result = await res.json();

        if (!res.ok) throw new Error(result.error || result.details || 'Optimization failed');

        updateLoadingStep('✅ Resume generated!', 100);
        await new Promise(r => setTimeout(r, 500));
        showSuccess(result);

      } catch (err) {
        showError(err.message || 'Optimization failed after confirmation');
      }
    };
  }

  // Wire "Back"
  if (backBtn) {
    backBtn.onclick = () => {
      currentMode   = null;
      currentAction = 'optimize';
      showState('actionSelection');
    };
  }

  showState('fitCheck');
}

// END OF FILE