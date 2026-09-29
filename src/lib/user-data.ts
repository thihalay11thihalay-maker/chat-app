export type UserData = Record<string, unknown>;

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
