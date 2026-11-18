# Provider boundary

Both adapters implement the operations in `contract/adapter-interface.ts` using
an injected Fetch transport. The coordinator maps provider IDs to random persistent
opaque IDs, scopes them to a fresh library namespace and never returns provider
addresses, credentials, raw IDs, file paths or arbitrary stream URLs.

OpenSubsonic uses salted token authentication and `ping`, `getPlaylists`,
`getPlaylist`, `getSong`, `search3` and raw `stream`. Playlist listing is sliced
into local cursor pages because `getPlaylists` returns a complete list. Selected
playlists are complete responses and are refused above 5,000 entries. Search
requests zero artists/albums and at most 30 library songs. See the official
[API](https://opensubsonic.github.io/docs/opensubsonic-api/),
[playlist](https://opensubsonic.github.io/docs/endpoints/getplaylist/),
[search](https://opensubsonic.github.io/docs/endpoints/search3/) and
[stream](https://opensubsonic.github.io/docs/endpoints/stream/) documentation.

Jellyfin uses an Authorization header and `System/Info`, audio playlists from
`Items`, complete paginated `Playlists/{id}/Items`, library-only audio `Items`
search, membership lookup and static `Audio/{id}/stream`. Static streams request
the existing audio bytes; there is no local transcoding or hardware use. The
official [Items controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/ItemsController.cs),
[Playlists controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/PlaylistsController.cs)
and [Audio controller](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/AudioController.cs)
provide the endpoint reference. Provider compatibility is tested with injected
fixtures rather than a running server. Non-audio tracks are refused.

Provider JSON is limited to 8 MiB per response. Requests have bounded timeouts;
redirects are refused and credentials never follow a different origin. Streams
accept one byte range, including suffix/open-ended forms. A provider 416 remains
416. Revoking a bearer aborts its active upstream requests. Missing media returns
404, without acquisition or online-search fallback. Logs never include provider
responses or request URLs. Unknown gain values use null (unity).
