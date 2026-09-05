# monochrome-api

hifi-api backed by monochrome.tf, by mimicking a browser. Drop-in source for `music-yoinker`.

## Run it

```bash
npm install
cp .env.example .env   # optional
npm start              # localhost:3000, docs at /docs
```

You need ffmpeg on PATH (decrypts the mp4 into flac).

Other scripts: `npm run dev`, `npm run typecheck`. There's no build.

## Endpoints

Full list in Swagger at `/docs`. The ones that matter:

- `/search/?s=|a=|al=|v=|p=|i=` search (track/artist/album/video/playlist/isrc)
- `/info/?id=` track info
- `/track/?id=` playback manifest, points at `/stream`
- `/stream/:id.flac` the decrypted flac
- also `/album/`, `/artist/`, `/cover/`, `/lyrics/`, `/recommendations/`, `/mix/`, `/playlist/`, `/artist/similar/`, `/album/similar/`

Config is all in `.env.example`, everything has a default.

## Notes for whoever works on this next

### A few things are done in odd ways for good reasons:

- Metadata and playback come from two different places. Metadata is just a Tidal proxy (`api.tidal.com`, called straight from node). Playback goes through geeked.wtf on monochrome.tf instead. They don't line up by id, so `/track` looks up the Tidal track's isrc and passes that to geeked.

- The browser thing isn't optional. geeked needs a Cloudflare Turnstile token that only shows up in localStorage after monochrome.tf loads. So we keep a cloakbrowser page open (`session.ts`) and do that fetch from inside the page. The Tidal token gets pulled from the same page but used from node directly.

- `/track` doesn't return a real Tidal manifest. The token we have can't pull Tidal streams (401, no session). So `/track` hands back a manifest pointing at our own `/stream`, and `/stream` grabs the encrypted Amazon file and runs it through ffmpeg to get flac. The decryption key is already in the geeked response so there's no license server involved, and ffmpeg handles the cenc so you don't need Bento4.

- If a download works on the website but 502s here, it's probably the quality. geeked breaks per tier, so Amazon LOSSLESS can be dead while HI_RES is fine on the same song. `getTrack` tries the asked-for tier and then the other one. The site defaults to HI_RES which is why it looked fine there.

- The response shapes are inconsistent, but that's copied from hifi-api on purpose. `/search?al` and `?a` nest under `data.albums.items` etc, `?s` is flat `data.items`, and `/artist` skips the `data` wrapper entirely. The client hits several hifi-api sources and expects them identical.
