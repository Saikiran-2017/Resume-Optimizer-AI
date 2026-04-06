// =====================================================
// STEP 3.8 — COMPANY CONTEXT ENGINE
// Uses Tavily (search + full content) + Jina Reader (fallback fetcher)
// Both free tier — no more 403s, no more snippets-only
// =====================================================

const axios = require('axios');

// -------------------------------------------------------
// PART 1 — Tavily search
// One call = search + full extracted content per result
// No separate page fetching needed
// -------------------------------------------------------
async function tavilySearch(query, tavilyApiKey) {
  const response = await axios.post('https://api.tavily.com/search', {
    api_key: tavilyApiKey,
    query: query,
    search_depth: 'advanced',
    include_raw_content: true,
    max_results: 5,
    include_domains: [],
    exclude_domains: [
      'linkedin.com', 'glassdoor.com', 'indeed.com',
      'ziprecruiter.com', 'builtin.com', 'wellfound.com',
      'lever.co', 'greenhouse.io', 'workday.com', 'jobs.com'
    ]
  }, {
    timeout: 15000
  });

  return response.data.results || [];
}

// -------------------------------------------------------
// PART 2 — Jina Reader fallback
// Prefix any URL with r.jina.ai/ — no API key needed
// Handles JS rendering, returns clean markdown
// -------------------------------------------------------
async function jinaFetch(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  const response = await axios.get(jinaUrl, {
    headers: {
      'Accept': 'text/plain',
      'X-Return-Format': 'markdown'
    },
    timeout: 15000
  });
  return response.data.substring(0, 4000);
}

// -------------------------------------------------------
// PART 3 — Build targeted queries for Tavily
// -------------------------------------------------------
function buildSearchQueries(companyName, jobDescription) {
  const year = new Date().getFullYear();

  // Query 1: What project/initiative is this company running right now
  const q1 = `${companyName} modernization OR acquisition OR "new platform" OR "legacy migration" OR "system rewrite" ${year - 1} OR ${year}`;

  // Query 2: Engineering/tech blog — what are they actually building
  const q2 = `${companyName} engineering technology "we built" OR "how we" OR "our platform" OR "our system"`;

  // Query 3: News — why are they hiring now
  const q3 = `${companyName} ${year} technology expansion OR "new product" OR launched OR "digital transformation"`;

  return [q1, q2, q3];
}

