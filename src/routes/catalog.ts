import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { VERSION } from '../constants';
import { IdQuery, nonEmpty, offset, pageLimit } from '../schemas/common';
import { envelope, relay } from '../reply';

const AlbumQuery = z.object({ id: nonEmpty.describe('Tidal album id'), limit: pageLimit(100), offset });

const ArtistQuery = z
  .object({
    id: z.string().optional().describe('Artist id (metadata)'),
    f: z.string().optional().describe('Artist id (releases + top tracks)'),
    skip_tracks: z.coerce.boolean().default(false).describe('Omit top tracks when using f'),
    limit: pageLimit(50),
    offset,
  })
  .refine((q) => Boolean(q.id ?? q.f), { message: 'provide id or f' });

const CoverQuery = z
  .object({ id: z.string().optional().describe('Tidal album id'), q: z.string().optional().describe('Album search query') })
  .refine((v) => Boolean(v.id ?? v.q), { message: 'provide id or q' });

function coverUrls(uuid: string | null | undefined): Record<string, string> | null {
  if (!uuid) return null;
  const p = uuid.replace(/-/g, '/');
  return Object.fromEntries([80, 160, 320, 640, 1280].map((s) => [`${s}x${s}`, `https://resources.tidal.com/images/${p}/${s}x${s}.jpg`]));
}

/** Album / artist / cover / lyrics metadata. */
export const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  const { session } = app;

  app.get('/album/', { schema: { summary: 'Album metadata + tracks', tags: ['catalog'], querystring: AlbumQuery } }, async (req, reply) => {
    const { id, limit, offset: off } = req.query;
    const [meta, items] = await Promise.all([
      session.tidalGet<Record<string, unknown>>(`/albums/${id}`),
      session.tidalGet<{ items?: unknown[] }>(`/albums/${id}/items`, { limit: String(limit), offset: String(off) }),
    ]);
    if (meta.status !== 200) return relay(reply, meta.status, meta.json);
    return reply.send(envelope({ ...meta.json, items: items.json.items ?? [] }));
  });

  // Note: /artist/ mirrors hifi-api and does NOT use the {version,data} envelope.
  app.get('/artist/', { schema: { summary: 'Artist metadata (id) or releases (f)', tags: ['catalog'], querystring: ArtistQuery } }, async (req, reply) => {
    const { id, f, skip_tracks, limit, offset: off } = req.query;
    if (f) {
      // hifi-api merges full albums with EPs/singles, deduped by id.
      const [albums, singles] = await Promise.all([
        session.tidalGet<{ items?: { id: number }[] }>(`/artists/${f}/albums`, { limit: String(limit), offset: String(off) }),
        session.tidalGet<{ items?: { id: number }[] }>(`/artists/${f}/albums`, { limit: String(limit), offset: String(off), filter: 'EPSANDSINGLES' }),
      ]);
      const byId = new Map<number, { id: number }>();
      for (const a of [...(albums.json.items ?? []), ...(singles.json.items ?? [])]) byId.set(a.id, a);
      const top = skip_tracks
        ? { json: { items: [] as unknown[] } }
        : await session.tidalGet<{ items?: unknown[] }>(`/artists/${f}/toptracks`, { limit: '20' });
      return reply.send({ version: VERSION, albums: { items: [...byId.values()] }, tracks: top.json.items ?? [] });
    }
    const { status, json } = await session.tidalGet<{ picture?: string | null }>(`/artists/${id}`);
    if (status !== 200) return relay(reply, status, json);
    const cover = json.picture ? `https://resources.tidal.com/images/${json.picture.replace(/-/g, '/')}/750x750.jpg` : null;
    return reply.send({ version: VERSION, artist: json, cover });
  });

  app.get('/cover/', { schema: { summary: 'Album cover URLs (id or q)', tags: ['catalog'], querystring: CoverQuery } }, async (req, reply) => {
    let uuid: string | null | undefined;
    let ctx: { id?: number; title?: string } = {};
    if (req.query.id) {
      const { status, json } = await session.tidalGet<{ id: number; title: string; cover?: string }>(`/albums/${req.query.id}`);
      if (status !== 200) return relay(reply, status, json);
      uuid = json.cover; ctx = { id: json.id, title: json.title };
    } else {
      const { json } = await session.tidalGet<{ items?: { id: number; title: string; cover?: string }[] }>('/search/albums', { query: req.query.q!, limit: '1' });
      const a = json.items?.[0];
      if (!a) return reply.code(404).send({ error: 'no album found' });
      uuid = a.cover; ctx = { id: a.id, title: a.title };
    }
    return reply.send(envelope({ ...ctx, cover: uuid, urls: coverUrls(uuid) }));
  });

  app.get('/lyrics/', { schema: { summary: 'Lyrics by Tidal id (needs r_usr scope)', tags: ['catalog'], querystring: IdQuery } }, async (req, reply) => {
    const { status, json } = await session.tidalGet(`/tracks/${req.query.id}/lyrics`);
    return relay(reply, status, json);
  });
};
