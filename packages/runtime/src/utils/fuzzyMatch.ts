/**
 * Fuzzy matching utilities with CamelCase and path support
 * Used for document search, file typeaheads, and similar features
 */

export interface FuzzyMatchResult {
  /** Whether the query matches the target */
  matches: boolean;
  /** Score from 0-1, higher is better match. 0 means no match */
  score: number;
  /** Indices of matched characters in the target string for highlighting */
  matchedIndices: number[];
}

/**
 * Perform fuzzy matching with support for:
 * - Substring matching: "bugs" matches "tracker-bugs.md"
 * - CamelCase abbreviation: "ClaCoPro" matches "ClaudeCodeProvider.tsx"
 * - Path segment matching: "elec/rend" matches "packages/electron/src/renderer"
 *
 * @param query - The search query (e.g., "ClaCoPro")
 * @param target - The target string to match against (e.g., "ClaudeCodeProvider.tsx")
 * @returns Match result with score and indices
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatchResult {
  if (!query || !target) {
    return { matches: !query, score: query ? 0 : 1, matchedIndices: [] };
  }

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // Quick check: all non-delimiter query chars must exist in target (in order)
  // Delimiters are stripped because strategies like delimiter-separated matching
  // treat them as separators, not literal characters to match.
  const queryCharsOnly = queryLower.split('').filter(c => !isDelimiter(c)).join('');
  const targetCharsOnly = targetLower.split('').filter(c => !isDelimiter(c)).join('');
  if (!containsAllCharsInOrder(queryCharsOnly, targetCharsOnly)) {
    return { matches: false, score: 0, matchedIndices: [] };
  }

  // Try different matching strategies and return best score
  const strategies = [
    exactSubstringMatch(queryLower, targetLower, target),
    camelCaseMatch(query, target),
    delimiterSeparatedMatch(query, target),
    fuzzySubsequenceMatch(queryLower, targetLower),
  ];

  // Return the best match
  const best = strategies.reduce((a, b) => (b.score > a.score ? b : a));
  return best;
}

/**
 * Check if all characters in query exist in target in order
 */
function containsAllCharsInOrder(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (query[qi] === target[ti]) {
      qi++;
    }
  }
  return qi === query.length;
}

/**
 * Exact substring match - highest priority if found
 */
function exactSubstringMatch(queryLower: string, targetLower: string, target: string): FuzzyMatchResult {
  const index = targetLower.indexOf(queryLower);
  if (index === -1) {
    return { matches: false, score: 0, matchedIndices: [] };
  }

  const matchedIndices = Array.from({ length: queryLower.length }, (_, i) => index + i);

  // Score based on:
  // - Match at start of string or after delimiter: bonus
  // - Match position (earlier is better)
  // - Match length relative to target
  let score = 0.5; // Base score for substring match

  if (index === 0) {
    score += 0.3; // Prefix match bonus
  } else {
    const charBefore = target[index - 1];
    if (isDelimiter(charBefore)) {
      score += 0.2; // Word boundary bonus
    }
  }

  // Length ratio bonus (shorter targets are better matches)
  score += 0.2 * (queryLower.length / targetLower.length);

  return { matches: true, score: Math.min(score, 1), matchedIndices };
}

/**
 * CamelCase matching - "ClaCoPro" matches "ClaudeCodeProvider"
 */
function camelCaseMatch(query: string, target: string): FuzzyMatchResult {
  // Check if query looks like CamelCase abbreviation (multiple capitals)
  const capitals = query.match(/[A-Z]/g);
  if (!capitals || capitals.length < 2) {
    return { matches: false, score: 0, matchedIndices: [] };
  }

  // Extract segments from query based on capital letters
  // "ClaCoPro" -> ["Cla", "Co", "Pro"]
  const querySegments = splitCamelCase(query);
  if (querySegments.length < 2) {
    return { matches: false, score: 0, matchedIndices: [] };
  }

  // Extract CamelCase parts from target
  // "ClaudeCodeProvider" -> ["Claude", "Code", "Provider"]
  const targetParts = splitCamelCase(target);

  // Try to match each query segment to target parts (in order)
  const matchedIndices: number[] = [];
  let partIndex = 0;
  let charOffset = 0;

  // Calculate character offsets for each target part
  const partOffsets: number[] = [];
  let offset = 0;
  for (const part of targetParts) {
    partOffsets.push(offset);
    offset += part.length;
  }

  for (const segment of querySegments) {
    const segmentLower = segment.toLowerCase();
    let found = false;

    // Look for a target part that starts with this segment
    for (let i = partIndex; i < targetParts.length; i++) {
      const partLower = targetParts[i].toLowerCase();
      if (partLower.startsWith(segmentLower)) {
        // Record matched character indices
        const startOffset = partOffsets[i];
        for (let j = 0; j < segment.length; j++) {
          matchedIndices.push(startOffset + j);
        }
        partIndex = i + 1;
        found = true;
        break;
      }
    }

    if (!found) {
      return { matches: false, score: 0, matchedIndices: [] };
    }
  }

  // Score based on:
  // - How many parts matched vs total parts
  // - How complete the segment matches are
  const partCoverage = querySegments.length / targetParts.length;
  const charCoverage = matchedIndices.length / target.length;
  const score = 0.6 + (0.2 * partCoverage) + (0.2 * charCoverage);

  return { matches: true, score: Math.min(score, 1), matchedIndices };
}

