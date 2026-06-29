const questionPool = Object.create(null);
const audioQuestionPool = Object.create(null);
const ttsAudioCache = new Map();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MODELS = 'gpt-5.4';
const AI_MODELS_SOURCE =
  process.env.AI_MODELS ||
  process.env.AITUNNEL_MODELS ||
  process.env.OPENAI_MODELS ||
  process.env.AI_MODEL ||
  process.env.AITUNNEL_MODEL ||
  process.env.OPENAI_MODEL ||
  DEFAULT_MODELS;
const AITUNNEL_MODELS = AI_MODELS_SOURCE
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);

const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_API_KEY ||
  process.env.ELEVENLABS_KEY ||
  process.env.ELEVENLABS_API_TOKEN ||
  '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const TTS_CACHE_LIMIT = Number(process.env.TTS_CACHE_LIMIT || 180);
const TTS_DISK_CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(os.tmpdir(), 'see-escape-tts-cache');
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45_000);
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 30_000);

const TOPIC_RULES = {
  'Infinitiv mit zu': `Verwende NUR Verben, die "zu + Infinitiv" verlangen: versuchen, beginnen, anfangen, aufhören, vorhaben, hoffen, vergessen, planen, sich freuen, Lust haben, Es ist wichtig/möglich/schwer... NIEMALS Modalverben (können, müssen, sollen, wollen, dürfen, mögen) — diese stehen mit Infinitiv OHNE "zu"! Richtig: "Er versucht, den Bahnhof zu finden." | Falsch: "Er kann den Bahnhof zu finden."`,

  'Modalverben': `Modalverben: können, müssen, sollen, wollen, dürfen, mögen/möchten. Modalverb auf Position 2, Infinitiv am Satzende OHNE "zu"! Richtig: "Er kann den Bahnhof finden." | Falsch: "Er kann den Bahnhof zu finden."`,

  'Perfekt': `sein + Partizip II bei: Bewegungsverben (gehen→ist gegangen, fahren→ist gefahren, kommen→ist gekommen, fliegen→ist geflogen, laufen→ist gelaufen), Zustandsänderung (einschlafen→ist eingeschlafen, aufwachen, sterben, werden, bleiben). haben + Partizip II bei ALLEN anderen Verben (machen→hat gemacht, essen→hat gegessen, lesen→hat gelesen). Partizip II: ge-...-t (regelmäßig: gemacht, gekauft), ge-...-en (unregelmäßig: gegangen, geschrieben). Verben auf -ieren: KEIN ge- (studiert, telefoniert). Trennbare: ge- zwischen Präfix und Stamm (ein·ge·kauft, auf·ge·standen). Untrennbare (be-, er-, ver-, ent-, zer-, emp-, miss-): KEIN ge- (besucht, verstanden, erzählt).`,

  'Präteritum': `Regelmäßig: Stamm + -te/-test/-te/-ten/-tet/-ten (machte, sagtest). Unregelmäßig: Stammvokalwechsel OHNE -te (gehen→ging, sehen→sah, nehmen→nahm, schreiben→schrieb, lesen→las, sprechen→sprach). Mischverben: Vokalwechsel + -te (bringen→brachte, denken→dachte, kennen→kannte, wissen→wusste).`,

  'Dativ': `Dativpräpositionen: mit, nach, bei, seit, von, zu, aus, gegenüber, ab. Dativverben: helfen, danken, gehören, gefallen, schmecken, passen, gratulieren, antworten, folgen. Formen: dem (m/n), der (f), den + -n (Pl). ein→einem (m/n), eine→einer (f).`,

  'Akkusativ': `Akkusativpräpositionen: durch, für, gegen, ohne, um. Formen: den (m), die (f), das (n), die (Pl). ein→einen (m), eine (f), ein (n). Transitive Verben: sehen, kaufen, essen, trinken, lesen, schreiben, brauchen, haben, finden.`,

  'Genitiv': `Genitivpräpositionen: wegen, trotz, während, innerhalb, außerhalb, statt/anstatt. Maskulin/Neutrum: des/eines + Nomen mit -(e)s (des Mannes, eines Kindes). Feminin: der/einer + Nomen OHNE Endung (der Frau, einer Studentin). Plural: der + Nomen OHNE Endung (der Kinder).`,

  'Adjektivdeklination': `Nach bestimmtem Artikel (der/die/das): -e (Nom. Sg. alle Genera), -en (alle anderen Fälle). Nach unbestimmtem Artikel (ein/kein/mein): -er (Nom.m), -es (Nom./Akk.n), -e (Nom./Akk.f), -en (alle anderen). Ohne Artikel: starke Endungen — Signalendungen des bestimmten Artikels: -er (m.Nom), -e (f.Nom/Akk), -es (n.Nom/Akk), -en (Dat/Gen), -em (m/n.Dat). Richtig: "ein alter Mann" (m.Nom), "mit dem alten Mann" (m.Dat) | Falsch: "ein alten Mann", "mit dem alter Mann"`,

  'Wechselpräpositionen': `an, auf, hinter, in, neben, über, unter, vor, zwischen. Wohin? (Bewegung/Richtung) → Akkusativ: "Ich stelle das Buch auf den Tisch." (stellen, legen, setzen, hängen) Wo? (Position/Ort) → Dativ: "Das Buch steht auf dem Tisch." (stehen, liegen, sitzen, hängen)`,

  'Negation': `"nicht" verneint: Verben, Adjektive, Adverbien, Präpositionalphrasen. Position: vor dem verneinten Element. "kein/keine/keinen/keinem/keiner" ersetzt unbestimmten Artikel oder Nullartikel + Nomen. Richtig: "Ich habe kein Auto." | Falsch: "Ich habe nicht Auto." Richtig: "Ich komme nicht aus Berlin." | Falsch: "Ich komme kein aus Berlin."`,

  'Wortstellung im Hauptsatz': `Finites Verb IMMER auf Position 2! Inversion bei Adverb/Objekt auf Pos.1: Verb Pos.2, Subjekt Pos.3. Richtig: "Gestern ging ich ins Kino." | Falsch: "Gestern ich ging ins Kino."`,

  'Wortstellung im Nebensatz': `Nach Konjunktion (weil, dass, wenn, ob, als, nachdem, obwohl): finites Verb am SATZENDE. Richtig: "Ich weiß, dass er morgen kommt." | Falsch: "Ich weiß, dass er kommt morgen." Perfekt im Nebensatz: "..., weil er nach Hause gegangen ist." (Hilfsverb am Ende!)`,

  'dass-Sätze': `"dass" + Nebensatzwortstellung (Verb am Ende). Richtig: "Ich glaube, dass er recht hat." | Falsch: "Ich glaube, dass er hat recht."`,

  'weil-Sätze': `"weil" + Nebensatzwortstellung (Verb am Ende). Richtig: "Ich bleibe zu Hause, weil ich krank bin." | Falsch: "Ich bleibe zu Hause, weil ich bin krank."`,

  'wenn-Sätze': `"wenn" + Verb am Ende. Hauptsatz nach wenn-Satz: Verb auf Position 1. Richtig: "Wenn es regnet, bleibe ich zu Hause." | Falsch: "Wenn es regnet, ich bleibe zu Hause."`,

  'Relativsätze': `Relativpronomen: Genus/Numerus vom BEZUGSWORT, aber Kasus von der FUNKTION im Nebensatz! Bestimme den Kasus: Was ist die Rolle des Relativpronomens im Nebensatz? Subjekt→Nom, direktes Objekt→Akk, indirektes Objekt→Dat. Nom: der/die/das/die. Akk: den/die/das/die. Dat: dem/der/dem/denen. Gen: dessen/deren. Richtig: "Der Turm, den man sehen kann" (Akk! weil: man sieht DEN Turm). Falsch: "Der Turm, dem man sehen kann." Richtig: "Der Mann, dem ich helfe" (Dat! weil: ich helfe DEM Mann). Verb am Ende des Relativsatzes!`,

  'Konjunktiv II': `Irreale Wünsche, höfliche Bitten, Ratschläge. würde + Infinitiv (Standard). Eigene Formen: wäre, hätte, könnte, müsste, sollte, dürfte, wüsste, käme, ginge, bräuchte. Richtig: "Wenn ich reich wäre, würde ich reisen." | Falsch: "Wenn ich reich würde sein..."`,

  'Passiv': `Vorgangspassiv: werden + Partizip II. "Das Buch wird gelesen." Zustandspassiv: sein + Partizip II. "Das Fenster ist geöffnet." Agens: von + Dativ. Präteritum: wurde + P.II. Perfekt: ist + P.II + worden.`,

  'Präsens': `Konjugation: -e, -st, -t, -en, -t, -en. Stammvokalwechsel (2./3. Sg.): e→i (sprechen→spricht, helfen→hilft), e→ie (lesen→liest, sehen→sieht), a→ä (fahren→fährt, schlafen→schläft). Verben auf -ten/-den: Bindevokal -e- (du arbeitest, er arbeitet).`,

  'Futur I': `werden + Infinitiv. werden: werde, wirst, wird, werden, werdet, werden. Richtig: "Ich werde morgen kommen." | Falsch: "Ich werde morgen zu kommen."`,

  'Imperativ': `du: Stamm (+e optional): "Komm!", "Mach!". e→i/ie bleibt: "Sprich!", "Lies!", "Nimm!" (KEIN -st, KEIN Pronomen). a→ä fällt weg: "Fahr!" (nicht "Fähr!"). ihr: wie Präsens ohne "ihr": "Kommt!", "Lest!". Sie: Infinitiv + Sie: "Kommen Sie!", "Lesen Sie!"`,

  'Artikel': `Bestimmt: der (m), die (f), das (n), die (Pl). Unbestimmt: ein (m/n), eine (f). Genus-Regeln: -ung/-heit/-keit/-schaft/-tion/-tät → die. -chen/-lein → das. -er/-ling → oft der.`,

  'Nominativ': `Subjekt im Nominativ. Prädikativ nach sein/werden/bleiben ebenfalls Nominativ. Richtig: "Der Mann ist ein guter Lehrer." | Falsch: "Der Mann ist einen guten Lehrer."`,
};

