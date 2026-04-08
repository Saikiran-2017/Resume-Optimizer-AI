const fs = require('fs');
const path = require('path');

function loadProfile() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'profile.json'), 'utf8'));
}

function extractJobLocation(jobDescription) {
  if (!jobDescription) {
    return { type: 'default', city: 'Irving', state: 'Texas', stateCode: 'TX', zip: '75038', street: '1203 Meadow Creek Dr' };
  }

  const remoteKeywords = /remote|work from home|wfh|fully remote|100% remote/i;
  if (remoteKeywords.test(jobDescription)) {
    return { type: 'remote', city: 'Irving', state: 'Texas', stateCode: 'TX', zip: '75038', street: '1203 Meadow Creek Dr' };
  }

  const locationPattern = /(?:located in|location:|based in|office in|on-?site in)?\s*([A-Z][a-zA-Z\s]+),\s*([A-Z]{2})/g;
  const match = locationPattern.exec(jobDescription);
  if (match) {
    return { type: 'onsite', city: match[1].trim(), state: match[2], street: '1203 Meadow Creek Dr', zip: null };
  }

  return { type: 'default', city: 'Irving', state: 'Texas', stateCode: 'TX', zip: '75038', street: '1203 Meadow Creek Dr' };
}

function buildFieldsDescription(fields) {
  return fields.map((f, i) => {
    let desc = `FIELD ${i + 1}:\n  key: "${f.key}"\n  label: "${f.label}"\n  type: ${f.type}\n  required: ${!!f.required}`;
    if (f.options && f.options.length > 0) {
      const optTexts = f.options.map(o => typeof o === 'string' ? o : (o.text || o.value));
      desc += `\n  options: ${JSON.stringify(optTexts)}`;
    }
    if (f.placeholder) desc += `\n  placeholder: "${f.placeholder}"`;
    if (f.currentValue) desc += `\n  currentValue: "${f.currentValue}"`;
    if (f.value) desc += `\n  prefilled: "${f.value}"`;
    if (f.section) desc += `\n  section: "${f.section}"`;
    return desc;
  }).join('\n\n');
}

function buildProfileDescription(profile) {
  const p = profile.personal;
  const w = profile.workAuthorization;
  const e = profile.employment;
  const ed = profile.education;
  const d = profile.demographics;
  const c = profile.commonAnswers;

  return `PERSONAL:
  Name: ${p.fullName}
  First Name: ${p.firstName}
  Last Name: ${p.lastName}
  Email: ${p.email}
  Phone: ${p.phone}
  Phone Formatted: ${p.phoneFormatted}
  LinkedIn: ${p.linkedin}
  GitHub: ${p.github}
  Portfolio: ${p.portfolio}
  Address: ${p.address.street}, ${p.address.city}, ${p.address.state} ${p.address.zip}, ${p.address.country}

WORK AUTHORIZATION:
  Authorized to work in US: ${w.authorized}
  Requires Sponsorship: ${w.requireSponsorship}
  Visa Status: ${w.visaStatus}
  Willing to Relocate: ${w.willingToRelocate}
  Remote: ${w.workRemote}, Hybrid: ${w.workHybrid}, Onsite: ${w.workOnsite}

EMPLOYMENT:
  Current Employer: ${e.currentEmployer}
  Current Title: ${e.currentTitle}
  Expected Salary: $${e.expectedSalary} (range: $${e.expectedSalaryMin}-$${e.expectedSalaryMax})
  Notice Period: ${e.noticePeriod} days (immediately available)
  Years of Experience: ${e.yearsOfExperience}
  Start Date: ${e.startDate}

EDUCATION:
  Degree: ${ed.degree} in ${ed.field}
  School: ${ed.school}
  Graduation: ${ed.graduationYear}
  GPA: ${ed.gpa}

DEMOGRAPHICS (for EEO/voluntary):
  Gender: ${d.gender}
  Ethnicity: ${d.ethnicity}
  Veteran: ${d.veteran}
  Disability: ${d.disability}
  Hispanic/Latino: ${d.hispanicLatino}

COMMON ANSWERS:
  Cover Letter: ${c.coverLetter}
  Why This Role: ${c.whyThisRole}
  Availability: ${c.availability}
  Salary: ${c.salaryExpectation}
  References: ${c.references}`;
}

