// Talks to LanguageTool's grammar-check API and turns its raw matches into
// a corrected string plus a lightweight issue list for the client.
// Free public endpoint by default; point LANGUAGETOOL_URL at a self-hosted
// instance later without touching the controller or client.

const LANGUAGETOOL_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';
const REQUEST_TIMEOUT_MS = 8000;

async function callLanguageTool(text, language) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(LANGUAGETOOL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text, language }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LanguageTool responded with status ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Applies each match's top suggestion right-to-left so earlier offsets in
// the string are never shifted by an edit made later in the loop.
function applyReplacements(text, matches) {
  const byOffsetDesc = [...matches].sort((a, b) => b.offset - a.offset);
  return byOffsetDesc.reduce((acc, match) => {
    const suggestion = match.replacements?.[0]?.value;
    if (suggestion === undefined) return acc;
    return acc.slice(0, match.offset) + suggestion + acc.slice(match.offset + match.length);
  }, text);
}

/**
 * Never throws. On any LanguageTool failure (timeout, non-2xx, network
 * error), falls back to the original text so the caller always gets a
 * usable result — `corrected: false` signals that the fallback was used.
 * @param {string} text
 * @param {string} [language='en-US']
 * @returns {Promise<{ correctedText: string, issues: Array, corrected: boolean }>}
 */
export async function checkGrammar(text, language = 'en-US') {
  try {
    const { matches = [] } = await callLanguageTool(text, language);
    const issues = matches.map((match) => ({
      message: match.message,
      offset: match.offset,
      length: match.length,
      suggestion: match.replacements?.[0]?.value ?? null,
      ruleId: match.rule?.id ?? null,
    }));
    return { correctedText: applyReplacements(text, matches), issues, corrected: true };
  } catch (err) {
    console.error('LanguageTool request failed, returning original text:', err.message);
    return { correctedText: text, issues: [], corrected: false };
  }
}