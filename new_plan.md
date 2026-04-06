# Job Application Bot — Complete Project Plan

Supervised AI-Powered Job Application Automation System
Owner: Lokesh | Version: 1.0 | Status: Planning Phase | Date: February 2026

---

## Table of Contents

1. Project Overview
2. The Problem and Solution
3. How Web Scraping Works
4. Complete Automation Pipeline
5. System Architecture
6. Technology Stack
7. Project Folder Structure
8. Pause / Resume / Correct System
9. ATS Detection and Form Handling
10. Profile Data (profile.yaml)
11. Database Design
12. API Endpoints
13. Frontend UI Pages and Features
14. Node.js Integration (Your Existing Tool)
15. Google Drive Integration
16. Python Dependencies
17. 10-Day Build Plan
18. Edge Cases and How to Handle Them
19. Open Questions — Decisions Needed
20. Summary

---

## 1. Project Overview

This document is the complete blueprint for building a supervised, AI-powered job application automation system. Every design decision, every file, every API, and every edge case is documented here before a single line of code is written.

### What This System Does

You paste a job posting URL into a browser UI. The system then:

1. Opens a real visible Chrome browser (not hidden)
2. Scrapes the full job description from that URL
3. Sends the JD to your existing Node.js/OpenAI tool which tailors your resume
4. Downloads the optimized resume PDF from Google Drive
5. Finds the Apply button on the job page (wherever it is)
6. Fills the application form field by field, live in front of you
7. Uploads your tailored resume to the form
8. Flags any fields it cannot fill — saves them for your manual review
9. Submits the application and logs it to the database

At any point during steps 5 through 8, you can pause the bot, fix something manually, and resume. The bot continues from exactly where it left off.

### Design Philosophy

Supervised Automation — The bot does the work. You stay in control.

This is NOT a fully automated bot running blindly in the background. It runs in YOUR visible browser. You watch every action. You can intervene at any time. This design was chosen because:

- No two company application forms are identical
- Some fields require human judgment (cover letters, essay questions)
- You want to catch mistakes before they get submitted
- It is safer — you are always in the loop

---

## 2. The Problem and Solution

### The Problem

| Pain Point | Impact |
|---|---|
| Applying manually takes 20-30 min per job | 10 jobs = 5 hours of work |
| Every application needs a tailored resume | Generic resumes fail ATS filters |
| Tracking 100s of applications is hard | Things fall through the cracks |
| Filling the same fields repeatedly | Name, email, phone, every single time |
| Some forms are broken or confusing | Easy to submit wrong data |

### The Solution

```
You paste ONE URL
        |
        v
Bot does everything automatically
        |
        v
You watch, pause if needed, fix, resume
        |
        v
Application submitted in about 2 minutes
        |
        v
Logged to your database automatically
```

### Time Savings

| Task | Manual | With Bot |
|---|---|---|
| Read JD and tailor resume | 15 min | 30 sec (AI does it) |
| Fill application form | 10 min | 60 sec (bot does it) |
| Upload resume | 2 min | 5 sec (auto upload) |
| Log the application | 3 min | 0 sec (auto logged) |
| Total per application | ~30 min | ~2 min |

---

## 3. How Web Scraping Works

Understanding this is critical before building. Here is a detailed breakdown.

### 3.1 What Happens When You Open a Website

When you type a URL in Chrome and hit Enter:

```
1. Chrome sends an HTTP GET request to the server
2. Server responds with raw HTML text
3. Chrome parses the HTML
4. Chrome downloads CSS files and applies styles
5. Chrome downloads JavaScript files and runs them
6. JavaScript renders the actual content (React, Angular, etc.)
7. You see the final page
```

Web scraping is doing steps 1 through 7 programmatically instead of manually.

### 3.2 Two Types of Scraping

#### Type 1 — Static Scraping (Simple HTTP Request)

You send an HTTP GET request and get back raw HTML. Works for old-school websites where content is baked into the HTML from the server.

```
Your Code  →  HTTP GET  →  Server
Your Code  ←  Raw HTML  ←  Server
(parse it directly — the data is already in the HTML)
```

Problem: Most modern job pages (Stripe, Greenhouse, Lever) are React apps. The raw HTML looks like this when you fetch it directly:

```html
<div id="root"></div>   <!-- completely empty — JS has not run yet -->
```

The actual job listings are loaded AFTER JavaScript runs. Static scraping gets you an empty page.

#### Type 2 — Dynamic Scraping (Browser Automation — What We Use)

You launch a real browser, let JavaScript fully execute, then read the rendered page. This is what Playwright does.

```
Your Python Code
        |
        v
Playwright launches Chrome
        |
        v
Chrome opens the URL
        |
        v
JavaScript runs, React renders
        |
        v
Page is fully loaded with all content
        |
        v
Playwright reads the DOM
        |
        v
You extract job title, description, apply link
```

This always works because you are using a real browser — exactly what a human would use.

### 3.3 How Playwright Finds Elements

Every piece of data on a page lives inside an HTML element. You find elements using selectors:

```html
<!-- Example: A Greenhouse job listing -->
<div class="opening">
  <a href="/apply/12345">
    <h2 class="title">Senior Java Engineer</h2>
    <span class="location">Austin, TX</span>
  </a>
</div>
```

| Selector Type | Example | Finds |
|---|---|---|
| CSS class | .title | The h2 with class "title" |
| CSS tag | h2 | All h2 elements |
| CSS attribute | a[href*='apply'] | Links with "apply" in href |
| XPath | //h2[contains(text(),'Engineer')] | h2 containing "Engineer" |
| Aria label | [aria-label='Job Title'] | Accessible label field |

### 3.4 Why Some Sites Are Harder to Scrape

