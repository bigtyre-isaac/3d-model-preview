import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';

const scrypt = promisify(derive);
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const PASSWORD_HASH_PATTERN = /^[a-f0-9]{32}:[a-f0-9]{128}$/;

export const roles = ['list-models', 'upload-models', 'admin'];

/** Create an error whose status can be returned by the HTTP layer. */
function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Expose account details without password hashes or token versions. */
export function publicUser({ id, username, roles, disabled }) {
  return { id, username, roles, disabled };
}

/** Check role names for both account creation and persisted-store validation. */
function validRoles(value) {
  return Array.isArray(value) && value.every(role => roles.includes(role));
}

/** Require a supported role list and remove duplicate entries. */
function normalizeRoles(value) {
  if (!validRoles(value)) {
    throw fail(400, 'Invalid roles.');
  }

  return [...new Set(value)];
}

/** Check the invariant shared by startup validation and every account edit. */
function hasEnabledAdmin(users) {
  return users.some(user => !user.disabled && user.roles.includes('admin'));
}

/** Validate a stored account before trusting its password hash or permissions. */
function validStoredUser(user) {
  return (
    typeof user.id === 'string' &&
    USERNAME_PATTERN.test(user.username) &&
    PASSWORD_HASH_PATTERN.test(user.passwordHash) &&
    validRoles(user.roles) &&
    typeof user.disabled === 'boolean' &&
    Number.isInteger(user.version)
  );
}

/** Reject damaged stores rather than silently replacing existing accounts. */
function validateStore(state) {
  const validUsers =
    Array.isArray(state.users) && state.users.length > 0 && state.users.every(validStoredUser);

  const validStore =
    state.schema === 1 &&
    /^[A-Za-z0-9+/]{43}=$/.test(state.key) &&
    validUsers &&
    new Set(state.users.map(user => user.username)).size === state.users.length &&
    hasEnabledAdmin(state.users);

  if (!validStore) {
    throw new Error('Invalid account store; restore a valid backup.');
  }
}

/** Derive a salted password hash, enforcing the account password policy. */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw fail(400, 'Use a password between 12 and 256 characters.');
  }

  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

/** Compare a password with a stored scrypt hash in constant time. */
async function matchesPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) {
    return false;
  }

  const [salt, value] = stored.split(':');
  const derived = await scrypt(password, salt, 64);
  return timingSafeEqual(derived, Buffer.from(value, 'hex'));
}

/** Resolve deployment credentials, giving a mounted password file precedence. */
async function readAdminPassword(bootstrap) {
  if (bootstrap.username && !USERNAME_PATTERN.test(bootstrap.username)) {
    throw new Error('Invalid bootstrap username.');
  }

  let password = bootstrap.password;
  if (bootstrap.passwordFile) {
    password = (await readFile(bootstrap.passwordFile, 'utf8')).trimEnd();
  }
  if (!password && bootstrap.passwordFile) {
    throw new Error('ADMIN_PASSWORD_FILE must contain a nonempty password.');
  }

  return password;
}

/** Build the first account store from explicitly supplied bootstrap credentials. */
async function bootstrapStore(bootstrap) {
  const password = await readAdminPassword(bootstrap);
  if (!password) {
    throw new Error('Set ADMIN_PASSWORD or ADMIN_PASSWORD_FILE to bootstrap the first admin.');
  }

  return {
    schema: 1,
    key: randomBytes(32).toString('base64'),
    users: [
      {
        id: randomUUID(),
        username: bootstrap.username || 'admin',
        passwordHash: await hashPassword(password),
        roles: ['admin'],
        disabled: false,
        version: 1,
      },
    ],
  };
}

