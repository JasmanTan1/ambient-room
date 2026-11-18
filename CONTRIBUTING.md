<!--
SPDX-FileCopyrightText: 2026 Jasman-Studio
SPDX-License-Identifier: Apache-2.0
-->

# Contributing

Submit only work you have authority to contribute. Unless explicitly identified
and accepted under another license, intentional contributions are offered under
Apache-2.0 without additional terms. Copyright remains with the actual rights
holders; contribution does not assign it to a product name.

Preserve existing copyright, license, patent, attribution and NOTICE statements.
Mark modified third-party files prominently and include their original license.
Never apply an original-project header over a third-party notice. Fonts and art
need their own provenance and redistribution terms. Include this evidence with
any proposed asset; otherwise use a simple newly authored geometric replacement
or the platform font. See [the licensing policy](docs/LICENSING.md).

Keep changes within the documented library-playback scope. Include synthetic
fixtures for behavior changes and explain validation and known limits. Tests must
use isolated mock providers and generated media, with no production network,
accounts or devices. Browser tests must name an explicit isolated configuration.
Do not include private configuration, personal identifiers, existing databases,
credentials, signing material, real screenshots or personal media.

Keep retained dependency and toolchain versions unchanged. If a dependency is
unavailable or a change is necessary, describe the exact issue and request a
separate version decision; do not regenerate a lockfile in a way that upgrades
packages silently.
