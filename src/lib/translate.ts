/**
 * Translating a message, for the Translate row on a message's action bar.
 *
 * Two languages rather than a list of ninety, because this app's users read Burmese and English and a
 * picker with ninety entries is a picker nobody opens. Which one is offered is worked out from the text
 * itself, so tapping Translate on a Burmese message offers English and the other way round.
 *
 * The translation itself comes from MyMemory's public endpoint, which needs no key and no account. That
 * is a deliberate trade and worth being clear about: the words of a message leave the device to be
 * translated, so this is only as private as that service is, and it has an anonymous daily limit that a
 * busy room would eventually reach. Everything here is behind one function so that swapping in a server
 * of your own is a change to this file and to nothing else.
 */

/** The languages this build translates between. */
export type TranslationLanguage = 'en' | 'my';

export const TRANSLATION_LANGUAGES: { code: TranslationLanguage; label: string }[] = [
  { code: 'my', label: 'Burmese' },
  { code: 'en', label: 'English' },
];

/**
 * Whether the text is Burmese, from the script rather than from a guess about the reader.
 *
 * The Burmese block is a small, fixed range of code points, so this is exact for the two languages here
 * and costs nothing. It matters because the translation API has to be told what it is translating *from*:
 * handing it the wrong source produces a confident answer in the wrong language, which is worse than
 * saying nothing.
 */
const BURMESE_PATTERN = /[\u1000-\u109F\uAA60-\uAA7F\u116D\u117B\u1A60\u1B5B]/;

export function detectTranslationLanguage(text: string): TranslationLanguage {
  return BURMESE_PATTERN.test(text) ? 'my' : 'en';
}

export function languageLabel(code: TranslationLanguage) {
  return TRANSLATION_LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

/**
 * MyMemory answers in HTML entities for some pairs, and a translation is shown as plain text, so the
 * handful that actually turn up are turned back into their characters rather than being displayed.
 */
function decodeEntities(text: string) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * How much of a message is sent.
 *
 * The free tier counts characters per day across everybody using the endpoint from the address, so a
 * long message is both a slow request and a bigger claim on that budget. A translation of the first
 * 900 characters is worth having; the tail is not worth a refused request.
 */
const MAX_CHARACTERS = 900;

/**
 * Translates a message, or throws something a person can be told.
 *
 * Every failure comes back as a sentence rather than as a status code, because the caller has one place
 * to show it and no way to act on a code.
 */
export async function translateMessageText(text: string, target: TranslationLanguage) {
  const source = detectTranslationLanguage(text);

  // Not an error worth a round trip: asking for Burmese and being handed Burmese would spend the
  // request to say what a script check already knows.
  if (source === target) {
    throw new Error(`This message is already in ${languageLabel(target).toLowerCase()}.`);
  }

  const trimmed = text.trim().slice(0, MAX_CHARACTERS);
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=${source}|${target}`;

  let response: Response;

  try {
    response = await fetch(url);
  } catch (error) {
    console.error('Could not reach the translation service:', error);

    throw new Error('No connection to the translation service.');
  }

  if (!response.ok) {
    throw new Error('The translation service could not answer. Please try again.');
  }

  let payload: {
    responseData?: { translatedText?: unknown };
    responseStatus?: unknown;
  };

  try {
    payload = await response.json();
  } catch (error) {
    console.error('Could not read the translation answer:', error);

    throw new Error('The translation service sent something unreadable.');
  }

  // The service answers 200 with an error inside the body once the anonymous daily limit is spent, so
  // the body is checked rather than the status alone.
  const status = String(payload.responseStatus ?? '');
  const translated = payload.responseData?.translatedText;

  if (status !== '' && status !== '200') {
    throw new Error(
      status === '403'
        ? 'The free translation limit for today is used up. Please try again tomorrow.'
        : 'The translation service could not translate that.',
    );
  }

  if (typeof translated !== 'string' || translated.trim() === '') {
    throw new Error('There is nothing in that message to translate.');
  }

  return decodeEntities(translated);
}