function aiKey() {
  return process.env.AITUNNEL_API_KEY ||
    process.env.AI_TUNNEL_API_KEY ||
    process.env.AITUNNEL_TOKEN ||
    process.env.OPENAI_API_KEY ||
    process.env.AI_API_KEY ||
    '';
}

function usesAiTunnel() {
  return Boolean(process.env.AITUNNEL_API_KEY || process.env.AI_TUNNEL_API_KEY || process.env.AITUNNEL_TOKEN);
}

function aiBaseUrl() {
  if (process.env.AI_BASE_URL) return process.env.AI_BASE_URL.replace(/\/$/, '');
  if (process.env.OPENAI_BASE_URL) return process.env.OPENAI_BASE_URL.replace(/\/$/, '');
  return usesAiTunnel() ? 'https://api.aitunnel.ru/v1' : 'https://api.openai.com/v1';
}

function aiProvider() {
  if (usesAiTunnel()) return 'aitunnel';
  if (aiKey()) return 'openai-compatible';
  return 'fallback';
}

function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function isValidQuestion(question) {
  return Boolean(
    question &&
    typeof question.text === 'string' &&
    typeof question.display === 'string' &&
    Array.isArray(question.options) &&
    question.options.length === 4 &&
    typeof question.correct === 'number' &&
    question.correct >= 0 &&
    question.correct <= 3
  );
}

