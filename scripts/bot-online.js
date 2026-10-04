#!/usr/bin/env node

/**
 * Runs the test bot as a headless account: signed in from a terminal, online, typing, answering.
 *
 * Why this exists. The app answers as the bot already -- useBotResponder, mounted at the root, does
 * it for whichever account is signed in with `isBot` on its profile. But that is the bot answering
 * *on the device it is signed in on*, which means testing a conversation means signing the bot in on a
 * second phone or emulator and giving up the one you are reading the conversation on. This runs the
 * same account from a terminal instead, so the bot stays online next to your own session and both
 * halves of a conversation can be watched from one screen.
 *
 * It is the same bot, not a shortcut past one: a real Firebase Auth session, writes that go through
 * the same security rules, the same typing signal and the same room preview, and the same answer table
 * (src/lib/bot-replies.json, shared with src/lib/bot.ts). The only difference is which process holds
 * the session. There is no admin key and no rule is bypassed.
 *
 *   npm run seed:bot          once, to create the account
 *   npm run bot:online        then this, and leave it running
 *
 * Options, all optional:
 *
 *   npm run bot:online -- --email bot@example.com --password secret123
 *   npm run bot:online -- --once          answer what is waiting, then exit
 *
 * How it works, on the same Firebase SDK the app itself uses rather than hand-written REST. That is a
 * deliberate change from the first version of this script, which called the Firestore and Realtime
 * Database HTTP endpoints directly. REST needs the token refreshed and its fields spelled out by hand,
 * and the Firestore half of it stopped working: reads against firestore.googleapis.com came back as
 * `429 RESOURCE_EXHAUSTED / Quota exceeded` for every request, which is not what an exhausted daily
 * quota looks like -- the app on the same project read and wrote without trouble throughout. The same
 * query through the SDK reached the rules and was answered by them, which is the answer a bot is
 * supposed to get. The SDK also runs in plain Node, which was the only reason REST was reached for.
 *
 * Polling rather than listening. A query is one request and one answer, so the newest message in each
 * room is asked for every few seconds. That is a few reads a minute rather than a live socket, which is
 * the right trade for something that is meant to be left running while you look at the app: it costs
 * nothing while it has nothing to do, and the delay is shorter than the typing signal the reply goes
 * out behind, so it is not the part anybody notices.
 */

const {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} = require('firebase/firestore');
const { initializeApp } = require('firebase/app');
const { getDatabase, onDisconnect, ref, remove, set } = require('firebase/database');
const { inMemoryPersistence, initializeAuth, signInWithEmailAndPassword } = require('firebase/auth');

const botReplies = require('../src/lib/bot-replies.json');
const { readArguments, readBotCredentials, readProjectConfig } = require('./bot-env');

/**
 * How often the newest message in each room is asked for.
 *
 * Under the shortest typing delay in bot.ts (900ms) so the bot is never late answering because of its
 * own polling, and long enough that leaving this running for an afternoon is a few hundred reads.
 */
const POLL_MS = 700;

/**
 * How often the presence node is refreshed.
 *
 * The same 30 seconds use-presence.ts uses, and the reason it matters is the same one: a heartbeat
 * older than STALE_CONNECTION_MS (90s) is read as offline, so the green dot disappears after a couple
 * of missed beats rather than never. Well under that, so a loaded machine does not flicker the dot.
 */
const HEARTBEAT_MS = 30_000;

/** How often a continuing typing signal is refreshed, so it does not age out mid-sentence. */
const TYPING_REFRESH_MS = 2_500;

/** How many answered message ids are remembered, per room. Same reasoning as the in-app responder. */
const ANSWER_MEMORY = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The answer to a message, from the same table the in-app responder uses.
 *
 * `index` rotates the wording within a conversation, so a run of messages produces a run of different
 * replies rather than the same line over and over, which is what makes it obvious that the list is
 * really updating.
 */
function pickReply(text, index) {
  const rule = botReplies.rules.find((candidate) => new RegExp(candidate.test, 'i').test(text));
  const replies = rule ? rule.replies : botReplies.fallback;

  return replies[index % replies.length];
}

