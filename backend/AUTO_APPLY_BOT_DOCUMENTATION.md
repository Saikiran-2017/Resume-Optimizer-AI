# Auto-Apply Bot — Complete Technical Documentation
# For use in Cursor AI to build the full system

---

## 1. PROJECT OVERVIEW

An intelligent job application bot that automatically fills and submits job applications on third-party ATS portals (starting with Workday). The bot is triggered from 3 places, uses AI to understand and answer every field, shows the user a live real-time view of what it is doing, and always pauses before final submission so the human clicks Submit.

---

## 2. TECH STACK — USE EXACTLY THESE TOOLS

### Browser Automation
- **Playwright** (NOT Puppeteer)
  - More reliable than Puppeteer for modern SPAs like Workday
  - Better auto-wait behavior — waits for elements automatically
  - Built-in network interception, screenshots, tracing
  - Works headful (visible browser) so user can watch and intervene
  - Install: `npm install playwright`
  - Use chromium browser in headed mode (visible)

### AI for Field Answering
- **OpenAI GPT-4o** via existing `generateAIContent()` in server.js
  - Input: all fields on current page + profile.json + job description
  - Output: structured JSON `{ fieldKey: answer }` for every field
  - One AI call per page (not per field — batch everything)

### Real-time Communication
- **WebSocket** (already in server.js at `ws://localhost:3000/ws/auto-apply`)
  - Bot sends state updates to frontend every time anything changes
  - Frontend renders live panel showing exactly what bot is doing

### Backend
- **Node.js + Express** (existing server.js)
- **PostgreSQL** (existing pool) — log bot sessions
- All auto-apply files live in `backend/auto-apply/` folder

### Frontend
- Vanilla HTML/CSS/JS (matching existing retro brutalist style)
- WebSocket client for live updates
- No React, no framework

---

## 3. TRIGGER POINTS — 3 WAYS TO START

### Trigger 1 — Chrome Extension (existing extension, add button)
**Location:** After resume optimization result appears in the extension popup
**What to add:** An "🤖 Auto Apply" button below the resume links
**What it sends to backend:**
```json
{
  "trigger": "extension",
  "jdUrl": "https://company.wd1.myworkdayjobs.com/...",
  "resumeLink": "https://docs.google.com/document/d/.../edit",
  "jobDescription": "full JD text",
  "companyName": "GEICO",
  "position": "Senior Software Engineer",
  "applicationId": 123
}
```
**How:** POST to `http://localhost:3000/api/auto-apply/start`
**Then:** Open `http://localhost:3000/auto-apply/live` in a new tab to show live view

