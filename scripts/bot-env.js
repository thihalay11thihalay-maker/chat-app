const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Reading the project settings both bot scripts need.
 *
 * The two scripts are a pair: one creates the bot account, the other runs it. They must agree about
 * which project they are talking to and about what the command line said, or the second one would
 * cheerfully sign a bot in against a different project from the one it just seeded.
 */

/** Reads the values the app itself uses, so the bot lands in the same project the app points at. */
function readProjectConfig() {
  const root = process.cwd();
  const candidates = ['.env.local', '.env'];

  for (const file of candidates) {
    const fullPath = path.join(root, file);

    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const values = {};

    fs.readFileSync(fullPath, 'utf8')
      .split(/\r?\n/)
      .forEach((line) => {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);

        if (!match || match[1].startsWith('#')) {
          return;
        }

        values[match[1]] = match[2].replace(/^["']|["']$/g, '');
      });

    return values;
  }

  return {};
}

/** `--name value` and `--name=value` both work, because both get typed. */
function readArguments(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      continue;
    }

    const withoutDashes = token.slice(2);
    const equalsAt = withoutDashes.indexOf('=');

    if (equalsAt !== -1) {
      options[withoutDashes.slice(0, equalsAt)] = withoutDashes.slice(equalsAt + 1);
      continue;
    }

    const next = argv[index + 1];

    if (next && !next.startsWith('--')) {
      options[withoutDashes] = next;
      index += 1;
    } else {
      options[withoutDashes] = 'true';
    }
  }

  return options;
}

/**
 * The bot's email and password, from a flag, the environment, or nowhere.
 *
 * There is deliberately no default password. This used to be a constant in both scripts, which meant the
 * credential for a real Firebase Auth account in a real project was sitting in the repository: anyone with
 * the source could sign in as the bot, read every room it had joined, and post as it.
 *
 * A generated password is only half an answer, because the two scripts have to agree on it. So `seed-bot`
 * generates one when it is given nothing, prints it once, and tells the operator to put it in `.env.local`
 * as `BOT_PASSWORD`; `bot-online` reads it from there. The value is never written back into a tracked file
 * and never has a fallback, so a script started without one stops rather than quietly using something
 * guessable.
 *
 * Returns `generated: true` when it made the password up, so the caller can say so out loud rather than
 * printing a secret somebody will assume they chose.
 */
function readBotCredentials(options, env) {
  const email = options.email || env.BOT_EMAIL || 'chatbot@example.com';
  const supplied = options.password || env.BOT_PASSWORD || '';
  const generated = supplied === '';

  return {
    email,
    generated,
    // 24 bytes of entropy, so the password is not something a dictionary reaches. Firebase requires at
    // least six characters, which this clears by a wide margin.
    password: generated ? crypto.randomBytes(24).toString('base64url') : supplied,
  };
}

module.exports = { readArguments, readBotCredentials, readProjectConfig };