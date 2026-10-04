export type UserData = Record<string, unknown>;

/**
 * The order a person's name is looked for in, and the order their picture is.
 *
 * Exported rather than repeated at each call site, because every screen that draws a person has to answer
 * the same two questions and there were five separate answers. They had drifted: some accepted an empty
 * string as a name, some trimmed whitespace, and only some fell through to the next field. So the same
 * profile could show a picture in the inbox and a letter initial on the profile screen.
 *
 * These are the fields this app has actually written over time. `displayName` first because that is what
 * onboarding sets; the rest are older shapes kept for profiles written before it. Adding a field here
 * fixes every screen at once, which is the entire reason they live here.
 */
export const PERSON_NAME_KEYS = ['displayName', 'name', 'username'];
export const PERSON_PHOTO_KEYS = ['profilePictureUrl', 'photoURL', 'photoUrl', 'avatarUrl'];

export function getString(data: UserData, keys: string[], fallback = '') {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return fallback;
}

export function getAge(data: UserData) {
    const age = typeof data.age === 'number' ? data.age : Number(data.age);
    return Number.isFinite(age) ? age : null;
}

export function readNumber(data: UserData, ...keys: string[]) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
            return Number(value);
        }
    }

    return null;
}

export function getCoordinates(data: UserData): [number, number] | null {
    const latitude = readNumber(data, 'latitude', 'lat');
    const longitude = readNumber(data, 'longitude', 'lng', 'lon');

    return latitude !== null && longitude !== null ? [latitude, longitude] : null;
}

export function getParticipants(value: unknown) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((participant) => {
        if (typeof participant === 'string') {
            return [participant];
        }
        if (participant && typeof participant === 'object' && 'uid' in participant) {
            const { uid } = participant as { uid: unknown };
            return typeof uid === 'string' ? [uid] : [];
        }
        return [];
    });
}
