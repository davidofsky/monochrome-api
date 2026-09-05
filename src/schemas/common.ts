import { z } from 'zod';

// Shared query-string building blocks used across route modules.

export const nonEmpty = z.string().trim().min(1);
export const offset = z.coerce.number().int().min(0).default(0).describe('Pagination offset');
export const pageLimit = (def: number) => z.coerce.number().int().min(1).max(100).default(def).describe('Page size (1-100)');

/** Single Tidal id — used by /info, /lyrics, /recommendations, /mix and the similar-* routes. */
export const IdQuery = z.object({ id: nonEmpty.describe('Tidal numeric id') });
