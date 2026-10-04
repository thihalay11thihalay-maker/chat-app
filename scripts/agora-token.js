#!/usr/bin/env node

/**
 * Mints Agora RTC tokens for the call screen, so the app never holds a secret.
 *
 * Why this has to exist. The Agora SDK will not join a channel without a token, and a token is signed
 * with the project's App Certificate. A certificate inside the app bundle is a certificate anybody with
 * the bundle can read, which would let them mint tokens for any channel on the project and listen to
 * calls that are not theirs. So the certificate stays here, in a Node process, and the app asks for a
 * token over HTTP the way it will have to for the rest of its life.
 *
 *   1. Put AGORA_APP_CERTIFICATE in .env.local -- the App Certificate from the Agora console, NOT the
 *      App ID, and NOT prefixed with EXPO_PUBLIC_. Anything so prefixed ships inside the bundle.
 *   2. npm run call:tokens        leave this running, like the bot
 *   3. Set EXPO_PUBLIC_AGORA_TOKEN_SERVER to http://<your-lan-ip>:8787 and restart the dev server.
 *      It has to be the LAN address, not localhost: a phone resolves localhost to itself, not to this
 *      machine. The console prints the address to use.
 *
 * The certificate is read from .env.local by bot-env.js rather than from process.env, so the same file
 * the app reads is the single place the value lives.
 *
 * Who may ask for a token. This used to be "any device that can reach the port", which meant anything on
 * the network -- or any web page in a browser that could reach it, because the CORS header was a wildcard
 * -- could mint a six-hour publish/subscribe token for any channel whose name began with the prefix. For
 * a call this service is signing, that is the call itself.
 *
 * So there are three checks now, and they are what a production deployment would need too:
 *
 *   The caller sends its Firebase ID token, and it is verified here against the same project. That is what
 *   turns "somebody on the network" into "a signed-in account", and it is checked before anything is
 *   signed rather than after.
 *
 *   The uid is taken from the verified token, never from the query string. A caller asking to be somebody
 *   else is the whole reason the uid is not client-supplied.
 *
 *   CORS is an allowlist. The wildcard is what let a web page reach this at all, and it is only needed
 *   because the bundle is served from Metro on a different port, which is a known origin rather than an
 *   unknown one.
 *
 * The server also binds to the loopback interface by default. Exposing it on the LAN has to be asked for
 * with AGORA_TOKEN_SERVER_HOST, because a phone on the same wifi needs it and nothing else does.
 *
 * What this still is not: production. The check here is that the caller is signed in, not that the caller
 * belongs in the room -- the channel name is derived from a chat id and the room membership lives in
 * Firestore, which this process deliberately does not read. So a signed-in account can still get a token
 * for a call it is not in. Closing that is one more check -- read the room document, confirm the verified
 * uid is in `participants` -- and it is left out here because this process has no service account and a
 * development service should not need one.
 */

const crypto = require('crypto');
const http = require('http');
const os = require('os');

