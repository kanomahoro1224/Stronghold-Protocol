# tools/fixtures

Test-only material, never loaded by the running service.

- `self-signed-key.pem` / `self-signed-cert.pem` — a throwaway self-signed certificate for `localhost` /
  `127.0.0.1` (CN=localhost, SAN `DNS:localhost,IP:127.0.0.1`, 10 years). `tools/check-probe-address.mjs`
  starts a local HTTPS server with it to prove two things at once: a plain `fetch` rejects that server
  (untrusted certificate), while `server/probe.js` reaches it — which is the deliberate, documented
  relaxation that lets the community server probe real game nodes whose certificates do not match their
  hostname. Committing the throwaway key is intentional; it protects nothing.