/**
 * Delimiter-separated prefix matching - "tra-bug" matches "tracker-bugs"
 * Activates when the query contains delimiters (dashes, underscores, dots, spaces).
 * Splits both query and target on delimiters/CamelCase boundaries, then checks
 * if each query segment is a prefix of a target segment (in order).
 */
function delimiterSeparatedMatch(query: string, target: string): FuzzyMatchResult {
  // Only activate if query contains at least one delimiter
  if (!query.split('').some(isDelimiter)) {
    return { matches: false, score: 0, matchedIndices: [] };
  }

  const querySegments = splitCamelCase(query);
  if (querySegments.length < 2) {
    return { matches: false, score: 0, matchedIndices: [] };
  }

  const targetParts = splitCamelCase(target);

  // Calculate character offsets for each target part in the original string
  // Must account for delimiter characters between parts
  const partOffsets = computePartOffsets(target, targetParts);

  // Match each query segment as prefix of target parts (in order)
  const matchedIndices: number[] = [];
  let partIndex = 0;

  for (const segment of querySegments) {
    const segmentLower = segment.toLowerCase();
    let found = false;

    for (let i = partIndex; i < targetParts.length; i++) {
      const partLower = targetParts[i].toLowerCase();
      if (partLower.startsWith(segmentLower)) {
        const startOffset = partOffsets[i];
        for (let j = 0; j < segment.length; j++) {
          matchedIndices.push(startOffset + j);
        }
        partIndex = i + 1;
        found = true;
        break;
      }
    }

    if (!found) {
      return { matches: false, score: 0, matchedIndices: [] };
    }
  }

  const partCoverage = querySegments.length / targetParts.length;
  const charCoverage = matchedIndices.length / target.length;
  const score = 0.55 + (0.2 * partCoverage) + (0.2 * charCoverage);

  return { matches: true, score: Math.min(score, 0.95), matchedIndices };
}

/**
 * Compute the starting character offset of each part in the original string.
 * splitCamelCase strips delimiters, so we need to find where each part
 * actually starts in the original string.
 */
function computePartOffsets(original: string, parts: string[]): number[] {
  const offsets: number[] = [];
  let searchFrom = 0;

  for (const part of parts) {
    const idx = original.indexOf(part, searchFrom);
    if (idx === -1) {
      // Fallback: try case-insensitive search
      const lowerOriginal = original.toLowerCase();
      const lowerPart = part.toLowerCase();
      const fallbackIdx = lowerOriginal.indexOf(lowerPart, searchFrom);
      offsets.push(fallbackIdx >= 0 ? fallbackIdx : searchFrom);
      searchFrom = (fallbackIdx >= 0 ? fallbackIdx : searchFrom) + part.length;
    } else {
      offsets.push(idx);
      searchFrom = idx + part.length;
    }
  }

  return offsets;
}

/**
 * Split a string into CamelCase parts
 * "ClaudeCodeProvider" -> ["Claude", "Code", "Provider"]
 * "tracker-bugs.md" -> ["tracker", "bugs", "md"]
 */