function normalizeAnswerText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[„“"']/g, '')
    .trim()
    .toLowerCase();
}

function answerLetterToIndex(letter) {
  return ['A', 'B', 'C', 'D'].indexOf(String(letter || '').trim().toUpperCase());
}

function normalizeTopicKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U')
    .replace(/ae/gi, 'a').replace(/oe/gi, 'o').replace(/ue/gi, 'u')
    .replace(/saetze/gi, 'satze')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

function topicRuleFor(grammarTopic) {
  const target = normalizeTopicKey(grammarTopic);
  const entry = Object.entries(TOPIC_RULES).find(([key]) => normalizeTopicKey(key) === target);
  return entry ? entry[1] : '';
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function parseSyntheticQuestions(rawText, expectedCount) {
  const text = String(rawText || '').replace(/\r/g, '').trim();
  const solutionMarker = text.match(/\n\s*(?:={2,}\s*)?(?:LÖSUNGEN|LOESUNGEN|ANTWORTEN|SCHLÜSSEL|SCHLUESSEL|KEYS)(?:\s*={2,})?\s*\n/i);
  if (!solutionMarker) return [];

  const tasksText = text.slice(0, solutionMarker.index).replace(/^\s*(?:={2,}\s*)?AUFGABEN(?:\s*={2,})?\s*/i, '').trim();
  const keysText = text.slice(solutionMarker.index + solutionMarker[0].length).trim();
  const keyMap = new Map();
  const keyRegex = /(?:^|\n)\s*(\d{1,2})\s*[\.\):=-]\s*([ABCD])(?:\s*=\s*(.+?))?\s*(?=\n|$)/gi;
  let keyMatch;
  while ((keyMatch = keyRegex.exec(keysText))) {
    const number = Number(keyMatch[1]);
    const index = answerLetterToIndex(keyMatch[2]);
    if (number > 0 && index >= 0) {
      keyMap.set(number, {
        index,
        answerText: keyMatch[3] ? keyMatch[3].trim() : '',
      });
    }
  }

  const blocks = tasksText
    .split(/\n(?=\s*\d{1,2}\.\s+)/)
    .map((block) => block.trim())
    .filter(Boolean);

  const parsed = [];
  for (const block of blocks) {
    const numberMatch = block.match(/^\s*(\d{1,2})\.\s*(.*)$/m);
    if (!numberMatch) continue;

    const number = Number(numberMatch[1]);
    const key = keyMap.get(number);
    if (!key) continue;

    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const optionLines = [];
    const bodyLines = [];
    for (const line of lines) {
      const optionMatch = line.match(/^([ABCD])[\)\.:]\s*(.+)$/i);
      if (optionMatch) {
        optionLines.push({
          label: optionMatch[1].toUpperCase(),
          value: optionMatch[2].trim(),
        });
      } else if (!/^\d{1,2}\.\s*$/.test(line)) {
        bodyLines.push(line.replace(/^\d{1,2}\.\s*/, '').trim());
      }
    }

    if (optionLines.length !== 4) continue;
    const orderedOptions = ['A', 'B', 'C', 'D'].map((label) => optionLines.find((option) => option.label === label)?.value || '');
    if (orderedOptions.some((option) => !option)) continue;
    if (new Set(orderedOptions.map(normalizeAnswerText)).size !== 4) continue;

    if (key.answerText) {
      const keyText = normalizeAnswerText(key.answerText);
      const optionText = normalizeAnswerText(orderedOptions[key.index]);
      if (keyText && keyText !== optionText) continue;
    }

    const instructionLine = bodyLines.find((line) => /^Anweisung\s*:/i.test(line));
    const displayLine = bodyLines.find((line) => /^(Satz|Aufgabe|Wörter|Woerter)\s*:/i.test(line));
    const instruction = instructionLine
      ? instructionLine.replace(/^Anweisung\s*:\s*/i, '').trim()
      : 'Выбери правильный вариант.';
    const display = displayLine
      ? displayLine.replace(/^(Satz|Aufgabe|Wörter|Woerter)\s*:\s*/i, '').trim()
      : bodyLines.filter((line) => !/^Anweisung\s*:/i.test(line))[0];

    const question = {
      text: instruction,
      display,
      options: orderedOptions,
      correct: key.index,
    };

    if (isValidQuestion(question)) parsed.push(question);
    if (parsed.length >= expectedCount) break;
  }

  return parsed;
}

