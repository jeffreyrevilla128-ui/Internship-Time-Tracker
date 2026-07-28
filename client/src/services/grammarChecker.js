const API_BASE = `${import.meta.env.VITE_API_URL}/api`;

/**
 * Never throws for a failed correction — if the request fails outright
 * (network error, server down, unexpected status), falls back to the
 * original text so the caller can always use `correctedText` directly.
 * @param {string} text
 * @param {string} [language='en-US']
 * @returns {Promise<{ correctedText: string, issues: Array, corrected: boolean }>}
 */
export async function checkGrammarViaApi(text, language = 'en-US') {
  try {
    const response = await fetch(`${API_BASE}/grammar/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language }),
    });

    if (!response.ok) {
      throw new Error(`Grammar check request failed (${response.status})`);
    }

    return await response.json();
  } catch (err) {
    console.error('Grammar check unavailable, keeping original text:', err.message);
    return { correctedText: text, issues: [], corrected: false };
  }
}