function splitCamelCase(str: string): string[] {
  // Split on transitions: lowercase->uppercase, or delimiters
  const parts: string[] = [];
  let current = '';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (isDelimiter(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    // Check for CamelCase transition
    if (current && isUpperCase(char) && !isUpperCase(current[current.length - 1])) {
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

/**
 * Fuzzy subsequence match - characters must appear in order but not consecutively
 */
function fuzzySubsequenceMatch(queryLower: string, targetLower: string): FuzzyMatchResult {
  const matchedIndices: number[] = [];
  let qi = 0;
  let consecutiveBonus = 0;
  let lastMatchIndex = -2; // Start before 0 so first match isn't "consecutive"

  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
    if (queryLower[qi] === targetLower[ti]) {
      matchedIndices.push(ti);
      if (ti === lastMatchIndex + 1) {
        consecutiveBonus += 0.05; // Bonus for consecutive matches
      }
      lastMatchIndex = ti;
      qi++;
    }
  }

  if (qi < queryLower.length) {
    return { matches: false, score: 0, matchedIndices: [] };
  }

  // Score based on:
  // - Consecutive character bonus
  // - Position of first match (earlier is better)
  // - Compactness of matches
  const firstMatchBonus = matchedIndices[0] === 0 ? 0.1 : 0;
  const compactness = queryLower.length / (matchedIndices[matchedIndices.length - 1] - matchedIndices[0] + 1);
  const score = 0.2 + consecutiveBonus + firstMatchBonus + (0.2 * compactness);

  return { matches: true, score: Math.min(score, 0.5), matchedIndices }; // Cap at 0.5 since this is weakest match
}

function isUpperCase(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

function isDelimiter(char: string): boolean {
  return char === '-' || char === '_' || char === '.' || char === '/' || char === '\\' || char === ' ';
}

/**
 * Match against a file path, considering both filename and path components
 * Filename matches score higher than path matches
 */
export function fuzzyMatchPath(query: string, filePath: string): FuzzyMatchResult {
  if (!query || !filePath) {
    return { matches: !query, score: query ? 0 : 1, matchedIndices: [] };
  }

  // Split path into parts
  const pathParts = filePath.split('/');
  const filename = pathParts[pathParts.length - 1] || '';

  // Try matching against filename first (higher score)
  const filenameMatch = fuzzyMatch(query, filename);
  if (filenameMatch.matches) {
    // Adjust indices to be relative to full path
    const filenameStart = filePath.length - filename.length;
    const adjustedIndices = filenameMatch.matchedIndices.map(i => i + filenameStart);
    return {
      matches: true,
      score: filenameMatch.score, // Keep full score for filename match
      matchedIndices: adjustedIndices,
    };
  }

  // Try matching against full path (lower score)
  const pathMatch = fuzzyMatch(query, filePath);
  if (pathMatch.matches) {
    return {
      matches: true,
      score: pathMatch.score * 0.7, // Reduce score for path-only match
      matchedIndices: pathMatch.matchedIndices,
    };
  }

  return { matches: false, score: 0, matchedIndices: [] };
}

/**
 * Sort and filter a list of items by fuzzy match score
 * @param items - Array of items to filter
 * @param query - Search query
 * @param getSearchText - Function to extract searchable text from item
 * @param limit - Maximum number of results to return
 * @returns Filtered and sorted array with match info
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getSearchText: (item: T) => string,
  limit?: number
): Array<{ item: T; match: FuzzyMatchResult }> {
  if (!query) {
    const results = items.map(item => ({
      item,
      match: { matches: true, score: 1, matchedIndices: [] } as FuzzyMatchResult,
    }));
    return limit ? results.slice(0, limit) : results;
  }

  const results = items
    .map(item => ({
      item,
      match: fuzzyMatchPath(query, getSearchText(item)),
    }))
    .filter(r => r.match.matches)
    .sort((a, b) => b.match.score - a.match.score);

  return limit ? results.slice(0, limit) : results;
}

/**
 * Filter documents specifically, matching against both name and path
 */
export function fuzzyFilterDocuments<T extends { name: string; path: string }>(
  documents: T[],
  query: string,
  limit?: number
): Array<{ item: T; match: FuzzyMatchResult }> {
  if (!query) {
    const results = documents.map(item => ({
      item,
      match: { matches: true, score: 1, matchedIndices: [] } as FuzzyMatchResult,
    }));
    return limit ? results.slice(0, limit) : results;
  }

  const results = documents
    .map(doc => {
      // Try matching against name first
      const nameMatch = fuzzyMatch(query, doc.name);
      // Try matching against path
      const pathMatch = fuzzyMatchPath(query, doc.path);

      // Use the better match, with name matches getting priority
      const match = nameMatch.score >= pathMatch.score ? nameMatch : pathMatch;

      return { item: doc, match };
    })
    .filter(r => r.match.matches)
    .sort((a, b) => b.match.score - a.match.score);

  return limit ? results.slice(0, limit) : results;
}
