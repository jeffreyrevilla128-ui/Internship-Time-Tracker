import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ---------- formatter ----------

// Lets the speaker dictate punctuation as words. Multi-word phrases are
// listed first so "new paragraph" isn't partially eaten by a "new" rule.
const SPOKEN_PUNCTUATION = [
  [/\bnew paragraph\b/gi, '\n\n'],
  [/\bnew line\b/gi, '\n'],
  [/\bfull stop\b/gi, '.'],
  [/\bexclamation (mark|point)\b/gi, '!'],
  [/\bquestion mark\b/gi, '?'],
  [/\bcomma\b/gi, ','],
  [/\bperiod\b/gi, '.'],
  [/\bcolon\b/gi, ':'],
  [/\bsemicolon\b/gi, ';'],
];

// Weekdays only — no common lowercase homonyms, so this is safe to always
// capitalize. Month names are deliberately excluded ("may", "march",
// "august" are common words too and would misfire constantly).
const WEEKDAY_PATTERN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

function applySpokenPunctuation(text) {
  return SPOKEN_PUNCTUATION.reduce((acc, [pattern, symbol]) => acc.replace(pattern, symbol), text);
}

function applyCapitalizationRules(text) {
  return text
    .replace(/\bi\b/g, 'I')
    .replace(WEEKDAY_PATTERN, (m) => m[0].toUpperCase() + m.slice(1).toLowerCase());
}

function formatFinalChunk(text) {
  if (!text) return '';
  const spaced = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!spaced) return '';
  const withSymbols = applySpokenPunctuation(spaced);
  const punctuated = withSymbols
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])(?=\S)/g, '$1 ')
    .replace(/ {2,}/g, ' ');
  const sentenced = punctuated.replace(
    /(^\s*[a-z])|([.!?]\s+)([a-z])/g,
    (_m, start, sep, letter) => (start ? start.toUpperCase() : sep + letter.toUpperCase())
  );
  return applyCapitalizationRules(sentenced);
}

// insertPeriod: true when a long pause preceded this chunk, so a sentence
// boundary is assumed if the existing text doesn't already end in punctuation.
function appendChunk(existing, chunk, insertPeriod = false) {
  if (!chunk) return existing;
  if (!existing) return chunk;
  if (existing.endsWith('\n')) return existing + chunk;
  const alreadyPunctuated = /[.!?]\s*$/.test(existing);
  if (insertPeriod && !alreadyPunctuated) return `${existing}. ${chunk}`;
  return existing.endsWith(' ') ? existing + chunk : `${existing} ${chunk}`;
}

// ---------- engine ----------

function getCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

const isSpeechRecognitionSupported = () => !!getCtor();

function createWebSpeechEngine(config) {
  const Ctor = getCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  Object.assign(recognition, config);

  const listeners = { start: [], result: [], error: [], end: [] };
  const emit = (event, ...args) => listeners[event].forEach((fn) => fn(...args));

  recognition.onstart = () => emit('start');

  recognition.onresult = (event) => {
    let finalChunk = '';
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalChunk += result[0].transcript;
      else interim += result[0].transcript;
    }
    emit('result', { finalChunk, interim });
  };

  recognition.onerror = (event) => emit('error', event.error);
  recognition.onend = () => emit('end');

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
    destroy: () => {
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      Object.keys(listeners).forEach((key) => (listeners[key] = []));
    },
    on: (event, handler) => listeners[event]?.push(handler),
  };
}

const ERROR_MESSAGES = {
  'no-speech': 'No speech was detected. Please try again.',
  'audio-capture': 'No microphone was found. Please check your device.',
  'not-allowed': 'Microphone access was denied. Please allow microphone permission.',
  'permission-denied': 'Microphone access was denied. Please allow microphone permission.',
  network: 'A network error occurred during speech recognition.',
  aborted: 'Speech recognition was aborted.',
  'service-not-allowed': 'Speech recognition service is not allowed.',
  'language-not-supported': 'The selected language is not supported.',
};

const describeSpeechError = (code) => ERROR_MESSAGES[code] || `Speech recognition error: ${code}`;
const FATAL_ERROR_CODES = new Set(['not-allowed', 'permission-denied', 'audio-capture']);

// ---------- hook ----------
// Usage: const { transcript, isListening, startListening, stopListening } = useSpeechRecognition();

export default function useSpeechRecognition(options = {}) {
  const {
    continuous = true,
    interimResults = true,
    lang = 'en-US',
    maxAlternatives = 1,
    autoRestart = false,
    pauseGapMs = 1500, // silence longer than this before a chunk implies a new sentence
    engineFactory = createWebSpeechEngine,
  } = options;

  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(isSpeechRecognitionSupported);
  const [error, setError] = useState(null);

  const engineRef = useRef(null);
  const isListeningRef = useRef(false);
  const shouldRestartRef = useRef(false);
  const lastFinalAtRef = useRef(null);

  const config = useMemo(
    () => ({ continuous, interimResults, lang, maxAlternatives }),
    [continuous, interimResults, lang, maxAlternatives]
  );

  useEffect(() => {
    const engine = engineFactory(config);
    if (!engine) {
      setIsSupported(false);
      return undefined;
    }
    setIsSupported(true);

    engine.on('result', ({ finalChunk, interim }) => {
      if (finalChunk) {
        const now = Date.now();
        const pauseDetected = lastFinalAtRef.current !== null && now - lastFinalAtRef.current > pauseGapMs;
        lastFinalAtRef.current = now;
        setTranscript((prev) => appendChunk(prev, formatFinalChunk(finalChunk), pauseDetected));
        setInterimTranscript('');
      } else {
        setInterimTranscript(interim);
      }
    });

    engine.on('error', (code) => {
      setError(describeSpeechError(code));
      if (FATAL_ERROR_CODES.has(code)) shouldRestartRef.current = false;
    });

    engine.on('end', () => {
      isListeningRef.current = false;
      setIsListening(false);
      setInterimTranscript('');

      if (shouldRestartRef.current && autoRestart) {
        try {
          engine.start();
          isListeningRef.current = true;
          setIsListening(true);
        } catch {
          setError(describeSpeechError('aborted'));
        }
      }
    });

    engineRef.current = engine;

    return () => {
      shouldRestartRef.current = false;
      engine.stop();
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, engineFactory, autoRestart, pauseGapMs]);

  const startListening = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || isListeningRef.current) return;
    setError(null);
    shouldRestartRef.current = true;
    try {
      engine.start();
      isListeningRef.current = true;
      setIsListening(true);
    } catch {}
  }, []);

  const stopListening = useCallback(() => {
    shouldRestartRef.current = false;
    if (!engineRef.current || !isListeningRef.current) return;
    engineRef.current.stop();
  }, []);

  const toggleListening = useCallback(() => {
    isListeningRef.current ? stopListening() : startListening();
  }, [startListening, stopListening]);

  const resetTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    lastFinalAtRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      engineRef.current?.abort();
    };
  }, []);

  return {
    transcript,
    interimTranscript,
    isListening,
    isSupported,
    error,
    startListening,
    stopListening,
    toggleListening,
    resetTranscript,
  };
}