/**
 * How long to pretend to type before answering.
 *
 * The same formula as botTypingDelay in src/lib/bot.ts, for the same reason: a reply that appears
 * instantly makes the typing signal impossible to see, and it is the only part of this a person has to
 * be watching the screen for.
 */
function typingDelay(text) {
  return 900 + Math.min(text.trim().length * 40, 2_000);
}

/**
 * Everything this run talks to: the two databases, and the uid the rules will judge every write by.
 *
 * The app name is suffixed so two runs -- a `--once` beside a long-running one, say -- do not collide
 * on Firebase's "an app already exists with this name" check, and so a cached session from a previous
 * run is never picked up by the next one.
 */
async function createSession(env, options) {
  const apiKey = options.apikey || env.EXPO_PUBLIC_FIREBASE_API_KEY;
  const projectId = options.project || env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  const databaseURL = (options.database || env.EXPO_PUBLIC_FIREBASE_DATABASE_URL || '').replace(/\/+$/, '');
  const credentials = readBotCredentials(options, env);

  if (credentials.generated) {
    throw new Error([
      'No bot password found, so there is nothing to sign in with.',
      '',
      '  This used to fall back to a password that was hardcoded in this file, which meant the credential',
      '  for a real account in a real project was published in the repository. There is no fallback now.',
      '',
      '  Put the password in .env.local as BOT_PASSWORD (npm run seed:bot prints one when it creates the',
      '  account), or pass --password on the command line.',
    ].join('\n'));
  }

  const email = credentials.email;
  const password = credentials.password;

  if (!apiKey || !projectId) {
    throw new Error(
      'Could not find the Firebase api key or project id. Run this from the project folder, or add a .env.local, or pass --apikey and --project.',
    );
  }

  if (!databaseURL) {
    throw new Error(
      'Could not find the Realtime Database url, so the bot could never show as online. Set EXPO_PUBLIC_FIREBASE_DATABASE_URL in .env.local, or pass --database.',
    );
  }

  const app = initializeApp(
    { apiKey, databaseURL, projectId },
    `bot-${Date.now().toString(36)}-${process.pid}`,
  );

  // The Auth module needs to be initialised by hand rather than through getAuth: that helper picks a
  // browser persistence it cannot use outside a browser, and throws here.
  const credential = await signInWithEmailAndPassword(
    initializeAuth(app, { persistence: inMemoryPersistence }),
    email,
    password,
  );

  return {
    email,
    firestore: getFirestore(app),
    realtime: getDatabase(app),
    uid: credential.user.uid,
  };
}

/**
 * Writes this run's presence node, and keeps refreshing it.
 *
 * The same shape use-presence.ts writes, and for the same reasons: `online` is what a reader looks at,
 * `lastSeen` is what makes age a usable second opinion for a process that was killed outright rather
 * than closed, and one node per connection is what lets two runs coexist without one closing taking
 * the other's presence with it. The rules in database.rules.json validate exactly this shape.
 */
async function reportPresence(session, connectionId) {
  const node = ref(session.realtime, `status/${session.uid}/${connectionId}`);
  const write = () => set(node, { lastSeen: Date.now(), online: true });

  await write();

  // Armed before the first write would be wrong and armed after it is nearly as bad, so this is
  // registered up front and left alone: a run killed outright still takes its own node with it.
  void onDisconnect(node).remove().catch(() => {});

  // On the way out the node is deleted rather than left to age out: a bot that was answering half a
  // minute ago should read as offline the moment it stops, and the heartbeat only corrects a stale
  // node after a minute and a half.
  return async () => {
    await remove(node).catch(() => {});
  };
}

/** Announces that the bot is typing, refreshes while it means it, and stops when told. */
function startTyping(session, chatId) {
  const node = ref(session.realtime, `typing/${chatId}/${session.uid}`);
  const announce = () => set(node, { at: Date.now() });

  void announce().catch(() => {});
  void onDisconnect(node).remove().catch(() => {});

  // Refreshed on a timer rather than on every keystroke: a write per character is a lot of traffic
  // for a signal that is only read as a boolean.
  const beat = setInterval(() => void announce().catch(() => {}), TYPING_REFRESH_MS);

  return async () => {
    clearInterval(beat);

    await remove(node).catch(() => {});
  };
}

