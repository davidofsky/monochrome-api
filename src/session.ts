import { launch } from 'cloakbrowser';
import type { Browser, Page } from 'playwright-core';
import { z } from 'zod';
import { config } from './config';
import { logger } from './logger';
import { GEEKED_TRACK_API, MONOCHROME_URL, TIDAL_API } from './constants';

const log = logger.child({ mod: 'session' });

export const PlaybackResource = z
  .object({
    source: z.string(),
    url: z.url(),
    mime_type: z.string().nullish(),
    codec: z.string().nullish(),
    container: z.string().nullish(),
    quality: z.string().nullish(),
    bit_depth: z.number().nullish(),
    sample_rate_hz: z.number().nullish(),
    encryption: z.unknown().nullish(),
  })
  .loose();
export type PlaybackResource = z.infer<typeof PlaybackResource>;

const GeekedTrackResponse = z
  .object({
    playback: z.array(PlaybackResource).default([]),
    sources: z
      .array(
        z.object({
          source: z.string(),
          status: z.string().optional(),
          error: z.object({ message: z.string().optional() }).nullish(),
        }),
      )
      .default([]),
  })
  .loose();

export interface GetTrackParams {
  track: string;
  artist?: string | undefined;
  album?: string | undefined;
  isrc?: string | undefined;
  duration?: number | undefined;
  quality?: 'LOSSLESS' | 'HI_RES_LOSSLESS';
  retries?: number;
  retryDelayMs?: number;
}

export class NoSourceError extends Error {
  override readonly name = 'NoSourceError';
  constructor(message: string) {
    super(message);
  }
}

export interface TidalResult<T = unknown> {
  status: number;
  json: T;
}

export class Session {
  #browser: Browser | null = null;
  #page: Page | null = null;
  #refreshing: Promise<void> | null = null;

  get #activePage(): Page {
    if (!this.#page) throw new Error('Session not started');
    return this.#page;
  }

  async start(): Promise<this> {
    log.info('starting stealth browser session');
    const args = config.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
    this.#browser = await launch(args.length ? { args } : {});
    this.#page = await this.#browser.newPage();
    await this.#activePage.goto(MONOCHROME_URL);
    await this.#waitForTokens();
    log.info('session ready (turnstile jwt + tidal token acquired)');
    return this;
  }

