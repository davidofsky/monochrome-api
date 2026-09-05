import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdQuery, nonEmpty, offset, pageLimit } from '../schemas/common';
import { envelope, relay } from '../reply';

const PagedIdQuery = z.object({ id: nonEmpty.describe('Tidal id'), limit: pageLimit(100), offset });

/** Recommendations, mixes, playlists, and similar-artist/album discovery. */
export const discoveryRoutes: FastifyPluginAsyncZod = async (app) => {
  const { session } = app;

  app.get('/recommendations/', { schema: { summary: 'Track radio', tags: ['discovery'], querystring: IdQuery } }, async (req, reply) => {
    const { status, json } = await session.tidalGet(`/tracks/${req.query.id}/radio`, { limit: '20' });
    return relay(reply, status, json);
  });

  app.get('/mix/', { schema: { summary: 'Mix items', tags: ['discovery'], querystring: IdQuery } }, async (req, reply) => {
    const { status, json } = await session.tidalGet(`/mixes/${req.query.id}/items`, { limit: '100' });
    return relay(reply, status, json);
  });

  app.get('/playlist/', { schema: { summary: 'Playlist + items', tags: ['discovery'], querystring: PagedIdQuery } }, async (req, reply) => {
    const { id, limit, offset: off } = req.query;
    const [meta, items] = await Promise.all([
      session.tidalGet<Record<string, unknown>>(`/playlists/${id}`),
      session.tidalGet<{ items?: unknown[] }>(`/playlists/${id}/items`, { limit: String(limit), offset: String(off) }),
    ]);
    if (meta.status !== 200) return relay(reply, meta.status, meta.json);
    return reply.send(envelope({ ...meta.json, items: items.json.items ?? [] }));
  });

  app.get('/artist/similar/', { schema: { summary: 'Similar artists', tags: ['discovery'], querystring: IdQuery } }, async (req, reply) => {
    const { status, json } = await session.tidalGet(`/artists/${req.query.id}/similar`, { limit: '50' });
    return relay(reply, status, json);
  });

  app.get('/album/similar/', { schema: { summary: 'Similar albums', tags: ['discovery'], querystring: IdQuery } }, async (req, reply) => {
    const { status, json } = await session.tidalGet(`/albums/${req.query.id}/similar`, { limit: '50' });
    return relay(reply, status, json);
  });
};
