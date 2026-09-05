import type { FastifyReply } from 'fastify';
import { VERSION } from './constants';

export const envelope = (data: unknown) => ({ version: VERSION, data });

// Forward upstream Tidal result in the hifi-api envelope, else passthrough. 
export function relay(reply: FastifyReply, status: number, json: unknown) {
  if (status === 200) return reply.send(envelope(json));
  return reply.code(status).send(json);
}
