import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { referenceProcedures } from './procedures.js';
import { normalizeTelegramUserId, selectUserReports } from './reports.js';

const demoApplication = {
  trackingNumber: 'KZ-2026-042',
  stage: 'under_review',
  explanation: 'Учебная запись для демонстрации. Это не реальное заявление.',
  updatedAt: '2026-09-25T00:00:00.000Z',
  demoOnly: true,
};

function validateReport(report) {
  if (!Number.isFinite(report.lat) || report.lat < -90 || report.lat > 90) {
    throw new Error('Для сигнала нужны корректные координаты.');
  }
  if (!Number.isFinite(report.lon) || report.lon < -180 || report.lon > 180) {
    throw new Error('Для сигнала нужны корректные координаты.');
  }
  if (!report.description?.trim() || !report.telegramFileId?.trim()) {
    throw new Error('Для сигнала нужны фото и описание.');
  }
}

export function createMockApi({ reportsFile = resolve('data/reports.json') } = {}) {
  let writeQueue = Promise.resolve();

  async function readReports() {
    try {
      const content = await readFile(reportsFile, 'utf8');
      const reports = JSON.parse(content);
      if (!Array.isArray(reports)) throw new Error('DEMO report store must contain a JSON array.');
      return reports;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function saveReports(reports) {
    await mkdir(dirname(reportsFile), { recursive: true });
    const temporaryFile = `${reportsFile}.${randomUUID()}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(reports, null, 2)}\n`, 'utf8');
    await rename(temporaryFile, reportsFile);
  }

  return {
    async createReport(report) {
      validateReport(report);
      const telegramUserId = normalizeTelegramUserId(report.telegramUserId);
      const operation = writeQueue.then(async () => {
        const reports = await readReports();
        const lastNumber = reports.reduce((max, item) => {
          const match = /^DEMO-(\d+)$/.exec(item.id);
          return match ? Math.max(max, Number(match[1])) : max;
        }, 41);
        const created = {
          ...report,
          telegramUserId,
          id: `DEMO-${String(lastNumber + 1).padStart(3, '0')}`,
          status: 'signal_received',
          createdAt: new Date().toISOString(),
          demoOnly: true,
        };
        await saveReports([...reports, created]);
        return { id: created.id, status: created.status, createdAt: created.createdAt, demoOnly: true };
      });
      writeQueue = operation.catch(() => {});
      return operation;
    },

    async listReports(telegramUserId) {
      const owner = normalizeTelegramUserId(telegramUserId);
      await writeQueue;
      return selectUserReports(await readReports(), owner);
    },

    async getApplication(trackingNumber) {
      if (trackingNumber !== demoApplication.trackingNumber) {
        throw new Error('Заявление не найдено. Проверьте номер и попробуйте ещё раз.');
      }
      return structuredClone(demoApplication);
    },

    async listProcedures() {
      return structuredClone(referenceProcedures);
    },
  };
}

export const mockApi = createMockApi();
