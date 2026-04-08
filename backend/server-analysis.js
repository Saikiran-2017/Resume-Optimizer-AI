const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = 3001; // Different port for analysis

// Middleware
app.use(cors());
app.use(express.json());

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

// Configuration
// Fallback keeps analysis working even if ORIGINAL_RESUME_DOC_ID is not explicitly set.
const ORIGINAL_RESUME_DOC_ID = process.env.ORIGINAL_RESUME_DOC_ID || process.env.FULLSTACK_RESUME_DOC_ID || process.env.FRONTEND_RESUME_DOC_ID;

// AI Provider wrapper
async function generateAIContent(prompt, provider, apiKey) {
    if (provider === 'gemini') {
        return await generateWithGemini(prompt, apiKey);
    } else if (provider === 'chatgpt') {
        return await generateWithChatGPT(prompt, apiKey);
    } else {
        throw new Error('Invalid AI provider');
    }
}

// Gemini AI implementation
async function generateWithGemini(prompt, apiKey) {
    try {
        console.log('🔑 Using Gemini for analysis...');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: 'gemini-2.0-flash',
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192
            }
        });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('❌ Gemini Error:', error.message);
        throw new Error(`Gemini API Error: ${error.message}`);
    }
}

// ChatGPT implementation
async function generateWithChatGPT(prompt, apiKey) {
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 4000
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        throw new Error(`ChatGPT API Error: ${error.response?.data?.error?.message || error.message}`);
    }
}

// Web search function (simulated - replace with actual search API)
async function searchWeb(query) {
    try {
        // TODO: Integrate with Google Search API or Bing Search API
        // For now, return mock data
        console.log('🔍 Searching:', query);
        return {
            query: query,
            results: [
                { title: 'Sample result', snippet: 'Mock data for ' + query }
            ]
        };
    } catch (error) {
        console.error('Search error:', error);
        return { query: query, results: [] };
    }
}

// Extract text from Google Doc
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