| Challenge | Why It Happens | How We Handle It |
|---|---|---|
| Content loads slowly | JavaScript takes time to render | wait_until="networkidle" — wait for all requests to finish |
| Infinite scroll | More jobs load as you scroll | Simulate scrolling with Playwright |
| Apply button opens popup | Modal overlays the page | Detect and interact with the modal |
| Redirect to new URL | Greenhouse/Lever hosted separately | Follow the redirect, re-detect ATS type |
| CAPTCHA | Bot detection system | Auto-pause for you to solve manually |
| iFrame forms | Form embedded from another domain | Switch Playwright context to the iframe |
| Shadow DOM | Web components hide internals | Use pierce/ selector prefix in Playwright |

---

## 4. Complete Automation Pipeline

Here is every single step, in order, with full detail on what happens at each stage.

```
COMPLETE PIPELINE FLOW

[YOU] Paste JD URL in React UI
         |
         v
[REACT] POST /api/run { jdUrl }
         |
         v
[PYTHON FastAPI] Receives request, starts pipeline thread
         |
         v
[STEP 1] JD Scraper
  Playwright opens Chrome (VISIBLE to you)
  Navigates to the URL
  Waits for JS to fully render
  Tries multiple CSS selectors to find JD text
  Extracts and returns full JD as plain text
         |
         v
[STEP 2] Resume Optimizer Call
  Python sends HTTP POST to Node.js tool
  Payload: { jobDescription: "full jd text..." }
  Node.js calls OpenAI with your resume + JD
  OpenAI tailors resume to match this specific job
  Node.js saves PDF to your Google Drive folder
  Returns: { driveFileId: "abc123" }
         |
         v
[STEP 3] Google Drive Download
  Python calls Google Drive API with driveFileId
  Downloads PDF to /tmp/Lokesh_Optimized_Resume.pdf
         |
         v
[STEP 4] ATS Detection
  Bot checks URL pattern + page source
  Identifies: Greenhouse / Lever / Workday / Ashby / Generic
  Loads the correct form-fill strategy for that ATS
         |
         v
[STEP 5] Apply Button Finder
  Searches for Apply button using multiple selector patterns
  Handles: same page / new tab / popup modal / redirect
  Clicks the button, waits for form to appear
         |
         v
[STEP 6] Form Scanner
  Finds all: input, textarea, select, file, checkbox, radio
  For each field: reads name, placeholder, aria-label, id
  Builds a list of (field_identifier -> field_element) pairs
         |
         v
[STEP 7] Field-by-Field Filling  (YOU WATCH THIS LIVE)
  For each field:
    -> bot_state.wait_if_paused()   PAUSE CHECK BEFORE EVERY FIELD
    -> maps identifier to your profile.yaml
    -> if match found: fills the field
    -> if no match: saves to flagged_fields table
    -> moves to next field
         |
         v
[STEP 8] Resume Upload
  Finds the file input field
  Sends the local PDF path to Playwright
  Playwright handles the file selection automatically
         |
         v
[STEP 9] Pre-Submit Review Pause (ALWAYS AUTOMATIC)
  Bot pauses automatically before submitting
  You review everything in the browser
  You click "Submit" in the UI to confirm
         |
         v
[STEP 10] Submit and Confirm
  Bot clicks the submit button
  Waits for confirmation message
  Records success or failure
         |
         v
[STEP 11] Log to Database
  Saves full application record to PostgreSQL
  Fields: company, title, url, resume_used, status, timestamp
  Flagged fields already saved during Step 7
         |
         v
[YOU] See result in React UI: APPLIED or APPLIED WITH FLAGS
```

---

## 5. System Architecture

### 5.1 Three-Service Design

```
[React Frontend]           HTTP            [Python Bot - FastAPI]
localhost:3000    ---------------------->   localhost:8000
                  <-- WebSocket (status) --

                                                    |
                                                    | HTTP POST
                                                    v

                                           [Node.js Tool]
                                           localhost:3001
                                           YOUR EXISTING TOOL
                                           - Receives JD text
                                           - Calls OpenAI
                                           - Saves to Drive
                                           - Returns fileId

                                                    |
                                                    v

                                           [PostgreSQL Database]
                                           - applications table
                                           - flagged_fields table
                                           - bot_sessions table
```

### 5.2 Communication Between Services

| From | To | Method | What Is Sent |
|---|---|---|---|
| React UI | Python Bot | HTTP POST | { jdUrl: "..." } |
| React UI | Python Bot | HTTP POST | { action: "pause" } |
| React UI | Python Bot | HTTP POST | { action: "resume" } |
| Python Bot | React UI | WebSocket | { step: "...", field: "...", status: "..." } |
| Python Bot | Node.js | HTTP POST | { jobDescription: "..." } |
| Python Bot | Google Drive | Drive API | Download by fileId |
| Python Bot | PostgreSQL | SQL | INSERT application record |

---

## 6. Technology Stack

| Component | Technology | Why This Choice |
|---|---|---|
| Browser Automation | Python + Playwright | Built-in pause/inspector, faster than Selenium, better JS handling, headful mode works perfectly |
| Bot API Server | FastAPI (Python) | Lightweight, async, real-time pause/resume state management, WebSocket built-in |
| Real-time UI Updates | WebSocket | Push bot status to React UI without polling |
| Resume Optimizer | Node.js + OpenAI (existing) | Already built — just needs one new endpoint added |
| Resume Storage | Google Drive API | Already in your workflow — no change needed |
| Frontend UI | React + Tailwind | Fast to build, clean control panel |
| Database | PostgreSQL | Reliable, relational, perfect for applications + flags tracking |
| Profile Storage | YAML file | Human-readable, easy to update without touching code |
| ATS Detection | URL + DOM pattern matching | Greenhouse/Lever/Workday all have distinct, stable URL patterns |

---

## 7. Project Folder Structure

