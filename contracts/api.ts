/** Proposed API v0.1. No backend implementation yet. Dates and UUIDs are strings. */
export type UUID = string;
export type ReportStatus = 'NEW' | 'INSPECTION' | 'VIOLATION' | 'IN_PROGRESS' | 'RESOLVED';
export type PlotStatus = 'NORMAL' | 'INSPECTION' | 'VIOLATION';
export type Category = 'DUMPING' | 'LAND_GRAB' | 'UNUSED_LAND' | 'ABANDONED_PLOT' | 'OTHER';
export type ApplicationStatus = 'RECEIVED' | 'IN_REVIEW' | 'INSPECTION_SCHEDULED' | 'COMPLETED' | 'REJECTED';
export type Position = [number, number]; // [longitude, latitude]
export type Point = { type: 'Point'; coordinates: Position };
export type Polygon = { type: 'Polygon'; coordinates: Position[][] };
export type MultiPolygon = { type: 'MultiPolygon'; coordinates: Position[][][] };
export interface Location { latitude: number; longitude: number }
export interface Photo { id: UUID; url: string }
export interface PlotRef { id: UUID; cadastral_number: string }
export interface Plot extends PlotRef {
  area_ha: number;
  purpose: string;
  address: string | null;
  status: PlotStatus;
  geometry: Polygon | MultiPolygon | null;
  active_reports_count: number;
}
export interface Report {
  id: UUID;
  tracking_number: string;
  category: Category;
  description: string;
  location: Location;
  plot: PlotRef | null;
  status: ReportStatus;
  deadline: string | null;
  is_overdue: boolean;
  photos: Photo[];
  version: number;
  created_at: string;
  updated_at: string;
}
export interface ReportSnapshot { status: ReportStatus; deadline: string | null; plot_id: UUID | null }
export interface HistoryEvent {
  id: UUID;
  event: 'CREATED' | 'UPDATED';
  before: ReportSnapshot | null;
  after: ReportSnapshot;
  comment: string | null;
  actor: { type: 'BOT' | 'INSPECTOR' | 'SYSTEM'; label: string };
  created_at: string;
}
export interface ReportDetail extends Report { history: HistoryEvent[] }
export interface PatchReport {
  version: number;
  status?: ReportStatus;
  deadline?: string | null;
  plot_id?: UUID | null;
  comment?: string;
}
export interface Page<T> { count: number; next: string | null; previous: string | null; results: T[] }
export interface Feature<G, P> { type: 'Feature'; id: UUID; geometry: G; properties: P }
export interface FeatureCollection<G, P> { type: 'FeatureCollection'; features: Feature<G, P>[] }
export interface MapReportProperties {
  tracking_number: string;
  status: ReportStatus;
  category: Category;
  plot_id: UUID | null;
  deadline: string | null;
  is_overdue: boolean;
}
export interface MapPlotProperties { cadastral_number: string; status: PlotStatus; area_ha: number }
export interface MapResponse {
  plots: FeatureCollection<Polygon | MultiPolygon, MapPlotProperties>;
  reports: FeatureCollection<Point, MapReportProperties>;
}
export interface Statistics {
  total_plots: number;
  active_violations: number;
  under_inspection: number;
  resolved: number;
  overdue: number;
}
export interface Instruction { id: string; title: string; body: string; updated_at: string }
export interface ApiError {
  error: { code: string; message: string; fields: Record<string, string[]>; request_id: string };
}
export interface User { id: UUID; username: string }
export interface CsrfResponse { csrf_token: string }
export interface LoginRequest { username: string; password: string }
export interface LoginResponse extends CsrfResponse { user: User }

// Server-to-server only. Never place a bot API key in React.
export interface CreateReport {
  telegram_user_id: string;
  location: Location;
  photos: { telegram_file_id: string }[];
  description: string;
  category: Category;
}
export interface CreateReportResponse {
  id: UUID;
  tracking_number: string;
  status: 'NEW';
  created_at: string;
}
export interface TrackingEvent { status: string; label: string; created_at: string }
interface TrackingBase {
  tracking_number: string;
  status_label: string;
  deadline: string | null;
  updated_at: string;
  history: TrackingEvent[];
}
export type TrackingResponse =
  | (TrackingBase & { kind: 'REPORT'; status: ReportStatus })
  | (TrackingBase & { kind: 'APPLICATION'; status: ApplicationStatus });

export const reportTransitions: Record<ReportStatus, readonly ReportStatus[]> = {
  NEW: ['INSPECTION'],
  INSPECTION: ['VIOLATION', 'RESOLVED'],
  VIOLATION: ['IN_PROGRESS'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: [],
};