// Main Analysis Endpoint
app.post('/api/analyze-resume', async (req, res) => {
    try {
        const {
            jobUrl,
            currentPageUrl,
            aiProvider,
            geminiKey1,      // For Score 1 & extraction
            geminiKey2,      // For Score 2
            geminiKey3,      // For Score 3 & 4
            chatgptApiKey,
            chatgptKey2,
            chatgptKey3,
            manualJobDescription
        } = req.body;

        console.log('\n📊 RESUME ANALYSIS STARTED');
        console.log('═'.repeat(60));

        // Validate inputs
        if (!manualJobDescription && !jobUrl) {
            return res.status(400).json({
                error: 'Job description or URL required'
            });
        }

        // Select API keys for different operations (avoid rate limits)
        const extractionKey = aiProvider === 'gemini' ? geminiKey1 : chatgptApiKey;
        const score1Key = aiProvider === 'gemini' ? geminiKey1 : chatgptApiKey;
        const score2Key = aiProvider === 'gemini' ? geminiKey2 : (chatgptKey2 || chatgptApiKey);
        const score3Key = aiProvider === 'gemini' ? geminiKey3 : (chatgptKey3 || chatgptApiKey);
        const score4Key = aiProvider === 'gemini' ? geminiKey3 : chatgptApiKey; // Reuse key3

        // Validate we have at least one key
        if (!extractionKey) {
            return res.status(400).json({ error: 'API key required' });
        }

        let jobDescription = manualJobDescription || '';

        // If URL provided, fetch JD
        if (jobUrl && !manualJobDescription) {
            console.log('🌐 Fetching job description from URL...');
            try {
                const jobResponse = await axios.get(jobUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 30000
                });

                const extractPrompt = `Extract only the job description from this HTML:

${jobResponse.data}

Return only the job description text.`;

                jobDescription = await generateAIContent(extractPrompt, aiProvider, extractionKey);
                console.log('✅ JD extracted');
            } catch (error) {
                console.log('⚠️ URL fetch failed, using manual JD if provided');
            }
        }

        if (!jobDescription) {
            return res.status(400).json({ error: 'Could not get job description' });
        }

        // Fetch resume from Google Docs
        console.log('📄 Fetching resume from Google Docs...');
        const resumeDoc = await docs.documents.get({
            documentId: ORIGINAL_RESUME_DOC_ID
        });
        const resume = extractTextFromDoc(resumeDoc.data);
        console.log('✅ Resume fetched');

        // SCORE 1: Resume-JD Match Score
        console.log('\n📊 Calculating Score 1: Resume-JD Match...');
        const score1Prompt = `Analyze how well this resume matches the job description.

RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

Provide analysis in this EXACT format:

SCORE: [number 0-100]

KEYWORD MATCH: [0-100]
- Matched keywords: [list]
- Missing keywords: [list]

SKILLS MATCH: [0-100]
- Matched skills: [list]
- Missing skills: [list]

EXPERIENCE MATCH: [0-100]
- Matched experience: [description]
- Gaps: [description]

OVERALL BREAKDOWN:
[Detailed explanation of the score]`;

        const score1Response = await generateAIContent(score1Prompt, aiProvider, score1Key);
        const score1 = parseInt(score1Response.match(/SCORE:\s*(\d+)/)?.[1] || '0');
        console.log(`✅ Resume-JD Match: ${score1}%`);

        // SCORE 2: Experience-Role Fit Score
        console.log('\n📊 Calculating Score 2: Experience-Role Fit...');
        const score2Prompt = `Analyze how well the candidate's experience fits the role requirements.

RESUME:
${resume}

JOB DESCRIPTION (Focus on responsibilities and requirements):
${jobDescription}

Provide analysis in this EXACT format:

SCORE: [number 0-100]

YEARS OF EXPERIENCE: [0-100]
- Required: [X years]
- Candidate has: [Y years]
- Match level: [description]

TECHNOLOGY STACK: [0-100]
- Required technologies: [list]
- Candidate's technologies: [list]
- Match: [description]

DOMAIN EXPERIENCE: [0-100]
- Required domain: [domain]
- Candidate's domain experience: [description]
- Match: [description]

RESPONSIBILITIES MATCH: [0-100]
- JD responsibilities: [list top 5]
- Candidate's experience with these: [description]

OVERALL BREAKDOWN:
[Detailed explanation of how well experience fits the role]`;

        const score2Response = await generateAIContent(score2Prompt, aiProvider, score2Key);
        const score2 = parseInt(score2Response.match(/SCORE:\s*(\d+)/)?.[1] || '0');
        console.log(`✅ Experience-Role Fit: ${score2}%`);

        // SCORE 3: Post-Optimization Potential Score
        console.log('\n📊 Calculating Score 3: Post-Optimization Potential...');
        const score3Prompt = `Based on the resume and job description, calculate the potential ATS score AFTER optimization.

CURRENT RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

CURRENT MATCH SCORE: ${score1}%

Analyze what improvements can be made and provide:

SCORE: [number 0-100] (potential score after optimization)

POTENTIAL IMPROVEMENTS:
- Keyword additions: [list keywords that can be added]
- Skills enhancements: [list skills to emphasize]
- Experience highlighting: [what to highlight better]
- Format improvements: [what format changes needed]

ESTIMATED IMPACT:
- Keyword additions: +[X]%
- Skills enhancements: +[Y]%
- Experience highlighting: +[Z]%

OVERALL BREAKDOWN:
[Explain the potential after optimization]`;

        const score3Response = await generateAIContent(score3Prompt, aiProvider, score3Key);
        const score3 = parseInt(score3Response.match(/SCORE:\s*(\d+)/)?.[1] || '0');
        console.log(`✅ Post-Optimization Potential: ${score3}%`);

        // Extract company name for Score 4
        console.log('\n🔍 Extracting company name...');
        const companyPrompt = `Extract ONLY the company name from this job description:

${jobDescription.substring(0, 1000)}

Return ONLY the company name, nothing else.`;

        const companyName = (await generateAIContent(companyPrompt, aiProvider, extractionKey)).trim();
        console.log(`✅ Company: ${companyName}`);

        // SCORE 4: Selection Probability Score
        console.log('\n📊 Calculating Score 4: Selection Probability...');

        // Search for company information
        console.log('🔍 Searching for company information...');
        const companySearch = await searchWeb(`${companyName} recent hiring trends news 2024`);
        const growthSearch = await searchWeb(`${companyName} company growth expansion 2024`);
        const hiringSearch = await searchWeb(`${companyName} new hires job openings 2024`);

        const score4Prompt = `Calculate the probability of selection for this candidate.

CANDIDATE RESUME:
${resume}

JOB DESCRIPTION:
${jobDescription}

COMPANY: ${companyName}

COMPANY INFORMATION (from web search):
${JSON.stringify(companySearch.results)}
${JSON.stringify(growthSearch.results)}
${JSON.stringify(hiringSearch.results)}

CURRENT SCORES:
- Resume-JD Match: ${score1}%
- Experience-Role Fit: ${score2}%
- Post-Optimization Potential: ${score3}%

Provide analysis in this EXACT format:

SCORE: [number 0-100]

COMPANY HIRING ACTIVITY: [0-100]
- Recent hiring trends: [description]
- Growth indicators: [description]
- Job openings: [description]

CANDIDATE STRENGTH: [0-100]
- Resume quality: [description]
- Experience relevance: [description]
- Skill match: [description]

MARKET DEMAND: [0-100]
- Industry trends: [description]
- Role demand: [description]

COMPETITION LEVEL: [0-100]
- Estimated competition: [High/Medium/Low]
- Reasoning: [description]

OVERALL BREAKDOWN:
[Detailed explanation of selection probability considering all factors]`;

        const score4Response = await generateAIContent(score4Prompt, aiProvider, score4Key);
        const score4 = parseInt(score4Response.match(/SCORE:\s*(\d+)/)?.[1] || '0');
        console.log(`✅ Selection Probability: ${score4}%`);

        console.log('\n═'.repeat(60));
        console.log('📊 ANALYSIS COMPLETE');
        console.log('═'.repeat(60));

        // Return results
        res.json({
            success: true,
            companyName: companyName,
            scores: {
                resumeJDMatch: score1,
                experienceRoleFit: score2,
                postOptimizationPotential: score3,
                selectionProbability: score4
            },
            detailedReports: {
                resumeJDMatch: score1Response,
                experienceRoleFit: score2Response,
                postOptimizationPotential: score3Response,
                selectionProbability: score4Response
            },
            summary: generateSummary(score1, score2, score3, score4)
        });

    } catch (error) {
        console.error('❌ Analysis Error:', error.message);
        res.status(500).json({
            error: 'Analysis failed',
            details: error.message
        });
    }
});

