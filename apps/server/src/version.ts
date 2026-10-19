import { readFileSync } from 'node:fs';

/** Installed server package version, valid in source and bundled distributions. */
export const applicationVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
