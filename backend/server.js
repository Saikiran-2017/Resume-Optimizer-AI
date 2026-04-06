require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const {
  findRecruitersAndSendEmails
} = require('./recruiter-automation-v2');
const { fetchCompanyContext } = require('./company-context');
const {
  createCheckpointTable,
  saveCheckpoint,
  loadCheckpoint,
  markComplete,
  markFailed,
  generateSessionId,
  cleanupOldCheckpoints,
  STEPS
} = require('./checkpoint');
const { registerAutoApplyRoutes, createBotSessionsTable } = require('./auto-apply/routes');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// POSTGRESQL CONNECTION (Using DATABASE_URL)
// =====================================================

// Test connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
  } else {
    console.log('✅ Database connected:', res.rows[0].now);
  }
});

// Initialize Google APIs
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/oauth2callback'
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const docs = google.docs({ version: 'v1', auth: oauth2Client });
const drive = google.drive({ version: 'v3', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
// =====================================================
// SEPARATE GMAIL OAUTH CLIENT FOR RECRUITER EMAILS
// =====================================================
const gmailOAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'http://localhost:3000/oauth2callback-gmail'
);

gmailOAuth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

// Gmail uses SEPARATE auth client
const gmail = google.gmail({ version: 'v1', auth: gmailOAuth2Client });

// const ORIGINAL_RESUME_DOC_ID = process.env.ORIGINAL_RESUME_DOC_ID;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const TRACKING_SHEET_ID = process.env.TRACKING_SHEET_ID;

// ADD THESE 4 NEW LINES:

const FRONTEND_RESUME_DOC_ID = process.env.FRONTEND_RESUME_DOC_ID;
const FULLSTACK_RESUME_DOC_ID = process.env.FULLSTACK_RESUME_DOC_ID;

// AI Provider wrapper
async function generateAIContent(prompt, provider, apiKey) {
  if (provider === 'gemini') {
    return await generateWithGemini(prompt, apiKey);
  } else if (provider === 'chatgpt') {
    return await generateWithChatGPT(prompt, apiKey);
  } else {
    throw new Error('Invalid AI provider. Use "gemini" or "chatgpt"');
  }
}

// Gemini AI implementation
async function generateWithGemini(prompt, apiKey) {
  try {
    console.log('🔑 Using Gemini API key:', apiKey.substring(0, 10) + '...');
    console.log('🎯 Model: gemini-2.0-flash');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    console.log('📤 Sending request to Gemini...');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log('✅ Gemini response received:', text.substring(0, 100) + '...');
    return text;
  } catch (error) {
    console.error('❌ Gemini API Error Details:', {
      message: error.message,
      status: error.status,
      statusText: error.statusText
    });
    throw new Error(`Gemini API Error: ${error.message}`);
  }
}

// ChatGPT (OpenAI) implementation
async function generateWithChatGPT(prompt, apiKey) {
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        const waitMs = attempt * 3000; // 3s, 6s
        console.log(`  ⏳ Retry attempt ${attempt}/${maxRetries} — waiting ${waitMs/1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }

      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 4000
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000  // 2 min timeout — rewrite prompt is large
      });

      return response.data.choices[0].message.content;

    } catch (error) {
      lastError = error;
      const isRetryable = (
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'EPIPE' ||
        (error.response && error.response.status >= 500) ||
        (error.response && error.response.status === 429)
      );

      if (isRetryable && attempt < maxRetries) {
        console.log(`  ⚠️ Attempt ${attempt} failed (${error.code || error.response?.status}): ${error.message} — retrying...`);
        continue;
      }

      // Not retryable or out of retries
      if (error.response) {
        throw new Error(`ChatGPT API Error: ${error.response.data.error.message}`);
      }
      throw new Error(`ChatGPT API Error: ${error.message}`);
    }
  }

  throw new Error(`ChatGPT API Error after ${maxRetries} attempts: ${lastError.message}`);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// Helper: Load README files from local folder
function loadProjectReadmes() {
  try {
    console.log('📖 Loading project README files...');
    
    // Define paths to README files
    const resumeOptimizerPath = path.join(__dirname, 'project-readmes', 'Resume-Optimizer-AI-README.md');
    const cifar10Path = path.join(__dirname, 'project-readmes', 'CIFAR10-README.md');
    
    let resumeOptimizerContent = '';
    let cifar10Content = '';
    
    // Load Resume Optimizer AI README
    if (fs.existsSync(resumeOptimizerPath)) {
      resumeOptimizerContent = fs.readFileSync(resumeOptimizerPath, 'utf8');
      console.log(`✅ Loaded Resume Optimizer AI README (${resumeOptimizerContent.length} chars)`);
    } else {
      console.log('⚠️ Resume Optimizer AI README not found at:', resumeOptimizerPath);
      resumeOptimizerContent = 'README file not found';
    }
    
    // Load CIFAR-10 README
    if (fs.existsSync(cifar10Path)) {
      cifar10Content = fs.readFileSync(cifar10Path, 'utf8');
      console.log(`✅ Loaded CIFAR-10 README (${cifar10Content.length} chars)`);
    } else {
      console.log('⚠️ CIFAR-10 README not found at:', cifar10Path);
      cifar10Content = 'README file not found';
    }
    
    return {
      resumeOptimizerReadme: resumeOptimizerContent,
      cifar10Readme: cifar10Content
    };
    
  } catch (error) {
    console.error('❌ Error loading README files:', error.message);
    return {
      resumeOptimizerReadme: 'Error loading README',
      cifar10Readme: 'Error loading README'
    };
  }
}

// Helper: Build the optimization points prompt (shared by single + batch optimize)
function buildOptimizationPointsPrompt({ resumeType, originalResume, jobDescription, portalName, projectReadmes, companyContext }) {
  return `You are a senior resume strategist. Your job is to generate precise optimization points that will make this resume score 88-92% on ATS while looking completely human-written.
 
====================================================
INPUTS
====================================================
 
RESUME TYPE: ${resumeType}
 
CURRENT RESUME:
${originalResume}
 
JOB DESCRIPTION:
${jobDescription}
 
PORTAL: ${portalName}
 
Project Readmes:
${projectReadmes.resumeOptimizerReadme}
${projectReadmes.cifar10Readme}
 
====================================================
COMPANY CONTEXT
====================================================
 
PROBLEM TYPE: ${companyContext ? companyContext.problemType : 'unclear'}
WHAT THIS TEAM BUILDS: ${companyContext ? companyContext.whatTheyBuild : 'unclear'}
WHY THIS ROLE EXISTS NOW: ${companyContext ? companyContext.whyHiringNow : 'unclear'}
CURRENT PROJECT: ${companyContext ? companyContext.projectContext : 'unclear'}
TECH BEING REPLACED: ${companyContext ? companyContext.techBeingReplaced : 'unclear'}
DOMAIN LANGUAGE: ${companyContext ? companyContext.domainLanguage : 'unclear'}
BEST MATCH FROM LOKESH: ${companyContext ? companyContext.bestMatchFromLokesh : 'unclear'}
NARRATIVE FRAME: ${companyContext ? companyContext.narrativeFrame : 'unclear'}
 
====================================================
STEP 1 — DO THIS ANALYSIS BEFORE GENERATING ANY POINTS
====================================================
 
Read the JD carefully and extract:
 
REQUIRED_SKILLS: [every required/must-have technical skill from JD]
PREFERRED_SKILLS: [every preferred/nice-to-have skill from JD]
TOOLS_AND_TECH: [every tool, framework, library, platform mentioned]
 
Then check the current resume and identify:
MISSING_FROM_SKILLS_SECTION: [JD skills NOT present in current Skills section]
MISSING_FROM_BULLETS: [JD skills with no mention anywhere in experience or project bullets]
WEAK_IN_RESUME: [JD skills mentioned once but need more prominence]
 
Every skill in MISSING_FROM_SKILLS_SECTION must get an optimization point.
Every skill in MISSING_FROM_BULLETS must get an optimization point.
This guarantees 88%+ ATS score every time.
 
====================================================
STEP 2 — GENERATE OPTIMIZATION POINTS
====================================================
 
Generate 8-25+ points in this EXACT priority order:
1. Required skills missing from Skills section → ADD_SKILL point (highest priority)
2. Required skills missing from all bullets → ADD_SKILL point
3. Preferred skills missing from Skills section → ADD_SKILL point
4. Preferred skills missing from bullets → ADD_SKILL point
5. Bullet reordering for JD relevance → REORDER_BULLETS point
6. Domain language alignment using company context → MODIFY_BULLET point
7. Metric improvements → ENHANCE_METRIC point
 
GOALS:
✅ ALL required JD skills in Skills section AND at least one bullet
✅ ALL preferred JD skills in Skills section AND at least one bullet
✅ 88-92% ATS match — MINIMUM 85%, never below
✅ Every change 100% interview-defensible
✅ Human-written, not AI-generated
✅ Domain language from company context used to reframe bullets
Note: never add soft skills, domain keywords, or industry terms to the Skills section.
 
====================================================
SKILL ADDITION STRATEGY
====================================================
 
FOR EVERY MISSING SKILL — add in TWO places:
 
1. SKILLS SECTION
   - Fit into EXISTING categories first — minimize new categories
   - Only create new category if skill truly doesn't fit anywhere
   - Plain text, comma-separated, no bold
   - Category format: "Category Name & Related:" (use & not and)
   - Examples: "Machine Learning & AI:", "Cloud & DevOps:", "Testing & Quality Assurance:"
 
   Fitting into existing categories:
   - OAuth2, JWT, SAML → "Backend"
   - Redis, Memcached → "Databases & Messaging"
   - Prometheus, Grafana → "Testing, Monitoring & Security"
   - GraphQL → "Backend"
   - Tailwind, Sass → "Frontend"
 
   New category placement:
   - JD heavily emphasizes it → position 2-3 (HIGH)
   - JD mentions as nice-to-have → near end (LOW)
 
2. EXPERIENCE OR PROJECTS BULLET
   - PRIORITIZE PROJECTS for AI/ML, automation, full-stack side-project skills
   - Choose Experience for skills that fit actual work responsibilities
   - Pick the MOST REALISTIC company or project
   - Add naturally to existing bullet OR create new bullet
   - BOLD the skill name in bullets: "**Spring Boot**", "**Kafka**", "**React 18**"
   - Never bold in Skills section
 
   Realistic placement:
   - LPL Financial: Cloud, modern frameworks, fintech, market data, portfolio systems
   - Athenahealth: Healthcare tech, FHIR, compliance, data security
   - YES Bank: Payments, banking, security, transaction processing
   - Comcast: Media, streaming, content delivery, scalability
   - Resume Optimizer AI: Full-stack, AI/ML integration, Chrome extensions, Node.js, PostgreSQL, automation
   - CIFAR-10: PyTorch, TensorFlow, deep learning, CNNs, model optimization
 
SKILL ADDITION EXAMPLES:
 
❌ BAD: "Implemented microservices using Spring Boot, Kafka, Redis, Docker, Kubernetes"
✅ GOOD: "Built event-driven microservices using **Spring Boot** and **Apache Kafka**, processing 2M+ daily transactions with **Redis** caching for sub-200ms response times"
 
❌ BAD: "Worked with React, Angular, Vue, and Next.js for frontend"
✅ GOOD: "Migrated legacy Angular application to **React 18** with **TypeScript**, reducing bundle size by 40%"
 
Bold rules:
- ONLY bold skills that appear in the JD
- Bold the skill name only, not the surrounding phrase
- Never bold in Skills section
 
====================================================
DOMAIN ALIGNMENT
====================================================
 
Use company context to make bullets contextually relevant, not just keyword-matched.
 
1. LEAD WITH THE MATCH
   - Best matching company's most contextually relevant bullet → move to position 1
   - First 2 bullets should signal "I have done exactly what you are building"
 
2. USE THEIR DOMAIN LANGUAGE
   - Replace generic terms with their specific vocabulary
   - WRONG: "Processed financial transactions"
   - RIGHT: "Processed trade settlement events for broker-dealer accounts"
 
3. MATCH THE PROBLEM TYPE
   - MODERNIZATION → emphasize migration, legacy integration, refactoring
   - SCALING → emphasize throughput, performance, reliability metrics
   - GREENFIELD → emphasize architecture decisions, full ownership, building from scratch
   - INTEGRATION → emphasize external APIs, third-party systems, data feeds
 
4. CONTEXT NOT JUST TECH
   - WRONG: "Built Kafka event streaming pipeline"
   - RIGHT: "Built Kafka pipeline for real-time trade confirmation event processing"
 
====================================================
PROJECTS AS COMPETITIVE ADVANTAGE
====================================================
 
Two projects to use strategically:
1. Resume Optimizer AI — Full-stack Chrome extension, Node.js, PostgreSQL, Google APIs, AI/ML, automation
2. CIFAR-10 — PyTorch, TensorFlow, deep learning, CNNs, model optimization, training pipelines
 
Strategy:
- Identify JD skills weak or missing from work experience
- If skill fits Resume Optimizer AI scope → showcase it there
- If skill fits CIFAR-10 scope → showcase it there
- Projects prove you build real things outside work — highly valued
- Each project: 3-5 bullets, bold JD skills, include metrics
 
Examples:
- JD needs PyTorch/TensorFlow → CIFAR-10 is perfect
- JD needs Chrome extensions/PostgreSQL/REST APIs → Resume Optimizer AI is perfect
- JD needs Spring Boot/Kafka → already in work experience, reinforce only if heavily emphasized
 
====================================================
BULLET REORDERING
====================================================
 
Move most JD-relevant bullet to position #1 at each company.
Recruiters spend 6 seconds scanning — first 2 bullets decide everything.
 
Example — JD emphasizes Kafka:
Current: 1,2,3,4,5,6 → New: 3,1,2,5,4,6 (bullet 3 was about Kafka)
 
====================================================
HUMANIZATION RULES
====================================================
 
Action verbs — use variety:
- Architected, Built, Developed, Engineered, Created, Designed, Implemented, Established, Deployed
- "Implemented" MAX 3 times total in entire resume
- Never start consecutive bullets with same verb
 
Metrics — 40-50% of bullets only:
- Round numbers: 40%, 2M+, 99.9% (NOT 43.7%, 2.3M)
- Mix bullets with and without metrics
 
Language:
- Real tech terms: Spring Boot, Kafka, React, PostgreSQL
- NO buzzwords: "cutting-edge", "revolutionary", "synergized", "leveraged", "spearheaded"
- Write like an engineer talking to another engineer
 
====================================================
ABSOLUTE RULES — NEVER CHANGE THESE
====================================================
 
❌ Company names, dates, job titles
❌ Number of companies (keep all 4)
❌ Project names or core project technologies
❌ Certifications or Education
❌ Contact information
❌ Resume structure or section order
❌ Resume must not exceed 2 pages
 
====================================================
OPTIMIZATION POINT FORMAT
====================================================
 
POINT 1:
Type: ADD_SKILL
Skill: Apache Flink
Where_Skills: Databases & Messaging (existing category)
Where_Experience_Or_Project: LPL Financial, Bullet 3
Integration: "Extend existing Kafka bullet to mention **Flink** for stream processing with 500K events/sec throughput"
Bold: YES (Flink is from JD)
Priority: High
Reasoning: JD lists Flink as required skill; fits existing "Databases & Messaging" category; realistic since candidate has Kafka experience at LPL
 
POINT 2:
Type: REORDER_BULLETS
Section: Experience
Company: Athenahealth
Current_Order: 1,2,3,4,5
New_Order: 4,1,2,3,5
Reasoning: JD emphasizes FHIR APIs — move FHIR bullet to position 1
 
POINT 3:
Type: ADD_SKILL
Skill: TensorFlow, PyTorch
Where_Skills: AI & Data (existing category)
Where_Experience_Or_Project: Projects - CIFAR-10, Bullet 1
Integration: "Update first bullet to emphasize both **PyTorch** (primary) and **TensorFlow** for model experimentation"
Bold: YES (both from JD)
Priority: High
Reasoning: JD requires deep learning frameworks; CIFAR-10 is the perfect place — more credible than adding to work experience
 
POINT 4:
Type: MODIFY_BULLET
Section: Experience
Company: LPL Financial
Bullet: 2
Current: "Built RESTful APIs integrating market data feeds"
New: "Built RESTful APIs integrating **Bloomberg** market data feeds for real-time portfolio pricing across 19K advisor accounts"
Bold: YES (Bloomberg from JD)
Priority: High
Reasoning: JD uses clearing/fintech domain language — reframe with their vocabulary
 
POINT 5:
Type: REORDER_BULLETS
Section: Projects
Project: Resume Optimizer AI
Current_Order: 1,2,3,4
New_Order: 2,1,3,4
Reasoning: JD heavily emphasizes PostgreSQL — move database bullet to position 1
 
====================================================
POINT TYPES
====================================================
 
1. ADD_SKILL — Add missing JD skill to Skills section AND (Experience OR Projects)
2. REORDER_BULLETS — Change bullet order at a company or project
3. MODIFY_BULLET — Update existing bullet to add skill or domain context
4. MERGE_BULLETS — Combine two bullets (reduces count by 1)
5. ENHANCE_METRIC — Make existing metric more specific or impressive
 
====================================================
QUALITY CHECKLIST — VERIFY BEFORE RETURNING
====================================================
 
□ Every REQUIRED JD skill has a point adding it to Skills section
□ Every REQUIRED JD skill has a point adding it to at least one bullet
□ Every PREFERRED JD skill has a point adding it to Skills section
□ Best matching company's most relevant bullet moved to position 1
□ Domain language from company context used in at least 2-3 bullet integrations
□ Projects section leveraged for AI/ML and full-stack skills
□ Every change is natural and interview-safe
□ No keyword stuffing
□ Would this score 88%+ on ATS?
□ Would a recruiter trust this resume?
 
====================================================
OUTPUT RULES
====================================================
 
Start directly with "POINT 1:" — no preamble, no commentary.
End with:
FILENAME: Lokesh_Para_[JobTitle]_[CompanyName]
 
Begin output:`;
}

// Helper: Extract company and position from job description
async function extractJobDetails(jobDescription, aiProvider, apiKey) {
  try {
    console.log('🔍 Extracting company and position from job description...');
    console.log('🔍 JD Preview (first 500 chars):');
    console.log(jobDescription.substring(0, 500));
    console.log('...\n');

    const extractionPrompt = `You must extract ONLY the company name and job position from this job description.
  
  JOB DESCRIPTION:
  ${jobDescription.substring(0, 3000)}
  
  Your response must be EXACTLY in this format with nothing else:
  COMPANY: [company name here]
  POSITION: [job title here]
  
  Example:
  COMPANY: Microsoft
  POSITION: Senior Software Engineer
  
  Now extract the company and position from the job description above. Output ONLY those two lines.`;

    console.log('🔍 Calling AI for extraction...');
    const response = await generateAIContent(extractionPrompt, aiProvider, apiKey);

    console.log('\n🔍 FULL AI EXTRACTION RESPONSE:');
    console.log('═'.repeat(60));
    console.log(response);
    console.log('═'.repeat(60));
    console.log('\n');

    let company = 'N/A';
    let position = 'N/A';

    // Method 1: Try exact pattern match
    console.log('🔍 Trying regex extraction...');
    const companyMatch = response.match(/COMPANY:\s*(.+?)(?:\n|$)/i);
    if (companyMatch && companyMatch[1]) {
      company = companyMatch[1].trim();
      console.log(`   ✅ Regex found company: "${company}"`);
    } else {
      console.log('   ❌ Regex did NOT find company pattern');
    }

    const positionMatch = response.match(/POSITION:\s*(.+?)(?:\n|$)/i);
    if (positionMatch && positionMatch[1]) {
      position = positionMatch[1].trim();
      console.log(`   ✅ Regex found position: "${position}"`);
    } else {
      console.log('   ❌ Regex did NOT find position pattern');
    }

    // Method 2: If still N/A, try parsing line by line
    if (company === 'N/A' || position === 'N/A') {
      console.log('⚠️ Regex failed, trying line-by-line parsing...');
      const lines = response.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        console.log(`   Line ${i}: "${line}"`);

        if (company === 'N/A' && line.toLowerCase().includes('company')) {
          const parts = line.split(':');
          if (parts.length >= 2) {
            company = parts.slice(1).join(':').trim();
            console.log(`   ✅ Found company in line ${i}: "${company}"`);
          }
        }

        if (position === 'N/A' && line.toLowerCase().includes('position')) {
          const parts = line.split(':');
          if (parts.length >= 2) {
            position = parts.slice(1).join(':').trim();
            console.log(`   ✅ Found position in line ${i}: "${position}"`);
          }
        }
      }
    }

    // Method 3: Extract from original JD if AI completely failed
    if (company === 'N/A' || position === 'N/A') {
      console.log('⚠️ AI extraction completely failed, parsing JD directly...');
      const jdLines = jobDescription.split('\n').slice(0, 30);

      for (let i = 0; i < jdLines.length; i++) {
        const line = jdLines[i].trim();

        if (!line || line.length < 3) continue;

        console.log(`   JD Line ${i}: "${line.substring(0, 80)}..."`);

        // Find position (usually first meaningful line with job-related keywords)
        if (position === 'N/A' && line.length > 5 && line.length < 100) {
          const jobKeywords = /engineer|developer|architect|manager|analyst|specialist|lead|senior|director|consultant|designer/i;
          if (jobKeywords.test(line) && !line.toLowerCase().includes('company') && !line.toLowerCase().includes('location')) {
            position = line;
            console.log(`   ✅ Found position from JD line ${i}: "${position}"`);
          }
        }

        // Find company
        if (company === 'N/A') {
          // Try common patterns
          if (line.match(/^Company:\s*(.+)/i)) {
            company = line.match(/^Company:\s*(.+)/i)[1].trim();
            console.log(`   ✅ Found company from JD line ${i}: "${company}"`);
          } else if (line.match(/^Employer:\s*(.+)/i)) {
            company = line.match(/^Employer:\s*(.+)/i)[1].trim();
            console.log(`   ✅ Found company from JD line ${i}: "${company}"`);
          } else if (line.match(/\bat\s+([A-Z][A-Za-z\s&.]{2,30})(?:\s|$)/)) {
            const match = line.match(/\bat\s+([A-Z][A-Za-z\s&.]{2,30})(?:\s|$)/);
            company = match[1].trim();
            console.log(`   ✅ Found company from JD line ${i}: "${company}"`);
          }
        }

        if (company !== 'N/A' && position !== 'N/A') {
          break;
        }
      }
    }

    console.log('\n📊 FINAL EXTRACTION RESULT:');
    console.log(`   🏢 Company: "${company}"`);
    console.log(`   💼 Position: "${position}"\n`);

    return { company, position };

  } catch (error) {
    console.error('❌ Failed to extract job details:', error.message);
    console.error('Error stack:', error.stack);
    return { company: 'N/A', position: 'N/A' };
  }
}

// Helper: AI-powered ATS detection and strategy
async function detectATSAndStrategy(jobUrl, jobDescription, aiProvider, apiKey) {
  try {
    console.log('🤖 AI analyzing job portal and creating optimization strategy...');

    const detectionPrompt = `You are an expert ATS (Applicant Tracking System) analyst. Analyze this job posting and determine the best optimization strategy.

JOB URL: ${jobUrl || 'Manual Input - No URL provided'}

JOB DESCRIPTION:
${jobDescription.substring(0, 4000)}

YOUR TASK:
1. Detect which ATS/job portal system this is (Workday, Greenhouse, Lever, LinkedIn, Indeed, Taleo, company career page, etc.)
2. Understand that portal's scoring algorithm and preferences
3. Create a winning strategy to achieve 100% match and get shortlisted

ANALYZE:
- URL patterns and domain
- Job description formatting and structure
- Application portal indicators
- Company size and typical ATS choice
- Any mentions of application systems in footer/header
- Portal-specific features (Easy Apply, Quick Apply, etc.)

RESPOND IN THIS FORMAT:

PORTAL: [Name of the ATS/portal system]

PORTAL_TYPE: [Workday / Greenhouse / Lever / LinkedIn / Indeed / Taleo / Custom Career Page / Other]

CONFIDENCE: [High / Medium / Low]

ALGORITHM_INSIGHTS:
[Explain how this portal's AI/algorithm scores resumes - what does it prioritize? Keywords? Metrics? Experience? Format?]

WINNING_STRATEGY:
[Detailed strategy on how to optimize resume specifically for THIS portal to guarantee shortlisting - be specific about what works best for this system]

CRITICAL_SUCCESS_FACTORS:
[List 5-7 most important things that will make resume score 100% on this portal]

AVOID:
[What NOT to do for this specific portal]

Think deeply and give your absolute best analysis. A candidate's career depends on this!`;

    const analysis = await generateAIContent(detectionPrompt, aiProvider, apiKey);
    console.log('✅ AI ATS Analysis Complete');
    console.log('📊 Analysis:\n', analysis);

    // Extract portal name from response
    const portalMatch = analysis.match(/PORTAL:\s*(.+?)(?:\n|$)/i);
    const portalName = portalMatch ? portalMatch[1].trim() : 'Job Portal';

    return {
      portalName: portalName,
      fullAnalysis: analysis
    };

  } catch (error) {
    console.log('⚠️ ATS detection failed:', error.message);
    return {
      portalName: 'Job Portal',
      fullAnalysis: 'Unable to detect specific portal. Optimizing for universal ATS compatibility.'
    };
  }
}



// Helper: AI-powered resume selection based on JD analysis
async function selectBestResume(jobDescription, aiProvider, apiKey) {
  try {
    console.log('🎯 Asking AI which resume is best for this JD...');

    // Replace the selectBestResume function's selectionPrompt with this:

const selectionPrompt = `You are an expert resume strategist. Analyze this job description and determine which specialized resume would be BEST to use as the base for optimization.

JOB DESCRIPTION:
${jobDescription.substring(0, 4000)}

AVAILABLE RESUME TYPES (ONLY 2 OPTIONS):
1. FRONTEND Resume: Specialized for pure frontend/UI roles
   - Use when: 70%+ of JD focuses on React, Angular, Vue, UI/UX, CSS, frontend frameworks
   - Examples: "Frontend Developer", "UI Engineer", "React Developer"

2. FULLSTACK Resume: Balanced backend + frontend + cloud
   - Use when: Role requires backend AND frontend, or unclear focus, or mentions full stack
   - Examples: "Full Stack Developer", "Software Engineer", "Java Developer"

ANALYSIS INSTRUCTIONS:
1. Read job title carefully
2. Count frontend vs backend vs cloud mentions in requirements
3. Determine PRIMARY daily focus (what will candidate spend 60%+ time doing?)
4. When in doubt → choose FULLSTACK (it's safer)

SELECTION RULES:
- If JD says "Frontend Developer" or "React Developer" → FRONTEND
- If JD says "Full Stack" or lists both backend AND frontend → FULLSTACK  
- If JD is unclear or mixed → FULLSTACK
- If JD mentions Spring Boot, microservices, APIs heavily → FULLSTACK

RESPOND IN THIS EXACT FORMAT (no other text):

SELECTED_RESUME: [FRONTEND / FULLSTACK]

CONFIDENCE: [High / Medium / Low]

REASONING: [2-3 sentences explaining why this resume is the best choice]

KEY_SKILLS_MATCH: [List 3-5 key skills from JD that match this resume type]

Be decisive. Choose the resume that gives the candidate the BEST chance of getting an interview.`;
    const analysis = await generateAIContent(selectionPrompt, aiProvider, apiKey);
    console.log('📊 Resume Selection Analysis:\n', analysis);

    // Extract selected resume from response
    const resumeMatch = analysis.match(/SELECTED_RESUME:\s*(FRONTEND|FULLSTACK)/i);
    const selectedResume = resumeMatch ? resumeMatch[1].toUpperCase() : 'FULLSTACK';
    
    const confidenceMatch = analysis.match(/CONFIDENCE:\s*(High|Medium|Low)/i);
    const confidence = confidenceMatch ? confidenceMatch[1] : 'Medium';

    const reasoningMatch = analysis.match(/REASONING:\s*(.+?)(?=\n\n|KEY_SKILLS_MATCH:|$)/is);
    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : 'Analysis completed';

    console.log(`\n✅ AI Selected Resume: ${selectedResume}`);
    console.log(`📊 Confidence: ${confidence}`);
    console.log(`💡 Reasoning: ${reasoning}\n`);

    return {
      selectedResume: selectedResume,
      confidence: confidence,
      reasoning: reasoning,
      fullAnalysis: analysis
    };

  } catch (error) {
    console.log('⚠️ Resume selection failed, defaulting to FULLSTACK:', error.message);
    return {
      selectedResume: 'FULLSTACK',
      confidence: 'Low',
      reasoning: 'Selection failed, using full stack as safe default',
      fullAnalysis: 'Selection analysis failed'
    };
  }
}

// =====================================================
// STEP 1.5: PRE-FLIGHT JOB FIT CHECK
// =====================================================
async function checkJobFit(jobDescription, aiProvider, apiKey) {
  const fitPrompt = `You are a senior technical recruiter. Assess if this candidate 
is a realistic fit BEFORE optimizing their resume.

CANDIDATE FACTS (non-negotiable):
- Primary stack: Java, Spring Boot, React, TypeScript
- Secondary: Node.js (side project level), Python (ML projects)
- Visa: F-1 STEM OPT — requires H-1B sponsorship
- Years of experience: 5+
- Domain: Fintech, Healthcare IT, Telecom

JOB DESCRIPTION:
${jobDescription.substring(0, 4000)}

EVALUATE THESE DEALBREAKERS IN ORDER:

1. SPONSORSHIP CHECK
   Does the JD say "cannot sponsor", "no sponsorship", "must be authorized", 
   "citizens/PR only", or similar? 
   → If YES: REJECT immediately

2. PRIMARY STACK MISMATCH
   Is the PRIMARY required language something other than Java/JavaScript/TypeScript?
   (Go required, Rust required, .NET/C# primary, Python primary, Ruby, etc.)
   → Check if candidate's stack is even mentioned in JD requirements
   → If candidate's stack is completely absent: REJECT

3. DOMAIN EXPERTISE MISMATCH  
   Does the role require deep expertise the candidate genuinely lacks?
   (Blockchain/crypto/Web3, Network infrastructure, Embedded systems, 
   Compiler design, Game development, etc.)
   → If core domain is something candidate has never worked in: REJECT

4. SENIORITY/LEVEL CHECK
   Is this a Staff/Principal/Distinguished/Fellow level role? 
   → These rarely sponsor and often require 10+ years: WARN

RESPOND IN EXACTLY THIS FORMAT:
APPLY: YES / WARN / NO
REASON: [one sentence, specific]
BLOCKER: [the specific dealbreaker, or "none"]
FIT_SCORE: [0-100, honest assessment]
PROCEED: true / false`;

  const response = await generateAIContent(fitPrompt, aiProvider, apiKey);

  const applyMatch   = response.match(/APPLY:\s*(YES|WARN|NO)/i);
  const reasonMatch  = response.match(/REASON:\s*(.+?)(?:\n|$)/i);
  const blockerMatch = response.match(/BLOCKER:\s*(.+?)(?:\n|$)/i);
  const fitMatch     = response.match(/FIT_SCORE:\s*(\d+)/i);
  const proceedMatch = response.match(/PROCEED:\s*(true|false)/i);

  return {
    apply:    applyMatch    ? applyMatch[1].toUpperCase()                    : 'WARN',
    reason:   reasonMatch   ? reasonMatch[1].trim()                          : 'Unable to assess',
    blocker:  blockerMatch  ? blockerMatch[1].trim()                         : 'none',
    fitScore: fitMatch      ? parseInt(fitMatch[1])                          : 50,
    proceed:  proceedMatch  ? proceedMatch[1].toLowerCase() === 'true'       : true
  };
}

async function logApplicationToDB({
  companyName,
  position,
  resumeLink,
  jobPostUrl,
  jobDescription
}) {
  const now = new Date();
  const localDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const today = localDate.toISOString().slice(0, 10);  // ← REPLACE LINE 439 WITH THESE 3 LINES

  // Option B: soft match (company + position + date)
  const existing = await pool.query(
    `
    SELECT id FROM applications
    WHERE company_name = $1
      AND position_applied = $2
      AND date_applied = $3
    LIMIT 1
    `,
    [companyName, position, today]
  );

  if (existing.rows.length > 0) {
    // UPDATE
    await pool.query(
      `
      UPDATE applications
      SET resume_link = $1,
          jd_link = $2,
          jd_text = $3
      WHERE id = $4
      `,
      [
        resumeLink,
        jobPostUrl,
        jobDescription,
        existing.rows[0].id
      ]
    );

    console.log('🟢 Application updated in DB');
    return;
  }

  // INSERT
  await pool.query(
    `
    INSERT INTO applications
    (
      company_name,
      position_applied,
      date_applied,
      resume_link,
      jd_link,
      jd_text
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      companyName,
      position,
      today,
      resumeLink,
      jobPostUrl,
      jobDescription
    ]
  );

  console.log('🟢 Application inserted into DB');
}


// Helper: Log optimization to Google Sheets
async function logToGoogleSheet(data) {
  try {
    console.log('📊 Step 8: Logging to Google Sheets...');
    console.log('📊 Sheet ID:', TRACKING_SHEET_ID);

    const {
      companyName,
      position,
      resumeLink,
      jobPostUrl,
      contacts,
      fileName
    } = data;

    // Simple date formatting
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const year = today.getFullYear();
    const formattedDate = `${month}/${day}/${year}`;

    console.log('📊 Formatted date:', formattedDate);
    console.log('📊 Job Post URL:', jobPostUrl);

    // Get the sheet metadata
    const sheetMetadata = await sheets.spreadsheets.get({
      spreadsheetId: TRACKING_SHEET_ID
    });

    const firstSheetName = sheetMetadata.data.sheets[0].properties.title;
    console.log(`📊 Using sheet: ${firstSheetName}`);

    // Append with USER_ENTERED
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: TRACKING_SHEET_ID,
      range: `${firstSheetName}!A:F`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          companyName || 'N/A',
          position || 'N/A',
          formattedDate,
          resumeLink || '',
          jobPostUrl || 'Manual Input',
          contacts || ''
        ]]
      }
    });

    console.log('✅ Logged to Google Sheets:', result.data.updates.updatedRange);
    return true;

  } catch (error) {
    console.log('❌ Failed to log to Google Sheets:', error.message);
    return false;
  }
}

// Main optimization endpoint
// =====================================================
// REPLACE LINES 946–1821 IN server.js
// From:  app.post('/api/optimize-resume', async (req, res) => {
// To:    the closing });  before the BATCH OPTIMIZE comment
// =====================================================

app.post('/api/optimize-resume', async (req, res) => {
  try {
    const {
      jobUrl,
      currentPageUrl,
      aiProvider,
      geminiKey1,
      geminiKey2,
      geminiKey3,
      chatgptApiKey,
      chatgptKey2,
      chatgptKey3,
      manualJobDescription,
      resumeSessionId        // ← NEW: pass this to resume a failed run
    } = req.body;

    console.log('\n📥 Request received:', {
      hasJobUrl: !!jobUrl,
      hasCurrentPageUrl: !!currentPageUrl,
      hasManualJD: !!manualJobDescription,
      manualJDLength: manualJobDescription ? manualJobDescription.length : 0,
      aiProvider,
      resumeSessionId: resumeSessionId || 'new session'
    });

    // ── Validation ───────────────────────────────────────────────────────────
    const jobPostUrl  = currentPageUrl || jobUrl || 'Manual Input';
    const hasManualJD = manualJobDescription && manualJobDescription.trim().length > 0;
    const hasJobUrl   = jobUrl && jobUrl.trim().length > 0;

    if (!hasManualJD && !hasJobUrl) {
      return res.status(400).json({
        error: 'Job URL or manual job description is required',
        details: 'Please provide either a job URL or paste the job description manually'
      });
    }
    if (!aiProvider) {
      return res.status(400).json({ error: 'AI provider is required' });
    }
    if (aiProvider === 'gemini' && (!geminiKey1 || !geminiKey2 || !geminiKey3)) {
      return res.status(400).json({ error: 'All 3 Gemini API keys are required' });
    }
    if (aiProvider === 'chatgpt' && !chatgptApiKey) {
      return res.status(400).json({ error: 'ChatGPT API key is required' });
    }

    console.log(`\n🚀 Starting optimization with ${aiProvider.toUpperCase()}`);

    const extractionKey = aiProvider === 'gemini' ? geminiKey1 : chatgptApiKey;
    const analysisKey   = aiProvider === 'gemini' ? geminiKey2 : (chatgptKey2 || chatgptApiKey);
    const rewriteKey    = aiProvider === 'gemini' ? geminiKey3 : (chatgptKey3 || chatgptApiKey);

    // ── Load or create checkpoint ─────────────────────────────────────────────
    const tempSessionId = resumeSessionId || generateSessionId(jobPostUrl, 'pending');
    let cp = await loadCheckpoint(pool, tempSessionId);

    if (cp && cp.status === 'complete') {
      console.log('✅ Session already complete — returning cached result');
      return res.json({
        success: true,
        resumed: true,
        sessionId: cp.sessionId,
        status: '✅ Already completed — no reprocessing needed'
      });
    }

    if (cp) {
      console.log(`\n♻️  Resuming from step ${cp.step} for session ${tempSessionId}`);
    } else {
      console.log(`\n🆕 New session: ${tempSessionId}`);
      await saveCheckpoint(pool, tempSessionId, STEPS.STARTED, { aiProvider, jobPostUrl });
    }

    let contentSource = hasManualJD ? 'manual_input' : 'url_fetch';

    // ── STEP 1-2: Job description ─────────────────────────────────────────────
    let jobDescription = cp?.jobDescription;

    if (!jobDescription) {
      if (hasManualJD) {
        console.log('📝 MODE: MANUAL JD INPUT');
        jobDescription = manualJobDescription.trim();
        contentSource  = 'manual_input';
        console.log('✅ Using manual job description');
      } else {
        console.log('🌐 MODE: URL FETCH (Playwright)');
        contentSource = 'url_fetch';

        const { chromium } = require('playwright');
        let browser = null;
        let pageText = '';

        try {
          browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
          });
          await context.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image','font','media','stylesheet'].includes(type)) route.abort();
            else route.continue();
          });
          const page = await context.newPage();
          await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(5000);
          for (let i = 0; i < 6; i++) {
            const textLen = await page.evaluate(() => document.body.innerText.trim().length).catch(() => 0);
            if (textLen > 500) break;
            console.log(`   ⏳ Page still loading (${textLen} chars), waiting...`);
            await page.waitForTimeout(2500);
          }
          try {
            const dismissSelectors = ['button[id*="cookie" i]','button[class*="cookie" i]','button[id*="accept" i]','button[class*="consent" i]','.onetrust-accept-btn-handler'];
            for (const sel of dismissSelectors) {
              const btn = await page.$(sel);
              if (btn) { await btn.click().catch(() => {}); break; }
            }
          } catch (_) {}
          pageText = await page.evaluate(() => {
            ['nav','header','footer','script','style','noscript','[role="navigation"]','[role="banner"]','[role="contentinfo"]','aside']
              .forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));
            return document.body.innerText.replace(/\t/g,' ').replace(/\n{3,}/g,'\n\n').trim();
          });
          console.log(`   ✅ Page extracted (${pageText.length.toLocaleString()} chars)`);
        } catch (error) {
          console.log(`   ❌ Playwright failed: ${error.message} — trying axios...`);
          try {
            const axiosResp = await axios.get(jobUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' },
              timeout: 30000, maxRedirects: 5
            });
            pageText = axiosResp.data
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'')
              .replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s{2,}/g,' ').trim();
          } catch (axiosErr) {
            return res.status(500).json({ error: 'Failed to fetch job page', details: axiosErr.message });
          }
        } finally {
          if (browser) await browser.close().catch(() => {});
        }

        if (!pageText || pageText.length < 50) {
          return res.status(500).json({ error: 'Failed to extract content from job page', details: 'Use Manual JD Input instead.' });
        }

        const truncatedText = pageText.length > 15000 ? pageText.substring(0, 15000) + '\n\n[...truncated]' : pageText;
        const jdPrompt = `Extract the job description from this page text. Return ONLY the job-related content.\n\nOutput format:\nJob Title: [title]\nCompany: [company]\nLocation: [location]\n\n[Full job description]\n\nPAGE TEXT:\n${truncatedText}`;

        try {
          jobDescription = await generateAIContent(jdPrompt, aiProvider, extractionKey);
          console.log(`✅ JD extracted (${jobDescription.length.toLocaleString()} chars)`);
        } catch (error) {
          if (error.message.includes('too large') || error.message.includes('context_length_exceeded')) {
            return res.status(413).json({ error: 'Job page too large', details: 'Use Manual JD Input instead.' });
          }
          throw error;
        }

        const jdValidation = jobDescription.trim();
        const jdBodyCheck  = jdValidation.replace(/^(Job Title|Company|Location|Pay Range|About the company)\s*[:]\s*.*/gim,'').replace(/N\/A/gi,'').replace(/\n/g,' ').trim();
        const noJdCheck    = /no job.*(description|content|posting|found|available)|not a job|no jd found|cannot extract|could not find|does not contain|no relevant (job|content)|page does not|unable to extract|no meaningful/i;
        if (jdValidation === 'NO_JOB_DESCRIPTION' || jdBodyCheck.length < 80 || noJdCheck.test(jdValidation)) {
          return res.status(400).json({ error: 'No job description found', details: 'Use Manual JD Input instead.' });
        }
      }

      await saveCheckpoint(pool, tempSessionId, STEPS.JD_FETCHED, { jobDescription });
    } else {
      console.log(`♻️  Using cached JD (${jobDescription.length} chars)`);
    }

    console.log(`\n📊 CONTENT SOURCE: ${contentSource}`);
    console.log(`📝 Final JD length: ${jobDescription.length.toLocaleString()} characters\n`);

    // ── STEP 1.5: Pre-flight job fit check ────────────────────────────────────
    // Skip fit check if user already confirmed (forceApply: true) or checkpoint has it
    const forceApply = req.body.forceApply === true;

    if (!forceApply && !cp?.fitCheck) {
      console.log('🎯 Step 1.5: Checking job fit...');
      const fitCheck = await checkJobFit(jobDescription, aiProvider, extractionKey);

      console.log(`   Apply    : ${fitCheck.apply}`);
      console.log(`   Fit Score: ${fitCheck.fitScore}`);
      console.log(`   Reason   : ${fitCheck.reason}`);
      console.log(`   Blocker  : ${fitCheck.blocker}\n`);

      // Save fitCheck into checkpoint so resume works
      await saveCheckpoint(pool, tempSessionId, STEPS.STARTED, {
        aiProvider, jobPostUrl, jobDescription, fitCheck
      });

      if (fitCheck.apply === 'NO') {
        // Hard blocker — stop entirely
        return res.json({
          success:              false,
          fitCheckFailed:       true,
          requiresConfirmation: false,
          fitCheck,
          sessionId:            tempSessionId,
          status:               `⛔ Not a fit — ${fitCheck.reason}`,
          message:              'Resume optimization stopped. This role has a hard blocker that cannot be fixed by resume changes.',
          blocker:              fitCheck.blocker
        });
      }

      if (fitCheck.apply === 'WARN') {
        // Soft warning — pause and ask user to confirm
        return res.json({
          success:              false,
          fitCheckFailed:       false,
          requiresConfirmation: true,
          fitCheck,
          sessionId:            tempSessionId,
          status:               `⚠️ Weak fit — ${fitCheck.reason}`,
          message:              'This role has concerns. Send forceApply: true with the same sessionId to continue anyway.',
          blocker:              fitCheck.blocker
        });
      }

      console.log(`✅ Fit check passed (score: ${fitCheck.fitScore}) — proceeding\n`);
    } else {
      if (forceApply) {
        console.log('⚡ forceApply=true — user confirmed, skipping fit check\n');
      } else {
        console.log('♻️  Using cached fit check\n');
      }
    }

    // ── STEP 3.5: Extract job details ─────────────────────────────────────────
    let companyName = cp?.companyName;
    let position    = cp?.position;
    let sessionId   = tempSessionId;

    if (!companyName || !position) {
      console.log('🔍 Step 3.5: Extracting job details...');
      const jobDetails = await extractJobDetails(jobDescription, aiProvider, extractionKey);
      companyName = jobDetails.company;
      position    = jobDetails.position;

      // Now we have company — generate proper stable session ID
      const properSessionId = resumeSessionId || generateSessionId(jobPostUrl, companyName);
      if (properSessionId !== tempSessionId) {
        // Migrate checkpoint to proper session ID
        await saveCheckpoint(pool, properSessionId, STEPS.JOB_DETAILS, {
          companyName, position, jobDescription, jobPostUrl, aiProvider
        });
        await pool.query('DELETE FROM optimization_checkpoints WHERE session_id = $1', [tempSessionId]);
        sessionId = properSessionId;
      } else {
        sessionId = tempSessionId;
        await saveCheckpoint(pool, sessionId, STEPS.JOB_DETAILS, { companyName, position });
      }

      console.log(`\n📊 Extracted Job Details:`);
      console.log(`   🏢 Company: ${companyName}`);
      console.log(`   💼 Position: ${position}\n`);
    } else {
      sessionId = resumeSessionId || generateSessionId(jobPostUrl, companyName);
      console.log(`♻️  Using cached job details: ${companyName} — ${position}`);
    }

    // ── STEP 3.6: ATS detection ───────────────────────────────────────────────
    let atsAnalysis = cp?.atsAnalysis;

    if (!atsAnalysis) {
      console.log('🤖 Step 3.6: AI analyzing job portal and creating strategy...');
      atsAnalysis = await detectATSAndStrategy(jobPostUrl, jobDescription, aiProvider, extractionKey);
      await saveCheckpoint(pool, sessionId, STEPS.ATS_DETECTED, { atsAnalysis });
      console.log(`\n🎯 Portal: ${atsAnalysis.portalName}\n`);
    } else {
      console.log(`♻️  Using cached ATS analysis: ${atsAnalysis.portalName}`);
    }

    // ── STEP 3.7: Resume selection ────────────────────────────────────────────
    let resumeSelection = cp?.resumeSelection;

    if (!resumeSelection) {
      console.log('🎯 Step 3.7: AI selecting best resume for this JD...');
      resumeSelection = await selectBestResume(jobDescription, aiProvider, extractionKey);
      await saveCheckpoint(pool, sessionId, STEPS.RESUME_SELECTED, { resumeSelection });
      console.log(`\n📄 Selected: ${resumeSelection.selectedResume} (${resumeSelection.confidence})\n`);
    } else {
      console.log(`♻️  Using cached resume selection: ${resumeSelection.selectedResume}`);
    }

    let selectedResumeId, resumeType;
    switch (resumeSelection.selectedResume) {
      case 'FRONTEND':
        selectedResumeId = FRONTEND_RESUME_DOC_ID;
        resumeType = 'Frontend Resume';
        break;
      case 'FULLSTACK':
      default:
        selectedResumeId = FULLSTACK_RESUME_DOC_ID;
        resumeType = 'Full Stack Resume';
        break;
    }

    // ── STEP 3.8: Company context ─────────────────────────────────────────────
    let companyContext = cp?.companyContext;

    if (!companyContext) {
      console.log('🏢 Step 3.8: Fetching company context...');
      companyContext = await fetchCompanyContext({
        companyName,
        jobDescription,
        tavilyApiKey: process.env.TAVILY_API_KEY,
        aiProvider,
        apiKey: extractionKey,
        generateAIContent
      });
      await saveCheckpoint(pool, sessionId, STEPS.COMPANY_CONTEXT, { companyContext });
      console.log(`   Problem type : ${companyContext.problemType}`);
      console.log(`   Confidence   : ${companyContext.confidence}`);
      console.log(`   Best match   : ${companyContext.bestMatchFromLokesh}\n`);
    } else {
      console.log(`♻️  Using cached company context: ${companyContext.problemType}`);
    }

    // ── STEP 4: Fetch resume from Google Docs ─────────────────────────────────
    let originalResume = cp?.originalResume;

    if (!originalResume) {
      console.log(`📋 Step 4: Fetching ${resumeType}...`);
      const resumeDoc = await docs.documents.get({ documentId: selectedResumeId });
      originalResume  = extractTextFromDoc(resumeDoc.data);
      await saveCheckpoint(pool, sessionId, STEPS.RESUME_FETCHED, { originalResume, resumeType });
      console.log(`✅ Resume fetched (${originalResume.length} chars)`);
    } else {
      console.log(`♻️  Using cached original resume (${originalResume.length} chars)`);
    }

    // ── STEP 5a: Optimization points ─────────────────────────────────────────
    let optimizationPoints = cp?.optimizationPoints;
    let suggestedFileName  = cp?.suggestedFilename;

    if (!optimizationPoints) {
      console.log('💡 Step 5: Generating optimization points...');
      const projectReadmes     = loadProjectReadmes();
      const optimizationPrompt = buildOptimizationPointsPrompt({
        resumeType, originalResume, jobDescription,
        portalName: atsAnalysis.portalName, projectReadmes, companyContext
      });

      optimizationPoints = await generateAIContent(optimizationPrompt, aiProvider, analysisKey);
      const pointCount   = (optimizationPoints.match(/POINT \d+:/g) || []).length;
      console.log(`✅ Generated ${pointCount} optimization points`);
      console.log(`✅ optimization points -----> ${optimizationPoints}`);

      const filenameMatch = optimizationPoints.match(/FILENAME:\s*(.+?)(?:\n|$)/i);
      if (filenameMatch) {
        suggestedFileName = filenameMatch[1].trim();
        console.log(`📝 Suggested filename: ${suggestedFileName}`);
      } else if (companyName !== 'N/A' && position !== 'N/A') {
        const posClean  = position.replace(/[^a-zA-Z0-9\s]/g,'').replace(/\s+/g,'_');
        const compClean = companyName.replace(/[^a-zA-Z0-9\s]/g,'').replace(/\s+/g,'_');
        suggestedFileName = `Lokesh_Para_${posClean}_${compClean}`;
        console.log(`📝 Generated filename: ${suggestedFileName}`);
      }

      await saveCheckpoint(pool, sessionId, STEPS.OPTIMIZATION_POINTS, {
        optimizationPoints, suggestedFilename: suggestedFileName
      });
    } else {
      console.log(`♻️  Using cached optimization points`);
    }

    // ── STEP 5b: Rewrite resume ───────────────────────────────────────────────
    let optimizedResume = cp?.optimizedResume;

    if (!optimizedResume) {
      console.log('✍️ Step 5: Rewriting resume...');
      const projectReadmes = loadProjectReadmes();

      const rewritePrompt = `You are a senior technical resume writer. Apply every optimization point precisely. The output must score 88-92% on ATS and look completely human-written.

====================================================
SECTION 1: YOUR TWO GOALS (EQUAL PRIORITY)
====================================================

GOAL 1 — ATS SCORE 88-92%:
Every required JD skill MUST appear in the Skills section AND in at least one bullet.
Every preferred JD skill MUST appear in the Skills section.
If any required skill is still missing after applying all optimization points — add it yourself.
Never let the resume drop below 85% ATS.

GOAL 2 — HUMAN-WRITTEN:
No consecutive bullets starting with the same verb.
No buzzwords. No keyword stuffing. No robotic patterns.
Write like an engineer talking to another engineer.
40-50% of bullets have metrics — not all of them.

====================================================
SECTION 2: INPUTS
====================================================

RESUME TYPE: ${resumeType}

ORIGINAL RESUME:
${originalResume}

OPTIMIZATION POINTS TO APPLY:
${optimizationPoints}

JOB DESCRIPTION:
${jobDescription}

PORTAL: ${atsAnalysis.portalName}

COMPANY CONTEXT:
Problem type: ${companyContext ? companyContext.problemType : 'unclear'}
What they build: ${companyContext ? companyContext.whatTheyBuild : 'unclear'}
Domain language: ${companyContext ? companyContext.domainLanguage : 'unclear'}
Best match from Lokesh: ${companyContext ? companyContext.bestMatchFromLokesh : 'unclear'}
Narrative frame: ${companyContext ? companyContext.narrativeFrame : 'unclear'}

Project Readmes:
${projectReadmes.resumeOptimizerReadme}
${projectReadmes.cifar10Readme}

====================================================
SECTION 3: RESUME STRUCTURE — NON-NEGOTIABLE
====================================================

Output MUST follow this EXACT structure. No additions. No removals. No reordering.

---RESUME START---

Lokesh Para
Software Engineer

paralokesh5@gmail.com | 682-503-1723 | linkedin.com/in/lokeshpara99 | github.com/lokeshpara | lokeshpara.github.io/Portfolio

PROFESSIONAL EXPERIENCE

Java Full Stack Developer | LPL Financial, San Diego, California
June 2025 - Present
• [6-7 bullets]

Java Full Stack Developer | Athenahealth, Boston, MA
August 2024 - May 2025
• [5-6 bullets]

Java Full Stack Developer | YES Bank, Mumbai, India
November 2021 - July 2023
• [5-6 bullets]

Java Developer | Comcast Corporation, Chennai, India
May 2020 - October 2021
• [4-5 bullets]

PROJECTS

Resume Optimizer AI - Chrome Extension with AI & Google Workspace Integration
• [3-5 bullets]

CIFAR-10 Image Classification with Custom ResNet Architecture
• [3-5 bullets]

TECHNICAL SKILLS

[Categories: plain text, comma-separated, no bullets, no bold]

CERTIFICATIONS

• Oracle Cloud Infrastructure 2025 Certified AI Foundations Associate
• AWS Certified Solutions Architect – Associate

EDUCATION

Master of Science in Computer and Information Sciences
Southern Arkansas University | Magnolia, Arkansas, USA

---RESUME END---

STRICT RULES — NEVER VIOLATE:
❌ Never change company names, dates, job titles, contact info
❌ Never add a Summary or Objective section
❌ Never change section order: Experience → Projects → Skills → Certifications → Education
❌ Never change Certifications or Education text
❌ Never change project names
❌ Title stays exactly "Software Engineer"
❌ Resume must not exceed 2 pages

====================================================
SECTION 4: APPLY EVERY OPTIMIZATION POINT
====================================================

Apply each point exactly as specified. Do not skip. Do not soften.

ADD_SKILL:
→ Add to Skills section under the specified category
→ Add to Experience OR Projects at the specified location
→ Sound natural and realistic — not obviously inserted

REORDER_BULLETS:
→ Rearrange to exact order specified
→ Keep all bullet content unchanged — only position changes

MODIFY_BULLET:
→ Update specified bullet with new content
→ Keep core message, weave in the specified skill or domain context

MERGE_BULLETS:
→ Combine two bullets into one coherent sentence
→ Bullet count drops by 1

ENHANCE_METRIC:
→ Make metric more specific or impressive
→ Round numbers only — never use decimals

THEN — ATS SELF-CHECK:
After applying all points, check: is every required JD skill in Skills section AND a bullet?
If any required skill is still missing → add it yourself before writing output.

====================================================
SECTION 5: HUMANIZATION RULES
====================================================

ACTION VERBS — vary throughout:
Use: Architected, Built, Developed, Engineered, Created, Designed, Implemented, Established, Deployed
- "Implemented" MAX 3 times in entire resume
- "Architected" MAX 2 times in entire resume
- Never start two consecutive bullets with the same verb

❌ ROBOTIC:
• Implemented microservices using Spring Boot
• Implemented RESTful APIs with OAuth2
• Implemented event-driven architecture

✅ HUMAN:
• Architected microservices ecosystem using **Spring Boot** processing 2M+ daily transactions
• Built RESTful APIs with **OAuth2** authentication integrating Bloomberg market data
• Designed event-driven architecture using **Kafka** with sub-200ms latency

METRICS — 40-50% of bullets only:
✅ Round numbers: 40%, 2M+, 99.9%
❌ Never: 43.7%, 2.3M, 87.4%

LANGUAGE:
✅ Real tech terms: Spring Boot, Kafka, React, PostgreSQL, Kubernetes
❌ Never: "cutting-edge", "revolutionary", "synergized", "leveraged", "spearheaded", "championed"

====================================================
SECTION 6: SKILLS SECTION RULES
====================================================

TECHNICAL SKILLS

Category Name: skill1, skill2, skill3, skill4
Category Name: skill1, skill2, skill3

Rules:
- NO bold, NO bullets, NO tables
- Minimize categories — fit into existing ones first
- Category names use "&": "Cloud & DevOps:", "Testing & Quality Assurance:"
- OAuth2, JWT → "Backend" | Redis → "Databases & Messaging" | Prometheus → "Testing, Monitoring & Security"

====================================================
SECTION 7: BULLET FORMATTING RULES
====================================================

✅ Bold JD-mentioned skills in Experience AND Projects: "**Spring Boot**", "**Kafka**"
✅ Bold project names before the dash
❌ Never bold in Skills section
❌ Never bold common words: "using", "with", "implementing"
✅ Always use "• " (bullet + space) — never "-", "*", or numbers
✅ One blank line between sections, companies, projects
✅ No blank lines between bullets at same company/project
✅ Plain text output — no markdown, no HTML

====================================================
SECTION 8: FINAL CHECKLIST — RUN BEFORE WRITING OUTPUT
====================================================

ATS:
□ Every REQUIRED JD skill in Skills section AND at least one bullet?
□ Every PREFERRED JD skill in Skills section?
□ 88%+ JD keywords covered?

Structure:
□ Order: Experience → Projects → Skills → Certifications → Education
□ "Lokesh Para" and "Software Engineer" in header
□ All 4 companies with exact names and dates
□ Both projects with exact names

Bullet counts:
□ LPL Financial: 6-7 | Athenahealth: 5-6 | YES Bank: 5-6 | Comcast: 4-5
□ Resume Optimizer AI: 3-5 | CIFAR-10: 3-5

Humanization:
□ No consecutive same verb | "Implemented" max 3x | "Architected" max 2x
□ 40-50% bullets have metrics | Round numbers only | No buzzwords

====================================================
SECTION 9: OUTPUT INSTRUCTIONS
====================================================

Return ONLY the complete resume.
No preamble. No commentary. No explanations.
Start directly with "Lokesh Para".
End with the Education section.

Begin output now:`;

      optimizedResume = await generateAIContent(rewritePrompt, aiProvider, rewriteKey);
      await saveCheckpoint(pool, sessionId, STEPS.RESUME_REWRITTEN, { optimizedResume });
      console.log(`✅ Resume rewritten (${optimizedResume.length} chars)`);
      console.log(`Rewrite resume ======> ${optimizedResume}`);
    } else {
      console.log(`♻️  Using cached rewritten resume`);
    }

    // ── STEP 6: Convert to HTML ───────────────────────────────────────────────
    console.log('🎨 Step 6: Converting to HTML...');
    const styledHtml = convertToStyledHTML(optimizedResume);

    // ── STEP 7: Upload to Google Drive ────────────────────────────────────────
    console.log('☁️ Step 7: Uploading to Google Drive...');
    const fileName = suggestedFileName || `Lokesh_Para_Optimized_${Date.now()}`;
    console.log(`📄 Filename: ${fileName}`);

    let fileId, resumeLink;
    try {
      const file = await drive.files.create({
        requestBody: {
          name:     fileName,
          parents:  [DRIVE_FOLDER_ID],
          mimeType: 'application/vnd.google-apps.document'
        },
        media: {
          mimeType: 'text/html',
          body:     styledHtml
        },
        fields: 'id'
      });
      fileId     = file.data.id;
      resumeLink = `https://docs.google.com/document/d/${fileId}/edit`;
      console.log('✅ Document created! ID:', fileId);
      await setDocumentFormatting(fileId);
      await saveCheckpoint(pool, sessionId, STEPS.UPLOADED, {});
    } catch (uploadError) {
      // Save state so retry skips everything and only re-uploads
      await markFailed(pool, sessionId, `Upload failed: ${uploadError.message}`);
      return res.status(500).json({
        error: 'Google Drive upload failed',
        details: uploadError.message,
        sessionId: sessionId,
        hint: `Your resume is fully generated and saved. Send this sessionId back as resumeSessionId to retry upload only.`
      });
    }

    // ── STEP 8: Log to PostgreSQL ─────────────────────────────────────────────
    try {
      await logApplicationToDB({ companyName, position, resumeLink, jobPostUrl, jobDescription });
      await saveCheckpoint(pool, sessionId, STEPS.LOGGED, {});
    } catch (logError) {
      console.log(`⚠️ DB log failed (non-critical): ${logError.message}`);
    }

    // ── Complete ──────────────────────────────────────────────────────────────
    await markComplete(pool, sessionId);

    const pointCount = (optimizationPoints.match(/POINT \d+:/g) || []).length;

    res.json({
      success:             true,
      status:              '✅ Resume Optimized Successfully!',
      sessionId:           sessionId,
      aiProvider:          aiProvider,
      portalName:          atsAnalysis.portalName,
      portalAnalysis:      atsAnalysis.fullAnalysis,
      selectedResume:      resumeSelection.selectedResume,
      resumeType:          resumeType,
      selectionConfidence: resumeSelection.confidence,
      selectionReasoning:  resumeSelection.reasoning,
      keysUsed:            aiProvider === 'gemini' ? '3 Gemini keys' : '1 ChatGPT key',
      contentSource:       contentSource,
      fileName:            fileName,
      companyName:         companyName,
      position:            position,
      links: {
        editInGoogleDocs: resumeLink,
        downloadPDF:      `https://docs.google.com/document/d/${fileId}/export?format=pdf`,
        downloadWord:     `https://docs.google.com/document/d/${fileId}/export?format=docx`,
        trackingSheet:    `https://docs.google.com/spreadsheets/d/${TRACKING_SHEET_ID}/edit`
      },
      documentId:          fileId,
      optimizationPoints:  pointCount
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({
      error:   'Resume optimization failed',
      details: error.message
    });
  }
});

// GET /api/optimize-resume/session/:sessionId — check session status
app.get('/api/optimize-resume/session/:sessionId', async (req, res) => {
  try {
    const cp = await loadCheckpoint(pool, req.params.sessionId);
    if (!cp) return res.status(404).json({ error: 'Session not found' });
    res.json({
      sessionId:    cp.sessionId,
      step:         cp.step,
      status:       cp.status,
      companyName:  cp.companyName,
      position:     cp.position,
      errorMessage: cp.errorMessage,
      updatedAt:    cp.updatedAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================
// BATCH OPTIMIZE — Core function (reusable for single + batch)
// =====================================================

async function optimizeSingleJob({ jobUrl, aiProvider, geminiKey1, geminiKey2, geminiKey3, chatgptApiKey, chatgptKey2, chatgptKey3, onProgress }) {
  const log = (msg) => {
    console.log(msg);
    if (onProgress) onProgress(msg);
  };

  const jobPostUrl = jobUrl;
  const contentSource = 'url_fetch';

  // ---- Step 1: Fetch JD via Playwright ----
  log('📄 Fetching job page...');
  const { chromium: chromiumFetch } = require('playwright');
  let browser = null;
  let pageText = '';

  try {
    browser = await chromiumFetch.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) route.abort();
      else route.continue();
    });
    const page = await context.newPage();
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    for (let i = 0; i < 6; i++) {
      const textLen = await page.evaluate(() => document.body.innerText.trim().length).catch(() => 0);
      if (textLen > 500) break;
      log(`⏳ Page still loading (${textLen} chars), waiting...`);
      await page.waitForTimeout(2500);
    }

    try {
      for (const sel of ['button[id*="cookie" i]', 'button[class*="accept" i]', '.onetrust-accept-btn-handler']) {
        const btn = await page.$(sel);
        if (btn) { await btn.click().catch(() => {}); break; }
      }
    } catch (_) {}
    pageText = await page.evaluate(() => {
      ['nav','header','footer','script','style','noscript','[role="navigation"]','aside'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });
      return document.body.innerText.replace(/\t/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    });
  } catch (err) {
    log(`⚠️ Playwright failed: ${err.message}, trying axios...`);
    const axiosResp = await axios.get(jobUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      timeout: 30000, maxRedirects: 5
    });
    pageText = axiosResp.data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  if (!pageText || pageText.length < 50) throw new Error('No JD found — page returned no content');

  // ---- Step 2: AI extract JD ----
  log('🤖 Extracting job description...');
  const truncatedText = pageText.length > 15000 ? pageText.substring(0, 15000) : pageText;
  const extractionKey = aiProvider === 'gemini' ? geminiKey1 : chatgptApiKey;
  const jobDescription = await generateAIContent(
    `Extract the job description from this page text. Return ONLY job-related content.
If this page does NOT contain a job description (e.g. it's a login page, homepage, error page, or unrelated page), respond with exactly: NO_JOB_DESCRIPTION

Output format (only if job found):
Job Title: [title]
Company: [company]
Location: [location]

[Full job description]
Pay Range: [pay range]
about the company: [about the company]
PAGE TEXT:
${truncatedText}`,
    aiProvider, extractionKey
  );

  // Validate AI actually found a JD
  const jdClean = jobDescription.trim();
  const jdLower = jdClean.toLowerCase();

  // Strip the headers to measure actual content length
  const jdBody = jdClean
    .replace(/^(Job Title|Company|Location|Pay Range|About the company)\s*[:]\s*.*/gim, '')
    .replace(/N\/A/gi, '')
    .replace(/\n/g, ' ')
    .trim();

  const noJdPatterns = /no job.*(description|content|posting|found|available)|not a job|no jd found|cannot extract|could not find|does not contain|no relevant (job|content)|page does not|unable to extract|no meaningful/i;

  if (
    jdClean === 'NO_JOB_DESCRIPTION' ||
    jdLower.startsWith('no_job') ||
    jdBody.length < 80 ||
    noJdPatterns.test(jdClean)
  ) {
    throw new Error('No JD found — this link does not contain a job description');
  }

  // ---- Step 3: Extract company/position ----
  log('🔍 Extracting job details...');
  const jobDetails = await extractJobDetails(jobDescription, aiProvider, extractionKey);
  const companyName = jobDetails.company;
  const position = jobDetails.position;
  log(`🏢 ${companyName} — ${position}`);

  // ---- Step 4: ATS + resume selection ----
  log('🎯 Analyzing portal & selecting resume...');
  const atsAnalysis = await detectATSAndStrategy(jobPostUrl, jobDescription, aiProvider, extractionKey);
  const resumeSelection = await selectBestResume(jobDescription, aiProvider, extractionKey);

  let selectedResumeId, resumeType;
  switch (resumeSelection.selectedResume) {
    case 'FRONTEND': selectedResumeId = FRONTEND_RESUME_DOC_ID; resumeType = 'Frontend Resume'; break;
    default: selectedResumeId = FULLSTACK_RESUME_DOC_ID; resumeType = 'Full Stack Resume'; break;
  }

  // ---- Step 5: Get resume ----
  const resumeDoc = await docs.documents.get({ documentId: selectedResumeId });
  const originalResume = extractTextFromDoc(resumeDoc.data);

  // ---- Step 6: Generate optimization points ----
  log('💡 Generating optimization points...');
  const projectReadmes = loadProjectReadmes();
  const analysisKey = aiProvider === 'gemini' ? geminiKey2 : (chatgptKey2 || chatgptApiKey);

  const optimizationPrompt = buildOptimizationPointsPrompt({
    resumeType, originalResume, jobDescription,
    portalName: atsAnalysis.portalName, projectReadmes,
    companyContext
  });

  const optimizationPoints = await generateAIContent(optimizationPrompt, aiProvider, analysisKey);
  const pointCount = (optimizationPoints.match(/POINT \d+:/g) || []).length;
  log(`✅ Generated ${pointCount} optimization points`);

  // ---- Step 7: Rewrite resume ----
  log('✍️ Rewriting resume...');
  const rewriteKey = aiProvider === 'gemini' ? geminiKey3 : (chatgptKey3 || chatgptApiKey);

  const rewritePrompt = `You are a senior technical resume writer. Your mission: Apply optimization points while keeping the resume HUMAN-WRITTEN and INTERVIEW-SAFE.

====================================================
SECTION 1: CRITICAL CONTEXT
====================================================

**The Problem:**
- Candidate applied to 360+ jobs with 90%+ ATS scores
- Got ZERO interview responses
- Issue: Resumes look AI-generated to human recruiters

**Your Solution:**
- Apply optimization points precisely
- Keep resume looking human-written
- Target 85-92% ATS (NOT 100% - that looks fake)
- Prioritize HUMAN TRUST over ATS scores
- Use Projects section strategically for competitive advantage

====================================================
SECTION 2: INPUTS
====================================================

RESUME TYPE: ${resumeType}

ORIGINAL RESUME:
${originalResume}

OPTIMIZATION POINTS TO APPLY:
${optimizationPoints}

JOB DESCRIPTION:
${jobDescription}

PORTAL: ${atsAnalysis.portalName}

Project Readmes:
${projectReadmes.resumeOptimizerReadme}
${projectReadmes.cifar10Readme}

====================================================
SECTION 3: MANDATORY STRUCTURE (NON-NEGOTIABLE)
====================================================

Your output MUST follow this EXACT structure:

---RESUME START---

Lokesh Para
Software Engineer

paralokesh5@gmail.com | 682-503-1723 | linkedin.com/in/lokeshpara99 | github.com/lokeshpara | lokeshpara.github.io/Portfolio

PROFESSIONAL EXPERIENCE

Java Full Stack Developer | LPL Financial, San Diego, California
June 2025 - Present
• [6-7 bullets depending on resume type]

Java Full Stack Developer | Athenahealth, Boston, MA
August 2024 - May 2025
• [5-6 bullets depending on resume type]

Java Full Stack Developer | YES Bank, Mumbai, India
November 2021 - July 2023
• [5-6 bullets depending on resume type]

Java Developer | Comcast Corporation, Chennai, India
May 2020 - October 2021
• [4-5 bullets depending on resume type]

PROJECTS

Resume Optimizer AI - Chrome Extension with AI & Google Workspace Integration
• [3-5 bullets - apply optimizations here if specified]

CIFAR-10 Image Classification with Custom ResNet Architecture
• [3-5 bullets - apply optimizations here if specified]

TECHNICAL SKILLS

[Categories with comma-separated skills]

CERTIFICATIONS

• Oracle Cloud Infrastructure 2025 Certified AI Foundations Associate
• AWS Certified Solutions Architect – Associate

EDUCATION

Master of Science in Computer and Information Sciences
Southern Arkansas University | Magnolia, Arkansas, USA

---RESUME END---

**STRICT RULES:**
❌ Never change: Company names, dates, job titles, contact info
❌ Never add: Summary section
❌ Never change: Section order (Experience → Projects → Skills → Certifications → Education)
❌ Never change: Certifications or Education text
❌ Never change: Project names or core project technologies
✅ Title must be "Software Developer" (never change)

====================================================
SECTION 4: APPLYING OPTIMIZATION POINTS
====================================================

**Apply EXACTLY as specified in optimization points:**

IF point type is "ADD_SKILL":
→ Add skill to Skills section under specified category
→ Add skill to Experience OR Projects section at specified location
→ Make integration sound natural and realistic
→ Use Projects section when specified (especially for AI/ML skills)

IF point type is "REORDER_BULLETS":
→ Rearrange bullets in exact order specified
→ Works for both Experience AND Projects sections
→ Keep all bullet content, just change position

IF point type is "MODIFY_BULLET":
→ Update the specified bullet with new content
→ Keep core message, add specified skills/context
→ Works for both Experience AND Projects bullets

IF point type is "MERGE_BULLETS":
→ Combine two bullets into one coherent bullet
→ Reduces total bullet count by 1

IF point type is "ENHANCE_METRIC":
→ Make existing metric more specific or impressive
→ Keep it realistic (round numbers only)

**DO NOT:**
❌ Make changes not mentioned in optimization points
❌ Add content optimization points didn't request
❌ Remove bullets unless points say to merge
❌ Change structure points didn't mention

====================================================
SECTION 5: HUMANIZATION RULES (CRITICAL)
====================================================

**1. NATURAL LANGUAGE VARIATION**

Action Verb Rotation:
- Use: Architected, Built, Developed, Engineered, Created, Designed, Implemented, Established, Deployed
- "Implemented" → MAX 3 times total
- "Architected" → MAX 2 times total  
- Never start consecutive bullets with same verb

❌ BAD (robotic):
• Implemented microservices using Spring Boot
• Implemented RESTful APIs with OAuth2
• Implemented event-driven architecture
• Implemented monitoring with Prometheus

✅ GOOD (human, with JD skills bolded):
• Architected microservices ecosystem using **Spring Boot** processing 2M+ daily transactions
• Built RESTful APIs with **OAuth2** authentication integrating Bloomberg market data
• Designed event-driven architecture using **Kafka** with sub-200ms latency
• Established monitoring platform with **Prometheus** reducing incident resolution by 55%

**2. REALISTIC METRICS (40-50% OF BULLETS)**

Metrics Guidelines:
- Only 40-50% of bullets should have metrics
- Use round numbers: 40%, 2M+, 99.9% (not 43.7%, 2.3M)
- Mix of bullets WITH and WITHOUT metrics

Examples:

✅ With metric: "Built microservices using **Spring Boot** processing 2M+ daily transactions with 99.9% uptime"
✅ Without metric: "Engineered RESTful APIs with **OAuth2** authentication integrating market data feeds"
✅ With metric: "Optimized database queries using **PostgreSQL** reducing load time from 4.2s to 1.5s"
✅ Without metric: "Designed event-driven architecture using **Kafka** and **Redis** distributed caching"

**3. CONVERSATIONAL TECH LANGUAGE**

✅ Use real tech terms: Spring Boot, Kafka, React, PostgreSQL, Kubernetes
❌ Avoid buzzwords: "cutting-edge", "revolutionary", "synergized", "leveraged"
❌ Avoid corporate speak: "spearheaded", "championed"

Write like an engineer explaining to another engineer.

**4. NATURAL SENTENCE STRUCTURE**

Vary bullet length and complexity:
- Some short (1 line): "Built GraphQL APIs for mobile banking application"
- Some long (2 lines): "Architected event-driven microservices ecosystem using Spring Boot and Apache Kafka with 10-node cluster processing 2M+ portfolio events daily implementing custom serializers and exactly-once delivery semantics"
- Mix technical depth: some high-level, some detailed

====================================================
SECTION 6: PROJECTS SECTION FORMAT
====================================================

**Format EXACTLY like this:**

PROJECTS

[Project Name] - [Brief Description]
• [3-5 bullets per project]
• [Focus on technical implementation and results]
• [Bold JD-mentioned skills in bullets]

**Project Bullet Best Practices:**
- Start with strong action verbs (Built, Developed, Implemented, Designed)
- Include specific technologies used
- Mention concrete results (accuracy %, performance metrics, features)
- Bold skills that appear in the JD
- Keep bullets concise but impactful

**Examples:**

Resume Optimizer AI - Chrome Extension with AI & Google Workspace Integration
• Developed full-stack Chrome extension with **Node.js** backend integrating **Google Gemini 2.0** and **ChatGPT GPT-4** APIs for AI-powered resume optimization achieving 85-92% ATS match rates
• Built comprehensive application tracking system using **PostgreSQL** database with full-text search and automated **Google Drive** integration handling 360+ applications

CIFAR-10 Image Classification with Custom ResNet Architecture
• Designed custom ResNet-inspired CNN architecture using **PyTorch** achieving 92.22% test accuracy with minimal overfitting and 100% accuracy on 8 out of 10 classes
• Implemented One Cycle Policy learning rate scheduling with **PyTorch** optimizer enabling super-convergence and 40% faster training

====================================================
SECTION 7: SKILLS SECTION FORMAT
====================================================

Format EXACTLY like this (plain text):

TECHNICAL SKILLS

Category Name: skill1, skill2, skill3, skill4, skill5
Category Name: skill1, skill2, skill3
Category Name: skill1, skill2, skill3, skill4

**Rules:**
- Section header: "TECHNICAL SKILLS" (all caps, no colon)
- Each category: "Category Name: " (with colon and space)
- Skills: comma-separated with spaces
- NO bold text in skills section
- NO bullet points in skills section
- NO tables or special formatting

**Category Management:**
- MINIMIZE categories: fit skills into existing categories whenever possible
- ONLY create new category if skill truly doesn't fit anywhere
- Category names: Descriptive for ATS + humans (e.g., "Machine Learning & AI:" not "ML/AI:")
- Use "&" instead of "and": "Cloud & DevOps:", "Testing & Quality Assurance:"

**Category Placement (when new category needed):**
- If JD heavily emphasizes the new skill → Place HIGH (position 2-3)
- If JD mentions as nice-to-have → Place LOW (near end)
- Default: Place after logically related categories

**Fitting Skills into Existing Categories (examples):**
- OAuth2, JWT, SAML → Add to "Backend" (don't create "Security")
- Redis, Memcached → Add to "Databases & Messaging" (don't create "Caching")
- Prometheus, Grafana → Add to "Testing, Monitoring & Security" (don't create "Observability")
- GraphQL → Add to "Backend" (don't create "API Technologies")
- Tailwind, Sass → Add to "Frontend" (don't create "CSS Frameworks")

**When optimization points specify new category:**
- Place category at position specified (e.g., "after Testing category")
- Use exact category name from optimization points
- Add skills comma-separated like existing categories

====================================================
SECTION 8: EXPERIENCE BULLET BEST PRACTICES
====================================================

**Bullet Structure Formula:**
[Action Verb] + [What you built] + [Technologies used] + [Impact/Scale - optional]

**Technology Mentions:**
✅ Specific versions when relevant: React 18, Spring Boot 3.x, Java 17
✅ Specific tools naturally: Redis, Kafka, PostgreSQL, Kubernetes
❌ Don't list every technology in every bullet
❌ Don't repeat same tech stack constantly

**When to Include Metrics:**
✅ Performance improvements: "reducing load time from 4.2s to 1.5s"
✅ Scale: "handling 2M+ daily transactions", "serving 29K advisors"
✅ Business impact: "saving $800K annually"
✅ Efficiency: "reducing deployment time by 87%"
✅ Quality: "achieving 99.9% uptime", "85% test coverage"

**When NOT to Include Metrics:**
✅ Describing architecture: "Built RESTful APIs with OAuth2"
✅ Listing responsibilities: "Integrated Bloomberg market data feeds"
✅ Technical implementation: "Implemented Redis distributed caching"

====================================================
SECTION 9: FORMATTING REQUIREMENTS
====================================================

**Bullets:**
✅ Use "• " (bullet symbol + space) for ALL bullets in Experience AND Projects
❌ Don't use "-", "*", or numbers

**Text Formatting:**
✅ Bold: Section headers (PROFESSIONAL EXPERIENCE, PROJECTS, TECHNICAL SKILLS)
✅ Bold: Company names and job titles
✅ Bold: Project names (before the dash)
✅ Bold: JD-mentioned skills in Experience AND Projects bullets ONLY
❌ Don't bold: Skills in Skills section (plain text only)
❌ Don't bold: Common words like "using", "with", "implementing"
❌ Don't bold: Project descriptions or GitHub links
❌ Don't use italics or underlines

**Bold Formatting Examples for Bullets:**
✅ "Built event-driven microservices using **Spring Boot** and **Apache Kafka**"
✅ "Implemented custom ResNet using **PyTorch** achieving 92% accuracy"
✅ "Developed Chrome extension with **Node.js** backend and **PostgreSQL** database"
❌ "Built event-driven microservices using **Spring Boot and Apache Kafka**" (don't bold entire phrase)
❌ "**Implemented** Redis distributed caching" (don't bold action verbs)

**Spacing:**
✅ One blank line between sections
✅ One blank line between companies
✅ One blank line between projects
✅ No blank lines between bullets at same company/project

**Output Format:**
✅ Plain text output
❌ No markdown formatting
❌ No HTML tags
❌ No special characters for formatting

====================================================
SECTION 10: QUALITY CHECKLIST
====================================================

Before returning the resume, verify:

**Structure:**
□ Sections in order: Experience → Projects → Skills → Certifications → Education
□ Header has "Lokesh Para" and "Software Engineer"
□ All 4 companies present with exact names/dates
□ Both projects present with names and descriptions

**Bullets:**
□ LPL Financial: 6-7 bullets (depending on ${resumeType})
□ Athenahealth: 5-6 bullets
□ YES Bank: 5-6 bullets
□ Comcast: 4-5 bullets
□ Resume Optimizer AI: 3-5 bullets
□ CIFAR-10 Project: 3-5 bullets

**Humanization:**
□ No consecutive bullets start with same verb
□ "Implemented" used MAX 3 times total
□ "Architected" used MAX 2 times total
□ 40-50% of bullets have metrics (not all)
□ Metrics use round numbers (no decimals)
□ Natural language variation
□ NO buzzwords ("cutting-edge", "revolutionary")

**Optimization:**
□ All optimization points applied
□ Skills added to Skills AND (Experience OR Projects) sections as specified
□ Projects section used strategically for AI/ML and full-stack skills
□ Bullets reordered as specified
□ No changes beyond what points requested

**Formatting:**
□ All bullets use "• " symbol in Experience AND Projects
□ JD-mentioned skills are bolded in Experience AND Projects bullets
□ Skills section has NO bold (plain text only)
□ No bold on common words ("using", "with", "implementing")
□ Project names bolded before the dash
□ Only section headers, company names, project names, and JD skills bolded
□ Plain text output
□ Proper spacing

**Interview Safety:**
□ Every bullet is defendable in interview
□ No exaggerated claims
□ No unknown technologies mentioned
□ Resume looks human-written

====================================================
SECTION 11: OUTPUT INSTRUCTIONS
====================================================

Return ONLY the complete rewritten resume.

NO preamble like "Here is the resume"
NO explanations or commentary
NO markdown formatting
NO extra text before or after

Start directly with "Lokesh Para"
End with education section

Resume should be ready to copy-paste into Google Doc.

Begin output now:
`;

  const optimizedResume = await generateAIContent(rewritePrompt, aiProvider, rewriteKey);

  // ---- Step 8: HTML + upload ----
  log('☁️ Uploading to Google Drive...');
  const styledHtml = convertToStyledHTML(optimizedResume);

  const posClean = position.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
  const compClean = companyName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
  const fileName = `Lokesh_Para_${posClean}_${compClean}`;

  const file = await drive.files.create({
    requestBody: { name: fileName, parents: [DRIVE_FOLDER_ID], mimeType: 'application/vnd.google-apps.document' },
    media: { mimeType: 'text/html', body: styledHtml },
    fields: 'id'
  });

  const fileId = file.data.id;
  const resumeLink = `https://docs.google.com/document/d/${fileId}/edit`;
  await setDocumentFormatting(fileId);

  // ---- Step 9: Log to DB ----
  await logApplicationToDB({ companyName, position, resumeLink, jobPostUrl, jobDescription });

  log(`✅ Done: ${companyName} — ${position}`);

  return {
    success: true,
    jobUrl,
    companyName,
    position,
    fileName,
    resumeType,
    resumeLink,
    downloadPDF: `https://docs.google.com/document/d/${fileId}/export?format=pdf`,
    optimizationPoints: pointCount
  };
}

// =====================================================
// BATCH OPTIMIZE ENDPOINT (SSE for real-time progress)
// =====================================================

app.post('/api/batch-optimize', async (req, res) => {
  console.log('\n📦 Batch optimize request received');
  const { urls, aiProvider, batchSize } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    console.log('❌ Batch: No URLs provided');
    return res.status(400).json({ error: 'No URLs provided' });
  }
  if (!aiProvider) {
    console.log('❌ Batch: No AI provider');
    return res.status(400).json({ error: 'AI provider is required' });
  }

  // Resolve keys with .env fallback (use same key for all 3 slots if only 1 exists)
  const envChatgpt = process.env.CHATGPT_API_KEY || process.env.OPENAI_API_KEY;
  const envGemini = process.env.GEMINI_API_KEY;

  const geminiKey1 = req.body.geminiKey1 || envGemini;
  const geminiKey2 = req.body.geminiKey2 || envGemini;
  const geminiKey3 = req.body.geminiKey3 || envGemini;
  const chatgptApiKey = req.body.chatgptApiKey || envChatgpt;
  const chatgptKey2 = req.body.chatgptKey2 || envChatgpt;
  const chatgptKey3 = req.body.chatgptKey3 || envChatgpt;

  console.log(`📦 Batch: provider=${aiProvider}, urls=${urls.length}, keys resolved: chatgpt=${!!chatgptApiKey}, gemini=${!!geminiKey1}`);

  // Validate resolved keys
  if (aiProvider === 'gemini' && !geminiKey1) {
    console.log('❌ Batch: No Gemini key');
    return res.status(400).json({ error: 'Gemini key required. Set GEMINI_API_KEY in .env or enter key manually.' });
  }
  if (aiProvider === 'chatgpt' && !chatgptApiKey) {
    console.log('❌ Batch: No ChatGPT key');
    return res.status(400).json({ error: 'ChatGPT key required. Set CHATGPT_API_KEY in .env or enter key manually.' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush(); // force flush for immediate delivery
  };

  const cleanUrls = urls.map(u => u.trim()).filter(u => u.length > 0);
  const total = cleanUrls.length;
  const concurrency = Math.min(batchSize || 2, 3); // max 3 parallel

  send('start', { total, concurrency });
  console.log(`🚀 Batch optimize: ${total} URLs, ${concurrency} parallel`);

  const results = [];
  let completed = 0;

  // Process in batches of `concurrency`
  for (let i = 0; i < cleanUrls.length; i += concurrency) {
    const batch = cleanUrls.slice(i, i + concurrency);
    console.log(`📦 Batch ${Math.floor(i / concurrency) + 1}: processing ${batch.length} URLs`);

    const batchPromises = batch.map((url, batchIdx) => {
      const jobIndex = i + batchIdx;
      send('job_start', { index: jobIndex, url });

      return optimizeSingleJob({
        jobUrl: url,
        aiProvider,
        geminiKey1, geminiKey2, geminiKey3,
        chatgptApiKey, chatgptKey2, chatgptKey3,
        onProgress: (msg) => send('progress', { index: jobIndex, url, message: msg })
      }).then(result => {
        completed++;
        console.log(`✅ [${completed}/${total}] ${result.companyName} — ${result.position}`);
        send('job_done', { index: jobIndex, url, result, completed, total });
        results.push(result);
        return result;
      }).catch(err => {
        completed++;
        console.log(`❌ [${completed}/${total}] ${url}: ${err.message}`);
        const errorResult = { success: false, jobUrl: url, error: err.message };
        send('job_error', { index: jobIndex, url, error: err.message, completed, total });
        results.push(errorResult);
        return errorResult;
      });
    });

    await Promise.allSettled(batchPromises);
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`\n📦 Batch complete: ${succeeded} succeeded, ${failed} failed out of ${total}`);

  send('complete', { total, succeeded, failed, results });
  res.end();
});

function extractTextFromDoc(doc) {
  let text = '';
  const content = doc.body.content;

  for (const element of content) {
    if (element.paragraph?.elements) {
      for (const elem of element.paragraph.elements) {
        if (elem.textRun) text += elem.textRun.content;
      }
    }
    if (element.table) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells) {
          for (const cellContent of cell.content) {
            if (cellContent.paragraph?.elements) {
              for (const elem of cellContent.paragraph.elements) {
                if (elem.textRun) text += elem.textRun.content;
              }
            }
          }
          text += '\t';
        }
        text += '\n';
      }
    }
  }
  return text;
}

// ============================================================================
// HTML CONVERSION - CERTIFICATIONS AS PLAIN TEXT (NO BULLETS)
// ============================================================================

// ============================================================================
// UPDATED HTML CONVERSION WITH BOLD SUPPORT FOR JD SKILLS
// ============================================================================

// REPLACE the convertToStyledHTML function in your server.js with this version:

function convertToStyledHTML(text) {
  const lines = text.split('\n');
  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  * {
    margin: 0;
    padding: 0;
  }
  
  body {
    font-family: Calibri, sans-serif;
    font-size: 9pt;
    line-height: 1.00;
    margin: 0.5in 0.5in;
    color: #000000;
  }
  
  /* Header - Name */
  .name {
    font-size: 28pt;
    font-weight: bold;
    text-align: center;
    margin-bottom: 2pt;
    color: #1D2D50;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  
  /* Header - Title */
  .title {
    font-size: 13pt;
    font-weight: bold;
    text-align: center;
    margin-bottom: 2pt;
  }
  
  /* Header - Contact */
  .contact {
    font-size: 11pt;
    text-align: center;
    margin-bottom: 2pt;
    line-height: 1.2;
    color: #2E4057;
  }
  
  .contact a {
    color: #2E4057;
    text-decoration: none;
  }
  
  /* Section Headers - Tight spacing */
  .section-header {
    margin-top: 2pt;
    margin-bottom: 4pt;
    font-size: 13pt;
    font-weight: bold;
    color: #1D2D50;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  
  /* Company Header - Bold */
  .company-header {
    font-size: 11pt;
    font-weight: bold;
    margin-top: 6pt;
    margin-bottom: 2pt;
  }
  
  /* Project Header - Bold with clickable project name */
  .project-header {
    font-size: 11pt;
    font-weight: bold;
    margin-top: 6pt;
    margin-bottom: 2pt;
  }
  
  .project-header a {
    color: #000000;
    text-decoration: none;
    font-weight: bold;
  }
  
  
  .project-subheader a {
    color: #000000;
    text-decoration: none;
  }
  
  /* Job Date - Italic */
  .job-date {
    font-size: 10pt;
    margin-bottom: 3pt;
    color: #6B7A8D;
  }
  
  /* Bullet List - For experience AND projects */
  ul {
    margin: 0 0 4pt 0.25in;
    padding: 0;
    list-style-position: outside;
    list-style-type: disc;
  }
  
  ul li {
    margin: 2pt 0;
    padding-left: 0.05in;
    text-align: justify;
    line-height: 1.08;
  }
  
  /* Skills Section - Tight spacing */
  .skills-para {
    margin: 2pt 0;
    text-align: justify;
    line-height: 1.08;
  }
  
  .skills-para strong {
    font-weight: bold;
    color: #1D2D50;

  }
  
  /* Education - Tight spacing */
  .edu-degree {
    font-weight: bold;
    margin-top: 2pt;
    margin-bottom: 2pt;
  }
  
  .edu-school {
    margin-top: 0pt;
    margin-bottom: 2pt;
  }
  
  /* Certification - Plain paragraph (NO BULLETS) */
  .cert-item {
    margin: 2pt 0;
    text-align: left;
    line-height: 1.08;
  }
  
  /* Regular paragraphs */
  p {
    margin: 2pt 0;
    text-align: justify;
    line-height: 1.08;
  }
  </style></head><body>`;

  let inSkills = false;
  let inCertifications = false;
  let inEducation = false;
  let inProjects = false;
  let currentBulletList = [];

  // Helper: Convert **text** to <strong>text</strong>
  function processBoldText(text) {
    // Replace **text** with <strong>text</strong>
    return text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  // Helper: Flush accumulated bullets
  function flushBullets() {
    if (currentBulletList.length > 0) {
      html += '<ul>\n';
      for (const bullet of currentBulletList) {
        // Process bold text in bullets
        const processedBullet = processBoldText(bullet);
        html += `<li>${processedBullet}</li>\n`;
      }
      html += '</ul>\n';
      currentBulletList = [];
    }
  }

  // Helper: Convert contact links
  function convertContactLinks(text) {
    text = text.replace(
      /linkedin\.com\/in\/lokeshpara99/gi,
      '<a href="https://linkedin.com/in/lokeshpara99">LinkedIn</a>'
    );
    
    text = text.replace(
      /github\.com\/lokeshpara/gi,
      '<a href="https://github.com/lokeshpara">GitHub</a>'
    );
    
    text = text.replace(
      /lokeshpara\.github\.io\/Portfolio/gi,
      '<a href="https://lokeshpara.github.io/Portfolio">Portfolio</a>'
    );
    
    return text;
  }

  // Helper: Convert project names to hyperlinks
  function convertProjectNameToLink(text) {
    // Resume Optimizer AI
    if (text.includes('Resume Optimizer AI')) {
      text = text.replace(
        /(Resume Optimizer AI[^•\n]*)/,
        '<a href="https://github.com/lokeshpara/Resume-Optimizer-AI">$1</a>'
      );
    }
    
    // CIFAR-10
    if (text.includes('CIFAR-10') || text.includes('CIFAR10')) {
      text = text.replace(
        /(CIFAR-?10[^•\n]*)/,
        '<a href="https://github.com/lokeshpara/CIFAR10-Custom-ResNet">$1</a>'
      );
    }
    
    return text;
  }

  // Helper: Convert GitHub links in project subheaders
  function convertProjectLinks(text) {
    // Convert GitHub links
    text = text.replace(
      /(GitHub:\s*)(github\.com\/[^\s]+)/gi,
      '$1<a href="https://$2">$2</a>'
    );
    
    return text;
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // NAME
    if (i === 0 || (i < 3 && line.toUpperCase().includes('LOKESH'))) {
      flushBullets();
      html += `<div class="name">${line}</div>\n`;
      continue;
    }

    // TITLE
    if (i <= 3 && (line.includes('Software Engineer') || line.includes('Full Stack') || line.includes('Developer')) && !line.includes('|')) {
      flushBullets();
      html += `<div class="title">${line}</div>\n`;
      continue;
    }

    // CONTACT
    if ((line.includes('@') || line.includes('|')) && i < 6) {
      flushBullets();
      const contactWithLinks = convertContactLinks(line);
      html += `<div class="contact">${contactWithLinks}</div>\n`;
      continue;
    }

    // SECTION HEADERS
    if (line === line.toUpperCase() && line.length > 3 && !line.startsWith('•')) {
      if (line.includes('PROFESSIONAL EXPERIENCE') ||
          line.includes('PROJECTS') ||
          line.includes('TECHNICAL SKILLS') ||
          line.includes('EDUCATION') ||
          line.includes('CERTIFICATIONS')) {
        
        flushBullets();
        html += `<div class="section-header">${line}</div>\n`;
        
        inSkills = line.includes('SKILL');
        inCertifications = line.includes('CERTIFICATION');
        inEducation = line.includes('EDUCATION');
        inProjects = line.includes('PROJECTS');
        continue;
      }
    }

    // PROJECT HEADER (detect project names)
    if (inProjects && 
        !inSkills && 
        !inEducation && 
        !inCertifications &&
        !line.startsWith('•') &&
        !line.startsWith('GitHub:') &&
        !line.startsWith('Technologies:') &&
        (line.includes('Resume Optimizer') || 
         line.includes('CIFAR-10') || 
         line.includes('CIFAR10') ||
         line.includes('Chrome Extension') ||
         line.includes('Image Classification'))) {
      flushBullets();
      const projectWithLink = convertProjectNameToLink(line);
      html += `<div class="project-header">${projectWithLink}</div>\n`;
      continue;
    }

    // PROJECT SUBHEADER (GitHub: or Technologies: line)
    if (inProjects && 
        !inSkills && 
        !inEducation && 
        !inCertifications &&
        !line.startsWith('•') &&
        (line.startsWith('GitHub:') || line.startsWith('Technologies:'))) {
      flushBullets();
      const projectLinksConverted = convertProjectLinks(line);
      html += `<div class="project-subheader">${projectLinksConverted}</div>\n`;
      continue;
    }

    // COMPANY HEADER
    if (!inProjects && 
        line.includes('|') && 
        !line.startsWith('•') && 
        !line.includes('@') && 
        !inSkills &&
        !inEducation &&
        !inCertifications &&
        (line.includes('Developer') || line.includes('Engineer') || 
         line.includes('LPL') || line.includes('Athenahealth') || 
         line.includes('YES Bank') || line.includes('Comcast'))) {
      flushBullets();
      const pipeIdx = line.indexOf('|');
      const title = line.substring(0, pipeIdx).trim();
      const company = line.substring(pipeIdx + 1).trim();
      html += `<div class="company-header">${title}<span style="color:#6B7A8D;font-weight:normal"> | </span><span style="color:#2E4057">${company}</span></div>\n`;
      continue;
    }

    // JOB DATE
    if ((line.includes('Present') || 
         line.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)/i) ||
         line.match(/^\w+\s+\d{4}\s*[-–]\s*/)) && 
        !line.startsWith('•') &&
        !inSkills &&
        !inEducation &&
        !inProjects &&
        !inCertifications) {
      flushBullets();
      html += `<div class="job-date" style="font-size:10pt;color:#6B7A8D;font-style:italic;margin-bottom:3pt;">${line}</div>\n`;
      continue;
    }

    // SKILLS SECTION - NO BOLD (plain text only)
    if (inSkills && !inCertifications && !inEducation && !inProjects) {
      flushBullets();
      if (line.includes(':')) {
        const colonIdx = line.indexOf(':');
        const category = line.substring(0, colonIdx).trim();
        const skills = line.substring(colonIdx + 1).trim();
        
        // Don't process bold in skills section
        html += `<p class="skills-para"><strong>${category}:</strong> ${skills}</p>\n`;
        continue;
      }
    }

    // CERTIFICATIONS SECTION - NO BULLETS, PLAIN TEXT
    if (inCertifications && !inEducation && !inProjects) {
      flushBullets();
      
      // Remove bullet if present and display as plain paragraph
      let certText = line.replace(/^[•*-]\s*/, '');
      
      // Skip if it's just a bullet with no text
      if (certText.trim()) {
        html += `<p class="cert-item">${certText}</p>\n`;
      }
      continue;
    }

    // EDUCATION SECTION
    if (inEducation && !inCertifications && !inProjects) {
      flushBullets();
      if (line.includes('Master of Science') || line.includes('GPA:')) {
        html += `<p class="edu-degree">${line}</p>\n`;
        continue;
      }
      if (line.includes('University') || line.includes('Southern Arkansas')) {
        html += `<p class="edu-school">${line}</p>\n`;
        continue;
      }
    }

    // BULLETS (Experience AND Projects sections - NOT certifications)
    if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
      // Add to bullet list if in Experience OR Projects (but NOT certifications)
      if (!inCertifications) {
        const bulletContent = line.replace(/^[•*-]\s*/, '');
        currentBulletList.push(bulletContent);
        continue;
      }
    }

    // Any other line
    flushBullets();
    const processedLine = processBoldText(line);
    html += `<p>${processedLine}</p>\n`;
  }

  flushBullets();

  return html + `</body></html>`;
}

// ============================================================================
// PAGE FORMATTING
// ============================================================================

async function setDocumentFormatting(documentId) {
  try {
    console.log('📐 Setting exact page formatting...');

    const requests = [
      {
        updateDocumentStyle: {
          documentStyle: {
            marginTop: { magnitude: 36, unit: 'PT' },
            marginBottom: { magnitude: 36, unit: 'PT' },
            marginLeft: { magnitude: 36, unit: 'PT' },
            marginRight: { magnitude: 36, unit: 'PT' },
            pageSize: {
              width: { magnitude: 595, unit: 'PT' },
              height: { magnitude: 842, unit: 'PT' }
            }
          },
          fields: 'marginTop,marginBottom,marginLeft,marginRight,pageSize'
        }
      },
      {
        updateParagraphStyle: {
          range: {
            startIndex: 1,
            endIndex: 2
          },
          paragraphStyle: {
            lineSpacing: 108,
            spaceAbove: { magnitude: 0, unit: 'PT' },
            spaceBelow: { magnitude: 0, unit: 'PT' }
          },
          fields: 'lineSpacing,spaceAbove,spaceBelow'
        }
      }
    ];

    await docs.documents.batchUpdate({
      documentId: documentId,
      requestBody: { requests }
    });

    console.log('✅ Page formatting applied');
  } catch (error) {
    console.error('⚠️ Failed to set formatting:', error.message);
  }
}









// =====================================================
// RECRUITER AUTOMATION ENDPOINTS
// =====================================================

// POST /api/applications/:id/find-recruiters
app.post('/api/applications/:id/find-recruiters', async (req, res) => {
  try {
    const { id } = req.params;
     
    // Get API keys from .env (not from request body)
    const hunterApiKey = process.env.HUNTER_API_KEY;
    const aiProvider = process.env.AI_PROVIDER || 'chatgpt';
    const apiKey = aiProvider === 'gemini' 
      ? process.env.GEMINI_API_KEY 
      : process.env.CHATGPT_API_KEY;

    if (!hunterApiKey) {
      return res.status(400).json({ error: 'Hunter.io API key is required' });
    }
    if (!aiProvider || !apiKey) {
      return res.status(400).json({ error: 'AI provider and API key are required' });
    }

    console.log(`\n🔍 Finding recruiters for application #${id}...`);

    const appResult = await pool.query(
      `SELECT id, company_name, position_applied, jd_text, resume_link
       FROM applications WHERE id = $1`,
      [id]
    );

    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const application = appResult.rows[0];

    if (!application.jd_text) {
      return res.status(400).json({ 
        error: 'Job description is required. Please add JD text to the application first.' 
      });
    }

    if (!application.resume_link) {
      return res.status(400).json({ 
        error: 'Resume link is required. Please optimize resume first.' 
      });
    }

    console.log('📄 Fetching resume content from Google Docs...');
    const resumeDocId = application.resume_link.split('/d/')[1].split('/')[0];
    const resumeDoc = await docs.documents.get({ documentId: resumeDocId });
    const resumeContent = resumeDoc.data.body.content
      .map(element => {
        if (element.paragraph && element.paragraph.elements) {
          return element.paragraph.elements
            .map(e => e.textRun ? e.textRun.content : '')
            .join('');
        }
        return '';
      })
      .join('');

    console.log('✅ Resume content fetched');

    const results = await findRecruitersAndSendEmails({
      jobDescription: application.jd_text,
      resumeContent: resumeContent,
      resumeDocUrl: application.resume_link,
      aiProvider: aiProvider,
      apiKey: apiKey,
      hunterApiKey: hunterApiKey,
      gmail: gmail,
      pool: pool,
      applicationId: id,
      generateAIContent: generateAIContent
    });

    res.json({
      success: true,
      message: `Found ${results.recruiters.length} recruiters`,
      stats: results.stats,
      recruiters: results.recruiters,
      errors: results.errors
    });

  } catch (error) {
    console.error('❌ Recruiter automation error:', error);
    res.status(500).json({ 
      error: 'Failed to find recruiters',
      details: error.message 
    });
  }
});

// =====================================================
// GMAIL OAUTH ENDPOINTS (SEPARATE ACCOUNT)
// =====================================================

// GET /auth/gmail - Initiate Gmail OAuth (separate account)
app.get('/auth/gmail', (req, res) => {
  const authUrl = gmailOAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify'
    ],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// GET /oauth2callback-gmail - Handle Gmail OAuth callback
app.get('/oauth2callback-gmail', async (req, res) => {
  const { code } = req.query;
  
  try {
    const { tokens } = await gmailOAuth2Client.getToken(code);
    gmailOAuth2Client.setCredentials(tokens);
    
    console.log('✅ Gmail OAuth successful!');
    console.log('Add this to your .env file:');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    
    res.send(`
      <html>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h1 style="color: #4caf50;">✅ Recruiter Gmail Authorization Successful!</h1>
          <p><strong>This is for your RECRUITER EMAIL ACCOUNT</strong></p>
          <p>Add this to your .env file:</p>
          <pre style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: left; display: inline-block; max-width: 600px; word-wrap: break-word;">GMAIL_REFRESH_TOKEN=${tokens.refresh_token}</pre>
          <p style="margin-top: 20px; color: #666;">
            Account authorized: This will be used ONLY for sending recruiter email drafts
          </p>
          <p style="margin-top: 20px;">You can close this window now.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('❌ Gmail OAuth error:', error);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h1 style="color: #f44336;">❌ Authorization Failed</h1>
          <p>Error: ${error.message}</p>
          <p>Please try again or check the console logs.</p>
        </body>
      </html>
    `);
  }
});

// GET /api/gmail-drafts - Get all Gmail drafts
app.get('/api/gmail-drafts', async (req, res) => {
  try {
    const response = await gmail.users.drafts.list({
      userId: 'me',
      maxResults: 10
    });
    
    res.json({
      success: true,
      drafts: response.data.drafts || []
    });
  } catch (error) {
    console.error('❌ Failed to fetch drafts:', error);
    res.status(500).json({ 
      error: 'Failed to fetch drafts',
      details: error.message 
    });
  }
});

// POST /api/test/hunter - Test Hunter.io API
app.post('/api/test/hunter', async (req, res) => {
  try {
    const { hunterApiKey } = req.body;
    
    if (!hunterApiKey) {
      return res.status(400).json({ error: 'Hunter.io API key is required' });
    }

    console.log('🧪 Testing Hunter.io API...');
    const testUrl = `https://api.hunter.io/v2/domain-search?domain=stripe.com&limit=1&api_key=${hunterApiKey}`;
    const response = await axios.get(testUrl);
    
    console.log('✅ Hunter.io response received');
    console.log('Response structure:', JSON.stringify(response.data.meta, null, 2));
    
    // Handle different response structures
    let requestsInfo = {
      used: 0,
      available: 0
    };

    if (response.data && response.data.meta) {
      const meta = response.data.meta;
      
      // Check for requests object
      if (meta.requests) {
        requestsInfo.used = meta.requests.used || 0;
        requestsInfo.available = meta.requests.available || meta.requests.limit || 0;
      }
      // Fallback: check for direct properties
      else if (meta.calls) {
        requestsInfo.used = meta.calls.used || 0;
        requestsInfo.available = meta.calls.available || meta.calls.limit || 0;
      }
    }
    
    res.json({
      success: true,
      message: 'Hunter.io API is working!',
      accountInfo: {
        requests: requestsInfo
      }
    });
  } catch (error) {
    console.error('❌ Hunter.io test failed:', error.response?.data || error.message);
    
    res.status(500).json({
      success: false,
      error: 'Hunter.io API test failed',
      details: error.response?.data?.errors?.[0]?.details || error.response?.data || error.message
    });
  }
});

// POST /api/test/gmail - Test Gmail API (separate account)
app.post('/api/test/gmail', async (req, res) => {
  try {
    const profile = await gmail.users.getProfile({ userId: 'me' });
    
    res.json({
      success: true,
      message: 'Gmail API is working!',
      email: profile.data.emailAddress,
      note: 'This is your RECRUITER email account'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Gmail API test failed',
      details: error.message,
      hint: 'Make sure GMAIL_REFRESH_TOKEN is set in .env'
    });
  }
});


// =====================================================
// DASHBOARD ENDPOINTS
// =====================================================

// GET /api/dashboard/summary - Enhanced KPIs
app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_applications,
        COUNT(DISTINCT company_name) as unique_companies,
        COUNT(*) FILTER (WHERE status IN ('Interview', 'Offer')) as interview_count,
        COUNT(*) FILTER (WHERE status = 'Offer') as offers_received,
        COUNT(*) FILTER (WHERE date_applied >= CURRENT_DATE - INTERVAL '7 days') as this_week_count,
        AVG(CASE 
          WHEN status != 'Applied' 
          THEN EXTRACT(DAY FROM (updated_at - date_applied))
          ELSE NULL 
        END) as avg_response_time
      FROM applications
    `);

    const data = result.rows[0];
    const totalApps = parseInt(data.total_applications);
    const interviewCount = parseInt(data.interview_count);
    const interviewRate = totalApps > 0
      ? Math.round((interviewCount / totalApps) * 100)
      : 0;

    res.json({
      totalApplications: totalApps,
      uniqueCompanies: parseInt(data.unique_companies),
      interviewRate: interviewRate,
      avgResponseTime: data.avg_response_time
        ? Math.round(parseFloat(data.avg_response_time))
        : null,
      offersReceived: parseInt(data.offers_received),
      thisWeekCount: parseInt(data.this_week_count)
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

// GET /api/dashboard/daily - Daily application count
app.get('/api/dashboard/daily', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        date_applied,
        COUNT(*) as count
      FROM applications
      WHERE date_applied >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY date_applied
      ORDER BY date_applied ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Daily chart error:', error);
    res.status(500).json({ error: 'Failed to load daily data' });
  }
});

// GET /api/dashboard/status-dist - Status distribution
app.get('/api/dashboard/status-dist', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        status,
        COUNT(*) as count,
        ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 2) as percentage
      FROM applications
      GROUP BY status
      ORDER BY count DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Status distribution error:', error);
    res.status(500).json({ error: 'Failed to load status distribution' });
  }
});

// GET /api/dashboard/recent - Recent activity
app.get('/api/dashboard/recent', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        company_name,
        position_applied,
        status,
        updated_at,
        date_applied
      FROM applications
      ORDER BY updated_at DESC
      LIMIT 10
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Recent activity error:', error);
    res.status(500).json({ error: 'Failed to load recent activity' });
  }
});

// =====================================================
// APPLICATIONS ENDPOINTS
// =====================================================

// GET /api/applications - With optional filters
app.get('/api/applications', async (req, res) => {
  try {
    const { status, days, search } = req.query;

    let query = 'SELECT * FROM applications WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (days) {
      query += ` AND date_applied >= CURRENT_DATE - INTERVAL '${parseInt(days)} days'`;
    }

    if (search) {
      query += ` AND search_vector @@ plainto_tsquery('english', $${paramIndex})`;
      params.push(search);
      paramIndex++;
    }

    query += ' ORDER BY date_applied DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Applications list error:', error);
    res.status(500).json({ error: 'Failed to load applications' });
  }
});

// GET /api/applications/:id - Get single application
app.get('/api/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM applications WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get application error:', error);
    res.status(500).json({ error: 'Failed to load application' });
  }
});

// PUT /api/applications/:id - Update application
app.put('/api/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;

    const allowedFields = [
      'company_name',
      'position_applied',
      'status',
      'resume_link',
      'jd_link',
      'jd_text'
    ];

    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (allowedFields.includes(key)) {
        updates.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(id);
    const query = `
      UPDATE applications 
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update application error:', error);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

// DELETE /api/applications/:id - Delete application
app.delete('/api/applications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM applications WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete application error:', error);
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

// =====================================================
// NOTES ENDPOINTS
// =====================================================

// GET /api/applications/:id/notes - Get all notes for application
app.get('/api/applications/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM notes WHERE application_id = $1 ORDER BY created_at DESC',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get notes error:', error);
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

// POST /api/applications/:id/notes - Add note to application
app.post('/api/applications/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { note_text } = req.body;

    if (!note_text || !note_text.trim()) {
      return res.status(400).json({ error: 'Note text is required' });
    }

    const result = await pool.query(
      'INSERT INTO notes (application_id, note_text) VALUES ($1, $2) RETURNING *',
      [id, note_text.trim()]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Add note error:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// DELETE /api/notes/:noteId - Delete note
app.delete('/api/notes/:noteId', async (req, res) => {
  try {
    const { noteId } = req.params;
    await pool.query('DELETE FROM notes WHERE id = $1', [noteId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete note error:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// =====================================================
// CONTACTS ENDPOINTS (NEW!)
// =====================================================

// GET /api/applications/:id/contacts - Get all contacts for application
app.get('/api/applications/:id/contacts', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT c.* 
      FROM contacts c
      JOIN application_contacts ac ON c.id = ac.contact_id
      WHERE ac.application_id = $1
      ORDER BY c.id DESC
    `, [id]);

    res.json(result.rows);
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

// POST /api/applications/:id/contacts - Create new contact and link to application
app.post('/api/applications/:id/contacts', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { full_name, email, linkedin_url, role, notes } = req.body;

    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }

    await client.query('BEGIN');

    // Create contact
    const contactResult = await client.query(
      `INSERT INTO contacts (full_name, email, linkedin_url, role, notes) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [
        full_name.trim(),
        email ? email.trim() : null,
        linkedin_url ? linkedin_url.trim() : null,
        role ? role.trim() : null,
        notes ? notes.trim() : null
      ]
    );

    const contactId = contactResult.rows[0].id;

    // Link contact to application
    await client.query(
      'INSERT INTO application_contacts (application_id, contact_id) VALUES ($1, $2)',
      [id, contactId]
    );

    await client.query('COMMIT');

    res.json(contactResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create contact error:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  } finally {
    client.release();
  }
});

// GET /api/contacts/:id - Get single contact
app.get('/api/contacts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM contacts WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get contact error:', error);
    res.status(500).json({ error: 'Failed to load contact' });
  }
});

// PUT /api/contacts/:id - Update contact
app.put('/api/contacts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, linkedin_url, role, notes } = req.body;

    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }

    const result = await pool.query(
      `UPDATE contacts 
       SET full_name = $1, email = $2, linkedin_url = $3, role = $4, notes = $5
       WHERE id = $6
       RETURNING *`,
      [
        full_name.trim(),
        email ? email.trim() : null,
        linkedin_url ? linkedin_url.trim() : null,
        role ? role.trim() : null,
        notes ? notes.trim() : null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/applications/:appId/contacts/:contactId - Unlink and delete contact
app.delete('/api/applications/:appId/contacts/:contactId', async (req, res) => {
  const client = await pool.connect();

  try {
    const { appId, contactId } = req.params;

    await client.query('BEGIN');

    // Remove link
    await client.query(
      'DELETE FROM application_contacts WHERE application_id = $1 AND contact_id = $2',
      [appId, contactId]
    );

    // Check if contact is linked to other applications
    const linkCheck = await client.query(
      'SELECT COUNT(*) as count FROM application_contacts WHERE contact_id = $1',
      [contactId]
    );

    // If not linked to any other applications, delete the contact
    if (parseInt(linkCheck.rows[0].count) === 0) {
      await client.query('DELETE FROM contacts WHERE id = $1', [contactId]);
    }

    await client.query('COMMIT');

    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  } finally {
    client.release();
  }
});

// =====================================================
// EXPORT ENDPOINT
// =====================================================

// GET /api/export/csv - Export applications as CSV
app.get('/api/export/csv', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        company_name,
        position_applied,
        date_applied,
        status,
        resume_link,
        jd_link
      FROM applications
      ORDER BY date_applied DESC
    `);

    const headers = ['Company', 'Position', 'Date Applied', 'Status', 'Resume Link', 'JD Link'];
    const rows = result.rows.map(row => [
      row.company_name,
      row.position_applied,
      row.date_applied,
      row.status,
      row.resume_link || '',
      row.jd_link || ''
    ]);

    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=applications_${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('Export CSV error:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// =====================================================
// SERVE STATIC FILES
// =====================================================

app.use(express.static('public'));

// Dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

// Application details route
app.get('/application/:id', (req, res) => {
  res.sendFile(__dirname + '/public/application.html');
});

// =====================================================
// AUTO-APPLY PAGE ROUTES
// =====================================================
app.get('/auto-apply', (req, res) => {
  res.sendFile(__dirname + '/public/auto-apply.html');
});

app.get('/auto-apply/live', (req, res) => {
  res.sendFile(__dirname + '/public/auto-apply-live.html');
});

app.get('/profile-settings', (req, res) => {
  res.sendFile(__dirname + '/public/profile-settings.html');
});

app.get('/auto-apply/:id', (req, res) => res.redirect(`/application/${req.params.id}`));

// =====================================================
// DATABASE TABLE CREATION
// =====================================================
createCheckpointTable(pool);
createBotSessionsTable(pool);

// =====================================================
// START SERVER WITH WEBSOCKET
// =====================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/auto-apply' });

registerAutoApplyRoutes(app, { pool, generateAIContent, wss, WebSocket });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected (auto-apply)');
  const { botState } = require('./auto-apply/bot-state');
  ws.send(JSON.stringify({ type: 'bot_state', data: botState.snapshot() }));
  ws.on('close', () => console.log('WebSocket disconnected'));
  ws.on('error', (err) => console.error('WebSocket error:', err.message));
});

server.listen(PORT, () => {
  console.log(`\nResume Optimizer Backend Running!`);
  console.log(`http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`Auto Apply: http://localhost:${PORT}/auto-apply`);
  console.log(`Profile Settings: http://localhost:${PORT}/profile-settings`);
  console.log('');
});

// =====================================================
// ERROR HANDLING
// =====================================================

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing database pool...');
  await pool.end();
  process.exit(0);
});