// Generate summary based on scores
function generateSummary(score1, score2, score3, score4) {
    const avgScore = Math.round((score1 + score2 + score3 + score4) / 4);

    let recommendation = '';
    if (avgScore >= 80) {
        recommendation = 'Excellent match! Strong chances of selection. Consider optimizing to push above 90%.';
    } else if (avgScore >= 60) {
        recommendation = 'Good match with room for improvement. Optimization highly recommended to increase chances.';
    } else if (avgScore >= 40) {
        recommendation = 'Moderate match. Significant optimization needed. Consider targeting roles that better match your profile.';
    } else {
        recommendation = 'Low match. This role may not be ideal. Consider upskilling or targeting different roles.';
    }

    return {
        averageScore: avgScore,
        recommendation: recommendation,
        strengths: getStrengths(score1, score2, score3, score4),
        improvements: getImprovements(score1, score2, score3, score4)
    };
}

function getStrengths(score1, score2, score3, score4) {
    const strengths = [];
    if (score1 >= 70) strengths.push('Strong resume-JD keyword alignment');
    if (score2 >= 70) strengths.push('Experience matches role requirements well');
    if (score3 >= 85) strengths.push('High optimization potential');
    if (score4 >= 60) strengths.push('Favorable hiring conditions');
    return strengths.length > 0 ? strengths : ['Baseline qualifications met'];
}

function getImprovements(score1, score2, score3, score4) {
    const improvements = [];
    if (score1 < 70) improvements.push('Add more JD keywords to resume');
    if (score2 < 70) improvements.push('Highlight relevant experience better');
    if (score3 < 85) improvements.push('Consider professional resume optimization');
    if (score4 < 60) improvements.push('Research company and tailor application');
    return improvements;
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'Analysis Server Running',
        port: PORT,
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log('\n📊 Resume Analysis Server Running!');
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`✅ Health: http://localhost:${PORT}/health`);
    console.log(`🔍 Analysis: POST /api/analyze-resume`);
    console.log(`🎯 Features: 4-Score Analysis System\n`);
});