```
job-bot/
|
|-- python-bot/                        <- NEW: Core automation engine
|   |-- main.py                        <- FastAPI server entry point
|   |-- pipeline.py                    <- Orchestrates all 11 steps end-to-end
|   |-- scraper.py                     <- Extracts JD text from any URL
|   |-- ats_detector.py                <- Detects Greenhouse / Lever / Workday / Ashby
|   |-- form_filler.py                 <- Fills every field from profile.yaml
|   |-- drive_downloader.py            <- Downloads resume PDF from Google Drive
|   |-- state.py                       <- Pause / Resume / Stop state manager
|   |-- database.py                    <- PostgreSQL connection + queries
|   |-- profile.yaml                   <- Your personal data (name, email, skills, etc.)
|   |-- credentials.json               <- Google Drive OAuth credentials (gitignored)
|   `-- requirements.txt               <- All Python dependencies
|
|-- resume-optimizer/                  <- YOUR EXISTING Node.js tool
|   `-- index.js                       <- Add ONE new endpoint: POST /optimize-resume
|                                         Everything else stays exactly the same
|
|-- frontend/                          <- NEW: React control panel
|   |-- package.json
|   `-- src/
|       |-- App.jsx                    <- Router + layout
|       |-- pages/
|       |   |-- Apply.jsx              <- Paste URL + live bot watcher + controls
|       |   |-- Applications.jsx       <- Full history of all applications
|       |   |-- Flags.jsx              <- Review + fill flagged fields
|       |   `-- Dashboard.jsx          <- Stats overview
|       `-- components/
|           |-- BotControls.jsx        <- Pause / Resume / Stop buttons
|           |-- StepTracker.jsx        <- Shows current step + field being filled
|           |-- ApplicationCard.jsx    <- Single application row in history
|           `-- FlagCard.jsx           <- Single flagged field for review
|
`-- database/
    `-- schema.sql                     <- All CREATE TABLE statements
```

---

## 8. Pause / Resume / Correct System

This is the most critical feature in the entire system.

### 8.1 The Core Idea

The bot runs on a background thread in Python. Before filling every single field, it checks a shared state variable: "Am I paused?"

- If NOT paused — it fills the field and moves on
- If PAUSED — it blocks and waits exactly at that spot until you press Resume

When you fix a field manually in the browser and hit Resume, the bot skips that field (since you already fixed it) and moves to the next field. It never goes backwards.

### 8.2 Exact Pause/Resume Flow

```
Bot is filling field: "years_of_experience"
Bot types: "50"  <- WRONG!

You see this in the browser and hit PAUSE in the UI
        |
        v
UI sends: POST /api/bot/pause
        |
        v
Python sets: bot_state.paused = True
             bot_state.lock.clear()   <- This BLOCKS the thread
        |
        v
Bot is now FROZEN at the next field check.
The "50" is already typed — browser is live, you can click into the field.
        |
        v
You click into the years_of_experience field in Chrome.
You clear it and type "5".
        |
        v
You click RESUME in the UI
        |
        v
UI sends: POST /api/bot/resume
        |
        v
Python sets: bot_state.paused = False
             bot_state.lock.set()   <- This UNBLOCKS the thread
        |
        v
Bot wakes up. Skips "years_of_experience" (you already fixed it).
Continues with next field: "linkedin_url"
```

### 8.3 What You Can Do While Paused

The Chrome browser is completely live and interactive when the bot is paused. You can:

- Click into any field and type a correct value
- Select a different dropdown option
- Check or uncheck checkboxes
- Upload a different resume version
- Scroll up and down to review other fields
- Copy text from the JD page to paste into an essay field
- Click Resume to continue from the next field
- Click Stop to abort the entire application

### 8.4 Automatic Pre-Submit Pause

The bot always pauses automatically before hitting Submit. This gives you a final review moment:

```
Bot finishes filling all fields
        |
        v
Bot pauses automatically
        |
        v
UI shows: "Review the form before submitting"
          "All fields filled. Flagged: 2 fields"
          [ Review in Browser ]  [ Submit Now ]  [ Abort ]
        |
        v
You scroll through the form in Chrome and confirm everything looks correct.
        |
        v
You click "Submit Now" in the UI.
        |
        v
Bot clicks the submit button.
```

### 8.5 Bot State Machine

| State | What Is Happening | UI Color |
|---|---|---|
| IDLE | Waiting for a URL to be submitted | Grey |
| RUNNING | Bot is actively filling fields | Green |
| PAUSED | Bot is frozen, waiting for you | Yellow |
| STOPPED | You aborted the application | Red |
| COMPLETED | Application submitted successfully | Blue |
| FAILED | An error occurred | Red |

---

## 9. ATS Detection and Form Handling

### 9.1 What is an ATS?

ATS = Applicant Tracking System. Instead of building their own career pages, most companies use a third-party platform. Each ATS has a consistent HTML structure — so once the bot knows which ATS it is dealing with, it knows exactly how to handle the form.

### 9.2 ATS Detection Logic

Stage 1 — URL pattern matching (fast, happens immediately):

```
URL contains "greenhouse.io"           -> GREENHOUSE
URL contains "lever.co"                -> LEVER
URL contains "myworkdayjobs.com"        -> WORKDAY
URL contains "workday.com"             -> WORKDAY
URL contains "ashbyhq.com"             -> ASHBY
URL contains "icims.com"               -> ICIMS
URL contains "smartrecruiters.com"     -> SMARTRECRUITERS
None of the above                      -> check Stage 2
```

Stage 2 — Page source inspection (for companies that embed an ATS):

```
Page source contains "greenhouse-job-board"   -> GREENHOUSE
Page source contains "lever-job-site"         -> LEVER
Page source contains "wd1.myworkdayjobs"      -> WORKDAY
None of the above                             -> GENERIC
```

### 9.3 Supported ATS Platforms

