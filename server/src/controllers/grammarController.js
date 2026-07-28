import { checkGrammar } from '../services/grammarService.js';

// Generous ceiling above the diary's 1000-word cap, just to reject junk payloads early.
const MAX_TEXT_LENGTH = 8000;

export async function checkGrammarHandler(req, res) {
  const { text, language } = req.body || {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'A non-empty "text" field is required.' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(413).json({ error: `Text exceeds ${MAX_TEXT_LENGTH} characters.` });
  }

  try {
    const result = await checkGrammar(text, language);
    return res.json(result);
  } catch (err) {
    // Should be unreachable — checkGrammar() already catches LanguageTool
    // failures internally. Kept as a last-resort safety net so the API
    // contract (correctedText always present) holds even on a bug.
    console.error('Unexpected grammar controller error:', err.message);
    return res.json({ correctedText: text, issues: [], corrected: false });
  }
}