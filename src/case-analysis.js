const CASE_TYPES = [
  {
    type: 'blocked_access',
    label: 'Перекрыт проход или доступ',
    urgency: 'high',
    authority: 'Местный акимат, управление земельных отношений или архитектурный контроль для первичной проверки',
    keywords: ['проход', 'проезд', 'доступ', 'перекрыл', 'перекрыли', 'закрыл', 'забор', 'ворота', 'шлагбаум'],
    evidence: [
      'Фото препятствия крупным планом и фото общего вида',
      'Геолокация или точные координаты места',
      'Дата, когда проход был перекрыт',
      'Фото прежнего прохода или схема, если есть',
      'Контакты жителей или свидетелей, которые подтверждают проблему',
    ],
  },
  {
    type: 'illegal_construction',
    label: 'Стройка или земляные работы',
    urgency: 'high',
    authority: 'Архитектурно-строительный контроль, местный акимат или профильное управление города',
    keywords: ['стройк', 'строят', 'котлован', 'фундамент', 'экскаватор', 'техника', 'паспорт объекта', 'без паспорта'],
    evidence: [
      'Фото строительных работ и техники',
      'Фото паспорта объекта или его отсутствия на площадке',
      'Геолокация или точные координаты участка',
      'Дата и время фиксации работ',
      'Короткое описание, что именно уже сделано на участке',
    ],
  },
  {
    type: 'land_grab',
    label: 'Возможный захват участка',
    urgency: 'normal',
    authority: 'Управление земельных отношений, местный акимат или земельная инспекция для проверки границ',
    keywords: ['захват', 'захватили', 'самовольно', 'расширил', 'присвоил', 'границ', 'участок', 'огородил'],
    evidence: [
      'Фото ограждения или фактических границ участка',
      'Геолокация или точные координаты',
      'Дата, когда появились изменения',
      'Описание, какая территория стала недоступной',
      'Кадастровые сведения или публичная карта, если есть',
    ],
  },
  {
    type: 'waste_dump',
    label: 'Мусор или загрязнение участка',
    urgency: 'normal',
    authority: 'Местный акимат, экологическая служба или коммунальная служба района',
    keywords: ['мусор', 'свалк', 'отход', 'гряз', 'загрязн', 'вонь', 'вывоз'],
    evidence: [
      'Фото мусора или загрязнения',
      'Геолокация или точные координаты',
      'Дата фиксации',
      'Оценка масштаба проблемы: двор, участок, дорога или пустырь',
      'Повторяется ли проблема после уборки',
    ],
  },
  {
    type: 'no_response',
    label: 'Нет ответа или проблема не решена',
    urgency: 'high',
    authority: 'Орган, который получил первое обращение, и вышестоящий орган при бездействии',
    keywords: ['не ответили', 'нет ответа', 'игнорируют', 'отписка', 'не решили', 'не устранено', 'просроч'],
    evidence: [
      'Номер первого обращения',
      'Дата отправки обращения',
      'Ответ госоргана, если он был',
      'Фото, подтверждающие что проблема не решена',
      'Короткое описание, что именно осталось без решения',
    ],
  },
];

const FALLBACK = {
  type: 'other_land_issue',
  label: 'Ситуация требует уточнения',
  urgency: 'normal',
  authority: 'Местный акимат или профильный орган после уточнения деталей',
  evidence: [
    'Фото места проблемы',
    'Геолокация или точные координаты',
    'Дата, когда вы заметили проблему',
    'Короткое описание, что изменилось и кому это мешает',
    'Дополнительные документы или ответы госорганов, если есть',
  ],
};

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function detectCaseType(description) {
  const lower = description.toLowerCase();
  let best = { score: 0, item: FALLBACK };
  for (const item of CASE_TYPES) {
    const score = item.keywords.reduce((count, keyword) => (lower.includes(keyword) ? count + 1 : count), 0);
    if (score > best.score) best = { score, item };
  }
  return best.score > 0 ? best.item : FALLBACK;
}

function coordinatesLine(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) ? `${lat}, ${lon}` : 'координаты не указаны';
}

function buildOfficialDraft({ type, description, lat, lon, evidenceChecklist }) {
  return [
    'Прошу провести проверку по сообщению о возможном нарушении.',
    '',
    `Категория: ${type.label}.`,
    `Место: ${coordinatesLine(lat, lon)}.`,
    `Описание: ${description}.`,
    '',
    'Прошу:',
    '1. Проверить фактическое состояние участка на месте.',
    '2. Установить ответственных лиц или организацию, если нарушение подтвердится.',
    '3. Сообщить, какие меры будут приняты и в какие сроки.',
    '',
    'Приложения и доказательства:',
    ...evidenceChecklist.map((item, index) => `${index + 1}. ${item}.`),
  ].join('\n');
}

function buildSocialText(type, description) {
  return `Зафиксирована проблема: ${type.label}. ${description}. Нужна проверка ответственного органа и публичный статус решения.`;
}

export function analyzeViolationCase({ description, lat, lon, hasPhoto = false } = {}) {
  const cleanDescription = normalizeText(description);
  const type = detectCaseType(cleanDescription);
  const evidenceChecklist = [...type.evidence];
  if (!hasPhoto && !evidenceChecklist.some(item => item.toLowerCase().includes('фото'))) {
    evidenceChecklist.unshift('Фото места проблемы');
  }
  const officialDraft = buildOfficialDraft({
    type,
    description: cleanDescription,
    lat,
    lon,
    evidenceChecklist,
  });
  return {
    type: type.type,
    typeLabel: type.label,
    responsibleAuthority: type.authority,
    urgency: type.urgency,
    evidenceChecklist,
    officialDraft,
    socialText: buildSocialText(type, cleanDescription),
    nextAction: 'Проверьте черновик и отправьте официальное обращение через eOtinish или профильный орган.',
    followUpDays: type.urgency === 'high' ? 3 : 7,
  };
}