/**
 * Whether the bot may post into this room.
 *
 * Read from the room document the poll already fetched rather than asking Firebase again. The rules
 * refuse a message in a channel to anybody but the owner and its admins, and a bot that keeps trying
 * is a bot that fills the console with the same denial once a second: silence is the honest answer
 * for a room this account cannot speak in.
 */
function mayPostIn(session, room) {
  if (room.kind !== 'channel') {
    return true;
  }

  return room.ownerId === session.uid
    || (Array.isArray(room.admins) && room.admins.includes(session.uid));
}

/**
 * Moves the room preview and the unread badges along with the message.
 *
 * Both halves matter, for the same reason they matter in bot.ts: the message alone would leave the
 * inbox quoting whatever was said before and the badges stuck, which is the class of bug the room
 * preview exists to fix. The counters are incremented in place rather than read and written back
 * whole, because the SDK can and because a bot replying in a room it shares cannot be the only writer
 * of that room's badge.
 */
async function updateRoomPreview(session, chatId, text) {
  const roomRef = doc(session.firestore, 'chats', chatId);
  const room = await getDoc(roomRef);

  if (!room.exists()) {
    return;
  }

  const update = {
    lastMessage: text.slice(0, 120),
    lastMessageSenderId: session.uid,
    lastMessageTime: serverTimestamp(),
  };

  const participants = room.data()?.participants;

  if (Array.isArray(participants)) {
    participants.forEach((participant) => {
      if (typeof participant === 'string' && participant !== session.uid) {
        update[`unreadCounts.${participant}`] = increment(1);
      }
    });
  }

  await updateDoc(roomRef, update);
}

/** Writes the bot's reply and puts the room document back in step with it. */
async function sendMessage(session, chatId, text) {
  await addDoc(collection(session.firestore, 'chats', chatId, 'messages'), {
    createdAt: serverTimestamp(),
    senderId: session.uid,
    text,
    type: 'text',
  });

  // Best effort, and a failure here must not undo a reply that has already been delivered: the inbox
  // preview and the badges catching up a moment later is a smaller problem than the message itself.
  try {
    await updateRoomPreview(session, chatId, text);
  } catch (error) {
    console.warn(`The bot replied in ${chatId} but could not update the room preview: ${error.message}`);
  }
}

/**
 * Answers the newest message in one room, if it is somebody else's and has not been answered.
 *
 * The id is what stops a message being answered twice, because a poll redelivers the same newest
 * message every few seconds. The typing signal goes on before the wait, held so that cancelling stops
 * it too rather than leaving the other side told somebody is typing until the entry ages out.
 */
function answerNewest(session, chatId, newest, state) {
  const { senderId, text } = newest;
  const messageId = newest.id;

  if (!senderId || senderId === session.uid || state.answered.has(messageId)) {
    return;
  }

  const body = typeof text === 'string' ? text : '';

  state.answered.add(messageId);

  if (state.answered.size > ANSWER_MEMORY) {
    const oldest = state.answered.values().next().value;

    if (typeof oldest === 'string') {
      state.answered.delete(oldest);
    }
  }

  const replyCount = state.replyCounts.get(chatId) ?? 0;
  state.replyCounts.set(chatId, replyCount + 1);

  const stopTyping = startTyping(session, chatId);
  const timer = setTimeout(async () => {
    state.timers.delete(timer);

    await stopTyping();

    try {
      await sendMessage(session, chatId, pickReply(body, replyCount));
      console.log(`Replied in ${chatId}: "${body.slice(0, 40)}"`);
    } catch (error) {
      console.warn(`The bot could not answer in ${chatId}: ${error.message}`);
    }
  }, typingDelay(body));

  state.timers.add(timer);
}

