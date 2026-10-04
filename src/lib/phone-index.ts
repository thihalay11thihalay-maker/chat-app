import * as Crypto from 'expo-crypto';

/**
 * Turning a phone number into something two devices can agree on without either of them handing the
 * number to the other.
 *
 * The address book is the most private list on a phone, and "people you know" is the feature most worth
 * having. Reconciling them means comparing numbers, and comparing numbers means the numbers have to be in
 * a form the server can look up -- so they are hashed rather than stored, and the hash is what travels.
 *
 * How much that protects is worth being exact about, because a hash of a phone number is not the same as
 * a password hash:
 *
 *   Phone numbers are not high entropy. There are perhaps 10^10 of them in use, so anybody holding a
 *   hash and an offline list of candidate numbers can confirm one in a few thousand tries per second.
 *   Hiding the digits raises the cost of reading the list; it does not make the digits unrecoverable.
 *
 *   A pepper -- a secret mixed into the hash before it leaves the device -- is what would close that gap,
 *   because the attacker would need the secret to test a guess. There is nowhere to keep one here: every
 *   value in a client is readable by whoever has the app. So this module deliberately does not pretend,
 *   and `phoneIndexId` is a plain SHA-256.
 *
 * What that buys in practice is that the raw numbers are not in the database, and the index cannot be
 * walked to enumerate the app's users: each hash is its own document and the collection refuses a list.
 * To learn a number you have to already know the number. Making it cryptographically private needs a
 * trusted server holding the pepper, and that is the change to make when there is one.
 */

/**
 * The digits of a phone number, and nothing else.
 *
 * Everything that is not a digit goes: spaces, dashes, brackets and a leading `+`, which is how the same
 * number is written differently in two address books and would otherwise be two different entries that
 * never match.
 *
 * Then the country code is dropped rather than kept, because it is the part that is most often stored
 * differently -- `09` locally against `959` internationally, or a number saved with the area code that the
 * other device never had. Matching on the last nine digits covers both, at the cost of also matching a
 * number that is nine digits long in a different country. That is the right trade: a false match is one
 * suggestion the reader declines, and a missed match is a friend the feature failed to find.
 */
export function normalizePhone(raw: string) {
    const digits = raw.replace(/\D/g, '');

    if (digits.length < 9) {
      // Too short to be a phone number in any country this app is used in. Returning nothing here rather
      // than a short hash keeps short entries -- extensions, postcodes, dates in a contact's "phone" field
      // -- from matching each other.
      return '';
    }

    return digits.slice(-9);
}

/**
 * The document id a number is looked up under, which is its SHA-256.
 *
 * The document id rather than a field, because it is what makes the collection unlistable: a client can
 * only ever ask for a hash it already has, so it cannot ask "give me every number in the app". A field on
 * a profile would have to be readable, because the profile itself is readable by every signed-in account.
 */
export async function phoneIndexId(raw: string) {
    const normalized = normalizePhone(raw);

    if (normalized === '') {
      return '';
    }

    // Hex rather than base64 because this is a Firestore document id, and `/` in base64 would have to be
    // escaped in every path it appeared in.
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, normalized);
}

/**
 * Every indexable number in a list, hashed, with the duplicates removed.
 *
 * An address book has the same person in it several times -- a work number, a mobile, and a landline that
 * is the mobile spelled differently -- and hashing each of those separately is a read that finds the same
 * person again. Hashing is cheap but not free, so the numbers are collapsed first.
 *
 * Sequential rather than parallel: `digestStringAsync` crosses to native, and an address book is a few
 * hundred entries, so firing them all at once is a burst of bridge traffic for no wall-clock gain worth
 * having on a screen that is showing a spinner.
 */
export async function hashPhoneList(phones: string[]) {
    const normalized = [...new Set(phones.map(normalizePhone).filter((value) => value !== ''))];
    const hashes: string[] = [];

    for (const value of normalized) {
        hashes.push(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value));
    }

    return hashes;
}