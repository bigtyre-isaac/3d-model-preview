# Planned: authenticated uploads

Status: future addition; not implemented.

- Use Caddy's built-in HTTP Basic Auth in the app container, before upload
  handlers, covering `/upload`, `/upload/*`, and `/upload.html`.
- Configure one username and a password hash generated with
  `caddy hash-password`, supplied through a mounted Docker Swarm secret.
- Replace the upload IP restriction with authentication so credentials work
  from any IP. Keep the viewer and model files public.
- Terminate public HTTPS at the outer Caddy proxy and connect to the app over
  the shared overlay network, without direct public access to the app port.
- Reuse the existing upload form with the browser's Basic Auth prompt.
- Verify anonymous/invalid credentials receive 401, authenticated uploads and
  replacements succeed, the 50 MB limit remains enforced, and viewing is public.

Tradeoffs: browser-managed credentials, awkward logout, no MFA or password reset.
