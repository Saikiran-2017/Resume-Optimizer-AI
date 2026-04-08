require('dotenv').config();
const { Pool } = require('pg');
const { google } = require('googleapis');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

console.log('\n' + '='.repeat(70));
console.log('🔍 COMPREHENSIVE API & CREDENTIALS VERIFICATION');
console.log('='.repeat(70) + '\n');

// =====================================================
// 1. CHECK ENVIRONMENT VARIABLES
// =====================================================
console.log('📋 STEP 1: Checking Environment Variables');
console.log('-'.repeat(70));

const requiredEnv = [
  'DATABASE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  'FRONTEND_RESUME_DOC_ID',
  'FULLSTACK_RESUME_DOC_ID',
  'DRIVE_FOLDER_ID',
  'SAI_RESUME_TEMPLATE_ID'
];

const missing = [];
requiredEnv.forEach(key => {
  const value = process.env[key];
  if (value) {
    const display = value.length > 50 
      ? value.substring(0, 20) + '...' + value.substring(value.length - 10)
      : value;
    console.log(`✅ ${key}: ${display}`);
  } else {
    console.log(`❌ ${key}: MISSING`);
    missing.push(key);
  }
});

if (missing.length > 0) {
  console.log(`\n⚠️  Missing ${missing.length} environment variables!`);
}

// =====================================================
// 2. TEST POSTGRESQL CONNECTION
// =====================================================
console.log('\n📋 STEP 2: Testing PostgreSQL Connection');
console.log('-'.repeat(70));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.log('❌ PostgreSQL Connection Failed:', err.message);
  } else {
    console.log('✅ PostgreSQL Connection Successful');
    console.log(`   Current Time: ${res.rows[0].now}`);
  }
});

// =====================================================
// 3. TEST GOOGLE OAUTH2 - DOCS/DRIVE/SHEETS
// =====================================================
console.log('\n📋 STEP 3: Testing Google OAuth2 (Docs/Drive/Sheets)');
console.log('-'.repeat(70));

async function testGoogleAPIs() {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:3000/oauth2callback'
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });

    console.log('✅ Google OAuth2 Client Initialized');

    // Test getting access token
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      console.log('✅ Access Token Refreshed Successfully');
      console.log(`   Token: ${credentials.access_token.substring(0, 20)}...`);
    } catch (err) {
      console.log('❌ Failed to Refresh Access Token:', err.message);
      return;
    }

    // Initialize API clients
    const docs = google.docs({ version: 'v1', auth: oauth2Client });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    console.log('✅ Google API Clients Initialized (Docs, Drive, Sheets)');

    // Test Drive - get file info
    try {
      console.log('\n   Testing Drive API...');
      const FRONTEND_RESUME_DOC_ID = process.env.FRONTEND_RESUME_DOC_ID;
      const fileRes = await drive.files.get({
        fileId: FRONTEND_RESUME_DOC_ID,
        fields: 'name, mimeType, owners'
      });
      console.log(`   ✅ Drive API Works - Found: ${fileRes.data.name}`);
      console.log(`      MIME Type: ${fileRes.data.mimeType}`);
      console.log(`      Owner: ${fileRes.data.owners[0]?.displayName}`);
    } catch (err) {
      console.log(`   ❌ Drive API Error: ${err.message}`);
    }

    // Test Docs - get document
    try {
      console.log('\n   Testing Docs API...');
      const FRONTEND_RESUME_DOC_ID = process.env.FRONTEND_RESUME_DOC_ID;
      const docRes = await docs.documents.get({
        documentId: FRONTEND_RESUME_DOC_ID
      });
      console.log(`   ✅ Docs API Works - Found: ${docRes.data.title}`);
      console.log(`      Body content length: ${docRes.data.body.content.length} elements`);
    } catch (err) {
      console.log(`   ❌ Docs API Error: ${err.message}`);
    }

    // Test Sheets - read values
    try {
      console.log('\n   Testing Sheets API...');
      // Using a test sheet ID - you can replace this
      const TRACKING_SHEET = process.env.TRACKING_SHEET_ID || 'test-sheet-id';
      if (TRACKING_SHEET !== 'test-sheet-id') {
        const sheetsRes = await sheets.spreadsheets.values.get({
          spreadsheetId: TRACKING_SHEET,
          range: 'Sheet1!A1:A1'
        });
        console.log(`   ✅ Sheets API Works`);
        console.log(`      Values: ${JSON.stringify(sheetsRes.data.values)}`);
      } else {
        console.log(`   ⚠️  TRACKING_SHEET_ID not set - skipping Sheets test`);
      }
    } catch (err) {
      console.log(`   ⚠️  Sheets API Error: ${err.message} (might be expected if TRACKING_SHEET_ID not set)`);
    }

  } catch (error) {
    console.log('❌ Google OAuth2 Error:', error.message);
  }
}

