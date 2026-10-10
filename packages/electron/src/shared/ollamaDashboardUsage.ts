import { isUsageRecord, usageTimestamp } from './ollamaUsage';

/** The signed-in dashboard supplies plan utilization and a separate extra-credit wallet. */
export interface OllamaDashboardModel {
  name: string;
  requestCount: number;
}

export interface OllamaDashboardWindow {
  utilization: number;
  resetsAt: string | null;
  models: OllamaDashboardModel[];
  modelCountsAvailable?: boolean;
}

export interface OllamaDashboardSnapshot {
  creditBalanceUSD?: number;
  plan?: string;
  session?: OllamaDashboardWindow;
  weekly?: OllamaDashboardWindow;
  modelCountsPeriod?: 'this-week';
}

export type OllamaDashboardResult =
  | { status: 'ok'; snapshot: OllamaDashboardSnapshot }
  | { status: 'sign-in-required' }
  | { status: 'error'; error: string };

/**
 * Raw extractor contract: { creditBalanceText, planText, session: {utilizationText, resetAt},
 * weekly: {utilizationText, resetAt}, weeklyModels: {sourceLabel, rows:[{nameText,countText}] } }.
 * Values are copied only from the owned Usage credits/session/weekly DOM regions.
 */
export function readOllamaDashboardDOM(doc: Document): unknown {
  const started = performance.now();
  const maxNodes = 10000;
  const maxRows = 256;
  const maxField = 160;
  let scanned = 0;
  let aborted = false;
  const expired = () => {
    if (performance.now() - started > 50) aborted = true;
    return aborted;
  };
  const spend = (units = 1) => {
    scanned += units;
    if (scanned > maxNodes || expired()) aborted = true;
    return !aborted;
  };
  const norm = (value: unknown, limit = maxField): string | null => {
    if (typeof value !== 'string' || value.length > limit) return null;
    const text = value.replace(/\s+/g, ' ').trim();
    return text ? text : null;
  };
  const visible = (element: Element): boolean => {
    let current: Element | null = element;
    let depth = 0;
    while (current) {
      if (!spend() || ++depth > 256) { aborted = true; return false; }
      if (current.hasAttribute('hidden') || current.classList.contains('hidden') || current.hasAttribute('inert')
          || current.getAttribute('aria-hidden') === 'true'
          || /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(current.getAttribute('style') ?? '')
          || /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)/i.test(current.getAttribute('style') ?? '')) return false;
      current = current.parentElement;
    }
    return true;
  };
  const collectElements = (): Element[] | null => {
    const result: Element[] = [];
    const walker = doc.createTreeWalker(doc, 1);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!spend()) return null;
      result.push(node as Element);
    }
    return result;
  };
  const elements = collectElements();
  if (!elements || expired()) return null;
  const idCount = (id: string) => {
    let count = 0;
    for (const element of elements) {
      if (!spend()) return -1;
      if (element.id === id) count++;
    }
    return count;
  };
  const uniqueId = (id: string): Element | null => {
    if (aborted || idCount(id) !== 1) return null;
    const node = doc.getElementById(id);
    return node && visible(node) ? node : null;
  };
  const text = (node: Element | null, limit = maxField): string | null => {
    if (!node) return null;
    const walker = doc.createTreeWalker(node, 4);
    let value = '';
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      if (!spend()) return null;
      const part = textNode.nodeValue ?? '';
      if (value.length + part.length > limit) return null;
      value += part;
    }
    return norm(value, limit);
  };
  const extractWindow = (label: string) => {
    const labels: Element[] = [];
    for (const element of elements) {
      if (!spend()) return null;
      if (element.tagName === 'SPAN' && visible(element) && text(element, 64) === label) labels.push(element);
    }
    if (labels.length !== 1) return null;
    const header = labels[0].parentElement;
    if (!header || header.children.length !== 2 || header.children[0] !== labels[0]) return null;
    const container = header.parentElement;
    if (!container) return null;
    const siblings: Element[] = [];
    for (const child of Array.from(header.children)) {
      if (!spend()) return null;
      if (child !== labels[0]) siblings.push(child);
    }
    if (siblings.length !== 1 || siblings[0].tagName !== 'SPAN') return null;
    const utilizationText = text(siblings[0], 64);
    if (!utilizationText || !/^\d+(?:\.\d+)?% used$/.test(utilizationText)) return null;
    const timers: Element[] = [];
    const localWalker = doc.createTreeWalker(container, 1);
    let local: Node | null;
    while ((local = localWalker.nextNode())) {
      if (!spend()) return null;
      const el = local as Element;
      if (el.hasAttribute('data-time') && visible(el)) timers.push(el);
    }
    if (aborted) return null;
    const resetAt = timers.length === 1 ? norm(timers[0].getAttribute('data-time'), 64) : null;
    return { utilizationText, resetAt };
  };

  const extra = uniqueId('extra-usage');
  const balanceEl = uniqueId('extra-usage-balance');
  let creditBalanceText: string | null = null;
  let planText: string | null = null;
  if (extra && balanceEl && extra.contains(balanceEl)) {
    creditBalanceText = text(balanceEl, 64);
    const headings: Element[] = [];
    for (const element of elements) {
      if (!spend()) break;
      if (element.tagName === 'H2' && extra.contains(element) && visible(element)
          && text(element, 120)?.startsWith('Usage credits')) headings.push(element);
    }
    if (headings.length === 1) {
      if (headings[0].children.length > 16) return null;
      const badges: Element[] = [];
      for (const child of Array.from(headings[0].children)) {
        if (!spend()) break;
        if (child.tagName === 'SPAN') badges.push(child);
      }
      if (badges.length === 1) planText = text(badges[0], 32);
    }
  }
  const session = extractWindow('Session usage');
  const weekly = extractWindow('Weekly usage');
  let weeklyModels: { sourceLabel: string | null; rows: { nameText: string | null; countText: string | null }[] } | null = null;
  const modelsRoot = uniqueId('weekly-usage-models');
  if (modelsRoot && weekly) {
    const weeklyLabels: Element[] = [];
    for (const element of elements) {
      if (!spend()) break;
      if (element.tagName === 'SPAN' && visible(element) && text(element, 64) === 'Weekly usage') weeklyLabels.push(element);
    }
    const weeklyContainer = weeklyLabels.length === 1 ? weeklyLabels[0].parentElement?.parentElement : null;
    if (weeklyContainer?.contains(modelsRoot)) {
      if (modelsRoot.children.length > maxRows + 1) return null;
      const children = Array.from(modelsRoot.children);
      if (children.length >= 1) {
        const sourceLabel = text(children[0], 80);
        const rows: { nameText: string | null; countText: string | null }[] = [];
        let valid = true;
        for (const row of children.slice(1)) {
          if (!spend()) return null;
          if (!visible(row)) continue;
          if (row.children.length !== 3 || row.children[0].tagName !== 'SPAN'
              || row.children[1].tagName !== 'SPAN' || row.children[2].tagName !== 'SPAN') {
            valid = false;
            break;
          }
          rows.push({ nameText: text(row.children[1], 120), countText: text(row.children[2], 64) });
          if (rows.length > maxRows) return null;
        }
        if (valid) weeklyModels = { sourceLabel, rows };
      }
    }
  }
  if (expired() || aborted || scanned > maxNodes) return null;
  return { creditBalanceText, planText, session, weekly, weeklyModels };
}