| ATS | URL Pattern | Common Users | Estimated Share |
|---|---|---|---|
| Greenhouse | greenhouse.io, boards.greenhouse.io | Stripe, Coinbase, Airbnb, Reddit, Figma | ~35% of startups |
| Lever | jobs.lever.co | Netflix, Shopify, Dropbox, GitHub | ~25% of startups |
| Workday | myworkdayjobs.com | Most large enterprises, banks | ~20% of enterprises |
| Ashby | ashbyhq.com | Modern tech startups | ~10% growing fast |
| iCIMS | icims.com | Mid-size companies | ~5% |
| SmartRecruiters | smartrecruiters.com | Mixed | ~3% |
| Generic | Any other URL | Custom career pages | Fallback logic handles it |

### 9.4 Complete Field Mapping

The bot reads each field's HTML attributes (name, placeholder, aria-label, id) and maps them to your profile.yaml:

```
Field Identifier                    ->  Your Value from profile.yaml
first_name / firstName              ->  "Lokesh"
last_name / lastName                ->  "YourLastName"
email / email_address               ->  "lokesh@email.com"
phone / mobile / tel                ->  "555-555-5555"
linkedin / linkedin_url             ->  "linkedin.com/in/lokesh"
github / github_url                 ->  "github.com/lokesh"
city / location                     ->  "Austin"
state                               ->  "TX"
country                             ->  "United States"
zip / postal_code                   ->  "78701"
university / school                 ->  "Southern Arkansas University"
degree / education                  ->  "Master of Science in Computer Science"
gpa                                 ->  "3.9"
years_experience / experience       ->  "5"
current_title / role                ->  "Java Full Stack Developer"
current_company                     ->  "LPL Financial"
salary / compensation               ->  "130000"
notice_period / available           ->  "2 weeks"
sponsorship / visa                  ->  "Yes, I will require sponsorship"
authorized / work_auth              ->  "Yes"
resume / cv / upload                ->  Uploads Lokesh_Optimized_Resume.pdf
cover_letter / essay                ->  FLAGGED — you fill manually
why_us / why_company                ->  FLAGGED — you fill manually
anything unrecognized               ->  FLAGGED — you fill manually
```

### 9.5 Handling Different Field Types

| Field Type | HTML Element | How Bot Handles It |
|---|---|---|
| Text input | input type="text" | element.fill("value") |
| Email input | input type="email" | element.fill("email@...") |
| Phone input | input type="tel" | element.fill("555-...") |
| Dropdown | select | element.select_option("value") |
| Checkbox | input type="checkbox" | element.check() or element.uncheck() |
| Radio button | input type="radio" | element.check() |
| File upload | input type="file" | element.set_input_files("/tmp/resume.pdf") |
| Textarea | textarea | element.fill("text...") |
| Rich text editor | div[contenteditable] | element.fill("text...") or flag it |
| Hidden input | input type="hidden" | Skip entirely |
| CAPTCHA | Various | Auto-pause for you to solve manually |

---

## 10. Profile Data (profile.yaml)

This YAML file is the single source of truth for all your personal information. The bot reads this to fill every field. You edit this file once and it applies to every application.

```yaml
# PERSONAL INFORMATION
personal:
  firstName: "Lokesh"
  lastName: "YourLastName"
  email: "lokesh@email.com"
  phone: "555-555-5555"
  linkedin: "https://linkedin.com/in/lokesh"
  github: "https://github.com/lokesh"
  portfolio: "https://lokesh.dev"
  location: "Austin, TX"
  city: "Austin"
  state: "TX"
  country: "United States"
  zipCode: "78701"

# WORK INFORMATION
work:
  currentTitle: "Java Full Stack Developer"
  currentCompany: "LPL Financial"
  experienceYears: "5"
  noticePeriod: "2 weeks"
  salaryExpectation: "130000"
  salaryRange: "120000-150000"
  remotePreference: "Remote or Hybrid"

# EDUCATION
education:
  degree: "Master of Science in Computer Science"
  university: "Southern Arkansas University"
  gpa: "3.9"
  graduationYear: "2021"
  undergrad: "Bachelor of Technology"
  undergradUniversity: "Your Undergrad University"

# VISA AND WORK AUTHORIZATION
visa:
  authorized: "Yes"
  sponsorship: "Yes, I will require sponsorship"
  visaType: "F-1 OPT"
  citizenshipStatus: "Student Visa"

# RESUME PATHS
resume:
  localPath: "/tmp/Lokesh_Optimized_Resume.pdf"
  driveFolderId: "YOUR_GOOGLE_DRIVE_FOLDER_ID"

# SKILLS
skills:
  primary:
    - "Java"
    - "Spring Boot"
    - "React"
    - "TypeScript"
    - "Node.js"
  secondary:
    - "Kafka"
    - "PostgreSQL"
    - "AWS"
    - "Docker"
    - "Kubernetes"
    - "Microservices"
    - "REST APIs"

# PRE-WRITTEN ANSWER TEMPLATES
# Used when the bot finds a common open-ended question it can auto-fill
answers:
  whyThisRole: >
    I am excited about this role because it aligns perfectly with my 5 years
    of experience building high-performance Java microservices and React frontends
    in fintech and healthcare domains. I am particularly drawn to the technical
    challenges around scalability and distributed systems.

  strengthSummary: >
    My strongest areas are Java Spring Boot backend development, React/TypeScript
    frontends, and designing distributed systems with Kafka. I have a track record
    of delivering high-quality systems at LPL Financial managing over $1 trillion
    in assets.

  availability: "2 weeks"
```

---

## 11. Database Design

Three tables handle everything needed to track applications and manage flagged fields.

### applications table

