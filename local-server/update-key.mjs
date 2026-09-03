// Trust anchor for the sidecar's SELF-UPDATE channel, the ONE place it is
// defined. Consumers: local-server/update.mjs (the supervised daemon's
// hot-swap) and the curl bootstraps (lib/local-serve/bootstrap-sh.ts,
// bootstrap-ps.ts), which fetch the same bundle from the same origin.
//
// serve.mjs is code the machine EXECUTES, so TLS alone is the wrong trust
// model: whoever can write that one static asset gets code execution on every
// headless install. Node and tectonic in the same installer are sha256-pinned;
// this is the moving-target equivalent — a detached ed25519 signature over the
// exact bundle bytes, published beside it at /serve.mjs.sig and verified
// against the key below before anything runs or is swapped in.
//
// The value is the RAW 32-byte ed25519 public key, base64 (44 chars). Empty
// means signing is not provisioned yet: the channel then behaves exactly as it
// did before signing existed (TLS-only), so filling this in is the single
// switch that arms verification everywhere.
//
// TODO(founder): generate the pair once and paste the public half here:
//   openssl genpkey -algorithm ed25519 -out sundial-update.key
//   openssl pkey -in sundial-update.key -pubout -outform DER | tail -c 32 | base64
// Keep sundial-update.key with the other signing material (never in the repo)
// and point ~/.config/sundial-signing.env at it:
//   export SUNDIAL_UPDATE_SIGNING_KEY_FILE="$HOME/.config/sundial-update.key"
// The release/web build then publishes the signature via
// scripts/sign-serve-bundle.mjs (wired into `pnpm build:serve-bundle`), which
// REFUSES to build once this key is set but the private half is missing —
// shipping an unsigned bundle against an armed client would break every
// install.
export const UPDATE_PUBLIC_KEY = '';
