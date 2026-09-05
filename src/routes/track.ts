import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { VERSION } from '../constants';
import { logger } from '../logger';
import { nonEmpty } from '../schemas/common';
import type { Session } from '../session';

const log = logger.child({ mod: 'track' });

/** hifi-api accepts these quality tiers; we map them onto the geeked resolver. */
const QualityEnum = z.enum(['LOW', 'HIGH', 'LOSSLESS', 'HI_RES', 'HI_RES_LOSSLESS']);

const TrackQuery = z.object({
  id: nonEmpty.describe('Tidal numeric track id'),
  quality: QualityEnum.default('LOSSLESS').describe('Requested audio quality tier'),
  immersiveaudio: z.string().optional(),
});

const StreamParams = z.object({ file: nonEmpty.describe('<tidal-id>.flac') });

/** Tidal track metadata — only the fields we consume. */
const TidalTrack = z
  .object({
    title: z.string(),
    isrc: z.string().nullish(),
    duration: z.number().nullish(),
    artist: z.object({ name: z.string() }).nullish(),
    artists: z.array(z.object({ name: z.string() })).nullish(),
    album: z.object({ title: z.string() }).nullish(),
  })
  .loose();

const geekedQuality = (q: string): 'LOSSLESS' | 'HI_RES_LOSSLESS' => (/HI_?RES/i.test(q) ? 'HI_RES_LOSSLESS' : 'LOSSLESS');

interface Resolved {
  url: string;
  key: string | null; // CENC AES-CTR content key (hex), if encrypted
  quality?: string;
}

// Short-lived cache so /track and the subsequent /stream don't resolve twice.
// Long enough that /stream reuses the resolve /track just did, even across a full album download.
// (Amazon's signed URLs stay valid well beyond this.)
const CACHE_TTL_MS = 600_000;
const cache = new Map<string, Resolved & { ts: number }>();

async function resolvePlayback(session: Session, id: string, quality: string): Promise<Resolved> {
  const meta = await session.tidalGet(`/tracks/${id}`);
  if (meta.status !== 200) throw new Error(`Tidal track ${id} lookup failed (${meta.status})`);
  const t = TidalTrack.parse(meta.json);
  const resource = await session.getTrack({
    track: t.title,
    artist: t.artist?.name ?? t.artists?.[0]?.name,
    album: t.album?.title,
    isrc: t.isrc ?? undefined,
    duration: t.duration ?? undefined,
    quality: geekedQuality(quality),
  });
  const enc = resource.encryption as { key?: { value?: string } } | null | undefined;
  return { url: resource.url, key: enc?.key?.value ?? null, quality: resource.quality ?? undefined };
}

function publicBase(req: FastifyRequest): string {
  return config.PUBLIC_URL ?? `${req.protocol}://${req.host}`;
}

/** Playback: hifi-api-compatible /track manifest + a /stream endpoint that serves decrypted FLAC. */
export const trackRoutes: FastifyPluginAsyncZod = async (app) => {
  const { session } = app;

  app.get(
    '/track/',
    { schema: { summary: 'Track playback manifest (hifi-api BTS)', tags: ['playback'], querystring: TrackQuery } },
    async (req, reply) => {
      const { id, quality } = req.query;
      const resolved = await resolvePlayback(session, id, quality);
      cache.set(id, { ...resolved, ts: Date.now() });

      // BTS manifest whose single URL points at our decrypting /stream endpoint.
      const streamUrl = `${publicBase(req)}/stream/${id}.flac`;
      const manifest = Buffer.from(JSON.stringify({ mimeType: 'audio/flac', urls: [streamUrl] })).toString('base64');

      return reply.send({
        version: VERSION,
        data: {
          trackId: Number(id),
          assetPresentation: 'FULL',
          audioMode: 'STEREO',
          audioQuality: resolved.quality ?? 'LOSSLESS',
          manifestMimeType: 'application/vnd.tidal.bts',
          manifest,
        },
      });
    },
  );

  // Fetch the (CENC-encrypted) source and stream it back as plain FLAC via ffmpeg.
  app.get('/stream/:file', { schema: { summary: 'Decrypted FLAC audio stream', tags: ['playback'], params: StreamParams } }, async (req, reply) => {
    const id = req.params.file.replace(/\.flac$/i, '');
    let entry = cache.get(id);
    if (!entry || Date.now() - entry.ts > CACHE_TTL_MS) {
      const resolved = await resolvePlayback(session, id, 'LOSSLESS');
      entry = { ...resolved, ts: Date.now() };
      cache.set(id, entry);
    }

    const src = await fetch(entry.url, { headers: { 'user-agent': 'Mozilla/5.0', origin: 'https://monochrome.tf' } });
    if (!src.ok || !src.body) return reply.code(502).send({ error: `source fetch failed (${src.status})` });

    // Buffer the encrypted MP4 to a temp file (ffmpeg needs seekable input for fMP4/CENC).
    const tmp = join(tmpdir(), `mono-${id}-${Date.now()}.mp4`);
    await pipeline(Readable.fromWeb(src.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));

    const args = ['-y', '-loglevel', 'error'];
    if (entry.key) args.push('-decryption_key', entry.key);
    args.push('-i', tmp, '-c:a', 'copy', '-f', 'flac', 'pipe:1');
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d.toString()));
    ff.on('close', (code) => {
      void unlink(tmp).catch(() => {});
      if (code !== 0) log.error({ id, code, stderr: stderr.slice(0, 500) }, 'ffmpeg failed');
    });

    reply.header('content-type', 'audio/flac');
    reply.header('content-disposition', `attachment; filename="${id}.flac"`);
    return reply.send(ff.stdout);
  });

  // Unsupported without a real Tidal streaming session / Widevine / video.
  const UNSUPPORTED: Record<string, string> = {
    '/trackManifests/': 'trackManifests not supported; use /track for a playable stream',
    '/widevine': 'Widevine DRM proxy not supported (no Tidal streaming session)',
    '/video/': 'video streaming not supported',
    '/topvideos/': 'video not supported',
  };
  for (const [path, message] of Object.entries(UNSUPPORTED)) {
    app.get(path, { schema: { summary: 'Not supported', tags: ['unsupported'] } }, async (_req, reply) => reply.code(501).send({ error: message }));
  }
};