function parseJsonQuestions(rawText) {
  const text = String(rawText || '').trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  const jsonStr = jsonMatch ? jsonMatch[0] : text;
  const parsed = JSON.parse(jsonStr);
  return Array.isArray(parsed) ? parsed.filter(isValidQuestion) : [];
}

function stripOuterQuotes(value) {
  return String(value || '')
    .replace(/^[\s"'`«»„“”]+|[\s"'`«»„“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAudioPairs(rawText, expectedCount) {
  const text = String(rawText || '')
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
    .trim();
  const chunks = text
    .split(/\n+|(?=\s*\d{1,2}[\).]\s+)/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const line = chunk.replace(/^\s*(?:[-*•]\s*)?(?:\d{1,2}[\).:-]\s*)?/, '').trim();
    if (!line || /^(paare|pairs|sätze|saetze|sentences|antworten|translations)/i.test(line)) continue;

    let match = line.match(/^(?:DE|Deutsch|Original)\s*:\s*(.+?)\s*(?:RU|Russisch|Russian|Русский|Перевод)\s*:\s*(.+)$/i);
    if (!match) match = line.match(/^(.+?)\s*(?:—|–|->|=>|\|)\s*(.+)$/);
    if (!match) match = line.match(/^(.+?)\s+-\s+(.+)$/);
    if (!match) match = line.match(/^(.+?)\s*:\s*(.+)$/);
    if (!match) continue;

    const de = stripOuterQuotes(match[1]);
    const ru = stripOuterQuotes(match[2]);
    if (!de || !ru) continue;
    if (/[А-Яа-яЁё]/.test(de)) continue;
    if (!/[А-Яа-яЁё]/.test(ru)) continue;
    if (de.length < 8 || ru.length < 8 || de.length > 220 || ru.length > 220) continue;

    const key = normalizeAnswerText(de);
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ de, ru });
    if (parsed.length >= expectedCount) break;
  }
  return parsed;
}