  async #waitForTokens(): Promise<void> {
    await this.#activePage.waitForFunction(
      () =>
        localStorage.getItem('unified-playback-turnstile-jwt') !== null &&
        localStorage.getItem('hifi_token') !== null,
      null,
      { timeout: 20000 },
    );
  }

  async #refreshTokens(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      try {
        log.debug('refreshing tokens (clear + reload)');

        // Remove the tokens first, otherwise no new tokens are received
        await this.#activePage.evaluate(() => {
          localStorage.removeItem('hifi_token');
          localStorage.removeItem('hifi_token_expiry');
          localStorage.removeItem('unified-playback-turnstile-jwt');
        });
        await this.#activePage.goto(MONOCHROME_URL);
        await this.#waitForTokens();
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async tidalToken(): Promise<string> {
    const { tok, exp } = await this.#activePage.evaluate(() => ({
      tok: localStorage.getItem('hifi_token'),
      exp: Number(localStorage.getItem('hifi_token_expiry')) || 0,
    }));
    if (tok && (exp === 0 || exp - Date.now() > 60_000)) return tok;

    log.debug('tidal token missing/expiring, re-minting');
    await this.#refreshTokens();
    const refreshed = await this.#activePage.evaluate(() => localStorage.getItem('hifi_token'));
    if (!refreshed) throw new Error('Failed to obtain Tidal token');
    return refreshed;
  }

  async #ensureFreshTurnstileJwt(): Promise<void> {
    const jwt = await this.#activePage.evaluate(() => localStorage.getItem('unified-playback-turnstile-jwt'));
    let valid = false;
    if (jwt) {
      try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64').toString());
        valid = typeof payload.exp === 'number' && payload.exp * 1000 - Date.now() > 60_000;
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      log.debug('turnstile jwt missing/expiring, re-minting');
      await this.#refreshTokens();
    }
  }

  async tidalGet<T = unknown>(path: string, params: Record<string, string> = {}): Promise<TidalResult<T>> {
    const usp = new URLSearchParams({ countryCode: config.TIDAL_COUNTRY, ...params });
    const url = `${TIDAL_API}${path}?${usp.toString()}`;

    const call = async (): Promise<TidalResult<T>> => {
      const token = await this.tidalToken();
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      return { status: res.status, json: json as T };
    };

    let result = await call();
    // A stored-valid token can still be rejected (Tidal revoked/rotated it early). Force a re-mint and retry once.
    if (result.status === 401) {
      log.debug({ path }, 'tidal 401, re-minting token and retrying');
      await this.#refreshTokens();
      result = await call();
    }
    log.debug({ path, status: result.status }, 'tidal request');
    return result;
  }

  async getTrack(params: GetTrackParams): Promise<PlaybackResource> {
    const { track, artist, album, isrc, duration, quality = 'LOSSLESS', retries = 3, retryDelayMs = 2000 } = params;

    await this.#ensureFreshTurnstileJwt();

    // A quality ladder is used just like monochrome.tf does. If a certain quality doesnt work -> try a lower tier
    const qLadder = quality === 'HI_RES_LOSSLESS' ? ['HI_RES_LOSSLESS', 'LOSSLESS'] : ['LOSSLESS', 'HI_RES_LOSSLESS'];

    const buildUrl = (q: string): string => {
      const usp = new URLSearchParams({ track, quality: q, intent: 'stream' });
      if (artist) usp.set('artist', artist);
      if (album) usp.set('album', album);
      if (isrc) usp.set('isrc', isrc);
      if (duration) usp.set('duration', String(duration));
      return `${GEEKED_TRACK_API}?${usp.toString()}`;
    };

    let lastReasons = '';
    let reminted = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      for (const q of qLadder) {
        const { status, body } = await this.#activePage.evaluate(
          async ({ url, apiKey }) => {
            const jwt = localStorage.getItem('unified-playback-turnstile-jwt');
            const res = await fetch(url, {
              headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'x-turnstile-jwt': jwt ?? '' },
            });
            return { status: res.status, body: await res.text() };
          },
          { url: buildUrl(q), apiKey: config.GEEKED_API_KEY },
        );

        // geeked rejects a stale/revoked turnstile jwt with 401 (not a source failure). The jwt can be
        // revoked before its time-expiry, so re-mint once and retry with a fresh token.
        if (status === 401 && !reminted) {
          log.debug('geeked 401 (invalid turnstile jwt), re-minting and retrying');
          reminted = true;
          await this.#refreshTokens();
          continue;
        }

        const data = GeekedTrackResponse.parse(JSON.parse(body));
        const resource = data.playback[0];
        if (status === 200 && resource) {
          // The 'mono' source (tracks.monochrome.tf) is a token-gated URL only a browser <audio>
          // element can play — it 403s any server-side fetch. Skip it and keep looking for a
          // fetchable source (amazon/tidal), which usually appears on a different quality tier.
          if (resource.source === 'mono') {
            lastReasons = `mono[${q}]: not server-fetchable`;
            continue;
          }
          log.debug({ track, isrc, quality: q, source: resource.source, attempt }, 'resolved playable source');
          return resource;
        }
        lastReasons = data.sources.map((s) => `${s.source}[${q}]: ${s.error?.message ?? s.status}`).join('; ');
      }
      log.debug({ track, isrc, attempt, retries }, 'no source on any tier, retrying');
      if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs));
    }

    throw new NoSourceError(`No playable source after ${retries} attempts${lastReasons ? ` — ${lastReasons}` : ''}`);
  }

  async close(): Promise<void> {
    if (this.#browser) {
      await this.#browser.close();
      this.#browser = null;
      this.#page = null;
    }
  }
}