/** Persist account changes using a same-directory atomic replacement. */
async function saveStore(path, state) {
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

/** Apply an explicit startup password to an existing enabled admin only. */
async function resetStartupPassword(path, state, bootstrap) {
  const password = await readAdminPassword(bootstrap);
  if (!password) {
    return;
  }

  const username = bootstrap.username || 'admin';
  const user = state.users.find(user => user.username === username);
  if (!user || user.disabled || !user.roles.includes('admin')) {
    throw new Error('ADMIN_USERNAME must identify an existing enabled admin to reset its password.');
  }

  user.passwordHash = await hashPassword(password);
  // Revoke previous sessions even when the supplied password has not changed.
  user.version++;
  await saveStore(path, state);
}

/** Load existing accounts, creating an admin only when the store is absent. */
async function loadStore(path, bootstrap) {
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    const state = await bootstrapStore(bootstrap);
    await writeFile(path, JSON.stringify(state, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    return state;
  }

  // Validate before recovery so credentials cannot overwrite a damaged store.
  validateStore(state);
  await resetStartupPassword(path, state, bootstrap);
  return state;
}

/** Open the single-instance account store and expose local authentication operations. */
export async function createAuth(directory, bootstrap = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'users.json');
  let state = await loadStore(path, bootstrap);
  validateStore(state);

  const key = Buffer.from(state.key, 'base64');
  // Unknown usernames still perform password hashing to reduce timing differences.
  const dummyHash = await hashPassword(randomBytes(24).toString('hex'));
  let queue = Promise.resolve();

  /** Serialize edits and publish in-memory changes only after atomic persistence. */
  function mutate(change) {
    const operation = queue.then(async () => {
      const next = structuredClone(state);
      const result = await change(next);

      if (!hasEnabledAdmin(next.users)) {
        throw fail(400, 'Keep at least one enabled admin.');
      }

      await saveStore(path, next);
      state = next;
      return result;
    });

    // A rejected edit must not prevent later edits from running.
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    /** List account details safe for the admin API. */
    list() {
      return state.users.map(publicUser);
    },

    /** Authenticate local credentials and issue an eight-hour token. */
    async login(username, password) {
      const user = state.users.find(user => user.username === username);
      const valid = await matchesPassword(password, user?.passwordHash || dummyHash);
      if (!valid || !user || user.disabled) {
        throw fail(401, 'Invalid username or password.');
      }

      const token = await new SignJWT({ version: user.version })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuer('model-preview')
        .setAudience('model-preview')
        .setIssuedAt()
        .setExpirationTime('8h')
        .sign(key);

      return { token, user: publicUser(user) };
    },

    /** Validate a token against the account's current status and session version. */
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],
          issuer: 'model-preview',
          audience: 'model-preview',
          requiredClaims: ['sub', 'exp', 'iat'],
          typ: 'JWT',
        });

        const user = state.users.find(user => user.id === payload.sub);
        if (!user || user.disabled || user.version !== payload.version) {
          throw new Error('Account session is no longer valid.');
        }

        return publicUser(user);
      } catch {
        throw fail(401, 'Please log in.');
      }
    },

    /** Create an enabled local account with explicitly assigned roles. */
    create(input) {
      return mutate(async next => {
        if (typeof input.username !== 'string' || !USERNAME_PATTERN.test(input.username)) {
          throw fail(400, 'Username must be 1–64 letters, numbers, dots, underscores or hyphens.');
        }
        if (next.users.some(user => user.username === input.username)) {
          throw fail(409, 'Username already exists.');
        }

        const assignedRoles = normalizeRoles(input.roles);
        const user = {
          id: randomUUID(),
          username: input.username,
          passwordHash: await hashPassword(input.password),
          roles: assignedRoles,
          disabled: false,
          version: 1,
        };

        next.users.push(user);
        return publicUser(user);
      });
    },

    /** Apply admin edits and revoke existing tokens, including for an empty edit. */
    update(id, input) {
      return mutate(async next => {
        const user = next.users.find(user => user.id === id);
        if (!user) {
          throw fail(404, 'Account not found.');
        }

        if (input.roles !== undefined) {
          user.roles = normalizeRoles(input.roles);
        }
        if (input.disabled !== undefined) {
          if (typeof input.disabled !== 'boolean') {
            throw fail(400, 'Invalid disabled value.');
          }
          user.disabled = input.disabled;
        }
        if (input.password !== undefined) {
          user.passwordHash = await hashPassword(input.password);
        }

        user.version++;
        return publicUser(user);
      });
    },

    /** Change a user's own password after checking the current one, revoking tokens. */
    changePassword(id, oldPassword, password) {
      return mutate(async next => {
        const user = next.users.find(user => user.id === id);
        if (!user || !(await matchesPassword(oldPassword, user.passwordHash))) {
          throw fail(400, 'Current password is incorrect.');
        }

        user.passwordHash = await hashPassword(password);
        user.version++;
      });
    },
  };
}