// -------------------------------------------------------
// PART 4 — AI synthesis prompt
// -------------------------------------------------------
function buildCompanyContextPrompt(companyName, jobDescription, contentBlocks) {

  const contentText = contentBlocks
    .map((b, i) => `--- SOURCE ${i + 1}: ${b.source} ---\n${b.text}`)
    .join('\n\n');

  return `You are a company research analyst. Your job is to figure out what ${companyName} is actually building right now, based on their job description and web research.

====================================================
JOB DESCRIPTION (what they are hiring for):
====================================================
${jobDescription.substring(0, 2000)}

====================================================
WEB RESEARCH (news, engineering blogs, press releases):
====================================================
${contentText || 'No web content retrieved — use JD analysis only.'}

====================================================
YOUR TASK
====================================================

Based on ALL of the above, extract the following.
Be specific and concrete. If you cannot determine something with confidence, say "unclear" — do NOT hallucinate.

Respond in EXACTLY this format with no extra text:

PROBLEM_TYPE: [ONE of: modernization / scaling / greenfield / integration / unclear]

WHAT_THEY_BUILD: [1-2 sentences. What does this team actually build day to day? Be specific — not "financial software" but "broker-dealer clearing platform processing equity and options settlements for 200+ correspondent firms"]

WHY_HIRING_NOW: [1-2 sentences. WHY does this role exist right now? Acquisition? Rapid growth? Legacy rewrite? New product launch?]

PROJECT_CONTEXT: [Name or description of the specific project/initiative if identifiable. E.g. "AUC — modernizing clearing operations acquired from National Financial Services in 2019 — replacing COBOL mainframe with Java microservices". If not identifiable: describe the initiative based on JD responsibilities.]

TECH_BEING_REPLACED: [What old tech are they moving away from? E.g. "COBOL mainframe, legacy Oracle stored procedures, monolithic Java EE app". Write "unclear" if not mentioned.]

DOMAIN_LANGUAGE: [8-12 specific terms this company uses in their world. E.g. for fintech: "clearing, settlement, broker-dealer, DTC, NSCC, trade confirmation, position reconciliation, custodial accounts, margin calls, DTCC"]

BEST_MATCH_FROM_LOKESH: [Pick the STRONGEST match using TWO criteria scored together:
  (1) Technical stack overlap — does the tech match what this company uses?
  (2) Seniority and recency — prefer current/recent senior roles over old junior ones

  SCORING RULES — follow strictly:
  - ALWAYS prefer LPL Financial if technical overlap is 50% or more — it is the current role, most senior, most recent
  - Pick Athenahealth ONLY if the JD is clearly healthtech, medical, or FHIR-related
  - Pick YES Bank ONLY if the JD is clearly payments, banking, or financial transactions
  - Pick Comcast as LAST RESORT ONLY — it was a junior developer role from 2020-2021, weakest on the resume, only choose if absolutely nothing else fits

  Options with context:
  - LPL Financial (CURRENT ROLE — most senior, most recent, PREFER THIS):
    Spring Boot microservices, Kafka, Bloomberg market data, React, AWS, portfolio management systems for 19K financial advisors, large-scale fintech platform
  - Athenahealth (use for healthtech/FHIR JDs only):
    HIPAA-compliant patient portal, FHIR R4, healthcare data pipelines, Spring Boot, PostgreSQL
  - YES Bank (use for payments/banking JDs only):
    Digital banking payments platform, transaction processing, Spring Boot, Oracle, India
  - Comcast (LAST RESORT — junior role 5 years ago, pick only if domain clearly matches and nothing else does):
    xFi home WiFi platform, Angular, Java, streaming/media infrastructure

  State which role you picked AND exactly why the technical overlap justifies it.]

NARRATIVE_FRAME: [2-3 sentences. Exactly how should Lokesh position his experience for THIS company? What is the one story to tell? Which specific experience maps most directly to what they are building? Always lead with the best-matched role.]

CONFIDENCE: [High / Medium / Low — how confident are you based on the research quality?]`;
}

// -------------------------------------------------------
// MAIN EXPORTED FUNCTION
// -------------------------------------------------------
async function fetchCompanyContext({
  companyName,
  jobDescription,
  tavilyApiKey,
  aiProvider,
  apiKey,
  generateAIContent
}) {
  console.log(`\n🏢 Step 3.8: Fetching company context for "${companyName}"...`);

  if (!tavilyApiKey) {
    console.log('  ⚠️ No TAVILY_API_KEY — running JD-only analysis');
    return await analyzeJDOnly(companyName, jobDescription, aiProvider, apiKey, generateAIContent);
  }

  try {
    const queries = buildSearchQueries(companyName, jobDescription);
    const contentBlocks = [];

    // Fire all 3 Tavily searches
    for (const query of queries) {
      try {
        console.log(`  🔍 Tavily: "${query.substring(0, 65)}..."`);
        const results = await tavilySearch(query, tavilyApiKey);
        console.log(`     ✅ ${results.length} results`);

        for (const r of results) {
          const text = (r.raw_content || r.content || '').substring(0, 3000);
          if (text.length > 100) {
            contentBlocks.push({
              source: r.url,
              title: r.title,
              text
            });
          }
        }
      } catch (err) {
        console.log(`     ⚠️ Tavily query failed: ${err.message}`);
      }
    }

    console.log(`  📦 Total content blocks from Tavily: ${contentBlocks.length}`);

    // If Tavily got very little, try Jina on company's own site
    if (contentBlocks.length < 3) {
      console.log('  📄 Low content — trying Jina Reader on company site...');
      const slug = companyName.toLowerCase().replace(/\s+/g, '');
      const jinaTargets = [
        `https://${slug}.com/blog`,
        `https://${slug}.com/engineering`,
        `https://${slug}.com/about`,
        `https://engineering.${slug}.com`
      ];

      for (const url of jinaTargets) {
        try {
          console.log(`  📄 Jina: ${url}`);
          const text = await jinaFetch(url);
          if (text && text.length > 200) {
            contentBlocks.push({ source: url, title: `${companyName} site`, text });
            console.log(`     ✅ Got ${text.length} chars`);
            break;
          }
        } catch (err) {
          console.log(`     ⚠️ Jina failed: ${err.message}`);
        }
      }
    }

    // AI synthesis
    console.log(`  🤖 Synthesizing context from ${contentBlocks.length} sources...`);
    const prompt = buildCompanyContextPrompt(companyName, jobDescription, contentBlocks);
    const rawContext = await generateAIContent(prompt, aiProvider, apiKey);

    const parsed = parseCompanyContext(rawContext);
    parsed.source = 'tavily_+_jina';
    parsed.sourcesCount = contentBlocks.length;

    console.log(`\n  📊 Company Context:`);
    console.log(`     Problem type : ${parsed.problemType}`);
    console.log(`     Why hiring   : ${parsed.whyHiringNow?.substring(0, 80)}...`);
    console.log(`     Best match   : ${parsed.bestMatchFromLokesh?.substring(0, 80)}...`);
    console.log(`     Confidence   : ${parsed.confidence}`);
    console.log(`     Sources used : ${contentBlocks.length}\n`);

    return parsed;

  } catch (error) {
    console.log(`  ⚠️ Company context failed: ${error.message} — falling back to JD-only`);
    return await analyzeJDOnly(companyName, jobDescription, aiProvider, apiKey, generateAIContent);
  }
}