export function parseOllamaDashboardUsage(raw: unknown): OllamaDashboardSnapshot | null {
  if (!isUsageRecord(raw)) return null;
  const snapshot: OllamaDashboardSnapshot = {};
  const credit = raw.creditBalanceText;
  if (typeof credit === 'string' && credit.length <= 64) {
    const match = /^\$(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d{2}))?$/.exec(credit.trim());
    if (match) {
      const amount = Number(`${match[1].replace(/,/g, '')}.${match[2] ?? '00'}`);
      if (Number.isFinite(amount) && amount >= 0) snapshot.creditBalanceUSD = amount;
    }
  }
  const plan = raw.planText;
  if (typeof plan === 'string' && plan.length <= 32 && ['free', 'pro', 'max', 'team', 'enterprise'].includes(plan.trim())) snapshot.plan = plan.trim();
  const parseWindow = (value: unknown): OllamaDashboardWindow | undefined => {
    if (!isUsageRecord(value) || typeof value.utilizationText !== 'string' || value.utilizationText.length > 64) return undefined;
    const match = /^(\d+(?:\.\d+)?)% used$/.exec(value.utilizationText.trim());
    if (!match) return undefined;
    const utilization = Number(match[1]);
    if (!Number.isFinite(utilization) || utilization < 0 || utilization > 100) return undefined;
    const resetsAt = typeof value.resetAt === 'string' && value.resetAt.length <= 64 && usageTimestamp(value.resetAt) ? value.resetAt : null;
    return { utilization, resetsAt, models: [], modelCountsAvailable: false };
  };
  const session = parseWindow(raw.session);
  const weekly = parseWindow(raw.weekly);
  if (session) snapshot.session = session;
  if (weekly) snapshot.weekly = weekly;
  if (weekly && isUsageRecord(raw.weeklyModels)) {
    const breakdown = raw.weeklyModels;
    const rows = breakdown.rows;
    if (breakdown.sourceLabel === 'Models used this week' && Array.isArray(rows) && rows.length <= 256) {
      const models: OllamaDashboardModel[] = [];
      const names = new Set<string>();
      let valid = true;
      for (const row of rows) {
        if (!isUsageRecord(row) || typeof row.nameText !== 'string' || row.nameText.length > 120
            || typeof row.countText !== 'string' || row.countText.length > 64) { valid = false; break; }
        const name = row.nameText.trim();
        const countMatch = /^(0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+) (request|requests)$/.exec(row.countText.trim());
        const hasControlCharacter = Array.from(name).some(character => {
          const code = character.charCodeAt(0);
          return code <= 31 || (code >= 127 && code <= 159);
        });
        if (!name || name.length > 120 || hasControlCharacter || names.has(name) || !countMatch) { valid = false; break; }
        const requestCount = Number(countMatch[1].replace(/,/g, ''));
        if (!Number.isSafeInteger(requestCount) || requestCount < 0
            || (requestCount === 1) !== (countMatch[2] === 'request')) { valid = false; break; }
        names.add(name);
        models.push({ name, requestCount });
      }
      if (valid) {
        weekly.models = models;
        weekly.modelCountsAvailable = true;
        snapshot.modelCountsPeriod = 'this-week';
      }
    }
  }
  return snapshot.creditBalanceUSD !== undefined || snapshot.session !== undefined || snapshot.weekly !== undefined
    ? snapshot
    : null;
}

export const OLLAMA_DASHBOARD_DOM_SCRIPT = `(${readOllamaDashboardDOM.toString()})(document)`;