```sql
CREATE TABLE applications (
    id              BIGSERIAL PRIMARY KEY,
    company         VARCHAR(255) NOT NULL,
    job_title       VARCHAR(255),
    jd_url          VARCHAR(1000) NOT NULL,
    apply_url       VARCHAR(1000),
    ats_type        VARCHAR(50),
    resume_path     VARCHAR(500),
    drive_file_id   VARCHAR(255),
    status          VARCHAR(50) NOT NULL,
    flagged_count   INT DEFAULT 0,
    error_message   TEXT,
    applied_at      TIMESTAMP DEFAULT NOW(),
    created_at      TIMESTAMP DEFAULT NOW()
);

-- status values: APPLIED / FAILED / STOPPED / APPLIED_WITH_FLAGS
-- ats_type values: GREENHOUSE / LEVER / WORKDAY / ASHBY / ICIMS / GENERIC
```

### flagged_fields table

```sql
CREATE TABLE flagged_fields (
    id                  BIGSERIAL PRIMARY KEY,
    application_id      BIGINT REFERENCES applications(id) ON DELETE CASCADE,
    field_identifier    VARCHAR(255),
    field_type          VARCHAR(50),
    field_label         TEXT,
    page_url            VARCHAR(1000),
    your_answer         TEXT,
    status              VARCHAR(50) DEFAULT 'PENDING',
    created_at          TIMESTAMP DEFAULT NOW(),
    resolved_at         TIMESTAMP
);

-- field_type values: text / textarea / select / checkbox / radio
-- status values: PENDING / RESOLVED / SKIPPED
```

### bot_sessions table

```sql
CREATE TABLE bot_sessions (
    id              BIGSERIAL PRIMARY KEY,
    application_id  BIGINT REFERENCES applications(id),
    started_at      TIMESTAMP DEFAULT NOW(),
    ended_at        TIMESTAMP,
    total_fields    INT,
    filled_fields   INT,
    flagged_fields  INT,
    pause_count     INT DEFAULT 0,
    duration_sec    INT,
    log_text        TEXT
);
```

---

## 12. API Endpoints

### Python Bot — FastAPI Server (localhost:8000)

| Method | Endpoint | Description | Payload |
|---|---|---|---|
| POST | /api/run | Start the full pipeline for a JD URL | { jdUrl: "https://..." } |
| POST | /api/pause | Pause the bot at the next field | none |
| POST | /api/resume | Resume from the next field | none |
| POST | /api/stop | Abort the current application | none |
| POST | /api/submit | Confirm and click the Submit button | none |
| GET | /api/status | Get current bot state and current step | none |
| GET | /api/applications | List all past applications | none |
| GET | /api/applications/{id} | Single application with all details | none |
| GET | /api/flags | All unresolved flagged fields | none |
| PUT | /api/flags/{id} | Submit your answer for a flagged field | { answer: "..." } |
| WS | /ws/status | WebSocket: real-time bot status stream | none |

### Node.js Resume Optimizer (localhost:3001)

| Method | Endpoint | Description | Payload | Response |
|---|---|---|---|---|
| POST | /optimize-resume | NEW — receives JD text, returns Drive file ID | { jobDescription: "..." } | { driveFileId: "..." } |

---

## 13. Frontend UI Pages and Features

### Page 1: Apply Page (Main Page)

This is what you see every time you apply to a job:

```
Job Application Bot
---------------------------------------------------------------------
Paste Job Posting URL:
[ https://stripe.com/jobs/listing/5678901                          ]
                                              [ Start Application ]

---------------------------------------------------------------------
STATUS: RUNNING

Current Step:    Filling form fields
Current Field:   years_of_experience
Progress:        Field 6 of 14
ATS Detected:    Greenhouse
Resume:          Lokesh_Stripe_SeniorJava_Resume.pdf

[ PAUSE ]     [ RESUME ]     [ STOP ]     [ SUBMIT ]

Step Log:
OK    JD scraped (2,340 chars)
OK    Resume optimized via OpenAI
OK    Resume downloaded from Drive
OK    ATS detected: Greenhouse
OK    Apply button clicked
...   Filling: years_of_experience -> "5"
FLAG  Flagged: cover_letter (unknown field)
```

### Page 2: Applications History

```
Applications History                                  Total: 47
---------------------------------------------------------------------
Company       | Role              | ATS        | Status  | Date
--------------+-------------------+------------+---------+--------
Stripe        | Sr Java Eng       | Lever      | APPLIED | 2/27
Plaid         | Full Stack Dev    | Greenhouse | FLAGS   | 2/26
Axos          | Java Developer    | Workday    | APPLIED | 2/25
Coinbase      | Backend Eng       | Greenhouse | FAILED  | 2/24
```

### Page 3: Flags Review

```
Flagged Fields — Needs Your Input                   Pending: 3
---------------------------------------------------------------------
Application: Plaid — Full Stack Developer
Field:       "Why do you want to work at Plaid?"
Type:        textarea

Your Answer:
[ I am passionate about financial inclusion and...               ]

                                          [ Save and Mark Resolved ]
```

### Page 4: Dashboard

```
Dashboard
---------------------------------------------------------------------
47 Total Applied  |  3 Flags Pending  |  ~2 min Avg Time  |  6 ATS Types

Applications by ATS Platform:
Greenhouse   52%  ████████████████
Lever        28%  █████████
Workday      12%  ████
Other         8%  ██
```

---

## 14. Node.js Integration (Your Existing Tool)

### The Only Change Required

Your existing Node.js resume optimizer needs ONE new HTTP endpoint added to it. Nothing else changes. The endpoint receives the scraped JD text from Python, runs your existing OpenAI logic, saves to Drive (which you already do), and returns the Drive file ID.

