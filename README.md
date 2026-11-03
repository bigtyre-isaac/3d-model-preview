# Model viewer

Copy `.env.example` to `.env`, adjust the settings for your deployment, then start:

```sh
cp .env.example .env
docker compose up -d --build
```

In PowerShell, use `Copy-Item .env.example .env`. The local `.env` is gitignored;
keep deployment-specific settings there. The example permits uploads from any
IP, so configure `UPLOAD_ALLOWED_IPS` before publishing if you want restrictions.

- Viewer: http://localhost:8090/?model=part.glb
- Upload form: http://localhost:8090/upload
- Background override: http://localhost:8090/?model=part.glb&background=dde2e6

The background defaults to light grey (`eeeeee`); `background` accepts six hex
digits. Status text is dark. Google's model-viewer supports GLB and glTF; its
JavaScript loads from Google's CDN and requires browser internet access.

Models are bind-mounted from `./models`. Set `MODELS_DIR` and `PORT` in `.env`
to change the folder and port. The example sets port 8090; without `.env`,
Compose defaults to 8080. Subfolders work with `?model=folder/part.glb`.

## Upload API

### Optional IP allowlist

Set a space-separated list of IP addresses or CIDR ranges in `.env`:

```dotenv
UPLOAD_ALLOWED_IPS="203.0.113.10 198.51.100.20 192.168.1.0/24"
```

Apply changes with `docker compose up -d`. This restricts the upload form,
its direct HTML URL, and the POST API; the viewer and models remain public.
The default (`0.0.0.0/0 ::/0`), including an unset or blank value, permits
everyone. Replace it before publishing if uploads should be restricted.

Behind a reverse proxy, set `TRUSTED_PROXIES` to its IP addresses or CIDRs
as seen by the app, separate from the visitor upload allowlist:

```dotenv
TRUSTED_PROXIES="10.0.0.10/32 10.0.0.11/32"
UPLOAD_ALLOWED_IPS="203.0.113.10 198.51.100.20"
```

The default empty `TRUSTED_PROXIES` trusts no proxies. Upload restrictions use
`client_ip`: Caddy reads `X-Forwarded-For` only from trusted proxies, with
strict right-to-left parsing. Otherwise it uses the direct connection IP.
An outer Caddy reverse proxy forwards client IPs automatically. Trust only
your actual proxy addresses, not all networks. Apply environment changes with
`docker compose up -d`; for Swarm, export both variables and redeploy the stack.
Docker Desktop may expose a gateway IP instead of the original client IP;
verify from an external connection before publishing.

POST `/upload?filename=part.glb` with the raw file as the body:

```sh
curl --fail-with-body --data-binary @part.glb -H "Content-Type: application/octet-stream" "http://localhost:8090/upload?filename=part.glb"
```

The limit is 50 MB (50,000,000 bytes), enforced for fixed-length and streamed
requests. Success returns JSON with `filename`, `bytes`, and `url`. Invalid
filenames return 400; oversized files return 413. Only plain filenames are
accepted for uploads, without directory paths. Existing files are replaced
only after an upload completes. Supporting textures and buffers can also be
uploaded. Uploads are unauthenticated.

Caddy and the Node upload handler run in one container with a read-write models
mount. The upload handler listens only on loopback. Models are publicly accessible by
URL; directory listing is disabled. No rebuild is needed when models change.

Rebuild viewer/config/service changes with `docker compose up -d --build`.
Stop with `docker compose down`.

## Docker Swarm

One image, one service, one replica. Build and push to a registry accessible
to your Swarm nodes (replace the registry and tag):

```sh
docker build -t registry.example.com/model-preview:1 .
docker push registry.example.com/model-preview:1
docker node update --label-add model-preview=true YOUR_NODE
```

Create the models directory on that node, then deploy from a manager:

```sh
export VIEWER_IMAGE=registry.example.com/model-preview:1
export MODELS_DIR=/srv/model-preview/models
export PORT=8090
export UPLOAD_ALLOWED_IPS="203.0.113.10 198.51.100.20"
export TRUSTED_PROXIES="10.0.0.10/32"
docker stack deploy --with-registry-auth -c docker-stack.yml model-preview
```

`docker stack deploy` does not load `.env` or build images. Supply exported
environment variables (PowerShell uses `$env:NAME = 'value'`). Label only the
node holding your models; the bind source must exist on that node. A registry
is optional for a single-node Swarm if the image already exists locally.

The stack publishes HTTP in host mode to avoid Swarm routing-mesh source-IP
translation, so connect to the selected node's published port. Proxies or
external load balancers still require appropriate client IP configuration.
The default allowlist remains open to everyone unless configured.

Both processes are supervised: if either exits, the container exits so Swarm
can restart it. Container shutdown signals are forwarded to both processes.
