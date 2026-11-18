<!--
SPDX-FileCopyrightText: 2026 Jasman-Studio
SPDX-License-Identifier: Apache-2.0
-->

# Security

To report a vulnerability, use a private channel with the maintainer. A
supported-version policy has yet to be established. Do not post
credentials, party links, personal media, logs or exploitable details publicly.
For local evaluation, restrict access and stop use of an affected component
while investigating; do not expose an unverified build to the internet.

## Required v1 controls

The coordinator owns authorization. Host, TV and guest permissions are distinct.
Setup and host approval require short-lived one-use console codes; pairing also
requires a distinct claim secret and host approval. Pairing a replacement TV
revokes the previous TV. Tokens expire and are checked on every request, including
retries. A guest display name does not establish identity, and browser-based
blocking cannot prevent a person from joining in another browser.

Use TLS and same-origin web controls. Treat HTTP as an explicit local-risk
choice. Keep library credentials in an access-restricted coordinator store and
TV credentials out of backups. Do not log tokens, codes, configured addresses,
messages or uploads. Revoke access through local console recovery if a host or
TV credential is exposed; renew or end a party if its join link is shared too
widely. Rotate library credentials at their provider if they are exposed.

Uploads must authenticate and enforce limits before buffering, accept only
verified still-image formats, bound decoding work and remove metadata through
fresh encoding. Never serve uploads as a public directory. Render user text as
text, validate provider destinations, deny cross-origin redirects and keep
provider errors out of responses and logs. Use isolated mock providers when verifying these controls.

## Release verification

Evaluate role separation, pairing, expiry/revocation, repeated commands, upload
limits, sanitization and deletion with isolated mocks and generated media. Audit
source, dependencies, workflows and packaged artifacts separately. A source scan
alone does not verify runtime security or certify an artifact.