```javascript
// ADD THIS to your existing index.js / server.js
// Everything else in your file stays exactly the same

app.post('/optimize-resume', async (req, res) => {
  const { jobDescription } = req.body;

  if (!jobDescription) {
    return res.status(400).json({ error: 'jobDescription is required' });
  }

  try {
    // Use your existing function that calls OpenAI
    const optimizedResume = await yourExistingOptimizeFunction(jobDescription);

    // Use your existing function that saves to Google Drive
    const driveFileId = await yourExistingDriveSaveFunction(optimizedResume);

    // Return the file ID so Python can download it
    return res.json({
      success: true,
      driveFileId: driveFileId,
      fileName: `Lokesh_Resume_${Date.now()}.pdf`
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
```

### How Python Calls This Endpoint

```python
import requests

def call_resume_optimizer(job_description: str) -> str:
    """
    Sends the scraped JD text to the Node.js tool.
    Returns the Google Drive file ID of the optimized resume.
    """
    response = requests.post(
        "http://localhost:3001/optimize-resume",
        json={"jobDescription": job_description},
        timeout=120  # Give OpenAI up to 2 minutes to respond
    )

    if response.status_code != 200:
        raise Exception(f"Resume optimizer failed: {response.text}")

    data = response.json()
    return data["driveFileId"]
```

---

## 15. Google Drive Integration

### How the Full Flow Works

```
Node.js (your existing tool) saves optimized PDF to Drive folder
        |
        v
Node.js returns { driveFileId: "abc123" } to Python
        |
        v
Python calls Drive API: download file by ID
        |
        v
PDF saved to /tmp/Lokesh_Optimized_Resume.pdf on your machine
        |
        v
Playwright uploads this local file to the application form
```

### One-Time Setup

1. Go to Google Cloud Console (console.cloud.google.com)
2. Create a project or use an existing one
3. Enable the Google Drive API
4. Create OAuth2 credentials (Desktop app type)
5. Download credentials.json and put it in python-bot/ folder
6. Run the authentication script once — creates token.json automatically
7. Add your Drive folder ID to profile.yaml

### Python Download Function

```python
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

def download_resume_from_drive(file_id: str, output_path: str) -> str:
    """
    Downloads the optimized resume PDF from Google Drive.
    Returns the local file path.
    """
    creds = Credentials.from_authorized_user_file('token.json')
    service = build('drive', 'v3', credentials=creds)

    file_meta = service.files().get(
        fileId=file_id,
        fields='mimeType,name'
    ).execute()

    mime = file_meta.get('mimeType', '')

    if 'google-apps.document' in mime:
        # Export Google Doc as PDF
        request = service.files().export_media(
            fileId=file_id,
            mimeType='application/pdf'
        )
    else:
        # Direct PDF download
        request = service.files().get_media(fileId=file_id)

    with open(output_path, 'wb') as f:
        downloader = MediaIoBaseDownload(f, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()

    print(f"Resume downloaded to: {output_path}")
    return output_path
```

---

## 16. Python Dependencies

```
# requirements.txt

# Browser automation — the core of the bot
playwright==1.42.0

# API server that the React UI talks to
fastapi==0.110.0
uvicorn==0.29.0
websockets==12.0

# HTTP calls to the Node.js optimizer
requests==2.31.0
httpx==0.27.0

# YAML config file parsing
pyyaml==6.0.1

# Google Drive API
google-api-python-client==2.120.0
google-auth-httplib2==0.2.0
google-auth-oauthlib==1.2.0

# PostgreSQL database
psycopg2-binary==2.9.9
sqlalchemy==2.0.29

# Utilities
python-dotenv==1.0.1
```

### Installation Commands

```bash
# Install all Python dependencies
pip install -r requirements.txt

# Install Playwright and download the Chromium browser binary
playwright install chromium

# Verify Playwright is working
python -c "from playwright.sync_api import sync_playwright; print('Playwright OK')"

# Start the FastAPI bot server
uvicorn main:app --reload --port 8000
```

---

## 17. 10-Day Build Plan

---

### Phase 1 — Foundation (Day 1-2)

---

#### Day 1: Add the Node.js API Endpoint

Goal: Your existing Node.js tool can receive a JD via HTTP POST and return a Drive file ID.

What to do:
- Open your existing index.js
- Add the POST /optimize-resume endpoint shown in Section 14
- Make sure your Express server is listening on port 3001
- Start the server

How to test:
```bash
curl -X POST http://localhost:3001/optimize-resume \
  -H "Content-Type: application/json" \
  -d '{"jobDescription": "We are looking for a Java engineer with Spring Boot experience..."}'
```

Success looks like: You get back { "success": true, "driveFileId": "abc123..." } in the terminal.

Nothing else in your Node.js tool changes.

---

#### Day 2: Python Project Setup

Goal: Python project runs, Playwright opens a visible Chrome window on command.

What to do:
- Create the python-bot/ folder
- Install all dependencies from requirements.txt
- Run `playwright install chromium`
- Create profile.yaml with your real personal data
- Write state.py — the pause/resume state manager
- Write main.py — FastAPI server with /pause, /resume, /stop, /status endpoints

How to test:
```python
# Quick test — run this directly
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)  # headless=False = VISIBLE
    page = browser.new_page()
    page.goto("https://google.com")
    input("Press Enter to close...")
    browser.close()
```

Success looks like: A real Chrome window opens and navigates to Google.

---

### Phase 2 — Core Bot (Day 3-5)

---

#### Day 3: JD Scraper

Goal: Given any job posting URL, extract the full job description text.

What to do:
- Write scraper.py
- Implement multi-selector fallback: try .job-description, then .description, then [data-automation='jobDescription'], then article, then main, then full body text as last resort
- Use wait_until="networkidle" — waits until the page stops making network requests, meaning JS has finished rendering
- Add a 2-second extra wait after networkidle for slow React pages

How to test. Test on these 5 URLs and confirm you get at least 200 words of real JD text from each:
- A Greenhouse job (any Stripe job posting)
- A Lever job (any job on jobs.lever.co)
- A Workday job (any large bank career page)
- A company with a custom career page
- A company that redirects to an ATS

