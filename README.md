# Model viewer

A public GLB/glTF viewer with authenticated uploads and a private model index.
Model links and supporting files remain publicly accessible by URL; directory
browsing is disabled. Listing permission does not make downloads private.

## Start locally

Copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`). Set
`ADMIN_PASSWORD` to a unique password of at least 12 characters, then run:

```sh
docker compose up -d --build
```

- Accounts, login, model list: http://localhost:8090/account
- Upload form: http://localhost:8090/upload
- Public viewer: http://localhost:8090/?model=part.glb
- Background override: `?model=part.glb&background=dde2e6`

`APP_ORIGIN` must exactly match the browser-facing origin (scheme, hostname,
and port, without a trailing slash). The example disables Secure cookies for
local HTTP. In production use HTTPS at your outer proxy, set `APP_ORIGIN` to
that HTTPS origin and `COOKIE_SECURE=true`. No cross-subdomain cookies or
external authentication service are used. The former IP allowlist settings
are replaced by local authentication and are no longer used.

Models are mounted from `MODELS_DIR` (default `./models`), and private auth data
from `AUTH_DIR` (default `./auth-data`). Never mount auth data below `/srv` or
inside the models directory. Compose creates local bind directories; for Swarm,
create both directories on the selected node first. Port defaults to 8080 if
unset; the example uses 8090. If changing the port, also change `APP_ORIGIN`.

## Accounts and persistence

On first startup, an admin account is created with `ADMIN_USERNAME`
(default `admin`) and `ADMIN_PASSWORD`. Alternatively, set `ADMIN_PASSWORD_FILE`
to the path of a mounted Docker secret inside the container. Mount the secret
using your deployment configuration. Passwords must be 12–256 characters.
On subsequent startups, supplying either password setting resets the password
of `ADMIN_USERNAME` and revokes that account's existing sessions. The file takes
precedence when both are supplied. Remove both settings after successful startup
to stop reapplying the password; without them, existing credentials are preserved.
The target must be an existing enabled admin: recovery does not create, enable,
or promote accounts in an existing store. Invalid passwords, unreadable or empty
secret files, and invalid target accounts fail startup without changing the store.

The account page lets admins create accounts, assign roles, reset passwords,
and disable accounts. Users can change their own passwords and log out all
sessions. At least one enabled admin must remain. There is no public signup,
email recovery, or external JWT support.

| Role | Access |
| --- | --- |
| `list-models` | List model filenames and viewer links |
| `upload-models` | Upload and replace model/supporting files |
| `admin` | All permissions plus account management |

`/data/auth/users.json` holds salted scrypt password hashes, account versions,
and a generated JWT signing key. Keep this directory private and back it up:
restoring it restores accounts and the signing key. Writes are serialized and
replaced atomically. Invalid stores fail startup rather than resetting accounts.
Run exactly one instance against the store; there is no multi-process locking.
If an admin password is lost, set `ADMIN_USERNAME` to that enabled admin's username,
supply `ADMIN_PASSWORD` or `ADMIN_PASSWORD_FILE`, and recreate/restart the service
with those settings. After logging in, remove the settings and recreate the
container to remove them from its environment. Other accounts and model files
are preserved. Never delete the account store as routine password recovery.

Tokens expire after eight hours; there are no refresh tokens. Browsers use a
host-only HttpOnly SameSite=Strict cookie. Cookie mutations require an exact
Origin match, and login attempts are throttled per account. Scripts use Bearer
tokens. Roles are checked from current accounts on every request. Saving an
account, changing its password, disabling it, or logging out all sessions revokes
its existing tokens. Ordinary logout clears the cookie; a previously copied
Bearer token remains usable until expiry or account-wide revocation.

## API

Login with `POST /api/login` and JSON `{"username":"admin","password":"..."}`.
The response includes `token` and the public `user`; it also sets the browser
session cookie. Never put passwords or tokens in URLs. Scripts send the token
as `Authorization: Bearer TOKEN` on subsequent requests.

| Method | Endpoint | Permission |
| --- | --- | --- |
| GET | `/api/me` | Any enabled account |
| GET | `/api/models` | `list-models` |
| POST | `/upload?filename=part.glb` | `upload-models` |
| POST | `/api/password` | Own account; JSON `currentPassword`, `password` |
| POST | `/api/logout` | Clear browser cookie |
| POST | `/api/logout-all` | Own account |
| GET / POST | `/api/users` | `admin`; create with `username`, `password`, `roles` |
| PATCH | `/api/users/USER_ID` | `admin`; optional `password`, `roles`, `disabled` |

Admins have every permission. Unauthenticated requests return 401; accounts
without permission receive 403. JSON mutation endpoints require
`Content-Type: application/json`. Browser mutations send an Origin matching
`APP_ORIGIN`; CLI Bearer requests need no Origin header. Responses containing
authentication or listing data use `Cache-Control: no-store`.

Upload raw file bytes, rather than multipart data:

```sh
curl --fail-with-body --data-binary @part.glb \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  "http://localhost:8090/upload?filename=part.glb"
```

The limit is 50,000,000 bytes, enforced for fixed-length and streamed requests.
Only plain filenames without directory paths are accepted. Existing files are
replaced only after upload completes. Temporary uploads are hidden by Caddy.
GLB/glTF files appear in the authenticated index, including subfolders; related
textures and buffers can also be uploaded but are omitted from that index.

## Deployment and checks

### Local development with mounted source

Run the development Compose file directly. It inherits the base service settings:

```sh
docker compose -f docker-compose-dev.yml up -d --build
```

HTML, CSS, and browser JavaScript changes appear on browser refresh. Node's watch
mode automatically restarts the API when its source changes, without recreating
the container. Models and accounts keep the normal persistent mounts. Dependencies
remain installed in the image; rebuild after changing package files or Dockerfile.
Caddy configuration changes also require a rebuild/recreate. The development
configuration is opt-in and does not change the normal production command.

Set `APP_ORIGIN` to your local URL and `COOKIE_SECURE=false` for local HTTP.
Remove startup admin password settings after initialization: otherwise every
watched API restart reapplies the password and revokes that admin's sessions.

### Production

Caddy and Node run in one container; Node listens only on loopback. Public
HTTPS can terminate at an outer proxy. The app makes no authentication calls
to other subdomains. Rebuild with `docker compose up -d --build`.

For Swarm, build and push the image, label the storage node
`model-preview=true`, export `VIEWER_IMAGE`, `MODELS_DIR`, `AUTH_DIR`, `PORT`,
`APP_ORIGIN`, `COOKIE_SECURE=true`, and the bootstrap credentials, then run:

```sh
docker stack deploy --with-registry-auth -c docker-stack.yml model-preview
```

Swarm does not read `.env` or build images. Keep one replica on the node holding
both bind mounts. Both processes are supervised and container health checks
probe the public viewer and private Node health endpoint.

For development use Node 22 or later, `npm ci`, then `npm test`. Container smoke checks are in `config/container-smoke.mjs`; mount it at `/smoke.mjs` in the built image and run with `--entrypoint node IMAGE /smoke.mjs` in a disposable container.
The viewer component loads from Google's CDN and needs browser internet access.

Public model responses use attachment disposition, nosniff, and a sandbox CSP to prevent uploaded HTML/SVG from executing as application pages.
