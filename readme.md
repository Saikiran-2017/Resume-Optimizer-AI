# Job Aggregator AI

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-12+-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Playwright](https://img.shields.io/badge/Playwright-1.58-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension_MV3-4285F4?logo=google-chrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Google Gemini](https://img.shields.io/badge/Gemini-2.0_Flash-8E75B2?logo=google&logoColor=white)](https://ai.google.dev/)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4-412991?logo=openai&logoColor=white)](https://openai.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**An AI-powered job application platform that optimizes resumes, auto-applies to jobs via an intelligent Playwright bot, tracks applications in PostgreSQL, and automates recruiter outreach — all from a Chrome extension and web dashboard.**

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [System Architecture Diagram](#system-architecture-diagram)
- [Resume Optimization Flow](#resume-optimization-flow)
- [Auto-Apply Bot Flow](#auto-apply-bot-flow)
- [Tech Stack](#tech-stack)
- [Features](#features)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Install Dependencies](#2-install-dependencies)
  - [3. Set Up PostgreSQL](#3-set-up-postgresql)
  - [4. Configure Environment Variables](#4-configure-environment-variables)
  - [5. Set Up Google Cloud APIs](#5-set-up-google-cloud-apis)
  - [6. Generate OAuth Refresh Tokens](#6-generate-oauth-refresh-tokens)
  - [7. Start the Servers](#7-start-the-servers)
  - [8. Load the Chrome Extension](#8-load-the-chrome-extension)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)
- [Environment Variables Reference](#environment-variables-reference)
- [Contributing](#contributing)
- [License](#license)

---

## Architecture Overview

The system is composed of four main layers:

| Layer | Components | Purpose |
|-------|-----------|---------|
| **Client** | Chrome Extension (MV3), Web Dashboard | User interface for optimization, analysis, tracking, and bot control |
| **Backend** | Express 5 server (port 3000), Analysis server (port 3001) | REST APIs, WebSocket, static file serving, OAuth flows |
| **Auto-Apply Bot** | Playwright Chromium, AI Agent, ATS handlers | Automated job application with ATS-specific form filling |
| **Data & Services** | PostgreSQL, Google APIs, AI providers, external APIs | Persistence, document management, AI processing, recruiter discovery |

### Key Architectural Decisions

- **Monolithic Express server** — single `server.js` handles all API routes, simplifying deployment
- **WebSocket for real-time updates** — the auto-apply bot streams state changes to the dashboard via `/ws/auto-apply`
- **ATS-specific handlers** — dedicated modules for Workday, Greenhouse, and a generic fallback with AI-driven form analysis
- **Dual OAuth clients** — separate Google and Gmail OAuth flows allow using different accounts for docs vs. email
- **Checkpoint system** — long-running optimizations are checkpointed to PostgreSQL and can be resumed after interruption

---

## System Architecture Diagram

<p align="center">
  <img src="docs/architecture-diagram.svg" alt="System Architecture Diagram" width="100%"/>
</p>

---

## Resume Optimization Flow

<p align="center">
  <img src="docs/resume-optimization-flow.svg" alt="Resume Optimization Flow" width="100%"/>
</p>

**Steps:**

1. **User Input** — Job URL or manual JD text + AI provider keys via Chrome Extension or web UI
2. **JD Extraction** — Playwright fetches the URL; AI parses the job description into structured data
3. **Company Context** — Tavily API + Jina Reader fetch company tech stack and culture information
4. **AI Optimization** — Gemini 2.0 Flash or GPT-4 rewrites the resume targeting 85-92% ATS score with 8-20 improvements
5. **Google Docs** — Creates a new formatted Google Doc with skills table and professional styling
6. **Google Drive** — Uploads to a designated folder with naming convention `Name_Position_Company`
7. **PostgreSQL** — Records the application with company, position, resume link, and JD text
8. **Tracking Sheet** — Appends a row to a Google Sheets tracking spreadsheet
9. **Response** — Returns the resume link and metadata to the extension/dashboard

---

## Auto-Apply Bot Flow

<p align="center">
  <img src="docs/auto-apply-flow.svg" alt="Auto-Apply Bot Flow" width="100%"/>
</p>

**Steps:**

1. **Trigger** — User clicks "Start Bot" on the dashboard, providing a job URL and profile config
2. **Pipeline** — `pipeline.js` launches a Playwright Chromium browser and loads the user profile
3. **ATS Detection** — `detector.js` identifies the applicant tracking system (Workday, Greenhouse, or generic)
4. **Navigation** — Finds and clicks the "Apply" button to reach the application form
5. **Page Scanning** — `page-scanner.js` discovers all form fields, labels, and input types
6. **Field Mapping** — `field-ai.js` uses AI to map `profile.json` data to the detected fields
7. **Field Filling** — `field-filler.js` types text, selects options, uploads files, and checks boxes
8. **AI Agent Loop** — `ai-agent.js` + `agent-executor.js` run an agentic read-plan-execute-verify loop for complex pages
9. **State Broadcasting** — `bot-state.js` emits state transitions over WebSocket to the live dashboard
10. **Persistence** — Session data is saved to the `bot_sessions` PostgreSQL table

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| **Runtime** | Node.js 18+ |
| **Web Framework** | Express 5 |
| **Database** | PostgreSQL 12+ |
| **Browser Automation** | Playwright (Chromium) |
| **Real-time** | WebSocket (`ws` library) |
| **AI Providers** | Google Gemini 2.0 Flash, OpenAI GPT-4 / GPT-4.1-mini |
| **Google APIs** | Docs, Drive, Sheets, Gmail (OAuth 2.0) |
| **External APIs** | SerpAPI (LinkedIn search), Hunter.io (email discovery), Tavily (company research), Jina Reader (web content) |
| **Chrome Extension** | Manifest V3, Service Worker |
| **Frontend** | Vanilla HTML5/CSS3/JS, Chart.js |
| **Package Manager** | npm |

---

## Features

### Resume Optimization
- Dual-mode input: URL auto-fetch (Playwright) or manual JD paste
- Multi-AI provider support (Gemini / ChatGPT) with key rotation
- ATS-optimized rewriting with 8-20 strategic improvements per resume
- Automatic Google Docs creation with professional formatting
- Google Drive upload and Google Sheets tracking
- Checkpointed sessions for long-running optimizations

### 4-Score Analysis
- Resume-JD Match Score
- Experience-Role Fit Score
- Post-Optimization Potential Score
- Selection Probability Score

### Auto-Apply Bot
- Playwright-powered browser automation (non-headless)
- ATS detection and routing (Workday, Greenhouse, Generic/Lever)
- AI-driven form field discovery and filling
- Agentic loop for complex multi-step forms
- Real-time state machine with WebSocket live updates
- Resume PDF download from Google Docs

### Application Tracking (CRM)
- Full CRUD for applications, notes, and contacts
- Dashboard with KPIs, daily charts, and status distribution
- Full-text search with PostgreSQL tsvector
- CSV export

### Recruiter Automation
- SerpAPI LinkedIn search for company recruiters
- AI-powered top-3 recruiter selection
- Hunter.io email discovery
- Personalized email generation
- Gmail draft creation

### Chrome Extension
- Manifest V3 with background service worker
- Analyze vs. Optimize mode selection
- Per-extension AI key storage
- Opens as a standalone window for persistent interaction

---

## Project Structure

```
job-aggregator-ai/
├── backend/
│   ├── auto-apply/                  # Auto-apply bot modules
│   │   ├── routes.js                # /api/auto-apply/* REST endpoints
│   │   ├── pipeline.js              # Orchestrator: Playwright + ATS dispatch
│   │   ├── detector.js              # ATS type detection
│   │   ├── bot-state.js             # State machine + EventEmitter
│   │   ├── page-scanner.js          # DOM field discovery
│   │   ├── page-reader.js           # Readable page snapshots
│   │   ├── field-ai.js              # AI field mapping
│   │   ├── field-filler.js          # Form interaction (type, select, upload)
│   │   ├── ai-agent.js              # Agentic loop controller
│   │   ├── agent-executor.js        # Action executor
│   │   ├── ats/
│   │   │   ├── workday.js           # Workday-specific handler
│   │   │   ├── greenhouse.js        # Greenhouse-specific handler
│   │   │   ├── lever.js             # Lever-specific handler
│   │   │   └── generic.js           # Generic/fallback handler
│   │   └── profile.json             # Default user profile data
│   ├── public/                      # Static web UI
│   │   ├── dashboard.html/js/css    # Dashboard — KPIs, charts, app list
│   │   ├── application.html/js/css  # Application detail — notes, contacts
│   │   ├── auto-apply.html/js/css   # Auto-apply control panel
│   │   ├── auto-apply-live.html     # Live bot monitoring view
│   │   ├── profile-settings.html/js # Bot profile editor
│   │   └── ...
│   ├── server.js                    # Main Express server (port 3000)
│   ├── server-analysis.js           # Analysis server (port 3001)
│   ├── checkpoint.js                # Optimization checkpoint system
│   ├── company-context.js           # Tavily + Jina company research
│   ├── recruiter-automation-v2.js   # SerpAPI + Hunter + Gmail automation
│   ├── get-token.js                 # OAuth refresh token generator
│   ├── package.json                 # Dependencies
│   └── .env                         # Environment variables (not committed)
├── extension/                       # Chrome Extension (Manifest V3)
│   ├── manifest.json                # Extension configuration
│   ├── background.js                # Service worker
│   ├── popup.html/js                # Main popup UI
│   ├── options.html/js              # Settings page
│   ├── results.html/js              # Analysis results
│   ├── styles.css                   # Extension styles
│   └── icons/                       # Extension icons
├── docs/                            # Documentation assets
│   ├── architecture-diagram.svg     # System architecture diagram
│   ├── resume-optimization-flow.svg # Optimization pipeline flow
│   └── auto-apply-flow.svg          # Auto-apply bot flow
├── .gitignore
└── README.md
```

---

## Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| [Node.js](https://nodejs.org/) | >= 18.0 | Runtime |
| [PostgreSQL](https://www.postgresql.org/download/) | >= 12 | Application database |
| [Google Chrome](https://www.google.com/chrome/) | Latest | Extension host |
| [Google Cloud Project](https://console.cloud.google.com/) | — | OAuth + API access |
| AI API Key | — | Google Gemini or OpenAI |

**Optional:**
- [Hunter.io](https://hunter.io/) API key — recruiter email discovery
- [SerpAPI](https://serpapi.com/) key — LinkedIn recruiter search
- [Tavily](https://tavily.com/) API key — company context research

---

## Getting Started

### 1. Clone the Repository

```bash
git clone https://gitlab.com/surendra.velpula3-group/job-aggregator-ui.git
cd job-aggregator-ui
```

### 2. Install Dependencies

```bash
cd backend
npm install
```

This installs Playwright as well. To also install browser binaries:

```bash
npx playwright install chromium
```

### 3. Set Up PostgreSQL

```bash
# Connect to PostgreSQL
psql -U postgres

# Create the database
CREATE DATABASE resume_optimizer;

# Exit
\q
```

> The application auto-creates all required tables (`applications`, `notes`, `contacts`, `application_contacts`, `optimization_checkpoints`, `bot_sessions`) on first startup.

### 4. Configure Environment Variables

Create `backend/.env` from the template below:

```bash
cp backend/.env.example backend/.env
```

Or create it manually — see [Environment Variables Reference](#environment-variables-reference) for all variables.

**Minimal `.env` for resume optimization:**

```env
# Database
DATABASE_URL=postgresql://username:password@localhost:5432/resume_optimizer

# Google OAuth (Docs/Drive/Sheets)
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your_secret
GOOGLE_REFRESH_TOKEN=1//your_refresh_token

# Resume Document IDs (Google Docs)
FRONTEND_RESUME_DOC_ID=your_frontend_resume_doc_id
FULLSTACK_RESUME_DOC_ID=your_fullstack_resume_doc_id

# Google Drive folder for optimized resumes
DRIVE_FOLDER_ID=your_drive_folder_id

# AI Provider (gemini or openai)
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_key
# Or for OpenAI:
# CHATGPT_API_KEY=your_openai_key
```

### 5. Set Up Google Cloud APIs

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project
2. Enable these APIs:
   - [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
3. Create **OAuth 2.0 Client ID** (Application type: **Desktop app**)
4. Download the credentials or note Client ID and Client Secret
5. (Optional) Create a second OAuth client for Gmail if using a separate account

### 6. Generate OAuth Refresh Tokens

**For Google Docs/Drive/Sheets:**

```bash
cd backend
node get-token.js
```

Follow the prompts — this opens a browser for authorization and prints the refresh token.

**For Gmail (separate account):**

1. Add `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` to `.env`
2. Start the server: `node server.js`
3. Visit: `http://localhost:3000/auth/gmail`
4. Authorize and copy the refresh token to `GMAIL_REFRESH_TOKEN` in `.env`

### 7. Start the Servers

**Terminal 1 — Main Server (port 3000):**

```bash
cd backend
node server.js
```

Expected output:

```
Resume Optimizer Backend Running!
http://localhost:3000
Health: http://localhost:3000/health
Supports: Gemini AI & ChatGPT
```

**Terminal 2 — Analysis Server (port 3001):** *(optional, for 4-score analysis)*

```bash
cd backend
node server-analysis.js
```

Expected output:

```
Resume Analysis Server Running!
http://localhost:3001
Health: http://localhost:3001/health
```

**Verify:**

```bash
curl http://localhost:3000/health
```

### 8. Load the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Click the extension icon and configure AI API keys in **Settings**

### Using the Application

| Action | URL / Method |
|--------|-------------|
| **Dashboard** | `http://localhost:3000/dashboard` |
| **Application Detail** | `http://localhost:3000/application/:id` |
| **Auto-Apply Control** | `http://localhost:3000/auto-apply` |
| **Auto-Apply Live View** | `http://localhost:3000/auto-apply/live` |
| **Profile Settings** | `http://localhost:3000/profile-settings` |
| **Optimize Resume** | Chrome Extension → Optimize |
| **Analyze Resume** | Chrome Extension → Analyze |

---

## API Reference

### Main Server — Port 3000

#### Resume Optimization

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/optimize-resume` | Optimize resume for a job description |
| `GET` | `/api/optimize-resume/session/:sessionId` | Get checkpoint status for a session |
| `POST` | `/api/batch-optimize` | Batch optimize multiple resumes |

#### Applications (CRUD)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/applications` | List applications (filter: `status`, `days`, `search`) |
| `GET` | `/api/applications/:id` | Get single application |
| `PUT` | `/api/applications/:id` | Update application |
| `DELETE` | `/api/applications/:id` | Delete application |

#### Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/dashboard/summary` | KPI summary |
| `GET` | `/api/dashboard/daily` | Daily application count (30 days) |
| `GET` | `/api/dashboard/status-dist` | Status distribution |
| `GET` | `/api/dashboard/recent` | Recent activity |

#### Notes & Contacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/applications/:id/notes` | Get notes |
| `POST` | `/api/applications/:id/notes` | Add note |
| `DELETE` | `/api/notes/:noteId` | Delete note |
| `GET` | `/api/applications/:id/contacts` | Get contacts |
| `POST` | `/api/applications/:id/contacts` | Create & link contact |
| `PUT` | `/api/contacts/:id` | Update contact |
| `DELETE` | `/api/applications/:appId/contacts/:contactId` | Delete contact |

#### Recruiter Automation

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/applications/:id/find-recruiters` | Find recruiters & create email drafts |
| `GET` | `/api/gmail-drafts` | List Gmail drafts |

#### Auto-Apply Bot

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/auto-apply/status` | Current bot status |
| `POST` | `/api/auto-apply/start` | Start auto-apply for a job URL |
| `POST` | `/api/auto-apply/confirm` | Confirm submission |
| `POST` | `/api/auto-apply/pause` | Pause bot |
| `POST` | `/api/auto-apply/resume` | Resume bot |
| `POST` | `/api/auto-apply/stop` | Stop bot |
| `GET` | `/api/auto-apply/sessions` | List bot sessions |
| `GET` | `/api/auto-apply/session/:id` | Get session detail |
| `GET` | `/api/auto-apply/profile` | Get user profile |
| `POST` | `/api/auto-apply/profile` | Update user profile |

#### Other

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/export/csv` | Export applications as CSV |
| `GET` | `/auth/gmail` | Start Gmail OAuth flow |

### Analysis Server — Port 3001

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/analyze-resume` | 4-score resume analysis |
| `GET` | `/health` | Health check |

### WebSocket

| Endpoint | Description |
|----------|-------------|
| `ws://localhost:3000/ws/auto-apply` | Real-time bot state updates (JSON messages) |

---

## Database Schema

```
┌──────────────────────────┐       ┌──────────────────────────┐
│      applications        │       │         notes            │
├──────────────────────────┤       ├──────────────────────────┤
│ id          SERIAL PK    │──┐    │ id             SERIAL PK │
│ company_name VARCHAR     │  │    │ application_id INTEGER FK │
│ position_applied VARCHAR │  ├───>│ note_text      TEXT      │
│ date_applied DATE        │  │    │ created_at     TIMESTAMP │
│ status       VARCHAR     │  │    └──────────────────────────┘
│ resume_link  TEXT        │  │
│ jd_link      TEXT        │  │    ┌──────────────────────────┐
│ jd_text      TEXT        │  │    │   application_contacts   │
│ search_vector TSVECTOR   │  │    ├──────────────────────────┤
│ created_at   TIMESTAMP   │  ├───>│ application_id INTEGER FK│
│ updated_at   TIMESTAMP   │  │    │ contact_id     INTEGER FK│──┐
└──────────────────────────┘  │    │ PRIMARY KEY (app, contact)│  │
                              │    └──────────────────────────┘  │
┌──────────────────────────┐  │                                  │
│ optimization_checkpoints │  │    ┌──────────────────────────┐  │
├──────────────────────────┤  │    │        contacts          │  │
│ session_id   TEXT PK     │  │    ├──────────────────────────┤  │
│ step         TEXT        │  │    │ id          SERIAL PK    │<─┘
│ data         JSONB       │  │    │ full_name   VARCHAR      │
│ created_at   TIMESTAMP   │  │    │ email       VARCHAR UQ   │
│ updated_at   TIMESTAMP   │  │    │ linkedin_url TEXT        │
└──────────────────────────┘  │    │ role        VARCHAR      │
                              │    │ notes       TEXT         │
┌──────────────────────────┐  │    │ created_at  TIMESTAMP    │
│      bot_sessions        │  │    └──────────────────────────┘
├──────────────────────────┤  │
│ id          SERIAL PK    │  │
│ job_url     TEXT         │  │
│ status      VARCHAR      │  │
│ logs        JSONB        │  │
│ created_at  TIMESTAMP    │  │
│ updated_at  TIMESTAMP    │  │
└──────────────────────────┘  │
```

---

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID (Docs/Drive/Sheets) |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | Google OAuth refresh token |
| `FRONTEND_RESUME_DOC_ID` | Yes | Google Docs ID for frontend resume |
| `FULLSTACK_RESUME_DOC_ID` | Yes | Google Docs ID for full-stack resume |
| `DRIVE_FOLDER_ID` | Yes | Google Drive folder for uploads |
| `TRACKING_SHEET_ID` | No | Google Sheets tracking spreadsheet ID |
| `AI_PROVIDER` | No | `gemini` (default) or `openai` |
| `GEMINI_API_KEY` | If gemini | Google Gemini API key |
| `CHATGPT_API_KEY` | If openai | OpenAI API key |
| `GMAIL_CLIENT_ID` | No | Gmail OAuth client ID |
| `GMAIL_CLIENT_SECRET` | No | Gmail OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | No | Gmail OAuth refresh token |
| `SERP_API_KEY` | No | SerpAPI key for LinkedIn search |
| `HUNTER_API_KEY` | No | Hunter.io key for email discovery |
| `TAVILY_API_KEY` | No | Tavily key for company research |
| `BACKEND_RESUME_DOC_ID` | No | Backend-specific resume doc ID |
| `DEVOPS_RESUME_DOC_ID` | No | DevOps-specific resume doc ID |
| `WORKDAY_EMAIL` | No | Workday login email (auto-apply) |
| `WORKDAY_PASSWORD` | No | Workday login password (auto-apply) |
| `BOT_TIMEOUT_MINUTES` | No | Auto-apply bot timeout |
| `BOT_TYPING_DELAY_MS` | No | Typing delay for bot interactions |

---

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Push to the branch (`git push origin feature/your-feature`)
5. Open a Merge Request

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
