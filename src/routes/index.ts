import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { catalogRoutes } from './catalog';
import { discoveryRoutes } from './discovery';
import { metaRoutes } from './meta';
import { trackRoutes } from './track';

/** Register every route group on the app. */
export const registerRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(metaRoutes);
  await app.register(trackRoutes);
  await app.register(catalogRoutes);
  await app.register(discoveryRoutes);
};
