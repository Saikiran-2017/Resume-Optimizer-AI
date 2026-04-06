// =====================================================
// CHECKPOINT SYSTEM
// Saves each pipeline step result to PostgreSQL
// If a step fails, resume from last successful checkpoint
// File: checkpoint.js — place next to server.js
// =====================================================

// -------------------------------------------------------
// DB SETUP — run once on startup
// -------------------------------------------------------
async function createCheckpointTable(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS optimization_checkpoints (
        id            SERIAL PRIMARY KEY,
        session_id    VARCHAR(64) UNIQUE NOT NULL,
        step          INTEGER NOT NULL DEFAULT 0,
        job_post_url  TEXT,
        company_name  TEXT,
        position      TEXT,
        job_description TEXT,
        ats_analysis  JSONB,
        resume_selection JSONB,
        company_context  JSONB,
        original_resume  TEXT,
        optimization_points TEXT,
        suggested_filename  TEXT,
        optimized_resume    TEXT,
        resume_type   TEXT,
        ai_provider   TEXT,
        status        VARCHAR(20) DEFAULT 'in_progress',
        error_message TEXT,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ Checkpoint table ready');
  }
  
  // -------------------------------------------------------
  // STEP NUMBERS — what each number means
  // -------------------------------------------------------
  const STEPS = {
    STARTED:              1,
    JD_FETCHED:           2,
    JOB_DETAILS:          3,
    ATS_DETECTED:         4,
    RESUME_SELECTED:      5,
    COMPANY_CONTEXT:      6,
    RESUME_FETCHED:       7,
    OPTIMIZATION_POINTS:  8,
    RESUME_REWRITTEN:     9,
    UPLOADED:             10,
    LOGGED:               11,
    COMPLETE:             12
  };
  
  // -------------------------------------------------------
  // SAVE checkpoint after each step
  // -------------------------------------------------------
  async function saveCheckpoint(pool, sessionId, step, data = {}) {
    // $1 = sessionId, $2 = step, then data values start at $3
    const updateFields = [];
    const values = [sessionId, parseInt(step)];
    let idx = 3;
  
    // step and updated_at always go into the UPDATE clause
    updateFields.push(`step = $2`);
    updateFields.push(`updated_at = NOW()`);
  
    const columnMap = {
      jobPostUrl:          'job_post_url',
      companyName:         'company_name',
      position:            'position',
      jobDescription:      'job_description',
      atsAnalysis:         'ats_analysis',
      resumeSelection:     'resume_selection',
      companyContext:      'company_context',
      originalResume:      'original_resume',
      optimizationPoints:  'optimization_points',
      suggestedFilename:   'suggested_filename',
      optimizedResume:     'optimized_resume',
      resumeType:          'resume_type',
      aiProvider:          'ai_provider',
      status:              'status',
      errorMessage:        'error_message'
    };
  
    for (const [key, col] of Object.entries(columnMap)) {
      if (data[key] !== undefined) {
        updateFields.push(`${col} = $${idx++}`);
        if (['atsAnalysis', 'resumeSelection', 'companyContext'].includes(key)) {
          values.push(typeof data[key] === 'object' ? JSON.stringify(data[key]) : data[key]);
        } else {
          values.push(data[key]);
        }
      }
    }
  
    await pool.query(
      `INSERT INTO optimization_checkpoints (session_id, step)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET ${updateFields.join(', ')}`,
      values
    );
  
    console.log(`  💾 Checkpoint saved: step ${step} (${getStepName(step)})`);
  }
  
  // -------------------------------------------------------
  // LOAD checkpoint — returns null if not found
  // -------------------------------------------------------
  async function loadCheckpoint(pool, sessionId) {
    const result = await pool.query(
      `SELECT * FROM optimization_checkpoints WHERE session_id = $1`,
      [sessionId]
    );
  
    if (result.rows.length === 0) return null;
  
    const row = result.rows[0];
  
    // Parse JSONB fields back to objects
    return {
      sessionId:           row.session_id,
      step:                row.step,
      jobPostUrl:          row.job_post_url,
      companyName:         row.company_name,
      position:            row.position,
      jobDescription:      row.job_description,
      atsAnalysis:         row.ats_analysis,
      resumeSelection:     row.resume_selection,
      companyContext:      row.company_context,
      originalResume:      row.original_resume,
      optimizationPoints:  row.optimization_points,
      suggestedFilename:   row.suggested_filename,
      optimizedResume:     row.optimized_resume,
      resumeType:          row.resume_type,
      aiProvider:          row.ai_provider,
      status:              row.status,
      errorMessage:        row.error_message,
      createdAt:           row.created_at,
      updatedAt:           row.updated_at
    };
  }
  
  // -------------------------------------------------------
  // MARK complete or failed
  // -------------------------------------------------------
  async function markComplete(pool, sessionId) {
    await pool.query(
      `UPDATE optimization_checkpoints
       SET status = 'complete', step = $1, updated_at = NOW()
       WHERE session_id = $2`,
      [STEPS.COMPLETE, sessionId]
    );
    console.log(`  ✅ Checkpoint marked complete`);
  }
  
  async function markFailed(pool, sessionId, errorMessage) {
    await pool.query(
      `UPDATE optimization_checkpoints
       SET status = 'failed', error_message = $1, updated_at = NOW()
       WHERE session_id = $2`,
      [errorMessage, sessionId]
    );
    console.log(`  ❌ Checkpoint marked failed: ${errorMessage}`);
  }
  
  // -------------------------------------------------------
  // GENERATE session ID from job URL + timestamp
  // Same URL retried within 2 hours = same session ID
  // -------------------------------------------------------
  function generateSessionId(jobPostUrl, companyName) {
    const base = `${companyName || 'unknown'}_${jobPostUrl || 'manual'}`;
    // Hash-like: use base64 of string + hour bucket
    const hourBucket = Math.floor(Date.now() / (1000 * 60 * 60 * 2)); // 2-hour window
    const raw = `${base}_${hourBucket}`;
    return Buffer.from(raw).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 64);
  }
  
  // -------------------------------------------------------
  // GET step name for logging
  // -------------------------------------------------------
  function getStepName(step) {
    return Object.keys(STEPS).find(k => STEPS[k] === step) || `step_${step}`;
  }
  
  // -------------------------------------------------------
  // CLEANUP old checkpoints (run periodically)
  // -------------------------------------------------------
  async function cleanupOldCheckpoints(pool, daysOld = 7) {
    const result = await pool.query(
      `DELETE FROM optimization_checkpoints
       WHERE created_at < NOW() - INTERVAL '${daysOld} days'
       RETURNING id`
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Cleaned up ${result.rowCount} old checkpoints`);
    }
  }
  
  module.exports = {
    createCheckpointTable,
    saveCheckpoint,
    loadCheckpoint,
    markComplete,
    markFailed,
    generateSessionId,
    cleanupOldCheckpoints,
    STEPS
  };