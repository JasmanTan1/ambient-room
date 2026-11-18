# Synthetic test media

`geometric.png` is the generated geometric image supplied with the frozen public
contract. It contains no captured photograph or inherited application artwork.

`solid.webp` is a newly generated, single-frame blue 16 × 8 image. It was produced
with the already available CPU FFmpeg encoder, without a source photograph:

```sh
"$FFMPEG" -hide_banner -loglevel error -threads 1 -f lavfi \
  -i color=c=blue:s=16x8 -frames:v 1 -c:v libwebp -threads 1 solid.webp
```

Photo tests generate other pixel data in memory, including deliberately malformed
headers and synthetic orientation metadata. No photo, server address, credential
or personal identity is taken from a real installation.
