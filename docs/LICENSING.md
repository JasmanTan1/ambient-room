<!--
SPDX-FileCopyrightText: 2026 Jasman-Studio
SPDX-License-Identifier: Apache-2.0
-->

# Licensing policy

Ambient Room project source and documentation are copyright 2026
Jasman-Studio and licensed under Apache-2.0. The full license text
is in [LICENSE](../LICENSE). Use Jasman-Studio exactly as the public copyright
holder for original project work covered by this authorization. Preserve the
actual rights holders and terms for third-party material.

## Original files

Use `Copyright 2026 Jasman-Studio` in NOTICE and the LICENSE preamble. Owned file headers use `SPDX-FileCopyrightText: 2026 Jasman-Studio` and
SPDX-License-Identifier: Apache-2.0 in the file's native comment syntax, with
accurate years. A short full Apache boilerplate may be used instead. Markdown
uses an HTML comment; Kotlin, TypeScript and CSS use a block comment; XML places
a comment after the XML declaration; shell files place comments after a shebang.
JSON has no comments: cover original JSON through a matching `.license` sidecar.
Generated/binary files need a sidecar stating provenance and the applicable terms.

Apply corresponding native-syntax headers to owned source files
when they are created or extracted, preserving any valid earlier years and
upstream attribution. The project copyright preamble precedes the complete,
unchanged Apache-2.0 text, including its stock example appendix. Do not alter
upstream license texts.

## Third-party material

Retain upstream headers, copyright statements, license texts, required NOTICE
entries and any modification notices. When modifying third-party code, add a
prominent changed-file statement without replacing its existing attribution.
If a required notice identifies an upstream author, preserve it accurately.
If attribution cannot be reconciled with release privacy requirements, exclude
or replace the component rather than silently changing its author's name.

[THIRD-PARTY](../THIRD-PARTY.md) describes included materials and retained dependency declarations. For every dependency incorporated into a final
artifact, inspect its exact pinned payload and transitives; collect LICENSE,
NOTICE and required attribution into the distribution and its license display.
A package-manager license label is a lead, not the complete notice text. Verify
licenses in build tools and native libraries too. Do not claim that all
transitives share a direct dependency's license.

Outfit remains SIL OFL-1.1, with its upstream copyright and full text preserved
in [OFL-Outfit.txt](../third-party-licenses/OFL-Outfit.txt). No font binary is
included. Unverified scene artwork is excluded. A source asset does not become
Apache-2.0 merely because a project that references it uses that license.

For new artwork, fixtures or generated audio, record who made it, the production
method, redistribution terms and any third-party inputs. Runtime user media is
not contributed to or relicensed by this project.

## Source references

The [Apache-2.0 terms](https://www.apache.org/licenses/LICENSE-2.0.txt) define
redistribution and notice requirements. The [official SIL OFL text](https://openfontlicense.org/open-font-license-official-text/)
defines the font's separate conditions. The included font-license document
retains the original upstream header and text, including its historical links.