/**
 * One pass over every room the bot is in.
 *
 * The same query the inbox makes, with the same composite index: an array-contains filter ordered by
 * another field cannot be served by a single-field one. The rules need the same filter to be there --
 * without it the query cannot be validated against them and the read is refused -- which is why the
 * field is `participants` and not something the bot could choose.
 */
async function pollRooms(session, states) {
  const rooms = await getDocs(query(
    collection(session.firestore, 'chats'),
    where('participants', 'array-contains', session.uid),
    orderBy('lastMessageTime', 'desc'),
    limit(25),
  ));

  const live = new Set();

  for (const room of rooms.docs) {
    const chatId = room.id;

    live.add(chatId);

    // A room this account cannot speak in is still counted as live, so it is not re-read from scratch
    // every pass; it simply has nothing read from inside it.
    if (!mayPostIn(session, room.data())) {
      continue;
    }

    if (!states.has(chatId)) {
      states.set(chatId, { answered: new Set(), replyCounts: new Map(), timers: new Set() });
    }

    const newest = await getDocs(query(
      collection(session.firestore, 'chats', chatId, 'messages'),
      orderBy('createdAt', 'desc'),
      limit(1),
    ));

    const message = newest.docs[0];

    if (message) {
      answerNewest(session, chatId, message.data(), states.get(chatId));
    }
  }

  // A room that has gone stops being watched, rather than leaving a poll reading a document nobody can
  // reach any more.
  states.forEach((state, chatId) => {
    if (!live.has(chatId)) {
      state.timers.forEach((timer) => clearTimeout(timer));
      states.delete(chatId);
    }
  });
}

/**
 * Answers whatever is waiting, then stops.
 *
 * `--once` rather than a mode of the loop: a one-shot run is a different thing from a bot that stays
 * online, and the difference is exactly the part somebody has to be told about -- it can answer the
 * messages already sitting there, but it cannot show as online to anybody who looks later.
 */
async function runOnce(session) {
  await pollRooms(session, new Map());
  await sleep(3_500);
}

async function main() {
  const env = readProjectConfig();
  const options = readArguments(process.argv.slice(2));
  const session = await createSession(env, options);
  const isOnce = options.once === 'true' || options.once === '';

  console.log(`\nThe bot ${session.email} is signed in as ${session.uid}.`);

  if (isOnce) {
    console.log('Answering whatever is waiting, then stopping.');
    await runOnce(session);

    // The SDK holds its sockets open, so the process would sit there after the answers rather than
    // return to the shell. Exiting is what makes `--once` once.
    process.exit(0);
  }

  // One id per run, so two runs coexist without one closing taking the other's presence with it.
  const connectionId = `${Date.now().toString(36)}-${process.pid}`;
  const stopPresence = await reportPresence(session, connectionId);
  const states = new Map();

  console.log('Online. It will answer every message sent to it, with a typing signal first.');
  console.log('Leave this running while you use the app. Ctrl+C to stop, which takes it offline at once.');
  console.log('\nIn the app: Find Friends, pick the bot, and send it something.\n');

  let stopped = false;
  const shutdown = async () => {
    if (stopped) {
      return;
    }

    stopped = true;

    states.forEach((state) => state.timers.forEach((timer) => clearTimeout(timer)));
    await stopPresence();
    console.log('\nOffline. The presence node has been removed.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const heartbeat = setInterval(() => {
    void set(ref(session.realtime, `status/${session.uid}/${connectionId}`), {
      lastSeen: Date.now(),
      online: true,
    }).catch((error) => {
      console.warn(`Could not refresh the bot presence: ${error.message}`);
    });
  }, HEARTBEAT_MS);

  while (!stopped) {
    try {
      await pollRooms(session, states);
    } catch (error) {
      // A dropped connection or an expired database session is a pause, not a reason to stop: the next
      // pass is POLL_MS away and the answers this exists for are not urgent.
      console.warn(`The bot could not read its conversations: ${error.message}`);
    }

    await sleep(POLL_MS);
  }

  clearInterval(heartbeat);
}

main().catch((error) => {
  console.error('Running the bot failed:', error.message);
  process.exitCode = 1;
});