/** Map and list endpoints are independent: each layer is filtered from its own DTOs. */
export function filterMonitoringData(
  data,
  { query = '', status = 'ALL', overdueOnly = false } = {},
) {
  const term = query.trim().toLowerCase();
  const matchesReport = (report, cadastral = '') =>
    (status === 'ALL' || report.status === status) &&
    (!overdueOnly || report.is_overdue) &&
    (!term || `${report.tracking_number} ${cadastral}`.toLowerCase().includes(term));
  const plotStatus =
    status === 'ALL'
      ? null
      : ['NEW', 'INSPECTION'].includes(status)
        ? 'INSPECTION'
        : ['VIOLATION', 'IN_PROGRESS'].includes(status)
          ? 'VIOLATION'
          : '__reports_only__';
  const matchesPlot = (plot) =>
    (!plotStatus || plot.status === plotStatus) &&
    (!term || plot.cadastral_number.toLowerCase().includes(term));

  const reports = data.reports.filter((report) =>
    matchesReport(report, report.plot?.cadastral_number),
  );
  const reportPlotIds = new Set(reports.map((report) => report.plot?.id).filter(Boolean));
  const plots = data.plots.filter(
    (plot) => matchesPlot(plot) && (!overdueOnly || reportPlotIds.has(plot.id)),
  );

  const cadastralById = new Map(data.plots.map((plot) => [plot.id, plot.cadastral_number]));
  for (const feature of data.map.plots.features)
    cadastralById.set(feature.id, feature.properties.cadastral_number);
  const mapReports = data.map.reports.features.filter((feature) =>
    matchesReport(feature.properties, cadastralById.get(feature.properties.plot_id)),
  );
  const mapReportPlotIds = new Set(
    mapReports.map((feature) => feature.properties.plot_id).filter(Boolean),
  );
  const mapPlots = data.map.plots.features.filter(
    (feature) =>
      matchesPlot(feature.properties) && (!overdueOnly || mapReportPlotIds.has(feature.id)),
  );
  return {
    reports,
    plots,
    map: {
      reports: { ...data.map.reports, features: mapReports },
      plots: { ...data.map.plots, features: mapPlots },
    },
  };
}

export function visibleFeatureCollection(map, { showPlots = true, showReports = true } = {}) {
  return {
    type: 'FeatureCollection',
    features: [
      ...(showPlots ? map.plots.features : []),
      ...(showReports ? map.reports.features : []),
    ],
  };
}
