// =====================================================
// RECRUITER FINDER & EMAIL AUTOMATION MODULE V2
// With AI-Powered Top 3 Recruiter Selection
// =====================================================

const axios = require('axios');

// =====================================================
// 1. EXTRACT JOB DETAILS FROM JD (Enhanced)
// =====================================================
async function extractJobDetailsEnhanced(jobDescription, aiProvider, apiKey, generateAIContent) {
  try {
    const extractionPrompt = `Extract the following information from this job description. Be precise and accurate.

JOB DESCRIPTION:
${jobDescription.substring(0, 5000)}

Extract and respond in EXACTLY this format:
COMPANY: [company name]
LOCATION: [city, state or remote]
POSITION: [job title/role]

Example:
COMPANY: LPL Financial
LOCATION: Austin, TX
POSITION: Java Full Stack Developer

Now extract from the job description above:`;

    const response = await generateAIContent(extractionPrompt, aiProvider, apiKey);
    
    let company = 'N/A';
    let location = 'N/A';
    let position = 'N/A';

    const companyMatch = response.match(/COMPANY:\s*(.+?)(?:\n|$)/i);
    const locationMatch = response.match(/LOCATION:\s*(.+?)(?:\n|$)/i);
    const positionMatch = response.match(/POSITION:\s*(.+?)(?:\n|$)/i);

    if (companyMatch) company = companyMatch[1].trim();
    if (locationMatch) location = locationMatch[1].trim();
    if (positionMatch) position = positionMatch[1].trim();

    console.log('📊 Extracted Job Details:');
    console.log(`   🏢 Company: ${company}`);
    console.log(`   📍 Location: ${location}`);
    console.log(`   💼 Position: ${position}`);

    return { company, location, position };
  } catch (error) {
    console.error('❌ Failed to extract job details:', error.message);
    return { company: 'N/A', location: 'N/A', position: 'N/A' };
  }
}

// =====================================================
// 2. GET COMPANY DOMAIN
// =====================================================
async function getCompanyDomain(companyName, aiProvider, apiKey, generateAIContent) {
  try {
    const domainPrompt = `What is the primary corporate email domain for ${companyName}?

Examples:
- LPL Financial → lpl.com
- JPMorgan Chase → jpmorganchase.com
- Amazon → amazon.com
- Google → google.com

Respond with ONLY the domain (e.g., company.com), nothing else.`;

    const domain = await generateAIContent(domainPrompt, aiProvider, apiKey);
    const cleanDomain = domain.trim().toLowerCase().replace(/https?:\/\//g, '').replace(/www\./g, '').split('/')[0];
    
    console.log(`🌐 Company Domain: ${cleanDomain}`);
    return cleanDomain;
  } catch (error) {
    console.error('❌ Failed to get company domain:', error.message);
    const fallbackDomain = companyName.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '')
      .substring(0, 20) + '.com';
    return fallbackDomain;
  }
}