function buildWorkHistoryDescription(profile) {
  const wh = profile.workHistory || [];
  if (wh.length === 0) return '';

  return `\nWORK HISTORY (${wh.length} positions — use MOST RECENT / FIRST entry for work experience fields):
${wh.map((w, i) => `
  POSITION ${i + 1}${i === 0 ? ' (MOST RECENT — use this for Job Title, Company, Location, Description fields)' : ''}:
    Company: ${w.company}
    Title: ${w.title}
    Start: ${w.startDate}
    End: ${w.endDate}
    Current: ${w.current}
    Location: ${w.location}
    Description: ${w.description.substring(0, 200)}...`).join('\n')}`;
}

async function getFieldAnswers({ fields, profile, jobDescription, companyName, position, generateAIContent, aiProvider, apiKey, pageContext }) {
  if (!fields || fields.length === 0) return {};

  const jobLocation = extractJobLocation(jobDescription);
  const fieldsDesc = buildFieldsDescription(fields);
  const profileDesc = buildProfileDescription(profile);
  const workHistoryDesc = buildWorkHistoryDescription(profile);

  // Detect if page has work experience fields
  const hasJobTitleField = fields.some(f =>
    f.key.toLowerCase().includes('jobtitle') ||
    f.label.toLowerCase().includes('job title') ||
    f.key.toLowerCase().includes('companyname') ||
    f.label.toLowerCase().includes('company')
  );

  const isWorkExpPage = pageContext === 'work_experience' || hasJobTitleField;

  let workExpRules = '';
  if (isWorkExpPage && profile.workHistory && profile.workHistory.length > 0) {
    const latest = profile.workHistory[0];
    workExpRules = `
CRITICAL — WORK EXPERIENCE RULES (THIS PAGE HAS WORK EXPERIENCE FIELDS):
- "Job Title" / "Job Title*" → "${latest.title}" (candidate's ACTUAL title at their most recent job, NOT the position being applied for)
- "Company" / "Company*" → "${latest.company}" (candidate's ACTUAL employer, NOT ${companyName})
- "Location" → "${latest.location}" (candidate's work location)
- "Role Description" / "Description" → Write description of what candidate did at ${latest.company}. Use this content: "${latest.description.substring(0, 300)}"
- DO NOT use "${companyName}" or "${position}" for work experience fields. Those are what the candidate is APPLYING TO, not their past work.
- The application is being submitted TO ${companyName}. The work experience fields should contain the candidate's PREVIOUS work history.`;
  }

  const prompt = `You are filling a job application for ${profile.personal.fullName}.

APPLYING TO: ${position} at ${companyName}
JD SUMMARY: ${(jobDescription || '').substring(0, 1500)}

JOB LOCATION: ${jobLocation.type === 'remote' ? 'Remote' : `${jobLocation.city}, ${jobLocation.state}`}

CANDIDATE PROFILE:
${profileDesc}
${workHistoryDesc}
${workExpRules}

ADDRESS RULE:
- If job is remote → use Irving Texas address: 1203 Meadow Creek Dr, Irving, TX 75038
- If job has specific city → use that city/state, street=1203 Meadow Creek Dr, find a realistic zip for that city
- For zip code field: provide a real zip code for the city, not a made-up number

NOTICE PERIOD RULE:
- For any field about notice period, availability, when can you start → always answer "0", "immediately", or pick the shortest option

FIELDS ON THIS PAGE:
${fieldsDesc}

RULES:
1. Return ONLY valid JSON, no explanation, no markdown, no code fences
2. Key = the field "key" value shown above (use the EXACT key string in quotes)
3. For SELECT/DROPDOWN fields: return EXACTLY one of the option texts shown (case-sensitive). Example: options=["Select One","Yes","No"] → return "Yes"
4. For text fields: return appropriate answer from profile
5. For yes/no sponsorship questions: answer "Yes" (Sai Kiran P DOES require sponsorship)
6. "Are you 18 years or older?" → "Yes"
7. "Do you have a high school diploma?" → "Yes"
8. "Are you legally authorized to work in the United States?" → "Yes"
9. "Will you now or in the future require immigration/visa sponsorship?" → "Yes"
10. For salary fields: use "120000"
11. For fields you cannot answer: return "__SKIP__"
12. Never "__SKIP__" for required fields
13. For EEO/demographic fields: use profile demographics
14. If a field already has a prefilled value: return "__PREFILLED__"
15. For file upload fields: return "__FILE__"
16. For "How did you hear" / source type fields: first try "${companyName} Careers" (company career page). If not available, "LinkedIn" or "Job Board"
17. For LinkedIn URL fields: "${profile.personal.linkedin}"
18. For GitHub/Portfolio URL fields: "${profile.personal.portfolio}"
19. CRITICAL: For select/dropdown, return the EXACT option text, not boolean
20. CRITICAL: For work experience fields (Job Title, Company, Location, Description) → use CANDIDATE'S work history, NOT the job being applied to

Return JSON:
{
  "fieldKey": "answer",
  ...
}`;

  console.log('[FIELD-AI] Prompt sent to AI (' + fields.length + ' fields, workExp=' + isWorkExpPage + ')');
  const raw = await generateAIContent(prompt, aiProvider, apiKey);
  console.log('[FIELD-AI] Raw AI response:', raw ? raw.substring(0, 500) : '(empty)');

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }

  let parsed = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {}
    }
    if (Object.keys(parsed).length === 0) {
      console.error('[FIELD-AI] Failed to parse AI response:', cleaned.substring(0, 500));
      return {};
    }
  }

  // ── Post-process: correct known AI mistakes ───────────────────────────────
  for (const key of Object.keys(parsed)) {
    const k = key.toLowerCase();
    const v = String(parsed[key] || '');

    // Country Phone Code — keep "United States" as-is; field-filler will try multiple terms
    if (k.includes('countryphonecode') || k.includes('phonenumber--country') || k === 'phonenumber--countryphonecode') {
      if (v.startsWith('+') || /^\+\d/.test(v) || v === '+1' || !v || v === '__SKIP__') {
        parsed[key] = 'United States';
      }
    }

    // Source/hear about — prefer company career page, fallback to LinkedIn
    if ((k.includes('source') || k.includes('hear')) && (!v || v === '__SKIP__' || v === 'LinkedIn')) {
      const company = companyName || '';
      parsed[key] = company ? `${company} Careers` : 'LinkedIn';
    }
  }

  console.log('[FIELD-AI] Parsed answers:', JSON.stringify(parsed, null, 2).substring(0, 500));
  return parsed;
}

async function generateWorkExperienceDescription({ jobEntry, fieldLabel, placeholder, maxLength, generateAIContent, aiProvider, apiKey }) {
  const prompt = `You are filling a work experience form field in a job application.

FIELD LABEL: "${fieldLabel || 'Description'}"
PLACEHOLDER TEXT: "${placeholder || ''}"
MAX CHARACTERS: ${maxLength || 2000}

JOB BEING DESCRIBED:
Company: ${jobEntry.company}
Title: ${jobEntry.title}
Duration: ${jobEntry.startDate} - ${jobEntry.endDate}
Location: ${jobEntry.location}

AVAILABLE DESCRIPTION CONTENT:
${jobEntry.description}

RULE: Write a natural description that fits what this field is asking for.
Keep within ${maxLength || 2000} characters.
Sound human-written, not AI-generated.
Do not use buzzwords like "leveraged", "spearheaded", "championed".

Return ONLY the text to fill in, nothing else.`;

  return (await generateAIContent(prompt, aiProvider, apiKey)).trim();
}

module.exports = { getFieldAnswers, extractJobLocation, loadProfile, generateWorkExperienceDescription };