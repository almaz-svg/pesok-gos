import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeTelegramUserId } from './reports.js';

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.some(item =>
    !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 8000)) {
    throw new Error('Invalid chat history.');
  }
}

export function createChatHistory({ historyFile = resolve('data/ai-history.json') } = {}) {
  let writeQueue = Promise.resolve();

  async function read() {
    try {
      const rows = JSON.parse(await readFile(historyFile, 'utf8'));
      if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw new Error('Invalid chat store.');
      for (const [owner, messages] of Object.entries(rows)) {
        normalizeTelegramUserId(owner);
        validateMessages(messages);
      }
      return rows;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  return {
    async get(userId) {
      const owner = normalizeTelegramUserId(userId);
      await writeQueue;
      return (await read())[owner] || [];
    },
    async set(userId, messages) {
      const owner = normalizeTelegramUserId(userId);
      validateMessages(messages);
      const retained = messages.slice(-12).map(({ role, content }) => ({ role, content }));
      const operation = writeQueue.then(async () => {
        const rows = await read();
        if (retained.length) rows[owner] = retained;
        else delete rows[owner];
        await mkdir(dirname(historyFile), { recursive: true });
        const temporary = `${historyFile}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(rows), { flag: 'wx' });
          await rename(temporary, historyFile);
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
      });
      writeQueue = operation.catch(() => {});
      return operation;
    },
  };
}

export const chatHistory = createChatHistory();