// =====================================================
// 4. TEST GMAIL OAUTH2
// =====================================================
async function testGmailAPI() {
  console.log('\n📋 STEP 4: Testing Gmail OAuth2');
  console.log('-'.repeat(70));

  try {
    const gmailOAuth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      'http://localhost:3000/oauth2callback-gmail'
    );

    gmailOAuth2Client.setCredentials({
      refresh_token: process.env.GMAIL_REFRESH_TOKEN
    });

    console.log('✅ Gmail OAuth2 Client Initialized');

    // Test getting access token
    try {
      const { credentials } = await gmailOAuth2Client.refreshAccessToken();
      console.log('✅ Gmail Access Token Refreshed Successfully');
      console.log(`   Token: ${credentials.access_token.substring(0, 20)}...`);
    } catch (err) {
      console.log('❌ Failed to Refresh Gmail Token:', err.message);
      return;
    }

    // Initialize Gmail client
    const gmail = google.gmail({ version: 'v1', auth: gmailOAuth2Client });
    console.log('✅ Gmail API Client Initialized');

    // Test Gmail - get profile
    try {
      console.log('\n   Testing Gmail API...');
      const profileRes = await gmail.users.getProfile({
        userId: 'me'
      });
      console.log(`   ✅ Gmail API Works - Email: ${profileRes.data.emailAddress}`);
      console.log(`      Total Messages: ${profileRes.data.messagesTotal}`);
      console.log(`      Total Threads: ${profileRes.data.threadsTotal}`);
    } catch (err) {
      console.log(`   ❌ Gmail API Error: ${err.message}`);
    }

  } catch (error) {
    console.log('❌ Gmail OAuth2 Error:', error.message);
  }
}

// =====================================================
// 5. TEST GEMINI API (if available)
// =====================================================
async function testGeminiAPI() {
  console.log('\n📋 STEP 5: Testing Gemini API');
  console.log('-'.repeat(70));

  // Check if Gemini key is available from environment or extension storage
  const geminiKey = process.env.GEMINI_API_KEY;
  
  if (!geminiKey) {
    console.log('⚠️  GEMINI_API_KEY not set in .env');
    console.log('   Note: Gemini keys should be stored in Chrome extension storage');
    console.log('   The extension user must provide Gemini API key in settings');
    return;
  }

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    console.log('✅ Gemini API Client Initialized');

    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    console.log('✅ Gemini Model (gemini-2.0-flash) Selected');

    // Test Gemini with a simple prompt
    try {
      console.log('\n   Testing Gemini API with simple prompt...');
      const result = await model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Say "Gemini API is working" in exactly 5 words.' }]
          }
        ]
      });

      if (result.response.text()) {
        console.log('   ✅ Gemini API Works');
        console.log(`      Response: "${result.response.text()}"`);
      }
    } catch (err) {
      console.log(`   ❌ Gemini API Error: ${err.message}`);
    }

  } catch (error) {
    console.log('❌ Gemini API Error:', error.message);
  }
}

// =====================================================
// 6. TEST CHATGPT API (if available)
// =====================================================
async function testChatGPTAPI() {
  console.log('\n📋 STEP 6: Testing ChatGPT API');
  console.log('-'.repeat(70));

  const chatgptKey = process.env.CHATGPT_API_KEY;
  
  if (!chatgptKey) {
    console.log('⚠️  CHATGPT_API_KEY not set in .env');
    console.log('   Note: ChatGPT keys should be stored in Chrome extension storage');
    console.log('   The extension user must provide ChatGPT API key in settings');
    return;
  }

  try {
    console.log('✅ ChatGPT API Key Found');

    // Test ChatGPT with a simple request
    try {
      console.log('\n   Testing ChatGPT API with simple prompt...');
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            { role: 'user', content: 'Say "ChatGPT API is working" in exactly 5 words.' }
          ],
          max_tokens: 50
        },
        {
          headers: {
            'Authorization': `Bearer ${chatgptKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.choices[0].message.content) {
        console.log('   ✅ ChatGPT API Works');
        console.log(`      Response: "${response.data.choices[0].message.content}"`);
      }
    } catch (err) {
      console.log(`   ❌ ChatGPT API Error: ${err.response?.data?.error?.message || err.message}`);
    }

  } catch (error) {
    console.log('❌ ChatGPT API Setup Error:', error.message);
  }
}

// =====================================================
// 7. RUN ALL ASYNC TESTS
// =====================================================
(async () => {
  await testGoogleAPIs();
  await testGmailAPI();
  await testGeminiAPI();
  await testChatGPTAPI();

  console.log('\n' + '='.repeat(70));
  console.log('✅ VERIFICATION COMPLETE');
  console.log('='.repeat(70) + '\n');

  // Close pool
  setTimeout(() => {
    pool.end();
    process.exit(0);
  }, 2000);
})();
