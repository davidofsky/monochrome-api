import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { REPO, VERSION } from '../constants';
import { IdQuery, offset } from '../schemas/common';
import { relay } from '../reply';

// Mirrors hifi-api's /search: tracks use the flat per-type endpoint; everything
// else uses /search/top-hits with a `types` filter (results nested per type).
const SEARCH: Record<'s' | 'a' | 'al' | 'v' | 'p', { path: string; types?: string }> = {
  s: { path: '/search/tracks' },
  a: { path: '/search/top-hits', types: 'ARTISTS,TRACKS' },
  al: { path: '/search/top-hits', types: 'ALBUMS' },
  v: { path: '/search/top-hits', types: 'VIDEOS' },
  p: { path: '/search/top-hits', types: 'PLAYLISTS' },
};

const SearchQuery = z
  .object({
    s: z.string().optional().describe('Track query'),
    a: z.string().optional().describe('Artist query'),
    al: z.string().optional().describe('Album query'),
    v: z.string().optional().describe('Video query'),
    p: z.string().optional().describe('Playlist query'),
    i: z.string().optional().describe('ISRC lookup'),
    offset,
    limit: z.coerce.number().int().min(1).max(500).default(25).describe('Page size (1-500)'),
  })
  .refine((q) => [q.s, q.a, q.al, q.v, q.p, q.i].some(Boolean), {
    message: 'provide one of s (track), a (artist), al (album), v (video), p (playlist) or i (ISRC)',
  });

/** Root, health, and Tidal metadata lookups (track info + search). */
export const metaRoutes: FastifyPluginAsyncZod = async (app) => {
  const { session } = app;

  app.get('/', { schema: { summary: 'Version + repo', tags: ['meta'] } }, async () => ({ version: VERSION, Repo: REPO }));
  app.get('/health', { schema: { summary: 'Liveness check', tags: ['meta'] } }, async () => ({ ok: true }));

  app.get('/info/', { schema: { summary: 'Track info by Tidal id', tags: ['meta'], querystring: IdQuery } }, async (req, reply) => {
    const { status, json } = await session.tidalGet(`/tracks/${req.query.id}`);
    return relay(reply, status, json);
  });

  app.get(
    '/search/',
    { schema: { summary: 'Search tracks/artists/albums/videos/playlists or ISRC', tags: ['meta'], querystring: SearchQuery } },
    async (req, reply) => {
      const q = req.query;
      if (q.i) {
        const { status, json } = await session.tidalGet('/tracks', { isrc: q.i });
        return relay(reply, status, json);
      }
      const key = (['s', 'a', 'al', 'v', 'p'] as const).find((k) => q[k])!;
      const spec = SEARCH[key];
      const params: Record<string, string> = { query: q[key]!, offset: String(q.offset), limit: String(q.limit) };
      if (spec.types) params.types = spec.types;
      const { status, json } = await session.tidalGet(spec.path, params);
      return relay(reply, status, json);
    },
  );
};
