#!/usr/bin/env node

/**
 * Creates the test bot account: a real Firebase Auth user with a profile that makes it appear in
 * Find Friends, so a conversation can be started with it from the app like with any other person.
 *
 * Why a real account rather than mock data: the security rules are the point of the test. A mock row
 * has no uid, is in no chat's `participants`, cannot send a message the rules would allow, and never
 * shows up as online. The bot is the only kind of test double that exercises the same code paths a
 * person does.
 *
 * Run once, then sign in as the bot on a second device or emulator:
 *
 *   npm run seed:bot
 *   npm run seed:bot -- --name "Nwe Lay" --email bot@example.com --password secret123
 *   npm run seed:bot -- --lat 16.8661 --lng 96.1951 --age 27
 *
 * The location decides whether Find Friends finds it at all: that screen queries a 50 km geohash
 * box, so a bot seeded on the other side of the planet is invisible no matter how correct its
 * profile is. Defaults to central Yangon.
 *
 * Plain REST rather than the Firebase SDK: the SDK's Auth module expects a browser, and this runs in
 * plain Node. The endpoints used are the same ones the app itself calls.
 */

const { readArguments, readBotCredentials, readProjectConfig } = require('./bot-env');

const DEFAULT_NAME = 'Test Bot';
const DEFAULT_AGE = 27;
// Central Yangon. Override with --lat/--lng if the tester is somewhere else.
const DEFAULT_LAT = 16.8661;
const DEFAULT_LNG = 96.1951;
const AVATAR = 'https://i.pravatar.cc/150?img=47';

async function readError(response) {
  let detail = '';

  try {
    detail = await response.text();
  } catch (error) {
    detail = `(no body: ${error.message})`;
  }

  return `${response.status} ${response.statusText} ${detail}`.trim();
}

/**
 * Creates the bot account, or signs in when it is already there.
 *
 * Creates first rather than signing in first on purpose. A sign-in against an address that has no
 * account comes back as `INVALID_LOGIN_CREDENTIALS` rather than saying so, so a script that tried to
 * sign in first could not tell "no such bot yet" from "wrong password" without guessing. Signing up
 * answers both cases plainly: it succeeds when the account is new and says `EMAIL_EXISTS` when it is
 * not.
 */
async function createOrSignInBot(apiKey, email, password) {
  const key = encodeURIComponent(apiKey);
  const credentials = JSON.stringify({ email, password, returnSecureToken: true });
  const signUp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`, {
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    body: credentials,
  });

  if (signUp.ok) {
    return { created: true, session: await signUp.json() };
  }

  const signUpError = await signUp.text();

  if (!signUpError.includes('EMAIL_EXISTS')) {
    throw new Error(`Could not create the bot account: ${signUpError}`);
  }

  const signIn = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
    { headers: { 'Content-Type': 'application/json' }, method: 'POST', body: credentials },
  );

  if (!signIn.ok) {
    throw new Error(`The bot account exists but could not sign in: ${await readError(signIn)}`);
  }

  return { created: false, session: await signIn.json() };
}

/**
 * Writes the profile the app reads.
 *
 * `age` rather than a birth date because `getAge` in user-data.ts reads a number, and the Find
 * Friends age filter drops anybody whose age it cannot work out. `geohash` plus the coordinates
 * because that screen queries by geohash and then filters on the real distance.
 *
 * An update mask rather than a plain document write, so a field somebody added by hand on this
 * profile is not wiped out by re-running the script.
 */
async function writeProfile(projectId, idToken, uid, profile) {
  const fields = Object.entries(profile).map(([key, value]) => {
    if (typeof value === 'boolean') {
      return [key, { booleanValue: value }];
    }

    if (typeof value === 'number') {
      return [key, { doubleValue: value }];
    }

    return [key, { stringValue: String(value) }];
  });

  const mask = Object.keys(profile)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join('&');

  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}?${mask}`,
    {
      body: JSON.stringify({ fields: Object.fromEntries(fields) }),
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      method: 'PATCH',
    },
  );

  if (!response.ok) {
    throw new Error(`Could not write the bot profile: ${await readError(response)}`);
  }
}

async function main() {
  const env = readProjectConfig();
  const options = readArguments(process.argv.slice(2));

  const apiKey = options.apikey || env.EXPO_PUBLIC_FIREBASE_API_KEY;
  const projectId = options.project || env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;

  if (!apiKey || !projectId) {
    console.error(
      'Could not find the Firebase api key or project id. Run this from the project folder, or add a .env.local, or pass --apikey and --project.',
    );
    process.exitCode = 1;
    return;
  }

  const credentials = readBotCredentials(options, env);
  const email = credentials.email;
  const password = credentials.password;
  const displayName = options.name || DEFAULT_NAME;
  const age = Number(options.age || DEFAULT_AGE);
  const latitude = Number(options.lat || DEFAULT_LAT);
  const longitude = Number(options.lng || DEFAULT_LNG);

  let geohash = '';

  try {
    // The same encoder Find Friends uses, so the bot lands inside the same geohash box a query from
    // the tester's own location would produce. It returns the hash itself, not an object.
    geohash = require('geofire-common').geohashForLocation([latitude, longitude]);
  } catch (error) {
    console.error('Could not compute a geohash, so the bot would be invisible to Find Friends:', error.message);
    process.exitCode = 1;
    return;
  }

  if (typeof geohash !== 'string' || !geohash) {
    console.error('geofire-common returned no geohash, so the bot would be invisible to Find Friends.');
    process.exitCode = 1;
    return;
  }

  const { created, session } = await createOrSignInBot(apiKey, email, password);

  await writeProfile(projectId, session.idToken, session.localId, {
    age,
    city: 'Yangon',
    displayName,
    geohash,
    isBot: true,
    latitude,
    longitude,
    locationUpdatedAt: new Date().toISOString(),
    profilePictureUrl: AVATAR,
  });

  console.log(`\n${created ? 'Created' : 'Signed in as'} the bot ${displayName} <${email}>`);
  console.log(`  uid          ${session.localId}`);
  console.log(`  location     ${latitude}, ${longitude} (geohash ${geohash})`);
  console.log(`  age          ${age}`);
  console.log('\nNext:');
  console.log('  1. Sign in as this account on a second device or emulator. The app reads isBot on the');
  console.log('     profile and starts answering messages by itself, with a typing signal first.');
  console.log('  2. On your own account, open Find Friends and pick the bot to start a conversation, or');
  console.log('     pick several people plus the bot to test a group.');
  console.log('  3. The bot keeps its presence alive, so the green dot and the Online tab work too.');

  if (credentials.generated) {
    console.log('\nA password was made up for this run, because none was given:');
    console.log(`    BOT_PASSWORD=${password}`);
    console.log('');
    console.log('  Put that line in .env.local before running `npm run bot:online`, which needs the same');
    console.log('  password and will not start without it. .env.local is gitignored -- check that before');
    console.log('  committing, because this account is real and its password is now in your shell history');
    console.log('  and in this scrollback.');
  } else {
    console.log('\n  The password came from BOT_PASSWORD or --password, and nothing was printed.');
  }
}

main().catch((error) => {
  console.error('Seeding the bot failed:', error.message);
  process.exitCode = 1;
});
