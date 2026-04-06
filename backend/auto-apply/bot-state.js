const EventEmitter = require('events');

const STATES = {
  IDLE:            'idle',
  DETECTING:       'detecting',
  CLICKING_APPLY:  'clicking_apply',
  SCANNING:        'scanning',
  AI_THINKING:     'ai_thinking',
  FILLING:         'filling',
  PAUSED:          'paused',
  REVIEWING:       'reviewing',
  WAITING_SUBMIT:  'waiting_submit',
  STUCK:           'stuck',
  DONE:            'done',
  ERROR:           'error'
};

class BotState extends EventEmitter {
  constructor() {
    super();
    this.state       = STATES.IDLE;
    this.sessionId   = null;
    this.companyName = '';
    this.position    = '';
    this.atsType     = '';
    this.currentPage = 0;
    this.totalPages  = 0;
    this.currentField = null;
    this.fields      = [];
    this.filled      = [];
    this.flagged     = [];
    this.log         = [];
    this.memory      = []; // Agent memory — every step: {step, pageUrl, pageTitle, read, aiResponse, actions, results}
    this.startedAt   = null;
    this.error       = null;
    this.stuckReason = null;
    this.stuckTimer  = null;
    this._previousState = null;
    this._confirmResolve = null;
    this._resumeResolve  = null;
  }

  start({ sessionId, companyName, position }) {
    this.state       = STATES.DETECTING;
    this.sessionId   = sessionId;
    this.companyName = companyName;
    this.position    = position;
    this.currentPage = 0;
    this.totalPages  = 0;
    this.currentField = null;
    this.fields      = [];
    this.filled      = [];
    this.flagged     = [];
    this.log         = [];
    this.memory      = [];
    this.startedAt   = new Date();
    this.error       = null;
    this.stuckReason = null;
    this._previousState = null;
    this._confirmResolve = null;
    this._resumeResolve  = null;
    this._emit('Bot started');
  }

  addMemory(entry) {
    this.memory.push({
      ...entry,
      timestamp: new Date().toISOString(),
      step: this.memory.length + 1
    });
  }

  getMemorySummary() {
    return this.memory.map(m =>
      `Step ${m.step} (${m.pageTitle || m.pageUrl || ''}): ${m.actionsCount || 0} actions, ${m.filledCount || 0} filled`
    ).join('\n');
  }

  setATS(atsType) {
    this.atsType = atsType;
    this._emit(`ATS detected: ${atsType}`);
  }

  clickingApply() {
    this.state = STATES.CLICKING_APPLY;
    this._emit('Looking for Apply button...');
  }

  scanning(pageNum) {
    this.state       = STATES.SCANNING;
    this.currentPage = pageNum;
    this.currentField = null;
    this._emit(`Scanning page ${pageNum}...`);
  }

  aiThinking() {
    this.state = STATES.AI_THINKING;
    this._emit('AI is analyzing fields...');
  }

  filling() {
    this.state = STATES.FILLING;
    this._emit('Filling fields...');
  }

  setCurrentField(field) {
    this.currentField = field;
    this._emit(`Filling: "${field.label}" → ${field.answer || ''}`);
  }

  fieldFilled(field) {
    this.filled.push(field);
    this._emit(`Filled: ${field.label} → "${field.answer || ''}"`);
  }

  fieldFlagged(field, reason) {
    this.flagged.push({ ...field, reason });
    this._emit(`Flagged: ${field.label} — ${reason}`);
  }

  pause(reason = 'Manual pause') {
    if (this.state !== STATES.IDLE && this.state !== STATES.DONE && this.state !== STATES.ERROR) {
      this._previousState = this.state;
      this.state = STATES.PAUSED;
      this._emit(`Paused: ${reason}`);
      return true;
    }
    return false;
  }

