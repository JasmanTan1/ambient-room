<!--
SPDX-FileCopyrightText: 2026 Jasman-Studio
SPDX-License-Identifier: Apache-2.0
-->

# Ambient Room

Ambient Room plays music from a library you configure. The Android TV renderer
handles playback, scenes and timers. The coordinator serves a browser remote
for playlist selection, queue editing, messages, photos and guest requests.
OpenSubsonic and Jellyfin libraries are read-only.

## Run and build

- [Coordinator and web remote](coordinator/README.md) explains setup with Node
  22, library configuration and mock tests.
- [Android TV renderer](tv/README.md) explains the JDK 17 and Android SDK 35
  toolchain, Gradle build, pairing and remote controls.
- [API and fixture contract](ci/contract/contract.md) documents the public v1
  interface. To check the frozen contract and synthetic examples, run
  `python3 -I ci/check.py contract --product bgm --report /tmp/ambient-contract.json`.

See [privacy](PRIVACY.md), [security](SECURITY.md), the
[third-party inventory](THIRD-PARTY.md) and the [license](LICENSE).
