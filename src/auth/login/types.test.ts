import {
    isUserRole,
    USER_ROLES,
    UserRecord,
    UserRepository,
} from './types';

describe('login type contract', () => {
    it('exposes the supported user roles and rejects invalid runtime values', () => {
        expect(USER_ROLES).toEqual(['startup', 'investor']);
        expect(USER_ROLES.every(isUserRole)).toBe(true);

        for (const value of [undefined, null, '', 'admin', 'STARTUP', 1, {}, []]) {
            expect(isUserRole(value)).toBe(false);
        }
    });

    it.each<UserRecord>([
        {
            id: 'user-startup',
            email: 'founder@example.com',
            role: 'startup',
            passwordHash: 'hash-startup',
        },
        {
            id: 'user-investor',
            email: 'investor@example.com',
            role: 'investor',
            passwordHash: 'hash-investor',
        },
    ])('accepts a complete %s user record', (record) => {
        expect(record).toMatchObject({
            id: expect.any(String),
            email: expect.stringContaining('@'),
            role: expect.any(String),
            passwordHash: expect.any(String),
        });
        expect(isUserRole(record.role)).toBe(true);
    });

    it('models repository lookup transitions from missing to found deterministically', async () => {
        const records = new Map<string, UserRecord>();
        const repository: UserRepository = {
            findByEmail: async (email) => records.get(email) ?? null,
        };
        const record: UserRecord = {
            id: 'user-1',
            email: 'user@example.com',
            role: 'startup',
            passwordHash: 'hash',
        };

        expect(await repository.findByEmail(record.email)).toBeNull();
        records.set(record.email, record);
        expect(await repository.findByEmail(record.email)).toEqual(record);
        expect(await repository.findByEmail('unknown@example.com')).toBeNull();
    });
});
