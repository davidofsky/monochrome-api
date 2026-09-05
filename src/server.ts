import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  type ZodTypeProvider,
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { config } from './config';
import { logger } from './logger';
import { REPO, VERSION } from './constants';
import { NoSourceError, Session } from './session';
import { registerRoutes } from './routes/index';

declare module 'fastify' {
  interface FastifyInstance {
    session: Session;
  }
}

export async function startServer(): Promise<void> {
  const session = await new Session().start();

  const app = Fastify({ loggerInstance: logger, ignoreTrailingSlash: true }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('session', session);

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: 'invalid query', issues: err.validation });
    }
    if (err instanceof NoSourceError) return reply.code(502).send({ error: err.message });
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'hifi-api (monochrome-backed)',
        version: VERSION,
        description:
          `hifi-api ${VERSION} compatible surface. Metadata is a faithful Tidal proxy; ` +
          `/track returns a playable stream via the geeked/Amazon resolver (hybrid). Repo: ${REPO}`,
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  await app.register(registerRoutes);

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`Swagger UI: http://localhost:${config.PORT}/docs`);

  const shutdown = async (sig: string): Promise<void> => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    await session.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(sig));
}