const { credential, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const { readProjectConfig } = require('./bot-env');

/** The port the token service listens on. */
const PORT = Number(process.env.AGORA_TOKEN_PORT || 8787);

/**
 * Which interface to bind.
 *
 * Loopback unless asked otherwise. A phone testing against this machine needs the LAN address, and that is
 * the one case that justifies exposing a signing service to a network -- so it has to be a deliberate
 * setting rather than the default, and it is why the address the console suggests depends on this value.
 */
const HOST = process.env.AGORA_TOKEN_SERVER_HOST || '127.0.0.1';

/**
 * Only channels this prefix are served.
 *
 * Every call channel in the app is named by callChannelName() in src/lib/agora-call.ts, which is what
 * makes this check possible: without it, this process would be an open token minter for every channel
 * anyone could name on this Agora project, which is a much larger thing to hand out than a token for
 * the room somebody is already in.
 */
const CHANNEL_PREFIX = 'channel_';

/**
 * How long a minted token is good for.
 *
 * Six hours. Long enough that a call started in the afternoon does not expire mid-conversation, short
 * enough that a leaked one is not useful for long. Agora's own ceiling is 24 hours.
 */
const TOKEN_TTL_SECONDS = 6 * 60 * 60;

/**
 * Refreshed this long before it actually expires.
 *
 * The call screen asks for a token when a call opens, not when it connects, so a token handed out at the
 * start of a call needs to survive the call.
 */
const EXPIRY_MARGIN_SECONDS = 60 * 60;

/** One token per channel, reused until it is close to expiring. */
const tokenCache = new Map();

/**
 * Signs the content block that makes an RTC token.
 *
 * The shape is Agora's: the app id as plain text, then the claims, then an HMAC-SHA256 of those claims
 * under the certificate, all base64url. The SDK parses all three back out, so none of the encoding here
 * is negotiable.
 */
function mintToken({ appCertificate, appId, channel, uid }) {
  const expireAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

  const claims = {
    appId,
    channelName: channel,
    expireTimestamp: expireAt,
    // Not a list of things to forbid but a list of things to allow, so a token minted for a voice call
    // cannot publish video. Both are on here because the same token serves both kinds of call and the
    // call screen asks for one without saying which it is for.
    privileges: {
      joinChannel: true,
      publishAudioStream: true,
      publishDataStream: true,
      publishVideoStream: true,
    },
    // The string form of the uid. "0" tells the SDK to assign one on join, which is what the call
    // screen asks for, so the two agree and the remote side finds the stream by the uid it is given.
    uid: String(uid),
  };

  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', appCertificate)
    .update(encoded)
    .digest('base64url');

  return {
    token: `${appId}${encoded}${signature}`,
    expiresAt: expireAt * 1000,
  };
}

/** A token for this channel, reused while the cached one is still comfortably valid. */
function tokenFor(config, channel, uid) {
  const cached = tokenCache.get(channel);

  if (cached && cached.expiresAt - EXPIRY_MARGIN_SECONDS * 1000 > Date.now()) {
    return cached;
  }

  const minted = mintToken({
    appCertificate: config.certificate,
    appId: config.appId,
    channel,
    uid,
  });

  tokenCache.set(channel, minted);

  return minted;
}

/**
 * The caller's LAN address, which is the address the phone has to be given.
 *
 * Enumerated rather than printed from a single guess, because a machine with a VPN or a virtual switch on
 * has more than one and only one of them is the network the phone is on.
 */
function lanAddresses() {
  const interfaces = os.networkInterfaces();
  const found = [];

  // The adapter's name is the key it is filed under rather than a field on the entry, so this iterates
  // entries rather than values. Getting this wrong prints "(undefined)" beside every address, which is
  // the one piece of information that tells a person which of their adapters the phone is on.
  Object.entries(interfaces).forEach(([name, entries]) => {
    (entries || []).forEach((entry) => {
      // IPv4 and not internal: loopback is the address the server is already on, and the phone cannot
      // use it. A vEthernet or docker interface is usually a dead end too, but it cannot be told apart
      // from a real one here, so all of them are printed and the right one is obvious by its name.
      if (entry.family === 'IPv4' && !entry.internal) {
        found.push({ address: entry.address, name });
      }
    });
  });

  return found;
}

/**
 * Sends a response, with CORS for the known development origins only.
 *
 * The origin list is explicit because the wildcard was the hole: `*` is what lets a page in somebody's
 * browser send a request to this service and read the reply, from any site at all. Metro and the Expo
 * dev tooling are the only origins that legitimately need it, and both are known ports.
 */
const ALLOWED_ORIGINS = new Set([
  'http://localhost:8081',
  'http://localhost:19000',
  'http://localhost:19006',
  'http://127.0.0.1:8081',
  'exp://127.0.0.1:8081',
]);

function allowedOrigin(request) {
  const origin = request.headers.origin;

  if (!origin) {
    // No Origin header: a native fetch, which is not a browser and is not subject to CORS. Allowed, and the
    // token check is what stands behind it.
    return null;
  }

  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function send(request, response, status, body) {
  const payload = JSON.stringify(body);
  const origin = allowedOrigin(request);
  const headers = {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Length': Buffer.byteLength(payload),
    'Content-Type': 'application/json',
  };

  // Echoed only when it is on the list, so an unknown origin gets the JSON body and no permission to read
  // it from a browser.
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  response.writeHead(status, headers);
  response.end(payload);
}

/**
 * Checks the Firebase ID token the app sends and returns the uid it belongs to.
 *
 * Returns null for anything it cannot positively verify -- missing, malformed, expired, signed by a
 * different project, or no Firebase configuration to verify against. There is no path through this that
 * returns a uid it has not checked, because the uid is only ever read off a verified token.
 */
async function authenticate(request) {
  const header = request.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  if (!match) {
    return null;
  }

  try {
    const decoded = await adminAuth.verifyIdToken(match[1]);

    return decoded.uid;
  } catch (error) {
    console.warn(`Refused a token request: ${error.code || error.message}`);

    return null;
  }
}

function main() {
  const env = readProjectConfig();
  const appId = env.EXPO_PUBLIC_AGORA_APP_ID || '';
  const certificate = env.AGORA_APP_CERTIFICATE || '';

  if (!appId) {
    console.error('Could not find EXPO_PUBLIC_AGORA_APP_ID in .env.local.');
    process.exitCode = 1;

    return;
  }

  if (!certificate) {
    console.error([
      'Could not find AGORA_APP_CERTIFICATE in .env.local, so no token can be signed.',
      '',
      '  It is the App Certificate from the Agora console (Project Management > App ID > App Certificate),',
      '  and it is a server secret: do not prefix it with EXPO_PUBLIC_, or it ships inside the app bundle.',
      '  Do not confuse it with the App ID, which the app already has.',
      '',
      '  The App ID already set:',
      `    ${appId}`,
    ].join('\n'));
    process.exitCode = 1;

    return;
  }

  const config = { appId, certificate };

  // Set up once so a request does not pay for it, and so a missing Firebase configuration fails here at
  // startup with a sentence rather than turning every request into a silent 401.
  initializeApp({ credential: credential.applicationDefault(), projectId: env.EXPO_PUBLIC_FIREBASE_PROJECT_ID });
  const adminAuth = getAuth();

  const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      send(request, response, 204, {});

      return;
    }

    const url = new URL(request.url || '/', `http://localhost:${PORT}`);

    if (url.pathname !== '/token') {
      send(request, response, 404, { error: 'Unknown path. This service only answers /token.' });

      return;
    }

    const channel = url.searchParams.get('channel') || '';

    if (!channel.startsWith(CHANNEL_PREFIX)) {
      send(request, response, 400, {
        error: `A channel token is only issued for channels named ${CHANNEL_PREFIX}...`,
      });

      return;
    }

    // Verified before anything is signed. The uid comes from the verified token and the query string's own
    // `uid` is ignored entirely, so a caller cannot ask to be somebody else.
    void authenticate(request).then((uid) => {
      if (!uid) {
        send(request, response, 401, {
          error: 'A valid Firebase ID token is required. Send it as `Authorization: Bearer <token>`.',
        });

        return;
      }

      try {
        const minted = tokenFor(config, channel, uid);

        console.log(`token for ${uid} on ${channel}, valid until ${new Date(minted.expiresAt).toISOString()}`);

        send(request, response, 200, {
          appId,
          channel,
          expiresAt: minted.expiresAt,
          token: minted.token,
          uid,
        });
      } catch (error) {
        send(request, response, 500, { error: 'Could not sign a token for that channel.' });
        console.error(error);
      }
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`\nAgora token service on port ${PORT}, signing for app id ${appId}.`);
    console.log('Leave this running while you use the app.\n');
    console.log('Requests must carry `Authorization: Bearer <Firebase ID token>`.\n');

    const onLan = HOST !== '127.0.0.1' && HOST !== 'localhost';

    if (!onLan) {
      console.log(`Bound to ${HOST}: only this machine can reach it.`);
      console.log(`  Set EXPO_PUBLIC_AGORA_TOKEN_SERVER=http://localhost:${PORT}`);
      console.log('  A phone cannot use that address -- on the phone, localhost is the phone.');
      console.log('  To test on a real device, restart with AGORA_TOKEN_SERVER_HOST=0.0.0.0 and use the LAN');
      console.log('  address below. That puts a token minter on your network, so do it only on a network you');
      console.log('  trust and stop the process when you are done.\n');

      return;
    }

    console.log(`Bound to ${HOST}: anything on this network can reach it.`);
    console.log('Put this in .env.local as EXPO_PUBLIC_AGORA_TOKEN_SERVER, then restart the dev server:\n');

    const addresses = lanAddresses();

    if (addresses.length === 0) {
      console.log(`  EXPO_PUBLIC_AGORA_TOKEN_SERVER=http://<this machine's LAN ip>:${PORT}`);
    }

    addresses.forEach((entry) => {
      console.log(`  EXPO_PUBLIC_AGORA_TOKEN_SERVER=http://${entry.address}:${PORT}    (${entry.name})`);
    });

    console.log('\nThe phone has to reach this over the network: localhost on the phone is the phone.\n');
  });
}

main();