  resume() {
    if (this.state === STATES.PAUSED || this.state === STATES.STUCK) {
      this.state = STATES.SCANNING;
      this.stuckReason = null;
      if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
      this._emit('Resumed — re-reading page');
      // Resolve whichever promise is waiting (resume OR confirm)
      if (this._resumeResolve) {
        this._resumeResolve('resumed');
        this._resumeResolve = null;
      }
      if (this._confirmResolve) {
        this._confirmResolve('resumed');
        this._confirmResolve = null;
      }
      return true;
    }
    return false;
  }

  review(pageNum) {
    this.state = STATES.REVIEWING;
    this._emit(`Page ${pageNum} filled — waiting for your review`);
  }

  confirm() {
    if (this.state === STATES.REVIEWING || this.state === STATES.PAUSED) {
      this.state = STATES.SCANNING;
      this._emit('User confirmed — proceeding');
      if (this._confirmResolve) {
        this._confirmResolve();
        this._confirmResolve = null;
      }
      return true;
    }
    return false;
  }

  waitingSubmit() {
    this.state = STATES.WAITING_SUBMIT;
    this._emit('All pages filled! Please click Submit in the browser');
  }

  setStuck(reason) {
    this._previousState = this.state;
    this.state = STATES.STUCK;
    this.stuckReason = reason;
    this._emit(`STUCK: ${reason}`);

    const timeoutMs = (parseInt(process.env.BOT_TIMEOUT_MINUTES) || 10) * 60 * 1000;
    this.stuckTimer = setTimeout(() => {
      if (this.state === STATES.STUCK) {
        this.setError('Stuck timeout exceeded — bot stopped automatically');
      }
    }, timeoutMs);
  }

  done(message = 'Application submitted successfully') {
    this.state = STATES.DONE;
    this.stuckReason = null;
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
    this._emit(message);
  }

  setError(message) {
    this.state = STATES.ERROR;
    this.error = message;
    this.stuckReason = null;
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
    this._emit(`Error: ${message}`);
  }

  stop() {
    this.state = STATES.IDLE;
    this.stuckReason = null;
    if (this.stuckTimer) { clearTimeout(this.stuckTimer); this.stuckTimer = null; }
    if (this._confirmResolve) { this._confirmResolve('stopped'); this._confirmResolve = null; }
    if (this._resumeResolve)  { this._resumeResolve('stopped');  this._resumeResolve  = null; }
    this._emit('Bot stopped');
  }

  waitForConfirm() {
    return new Promise((resolve) => { this._confirmResolve = resolve; });
  }

  waitForResume() {
    return new Promise((resolve) => { this._resumeResolve = resolve; });
  }

  async waitForUnpause() {
    while (this.state === STATES.PAUSED) {
      await new Promise(r => { this._resumeResolve = r; });
    }
  }

  _emit(message) {
    const entry = { time: new Date().toLocaleTimeString('en-US', { hour12: false }), message };
    this.log.push(entry);
    if (this.log.length > 200) this.log = this.log.slice(-100);
    console.log(`[${this.state.toUpperCase()}] ${message}`);
    this.emit('update', this.snapshot());
  }

  snapshot() {
    return {
      state:        this.state,
      sessionId:    this.sessionId,
      companyName:  this.companyName,
      position:     this.position,
      atsType:      this.atsType,
      currentPage:  this.currentPage,
      totalPages:   this.totalPages,
      currentField: this.currentField,
      filled:       this.filled.length,
      flagged:      this.flagged.length,
      flaggedList:  this.flagged,
      log:          this.log.slice(-50),
      memory:       this.memory.slice(-10),
      memorySteps:  this.memory.length,
      startedAt:    this.startedAt,
      error:        this.error,
      stuckReason:  this.stuckReason
    };
  }

  isRunning() {
    return ![STATES.IDLE, STATES.DONE, STATES.ERROR].includes(this.state);
  }

  isBusy() {
    return this.isRunning() && this.state !== STATES.PAUSED && this.state !== STATES.STUCK;
  }
}

const botState = new BotState();

module.exports = { botState, STATES };
