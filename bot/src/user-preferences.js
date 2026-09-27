import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeTelegramUserId } from './reports.js';

function validateLanguage(language) {
  if (language !== 'ru' && language !== 'kk') {
    throw new Error('Language must be exactly ru or kk.');
  }
}

export function createUserPreferences({ preferencesFile = resolve('data/user-preferences.json') } = {}) {
  let writeQueue = Promise.resolve();

  async function readPreferences() {
    try {
      const content = await readFile(preferencesFile, 'utf8');
      const preferences = JSON.parse(content);
      if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
        throw new Error('User preferences store must contain a JSON object.');
      }
      for (const [owner, record] of Object.entries(preferences)) {
        normalizeTelegramUserId(owner);
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error('User preferences records must contain a language.');
        }
        validateLanguage(record.language);
      }
      return preferences;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function savePreferences(preferences) {
    await mkdir(dirname(preferencesFile), { recursive: true });
    const temporaryFile = `${preferencesFile}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryFile, 'wx');
      try {
        await file.writeFile(`${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryFile, preferencesFile);
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    async getLanguage(telegramUserId) {
      const owner = normalizeTelegramUserId(telegramUserId);
      await writeQueue;
      return (await readPreferences())[owner]?.language;
    },

    async setLanguage(telegramUserId, language) {
      const owner = normalizeTelegramUserId(telegramUserId);
      validateLanguage(language);
      const operation = writeQueue.then(async () => {
        const preferences = await readPreferences();
        preferences[owner] = { ...preferences[owner], language };
        await savePreferences(preferences);
      });
      writeQueue = operation.catch(() => {});
      return operation;
    },
  };
}

export const userPreferences = createUserPreferences();