function buildRussianDistractors(correct, allPairs) {
  const base = stripOuterQuotes(correct).replace(/\s+/g, ' ');
  const normalizedCorrect = normalizeAnswerText(base);
  const options = [];
  const add = (value) => {
    const option = stripOuterQuotes(value).replace(/\s+/g, ' ');
    if (!option) return;
    const norm = normalizeAnswerText(option);
    if (!norm || norm === normalizedCorrect) return;
    if (options.some((existing) => normalizeAnswerText(existing) === norm)) return;
    options.push(option);
  };

  const swaps = [
    ['может', 'должен'], ['должен', 'может'], ['могу', 'должен'],
    ['покупаю', 'продаю'], ['купить', 'продать'], ['купил', 'продал'],
    ['прибывает', 'отправляется'], ['пришел', 'ушел'], ['пришла', 'ушла'],
    ['оставил', 'положил'], ['оставила', 'положила'], ['стоит', 'лежит'],
    ['лежит', 'стоит'], ['поставил', 'положил'], ['положил', 'поставил'],
    ['знаю', 'умею'], ['умею', 'знаю'], ['получил', 'стал'],
    ['к врачу', 'в аптеку'], ['в аптеку', 'к врачу'], ['на столе', 'в столе'],
    ['в городе', 'за городом'], ['к станции', 'на станции'], ['на станции', 'к станции'],
  ];

  for (const [from, to] of swaps) {
    const re = new RegExp(`(^|[\\s,.;:!?("«])(${from})(?=$|[\\s,.;:!?)"»])`, 'iu');
    if (re.test(base)) add(base.replace(re, `$1${to}`));
  }

  const neighbors = (allPairs || [])
    .map((pair) => pair.ru)
    .filter(Boolean)
    .sort((a, b) => Math.abs(a.length - base.length) - Math.abs(b.length - base.length));
  for (const neighbor of neighbors) add(neighbor);

  return options.slice(0, 3);
}

function formatAudioQuestion(pair, allPairs, level, lexicalTopic) {
  const distractors = buildRussianDistractors(pair.ru, allPairs);
  if (distractors.length < 3) return null;
  const correctAnswer = stripOuterQuotes(pair.ru);
  const options = shuffle([correctAnswer, ...distractors]).slice(0, 4);
  const correct = options.findIndex((option) => normalizeAnswerText(option) === normalizeAnswerText(correctAnswer));
  if (correct < 0) return null;
  if (new Set(options.map(normalizeAnswerText)).size !== 4) return null;

  return {
    mode: 'audio',
    level,
    topic: lexicalTopic || 'Audio',
    text: 'Прослушай немецкое предложение и выбери точный русский перевод.',
    display: 'Немецкая фраза звучит вслух. Выбери перевод на грибе.',
    audioText: pair.de,
    options,
    correct,
  };
}

function normalizeAudioQuestion(raw, level, lexicalTopic) {
  if (!raw || typeof raw !== 'object') return null;
  const audioText = stripOuterQuotes(raw.audioText || raw.audio || raw.de || raw.satz || raw.sentence);
  if (!audioText || /[А-Яа-яЁё]/.test(audioText)) return null;

  const options = Array.isArray(raw.options)
    ? raw.options.map((option) => stripOuterQuotes(option)).filter(Boolean)
    : [];
  if (options.length !== 4 || options.some((option) => !/[А-Яа-яЁё]/.test(option))) return null;

  let correct = typeof raw.correct === 'number' ? raw.correct : Number.NaN;
  if (!Number.isInteger(correct)) correct = answerLetterToIndex(raw.correct);
  if (correct < 0 && raw.correctAnswer) {
    const correctAnswer = normalizeAnswerText(raw.correctAnswer);
    correct = options.findIndex((option) => normalizeAnswerText(option) === correctAnswer);
  }
  if (!Number.isInteger(correct) || correct < 0 || correct > 3) return null;
  if (new Set(options.map(normalizeAnswerText)).size !== 4) return null;

  const question = {
    mode: 'audio',
    level,
    topic: lexicalTopic || 'Audio',
    text: raw.text || 'Прослушай немецкое предложение и выбери точный русский перевод.',
    display: raw.display || 'Немецкая фраза звучит вслух. Выбери перевод на грибе.',
    audioText,
    options,
    correct,
  };
  return isValidQuestion(question) ? question : null;
}

function parseJsonAudioQuestions(rawText, expectedCount, level, lexicalTopic) {
  const text = String(rawText || '').trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  const jsonStr = jsonMatch ? jsonMatch[0] : text;
  const parsed = JSON.parse(jsonStr);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => normalizeAudioQuestion(item, level, lexicalTopic))
    .filter(Boolean)
    .slice(0, expectedCount);
}