// -------------------------------------------------------
// FALLBACK — JD-only when Tavily unavailable or fails
// -------------------------------------------------------
async function analyzeJDOnly(companyName, jobDescription, aiProvider, apiKey, generateAIContent) {
  console.log('  🤖 Running JD-only context analysis...');
  const prompt = buildCompanyContextPrompt(companyName, jobDescription, []);
  try {
    const rawContext = await generateAIContent(prompt, aiProvider, apiKey);
    const parsed = parseCompanyContext(rawContext);
    parsed.source = 'jd_only';
    parsed.sourcesCount = 0;
    return parsed;
  } catch (err) {
    console.log(`  ⚠️ JD-only also failed: ${err.message}`);
    return getDefaultContext(companyName);
  }
}

// -------------------------------------------------------
// Parse AI output into structured object
// -------------------------------------------------------
function parseCompanyContext(rawText) {
  const extract = (key) => {
    const match = rawText.match(new RegExp(`${key}:\\s*(.+?)(?=\\n[A-Z_]+:|$)`, 'is'));
    return match ? match[1].trim() : 'unclear';
  };

  return {
    problemType:         extract('PROBLEM_TYPE'),
    whatTheyBuild:       extract('WHAT_THEY_BUILD'),
    whyHiringNow:        extract('WHY_HIRING_NOW'),
    projectContext:      extract('PROJECT_CONTEXT'),
    techBeingReplaced:   extract('TECH_BEING_REPLACED'),
    domainLanguage:      extract('DOMAIN_LANGUAGE'),
    bestMatchFromLokesh: extract('BEST_MATCH_FROM_LOKESH'),
    narrativeFrame:      extract('NARRATIVE_FRAME'),
    confidence:          extract('CONFIDENCE'),
    source:              'unknown',
    sourcesCount:        0,
    rawContext:          rawText
  };
}

// -------------------------------------------------------
// Default fallback if everything fails
// -------------------------------------------------------
function getDefaultContext(companyName) {
  return {
    problemType:         'unclear',
    whatTheyBuild:       `${companyName} — context unavailable`,
    whyHiringNow:        'unclear',
    projectContext:      'unclear',
    techBeingReplaced:   'unclear',
    domainLanguage:      'unclear',
    bestMatchFromLokesh: 'unclear',
    narrativeFrame:      'Use full stack experience as general positioning',
    confidence:          'Low',
    source:              'fallback',
    sourcesCount:        0,
    rawContext:          ''
  };
}

module.exports = { fetchCompanyContext };