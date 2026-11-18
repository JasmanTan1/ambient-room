# Ambient Room coordinator

A standalone, single-room music coordinator with a host web remote, anonymous
guest requests and read-only OpenSubsonic/Jellyfin REST adapters. Configure your
own library. No origin, library endpoint, account, playlist or device is supplied.

## Run locally

Run commands from this directory. Use an existing Node 22 runtime with
`node:sqlite` support.
There are no npm dependencies, package downloads or transpilation steps. The
package lock describes only this package; no retained library version changed.
All server and browser code is native ECMAScript modules.

For photos, supply an existing absolute FFmpeg path. This Linux implementation
uses `/usr/bin/prlimit` to bound the decoder to 1 GiB address space and eight CPU
seconds, with a ten-second elapsed deadline, one thread and no hardware decoding.
FFmpeg is external, not bundled. Without a configured decoder, uploads fail
closed; other room controls still work.

Choose your bind address and port explicitly. Use a fresh, dedicated data directory.
For example, with shell variables you have set yourself:

```sh
node src/main.mjs --listen "$ROOM_BIND" --port "$ROOM_PORT" \
  --data ./ambient-room --ffmpeg "$FFMPEG"
```

The HTTP listener is intended to sit behind your own HTTPS reverse proxy at the
public origin you enter during setup. Serve both the remote and API from that
same origin. The proxy must support binary responses, preserve `Origin`, and
avoid logging authorization headers or bodies. Forwarded client-address headers
are intentionally ignored: address limits use the immediate socket peer.
Set network access restrictions appropriate to your deployment. HTTPS is required
for coordinator and library configuration by default. `--allow-insecure-http`
explicitly permits user-chosen local HTTP origins and library URLs.

Open the coordinator origin. Enter the five-minute console setup code, the exact
coordinator origin and your library configuration. An OpenSubsonic credential is
the library password, used to compose salted token authentication. A Jellyfin
credential is a user access token or a deliberately scoped server API token with
library/playlist access. Use an account limited to the intended music library.
Provider HTTP redirects are refused; enter the final installation base URL.
Installation subpaths are supported; no provider-returned URL is fetched.

After setup, the host remote lists library playlists. Link a playlist explicitly
and choose its scene. Pair a TV using its displayed eight-character code. The host
approval action explicitly confirms replacement of an existing TV. Use the paired
device ID returned to the TV when unpairing through the remote; v1 deliberately
does not expose a device-inventory endpoint. Start playback only after that TV is
connected. See the [TV renderer](../tv/README.md).

Local console commands:

- `setup-code`: replace an expired first-run code before configuration.
- `approve`: issue a new one-use, five-minute host login code.
- `recover`: revoke all host/TV tokens, stop playback, clear photos/guest sessions
  and issue a host code. Saved local playlist orders remain.
- `quit`: close this coordinator cleanly.

The host bearer stays in page memory. Closing the page requires another console
approval. Guest join links use `/guest#t=...`; the page immediately removes the
fragment from history. Guest credentials use only session storage under
`ambient-room.v1.guest.` and are cleared on terminal access errors or local expiry.
The host shares the guest link; the TV can render the same link as a QR code.

## Included behavior

- Host/TV pairing, token expiry/revocation, playback, resume, volume and immutable
  timer IDs. Timer completion clears only its matching timer and continues music.
- Queue next/end/move/remove/reset and **Save local order**. Orders stay in this
  coordinator and never modify upstream playlists or media files.
- Six manual scenes, cleaned Unicode messages, authenticated photos, guest join,
  library search, requests, first-come/take-turns order and host moderation.
- Persisted room/command counters and canonical-body idempotency records.
- Closed request/response schemas, role and room checks before body buffering,
  actor/address limits and same-origin web assets with no third-party requests.

One active TV owns rendering. `GET /v1/state` uses the contract's immediate-response
fallback; clients poll every five seconds instead of repeatedly issuing long polls.
Resume samples do not advance room `seq`; gains have their own `gainRev`.
The TV implements playback looping, timer duck/chime/restore and local deadlines.
Those renderer behaviors are outside this coordinator's implementation.

Library replacement checks connectivity before committing. Because v1 has no
provider-library identity proof, replacement always resets provider mappings,
links, queues, saved local orders, resume, photos and party, even if the URL string
is unchanged. It stops playback without guessing that two libraries are identical.

SQLite stores fresh coordinator state, opaque provider-ID mappings and up to three
re-encoded JPEGs. The dedicated directory has mode 0700 and database 0600. Existing
databases without this schema's application ID/version are refused. There is no
migration or inherited account/database reader. Configuration and credentials are
never returned in status or provider error messages. Backups of runtime data need
the same access restrictions as the original store.

## Verify without library services

```sh
AMBIENT_FFMPEG="$FFMPEG" node --test test/*.test.mjs
```

Tests inject synthetic library transports and generated media. The HTTP tests
bind only an ephemeral local listener created by the test and close it afterward;
no provider service is contacted. Tests create and remove their own `.test-room-*`
directories inside the current working directory. No default browser configuration
is invoked. Photo decode checks explicitly skip if the decoder path is missing.

`contract/openapi.json`, `contract/contract.md` and `adapter-interface.ts` describe
the frozen interface. Tests include its schema and pure transition vectors.
Provider mocks validate request composition, pagination, ownership projections,
range handling, cancellation and generic errors; they do not establish compatibility
with every server version or media codec. Browser rendering, keyboard/accessibility
behavior, TV integration, TLS proxy setup and real providers need separate checks.
