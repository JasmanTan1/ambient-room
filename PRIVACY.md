<!--
SPDX-FileCopyrightText: 2026 Jasman-Studio
SPDX-License-Identifier: Apache-2.0
-->

# Privacy

The coordinator stores the library configuration and credential, pairing and
authorization records, playlist links, local queue orders, playback/resume
state, timers, messages and selected photos in its dedicated data directory.
Protect the directory and its backups. Library adapters read playlists and
media without writing changes to the library.

The TV stores its pairing credential and resume counter in app storage
excluded from backup. The host bearer stays in page memory and guest
credentials stay in browser session storage until cleared or expired.
Guest display names and requests are visible to the host for moderation.
A shared party link grants access to the room's guest controls.

Host credentials expire after 12 hours and TV credentials after 30 days.
Pairing approval expires after five minutes. Party access lasts up to 12 hours
and can be renewed or revoked from the host remote. Messages expire after their
selected duration. Photo uploads are resized and re-encoded to remove metadata.
The coordinator keeps the selected photo and at most two recent others.

TV Disconnect clears local pairing and stops playback. Revoke the device from
the host remote to invalidate its coordinator credential and clear room photos.
Removing the coordinator directory and backups removes local configuration,
credentials and playback data. Library media remains on the user's server.

The coordinator uses socket addresses and bearer keys in memory to limit
requests. Bucket counters reset on reuse after the window and stale buckets are
pruned when the map grows. A local console displays short-lived setup and host
approval codes. Keep console output private. Proxy or service infrastructure
can apply its own logging and retention.
