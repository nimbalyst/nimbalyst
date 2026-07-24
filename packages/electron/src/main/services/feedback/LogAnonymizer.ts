export interface AnonymizerConfig {
  /** Absolute path to the user's home directory. Replaced with `~`. */
  homeDir: string;
  /** Absolute paths to known workspaces. Each is replaced with `<WORKSPACE>`. */
  workspacePaths?: string[];
}

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const ANTHROPIC_KEY_RE = /\bsk-ant-[A-Za-z0-9_\-]{20,}/g;
const OPENAI_KEY_RE = /\bsk-(?!ant-)[A-Za-z0-9_\-]{20,}/g;
const GITHUB_TOKEN_RE = /\bgh[oprsu]_[A-Za-z0-9]{20,}/g;
const GENERIC_BEARER_RE = /\bBearer\s+[A-Za-z0-9_\-]{20,}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g;
const STYTCH_ID_RE = /\b(session|member|organization|user)-(?:test|live|prod)-[a-z0-9-]{10,}/gi;
const PRIVATE_IPV4_RE = /\b(?:10|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))(?:\.\d{1,3}){2,3}\b/g;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Produce the string forms the same absolute path can take across logs, so a
 * single configured path (e.g. `C:\Users\jane`, the value `os.homedir()` returns
 * on Windows) still matches when a log line renders it differently. Without this
 * the home/workspace replacement is an exact-string match and Windows path
 * variants slip through, leaking the OS username and workspace directory names.
 * Covers: forward-slash (`C:/Users/jane`), Git Bash/MSYS (`/c/Users/jane`),
 * WSL (`/mnt/c/Users/jane`), and JSON-escaped (`C:\\Users\\jane`) forms.
 */
function expandPathVariants(p: string): string[] {
  const variants = new Set<string>([p]);
  const fwd = p.replace(/\\/g, '/');
  const back = p.replace(/\//g, '\\');
  variants.add(fwd);
  variants.add(back);
  variants.add(back.replace(/\\/g, '\\\\')); // JSON-escaped backslashes

  // Windows drive form -> POSIX-ish forms.
  const win = fwd.match(/^([A-Za-z]):\/(.*)$/);
  if (win) {
    const drive = win[1].toLowerCase();
    const rest = win[2];
    variants.add(`/${drive}/${rest}`); // Git Bash / MSYS
    variants.add(`/mnt/${drive}/${rest}`); // WSL
  }

  // POSIX drive form (/c/... or /mnt/c/...) -> Windows forms.
  const nix = fwd.match(/^\/(?:mnt\/)?([A-Za-z])\/(.*)$/);
  if (nix) {
    const drive = nix[1].toUpperCase();
    const rest = nix[2];
    variants.add(`${drive}:/${rest}`);
    variants.add(`${drive}:\\${rest.replace(/\//g, '\\')}`);
  }

  // Drop variants too short to match safely (e.g. a bare drive root).
  return [...variants].filter((v) => v.length >= 4);
}

function buildPathReplacer(paths: string[], replacement: string): (text: string) => string {
  const expanded = [...new Set(paths.filter(Boolean).flatMap(expandPathVariants))];
  if (expanded.length === 0) return (text) => text;
  // Longest first so a workspace path nested under home (or a longer variant)
  // wins over a shorter prefix. Case-insensitive because Windows paths are.
  const sorted = expanded.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(sorted.map(escapeRegExp).join('|'), 'gi');
  return (text) => text.replace(pattern, replacement);
}

export function anonymize(text: string, config: AnonymizerConfig): string {
  if (!text) return text;

  let out = text;

  if (config.workspacePaths && config.workspacePaths.length > 0) {
    out = buildPathReplacer(config.workspacePaths, '<WORKSPACE>')(out);
  }

  if (config.homeDir) {
    out = buildPathReplacer([config.homeDir], '~')(out);
  }

  out = out.replace(ANTHROPIC_KEY_RE, '<REDACTED_KEY>');
  out = out.replace(OPENAI_KEY_RE, '<REDACTED_KEY>');
  out = out.replace(GITHUB_TOKEN_RE, '<REDACTED_KEY>');
  out = out.replace(GENERIC_BEARER_RE, 'Bearer <REDACTED_TOKEN>');
  out = out.replace(JWT_RE, '<REDACTED_JWT>');
  out = out.replace(STYTCH_ID_RE, '<REDACTED_ID>');
  out = out.replace(PRIVATE_IPV4_RE, '<LOCAL_IP>');
  out = out.replace(EMAIL_RE, '<EMAIL>');

  return out;
}
