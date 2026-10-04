const fs = require('fs');
const path = require('path');

const { collection, getDocs } = require('firebase/firestore');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

/**
 * Giving every existing post a `visibility` field, before the tightened rules go out.
 *
 * Why this has to be a server script rather than something the app does:
 *
 *   The rules that make `visibility` meaningful only recognise it on documents that have it. A post
 *   written before the field existed has none, so after the rules deploy it satisfies none of the three
 *   feed clauses and disappears from every feed -- and the app's own client-side backfill cannot fix it in
 *   time, because it only runs when the *author* next opens the app on a new build. Until then their posts
 *   are invisible to everybody, including them.
 *
 *   The obvious rules-side fix -- treating a missing field as public inside the list rule -- is worse, and
 *   is the reason the comment in firestore.rules is as long as it is. In a query there is no stored
 *   document, so `resource` is null and `'visibility' in resource.data` reads as "absent" for *every*
 *   document the query might return. That clause would authorize an unfiltered `collection('posts')` for
 *   everybody, signed out included, handing back the whole collection including `only_me` posts. Rules
 *   never filter what a query returns, so a single permissive clause leaks everything.
 *
 * So the data is fixed instead of the rules, and the order matters:
 *
 *   1. npm run backfill:visibility      <- this script
 *   2. npm run deploy:fb                <- rules and indexes
 *   3. ship the build
 *
 * Running the rules first is the failure this exists to prevent. Re-running it afterwards is harmless and
 * is the right way to catch posts written while it was running.
 *
 * Admin credentials bypass these rules by design, which is the only reason this can be done at all: no
 * client can write this field on somebody else's post, so a client-side version of this migration is not
 * merely slower, it is impossible.
 */

/**
 * How many posts are written per batch.
 *
 * Firestore caps a batch at 500 operations. Well under that, because a batch that trips the cap fails
 * whole and this is a migration that has to be resumable: a smaller batch means a failure costs less work
 * and the next run picks up from the beginning of what is left.
 */
const BATCH_SIZE = 400;

async function readCredentials(root) {
  const candidates = ['service-account.json', 'scripts/service-account.json'];

  for (const file of candidates) {
    const fullPath = path.join(root, file);

    if (fs.existsSync(fullPath)) {
      return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    }
  }

  // The path Firebase puts a downloaded key on, which is also where the CLI leaves one after
  // `firebase login:ci`-style flows.
  const home = process.env.FIREBASE_SERVICE_ACCOUNT
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'firebase', 'service-account.json');

  if (fs.existsSync(home)) {
    return JSON.parse(fs.readFileSync(home, 'utf8'));
  }

  throw new Error(
    'No service account found. Download an admin key from the Firebase console (Project settings > Service '
    + 'accounts > Generate new private key), save it as service-account.json in the project root, and put '
    + 'its path in FIREBASE_SERVICE_ACCOUNT if it lives somewhere else.',
  );
}

function readProjectId(credentials) {
  return process.env.FIREBASE_PROJECT_ID || credentials.project_id;
}

async function main() {
  const root = process.cwd();
  const credentials = await readCredentials(root);
  const projectId = readProjectId(credentials);

  initializeApp({ credential: cert(credentials), projectId });

  const db = getFirestore();

  // Fetched by document id rather than by `where('visibility', '==', null)`: that comparison also matches
  // documents where the field is entirely absent, but Firestore will not index or return it as a "missing
  // field" match reliably across a large collection, and this migration must not depend on that subtlety.
  // Reading all documents and testing the field in Node is slower per document but unambiguous, and it is
  // a one-off.
  console.log('Reading every post. This is a full collection scan and is expected to take a while...');

  const snapshot = await getDocs(collection(db, 'posts'));
  const missing = snapshot.docs.filter((postDocument) => postDocument.data().visibility === undefined);

  console.log(`Found ${snapshot.size} posts, ${missing.length} of which have no visibility field.`);

  if (missing.length === 0) {
    console.log('Nothing to do. The rules can be deployed.');
    return;
  }

  let written = 0;

  for (let start = 0; start < missing.length; start += BATCH_SIZE) {
    const batch = db.batch();
    const slice = missing.slice(start, start + BATCH_SIZE);

    slice.forEach((postDocument) => {
      batch.update(postDocument.ref, { visibility: 'public' });
    });

    await batch.commit();
    written += slice.length;

    console.log(`  ${written}/${missing.length}`);
  }

  console.log(`\nMarked ${written} posts as public.`);
  console.log('They now satisfy the public feed clause, so deploy the rules with: npm run deploy:fb');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nThe backfill did not finish:', error.message);
    console.error('It is safe to run again -- posts already given a visibility are skipped.');
    process.exit(1);
  });