// =====================================================
// 3. GOOGLE SEARCH USING SERPAPI (NO CAPTCHA!)
// =====================================================
async function searchRecruitersOnGoogle(companyName, position, location) {
    console.log(`🔍 Searching Google for recruiters at ${companyName}...`);
    
    const searchQuery = `${companyName} company recruiter site:linkedin.com/in`;
    
    try {
      // Get SerpAPI key from environment
      const serpApiKey = process.env.SERP_API_KEY;
      
      if (!serpApiKey) {
        console.error('❌ SERP_API_KEY not found in .env file');
        console.log('💡 Get your free API key at: https://serpapi.com/');
        return [];
      }
      
      const serpUrl = `https://serpapi.com/search.json?q=${encodeURIComponent(searchQuery)}&num=20&api_key=${serpApiKey}`;
      
      console.log('🌐 Calling SerpAPI (no CAPTCHA!)...');
      const response = await axios.get(serpUrl);
      
      const results = [];
      const seenUrls = new Set();
      
      // Extract organic results
      if (response.data && response.data.organic_results) {
        console.log(`📊 SerpAPI returned ${response.data.organic_results.length} results`);
        
        response.data.organic_results.forEach(result => {
          const link = result.link;
          
          if (link && link.includes('linkedin.com/in/')) {
            // Clean URL
            const cleanUrl = link.split('?')[0].split('#')[0];
            
            // Extract profile slug
            const match = cleanUrl.match(/linkedin\.com\/in\/([a-zA-Z0-9-]+)/);
            if (match && match[1]) {
              const profileSlug = match[1];
              const finalUrl = `https://www.linkedin.com/in/${profileSlug}`;
              
              if (!seenUrls.has(finalUrl)) {
                seenUrls.add(finalUrl);
                
                results.push({
                  linkedinUrl: finalUrl,
                  profileSlug: profileSlug,
                  title: result.title || '',
                  snippet: result.snippet || ''
                });
                
                console.log(`✅ Found profile ${results.length}: ${profileSlug}`);
              }
            }
          }
        });
      } else {
        console.log('⚠️ No organic_results in SerpAPI response');
      }
      
      console.log(`✅ Found ${results.length} LinkedIn profiles via SerpAPI`);
      
      if (results.length > 0) {
        console.log('Sample profiles:');
        results.slice(0, 3).forEach((r, i) => {
          console.log(`  ${i + 1}. ${r.profileSlug} - ${r.title.substring(0, 60)}`);
        });
      }
      
      return results;
      
    } catch (error) {
      console.error('❌ SerpAPI search failed:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
      return [];
    }
  }
// =====================================================
// 4. AI SELECTS TOP 3 AND EXTRACTS THEIR NAMES
// =====================================================
async function selectTop3Recruiters(
    rawRecruiters,
    jobDescription,
    resumeContent,
    location,
    position,
    companyName,
    aiProvider,
    apiKey,
    generateAIContent
  ) {
    try {
      console.log('🤖 AI analyzing recruiters to find top 3 matches...');
  
      // Format recruiter data for AI
      const recruiterList = rawRecruiters.map((r, index) => 
        `${index + 1}. LinkedIn: ${r.linkedinUrl}
     Title/Name: ${r.title || r.snippet.substring(0, 100)}`
      ).join('\n\n');
  
      const selectionPrompt = `You are a career strategist helping a job seeker find the BEST recruiters to contact for a specific job.
  
  JOB DETAILS:
  Company: ${companyName}
  Position: ${position}
  Location: ${location}
  
  JOB DESCRIPTION:
  ${jobDescription.substring(0, 3000)}
  
  CANDIDATE'S RESUME SUMMARY:
  ${resumeContent.substring(0, 2000)}
  
  AVAILABLE RECRUITERS FROM GOOGLE SEARCH:
  ${recruiterList}
  
  YOUR TASK - PART 1: SELECT TOP 3
  Analyze each recruiter and select the TOP 3 BEST MATCHES based on:
  1. **Seniority Level** - Senior recruiters, talent acquisition managers have more authority
  2. **Specialization** - Tech recruiters for tech roles, finance recruiters for finance roles
  3. **Location Match** - Recruiters in the same location/region as the job
  4. **Role Relevance** - Keywords matching the position (e.g., "software", "engineering" for dev roles)
  5. **Department Fit** - Engineering recruiters for engineering roles
  
  YOUR TASK - PART 2: EXTRACT CLEAN NAMES
  For each selected recruiter, extract their FIRST NAME and LAST NAME separately.
  
  RESPONSE FORMAT (respond ONLY with this format):
  SELECTED: 1,5,8
  RECRUITER_1: John|Smith
  RECRUITER_5: Sarah|Johnson
  RECRUITER_8: Michael|Chen
  
  RULES:
  - First line: SELECTED: [comma-separated indices]
  - Following lines: RECRUITER_X: FirstName|LastName
  - Remove middle names, credentials (PhD, MBA, CDR, etc.), suffixes (Jr, Sr, III)
  - Remove numbers from names
  - If name has 3+ parts, use FIRST and LAST only
  - If you can't determine first/last name, use: Unknown|Unknown
  
  Examples:
  "Andy Hardy - Sr. Recruiter" → Andy|Hardy
  "Jen Ashton Motz, MBA" → Jen|Motz
  "Jarrett Chan1" → Jarrett|Chan
  "Samantha Loweth, CDR" → Samantha|Loweth
  "Dr. John Michael Smith III" → John|Smith
  
  Now analyze and respond:`;
  
      const response = await generateAIContent(selectionPrompt, aiProvider, apiKey);
      
      console.log('\n🤖 AI Selection Response:');
      console.log(response);
      console.log('');
      
      // Parse AI response
      const lines = response.split('\n').filter(line => line.trim());
      
      // Extract selected indices
      const selectedLine = lines.find(line => line.match(/SELECTED:\s*/i));
      if (!selectedLine) {
        console.log('⚠️ AI did not return valid selection, using first 3 as fallback');
        return rawRecruiters.slice(0, 3).map(r => ({
          ...r,
          extractedFirstName: 'Unknown',
          extractedLastName: 'Unknown'
        }));
      }
  
      const selectedMatch = selectedLine.match(/SELECTED:\s*([\d,\s]+)/i);
      if (!selectedMatch) {
        console.log('⚠️ Could not parse SELECTED line');
        return rawRecruiters.slice(0, 3).map(r => ({
          ...r,
          extractedFirstName: 'Unknown',
          extractedLastName: 'Unknown'
        }));
      }
  
      const indices = selectedMatch[1]
        .split(',')
        .map(s => parseInt(s.trim()) - 1) // Convert to 0-indexed
        .filter(i => i >= 0 && i < rawRecruiters.length);
  
      // Extract names for each selected recruiter
      const selectedRecruitersWithNames = indices.map(index => {
        const recruiter = rawRecruiters[index];
        
        // Find the name line for this recruiter
        const namePattern = new RegExp(`RECRUITER_${index + 1}:\\s*([^|]+)\\|(.+)`, 'i');
        const nameLine = lines.find(line => namePattern.test(line));
        
        let firstName = 'Unknown';
        let lastName = 'Unknown';
        
        if (nameLine) {
          const nameMatch = nameLine.match(namePattern);
          if (nameMatch) {
            firstName = nameMatch[1].trim();
            lastName = nameMatch[2].trim();
          }
        }
        
        return {
          ...recruiter,
          extractedFirstName: firstName,
          extractedLastName: lastName
        };
      });
      
      console.log(`✅ AI selected ${selectedRecruitersWithNames.length} top recruiters with names:`);
      selectedRecruitersWithNames.forEach((r, idx) => {
        console.log(`   ${idx + 1}. ${r.extractedFirstName} ${r.extractedLastName} - ${r.title.substring(0, 60)}`);
      });
  
      return selectedRecruitersWithNames;
  
    } catch (error) {
      console.error('❌ AI selection failed:', error.message);
      console.log('⚠️ Falling back to first 3 recruiters');
      return rawRecruiters.slice(0, 3).map(r => ({
        ...r,
        extractedFirstName: 'Unknown',
        extractedLastName: 'Unknown'
      }));
    }
  }

// =====================================================
// 5. EXTRACT RECRUITER NAME
// =====================================================
async function extractRecruiterName(linkedinUrl, title, snippet, aiProvider, apiKey, generateAIContent) {
  try {
    // Method 1: Try to extract from URL slug first
    const urlParts = linkedinUrl.split('/in/')[1];
    if (urlParts) {
      const slug = urlParts.split('/')[0];
      const nameParts = slug.split('-').filter(part => !/^\d+$/.test(part));
      const nameFromUrl = nameParts.map(part => 
        part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
      ).join(' ');
      
      if (nameFromUrl.length > 3 && nameFromUrl.split(' ').length >= 2) {
        return nameFromUrl;
      }
    }
    
    // Method 2: Try to extract from title
    if (title && title.length > 3) {
      const titleParts = title.split('-')[0].split('|')[0].trim();
      if (titleParts.length > 3 && titleParts.length < 50) {
        return titleParts;
      }
    }
    
    // Method 3: AI extraction from snippet
    if (snippet && snippet.length > 10) {
      const namePrompt = `Extract the person's full name from this LinkedIn snippet:
"${snippet.substring(0, 300)}"

Respond with ONLY the full name (First Last), nothing else. If you can't find a clear name, respond with "Unknown".`;
      
      const extractedName = await generateAIContent(namePrompt, apiProvider, apiKey);
      const cleanName = extractedName.trim();
      
      if (cleanName !== 'Unknown' && cleanName.length > 3 && cleanName.length < 50) {
        return cleanName;
      }
    }
    
    return 'Unknown';
  } catch (error) {
    console.error('❌ Failed to extract name:', error.message);
    return 'Unknown';
  }
}

// =====================================================
// 6. GET EMAIL WITH HUNTER.IO
// =====================================================
async function findEmailWithHunter(firstName, lastName, domain, hunterApiKey) {
  try {
    console.log(`📧 Searching email for ${firstName} ${lastName} at ${domain}...`);
    
    const url = `https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${hunterApiKey}`;
    
    const response = await axios.get(url);
    
    if (response.data && response.data.data && response.data.data.email) {
      const email = response.data.data.email;
      const confidence = response.data.data.score;
      
      console.log(`✅ Found email: ${email} (Confidence: ${confidence}%)`);
      return { email, confidence };
    } else {
      console.log('❌ No email found via Hunter.io');
      return { email: null, confidence: 0 };
    }
  } catch (error) {
    console.error('❌ Hunter.io API error:', error.response?.data || error.message);
    return { email: null, confidence: 0 };
  }
}

// =====================================================
// 7. GENERATE PERSONALIZED EMAIL
// =====================================================
async function generatePersonalizedEmail(
  recruiterName,
  companyName,
  position,
  resumeContent,
  jobDescription,
  aiProvider,
  apiKey,
  generateAIContent
) {
  try {
    const emailPrompt = `You are writing a professional, personalized cold email to a recruiter.

RECRUITER NAME: ${recruiterName}
COMPANY: ${companyName}
POSITION: ${position}

YOUR RESUME HIGHLIGHTS:
${resumeContent.substring(0, 2000)}

JOB DESCRIPTION:
${jobDescription.substring(0, 2000)}

Write a compelling, concise email (150-200 words) that:
1. Opens with a professional greeting using recruiter's first name
2. Mentions the specific position and company in first sentence
3. Highlights 2-3 key matching qualifications from the resume
4. Shows genuine interest in the company/role
5. Includes a clear call-to-action (request for brief conversation)
6. Ends with "Best regards," and your name

CRITICAL FORMATTING RULES:
- Use proper line breaks between paragraphs (double newline)
- DO NOT include phone number, email, LinkedIn, GitHub, or portfolio links (these will be added automatically)
- DO NOT add "---" separators or extra formatting
- Keep signature simple: just "Best regards," and name
- Be authentic and conversational, not robotic

GOOD EXAMPLE:
Hi Sarah,

I'm reaching out about the Software Engineer position at Chewy. With 5 years building scalable microservices at LPL Financial, I've developed expertise that aligns well with your backend requirements.

I'm particularly excited about Chewy's mission to innovate pet health solutions. My experience with Spring Boot, AWS deployments, and React frontends would allow me to contribute immediately to your Practice Hub team.

Would you be open to a brief conversation next week to discuss how my background could support Chewy's goals?

Best regards,
Sai Kiran P
saikiran.itcareer@gmail.com
+1 (940) 344-2150

Generate the email now:`;

    const emailBody = await generateAIContent(emailPrompt, aiProvider, apiKey);
    
    console.log('✅ Personalized email generated');
    return emailBody.trim();
  } catch (error) {
    console.error('❌ Failed to generate email:', error.message);
    throw error;
  }
}

// =====================================================
// 8. CREATE GMAIL DRAFT (FIXED FORMATTING)
// =====================================================
async function createGmailDraft(gmail, toEmail, subject, bodyText, resumeDocUrl) {
    try {
      console.log(`📨 Creating Gmail draft to ${toEmail}...`);
      
      // Check if signature already exists in bodyText
      const hasSignature = bodyText.includes('Best regards') || 
                          bodyText.includes('Sincerely') || 
                          bodyText.includes('Thank you');
      
      let emailBody;
      
      if (hasSignature) {
        // AI already added signature, just add resume link
        emailBody = `${bodyText}
  
  ---
  📄 Resume: ${resumeDocUrl}`;
      } else {
        // No signature, add full signature
        emailBody = `${bodyText}
  
  ---
  Best regards,
  Lokesh Kanakamedala
  
  📄 Resume: ${resumeDocUrl}`;
      }
  
      const email = [
        `To: ${toEmail}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        emailBody
      ].join('\n');
  
      const encodedEmail = Buffer.from(email)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
  
      const draft = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedEmail
          }
        }
      });
  
      console.log(`✅ Draft created with ID: ${draft.data.id}`);
      return draft.data;
    } catch (error) {
      console.error('❌ Failed to create Gmail draft:', error.message);
      throw error;
    }
  }

// =====================================================
// 9. MAIN ORCHESTRATOR WITH TOP 3 SELECTION
// =====================================================
async function findRecruitersAndSendEmails({
  jobDescription,
  resumeContent,
  resumeDocUrl,
  aiProvider,
  apiKey,
  hunterApiKey,
  gmail,
  pool,
  applicationId,
  generateAIContent
}) {
  console.log('\n🚀 Starting Recruiter Finder with AI-Powered Top 3 Selection...\n');
  
  const results = {
    recruiters: [],
    errors: [],
    stats: {
      searched: 0,
      aiSelected: 0,
      emailsFound: 0,
      draftsCreated: 0
    }
  };

  try {
    // Step 1: Extract job details
    const { company, location, position } = await extractJobDetailsEnhanced(
      jobDescription,
      aiProvider,
      apiKey,
      generateAIContent
    );

    if (company === 'N/A' || position === 'N/A') {
      throw new Error('Could not extract company or position from job description');
    }

    // Step 2: Get company domain
    const companyDomain = await getCompanyDomain(company, aiProvider, apiKey, generateAIContent);

    // Step 3: Search Google for ALL recruiters (10-15 results)
    const allRecruiters = await searchRecruitersOnGoogle(company, position, location);
    results.stats.searched = allRecruiters.length;

    if (allRecruiters.length === 0) {
      console.log('⚠️ No recruiters found in Google search');
      return results;
    }

    // Step 4: AI selects TOP 3 best-matched recruiters
    const top3Recruiters = await selectTop3Recruiters(
      allRecruiters,
      jobDescription,
      resumeContent,
      location,
      position,
      company,
      aiProvider,
      apiKey,
      generateAIContent
    );
    results.stats.aiSelected = top3Recruiters.length;

    console.log(`\n🎯 Processing ${top3Recruiters.length} AI-selected recruiter(s)...\n`);

    // Step 5: Process ONLY the top 3 selected recruiters
    for (const recruiter of top3Recruiters) {
      try {
        console.log(`\n👤 Processing: ${recruiter.linkedinUrl}`);

        // Use AI-extracted names (already cleaned by AI)
const firstName = recruiter.extractedFirstName;
const lastName = recruiter.extractedLastName;
const fullName = `${firstName} ${lastName}`;

console.log(`👤 Using AI-extracted name: ${firstName} ${lastName}`);

// Skip if AI couldn't extract valid names
if (firstName === 'Unknown' || lastName === 'Unknown') {
  console.log(`⚠️ Skipping - AI could not extract valid name from: ${recruiter.title}`);
  results.errors.push({
    linkedinUrl: recruiter.linkedinUrl,
    error: 'Could not extract valid name'
  });
  continue;
}

// Validate names (only letters, at least 2 chars each)
const firstNameClean = firstName.replace(/[^a-zA-Z]/g, '');
const lastNameClean = lastName.replace(/[^a-zA-Z]/g, '');

if (firstNameClean.length < 2 || lastNameClean.length < 2) {
  console.log(`⚠️ Skipping - Invalid name format: "${firstName}" "${lastName}"`);
  results.errors.push({
    name: fullName,
    linkedinUrl: recruiter.linkedinUrl,
    error: 'Invalid name format'
  });
  continue;
}

        // Find email with Hunter.io
const { email, confidence } = await findEmailWithHunter(
    firstNameClean,  // Already cleaned
    lastNameClean,   // Already cleaned
    companyDomain,
    hunterApiKey
  );

        if (!email) {
          console.log(`⚠️ Skipping ${fullName} - no email found`);
          results.errors.push({
            name: fullName,
            linkedinUrl: recruiter.linkedinUrl,
            error: 'Email not found'
          });
          continue;
        }

        results.stats.emailsFound++;

        // Generate personalized email
        const emailBody = await generatePersonalizedEmail(
          fullName,
          company,
          position,
          resumeContent,
          jobDescription,
          aiProvider,
          apiKey,
          generateAIContent
        );

        // Create subject line
        const subject = `Application for ${position} at ${company}`;

        // Create Gmail draft
        const draft = await createGmailDraft(
          gmail,
          email,
          subject,
          emailBody,
          resumeDocUrl
        );

        results.stats.draftsCreated++;

       // Save to database
let contactId;
try {
  const contactResult = await pool.query(
    `INSERT INTO contacts (full_name, email, linkedin_url, role, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE 
     SET full_name = EXCLUDED.full_name,
         linkedin_url = EXCLUDED.linkedin_url,
         role = EXCLUDED.role,
         notes = EXCLUDED.notes
     RETURNING id`,
    [
      fullName,
      email,
      recruiter.linkedinUrl,
      `Recruiter at ${company}`,
     `AI-selected by AI\nHunter.io confidence: ${confidence}%\nDraft ID: ${draft.id}`

    ]
  );

  contactId = contactResult.rows[0].id;

  // Link to application
  await pool.query(
    `INSERT INTO application_contacts (application_id, contact_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [applicationId, contactId]
  );

  console.log(`✅ Saved to database - Contact ID: ${contactId}`);

} catch (dbError) {
  console.error('⚠️ Database save failed:', dbError.message);
  // Continue anyway - we still have the draft
}

        results.recruiters.push({
          name: fullName,
          email,
          linkedinUrl: recruiter.linkedinUrl,
          company: company,
          domain: companyDomain,
          confidence,
          draftId: draft.id,
          rank: top3Recruiters.indexOf(recruiter) + 1,
          saved: true
        });

        console.log(`✅ Complete for ${fullName}`);
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        console.error(`❌ Error processing recruiter:`, error.message);
        results.errors.push({
          linkedinUrl: recruiter.linkedinUrl,
          error: error.message
        });
      }
    }

    console.log('\n✅ Recruiter automation complete!');
    console.log(`📊 Stats:`);
    console.log(`   - Google Search: ${results.stats.searched} recruiters found`);
    console.log(`   - AI Selected: ${results.stats.aiSelected} top matches`);
    console.log(`   - Emails Found: ${results.stats.emailsFound}`);
    console.log(`   - Drafts Created: ${results.stats.draftsCreated}`);

    return results;

  } catch (error) {
    console.error('❌ Recruiter automation failed:', error.message);
    throw error;
  }
}

// =====================================================
// EXPORTS
// =====================================================
module.exports = {
  findRecruitersAndSendEmails,
  extractJobDetailsEnhanced,
  getCompanyDomain,
  searchRecruitersOnGoogle,
  selectTop3Recruiters,
  findEmailWithHunter,
  generatePersonalizedEmail,
  createGmailDraft
};