Success looks like: You print the extracted JD text for each URL and it contains real job requirements, not HTML tags or navigation text.

---

#### Day 4: Resume Pipeline

Goal: Scraped JD text flows all the way through to an optimized resume PDF sitting on your local disk.

What to do:
- Write the HTTP call from Python to your Node.js optimizer (Section 14)
- Set up Google OAuth one time (Section 15 setup steps)
- Write drive_downloader.py (Section 15 download function)
- Connect them: JD text in -> call Node.js -> get file ID -> download from Drive -> PDF on disk

How to test:
```python
jd_text = "We are looking for a Senior Java Engineer with Spring Boot..."
file_id = call_resume_optimizer(jd_text)
local_path = download_resume_from_drive(file_id, "/tmp/test_resume.pdf")
print(f"Resume is at: {local_path}")
```

Success looks like: /tmp/test_resume.pdf exists on your machine after running the script.

---

#### Day 5: ATS Detector and Apply Button

Goal: Bot identifies which ATS a page uses and clicks the Apply button on any company's page.

What to do:
- Write ats_detector.py with URL + source pattern matching (Section 9.2)
- Write click_apply_button() with multiple selector fallbacks:
  - a[href*='apply']
  - button[class*='apply']
  - XPath: //a[contains(translate(text(),'APPLY','apply'),'apply')] (case-insensitive)
  - XPath: //button[contains(text(),'Apply')]
- Handle new tab case: if Apply opens a new tab, switch Playwright context to the new tab

How to test: Test on one Greenhouse page, one Lever page, one Workday page. The bot should:
1. Print the detected ATS type
2. Click the Apply button
3. Wait for the application form to appear

Success looks like: On each test page, the bot correctly identifies the ATS and the application form appears after clicking Apply.

---

### Phase 3 — Form Filler (Day 6-7)

---

#### Day 6: Text Field Filling and Pause/Resume

Goal: Bot scans all text form inputs and fills them from profile.yaml. Pause/Resume works correctly.

What to do:
- Write form_filler.py
- Implement get_field_identifier(element) — tries name, then placeholder, then aria-label, then id, then nearby label text
- Implement map_to_profile(identifier) — the full field mapping table from Section 9.4
- Add bot_state.wait_if_paused() call BEFORE filling each field
- Test text fields only first — no dropdowns, file upload, or checkboxes yet
- Test pause: run the bot on a form, press Pause via the API, verify it freezes

How to test: Use a real Greenhouse application form. Run the bot and watch it fill name, email, phone, LinkedIn, etc. Then press Pause mid-way, fix a field manually, press Resume, and confirm it continues.

Success looks like: All text fields fill correctly from profile.yaml. Pause works — bot freezes and resumes correctly.

---

#### Day 7: Dropdowns, Checkboxes, File Upload, and Flagging

Goal: Handle all remaining field types. Unknown fields get flagged to the database.

What to do:
- Add dropdown handling: element.select_option("text=value") — fuzzy match if exact value not found
- Add checkbox handling: element.check() for Yes/agree questions
- Add radio button handling: find the right radio option and click it
- Add file upload: element.set_input_files("/tmp/Lokesh_Optimized_Resume.pdf")
- Set up PostgreSQL with schema.sql — run the CREATE TABLE statements
- Write database.py with save_flag() and save_application() functions
- Implement flagging: any field where map_to_profile() returns None gets saved to flagged_fields table

How to test: Run a complete Greenhouse application from start to finish without submitting. The cover letter field should appear as a flagged entry in your database.

Success looks like: Bot fills all standard fields, uploads the resume, and you see the cover letter flagged in PostgreSQL.

---

### Phase 4 — Integration (Day 8-9)

---

#### Day 8: Full Pipeline and Pre-Submit Pause

Goal: All 11 steps connected end-to-end. Bot always pauses before submitting.

What to do:
- Write pipeline.py that calls each step in order
- Add the automatic pre-submit pause: after all fields are filled, bot pauses and waits for your /api/submit call
- Add /api/submit endpoint to FastAPI
- Connect WebSocket: bot sends status updates after every step and every field fill
- Test the complete flow without submitting — stop at the pre-submit pause stage

How to test: Run the full pipeline on a real job posting URL. Watch it go through all 11 steps. Verify it pauses before submitting.

Success looks like: You paste a URL, watch the bot scrape the JD, see the resume download, watch the form fill field by field in Chrome, and see it freeze before the submit button.

---

#### Day 9: React Frontend

Goal: You control the bot entirely from a browser UI instead of using raw API calls.

What to do:
- Create React app: npx create-react-app frontend
- Install Tailwind CSS
- Build Apply.jsx: URL input + Start button + status display + step log + all control buttons
- Connect to FastAPI via fetch() for button actions
- Connect to WebSocket at ws://localhost:8000/ws/status for real-time step updates
- Build Applications.jsx: table of all past applications from GET /api/applications
- Build Flags.jsx: list of pending flags with text input and Save button for each
- Build Dashboard.jsx: stats cards and applications by ATS breakdown

Success looks like: You open localhost:3000, paste a job URL, click Start, and watch the bot status update live in the browser.

---

### Phase 5 — Testing and Polish (Day 10)

---

#### Day 10: Live End-to-End Testing

Goal: Submit 2-3 real job applications through the full system. Fix anything that breaks.

What to do:
- Pick 3 real job postings you actually want to apply to
- Run the full pipeline on each one, watching carefully
- For the first one: stop before submitting, review everything, then manually submit
- For the second one: use the bot's Submit button to actually submit
- Fix any field mapping issues found (e.g. wrong value for a dropdown option)
- Add error recovery: if any step fails, log the error clearly and show it in the UI
- Verify flagged fields appear in the Flags page correctly
- Make sure applications appear in the history page after submission

