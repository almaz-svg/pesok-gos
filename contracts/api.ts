/** Agreed API v0.1, implemented in Django/DRF. Dates and UUIDs are strings. */
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
/** Bot-generated plain text. Render as text; this is not an inspector decision. */
export interface CasePassport {
  type?: string; // max 80
  typeLabel?: string; // max 160
  responsibleAuthority?: string; // max 500
  urgency?: 'high' | 'normal';
  evidenceChecklist?: string[]; // max 20 items, 500 characters each
  officialDraft?: string; // max 12000
  followUpDraft?: string; // max 12000
  inactivityComplaintDraft?: string; // max 12000
  publicText?: string; // max 8000
  socialText?: string; // max 4000
  nextAction?: string; // max 1000
  followUpDays?: number; // integer 1..365
}
export interface BotResult {
  language?: 'ru' | 'kk' | 'en';
  location_summary?: string; // max 4000
  land_case_id?: string; // exactly 12 hexadecimal characters
  case_passport?: CasePassport;
}
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
export interface ReportDetail extends Report { history: HistoryEvent[]; bot_result: BotResult | null }
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
  bot_result?: BotResult | null;
}
/** GET /api/bot/reports; Bearer bot credentials, never inspector/browser access. */
export interface BotReportsQuery {
  telegram_user_id: string;
  page?: number; // defaults to 1
  page_size?: number; // 1..100, defaults to 20
}
export interface BotReport extends Report {
  telegram_user_id: string;
  bot_result: BotResult | null;
  photos: (Photo & { telegram_file_id: string })[];
}
export type BotReportsResponse = Page<BotReport>;
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

/** Public website guide; no inspector data access. POST still requires CSRF. */
export interface AssistantStatus {
  available: boolean;
  csrf_token: string;
}
export interface AssistantChatRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  page?: '/' | '/map' | '/reports' | '/register' | '/login';
  language?: 'kk' | 'ru' | 'en';
}
export interface AssistantChatResponse {
  reply: string;
  truncated: boolean;
}