function buildSyntheticPrompt({ level, lexicalTopic, grammarTopic, isWortstellung, questionsCount, exclude, topicRule }) {
  {
    const ruleBlock = topicRule ? `\nSpezifische Regel fuer "${grammarTopic}":\n${topicRule}\n` : '';
    const excludeBlock = exclude && exclude.length
      ? `\nVerwende diese Saetze nicht erneut: ${exclude.slice(-10).map((item) => `"${item}"`).join(', ')}\n`
      : '';
    const kind = isWortstellung
      ? 'Wortstellungsuebungen. Die Aufgabe-Zeile enthaelt durcheinander gebrachte Woerter oder Satzteile.'
      : 'Lueckenuebungen. Die Aufgabe-Zeile enthaelt einen deutschen Satz mit genau einer Luecke ___.';

    return `Du bist ein erfahrener DaF-Lehrer und erstellst Multiple-Choice-Uebungen.

Erstelle genau ${questionsCount} deutsche Grammatikuebungen.
Niveau: ${level}. Verwende keine Grammatik und keinen Wortschatz ueber ${level}.
Grammatikthema: ${grammarTopic}.
Lexikalisches Thema: ${lexicalTopic || 'frei'}.
Uebungstyp: ${kind}
${ruleBlock}${excludeBlock}
Qualitaetsregeln:
1. Jede Aufgabe hat genau vier Antwortmoeglichkeiten A, B, C, D.
2. Genau eine Antwort ist grammatisch korrekt.
3. Die falschen Antworten sind plausibel, aber eindeutig falsch.
4. Die richtige Antwort muss absolut korrekt sein. Wenn du unsicher bist, formuliere die Aufgabe neu.
5. Loese jede deiner Aufgaben selbst und schreibe die Schluessel erst nach der Selbstpruefung.
6. In den Loesungen muss der Buchstabe und der exakte Text der richtigen Option stehen.
7. Keine abgeschnittenen Saetze. Keine Erklaerungen. Kein JSON. Kein Markdown.

Ausgabeformat, exakt so:
AUFGABEN
1. Anweisung: Waehle die richtige Option.
Satz: ...
A) ...
B) ...
C) ...
D) ...

2. Anweisung: Waehle die richtige Option.
Satz: ...
A) ...
B) ...
C) ...
D) ...

LOESUNGEN
1: A = exakter Text der Option A
2: C = exakter Text der Option C

Schreibe jetzt den vollstaendigen Block mit ${questionsCount} Aufgaben und danach den Loesungen.`;
  }

  const topicPart = topicRule ? `\nSpezifische Regel fuer "${grammarTopic}":\n${topicRule}\n` : '';
  const excludePart = exclude && exclude.length
    ? `\nVerwende diese Saetze nicht erneut: ${exclude.slice(-10).map((item) => `"${item}"`).join(', ')}\n`
    : '';
  const taskKind = isWortstellung
    ? 'Wortstellungsuebungen. Die Aufgabe-Zeile enthaelt durcheinander gebrachte Woerter oder Satzteile.'
    : 'Lueckenuebungen. Die Aufgabe-Zeile enthaelt einen deutschen Satz mit genau einer Luecke ___.';

  return `Du bist ein erfahrener DaF-Lehrer und erstellst Multiple-Choice-Uebungen.

Erstelle genau ${questionsCount} deutsche Grammatikuebungen.
Niveau: ${level}. Verwende keine Grammatik und keinen Wortschatz ueber ${level}.
Grammatikthema: ${grammarTopic}.
Lexikalisches Thema: ${lexicalTopic || 'frei'}.
Uebungstyp: ${taskKind}
${topicPart}${excludePart}
Qualitaetsregeln:
1. Jede Aufgabe hat genau vier Antwortmoeglichkeiten A, B, C, D.
2. Genau eine Antwort ist grammatisch korrekt.
3. Die falschen Antworten sind plausibel, aber eindeutig falsch.
4. Die richtige Antwort muss absolut korrekt sein. Wenn du unsicher bist, formuliere die Aufgabe neu.
5. Loese jede deiner Aufgaben selbst und schreibe die Schluessel erst nach der Selbstpruefung.
6. In den Loesungen muss der Buchstabe und der exakte Text der richtigen Option stehen.
7. Keine abgeschnittenen Saetze. Keine Erklaerungen. Kein JSON. Kein Markdown.

Ausgabeformat, exakt so:
AUFGABEN
1. Anweisung: Выбери правильный вариант.
Satz: ...
A) ...
B) ...
C) ...
D) ...

2. Anweisung: Выбери правильный вариант.
Satz: ...
A) ...
B) ...
C) ...
D) ...

LOESUNGEN
1: A = exact text of option A
2: C = exact text of option C

Now write the full block with ${questionsCount} tasks and then the solutions.`;
}