**RESUME DOWNLOAD — Trigger 1 and Trigger 2:**
The resumeLink is a Google Docs URL. Backend must convert it to a PDF before bot uploads it.
```javascript
async function downloadResumePdf(resumeLink) {
  const match = resumeLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('Invalid Google Docs URL');
  const fileId = match[1];
  const pdfUrl = `https://docs.google.com/document/d/${fileId}/export?format=pdf`;
  const response = await axios.get(pdfUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const tmpPath = path.join(os.tmpdir(), `resume_${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, response.data);
  return tmpPath; // pass this path to Playwright file upload
}
// Always delete temp PDF after session ends in pipeline cleanup
```
Trigger 3 (manual): user uploads PDF directly — save to temp folder, use that path directly.

### Trigger 2 — Application Detail Page (`/application/:id`)
**Location:** The "🤖 Auto Apply Bot" card already exists in `application.html`
**What to add:** "Launch Auto Apply" button opens modal with:
- Job post URL (pre-filled from `jd_link` field)
- Resume link (pre-filled from `resume_link` field — Google Docs URL, auto-downloaded as PDF by backend)
- JD text (pre-filled from `jd_text` field)
- AI provider selector
- "Launch Bot" button
**After launch:** Live panel appears on same page showing bot activity

### Trigger 3 — Manual Page (`/auto-apply`)
**A dedicated page** with these sections:
1. **Job Post URL** — text input — paste the Workday/job URL
2. **Job Description** — large textarea — paste the full JD text
3. **Resume Upload** — file upload OR Google Docs link input
4. **Profile** — shows current profile.json data, editable inline
5. **Start Bot** button
**No application record needed** — fully standalone

---

## 4. LIVE VIEW — WHAT USER SEES WHILE BOT RUNS

### Real-time Panel (shown on all 3 trigger pages)
This is the most important UX requirement. User must always see what the bot is doing.

```
┌─────────────────────────────────────────────────────┐
│ 🤖 BOT STATUS: FILLING  |  Workday  |  Page 2 of 4  │
├─────────────────────────────────────────────────────┤
│ ✅ Filled: 12 fields    ⚠️ Flagged: 2 fields          │
├─────────────────────────────────────────────────────┤
│ CURRENTLY FILLING:                                  │
│   "Years of Experience" → typing "5"                │
├─────────────────────────────────────────────────────┤
│ ⚠️ NEEDS YOUR ATTENTION:                             │
│   • "Security Clearance" — no answer in profile     │
│   • "LinkedIn URL" — fill manually in browser       │
├─────────────────────────────────────────────────────┤
│ [⏸️ Pause]  [⏹️ Stop]  [▶️ Resume]                   │
├─────────────────────────────────────────────────────┤
│ ACTIVITY LOG (live):                                │
│  14:32:01  Detected Workday portal                  │
│  14:32:03  Clicked Apply button                     │
│  14:32:08  Page 1: scanned 8 fields                 │
│  14:32:09  AI answered all 8 fields                 │
│  14:32:15  Filled: First Name → "Sai Kiran"            │
│  14:32:16  Filled: Last Name → "P"               │
│  14:32:17  Filled: Email → "saikiran.itcareer@gmail.com"  │
│  14:32:20  Uploaded resume PDF                      │
│  14:32:22  Clicked Next → Page 2                    │
└─────────────────────────────────────────────────────┘
```

### WebSocket Events sent from bot to frontend
Every event is JSON: `{ type: "bot_state", data: { ...snapshot } }`

Bot state snapshot always includes:
```json
{
  "state": "filling",
  "atsType": "workday",
  "currentPage": 2,
  "totalPages": 4,
  "currentField": { "label": "Years of Experience", "answer": "5" },
  "filled": 12,
  "flagged": 2,
  "flaggedList": [
    { "label": "Security Clearance", "reason": "not in profile" },
    { "label": "LinkedIn URL", "reason": "field format unknown" }
  ],
  "log": [
    { "time": "14:32:22", "message": "Clicked Next → Page 2" },
    ...last 20 entries
  ],
  "error": null,
  "sessionId": "abc123"
}
```

---

## 5. BOT STATES (state machine)

```
IDLE → DETECTING → CLICKING_APPLY → SCANNING → AI_THINKING → FILLING → PAUSED → REVIEWING → WAITING_SUBMIT → DONE
                                                                              ↕
                                                                         (human resumes)
ERROR (can happen from any state)
STUCK (login wall, captcha, unexpected page — 10 min timeout then ERROR)
```

State transitions:
- `IDLE` → `DETECTING` when start() called
- `DETECTING` → `CLICKING_APPLY` when ATS identified
- `CLICKING_APPLY` → `SCANNING` after apply button clicked
- `SCANNING` → `AI_THINKING` after all fields extracted
- `AI_THINKING` → `FILLING` after AI returns answers
- `FILLING` → `REVIEWING` after all fields on page filled
- `REVIEWING` → user sees "Confirm & Continue" button
- `REVIEWING` → `SCANNING` (next page) when user confirms
- `REVIEWING` → `WAITING_SUBMIT` on last page
- `WAITING_SUBMIT` → bot shows Submit button, DOES NOT CLICK IT
- Human clicks Submit manually in the browser
- `WAITING_SUBMIT` → `DONE` when bot detects submission success page
- Any state → `STUCK` if bot can't proceed for 10 minutes
- `STUCK` → `PAUSED` + notify user to help + start 10 min countdown
- Any state → `PAUSED` when human clicks Pause
- `PAUSED` → re-reads page → continues from where it was

---

## 6. FILE STRUCTURE

```
backend/
├── server.js                          ← existing, add WebSocket + routes
├── auto-apply/
│   ├── profile.json                   ← personal data (editable via UI)
│   ├── bot-state.js                   ← state machine + EventEmitter
│   ├── detector.js                    ← identify ATS from URL/page
│   ├── page-scanner.js                ← extract all fields from any page
│   ├── field-ai.js                    ← ask GPT-4o to answer all fields
│   ├── field-filler.js                ← fill each field by type
│   ├── pipeline.js                    ← orchestrate full flow
│   ├── routes.js                      ← API endpoints
│   └── ats/
│       ├── workday.js                 ← Workday-specific handler (BUILD FIRST)
│       ├── greenhouse.js              ← (build after Workday works)
│       ├── lever.js                   ← (build after Greenhouse works)
│       └── generic.js                 ← fallback for unknown ATS

public/
├── auto-apply.html                    ← Trigger 3: manual paste page
├── auto-apply.css                     ← styles for auto-apply pages
├── auto-apply.js                      ← WebSocket client + live panel
├── auto-apply-live.html               ← standalone live view (opens in new tab)
├── profile-settings.html              ← edit profile.json via UI
└── profile-settings.js
```

---

## 7. API ENDPOINTS

### Start bot
```
POST /api/auto-apply/start
Body: {
  jdUrl: string,           -- job post URL (Workday page URL)
  resumeLink: string,      -- Google Docs link OR will use uploaded file
  jobDescription: string,  -- full JD text for AI context
  companyName: string,
  position: string,
  applicationId: number,   -- optional, null if triggered from /auto-apply
  aiProvider: "chatgpt"
}
Response: { success: true, sessionId: string, state: BotSnapshot }
```

### Bot controls
```
POST /api/auto-apply/confirm     -- user confirms page, bot goes to next
POST /api/auto-apply/pause       -- pause bot
POST /api/auto-apply/resume      -- resume bot (bot re-reads page)
POST /api/auto-apply/stop        -- stop bot + close browser
```

### Status
```
GET /api/auto-apply/status       -- current bot state snapshot
GET /api/auto-apply/sessions     -- past sessions from DB
GET /api/auto-apply/session/:id  -- specific session details
```

### Profile
```
GET  /api/auto-apply/profile     -- get profile.json
POST /api/auto-apply/profile     -- save profile.json (from settings UI)
```

### WebSocket
```
ws://localhost:3000/ws/auto-apply
-- server pushes BotSnapshot on every state change
-- no client messages needed
```

---

## 8. PROFILE.JSON STRUCTURE

This file drives all field answers. Must be complete.

```json
{
  "personal": {
    "fullName": "Sai Kiran P",
    "firstName": "Sai Kiran",
    "lastName": "P",
    "email": "saikiran.itcareer@gmail.com",
    "phone": "+1 (940) 344-2150",
    "phoneFormatted": "+19403442150",
    "linkedin": "https://www.linkedin.com/in/saikiran2017/",
    "github": "https://github.com/Saikiran-2017",
    "portfolio": "https://saikirandev-portfolio.vercel.app",
    "address": {
      "street": "1203 Meadow Creek Dr",
      "city": "Irving",
      "state": "Texas",
      "stateCode": "TX",
      "zip": "75038",
      "country": "United States",
      "countryCode": "US"
    }
  },
  "workAuthorization": {
    "authorized": true,
    "requireSponsorship": true,
    "visaStatus": "F-1 OPT/STEM OPT",
    "willingToRelocate": false,
    "workRemote": true,
    "workHybrid": true,
    "workOnsite": true
  },
  "employment": {
    "currentEmployer": "LPL Financial",
    "currentTitle": "Java Full Stack Developer",
    "expectedSalary": "120000",
    "expectedSalaryMin": "110000",
    "expectedSalaryMax": "140000",
    "noticePeriod": "0",  // Always answer "0" or "immediately" for notice period
    "yearsOfExperience": "5",
    "startDate": "immediately"
  },
  "education": {
    "degree": "Master of Science",
    "field": "Computer and Information Sciences",
    "school": "Southern Arkansas University",
    "graduationYear": "2022",
    "gpa": "3.9"
  },
  "demographics": {
    "gender": "Male",
    "ethnicity": "Asian",
    "veteran": false,
    "disability": false,
    "hispanicLatino": false
  },
  "workHistory": [
    {
      "company": "LPL Financial",
      "title": "Java Full Stack Developer",
      "startDate": "June 2025",
      "endDate": "Present",
      "current": true,
      "location": "San Diego, California",
      "description": "Built portfolio management systems for 19,000+ financial advisors using Java, Spring Boot, Apache Kafka, React, and AWS. Developed RESTful APIs integrating Bloomberg market data feeds for real-time portfolio pricing. Implemented event-driven microservices processing 2M+ daily transactions with 99.9% uptime. Led migration of legacy monolith to microservices architecture using Docker and Kubernetes on AWS EKS."
    },
    {
      "company": "Athenahealth",
      "title": "Java Full Stack Developer",
      "startDate": "August 2024",
      "endDate": "May 2025",
      "current": false,
      "location": "Boston, MA",
      "description": "Developed HIPAA-compliant patient portal using Java, Spring Boot, FHIR R4 APIs, and Angular. Built secure data pipelines for EHR integration handling 500K+ daily patient records. Implemented OAuth2 and JWT authentication reducing unauthorized access incidents by 90%. Designed real-time notifications system using WebSocket and Redis for 2M+ active patients."
    },
    {
      "company": "YES Bank",
      "title": "Java Full Stack Developer",
      "startDate": "November 2021",
      "endDate": "July 2023",
      "current": false,
      "location": "Mumbai, India",
      "description": "Developed digital banking and payments platform processing 5M+ daily transactions using Java, Spring Boot, and Apache Kafka. Built UPI payment integration and NEFT/RTGS transfer modules for mobile banking application. Implemented PCI-DSS compliant payment gateway with 256-bit encryption. Designed React-based dashboard for real-time transaction monitoring and fraud detection."
    },
    {
      "company": "Comcast Corporation",
      "title": "Java Developer",
      "startDate": "May 2020",
      "endDate": "October 2021",
      "current": false,
      "location": "Chennai, India",
      "description": "Built xFi platform features for residential internet management serving 30M+ customers using Java and Spring Boot. Developed device management APIs for network configuration and parental controls. Implemented real-time network diagnostics using WebSocket reducing customer support calls by 35%. Built automated testing suite with JUnit and Mockito achieving 85% code coverage."
    }
  ],
  "commonAnswers": {
    "coverLetter": "I am writing to express my interest in this position. With 5+ years of experience in Java full-stack development across fintech, healthcare, and telecom domains, I am confident I can add immediate value to your team.",
    "whyThisRole": "This role aligns perfectly with my expertise in Java, Spring Boot, and cloud technologies. I am eager to contribute to your engineering team.",
    "availability": "I am available to start within 2 weeks of receiving an offer.",
    "salaryExpectation": "My expected salary range is $110,000-$140,000 based on the role and responsibilities.",
    "references": "Available upon request."
  }
}
```

---

## 8b. ADDRESS LOGIC — SMART LOCATION DETECTION

The bot must determine the correct address to fill based on the job location in the JD.

### Rules (in priority order):

**Rule 1 — Remote job:**
If JD contains "remote", "work from home", "WFH", "fully remote", "100% remote":
→ Use default address: `1203 Meadow Creek Dr, Irving, Texas 75038`
→ Do not try to find a local address

**Rule 2 — JD has a specific city/state:**
If JD mentions a location like "San Diego, CA" or "Boston, MA" or "New York":
→ Use that city and state for address fields
→ For street address: use default `1203 Meadow Creek Dr` (apartments don't matter for applications)
→ For zip code: use AI to find a realistic zip code for that city
→ Example: JD says "San Diego, CA" → fill city=San Diego, state=CA, zip=92101

**Rule 3 — No location mentioned:**
If JD has no location or says "multiple locations":
→ Use default address: `1203 Meadow Creek Dr, Irving, Texas 75038, United States`

### Implementation in field-ai.js:
```javascript
// Extract job location from JD before building AI prompt
function extractJobLocation(jobDescription) {
  const remoteKeywords = /remote|work from home|wfh|fully remote|100% remote/i;
  if (remoteKeywords.test(jobDescription)) {
    return { type: 'remote', city: 'Irving', state: 'Texas', stateCode: 'TX', zip: '75038', street: '1203 Meadow Creek Dr' };
  }

  // Try to find city, state pattern in JD
  const locationPattern = /(?:located in|location:|based in|office in|on-?site in)?\s*([A-Z][a-zA-Z\s]+),\s*([A-Z]{2})/g;
  const match = locationPattern.exec(jobDescription);
  if (match) {
    return { type: 'onsite', city: match[1].trim(), state: match[2], street: '1203 Meadow Creek Dr', zip: null };
    // zip will be filled by AI prompt
  }

  // Default
  return { type: 'default', city: 'Irving', state: 'Texas', stateCode: 'TX', zip: '75038', street: '1203 Meadow Creek Dr' };
}
```

### AI prompt addition for address:
Add this to the field-ai.js prompt when address fields are present:
```
JOB LOCATION: {extracted location from JD}
ADDRESS RULE:
- If job is remote → use Irving Texas address
- If job has specific city → use that city/state, street=1203 Meadow Creek Dr, find realistic zip for that city
- For zip code field: provide a real zip code for the city, not a made-up number
```

---

## 8c. NOTICE PERIOD — ALWAYS ZERO

For any field asking about notice period, availability, or when you can start:
- Notice period fields → always answer "0", "0 days", "immediately", or "2 weeks" — pick the option closest to immediate/zero
- "When can you start?" → always "Immediately" or "As soon as possible"
- "How many days notice?" → always "0"
- For dropdown with options → pick the shortest notice period option available

---

## 8d. WORK HISTORY DESCRIPTION — AI-DRIVEN, NOT TEMPLATE

### The Problem
Workday's "My Experience" section has a "Description" or "Responsibilities" textarea for each job. This must NOT use a pre-written template. Instead:

### How it works:
1. Bot finds the description/responsibilities textarea for a specific job entry
2. Bot reads the **label** and any **placeholder text** or **instructions** shown on the page
3. Bot sends the actual page content + job entry context to AI
4. AI generates a natural, relevant description based on what the page is asking for

### Implementation:
```javascript
// In workday.js — when handling work experience description field
async function fillWorkExperienceDescription(page, jobEntry, jobDescription, generateAIContent, apiKey) {
  // Read what the page actually asks for
  const fieldLabel = await page.textContent('[data-automation-id*="description"] label, [data-automation-id*="responsibilities"] label');
  const placeholder = await page.getAttribute('[data-automation-id*="description"] textarea', 'placeholder') || '';
  const maxLength = await page.getAttribute('[data-automation-id*="description"] textarea', 'maxlength') || '2000';
  const charCounter = await page.textContent('[data-automation-id*="characterCount"]').catch(() => '');

  // Send to AI with the ACTUAL page context — not a pre-defined template
  const prompt = `You are filling a work experience form field in a job application.

FIELD LABEL: "${fieldLabel}"
PLACEHOLDER TEXT: "${placeholder}"
MAX CHARACTERS: ${maxLength}
${charCounter ? `CURRENT CHAR COUNTER: ${charCounter}` : ''}

JOB BEING DESCRIBED:
Company: ${jobEntry.company}
Title: ${jobEntry.title}
Duration: ${jobEntry.startDate} - ${jobEntry.endDate}
Location: ${jobEntry.location}

AVAILABLE DESCRIPTION CONTENT:
${jobEntry.description}

RULE: Write a natural description that fits exactly what this field is asking for based on the label and placeholder. 
If it asks for "responsibilities" → write responsibilities bullet points.
If it asks for "description" → write a paragraph description.
If it asks for "key achievements" → write achievement-focused content.
Keep within ${maxLength} characters.
Sound human-written, not AI-generated.
Do not use buzzwords like "leveraged", "spearheaded", "championed".

Return ONLY the text to fill in, nothing else.`;

  const answer = await generateAIContent(prompt, 'chatgpt', apiKey);
  
  // Type it into the field (human-like speed)
  const textarea = await page.$('[data-automation-id*="description"] textarea, [data-automation-id*="responsibilities"] textarea');
  await textarea.fill('');
  await textarea.type(answer.trim(), { delay: 20 });
}
```

### Key principle:
- Read what the page ACTUALLY says (label, placeholder, instructions)
- Send that ACTUAL text to AI
- AI adapts the answer to what that specific field is asking
- Never use a hardcoded template
- Always check character limit and stay within it


---

## 9. WORKDAY BOT — DETAILED FLOW

### 9.1 How Workday Works (know before building)
- Workday is a React SPA
- Every field has `data-automation-id` attribute — USE THIS, not CSS classes
- Forms are multi-page (typically 4-6 pages): Resume → My Information → My Experience → Application Questions → Voluntary Disclosures → Review
- Workday renders fields dynamically — must wait for them to appear
- Custom dropdowns are NOT `<select>` — they are `<div role="combobox">` — need special handling
- File upload uses hidden `<input type="file">` triggered by clicking a styled button
- Date fields use custom date pickers — need special handling

### 9.2 Playwright Setup for Workday

```javascript
const { chromium } = require('playwright');

const browser = await chromium.launch({
  headless: false,           // MUST be visible so user can watch and help
  slowMo: 50,                // slight delay so bot looks human
  args: ['--start-maximized']
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
});

const page = await context.newPage();
```

### 9.3 Page Scanner — What to Extract

For each page, extract ALL of these field types:

```javascript
// TEXT fields
{ type: 'text', key, label, selector, value, required, placeholder }

// TEXTAREA fields
{ type: 'textarea', key, label, selector, value, required }

// NATIVE SELECT (rare in Workday)
{ type: 'select', key, label, selector, options: [{value, text}], required }

// WORKDAY CUSTOM DROPDOWN (most common)
{ type: 'workday-dropdown', key, label, automationId, currentValue, required }
// To fill: click it → wait for list → find matching option → click

// RADIO GROUP
{ type: 'radio', key, label, options: [{value, text, selected}], required }

// CHECKBOX
{ type: 'checkbox', key, label, selector, checked, required }

// FILE UPLOAD
{ type: 'file', key, label, selector, accept, required }
// For Workday: find [data-automation-id="file-upload-input-ref"]

// DATE PICKER
{ type: 'date', key, label, selector, value, required }

// RICH TEXT EDITOR (cover letter, essay questions)
{ type: 'richtext', key, label, selector, value, required }
```

### 9.4 AI Field Answering — Prompt Structure

Send ONE prompt per page with ALL fields:

```
You are filling a Workday job application for Sai Kiran P.

JOB: {position} at {companyName}
JD SUMMARY: {first 2000 chars of jobDescription}

CANDIDATE PROFILE:
{full profile.json as formatted text}

FIELDS ON THIS PAGE:
FIELD 1:
  key: legalNameSection_firstName
  label: "First Name"
  type: text
  required: true

FIELD 2:
  key: countryDropdown
  label: "Country"
  type: workday-dropdown
  options: ["United States", "Canada", "India", ...]
  required: true

FIELD 3:
  key: howDidYouHear
  label: "How did you hear about this position?"
  type: workday-dropdown
  options: ["LinkedIn", "Indeed", "Company Website", "Referral", "Other"]
  required: false

...all fields...

RULES:
1. Return ONLY valid JSON, no explanation, no markdown
2. Key = the field "key" value shown above
3. For dropdown fields: return EXACTLY one of the option texts shown
4. For text fields: return appropriate answer from profile
5. For yes/no questions about sponsorship: Sai Kiran P DOES require sponsorship
6. For salary fields: use 120000
7. For fields you cannot answer confidently: return "__SKIP__"
8. Never return "__SKIP__" for required fields — always provide best answer
9. For EEO/demographic fields: use profile demographics data

Return JSON:
{
  "legalNameSection_firstName": "Sai Kiran",
  "countryDropdown": "United States",
  "howDidYouHear": "LinkedIn"
}
```

### 9.5 Field Filler — How to Fill Each Type

```javascript
// TEXT — clear existing, type new value
await page.fill(selector, '');
await page.type(selector, value, { delay: 30 }); // human-like typing speed

// WORKDAY CUSTOM DROPDOWN — click → wait → find option → click
await page.click(`[data-automation-id="${automationId}"]`);
await page.waitForSelector('[data-automation-id="promptOption"]', { timeout: 3000 });
// Search through options, click matching one
const options = await page.$$('[data-automation-id="promptOption"]');
for (const opt of options) {
  const text = await opt.innerText();
  if (text.toLowerCase().includes(targetValue.toLowerCase())) {
    await opt.click();
    break;
  }
}

// IF dropdown has search — type first few chars to filter
await page.type(`[data-automation-id="${automationId}"]`, value.substring(0, 3));
await page.waitForTimeout(500);
// then find and click option

// FILE UPLOAD — use Playwright's setInputFiles
const fileInput = await page.$('[data-automation-id="file-upload-input-ref"]');
await fileInput.setInputFiles(resumePdfPath);
await page.waitForTimeout(2000); // wait for upload confirmation

// RADIO — find by label text, click
const radios = await page.$$('input[type="radio"]');
for (const radio of radios) {
  const label = await radio.evaluate(el => {
    const lbl = document.querySelector(`label[for="${el.id}"]`);
    return lbl ? lbl.innerText : '';
  });
  if (label.toLowerCase().includes(targetValue.toLowerCase())) {
    await radio.click();
    break;
  }
}

// CHECKBOX
const checkbox = await page.$(selector);
const isChecked = await checkbox.isChecked();
if (shouldCheck && !isChecked) await checkbox.click();
if (!shouldCheck && isChecked) await checkbox.click();

// DATE — Workday date picker — type directly
await page.fill(selector, value); // format: MM/DD/YYYY
await page.keyboard.press('Tab');

// SKIP pre-filled fields
const currentValue = await page.inputValue(selector);
if (currentValue && currentValue.trim() !== '') {
  console.log(`Skipping pre-filled: ${label} = "${currentValue}"`);
  continue; // NEVER overwrite pre-filled fields
}
```

### 9.6 Workday Page Navigation

```javascript
// Detect current page title
const pageTitle = await page.textContent('[data-automation-id="page-header-title"]');

// Known Workday pages and special handling:
// "My Information" → fill name, address, phone, email, linkedin
// "My Experience" → resume upload, work history (usually pre-populated from resume parse)
// "Application Questions" → custom questions per job — all handled by AI
// "Voluntary Disclosures" → EEO fields — use demographics from profile
// "Review" → DO NOT AUTO-SUBMIT — pause and wait for human

// Next button
const nextBtn = await page.$('[data-automation-id="bottom-navigation-next-button"]');
if (nextBtn) await nextBtn.click();

// Submit button — DETECT BUT DO NOT CLICK
const submitBtn = await page.$('[data-automation-id="bottom-navigation-submit-button"]');
if (submitBtn) {
  botState.setState('WAITING_SUBMIT');
  // Notify user: "Ready to submit — please click Submit in the browser"
  // Bot waits here — does NOT click submit
  // Bot watches for submission success page
  await waitForSubmissionOrUserAction(page, botState);
}
```

### 9.7 Stuck Detection & Recovery

```javascript
async function checkIfStuck(page, botState) {
  // Detect login wall
  const loginForm = await page.$('input[type="password"]');
  if (loginForm) {
    botState.setState('STUCK');
    botState.setStuckReason('Login required — please log in then click Resume');
    startStuckTimer(10 * 60 * 1000); // 10 minute timeout
    await waitForResume(botState);
    // After resume: re-scan the page
    return true;
  }

  // Detect CAPTCHA
  const captcha = await page.$('iframe[src*="recaptcha"], .cf-challenge');
  if (captcha) {
    botState.setState('STUCK');
    botState.setStuckReason('CAPTCHA detected — please solve it then click Resume');
    startStuckTimer(10 * 60 * 1000);
    await waitForResume(botState);
    return true;
  }

  // Detect unexpected page (not a Workday form page)
  const workdayContent = await page.$('[data-automation-id]');
  if (!workdayContent) {
    botState.setState('STUCK');
    botState.setStuckReason('Unexpected page — bot cannot read this. Please navigate manually then click Resume');
    startStuckTimer(10 * 60 * 1000);
    await waitForResume(botState);
    return true;
  }

  return false;
}
```

---

## 10. FRONTEND — `/auto-apply` PAGE (Trigger 3)

### Layout
```
┌──────────────────────────────────────────────────┐
│  🤖 Auto Apply                                   │
│  Apply to any job automatically                  │
├──────────────────────────────────────────────────┤
│  Job Post URL *                                  │
│  [https://company.wd1.myworkdayjobs.com/...]     │
│                                                  │
│  Job Description *                               │
│  [large textarea — paste full JD here      ]     │
│  [                                         ]     │
│  [                                         ]     │
│                                                  │
│  Resume                                          │
│  ○ Use Google Docs link:                         │
│    [https://docs.google.com/document/d/...]      │
│  ○ Upload PDF file:                              │
│    [Choose File]                                 │
│                                                  │
│  Your Profile                                    │
│  [Edit Profile →] (links to /profile-settings)  │
│                                                  │
│  [🤖 Start Auto Apply]                           │
├──────────────────────────────────────────────────┤
│  LIVE BOT PANEL (appears after Start)            │
│  (same live panel as application.html)           │
└──────────────────────────────────────────────────┘
```

---

## 11. FRONTEND — LIVE PANEL (all 3 triggers share this)

The live panel is a reusable component. Same HTML/JS used in:
- `application.html` (Trigger 2)
- `auto-apply.html` (Trigger 3)
- `auto-apply-live.html` (standalone tab opened by extension, Trigger 1)

### Live Panel HTML Structure
```html
<div id="botLivePanel" class="bot-live-panel hidden">

  <!-- Header row -->
  <div class="live-header">
    <span id="liveState">IDLE</span>
    <span id="liveAts"></span>
    <span id="livePage"></span>
    <span id="liveCounts">✅ 0 filled  ⚠️ 0 flagged</span>
  </div>

  <!-- Currently doing -->
  <div class="live-current" id="liveCurrent">
    Waiting to start...
  </div>

  <!-- Control buttons — change based on state -->
  <div class="live-controls" id="liveControls">
    <!-- Rendered by JS based on bot state -->
  </div>

  <!-- Flagged fields -->
  <div class="live-flagged hidden" id="liveFlagged">
    <div class="flagged-title">⚠️ Needs your attention</div>
    <div id="flaggedList"></div>
  </div>

  <!-- Activity log -->
  <div class="live-log-title">Activity Log</div>
  <div class="live-log" id="liveLog"></div>

</div>
```

### Control Buttons by State
```
DETECTING / CLICKING_APPLY / SCANNING / AI_THINKING / FILLING:
  [⏸️ Pause]  [⏹️ Stop]

PAUSED:
  [▶️ Resume]  [⏹️ Stop]

STUCK:
  "Bot is stuck: {reason}. Please help then click Resume."
  [▶️ Resume after fixing]  [⏹️ Stop]
  Timer: "Auto-stopping in 9:42..."

REVIEWING (after page filled, before Next):
  "✅ Page {n} filled. Check the browser — fix anything wrong — then confirm."
  [✅ Confirm & Go to Next Page]  [⏸️ Pause]  [⏹️ Stop]

WAITING_SUBMIT:
  "🎯 All pages filled! Please click SUBMIT in the browser."
  "The bot will NOT click Submit — you must click it."
  [⏹️ Close Bot]

DONE:
  "✅ Application submitted successfully!"
  [Close]

ERROR:
  "❌ Error: {message}"
  [🔄 Retry]  [Close]
```

---

## 12. PROFILE SETTINGS PAGE (`/profile-settings`)

A page where user can view and edit profile.json without touching the file.

### Sections to show:
1. **Personal Info** — name, email, phone, address fields
2. **Work Authorization** — visa status, sponsorship, relocation toggles
3. **Employment** — current employer, title, salary expectations
4. **Education** — degree, school, graduation year, GPA
5. **Work History** — list of jobs (add/edit/remove)
6. **Demographics** — gender, ethnicity, veteran, disability (EEO fields)
7. **Common Answers** — cover letter template, why this role, etc.

Each section has Edit / Save buttons. Saves to `POST /api/auto-apply/profile` which writes to `profile.json`.

---

## 13. DATABASE — BOT SESSIONS TABLE

```sql
CREATE TABLE IF NOT EXISTS bot_sessions (
  id               SERIAL PRIMARY KEY,
  session_id       VARCHAR(255) UNIQUE,
  application_id   INTEGER REFERENCES applications(id),
  company_name     VARCHAR(255),
  position         VARCHAR(255),
  jd_url           TEXT,
  ats_type         VARCHAR(50),
  trigger_source   VARCHAR(50),  -- 'extension', 'application_page', 'manual'
  resume_link      TEXT,
  fields_scanned   INTEGER DEFAULT 0,
  fields_filled    INTEGER DEFAULT 0,
  fields_flagged   INTEGER DEFAULT 0,
  flagged_details  JSONB DEFAULT '[]',
  pages_completed  INTEGER DEFAULT 0,
  status           VARCHAR(50) DEFAULT 'pending',
  -- pending, running, paused, stuck, done, error, stopped
  error_message    TEXT,
  started_at       TIMESTAMP DEFAULT NOW(),
  completed_at     TIMESTAMP,
  duration_sec     INTEGER
);
```

---

## 14. CHROME EXTENSION CHANGES

**File to modify:** The extension's result page JS (wherever resume links are shown after optimization)

**Add after resume links appear:**
```javascript
// Add Auto Apply button
const autoApplyBtn = document.createElement('button');
autoApplyBtn.textContent = '🤖 Auto Apply';
autoApplyBtn.style.cssText = 'background:#8b5cf6;color:#fff;border:none;padding:10px 20px;cursor:pointer;font-size:14px;margin-top:12px;width:100%;';
autoApplyBtn.onclick = async () => {
  // Get data from extension context
  const payload = {
    trigger: 'extension',
    jdUrl: currentPageUrl,           // the job post URL user was on
    resumeLink: resumeGoogleDocsUrl, // from optimization result
    jobDescription: jobDescriptionText,
    companyName: companyName,
    position: position
  };

  // Start bot
  const res = await fetch('http://localhost:3000/api/auto-apply/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  // Open live view in new tab
  chrome.tabs.create({ url: 'http://localhost:3000/auto-apply/live' });
};
resultContainer.appendChild(autoApplyBtn);
```

---

## 15. BUILD ORDER — DO IN THIS EXACT SEQUENCE

### Phase 1 — Foundation (do first, verify before moving on)
1. `auto-apply/bot-state.js` — state machine with all states listed in section 5
2. `auto-apply/profile.json` — complete with all fields from section 8
3. `auto-apply/routes.js` — all API endpoints from section 7
4. Wire routes into `server.js` — WebSocket + registerAutoApplyRoutes
5. Test: `GET /api/auto-apply/status` returns `{ state: "idle" }`

### Phase 2 — Browser + Detection
6. `auto-apply/detector.js` — ATS detection from URL patterns
7. `auto-apply/pipeline.js` — launch Playwright, navigate to URL
8. Test: bot opens browser, navigates to a Workday URL

### Phase 3 — Workday Reading
9. `auto-apply/page-scanner.js` — extract all field types
10. `auto-apply/field-ai.js` — GPT-4o answers all fields
11. Test: bot reads a Workday page and logs all fields + answers

### Phase 4 — Workday Filling
12. `auto-apply/field-filler.js` — fill each field type
13. `auto-apply/ats/workday.js` — full Workday multi-page flow
14. Test: bot fills a real Workday application form (don't submit)

### Phase 5 — Frontend
15. `public/auto-apply.js` — WebSocket client + live panel rendering
16. `public/auto-apply.html` — Trigger 3 manual page
17. `public/auto-apply-live.html` — standalone live view for extension
18. Update `public/application.html` — Trigger 2 modal + live panel
19. `public/profile-settings.html` — profile editor

### Phase 6 — Chrome Extension
20. Add Auto Apply button to extension result page

### Phase 7 — Other ATS (after Workday is 100% working)
21. `auto-apply/ats/greenhouse.js`
22. `auto-apply/ats/lever.js`
23. `auto-apply/ats/generic.js`

---

## 16. KEY RULES — NEVER BREAK THESE

1. **NEVER click Submit automatically** — always pause at `WAITING_SUBMIT` state and wait for human
2. **NEVER overwrite pre-filled fields** — check if field already has value before filling
3. **ALWAYS use `data-automation-id`** for Workday selectors — never rely on CSS classes
4. **ALWAYS use Playwright's built-in waits** — never use `setTimeout` for waiting, use `page.waitForSelector()`, `page.waitForLoadState()`
5. **ALWAYS batch AI calls** — one GPT call per page, not one per field
6. **ALWAYS show the browser** — `headless: false` — user must see what bot is doing
7. **ALWAYS emit WebSocket update** after every action — user sees every step live
8. **10 minute timeout on STUCK** — then automatically stop and notify user
9. **Resume after STUCK/PAUSE** — always re-scan the page before continuing — don't assume page is same
10. **One bot instance at a time** — reject new start() if bot is already running

---

## 17. WHAT ALREADY EXISTS (DO NOT REBUILD)

These files already exist in the codebase. Use them, don't replace:

- `server.js` — Express server, WebSocket, `generateAIContent()`, Google Drive/Docs APIs
- `checkpoint.js` — resume optimization checkpoints (separate from bot)
- `company-context.js` — Tavily research
- `recruiter-automation-v2.js` — recruiter finder
- `public/dashboard.html` + `dashboard.js` + `dashboard.css`
- `public/application.html` + `application.js` + `application.css`
- Existing auto-apply files (may need rewriting for Playwright — currently use Puppeteer)

**Switch from Puppeteer to Playwright:**
- Uninstall: `npm uninstall puppeteer`
- Install: `npm install playwright`
- Run: `npx playwright install chromium`
- Replace all `require('puppeteer')` with `require('playwright')`
- Replace `puppeteer.launch()` with `chromium.launch()`
- Replace `page.$()` with `page.$()` (same API for basic selectors)
- Replace `page.waitForSelector()` — Playwright auto-waits, simpler

---

## 18. ENVIRONMENT VARIABLES NEEDED

Add to `.env`:
```
# Already exists:
CHATGPT_API_KEY=sk-...
OPENAI_API_KEY=sk-...

# Already exists:
DATABASE_URL=postgresql://...

# Add if not present:
BOT_TIMEOUT_MINUTES=10
BOT_TYPING_DELAY_MS=30
```

---

## 19. SUCCESS CRITERIA — HOW TO KNOW IT'S WORKING

The system is complete when:

1. ✅ User pastes a Workday job URL on `/auto-apply`
2. ✅ Bot opens visible Chrome browser
3. ✅ Bot finds and clicks "Apply" button on job post
4. ✅ Bot detects it's Workday
5. ✅ Bot reads all fields on Page 1
6. ✅ GPT-4o answers all fields in one call
7. ✅ Bot fills every field correctly (text, dropdown, file upload)
8. ✅ User sees every action in the live panel on the website
9. ✅ Bot pauses after each page — user clicks "Confirm & Continue"
10. ✅ Bot navigates all pages until Submit button
11. ✅ Bot stops at Submit — shows "Please click Submit in the browser"
12. ✅ User clicks Submit in browser — bot detects success page
13. ✅ Session logged to PostgreSQL
14. ✅ Live panel shows "✅ Done"
