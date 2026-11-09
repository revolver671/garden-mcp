/**
 * Withings OAuth 2.0 Token Setup Script
 * ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 * Run this ONCE on the Dell to get your initial access + refresh tokens.
 * 
 * Usage:
 *   cd cloud_worker
 *   node scripts/withings-oauth-setup.mjs
 * 
 * It will:
 *   1. Open your browser to Withings authorization page
 *   2. You log in and consent
 *   3. Withings redirects to localhost:8080
 *   4. Script exchanges auth code for tokens
 *   5. Prints the tokens for you to set as Wrangler secrets
 */

import http from 'http';
import { exec } from 'child_process';
import https from 'https';
import { URL, URLSearchParams } from 'url';

// ============================================================================
// YOUR CREDENTIALS — update these
// ============================================================================

const CLIENT_ID = '8f8c009fcf056f159803994a8bac84688f96565125faf247f1275003b515b77d';
// Set via environment variable, or paste directly here (delete after getting tokens!)
// PowerShell:  $env:WITHINGS_CLIENT_SECRET = "your_secret"; node scripts/withings-oauth-setup.mjs
// CMD:         set WITHINGS_CLIENT_SECRET=your_secret && node scripts/withings-oauth-setup.mjs
const CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET || 'PASTE_YOUR_SECRET_HERE';
const REDIRECT_URI = 'http://localhost:8080';
const SCOPES = 'user.info,user.metrics,user.activity';

// ============================================================================
// OAuth URLs
// ============================================================================

const AUTH_URL = 'https://account.withings.com/oauth2_user/authorize2';
const TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2';

// ============================================================================
// Main
// ============================================================================

console.log('\n🌿 Withings OAuth 2.0 Setup for The Garden\n');

if (CLIENT_SECRET === 'PASTE_YOUR_SECRET_HERE') {
  console.log('⚠️  Set your client secret first:');
  console.log('   WITHINGS_CLIENT_SECRET=your_secret node scripts/withings-oauth-setup.mjs');
  console.log('   Or edit the CLIENT_SECRET variable in this file.\n');
  process.exit(1);
}

// Build authorization URL
const state = Math.random().toString(36).substring(2, 15);
const authParams = new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  state: state,
  scope: SCOPES,
  redirect_uri: REDIRECT_URI,
});
const authUrl = `${AUTH_URL}?${authParams.toString()}`;

// Start local server to catch the redirect
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:8080`);
  
  if (url.pathname === '/') {
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Error: No authorization code received</h1>');
      return;
    }
    
    if (returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Error: State mismatch</h1>');
      return;
    }
    
    console.log('✅ Authorization code received! Exchanging for tokens...\n');
    
    // Exchange code for tokens
    try {
      const tokens = await exchangeCode(code);
      
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><body style="font-family: system-ui; padding: 40px; background: #1a1a2e; color: #e0e0e0;">
          <h1 style="color: #4ade80;">🌿 Success!</h1>
          <p>Tokens received. Check your terminal for the Wrangler commands.</p>
          <p>You can close this tab.</p>
        </body></html>
      `);
      
      console.log('═══════════════════════════════════════════════════════');
      console.log('🔑 TOKENS RECEIVED — Set these as Wrangler secrets:');
      console.log('═══════════════════════════════════════════════════════\n');
      console.log('Run these commands in your cloud_worker directory:\n');
      console.log(`echo "${tokens.access_token}" | npx wrangler secret put WITHINGS_ACCESS_TOKEN`);
      console.log(`echo "${tokens.refresh_token}" | npx wrangler secret put WITHINGS_REFRESH_TOKEN`);
      console.log(`\nAccess token expires in: ${tokens.expires_in} seconds (${Math.round(tokens.expires_in / 3600)} hours)`);
      console.log(`User ID: ${tokens.userid}`);
      console.log('\n═══════════════════════════════════════════════════════\n');
      
      // Also save to a local file for reference (delete after setting secrets!)
      const tokenData = JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        userid: tokens.userid,
        created_at: new Date().toISOString(),
        note: 'DELETE THIS FILE after setting Wrangler secrets!'
      }, null, 2);
      
      const fs = await import('fs');
      fs.writeFileSync('withings-tokens.json', tokenData);
      console.log('💾 Also saved to withings-tokens.json (DELETE after setting secrets!)\n');
      
      // Close server after a moment
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 2000);
      
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error exchanging token</h1><pre>${err.message}</pre>`);
      console.error('❌ Token exchange failed:', err.message);
    }
  }
});

server.listen(8080, () => {
  console.log('🔗 Opening Withings authorization page...\n');
  console.log(`   If your browser doesn't open, visit:\n   ${authUrl}\n`);
  
  // Open browser (Windows)
  exec(`start "" "${authUrl}"`);
});

// ============================================================================
// Token exchange
// ============================================================================

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
    }).toString();
    
    const options = {
      hostname: 'wbsapi.withings.net',
      path: '/v2/oauth2',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status !== 0) {
            reject(new Error(`Withings API error: status ${parsed.status} — ${JSON.stringify(parsed)}`));
            return;
          }
          resolve(parsed.body);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}
