import { readFileSync } from 'node:fs';

interface PackageJson {
  version: string;
  repository?: string | { url?: string };
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageJson;
const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;

export const VERSION = pkg.version;
export const REPO = (repoUrl ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
export const MONOCHROME_URL = 'https://monochrome.tf';
export const GEEKED_TRACK_API = 'https://music-api.geeked.wtf/api/v2/track/';
export const TIDAL_API = 'https://api.tidal.com/v1';
