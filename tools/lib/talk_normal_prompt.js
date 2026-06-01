const fs = require('fs');
const os = require('os');
const path = require('path');

const TALK_NORMAL_MARKER = '<!-- talk-normal';
const TALK_NORMAL_FALLBACK_SNIPPET = 'Be direct and informative. No filler, no fluff';

let cachedPrompt = null;

function normalizeString(value) {
  return String(value || '').trim();
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function candidatePromptPaths() {
  const homeDir = process.env.HOME || os.homedir();
  const envPath = normalizeString(process.env.SUNCODEXCLAW_TALK_NORMAL_PROMPT);
  const codexHome = normalizeString(process.env.CODEX_HOME);
  return uniqueStrings([
    envPath,
    codexHome ? path.join(codexHome, 'skills', 'talk-normal', 'prompt.md') : '',
    path.join(homeDir, '.codex', 'skills', 'talk-normal', 'prompt.md'),
  ]);
}

function loadTalkNormalPromptMeta() {
  if (cachedPrompt) return cachedPrompt;

  for (const promptPath of candidatePromptPaths()) {
    try {
      if (!promptPath || !fs.existsSync(promptPath)) continue;
      const text = normalizeString(fs.readFileSync(promptPath, 'utf8'));
      if (!text) continue;
      cachedPrompt = { loaded: true, path: promptPath, text };
      return cachedPrompt;
    } catch (_) {
      // Try the next candidate path.
    }
  }

  cachedPrompt = { loaded: false, path: '', text: '' };
  return cachedPrompt;
}

function promptAlreadyContainsTalkNormal(text) {
  const prompt = normalizeString(text);
  if (!prompt) return false;
  return prompt.includes(TALK_NORMAL_MARKER) || prompt.includes(TALK_NORMAL_FALLBACK_SNIPPET);
}

function mergeTalkNormalPrompt(basePrompt, fallbackPrompt = '') {
  const prompt = normalizeString(basePrompt) || normalizeString(fallbackPrompt);
  const talkNormal = loadTalkNormalPromptMeta();
  if (!talkNormal.loaded || !talkNormal.text) return prompt;
  if (promptAlreadyContainsTalkNormal(prompt)) return prompt;
  return [prompt, talkNormal.text].filter(Boolean).join('\n\n').trim();
}

module.exports = {
  loadTalkNormalPromptMeta,
  mergeTalkNormalPrompt,
};
