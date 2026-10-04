#!/usr/bin/env node

/**
 * Checks that the call token service can sign a token Agora's SDK would accept.
 *
 * Run this after putting AGORA_APP_CERTIFICATE in .env.local, before blaming the app for a call that
 * will not connect:
 *
 *   npm run call:check
 *
 * It answers the two questions that are hard to tell apart from the outside. Is the certificate the right
 * secret, or is it the App ID pasted into the wrong field? And does the channel the app builds actually
 * get served, or is the service refusing it?
 *
 * The signature is verified the same way the SDK verifies it, which is the part worth proving: a token
 * that is merely well shaped is not a token that joins. It starts the service itself, so there is nothing
 * to have running first.
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const { readProjectConfig } = require('./bot-env');

const SERVICE = path.join(__dirname, 'agora-token.js');
const PORT = Number(process.env.AGORA_TOKEN_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;

/** The channel shape callChannelName() in src/lib/agora-call.ts produces, and a chat id that made one. */
const SAMPLE_CHANNEL = 'channel_X09gUoq0FxNZxYSVFbir';

function say(line) {
  process.stdout.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes a token apart the way the SDK does.
 *
 * The layout is the app id as plain text, the claims in base64url, then a 43 character base64url
 * HMAC-SHA256. The 43 is base64url of a 32 byte digest, so it is how much is left once the signature is
 * taken off the end.
 */
function verify(token, appId, certificate) {
  const claimsPart = token.slice(appId.length, token.length - 43);
  const signature = token.slice(token.length - 43);
  const expected = crypto.createHmac('sha256', certificate).update(claimsPart).digest('base64url');

  return {
    claims: JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8')),
    signatureVerifies: signature === expected,
    startsWithAppId: token.startsWith(appId),
  };
}

async function main() {
  const env = readProjectConfig();
  const appId = env.EXPO_PUBLIC_AGORA_APP_ID || '';
  const certificate = env.AGORA_APP_CERTIFICATE || '';

  if (!appId) {
    say('EXPO_PUBLIC_AGORA_APP_ID is not set in .env.local. There is no app to sign a token for.');

    return;
  }

  if (!certificate) {
    say('AGORA_APP_CERTIFICATE is not set in .env.local, so there is nothing to sign with.');
    say('It is the App Certificate from the Agora console, not the App ID, and not EXPO_PUBLIC_.');

    return;
  }

  say(`app id: ${appId}`);
  say('starting the token service...\n');

  const service = spawn(process.execPath, [SERVICE], { cwd: __dirname, stdio: 'ignore' });

  // Given a moment to bind before it is asked anything.
  await sleep(1500);

  try {
    const response = await fetch(`${BASE}/token?channel=${SAMPLE_CHANNEL}&uid=0`);

    if (!response.ok) {
      say(`FAIL: the service answered ${response.status} ${await response.text()}`);

      return;
    }

    const body = await response.json();
    const check = verify(body.token, appId, certificate);

    say(`token length: ${body.token.length}`);
    say(`claims: ${JSON.stringify(check.claims)}`);
    say('');
    say(`app id prefix correct: ${check.startsWithAppId}`);
    say(`signature verifies:    ${check.signatureVerifies}`);
    say(`channel matches:       ${check.claims.channelName === SAMPLE_CHANNEL}`);
    say(`can join:              ${check.claims.privileges?.joinChannel === true}`);

    // The guard, because a token service that will sign any channel name is a much larger thing to leave
    // running than one that signs this app's rooms.
    const refused = await fetch(`${BASE}/token?channel=someone-elses-room&uid=0`);

    say(`refuses other channels: ${refused.status === 400}`);

    const passed = check.startsWithAppId
      && check.signatureVerifies
      && check.claims.channelName === SAMPLE_CHANNEL
      && refused.status === 400;

    say(`\n${passed ? 'PASS' : 'FAIL'}`);

    if (!passed) {
      say('\nIf the signature does not verify, AGORA_APP_CERTIFICATE is the wrong value -- the App ID is');
      say('the most common mistake, since the two sit next to each other in the console.');
    }
  } finally {
    service.kill();
  }
}

main().catch((error) => {
  say(`FAIL: ${error.message}`);
  process.exitCode = 1;
});