Success looks like: Three real applications submitted, all three logged in PostgreSQL, all flagged fields visible in the Flags UI, no crashes.

---

## 18. Edge Cases and How to Handle Them

| Edge Case | Why It Happens | How Bot Handles It |
|---|---|---|
| Apply button opens a new tab | Some companies open their ATS in a new browser tab | context.wait_for_event("page") — Playwright catches the new tab automatically |
| Apply button opens a modal popup | Form is inside a floating overlay on the same page | Detect that the page URL did not change, interact with the overlay normally |
| Page redirects to a completely different URL | Company career page redirects to Greenhouse or Lever | Follow the redirect, re-run ATS detection on the new URL |
| CAPTCHA appears during application | Bot detection system on the site | Auto-pause + show message "Please solve the CAPTCHA in the browser, then press Resume" |
| File upload field is hidden | Some sites hide the native file input and show a custom styled button | Use JavaScript to find the hidden input[type="file"] and set files directly |
| Dropdown options do not match profile values | Profile has "5" but dropdown options are "0-2", "3-5", "5-10" | Fuzzy match — find the option whose text best contains your value |
| iFrame contains the application form | Form is embedded from another domain using an iframe | page.frame_locator("iframe#apply-frame").locator("input") |
| Form has multiple pages (wizard style) | After filling page 1 there is a Next button to page 2 and 3 | Detect "Next" or "Continue" button after each page fill, click it, continue filling |
| Required field gets flagged | A required field is unknown to the bot so it flags it instead of filling | Mark the flag as REQUIRED in the database, do not allow submission until it is resolved |
| Network timeout during JD scraping | Slow company server or unusually large page | Retry up to 3 times with a 5-second delay between attempts |
| OpenAI API call fails | OpenAI is down or rate limit hit | Fallback: use your most recently downloaded general resume from /tmp/ |
| Google Drive download fails | Drive API auth expired or file not found | Auto-pause and show "Resume download failed — check your Drive connection and re-run" |
| Duplicate application detected | You already applied to this exact URL before | Check the database for the same jd_url before starting — show a warning and ask you to confirm |
| Form field only accepts numbers | e.g. "Years of experience" only accepts digits, not "5 years" | Store all numeric profile values as plain numbers without units |

---

## 19. Open Questions — Decisions Needed

These questions were raised but not yet answered. The answers will affect specific implementation details.

---

### Q1: What does your existing Node.js tool do step by step?

Why it matters: The plan assumes you can add a single POST /optimize-resume endpoint without restructuring anything. If the tool only runs as a CLI script and not a server, more setup is needed before it can receive HTTP calls from Python.

What to share: Walk through exactly what happens when you use the tool today. Do you run a command? Open a webpage? Paste text somewhere?

---

### Q2: Does your Node.js tool already connect to Google Drive?

Why it matters:
- If Drive is already connected in Node.js — Python just downloads using the file ID that Node.js returns. No extra work.
- If Drive is NOT connected yet — You need to add Google Drive API to Node.js first, which is a bigger task than adding a single endpoint.

---

### Q3: One application at a time, or a queue of multiple URLs?

| Mode | How It Works | Complexity |
|---|---|---|
| One at a time (recommended to start) | Paste one URL, run, watch, submit, done | Simple — build this first |
| Queue mode | Paste 5 URLs, bot processes them one by one | Needs a job queue system, harder to supervise |

Recommendation: Build one-at-a-time first. Add queue mode in a later phase.

---

### Q4: Do you have multiple resume versions or one master resume?

Why it matters: If you have multiple versions (Backend-focused, Full Stack, Frontend), the bot needs logic to pick the right base resume before sending to OpenAI. A backend Java role should start from your backend resume, not your frontend one.

- If one master resume: No additional logic needed. OpenAI always starts from the same base.
- If multiple versions: Add a resumeVersions section to profile.yaml and add keyword-based selection logic.

---

### Q5: Where to track applications?

| Option | Pros | Cons |
|---|---|---|
| PostgreSQL (recommended) | Full-featured, fast queries, powers the React UI | Needs local DB server running |
| Google Sheets | Visual, shareable, no DB setup, accessible anywhere | Slower, limited querying, no concurrent writes |
| CSV file | Zero setup, always works | Hard to query, breaks with concurrent writes |
| Notion | Beautiful UI, shareable | Complex API, overkill for this use case |

Recommendation: Use PostgreSQL. It powers the Applications and Flags pages in the React UI and lets you query your history easily. Setup takes about 5 minutes.

---

## 20. Summary

### What You Are Building

A supervised automation bot that:

- Runs in your visible Chrome browser using Playwright
- Lets you watch every field being filled in real time
- Gives you full Pause / Resume / Correct control at any time
- Tailors your resume per job using your existing Node.js + OpenAI tool
- Downloads the optimized resume from Google Drive and uploads it automatically
- Flags unknown fields so you fill them manually — never guesses on important fields
- Logs every application to PostgreSQL with full details
- Takes approximately 2 minutes per application versus 30 minutes manually

### Key Numbers

| Metric | Value |
|---|---|
| Time per application | ~2 minutes (vs ~30 minutes manual) |
| Time saved per 100 applications | ~46 hours |
| Total build time | 10 days |
| New services to build | 2 (Python bot + React UI) |
| Change to your existing Node.js tool | 1 new API endpoint only |
| Total new files to create | ~15 files |
| ATS platforms supported | 6 (Greenhouse, Lever, Workday, Ashby, iCIMS, Generic) |
| Pipeline steps from URL to submission | 11 steps |

### The First Thing to Build

Answer the 5 open questions in Section 19.

Then immediately: add the POST /optimize-resume endpoint to your existing Node.js tool. That single endpoint is the foundation everything else in the pipeline connects to. Once it is tested and working, every other step can be built and tested independently.

---

Job Application Bot — Complete Project Plan v1.0 | February 2026