function buildAudioPrompt({ level, lexicalTopic, questionsCount, exclude }) {
  const excludePart = exclude && exclude.length
    ? `\nDo not reuse these German sentences: ${exclude.slice(-12).map((item) => `"${item}"`).join(', ')}\n`
    : '';

  return `You are an experienced DaF teacher building listening-comprehension tasks with strong, fair distractors.

Create exactly ${questionsCount} short German listening tasks with one exact Russian translation and three wrong Russian options.
Level: ${level}. Do not use grammar or vocabulary above ${level}.
Lexical topic: ${lexicalTopic || 'Alltag'}.
${excludePart}
Rules:
1. Every German sentence is natural, complete, and 6 to 14 words long.
2. The correct Russian option is an exact translation.
3. Wrong options are realistic learner traps: similar word field, separable prefix, modal verb, preposition, case relation, movement direction, false friend, or verb valency.
4. All four options are Russian, similarly short, plausible, and distinct.

Output only a JSON array, no Markdown:
[
  {
    "audioText": "Ich hole das Rezept in der Apotheke ab.",
    "options": [
      "Я забираю рецепт в аптеке.",
      "Я отдаю рецепт в аптеке.",
      "Я забираю чек в аптеке.",
      "Я забираю рецепт у врача."
    ],
    "correct": 0
  }
]

Write exactly ${questionsCount} objects now.`;
}

