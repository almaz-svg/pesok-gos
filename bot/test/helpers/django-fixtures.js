// Translate cabinet fixtures into the actual Django wire format. Never infer an owner.
export function djangoReport(report) {
  if (!report) return report;
  return {
    id: report.backendId || '3a0779f6-377e-488a-b738-10639179a75f',
    tracking_number: report.id,
    telegram_user_id: report.telegramUserId,
    description: report.description,
    status: report.status,
    created_at: report.createdAt,
    updated_at: report.updatedAt,
    location: { latitude: report.lat, longitude: report.lon },
    photos: report.telegramFileId ? [{ telegram_file_id: report.telegramFileId }] : [],
    bot_result: {
      language: report.language || 'ru',
      case_passport: report.casePassport,
      location_summary: report.locationSummary,
      land_case_id: report.landCaseId,
    },
  };
}

export function djangoPage(reports, next = null) {
  return { count: reports.length, next, previous: null, results: reports.map(djangoReport) };
}
