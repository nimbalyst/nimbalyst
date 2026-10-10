/**
 * The allowlist of sites whose links may render as an iframe embed, and the
 * mapping from a page URL to the site's official embed URL. Anything not
 * listed here renders as a preview card, never an iframe.
 *
 * An entry is added only when the site publishes an embed URL meant for
 * third-party pages. The iframe always loads the URL this module builds, never
 * the URL the author wrote, so a crafted link cannot point the frame anywhere
 * off the list.
 *
 * React-free: the renderer and tests import it; it holds no DOM code.
 */

export interface ExternalEmbed {
  /** Stable id, e.g. `youtube`. */
  provider: string;
  /** Human name for menus, e.g. `YouTube video`. */
  contentName: string;
  /** The iframe `src`. Always https and always on `origin`. */
  embedUrl: string;
  /** The only origin the iframe may load. */
  origin: string;
  /** Width / height, used for the frame's aspect ratio. */
  aspectRatio: number;
}

interface EmbedProvider {
  provider: string;
  contentName: string;
  origin: string;
  aspectRatio: number;
  hosts: readonly string[];
  toEmbedUrl: (url: URL) => string | null;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeStartSeconds(url: URL): number | null {
  const raw = url.searchParams.get('t') ?? url.searchParams.get('start');
  if (!raw) return null;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(raw);
  if (!match) return null;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

const PROVIDERS: readonly EmbedProvider[] = [
  {
    provider: 'youtube',
    contentName: 'YouTube video',
    // The no-cookie host is the official privacy-enhanced player.
    origin: 'https://www.youtube-nocookie.com',
    aspectRatio: 16 / 9,
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
    toEmbedUrl: (url) => {
      const segments = url.pathname.split('/').filter(Boolean);
      let id: string | null = null;
      if (url.hostname === 'youtu.be') id = segments[0] ?? null;
      else if (segments[0] === 'watch') id = url.searchParams.get('v');
      else if (['embed', 'shorts', 'live', 'v'].includes(segments[0] ?? '')) id = segments[1] ?? null;
      if (!id || !YOUTUBE_ID.test(id)) return null;
      const start = youtubeStartSeconds(url);
      return `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`;
    },
  },
  {
    provider: 'vimeo',
    contentName: 'Vimeo video',
    origin: 'https://player.vimeo.com',
    aspectRatio: 16 / 9,
    hosts: ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'],
    toEmbedUrl: (url) => {
      const id = url.pathname.split('/').filter(Boolean).find((segment) => /^\d{5,12}$/.test(segment));
      return id ? `https://player.vimeo.com/video/${id}` : null;
    },
  },
  {
    provider: 'loom',
    contentName: 'Loom video',
    origin: 'https://www.loom.com',
    aspectRatio: 16 / 9,
    hosts: ['loom.com', 'www.loom.com'],
    toEmbedUrl: (url) => {
      const [kind, id] = url.pathname.split('/').filter(Boolean);
      if ((kind !== 'share' && kind !== 'embed') || !id || !/^[0-9a-f]{32}$/i.test(id)) return null;
      return `https://www.loom.com/embed/${id}`;
    },
  },
  {
    provider: 'figma',
    contentName: 'Figma file',
    origin: 'https://www.figma.com',
    aspectRatio: 4 / 3,
    hosts: ['figma.com', 'www.figma.com'],
    toEmbedUrl: (url) => {
      const [kind, key] = url.pathname.split('/').filter(Boolean);
      if (!['file', 'design', 'proto', 'board', 'slides'].includes(kind ?? '') || !key || !/^[0-9A-Za-z]{10,128}$/.test(key)) return null;
      // Figma's embed takes the page URL; rebuild it from the parsed parts so
      // nothing but a figma.com https URL is ever passed along.
      const page = `https://www.figma.com${url.pathname}${url.search}`;
      return `https://www.figma.com/embed?embed_host=nimbalyst&url=${encodeURIComponent(page)}`;
    },
  },
];

/** Parse an http(s) URL; anything else (relative, `javascript:`, `file:`) is null. */
export function parseWebUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url;
}

/** The embed for an allowlisted page URL, or null when the URL is not on the list. */
export function resolveExternalEmbed(raw: string): ExternalEmbed | null {
  const url = parseWebUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const provider = PROVIDERS.find((candidate) => candidate.hosts.includes(host));
  if (!provider) return null;
  const embedUrl = provider.toEmbedUrl(url);
  if (!embedUrl || !embedUrl.startsWith(`${provider.origin}/`)) return null;
  return {
    provider: provider.provider,
    contentName: provider.contentName,
    embedUrl,
    origin: provider.origin,
    aspectRatio: provider.aspectRatio,
  };
}

/** The providers on the list, for menus. */
export const EXTERNAL_EMBED_PROVIDERS: ReadonlyArray<{ provider: string; contentName: string }> =
  PROVIDERS.map(({ provider, contentName }) => ({ provider, contentName }));

/** Every origin an embed iframe may load, for CSP `frame-src`. */
export const EXTERNAL_EMBED_ORIGINS: readonly string[] = PROVIDERS.map((provider) => provider.origin);