async function requestAiText(prompt, maxTokens) {
  const key = aiKey();
  if (!key) {
    const error = new Error('AI API key is not configured. Set AITUNNEL_API_KEY, AI_TUNNEL_API_KEY, OPENAI_API_KEY, or AI_API_KEY.');
    error.statusCode = 503;
    throw error;
  }

  const errors = [];
  for (const model of AITUNNEL_MODELS) {
    try {
      const response = await fetchWithTimeout(`${aiBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      }, AI_TIMEOUT_MS);

      const bodyText = await response.text();
      if (!response.ok) {
        errors.push(`${model}: HTTP ${response.status} ${bodyText.slice(0, 220)}`);
        continue;
      }

      const data = JSON.parse(bodyText);
      const content = data.choices?.[0]?.message?.content;
      if (content && content.trim()) return content.trim();
      errors.push(`${model}: empty response`);
    } catch (error) {
      errors.push(`${model}: ${error?.name === 'AbortError' ? `timeout after ${AI_TIMEOUT_MS}ms` : error?.message || String(error)}`);
    }
  }

  const error = new Error(`AI generation failed via ${aiProvider()}: ${errors.join(' | ')}`);
  error.statusCode = 502;
  throw error;
}

function putTtsCache(key, entry) {
  if (ttsAudioCache.has(key)) ttsAudioCache.delete(key);
  ttsAudioCache.set(key, entry);
  while (ttsAudioCache.size > TTS_CACHE_LIMIT) {
    const oldestKey = ttsAudioCache.keys().next().value;
    ttsAudioCache.delete(oldestKey);
  }
}

function ttsDiskPath(cacheKey) {
  const hash = crypto.createHash('sha256').update(cacheKey).digest('hex');
  return path.join(TTS_DISK_CACHE_DIR, `${hash}.mp3`);
}

function readTtsDiskCache(cacheKey) {
  try {
    const filePath = ttsDiskPath(cacheKey);
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    if (!buffer.length) return null;
    const entry = { buffer, contentType: 'audio/mpeg' };
    putTtsCache(cacheKey, entry);
    return entry;
  } catch (error) {
    console.warn('TTS disk cache read failed:', error?.message || error);
    return null;
  }
}

function writeTtsDiskCache(cacheKey, buffer) {
  try {
    fs.mkdirSync(TTS_DISK_CACHE_DIR, { recursive: true });
    fs.writeFileSync(ttsDiskPath(cacheKey), buffer);
  } catch (error) {
    console.warn('TTS disk cache write failed:', error?.message || error);
  }
}

function installQuizRoutes(app) {
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/quiz/status', (_req, res) => {
    res.json({
      ok: true,
      generationConfigured: Boolean(aiKey()),
      ttsConfigured: Boolean(ELEVENLABS_API_KEY),
      aiProvider: aiProvider(),
      aiBaseUrl: aiBaseUrl(),
      models: AITUNNEL_MODELS,
      ttsProvider: ELEVENLABS_API_KEY ? 'elevenlabs' : 'browser-fallback',
      ttsVoiceId: ELEVENLABS_VOICE_ID,
      ttsModelId: ELEVENLABS_MODEL_ID,
      ttsDiskCache: TTS_DISK_CACHE_DIR,
    });
  });

  app.post('/api/generate-questions', async (req, res) => {
    const { level, lexicalTopic, grammarTopic, isWortstellung, count, exclude } = req.body || {};
    if (!level || !grammarTopic) {
      return res.status(400).json({ error: 'level and grammarTopic are required' });
    }

    const questionsCount = Math.max(1, Math.min(20, Number(count) || 10));
    const cacheKey = `${level}:${grammarTopic}:${lexicalTopic || ''}:${isWortstellung ? 'w' : 'g'}`;
    if (questionPool[cacheKey] && questionPool[cacheKey].length >= questionsCount) {
      return res.json({ questions: questionPool[cacheKey].splice(0, questionsCount) });
    }

    const prompt = buildSyntheticPrompt({
      level,
      lexicalTopic,
      grammarTopic,
      isWortstellung,
      questionsCount,
      exclude: Array.isArray(exclude) ? exclude : [],
      topicRule: topicRuleFor(grammarTopic),
    });

    try {
      const text = await requestAiText(prompt, 8192);
      const valid = parseSyntheticQuestions(text, questionsCount);
      if (!valid.length) {
        return res.status(502).json({ error: 'No valid synthetic questions in LLM response' });
      }

      if (valid.length > questionsCount) {
        if (!questionPool[cacheKey]) questionPool[cacheKey] = [];
        questionPool[cacheKey].push(...valid.slice(questionsCount));
      }

      res.json({ questions: valid.slice(0, questionsCount) });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message || 'Failed to generate questions' });
    }
  });

  app.post('/api/generate-audio-questions', async (req, res) => {
    const { level, lexicalTopic, count, exclude } = req.body || {};
    if (!level) return res.status(400).json({ error: 'level is required' });

    const questionsCount = Math.max(1, Math.min(20, Number(count) || 10));
    const cacheKey = `audio:${level}:${lexicalTopic || ''}`;
    if (audioQuestionPool[cacheKey] && audioQuestionPool[cacheKey].length >= questionsCount) {
      return res.json({ questions: audioQuestionPool[cacheKey].splice(0, questionsCount) });
    }

    const prompt = buildAudioPrompt({
      level,
      lexicalTopic,
      questionsCount: Math.max(questionsCount, 10),
      exclude: Array.isArray(exclude) ? exclude : [],
    });

    try {
      const text = await requestAiText(prompt, 4096);
      let valid = [];
      try {
        valid = parseJsonAudioQuestions(text, Math.max(questionsCount, 10), level, lexicalTopic);
      } catch (_) {
        valid = [];
      }

      if (!valid.length) {
        const pairs = parseAudioPairs(text, Math.max(questionsCount, 10));
        valid = pairs.map((pair) => formatAudioQuestion(pair, pairs, level, lexicalTopic)).filter(isValidQuestion);
      }
      if (!valid.length) {
        return res.status(502).json({ error: 'No valid audio questions in LLM response' });
      }

      if (valid.length > questionsCount) {
        if (!audioQuestionPool[cacheKey]) audioQuestionPool[cacheKey] = [];
        audioQuestionPool[cacheKey].push(...valid.slice(questionsCount));
      }

      res.json({ questions: valid.slice(0, questionsCount) });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message || 'Failed to generate audio questions' });
    }
  });

  app.post('/api/tts', async (req, res) => {
    const text = String(req.body?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > 420) return res.status(400).json({ error: 'text is too long' });
    if (!ELEVENLABS_API_KEY) {
      return res.status(503).json({ error: 'ELEVENLABS_API_KEY is not configured' });
    }

    const cacheKey = `${ELEVENLABS_VOICE_ID}:${ELEVENLABS_MODEL_ID}:${text}`;
    const cached = ttsAudioCache.get(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-TTS-Cache', 'HIT');
      return res.send(cached.buffer);
    }
    const diskCached = readTtsDiskCache(cacheKey);
    if (diskCached) {
      res.setHeader('Content-Type', diskCached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-TTS-Cache', 'DISK');
      return res.send(diskCached.buffer);
    }

    try {
      const ttsResponse = await fetchWithTimeout(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`, {
        method: 'POST',
        headers: {
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: ELEVENLABS_MODEL_ID,
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75,
            use_speaker_boost: true,
          },
        }),
      }, TTS_TIMEOUT_MS);

      if (!ttsResponse.ok) {
        const detail = await ttsResponse.text().catch(() => '');
        return res.status(502).json({ error: 'ElevenLabs TTS failed', detail: detail.slice(0, 500) });
      }

      const contentType = ttsResponse.headers.get('content-type') || 'audio/mpeg';
      const buffer = Buffer.from(await ttsResponse.arrayBuffer());
      if (!buffer.length) return res.status(502).json({ error: 'ElevenLabs returned empty audio' });

      putTtsCache(cacheKey, { buffer, contentType });
      writeTtsDiskCache(cacheKey, buffer);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-TTS-Cache', 'MISS');
      res.send(buffer);
    } catch (error) {
      res.status(502).json({
        error: 'ElevenLabs TTS request failed',
        detail: error?.name === 'AbortError' ? `timeout after ${TTS_TIMEOUT_MS}ms` : error?.message || String(error),
      });
    }
  });
}

module.exports = { installQuizRoutes };
