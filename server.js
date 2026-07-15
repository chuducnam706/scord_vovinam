const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const STORAGE_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(STORAGE_DIR, 'vovinam.db');
const LEGACY_STORAGE_FILE = path.join(STORAGE_DIR, 'storage.json');

const config = {
  judgeCount: 4,
  requiredVotes: 3,
  scoringWindowMs: 1500,
  technicalWinGap: 10,
};

const performanceConfig = {
  judgeCount: 5,
  minScore: 0,
  maxScore: 100,
  scoreStep: 1,
  defaultScore: 80,
  scoreDecimals: 0,
};

const performanceRoutineCatalog = [
  { id: 'don_luyen_tay_khong', name: 'Đơn Luyện Tay Không', aliases: ['don luyen tay khong'], memberCount: 1 },
  { id: 'don_luyen_binh_khi', name: 'Đơn Luyện Binh Khí', aliases: ['don luyen binh khi'], memberCount: 1 },
  { id: 'song_luyen', name: 'Song Luyện', aliases: ['song luyen'], memberCount: 2 },
  { id: 'da_luyen', name: 'Đa Luyện', aliases: ['da luyen'], memberCount: 4 },
  { id: 'quyen_dong_doi', name: 'Quyền Đồng Đội', aliases: ['quyen dong doi'], memberCount: 3 },
  { id: 'long_ho_quyen', name: 'Long Hổ Quyền', aliases: ['long ho quyen'], memberCount: 1 },
  { id: 'ngu_mon_quyen', name: 'Ngũ Môn Quyền', aliases: ['ngu mon quyen'], memberCount: 1 },
  { id: 'thap_tu_quyen', name: 'Thập Tự Quyền', aliases: ['thap tu quyen'], memberCount: 1 },
  { id: 'tu_tru_quyen', name: 'Tứ Trụ Quyền', aliases: ['tu tru quyen'], memberCount: 1 },
  { id: 'ngu_tan_quyen', name: 'Ngũ Tấn Quyền', aliases: ['ngu tan quyen'], memberCount: 1 },
  { id: 'tinh_hoa_luong_nghi_kiem_phap', name: 'Tinh Hoa Lưỡng Nghi Kiếm Pháp', aliases: ['tinh hoa luong nghi kiem phap'], memberCount: 1 },
  { id: 'song_luyen_1', name: 'Song Luyện 1', aliases: ['song luyen 1'], memberCount: 2 },
  { id: 'song_luyen_2', name: 'Song Luyện 2', aliases: ['song luyen 2'], memberCount: 2 },
  { id: 'song_luyen_3', name: 'Song Luyện 3', aliases: ['song luyen 3'], memberCount: 2 },
  { id: 'song_luyen_4', name: 'Song Luyện 4', aliases: ['song luyen 4'], memberCount: 2 },
  { id: 'song_luyen_5', name: 'Song Luyện 5', aliases: ['song luyen 5'], memberCount: 2 },
  { id: 'song_dao_phap', name: 'Song Đao Pháp', aliases: ['song dao phap'], memberCount: 2 },
  { id: 'song_kiem_phap', name: 'Song Kiếm Pháp', aliases: ['song kiem phap'], memberCount: 2 },
  { id: 'da_luyen_vo_khi', name: 'Đa Luyện Vũ Khí', aliases: ['da luyen vu khi', 'da luyen'], memberCount: 4 },
  { id: 'tu_ve_nam', name: 'Tự Vệ Nam', aliases: ['tu ve nam'], memberCount: 4 },
  { id: 'tu_ve_nu', name: 'Tự Vệ Nữ', aliases: ['tu ve nu'], memberCount: 4 },
  { id: 'don_chan_tan_cong', name: 'Đòn Chân Tấn Công', aliases: ['don chan tan cong'], memberCount: 4 },
];

const MAX_PERFORMANCE_MEMBER_COUNT = 50;

const COURT_COUNT = 6;
const modeLabels = {
  combat: 'Đối kháng',
  performance: 'Hội diễn',
};

const performanceMedalSlots = [
  { rank: 1, medalCode: 'HCV', medalLabel: 'Giải nhất' },
  { rank: 2, medalCode: 'HCB', medalLabel: 'Giải nhì' },
  { rank: 3, medalCode: 'HCD', medalLabel: 'Đồng giải ba' },
  { rank: 3, medalCode: 'HCD', medalLabel: 'Đồng giải ba' },
];

const matches = new Map();
const performanceMatches = new Map();
const courtAssignments = new Map();
const mcCourtStates = new Map();
const performanceCourtDisplays = new Map();
const sseClients = new Map();
const storage = {
  importedAthleteBatches: [],
  tournamentInfo: null,
  performanceSchedules: [],
  performanceRoutineBatches: [],
  performanceResults: [],
};

let database = null;

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifyText(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'item';
}

function serializeMatch(match) {
  return {
    matchId: match.matchId,
    status: match.status,
    round: match.round,
    scores: match.scores,
    winner: match.winner,
    audit: match.audit,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
  };
}

function hydrateMatch(savedMatch) {
  return {
    matchId: savedMatch.matchId,
    status: savedMatch.status || 'running',
    round: savedMatch.round || 1,
    scores: {
      blue: Number(savedMatch.scores?.blue || 0),
      red: Number(savedMatch.scores?.red || 0),
    },
    winner: savedMatch.winner || null,
    voteGroups: [],
    audit: Array.isArray(savedMatch.audit) ? savedMatch.audit : [],
    createdAt: savedMatch.createdAt || nowIso(),
    updatedAt: savedMatch.updatedAt || nowIso(),
  };
}

function getDatabase() {
  if (database) return database;

  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS matches (
      match_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      batch_id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      total_rows INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      saved_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS performance_matches (
      match_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS court_assignments (
      court TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      match_id TEXT NOT NULL,
      status TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tournament_info (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS performance_schedules (
      group_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      age_group TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      routine_name TEXT NOT NULL,
      entries_json TEXT NOT NULL,
      total_entries INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(batch_id, age_group, routine_id)
    );

    CREATE TABLE IF NOT EXISTS performance_routine_batches (
      batch_id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      sheet_name TEXT NOT NULL,
      routines_json TEXT NOT NULL,
      total_routines INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      saved_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mc_court_states (
      court TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      queue_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS performance_court_displays (
      court TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS performance_results (
      result_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      court TEXT NOT NULL,
      match_id TEXT NOT NULL,
      age_group TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      routine_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      total_score REAL NOT NULL,
      judge_scores_json TEXT NOT NULL,
      counted_scores_json TEXT NOT NULL,
      excluded_scores_json TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(group_id, entry_id)
    );
  `);

  return database;
}

function saveMatch(match) {
  const db = getDatabase();
  const savedMatch = serializeMatch(match);

  db.prepare(`
    INSERT INTO matches (match_id, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(match_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    savedMatch.matchId,
    JSON.stringify(savedMatch),
    savedMatch.createdAt || nowIso(),
    savedMatch.updatedAt || nowIso(),
  );
}

function createEmptyPerformanceScores() {
  const scores = {};

  for (let i = 1; i <= performanceConfig.judgeCount; i += 1) {
    scores[i] = null;
  }

  return scores;
}

function computePerformanceResult(judgeScores) {
  const submittedScores = Object.entries(judgeScores)
    .filter(([, score]) => Number.isFinite(score))
    .map(([judgeId, score]) => ({
      judgeId: Number(judgeId),
      score: Number(score),
    }))
    .sort((a, b) => (a.score - b.score) || (a.judgeId - b.judgeId));

  if (submittedScores.length < performanceConfig.judgeCount) {
    return {
      ready: false,
      submittedCount: submittedScores.length,
      requiredCount: performanceConfig.judgeCount,
      total: null,
      countedScores: [],
      excludedScores: [],
    };
  }

  const lowest = submittedScores[0];
  const highest = submittedScores[submittedScores.length - 1];
  const countedScores = submittedScores.slice(1, -1);
  const total = countedScores.reduce((sum, item) => sum + item.score, 0);

  return {
    ready: true,
    submittedCount: submittedScores.length,
    requiredCount: performanceConfig.judgeCount,
    total: Number(total.toFixed(performanceConfig.scoreDecimals)),
    countedScores,
    excludedScores: [
      { ...lowest, reason: 'lowest' },
      { ...highest, reason: 'highest' },
    ],
  };
}

function isValidPerformanceScoreStep(score) {
  const steps = (score - performanceConfig.minScore) / performanceConfig.scoreStep;
  return Math.abs(steps - Math.round(steps)) < 0.000001;
}

function hasSubmittedPerformanceScore(score) {
  return score !== null && score !== undefined && score !== '' && Number.isFinite(Number(score));
}

function serializePerformanceMatch(match) {
  return {
    matchId: match.matchId,
    court: match.court,
    judgeScores: match.judgeScores,
    judgeDevices: match.judgeDevices,
    audit: match.audit,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
  };
}

function hydratePerformanceMatch(savedMatch) {
  const judgeScores = createEmptyPerformanceScores();
  const judgeDevices = {};

  for (let i = 1; i <= performanceConfig.judgeCount; i += 1) {
    const score = savedMatch.judgeScores?.[i] ?? savedMatch.judgeScores?.[String(i)];
    judgeScores[i] = score === null || score === undefined || score === ''
      ? null
      : (Number.isFinite(Number(score)) ? Number(score) : null);
    judgeDevices[i] = String(savedMatch.judgeDevices?.[i] || savedMatch.judgeDevices?.[String(i)] || `Máy ${i}`);
  }

  return {
    matchId: savedMatch.matchId,
    court: String(savedMatch.court || ''),
    judgeScores,
    judgeDevices,
    audit: Array.isArray(savedMatch.audit) ? savedMatch.audit : [],
    createdAt: savedMatch.createdAt || nowIso(),
    updatedAt: savedMatch.updatedAt || nowIso(),
  };
}

function savePerformanceMatch(match) {
  const db = getDatabase();
  const savedMatch = serializePerformanceMatch(match);

  db.prepare(`
    INSERT INTO performance_matches (match_id, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(match_id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    savedMatch.matchId,
    JSON.stringify(savedMatch),
    savedMatch.createdAt || nowIso(),
    savedMatch.updatedAt || nowIso(),
  );
}

function publicPerformanceMatch(match) {
  return {
    matchId: match.matchId,
    court: match.court,
    judgeScores: match.judgeScores,
    judgeDevices: match.judgeDevices,
    result: computePerformanceResult(match.judgeScores),
    config: performanceConfig,
    audit: match.audit.slice(-50),
    updatedAt: match.updatedAt,
  };
}

function normalizeMode(mode) {
  const value = String(mode || '').trim();
  return ['combat', 'performance'].includes(value) ? value : '';
}

function normalizeCourt(court) {
  const value = Number(court);
  if (!Number.isInteger(value) || value < 1 || value > COURT_COUNT) return '';
  return String(value);
}

function defaultMatchIdForMode(mode, court) {
  return mode === 'performance' ? `PERFORMANCE_COURT_${court}` : `COURT_${court}`;
}

function targetUrlForCourt(mode, court, matchId) {
  if (mode === 'performance') {
    return `/performance-court.html?court=${encodeURIComponent(court)}&matchId=${encodeURIComponent(matchId)}`;
  }

  return `/court.html?court=${encodeURIComponent(court)}&matchId=${encodeURIComponent(matchId)}`;
}

function inferCourtFromMatchId(matchId, mode) {
  const prefix = mode === 'performance' ? 'PERFORMANCE_COURT_' : 'COURT_';
  const value = String(matchId || '');
  if (!value.startsWith(prefix)) return '';

  return normalizeCourt(value.slice(prefix.length));
}

function courtModeConflict(court, mode) {
  const normalizedCourt = normalizeCourt(court);
  const normalizedMode = normalizeMode(mode);
  if (!normalizedCourt || !normalizedMode) return null;

  const assignment = getCourtAssignment(normalizedCourt);
  if (!assignment || assignment.mode === normalizedMode) return null;

  return {
    statusCode: 409,
    payload: {
      error: `Sân ${normalizedCourt} đang là ${modeLabels[assignment.mode] || assignment.mode}`,
      court: publicCourtState(normalizedCourt, normalizedMode),
    },
  };
}

function hydrateCourtAssignment(row) {
  if (!row) return null;

  return {
    court: String(row.court),
    mode: normalizeMode(row.mode),
    matchId: String(row.match_id || row.matchId || ''),
    status: String(row.status || 'active'),
    assignedAt: row.assigned_at || row.assignedAt || nowIso(),
    updatedAt: row.updated_at || row.updatedAt || nowIso(),
  };
}

function saveCourtAssignment(assignment) {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO court_assignments (court, mode, match_id, status, assigned_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(court) DO UPDATE SET
      mode = excluded.mode,
      match_id = excluded.match_id,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    assignment.court,
    assignment.mode,
    assignment.matchId,
    assignment.status,
    assignment.assignedAt,
    assignment.updatedAt,
  );
}

function readCourtAssignmentsFromDatabase() {
  return getDatabase()
    .prepare('SELECT court, mode, match_id, status, assigned_at, updated_at FROM court_assignments ORDER BY CAST(court AS INTEGER)')
    .all()
    .map(hydrateCourtAssignment)
    .filter((assignment) => assignment && assignment.court && assignment.mode);
}

function getCourtAssignment(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) return null;
  return courtAssignments.get(normalizedCourt) || null;
}

function publicCourtState(court, requestedMode = '') {
  const normalizedCourt = normalizeCourt(court);
  const mode = normalizeMode(requestedMode);
  const assignment = getCourtAssignment(normalizedCourt);

  if (!assignment) {
    return {
      court: normalizedCourt,
      assigned: false,
      mode: null,
      modeLabel: 'Trống',
      matchId: mode ? defaultMatchIdForMode(mode, normalizedCourt) : null,
      status: 'empty',
      locked: false,
      action: mode ? 'assign' : 'empty',
      targetUrl: null,
    };
  }

  const locked = Boolean(mode && assignment.mode !== mode);

  return {
    court: normalizedCourt,
    assigned: true,
    mode: assignment.mode,
    modeLabel: modeLabels[assignment.mode] || assignment.mode,
    matchId: assignment.matchId,
    status: assignment.status,
    assignedAt: assignment.assignedAt,
    updatedAt: assignment.updatedAt,
    locked,
    action: locked ? 'locked' : 'enter',
    targetUrl: targetUrlForCourt(assignment.mode, normalizedCourt, assignment.matchId),
  };
}

function publicCourts(requestedMode = '') {
  return Array.from({ length: COURT_COUNT }, (_, index) => publicCourtState(index + 1, requestedMode));
}

function assignCourt(court, mode) {
  const normalizedCourt = normalizeCourt(court);
  const normalizedMode = normalizeMode(mode);

  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }
  if (!normalizedMode) {
    return { statusCode: 400, payload: { error: 'mode must be combat or performance' } };
  }

  const existing = getCourtAssignment(normalizedCourt);
  if (existing && existing.mode !== normalizedMode) {
    return {
      statusCode: 409,
      payload: {
        error: `Sân ${normalizedCourt} đang là ${modeLabels[existing.mode] || existing.mode}`,
        court: publicCourtState(normalizedCourt, normalizedMode),
      },
    };
  }

  if (existing) {
    broadcastMcCourt(normalizedCourt);
    return {
      statusCode: 200,
      payload: {
        reused: true,
        court: publicCourtState(normalizedCourt, normalizedMode),
      },
    };
  }

  const timestamp = nowIso();
  const assignment = {
    court: normalizedCourt,
    mode: normalizedMode,
    matchId: defaultMatchIdForMode(normalizedMode, normalizedCourt),
    status: 'active',
    assignedAt: timestamp,
    updatedAt: timestamp,
  };

  courtAssignments.set(normalizedCourt, assignment);
  saveCourtAssignment(assignment);
  broadcastMcCourt(normalizedCourt);

  return {
    statusCode: 200,
    payload: {
      assigned: true,
      court: publicCourtState(normalizedCourt, normalizedMode),
    },
  };
}

function releaseCourt(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }

  const existing = getCourtAssignment(normalizedCourt);
  if (!existing) {
    return {
      statusCode: 200,
      payload: {
        released: false,
        court: publicCourtState(normalizedCourt),
      },
    };
  }

  courtAssignments.delete(normalizedCourt);
  getDatabase().prepare('DELETE FROM court_assignments WHERE court = ?').run(normalizedCourt);
  deleteMcCourtState(normalizedCourt);
  deletePerformanceCourtDisplay(normalizedCourt);
  broadcastMcCourt(normalizedCourt);
  broadcastPerformanceCourtDisplay(normalizedCourt);

  return {
    statusCode: 200,
    payload: {
      released: true,
      previous: {
        court: existing.court,
        mode: existing.mode,
        modeLabel: modeLabels[existing.mode] || existing.mode,
        matchId: existing.matchId,
      },
      court: publicCourtState(normalizedCourt),
    },
  };
}

function normalizeMcQueueStatus(status) {
  return ['pending', 'calling', 'in_progress', 'completed', 'skipped'].includes(status)
    ? status
    : 'pending';
}

function normalizeMcQueueItem(item, index = 0) {
  const memberNames = (Array.isArray(item?.memberNames) ? item.memberNames : [])
    .map((name) => String(name || '').trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, MAX_PERFORMANCE_MEMBER_COUNT);

  return {
    itemId: String(item?.itemId || newId(`mc_item_${index + 1}`)).trim(),
    sourceEntryId: String(item?.sourceEntryId || '').trim(),
    displayName: String(item?.displayName || '').trim().slice(0, 240),
    unit: String(item?.unit || '').trim().slice(0, 240),
    ageGroup: String(item?.ageGroup || '').trim().slice(0, 120),
    routineName: String(item?.routineName || '').trim().slice(0, 240),
    memberNames,
    memberSummary: memberNames.join(', '),
    participantCount: Number.isInteger(Number(item?.participantCount))
      ? Math.max(0, Number(item.participantCount))
      : memberNames.length,
    order: Number.isInteger(Number(item?.order)) ? Number(item.order) : index + 1,
    status: normalizeMcQueueStatus(item?.status),
    calledAt: item?.calledAt || null,
    startedAt: item?.startedAt || null,
    completedAt: item?.completedAt || null,
    skippedAt: item?.skippedAt || null,
    updatedAt: item?.updatedAt || nowIso(),
  };
}

function normalizeMcCourtState(state = {}) {
  const court = normalizeCourt(state.court);
  const queue = Array.isArray(state.queue)
    ? state.queue.map((item, index) => normalizeMcQueueItem(item, index))
    : [];

  return {
    court,
    mode: normalizeMode(state.mode) || 'performance',
    sourceType: String(state.sourceType || '').trim().slice(0, 120),
    sourceId: String(state.sourceId || '').trim().slice(0, 240),
    title: String(state.title || '').trim().slice(0, 240),
    queue,
    createdAt: state.createdAt || nowIso(),
    updatedAt: state.updatedAt || nowIso(),
  };
}

function persistMcCourtState(state) {
  const normalized = normalizeMcCourtState(state);
  getDatabase().prepare(`
    INSERT INTO mc_court_states (
      court,
      mode,
      source_type,
      source_id,
      title,
      queue_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(court) DO UPDATE SET
      mode = excluded.mode,
      source_type = excluded.source_type,
      source_id = excluded.source_id,
      title = excluded.title,
      queue_json = excluded.queue_json,
      updated_at = excluded.updated_at
  `).run(
    normalized.court,
    normalized.mode,
    normalized.sourceType,
    normalized.sourceId,
    normalized.title,
    JSON.stringify(normalized.queue),
    normalized.createdAt,
    normalized.updatedAt,
  );

  return normalized;
}

function readMcCourtStatesFromDatabase() {
  const rows = getDatabase().prepare(`
    SELECT
      court,
      mode,
      source_type,
      source_id,
      title,
      queue_json,
      created_at,
      updated_at
    FROM mc_court_states
    ORDER BY CAST(court AS INTEGER)
  `).all();

  return rows
    .map((row) => normalizeMcCourtState({
      court: row.court,
      mode: row.mode,
      sourceType: row.source_type,
      sourceId: row.source_id,
      title: row.title,
      queue: JSON.parse(row.queue_json || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    .filter((item) => item.court);
}

function deleteMcCourtState(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) return;
  mcCourtStates.delete(normalizedCourt);
  getDatabase().prepare('DELETE FROM mc_court_states WHERE court = ?').run(normalizedCourt);
}

function getMcCourtState(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) return null;
  return mcCourtStates.get(normalizedCourt) || null;
}

function normalizePerformanceCourtGroupIds(display = {}) {
  const rawGroupIds = Array.isArray(display.groupIds)
    ? display.groupIds
    : (() => {
      const raw = String(display.groupId || '').trim();
      if (!raw) return [];
      if (raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [raw];
        } catch (error) {
          return [raw];
        }
      }
      return [raw];
    })();

  return Array.from(new Set(rawGroupIds.map((groupId) => String(groupId || '').trim()).filter(Boolean)));
}

function normalizePerformanceCourtDisplay(display = {}) {
  const groupIds = normalizePerformanceCourtGroupIds(display);
  return {
    court: normalizeCourt(display.court),
    groupIds,
    groupId: groupIds[0] || '',
    createdAt: display.createdAt || nowIso(),
    updatedAt: display.updatedAt || nowIso(),
  };
}

function persistPerformanceCourtDisplay(display) {
  const normalized = normalizePerformanceCourtDisplay(display);
  getDatabase().prepare(`
    INSERT INTO performance_court_displays (
      court,
      group_id,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(court) DO UPDATE SET
      group_id = excluded.group_id,
      updated_at = excluded.updated_at
  `).run(
    normalized.court,
    JSON.stringify(normalized.groupIds),
    normalized.createdAt,
    normalized.updatedAt,
  );

  return normalized;
}

function readPerformanceCourtDisplaysFromDatabase() {
  return getDatabase().prepare(`
    SELECT court, group_id, created_at, updated_at
    FROM performance_court_displays
    ORDER BY CAST(court AS INTEGER)
  `).all()
    .map((row) => normalizePerformanceCourtDisplay({
      court: row.court,
      groupId: row.group_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    .filter((item) => item.court && item.groupIds.length);
}

function getPerformanceCourtDisplay(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) return null;
  return performanceCourtDisplays.get(normalizedCourt) || null;
}

function deletePerformanceCourtDisplay(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) return;
  performanceCourtDisplays.delete(normalizedCourt);
  getDatabase().prepare('DELETE FROM performance_court_displays WHERE court = ?').run(normalizedCourt);
}

function buildMcQueueFromPerformanceSchedule(group) {
  return group.entries.map((entry, index) => normalizeMcQueueItem({
    sourceEntryId: entry.entryId,
    displayName: entry.displayName,
    unit: entry.unit,
    ageGroup: entry.ageGroup,
    routineName: entry.routineName,
    memberNames: entry.memberNames,
    participantCount: entry.participantCount,
    order: index + 1,
    status: 'pending',
  }, index));
}

function deriveMcQueueState(queue = []) {
  const currentIndex = queue.findIndex((item) => ['calling', 'in_progress'].includes(item.status));
  const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;
  const nextItems = queue.filter((item) => item.status === 'pending').slice(0, 3);
  const completedCount = queue.filter((item) => item.status === 'completed').length;
  const skippedCount = queue.filter((item) => item.status === 'skipped').length;
  const pendingCount = queue.filter((item) => item.status === 'pending').length;

  return {
    currentIndex,
    currentItem,
    nextItems,
    completedCount,
    skippedCount,
    pendingCount,
  };
}

function publicMcQueueItem(item, index = 0) {
  return {
    itemId: item.itemId,
    sourceEntryId: item.sourceEntryId,
    displayName: item.displayName,
    unit: item.unit,
    ageGroup: item.ageGroup,
    routineName: item.routineName,
    memberNames: item.memberNames,
    memberSummary: item.memberSummary,
    participantCount: item.participantCount,
    order: Number.isInteger(Number(item.order)) ? Number(item.order) : index + 1,
    status: item.status,
    calledAt: item.calledAt,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    skippedAt: item.skippedAt,
    updatedAt: item.updatedAt,
  };
}

function publicMcCourt(court, includeQueue = false) {
  const normalizedCourt = normalizeCourt(court);
  const state = getMcCourtState(normalizedCourt);
  const assignment = getCourtAssignment(normalizedCourt);
  const queue = state?.queue || [];
  const derived = deriveMcQueueState(queue);

  return {
    court: normalizedCourt,
    assigned: Boolean(assignment),
    mode: assignment?.mode || state?.mode || null,
    modeLabel: assignment?.mode ? (modeLabels[assignment.mode] || assignment.mode) : 'Trống',
    matchId: assignment?.matchId || null,
    sourceType: state?.sourceType || null,
    sourceId: state?.sourceId || null,
    title: state?.title || '',
    totalItems: queue.length,
    completedCount: derived.completedCount,
    skippedCount: derived.skippedCount,
    pendingCount: derived.pendingCount,
    currentItem: derived.currentItem ? publicMcQueueItem(derived.currentItem, derived.currentIndex) : null,
    nextItems: derived.nextItems.map(publicMcQueueItem),
    updatedAt: state?.updatedAt || assignment?.updatedAt || null,
    ...(includeQueue ? { queue: queue.map(publicMcQueueItem) } : {}),
  };
}

function publicMcCourts() {
  return Array.from({ length: COURT_COUNT }, (_, index) => publicMcCourt(index + 1));
}

function mcChannelKey(court) {
  return `mc_court_${normalizeCourt(court) || court}`;
}

function mcOverviewChannelKey() {
  return 'mc_overview';
}

function broadcastMcCourt(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) return;
  broadcast(mcChannelKey(normalizedCourt), 'mcSnapshot', publicMcCourt(normalizedCourt, true));
  broadcast(mcOverviewChannelKey(), 'mcOverview', { courts: publicMcCourts() });
}

function saveMcCourtState(state) {
  const normalized = persistMcCourtState(state);
  mcCourtStates.set(normalized.court, normalized);
  broadcastMcCourt(normalized.court);
  return normalized;
}

function ensurePerformanceCourtForMc(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }

  const assignment = getCourtAssignment(normalizedCourt);
  if (assignment?.mode === 'performance') {
    return { statusCode: 200, payload: { court: publicCourtState(normalizedCourt, 'performance') } };
  }

  if (assignment?.mode && assignment.mode !== 'performance') {
    return {
      statusCode: 409,
      payload: { error: `Sân ${normalizedCourt} đang là ${modeLabels[assignment.mode] || assignment.mode}` },
    };
  }

  return assignCourt(normalizedCourt, 'performance');
}

function loadPerformanceScheduleToMcCourt(court, groupId) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }

  const schedule = getPerformanceScheduleGroup(groupId);
  if (!schedule) {
    return { statusCode: 404, payload: { error: 'Performance schedule not found' } };
  }

  const ensuredCourt = ensurePerformanceCourtForMc(normalizedCourt);
  if (ensuredCourt.statusCode >= 400) {
    return ensuredCourt;
  }

  const existing = getMcCourtState(normalizedCourt);
  const state = saveMcCourtState({
    court: normalizedCourt,
    mode: 'performance',
    sourceType: 'performance_schedule',
    sourceId: schedule.groupId,
    title: `${schedule.ageGroup} - ${schedule.routineName}`,
    queue: buildMcQueueFromPerformanceSchedule(schedule),
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  });

  return {
    statusCode: 200,
    payload: {
      saved: true,
      court: publicMcCourt(normalizedCourt, true),
      schedule: publicPerformanceScheduleGroup(schedule),
    },
  };
}

function mutateMcCourtState(court, mutator) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }

  const state = getMcCourtState(normalizedCourt);
  if (!state) {
    return { statusCode: 404, payload: { error: `Sân ${normalizedCourt} chưa có danh sách MC.` } };
  }

  const draft = normalizeMcCourtState({
    ...state,
    queue: state.queue.map((item) => ({ ...item })),
  });

  const result = mutator(draft);
  if (result?.error) {
    return { statusCode: result.statusCode || 400, payload: { error: result.error } };
  }

  draft.updatedAt = nowIso();
  const saved = saveMcCourtState(draft);
  return {
    statusCode: 200,
    payload: {
      saved: true,
      action: result?.action || null,
      court: publicMcCourt(saved.court, true),
    },
  };
}

function announceNextMcItem(court) {
  return mutateMcCourtState(court, (state) => {
    const activeIndex = state.queue.findIndex((item) => ['calling', 'in_progress'].includes(item.status));
    if (activeIndex >= 0) {
      return { statusCode: 409, error: 'Đang có mục được gọi hoặc đang thi trên sân này.' };
    }

    const nextIndex = state.queue.findIndex((item) => item.status === 'pending');
    if (nextIndex === -1) {
      return { statusCode: 400, error: 'Không còn mục nào chờ gọi.' };
    }

    state.queue[nextIndex] = normalizeMcQueueItem({
      ...state.queue[nextIndex],
      status: 'calling',
      calledAt: nowIso(),
      updatedAt: nowIso(),
    }, nextIndex);

    return { action: 'announce-next' };
  });
}

function startCurrentMcItem(court) {
  return mutateMcCourtState(court, (state) => {
    const inProgressIndex = state.queue.findIndex((item) => item.status === 'in_progress');
    if (inProgressIndex >= 0) {
      return { statusCode: 409, error: 'Sân này đang có mục ở trạng thái đang thi.' };
    }

    let currentIndex = state.queue.findIndex((item) => item.status === 'calling');
    if (currentIndex === -1) {
      currentIndex = state.queue.findIndex((item) => item.status === 'pending');
      if (currentIndex === -1) {
        return { statusCode: 400, error: 'Không có mục nào để bắt đầu.' };
      }
    }

    state.queue[currentIndex] = normalizeMcQueueItem({
      ...state.queue[currentIndex],
      status: 'in_progress',
      calledAt: state.queue[currentIndex].calledAt || nowIso(),
      startedAt: nowIso(),
      updatedAt: nowIso(),
    }, currentIndex);

    return { action: 'start-current' };
  });
}

function completeCurrentMcItem(court) {
  return mutateMcCourtState(court, (state) => {
    const currentIndex = state.queue.findIndex((item) => ['calling', 'in_progress'].includes(item.status));
    if (currentIndex === -1) {
      return { statusCode: 400, error: 'Chưa có mục nào đang gọi hoặc đang thi.' };
    }

    state.queue[currentIndex] = normalizeMcQueueItem({
      ...state.queue[currentIndex],
      status: 'completed',
      completedAt: nowIso(),
      updatedAt: nowIso(),
    }, currentIndex);

    const nextIndex = state.queue.findIndex((item) => item.status === 'pending');
    if (nextIndex >= 0) {
      state.queue[nextIndex] = normalizeMcQueueItem({
        ...state.queue[nextIndex],
        status: 'calling',
        calledAt: nowIso(),
        updatedAt: nowIso(),
      }, nextIndex);
    }

    return { action: 'complete-current' };
  });
}

function skipCurrentMcItem(court) {
  return mutateMcCourtState(court, (state) => {
    let currentIndex = state.queue.findIndex((item) => ['calling', 'in_progress'].includes(item.status));
    if (currentIndex === -1) {
      currentIndex = state.queue.findIndex((item) => item.status === 'pending');
    }
    if (currentIndex === -1) {
      return { statusCode: 400, error: 'Không còn mục nào để bỏ qua.' };
    }

    state.queue[currentIndex] = normalizeMcQueueItem({
      ...state.queue[currentIndex],
      status: 'skipped',
      skippedAt: nowIso(),
      updatedAt: nowIso(),
    }, currentIndex);

    const nextIndex = state.queue.findIndex((item) => item.status === 'pending');
    if (nextIndex >= 0) {
      state.queue[nextIndex] = normalizeMcQueueItem({
        ...state.queue[nextIndex],
        status: 'calling',
        calledAt: nowIso(),
        updatedAt: nowIso(),
      }, nextIndex);
    }

    return { action: 'skip-current' };
  });
}

function resetMcCourtQueue(court) {
  return mutateMcCourtState(court, (state) => {
    state.queue = state.queue.map((item, index) => normalizeMcQueueItem({
      ...item,
      order: index + 1,
      status: 'pending',
      calledAt: null,
      startedAt: null,
      completedAt: null,
      skippedAt: null,
      updatedAt: nowIso(),
    }, index));

    return { action: 'reset-queue' };
  });
}

function reorderMcCourtQueue(court, itemId, direction) {
  return mutateMcCourtState(court, (state) => {
    const index = state.queue.findIndex((item) => item.itemId === itemId);
    if (index === -1) {
      return { statusCode: 404, error: 'Không tìm thấy mục trong danh sách MC.' };
    }

    const nextIndex = direction === 'up' ? index - 1 : index + 1;
    if (!['up', 'down'].includes(direction) || nextIndex < 0 || nextIndex >= state.queue.length) {
      return { statusCode: 400, error: 'Không thể đổi thứ tự mục này.' };
    }

    const activeStatuses = ['calling', 'in_progress'];
    if (activeStatuses.includes(state.queue[index].status) || activeStatuses.includes(state.queue[nextIndex].status)) {
      return { statusCode: 409, error: 'Không đổi thứ tự mục đang gọi hoặc đang thi.' };
    }

    [state.queue[index], state.queue[nextIndex]] = [state.queue[nextIndex], state.queue[index]];
    state.queue = state.queue.map((item, queueIndex) => normalizeMcQueueItem({
      ...item,
      order: queueIndex + 1,
      updatedAt: nowIso(),
    }, queueIndex));

    return { action: `reorder-${direction}` };
  });
}

function defaultTournamentInfo() {
  return {
    name: '',
    logos: [],
    sponsors: [],
    updatedAt: null,
  };
}

function normalizeTournamentAsset(asset) {
  const id = String(asset?.id || newId('logo')).trim();
  const name = String(asset?.name || 'Logo').trim().slice(0, 120) || 'Logo';
  const type = String(asset?.type || '').trim().slice(0, 80);
  const dataUrl = String(asset?.dataUrl || '').trim();
  const size = Number(asset?.size || 0);

  if (!dataUrl) return null;
  if (!dataUrl.startsWith('data:image/')) return null;

  return {
    id,
    name,
    type,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    dataUrl,
    createdAt: asset?.createdAt || nowIso(),
  };
}

function normalizeTournamentSponsor(sponsor) {
  const rawName = typeof sponsor === 'string' ? sponsor : sponsor?.name;
  const name = String(rawName || '').trim().slice(0, 160);
  if (!name) return null;

  return {
    id: String((typeof sponsor === 'object' && sponsor?.id) || newId('sponsor')).trim(),
    name,
  };
}

function normalizeTournamentInfo(payload = {}) {
  const name = String(payload.name || '').trim().slice(0, 240);
  const logos = Array.isArray(payload.logos)
    ? payload.logos.map(normalizeTournamentAsset).filter(Boolean).slice(0, 20)
    : [];
  const sponsors = Array.isArray(payload.sponsors)
    ? payload.sponsors.map(normalizeTournamentSponsor).filter(Boolean).slice(0, 100)
    : [];

  return {
    name,
    logos,
    sponsors,
    updatedAt: payload.updatedAt || nowIso(),
  };
}

function readTournamentInfoFromDatabase() {
  const row = getDatabase()
    .prepare('SELECT payload_json FROM tournament_info WHERE id = ?')
    .get('current');

  if (!row) return defaultTournamentInfo();

  try {
    return normalizeTournamentInfo(JSON.parse(row.payload_json || '{}'));
  } catch (error) {
    return defaultTournamentInfo();
  }
}

function saveTournamentInfo(info) {
  const db = getDatabase();
  const storedInfo = normalizeTournamentInfo({
    ...info,
    updatedAt: nowIso(),
  });

  db.prepare(`
    INSERT INTO tournament_info (id, payload_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    'current',
    JSON.stringify(storedInfo),
    storedInfo.updatedAt,
  );

  storage.tournamentInfo = storedInfo;
  return storedInfo;
}

function publicTournamentInfo() {
  return storage.tournamentInfo || defaultTournamentInfo();
}

function makeImportedRoutineSelectionId(batchId, routineId) {
  return `import:${batchId}:${routineId}`;
}

function parseRoutineSelectionId(value) {
  const raw = String(value || '').trim();
  if (!raw) return { kind: '', routineId: '', batchId: '' };
  if (!raw.startsWith('import:')) {
    return { kind: 'system', routineId: raw, batchId: '' };
  }

  const match = /^import:([^:]+):(.+)$/.exec(raw);
  if (!match) return { kind: '', routineId: '', batchId: '' };

  return {
    kind: 'import',
    batchId: match[1],
    routineId: match[2],
  };
}

function parsePerformanceMemberCount(value) {
  const match = String(value ?? '').match(/\d+/);
  if (!match) return null;
  const memberCount = Number(match[0]);
  if (!Number.isInteger(memberCount) || memberCount < 1 || memberCount > MAX_PERFORMANCE_MEMBER_COUNT) {
    return null;
  }
  return memberCount;
}

function normalizePerformanceMemberCount(value, fallback = 1) {
  return parsePerformanceMemberCount(value)
    || parsePerformanceMemberCount(fallback)
    || 1;
}

function normalizePerformanceRoutineItem(item, index = 0) {
  const name = String(item?.name || '').trim().slice(0, 240);
  if (!name) return null;

  const aliases = Array.isArray(item?.aliases)
    ? item.aliases.map((alias) => String(alias || '').trim()).filter(Boolean).slice(0, 20)
    : [];

  return {
    id: String(item?.id || `routine_${slugifyText(name)}_${index + 1}`),
    name,
    aliases,
    memberCount: normalizePerformanceMemberCount(
      item?.memberCount,
      matchPerformanceRoutine(name)?.memberCount || 1,
    ),
  };
}

function normalizePerformanceRoutineBatch(batch) {
  const routines = Array.isArray(batch?.routines)
    ? batch.routines.map((item, index) => normalizePerformanceRoutineItem(item, index)).filter(Boolean)
    : [];
  const savedAt = batch?.savedAt || batch?.importedAt || nowIso();

  return {
    batchId: String(batch?.batchId || newId('performance_routine_batch')).trim(),
    fileName: String(batch?.fileName || 'unknown').trim(),
    fileType: String(batch?.fileType || 'UNKNOWN').trim(),
    sheetName: String(batch?.sheetName || 'Sheet1').trim(),
    routines,
    totalRoutines: routines.length,
    importedAt: batch?.importedAt || savedAt,
    savedAt,
  };
}

function publicPerformanceRoutineBatch(batch, includeRoutines = false) {
  return {
    batchId: batch.batchId,
    fileName: batch.fileName,
    fileType: batch.fileType,
    sheetName: batch.sheetName,
    totalRoutines: batch.totalRoutines,
    importedAt: batch.importedAt,
    savedAt: batch.savedAt,
    previewRoutines: batch.routines.slice(0, 10).map(publicPerformanceRoutine),
    ...(includeRoutines ? {
      routines: batch.routines.map((item) => ({
        ...publicPerformanceRoutine(item),
        id: makeImportedRoutineSelectionId(batch.batchId, item.id),
      })),
    } : {}),
  };
}

function persistPerformanceRoutineBatch(batch) {
  const db = getDatabase();
  const normalizedBatch = normalizePerformanceRoutineBatch(batch);

  db.prepare(`
    INSERT INTO performance_routine_batches (
      batch_id,
      file_name,
      file_type,
      sheet_name,
      routines_json,
      total_routines,
      imported_at,
      saved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id) DO UPDATE SET
      file_name = excluded.file_name,
      file_type = excluded.file_type,
      sheet_name = excluded.sheet_name,
      routines_json = excluded.routines_json,
      total_routines = excluded.total_routines,
      imported_at = excluded.imported_at,
      saved_at = excluded.saved_at
  `).run(
    normalizedBatch.batchId,
    normalizedBatch.fileName,
    normalizedBatch.fileType,
    normalizedBatch.sheetName,
    JSON.stringify(normalizedBatch.routines),
    normalizedBatch.totalRoutines,
    normalizedBatch.importedAt,
    normalizedBatch.savedAt,
  );

  return normalizedBatch;
}

function readPerformanceRoutineBatchesFromDatabase() {
  const rows = getDatabase().prepare(`
    SELECT
      batch_id,
      file_name,
      file_type,
      sheet_name,
      routines_json,
      total_routines,
      imported_at,
      saved_at
    FROM performance_routine_batches
    ORDER BY saved_at DESC
  `).all();

  return rows.map((row) => normalizePerformanceRoutineBatch({
    batchId: row.batch_id,
    fileName: row.file_name,
    fileType: row.file_type,
    sheetName: row.sheet_name,
    routines: JSON.parse(row.routines_json || '[]'),
    totalRoutines: row.total_routines,
    importedAt: row.imported_at,
    savedAt: row.saved_at,
  }));
}

function getPerformanceRoutineBatch(batchId) {
  return storage.performanceRoutineBatches.find((batch) => batch.batchId === batchId) || null;
}

function deletePerformanceRoutineBatch(batchId) {
  const index = storage.performanceRoutineBatches.findIndex((batch) => batch.batchId === batchId);
  if (index === -1) {
    return { statusCode: 404, payload: { error: 'Performance routine batch not found' } };
  }

  const schedulePrefix = `import:${batchId}:`;
  getDatabase().prepare('DELETE FROM performance_schedules WHERE routine_id LIKE ?').run(`${schedulePrefix}%`);
  storage.performanceSchedules = storage.performanceSchedules.filter((group) => !group.routineId.startsWith(schedulePrefix));
  getDatabase().prepare('DELETE FROM performance_routine_batches WHERE batch_id = ?').run(batchId);
  const [deletedBatch] = storage.performanceRoutineBatches.splice(index, 1);

  return {
    statusCode: 200,
    payload: {
      deleted: true,
      batchId,
      fileName: deletedBatch.fileName,
      deletedSchedules: true,
    },
  };
}

function normalizeImportedPerformanceRoutines(result) {
  const routineColumnAliases = [...performancePlannerAliases.routine, 'ten bai quyen', 'ten bai'];
  const memberCountAliases = [
    ...performancePlannerAliases.memberCount,
    'member count',
    'group size',
    'team size',
  ];
  const routineIndex = findColumnIndexByAliases(result.columns || [], routineColumnAliases);
  const index = routineIndex >= 0 ? routineIndex : 0;
  const memberCountIndex = findColumnIndexByAliases(result.columns || [], memberCountAliases);
  const routineMap = new Map();
  const records = [];
  const headerValue = String(result.columns?.[index] || '').trim();
  const normalizedHeaderValue = normalizeText(headerValue);
  const isHeaderLike = routineColumnAliases.some((alias) => normalizedHeaderValue.includes(alias));

  if (headerValue && !isHeaderLike) {
    records.push({ name: headerValue, memberCount: null });
  }

  (result.rows || []).forEach((row) => {
    const name = String(row?.[index] || '').trim();
    if (!name) return;
    records.push({
      name,
      memberCount: memberCountIndex >= 0 ? row?.[memberCountIndex] : null,
    });
  });

  records.forEach((record) => {
    record.name
      .split(/[;\n\r]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((name) => {
        const key = slugifyText(name);
        if (!routineMap.has(key)) {
          const catalogRoutine = matchPerformanceRoutine(name);
          routineMap.set(key, {
            id: key,
            name,
            aliases: [],
            memberCount: normalizePerformanceMemberCount(
              record.memberCount,
              catalogRoutine?.memberCount || 1,
            ),
          });
        }
      });
  });

  const routines = Array.from(routineMap.values())
    .sort((a, b) => a.name.localeCompare(b.name, 'vi', { sensitivity: 'base' }));

  return {
    fileName: result.fileName,
    fileType: result.fileType,
    sheetName: result.sheetName,
    routines,
  };
}

function saveImportedPerformanceRoutineBatch(result) {
  const importedAt = nowIso();
  const batch = persistPerformanceRoutineBatch({
    batchId: newId('performance_routine_import'),
    fileName: result.fileName,
    fileType: result.fileType,
    sheetName: result.sheetName,
    routines: result.routines,
    importedAt,
    savedAt: importedAt,
  });

  storage.performanceRoutineBatches.unshift(batch);
  storage.performanceRoutineBatches.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  return batch;
}

const performancePlannerAliases = {
  age: ['lua tuoi', 'nhom tuoi', 'do tuoi', 'tuoi', 'age'],
  routine: ['bai quyen', 'bai thi', 'noi dung', 'noi dung thi', 'bai bieu dien', 'ten bai'],
  name: ['ho ten', 'ten vdv', 'van dong vien', 'ten doi', 'doi thi', 'athlete', 'ho va ten'],
  unit: ['don vi', 'clb', 'cau lac bo', 'team', 'unit'],
  memberCount: ['so nguoi', 'so vdv', 'so thanh vien', 'nguoi moi doi', 'so luong'],
};

function publicPerformanceRoutine(routine) {
  return {
    id: routine.id,
    name: routine.name,
    memberCount: normalizePerformanceMemberCount(routine.memberCount, 1),
  };
}

function findColumnIndexByAliases(columns, aliases) {
  return columns.findIndex((column) => {
    const normalizedColumn = normalizeText(column);
    return aliases.some((alias) => normalizedColumn.includes(alias));
  });
}

function detectPerformancePlannerColumns(columns) {
  return {
    age: findColumnIndexByAliases(columns, performancePlannerAliases.age),
    routine: findColumnIndexByAliases(columns, performancePlannerAliases.routine),
    name: findColumnIndexByAliases(columns, performancePlannerAliases.name),
    unit: findColumnIndexByAliases(columns, performancePlannerAliases.unit),
    memberCount: findColumnIndexByAliases(columns, performancePlannerAliases.memberCount),
  };
}

function getRowCell(row, columnIndex) {
  if (columnIndex < 0) return '';
  return String(row?.[columnIndex] || '').trim();
}

function getUniqueColumnValues(rows, columnIndex) {
  if (columnIndex < 0) return [];

  return Array.from(new Set(
    rows
      .map((row) => getRowCell(row, columnIndex))
      .filter((value) => value !== ''),
  )).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true, sensitivity: 'base' }));
}

function findBestRoutineMatch(value, routines) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) return null;

  const matches = (routines || []).flatMap((routine, routineIndex) => (
    [routine.name, ...(routine.aliases || [])]
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .map((name) => ({
        routine,
        routineIndex,
        name,
        exact: name === normalizedValue,
        matches: name === normalizedValue
          || normalizedValue.includes(name)
          || name.includes(normalizedValue),
      }))
      .filter((candidate) => candidate.matches)
  ));

  matches.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.name.length !== b.name.length) return b.name.length - a.name.length;
    return a.routineIndex - b.routineIndex;
  });

  return matches[0]?.routine || null;
}

function matchPerformanceRoutine(value) {
  return findBestRoutineMatch(value, performanceRoutineCatalog);
}

function matchedPerformanceRoutinesForValue(value) {
  return String(value || '')
    .split(/[;,/|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => matchPerformanceRoutine(item))
    .filter(Boolean);
}

function matchRoutineFromList(value, routines) {
  return findBestRoutineMatch(value, routines);
}

function matchedRoutinesForValue(value, routines) {
  return String(value || '')
    .split(/[;,/|]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => matchRoutineFromList(item, routines))
    .filter(Boolean);
}

function resolveRoutineSelection(selectionId) {
  const parsed = parseRoutineSelectionId(selectionId);
  if (parsed.kind === 'system') {
    const routine = performanceRoutineCatalog.find((item) => item.id === parsed.routineId);
    return routine ? { kind: 'system', routine } : null;
  }

  if (parsed.kind === 'import') {
    const batch = getPerformanceRoutineBatch(parsed.batchId);
    if (!batch) return null;
    const routine = batch.routines.find((item) => item.id === parsed.routineId);
    if (!routine) return null;

    return {
      kind: 'import',
      batch,
      routine: {
        ...routine,
        id: makeImportedRoutineSelectionId(batch.batchId, routine.id),
      },
    };
  }

  return null;
}

function buildPerformancePlannerOptions(batch) {
  const columns = Array.isArray(batch?.columns) ? batch.columns : [];
  const rows = Array.isArray(batch?.rows) ? batch.rows : [];
  const indexes = detectPerformancePlannerColumns(columns);
  const ageOptions = getUniqueColumnValues(rows, indexes.age);
  const routineMap = new Map();
  const unmatchedRoutineValues = new Set();

  rows.forEach((row) => {
    const rawRoutine = getRowCell(row, indexes.routine);
    if (!rawRoutine) return;

    const matchedRoutines = matchedPerformanceRoutinesForValue(rawRoutine);
    if (matchedRoutines.length === 0) {
      unmatchedRoutineValues.add(rawRoutine);
      return;
    }

    matchedRoutines.forEach((matchedRoutine) => {
      const rowMemberCount = parsePerformanceMemberCount(getRowCell(row, indexes.memberCount));
      if (!routineMap.has(matchedRoutine.id)) {
        routineMap.set(matchedRoutine.id, {
          ...matchedRoutine,
          memberCount: rowMemberCount || matchedRoutine.memberCount || 1,
        });
      }
    });
  });

  return {
    indexes,
    ageOptions,
    routineOptions: Array.from(routineMap.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'vi', { sensitivity: 'base' }))
      .map(publicPerformanceRoutine),
    unmatchedRoutineValues: Array.from(unmatchedRoutineValues)
      .sort((a, b) => a.localeCompare(b, 'vi', { sensitivity: 'base' })),
  };
}

function publicPlannerColumn(columns, index) {
  if (index < 0) return null;
  return columns[index] || null;
}

function publicPerformancePlannerOptions(batch) {
  const options = buildPerformancePlannerOptions(batch);

  return {
    batchId: batch.batchId,
    fileName: batch.fileName,
    totalRows: batch.totalRows,
    detectedColumns: {
      age: publicPlannerColumn(batch.columns, options.indexes.age),
      routine: publicPlannerColumn(batch.columns, options.indexes.routine),
      name: publicPlannerColumn(batch.columns, options.indexes.name),
      unit: publicPlannerColumn(batch.columns, options.indexes.unit),
      memberCount: publicPlannerColumn(batch.columns, options.indexes.memberCount),
    },
    ageOptions: options.ageOptions,
    routineOptions: options.routineOptions,
    unmatchedRoutineValues: options.unmatchedRoutineValues.slice(0, 30),
  };
}

function normalizePerformanceScheduleEntry(entry, index = 0) {
  const status = ['pending', 'in_progress', 'completed'].includes(entry?.status)
    ? entry.status
    : 'pending';
  const displayName = String(entry?.displayName || '').trim().slice(0, 240);
  const memberNames = (Array.isArray(entry?.memberNames) ? entry.memberNames : [])
    .map((name) => String(name || '').trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, MAX_PERFORMANCE_MEMBER_COUNT);
  if (!memberNames.length && displayName) memberNames.push(displayName);
  const expectedMemberCount = normalizePerformanceMemberCount(
    entry?.expectedMemberCount,
    memberNames.length || 1,
  );
  const participantCount = memberNames.length;
  const sourceRowIndexes = (Array.isArray(entry?.sourceRowIndexes)
    ? entry.sourceRowIndexes
    : [entry?.sourceRowIndex])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0)
    .slice(0, MAX_PERFORMANCE_MEMBER_COUNT);

  return {
    entryId: String(entry?.entryId || newId(`performance_entry_${index + 1}`)),
    displayName,
    unit: String(entry?.unit || '').trim().slice(0, 240),
    ageGroup: String(entry?.ageGroup || '').trim().slice(0, 120),
    routineName: String(entry?.routineName || '').trim().slice(0, 240),
    sourceRowIndex: Number.isInteger(Number(entry?.sourceRowIndex)) ? Number(entry.sourceRowIndex) : index,
    sourceRowIndexes,
    originalOrder: Number.isInteger(Number(entry?.originalOrder)) ? Number(entry.originalOrder) : index + 1,
    memberNames,
    memberSummary: memberNames.join(', '),
    participantCount,
    expectedMemberCount,
    groupNumber: Number.isInteger(Number(entry?.groupNumber)) ? Math.max(1, Number(entry.groupNumber)) : 1,
    groupCountForUnit: Number.isInteger(Number(entry?.groupCountForUnit))
      ? Math.max(1, Number(entry.groupCountForUnit))
      : 1,
    autoGroupKey: String(entry?.autoGroupKey || '').trim().slice(0, 300),
    needsAttention: Boolean(entry?.needsAttention) || participantCount !== expectedMemberCount,
    attentionReason: String(entry?.attentionReason || '').trim().slice(0, 300),
    status,
    startedAt: entry?.startedAt || null,
    completedAt: entry?.completedAt || null,
  };
}

function normalizePerformanceScheduleGroup(group) {
  const entries = Array.isArray(group?.entries)
    ? group.entries.map((entry, index) => normalizePerformanceScheduleEntry(entry, index))
    : [];

  return {
    groupId: String(group?.groupId || newId('performance_schedule')),
    batchId: String(group?.batchId || '').trim(),
    ageGroup: String(group?.ageGroup || '').trim().slice(0, 120),
    routineId: String(group?.routineId || '').trim(),
    routineName: String(group?.routineName || '').trim().slice(0, 240),
    entries,
    totalEntries: entries.length,
    createdAt: group?.createdAt || nowIso(),
    updatedAt: group?.updatedAt || nowIso(),
  };
}

function publicPerformanceScheduleGroup(group, includeEntries = false) {
  const memberCount = group.entries.length
    ? normalizePerformanceMemberCount(group.entries[0]?.expectedMemberCount, 1)
    : 1;
  const autoGrouped = group.entries.length > 0 && group.entries.every((entry) => entry.autoGroupKey);

  return {
    groupId: group.groupId,
    batchId: group.batchId,
    ageGroup: group.ageGroup,
    routineId: group.routineId,
    routineName: group.routineName,
    totalEntries: group.totalEntries,
    totalAthletes: group.entries.reduce((total, entry) => total + Number(entry.participantCount || 0), 0),
    memberCount,
    autoGrouped,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    previewEntries: group.entries.slice(0, 5),
    ...(includeEntries ? { entries: group.entries } : {}),
  };
}

function normalizePerformanceRankingResult(result) {
  const totalScore = Number(result?.totalScore);
  const judgeScores = (result?.judgeScores && typeof result.judgeScores === 'object')
    ? result.judgeScores
    : {};

  return {
    resultId: String(
      result?.resultId
      || `${String(result?.groupId || 'performance_group')}__${String(result?.entryId || newId('performance_entry'))}`,
    ),
    groupId: String(result?.groupId || '').trim(),
    entryId: String(result?.entryId || '').trim(),
    court: String(result?.court || '').trim(),
    matchId: String(result?.matchId || '').trim(),
    ageGroup: String(result?.ageGroup || '').trim().slice(0, 120),
    routineId: String(result?.routineId || '').trim(),
    routineName: String(result?.routineName || '').trim().slice(0, 240),
    displayName: String(result?.displayName || '').trim().slice(0, 240),
    unit: String(result?.unit || '').trim().slice(0, 240),
    totalScore: Number.isFinite(totalScore) ? Number(totalScore.toFixed(performanceConfig.scoreDecimals)) : 0,
    judgeScores,
    countedScores: Array.isArray(result?.countedScores) ? result.countedScores : [],
    excludedScores: Array.isArray(result?.excludedScores) ? result.excludedScores : [],
    startedAt: result?.startedAt || null,
    completedAt: result?.completedAt || null,
    createdAt: result?.createdAt || nowIso(),
    updatedAt: result?.updatedAt || nowIso(),
  };
}

function persistPerformanceRankingResult(result) {
  const saved = normalizePerformanceRankingResult(result);
  getDatabase().prepare(`
    INSERT INTO performance_results (
      result_id,
      group_id,
      entry_id,
      court,
      match_id,
      age_group,
      routine_id,
      routine_name,
      display_name,
      unit,
      total_score,
      judge_scores_json,
      counted_scores_json,
      excluded_scores_json,
      started_at,
      completed_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(result_id) DO UPDATE SET
      court = excluded.court,
      match_id = excluded.match_id,
      age_group = excluded.age_group,
      routine_id = excluded.routine_id,
      routine_name = excluded.routine_name,
      display_name = excluded.display_name,
      unit = excluded.unit,
      total_score = excluded.total_score,
      judge_scores_json = excluded.judge_scores_json,
      counted_scores_json = excluded.counted_scores_json,
      excluded_scores_json = excluded.excluded_scores_json,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `).run(
    saved.resultId,
    saved.groupId,
    saved.entryId,
    saved.court,
    saved.matchId,
    saved.ageGroup,
    saved.routineId,
    saved.routineName,
    saved.displayName,
    saved.unit,
    saved.totalScore,
    JSON.stringify(saved.judgeScores),
    JSON.stringify(saved.countedScores),
    JSON.stringify(saved.excludedScores),
    saved.startedAt,
    saved.completedAt,
    saved.createdAt,
    saved.updatedAt,
  );
}

function readPerformanceRankingResultsFromDatabase() {
  const rows = getDatabase().prepare(`
    SELECT
      result_id,
      group_id,
      entry_id,
      court,
      match_id,
      age_group,
      routine_id,
      routine_name,
      display_name,
      unit,
      total_score,
      judge_scores_json,
      counted_scores_json,
      excluded_scores_json,
      started_at,
      completed_at,
      created_at,
      updated_at
    FROM performance_results
    ORDER BY updated_at DESC
  `).all();

  return rows.map((row) => normalizePerformanceRankingResult({
    resultId: row.result_id,
    groupId: row.group_id,
    entryId: row.entry_id,
    court: row.court,
    matchId: row.match_id,
    ageGroup: row.age_group,
    routineId: row.routine_id,
    routineName: row.routine_name,
    displayName: row.display_name,
    unit: row.unit,
    totalScore: row.total_score,
    judgeScores: JSON.parse(row.judge_scores_json || '{}'),
    countedScores: JSON.parse(row.counted_scores_json || '[]'),
    excludedScores: JSON.parse(row.excluded_scores_json || '[]'),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function publicPerformanceRankingResult(result) {
  return {
    resultId: result.resultId,
    groupId: result.groupId,
    entryId: result.entryId,
    court: result.court,
    matchId: result.matchId,
    ageGroup: result.ageGroup,
    routineId: result.routineId,
    routineName: result.routineName,
    displayName: result.displayName,
    unit: result.unit,
    totalScore: result.totalScore,
    judgeScores: result.judgeScores,
    countedScores: result.countedScores,
    excludedScores: result.excludedScores,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    updatedAt: result.updatedAt,
  };
}

function buildPerformanceRankingGroups() {
  const grouped = new Map();

  storage.performanceResults.forEach((result) => {
    if (!result.groupId) return;
    if (!grouped.has(result.groupId)) {
      grouped.set(result.groupId, []);
    }
    grouped.get(result.groupId).push(result);
  });

  return Array.from(grouped.entries())
    .map(([groupId, results]) => {
      const sortedResults = [...results].sort((a, b) => {
        if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
        return new Date(a.completedAt || a.updatedAt).getTime() - new Date(b.completedAt || b.updatedAt).getTime();
      });

      const sourceGroup = getPerformanceScheduleGroup(groupId);
      const first = sortedResults[0];

      return {
        groupId,
        ageGroup: sourceGroup?.ageGroup || first?.ageGroup || '',
        routineId: sourceGroup?.routineId || first?.routineId || '',
        routineName: sourceGroup?.routineName || first?.routineName || '',
        title: sourceGroup
          ? `${sourceGroup.ageGroup} - ${sourceGroup.routineName}`
          : `${first?.ageGroup || '--'} - ${first?.routineName || '--'}`,
        totalResults: sortedResults.length,
        updatedAt: sortedResults[0]?.updatedAt || sourceGroup?.updatedAt || null,
        medalists: performanceMedalSlots.map((slot, index) => ({
          ...slot,
          result: sortedResults[index] ? publicPerformanceRankingResult(sortedResults[index]) : null,
        })),
        results: sortedResults.map(publicPerformanceRankingResult),
      };
    })
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function performanceRankingChannelKey() {
  return 'performance_rankings';
}

function broadcastPerformanceRankings() {
  broadcast(performanceRankingChannelKey(), 'performanceRankingSnapshot', {
    groups: buildPerformanceRankingGroups(),
  });
}

function saveCompletedPerformanceResult({ group, entry, court, matchId, matchSnapshot, completedAt }) {
  const result = matchSnapshot?.result;
  if (!result?.ready || !group || !entry) return null;

  persistPerformanceRankingResult({
    resultId: `${group.groupId}__${entry.entryId}`,
    groupId: group.groupId,
    entryId: entry.entryId,
    court,
    matchId,
    ageGroup: group.ageGroup,
    routineId: group.routineId,
    routineName: group.routineName,
    displayName: entry.displayName,
    unit: entry.unit,
    totalScore: result.total,
    judgeScores: matchSnapshot.judgeScores,
    countedScores: result.countedScores,
    excludedScores: result.excludedScores,
    startedAt: entry.startedAt || null,
    completedAt: completedAt || nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  storage.performanceResults = readPerformanceRankingResultsFromDatabase();
  broadcastPerformanceRankings();
  return storage.performanceResults.find((item) => item.resultId === `${group.groupId}__${entry.entryId}`) || null;
}

function deriveDisplayEntryForPerformanceSchedule(group) {
  const entries = Array.isArray(group?.entries) ? group.entries : [];
  const current = entries.find((entry) => entry.status === 'in_progress');
  if (current) {
    return {
      label: 'Đang diễn ra',
      status: 'in_progress',
      entry: current,
      meta: `${group.ageGroup || '--'} • Đang hiển thị theo trạng thái realtime`,
    };
  }

  const pending = entries.find((entry) => (entry.status || 'pending') === 'pending');
  if (pending) {
    return {
      label: 'Chuẩn bị / Chưa diễn ra',
      status: 'pending',
      entry: pending,
      meta: `${group.ageGroup || '--'} • Chưa có mục nào chuyển sang đang diễn ra`,
    };
  }

  const completed = [...entries].reverse().find((entry) => entry.status === 'completed');
  if (completed) {
    return {
      label: 'Đã kết thúc',
      status: 'completed',
      entry: completed,
      meta: `${group.ageGroup || '--'} • Tất cả mục trong danh sách đã kết thúc`,
    };
  }

  return null;
}

function performanceCourtDisplayChannelKey(court) {
  return `performance_court_display_${normalizeCourt(court) || court}`;
}

function performanceScheduleChannelKey(groupId) {
  return `performance_schedule_${String(groupId || '').trim()}`;
}

function broadcastPerformanceScheduleGroup(groupId) {
  const group = getPerformanceScheduleGroup(groupId);
  if (!group) return;
  broadcast(
    performanceScheduleChannelKey(groupId),
    'performanceScheduleSnapshot',
    publicPerformanceScheduleGroup(group, true),
  );
}

function readPerformanceSchedulesFromDatabase() {
  const rows = getDatabase().prepare(`
    SELECT
      group_id,
      batch_id,
      age_group,
      routine_id,
      routine_name,
      entries_json,
      total_entries,
      created_at,
      updated_at
    FROM performance_schedules
    ORDER BY updated_at DESC
  `).all();

  return rows.map((row) => normalizePerformanceScheduleGroup({
    groupId: row.group_id,
    batchId: row.batch_id,
    ageGroup: row.age_group,
    routineId: row.routine_id,
    routineName: row.routine_name,
    entries: JSON.parse(row.entries_json || '[]'),
    totalEntries: row.total_entries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function getPerformanceScheduleGroup(groupId) {
  return storage.performanceSchedules.find((group) => group.groupId === groupId) || null;
}

function performanceScheduleHasRemainingEntries(group) {
  return Boolean(group && Array.isArray(group.entries) && group.entries.some((entry) => entry.status !== 'completed'));
}

function countPerformanceScheduleEntries(entries = []) {
  return entries.reduce((acc, entry) => {
    const status = ['pending', 'in_progress', 'completed'].includes(entry?.status)
      ? entry.status
      : 'pending';
    acc[status] += 1;
    return acc;
  }, {
    pending: 0,
    in_progress: 0,
    completed: 0,
  });
}

function getPerformanceCourtQueueSchedules(assignment) {
  return (assignment?.groupIds || [])
    .map((groupId) => getPerformanceScheduleGroup(groupId))
    .filter(Boolean);
}

function getActivePerformanceCourtSchedule(assignment) {
  return getPerformanceCourtQueueSchedules(assignment)
    .find((group) => performanceScheduleHasRemainingEntries(group)) || null;
}

function publicPerformanceQueueSchedule(group, index, activeGroupId = '') {
  const counts = countPerformanceScheduleEntries(group.entries || []);
  return {
    groupId: group.groupId,
    title: `${group.ageGroup} - ${group.routineName}`,
    ageGroup: group.ageGroup,
    routineName: group.routineName,
    totalEntries: group.totalEntries,
    counts,
    hasRemainingEntries: performanceScheduleHasRemainingEntries(group),
    active: group.groupId === activeGroupId,
    order: index + 1,
  };
}

function ensurePerformanceScheduleForCourt(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }

  const ensuredCourt = ensurePerformanceCourtForMc(normalizedCourt);
  if (ensuredCourt.statusCode >= 400) {
    return ensuredCourt;
  }

  const existing = getPerformanceCourtDisplay(normalizedCourt);

  return {
    statusCode: 200,
    payload: {
      assignment: existing || null,
      display: publicPerformanceCourtDisplay(normalizedCourt),
    },
  };
}

function publicPerformanceCourtDisplay(court) {
  const normalizedCourt = normalizeCourt(court);
  const assignment = getPerformanceCourtDisplay(normalizedCourt);
  const schedule = assignment ? getActivePerformanceCourtSchedule(assignment) : null;
  const queueSchedules = assignment ? getPerformanceCourtQueueSchedules(assignment) : [];
  const display = schedule ? deriveDisplayEntryForPerformanceSchedule(schedule) : null;
  const courtAssignment = getCourtAssignment(normalizedCourt);
  const matchId = courtAssignment?.matchId || defaultMatchIdForMode('performance', normalizedCourt);
  const matchSnapshot = normalizedCourt ? publicPerformanceMatch(getPerformanceMatch(matchId, normalizedCourt)) : null;
  let canNext = false;
  let nextReason = 'Sân này chưa được phân nội dung hội diễn.';
  const activeQueueIndex = schedule
    ? queueSchedules.findIndex((group) => group.groupId === schedule.groupId)
    : -1;

  if (assignment?.groupIds?.length && !schedule) {
    nextReason = 'Hàng chờ hội diễn của sân này đã hoàn thành hết.';
  } else if (schedule) {
    if (!matchSnapshot?.result?.ready) {
      nextReason = 'Chưa có đủ điểm công bố kết quả nên chưa thể Next.';
    } else {
      canNext = true;
      nextReason = 'Đã có kết quả, có thể bấm Next.';
    }
  }

  return {
    court: normalizedCourt,
    groupId: schedule?.groupId || assignment?.groupId || null,
    groupIds: assignment?.groupIds || [],
    queueLength: assignment?.groupIds?.length || 0,
    activeQueueIndex,
    hasSchedule: Boolean(schedule || assignment?.groupIds?.length),
    title: schedule
      ? `${schedule.ageGroup} - ${schedule.routineName}`
      : (assignment?.groupIds?.length ? 'Hàng chờ hội diễn đã hoàn thành' : ''),
    schedule: schedule ? publicPerformanceScheduleGroup(schedule, true) : null,
    queue: queueSchedules.map((group, index) => publicPerformanceQueueSchedule(group, index, schedule?.groupId || '')),
    currentEntry: display?.entry || null,
    currentLabel: display?.label || 'Chưa có dữ liệu',
    currentStatus: display?.status || '',
    currentMeta: display?.meta
      ? `${display.meta} • Nội dung ${activeQueueIndex + 1}/${queueSchedules.length}`
      : (assignment?.groupIds?.length ? 'Tất cả nội dung trong hàng chờ đã hoàn thành.' : 'Sân này chưa được phân nội dung hội diễn.'),
    matchReady: Boolean(matchSnapshot?.result?.ready),
    submittedJudgeCount: Number(matchSnapshot?.result?.submittedCount || 0),
    requiredJudgeCount: Number(matchSnapshot?.result?.requiredCount || performanceConfig.judgeCount),
    canNext,
    nextReason,
    updatedAt: assignment?.updatedAt || schedule?.updatedAt || null,
  };
}

function performanceCourtSummary(court) {
  const courtState = publicCourtState(court, 'performance');
  const display = publicPerformanceCourtDisplay(courtState.court);
  const schedule = display.schedule;
  const counts = countPerformanceScheduleEntries(schedule?.entries || []);
  const queue = display.queue || [];
  const queueCounts = queue.reduce((acc, item) => {
    acc.totalEntries += Number(item.totalEntries || 0);
    acc.pending += Number(item.counts?.pending || 0);
    acc.in_progress += Number(item.counts?.in_progress || 0);
    acc.completed += Number(item.counts?.completed || 0);
    if (item.hasRemainingEntries) acc.remainingSchedules += 1;
    return acc;
  }, {
    totalEntries: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    remainingSchedules: 0,
  });

  return {
    court: courtState.court,
    assigned: courtState.assigned,
    mode: courtState.mode,
    modeLabel: courtState.modeLabel,
    locked: courtState.locked,
    targetUrl: courtState.targetUrl,
    hasSchedule: display.hasSchedule,
    groupId: display.groupId,
    groupIds: display.groupIds,
    queueLength: display.queueLength,
    activeQueueIndex: display.activeQueueIndex,
    queue,
    title: display.title || '',
    currentLabel: display.currentLabel,
    currentStatus: display.currentStatus,
    currentEntry: display.currentEntry,
    currentMeta: display.currentMeta,
    canNext: display.canNext,
    nextReason: display.nextReason,
    matchReady: display.matchReady,
    submittedJudgeCount: display.submittedJudgeCount,
    requiredJudgeCount: display.requiredJudgeCount,
    totalEntries: queueCounts.totalEntries || schedule?.totalEntries || 0,
    counts: queue.length ? {
      pending: queueCounts.pending,
      in_progress: queueCounts.in_progress,
      completed: queueCounts.completed,
    } : counts,
    activeCounts: counts,
    remainingScheduleCount: queueCounts.remainingSchedules,
    updatedAt: display.updatedAt || courtState.updatedAt || null,
  };
}

function buildPerformanceDispatchData() {
  const assignmentsByGroupId = new Map();
  for (const assignment of performanceCourtDisplays.values()) {
    (assignment.groupIds || []).forEach((groupId, index) => {
      assignmentsByGroupId.set(groupId, {
        court: assignment.court,
        order: index + 1,
      });
    });
  }

  const schedules = storage.performanceSchedules
    .map((group) => {
      const counts = countPerformanceScheduleEntries(group.entries || []);
      const assignment = assignmentsByGroupId.get(group.groupId) || null;
      const assignedCourt = assignment?.court || null;

      return {
        ...publicPerformanceScheduleGroup(group),
        counts,
        hasRemainingEntries: performanceScheduleHasRemainingEntries(group),
        assignedCourt,
        assignmentOrder: assignment?.order || null,
        assignmentStatus: !performanceScheduleHasRemainingEntries(group)
          ? 'completed'
          : (assignedCourt ? 'assigned' : 'unassigned'),
      };
    })
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  const courts = Array.from({ length: COURT_COUNT }, (_, index) => performanceCourtSummary(index + 1));

  return {
    courts,
    schedules,
  };
}

function broadcastPerformanceCourtDisplay(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) return;
  broadcast(
    performanceCourtDisplayChannelKey(normalizedCourt),
    'performanceCourtDisplaySnapshot',
    publicPerformanceCourtDisplay(normalizedCourt),
  );
}

function broadcastPerformanceCourtDisplaysForGroup(groupId) {
  for (const assignment of performanceCourtDisplays.values()) {
    if ((assignment.groupIds || []).includes(groupId)) {
      broadcastPerformanceCourtDisplay(assignment.court);
    }
  }
}

function getPerformanceScheduleGroupByKey(batchId, ageGroup, routineId) {
  return storage.performanceSchedules.find((group) => (
    group.batchId === batchId
    && group.ageGroup === ageGroup
    && group.routineId === routineId
  )) || null;
}

function deletePerformanceScheduleGroup(groupId) {
  const index = storage.performanceSchedules.findIndex((group) => group.groupId === groupId);
  if (index === -1) {
    return { statusCode: 404, payload: { error: 'Performance schedule not found' } };
  }

  const impactedAssignments = Array.from(performanceCourtDisplays.values())
    .filter((assignment) => (assignment.groupIds || []).includes(groupId));
  getDatabase().prepare('DELETE FROM performance_schedules WHERE group_id = ?').run(groupId);
  const [deletedGroup] = storage.performanceSchedules.splice(index, 1);
  broadcast(performanceScheduleChannelKey(groupId), 'performanceScheduleDeleted', { groupId });
  impactedAssignments.forEach((assignment) => {
    const nextGroupIds = (assignment.groupIds || []).filter((item) => item !== groupId);
    if (!nextGroupIds.length) {
      deletePerformanceCourtDisplay(assignment.court);
    } else {
      const saved = persistPerformanceCourtDisplay({
        ...assignment,
        groupIds: nextGroupIds,
        updatedAt: nowIso(),
      });
      performanceCourtDisplays.set(saved.court, saved);
    }
    broadcastPerformanceCourtDisplay(assignment.court);
  });

  return {
    statusCode: 200,
    payload: {
      deleted: true,
      groupId,
      schedule: publicPerformanceScheduleGroup(deletedGroup),
    },
  };
}

function persistPerformanceScheduleGroup(group) {
  const db = getDatabase();
  const normalizedGroup = normalizePerformanceScheduleGroup(group);

  db.prepare(`
    INSERT INTO performance_schedules (
      group_id,
      batch_id,
      age_group,
      routine_id,
      routine_name,
      entries_json,
      total_entries,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id, age_group, routine_id) DO UPDATE SET
      routine_name = excluded.routine_name,
      entries_json = excluded.entries_json,
      total_entries = excluded.total_entries,
      updated_at = excluded.updated_at
  `).run(
    normalizedGroup.groupId,
    normalizedGroup.batchId,
    normalizedGroup.ageGroup,
    normalizedGroup.routineId,
    normalizedGroup.routineName,
    JSON.stringify(normalizedGroup.entries),
    normalizedGroup.totalEntries,
    normalizedGroup.createdAt,
    normalizedGroup.updatedAt,
  );

  return normalizedGroup;
}

function savePerformanceScheduleGroup(payload) {
  const batchId = String(payload?.batchId || '').trim();
  const ageGroup = String(payload?.ageGroup || '').trim();
  const routineId = String(payload?.routineId || '').trim();
  const batch = getImportBatch(batchId);
  const routineSelection = resolveRoutineSelection(routineId);

  if (!batch) return { statusCode: 404, payload: { error: 'Import batch not found' } };
  if (!ageGroup) return { statusCode: 400, payload: { error: 'ageGroup is required' } };
  if (!routineSelection) return { statusCode: 400, payload: { error: 'routineId is invalid' } };
  if (!Array.isArray(payload?.entries) || payload.entries.length === 0) {
    return { statusCode: 400, payload: { error: 'entries must be a non-empty array' } };
  }

  const normalizedEntries = payload.entries.map((entry, index) => normalizePerformanceScheduleEntry(entry, index));
  const invalidEntry = normalizedEntries.find((entry) => (
    entry.needsAttention || entry.participantCount !== entry.expectedMemberCount
  ));
  if (invalidEntry) {
    return {
      statusCode: 400,
      payload: {
        error: invalidEntry.attentionReason
          || `Đội "${invalidEntry.displayName}" chưa đủ ${invalidEntry.expectedMemberCount} VĐV.`,
      },
    };
  }

  const existing = getPerformanceScheduleGroupByKey(batchId, ageGroup, routineId);
  const group = persistPerformanceScheduleGroup({
    groupId: existing?.groupId || newId('performance_schedule'),
    batchId,
    ageGroup,
    routineId,
    routineName: routineSelection.routine.name,
    entries: normalizedEntries,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  });

  storage.performanceSchedules = readPerformanceSchedulesFromDatabase();
  const savedGroup = getPerformanceScheduleGroup(group.groupId) || group;
  broadcastPerformanceScheduleGroup(savedGroup.groupId);
  broadcastPerformanceCourtDisplaysForGroup(savedGroup.groupId);

  return {
    statusCode: 200,
    payload: {
      saved: true,
      schedule: publicPerformanceScheduleGroup(savedGroup, true),
    },
  };
}

function updatePerformanceScheduleEntryStatus(groupId, entryId, status) {
  const normalizedStatus = ['pending', 'in_progress', 'completed'].includes(String(status || '').trim())
    ? String(status).trim()
    : '';
  if (!normalizedStatus) {
    return { statusCode: 400, payload: { error: 'status must be pending, in_progress, or completed' } };
  }

  const group = getPerformanceScheduleGroup(groupId);
  if (!group) {
    return { statusCode: 404, payload: { error: 'Performance schedule not found' } };
  }

  const entryIndex = group.entries.findIndex((entry) => entry.entryId === entryId);
  if (entryIndex === -1) {
    return { statusCode: 404, payload: { error: 'Performance schedule entry not found' } };
  }

  const now = nowIso();
  const nextEntries = group.entries.map((entry, index) => {
    if (normalizedStatus === 'in_progress' && index !== entryIndex && entry.status === 'in_progress') {
      return normalizePerformanceScheduleEntry({
        ...entry,
        status: 'pending',
        startedAt: null,
        completedAt: null,
      }, index);
    }

    if (index !== entryIndex) return normalizePerformanceScheduleEntry(entry, index);

    if (normalizedStatus === 'pending') {
      return normalizePerformanceScheduleEntry({
        ...entry,
        status: 'pending',
        startedAt: null,
        completedAt: null,
      }, index);
    }

    if (normalizedStatus === 'in_progress') {
      return normalizePerformanceScheduleEntry({
        ...entry,
        status: 'in_progress',
        startedAt: entry.startedAt || now,
        completedAt: null,
      }, index);
    }

    return normalizePerformanceScheduleEntry({
      ...entry,
      status: 'completed',
      startedAt: entry.startedAt || now,
      completedAt: now,
    }, index);
  });

  persistPerformanceScheduleGroup({
    ...group,
    entries: nextEntries,
    updatedAt: now,
  });
  storage.performanceSchedules = readPerformanceSchedulesFromDatabase();
  const savedGroup = getPerformanceScheduleGroup(groupId);
  broadcastPerformanceScheduleGroup(groupId);
  broadcastPerformanceCourtDisplaysForGroup(groupId);

  return {
    statusCode: 200,
    payload: {
      saved: true,
      schedule: publicPerformanceScheduleGroup(savedGroup, true),
    },
  };
}

function resetPerformanceScheduleStatuses(groupId) {
  const group = getPerformanceScheduleGroup(groupId);
  if (!group) {
    return { statusCode: 404, payload: { error: 'Performance schedule not found' } };
  }

  const nextEntries = group.entries.map((entry, index) => normalizePerformanceScheduleEntry({
    ...entry,
    status: 'pending',
    startedAt: null,
    completedAt: null,
  }, index));

  persistPerformanceScheduleGroup({
    ...group,
    entries: nextEntries,
    updatedAt: nowIso(),
  });
  storage.performanceSchedules = readPerformanceSchedulesFromDatabase();
  const savedGroup = getPerformanceScheduleGroup(groupId);
  broadcastPerformanceScheduleGroup(groupId);
  broadcastPerformanceCourtDisplaysForGroup(groupId);

  return {
    statusCode: 200,
    payload: {
      saved: true,
      schedule: publicPerformanceScheduleGroup(savedGroup, true),
    },
  };
}

function assignPerformanceScheduleToCourt(court, groupIdsInput) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }

  const groupIds = Array.from(new Set(
    (Array.isArray(groupIdsInput) ? groupIdsInput : [groupIdsInput])
      .map((groupId) => String(groupId || '').trim())
      .filter(Boolean),
  ));

  if (!groupIds.length) {
    return { statusCode: 400, payload: { error: 'Chọn ít nhất một nội dung hội diễn.' } };
  }

  const schedules = groupIds.map((groupId) => getPerformanceScheduleGroup(groupId));
  if (schedules.some((schedule) => !schedule)) {
    return { statusCode: 404, payload: { error: 'Performance schedule not found' } };
  }

  const occupied = Array.from(performanceCourtDisplays.values()).find((item) => (
    item.court !== normalizedCourt && (item.groupIds || []).some((groupId) => groupIds.includes(groupId))
  ));
  if (occupied) {
    return {
      statusCode: 409,
      payload: { error: `Nội dung này đang được gán cho sân ${occupied.court}.` },
    };
  }

  const ensuredCourt = ensurePerformanceCourtForMc(normalizedCourt);
  if (ensuredCourt.statusCode >= 400) {
    return ensuredCourt;
  }

  const existing = getPerformanceCourtDisplay(normalizedCourt);
  const existingGroupIds = existing?.groupIds || [];
  const nextGroupIds = Array.from(new Set([...existingGroupIds, ...groupIds]));
  if (existingGroupIds.length === nextGroupIds.length) {
    const courtAssignment = getCourtAssignment(normalizedCourt);
    const matchId = courtAssignment?.matchId || defaultMatchIdForMode('performance', normalizedCourt);
    return {
      statusCode: 200,
      payload: {
        reused: true,
        display: publicPerformanceCourtDisplay(normalizedCourt),
        match: publicPerformanceMatch(getPerformanceMatch(matchId, normalizedCourt)),
      },
    };
  }

  const saved = persistPerformanceCourtDisplay({
    court: normalizedCourt,
    groupIds: nextGroupIds,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  });
  performanceCourtDisplays.set(saved.court, saved);
  broadcastPerformanceCourtDisplay(saved.court);
  const courtAssignment = getCourtAssignment(normalizedCourt);
  const matchId = courtAssignment?.matchId || defaultMatchIdForMode('performance', normalizedCourt);
  const activeBefore = existing ? getActivePerformanceCourtSchedule(existing) : null;
  const activeAfter = getActivePerformanceCourtSchedule(saved);
  const resetMatch = activeBefore?.groupId === activeAfter?.groupId
    ? getPerformanceMatch(matchId, normalizedCourt)
    : resetPerformanceMatch(matchId, normalizedCourt);

  return {
    statusCode: 200,
    payload: {
      saved: true,
      display: publicPerformanceCourtDisplay(saved.court),
      match: publicPerformanceMatch(resetMatch),
    },
  };
}

function clearPerformanceScheduleFromCourt(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }

  const existing = getPerformanceCourtDisplay(normalizedCourt);
  if (!existing) {
    return {
      statusCode: 200,
      payload: {
        cleared: false,
        display: publicPerformanceCourtDisplay(normalizedCourt),
      },
    };
  }

  deletePerformanceCourtDisplay(normalizedCourt);
  const courtAssignment = getCourtAssignment(normalizedCourt);
  const matchId = courtAssignment?.matchId || defaultMatchIdForMode('performance', normalizedCourt);
  const resetMatch = resetPerformanceMatch(matchId, normalizedCourt);
  broadcastPerformanceCourtDisplay(normalizedCourt);

  return {
    statusCode: 200,
    payload: {
      cleared: true,
      display: publicPerformanceCourtDisplay(normalizedCourt),
      match: publicPerformanceMatch(resetMatch),
    },
  };
}

function removePerformanceScheduleFromCourt(court, groupId) {
  const normalizedCourt = normalizeCourt(court);
  const targetGroupId = String(groupId || '').trim();
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }
  if (!targetGroupId) {
    return { statusCode: 400, payload: { error: 'groupId is required' } };
  }

  const existing = getPerformanceCourtDisplay(normalizedCourt);
  if (!existing || !(existing.groupIds || []).includes(targetGroupId)) {
    return {
      statusCode: 200,
      payload: {
        removed: false,
        display: publicPerformanceCourtDisplay(normalizedCourt),
      },
    };
  }

  const activeBefore = getActivePerformanceCourtSchedule(existing);
  const nextGroupIds = (existing.groupIds || []).filter((item) => item !== targetGroupId);
  let saved = null;

  if (nextGroupIds.length) {
    saved = persistPerformanceCourtDisplay({
      court: normalizedCourt,
      groupIds: nextGroupIds,
      createdAt: existing.createdAt || nowIso(),
      updatedAt: nowIso(),
    });
    performanceCourtDisplays.set(saved.court, saved);
  } else {
    deletePerformanceCourtDisplay(normalizedCourt);
  }

  const courtAssignment = getCourtAssignment(normalizedCourt);
  const matchId = courtAssignment?.matchId || defaultMatchIdForMode('performance', normalizedCourt);
  const activeAfter = saved ? getActivePerformanceCourtSchedule(saved) : null;
  const match = activeBefore?.groupId === activeAfter?.groupId
    ? getPerformanceMatch(matchId, normalizedCourt)
    : resetPerformanceMatch(matchId, normalizedCourt);

  broadcastPerformanceCourtDisplay(normalizedCourt);

  return {
    statusCode: 200,
    payload: {
      removed: true,
      display: publicPerformanceCourtDisplay(normalizedCourt),
      match: publicPerformanceMatch(match),
    },
  };
}

function advancePerformanceScheduleForCourt(court) {
  const normalizedCourt = normalizeCourt(court);
  if (!normalizedCourt) {
    return { statusCode: 400, payload: { error: `court must be 1-${COURT_COUNT}` } };
  }

  const ensured = ensurePerformanceScheduleForCourt(normalizedCourt);
  if (ensured.statusCode >= 400) {
    return ensured;
  }

  const assignment = getPerformanceCourtDisplay(normalizedCourt);
  if (!assignment) {
    return { statusCode: 404, payload: { error: 'Không còn danh sách hội diễn nào để chuyển tiếp.' } };
  }

  const group = getActivePerformanceCourtSchedule(assignment);
  if (!group) {
    return { statusCode: 404, payload: { error: 'Hàng chờ hội diễn của sân này đã hoàn thành hết.' } };
  }

  const entries = group.entries.map((entry, index) => normalizePerformanceScheduleEntry(entry, index));
  const currentIndex = entries.findIndex((entry) => entry.status === 'in_progress');
  const activeIndex = currentIndex >= 0
    ? currentIndex
    : entries.findIndex((entry) => (entry.status || 'pending') === 'pending');

  if (activeIndex === -1) {
    return { statusCode: 400, payload: { error: 'Không còn VĐV/đội nào để chuyển tiếp.' } };
  }

  const courtAssignment = getCourtAssignment(normalizedCourt);
  const matchId = courtAssignment?.matchId || defaultMatchIdForMode('performance', normalizedCourt);
  const matchSnapshot = publicPerformanceMatch(getPerformanceMatch(matchId, normalizedCourt));
  if (!matchSnapshot.result?.ready) {
    return { statusCode: 409, payload: { error: 'Chưa có đủ điểm công bố kết quả nên chưa thể Next.' } };
  }

  let nextIndex = -1;
  const now = nowIso();
  const activeEntry = entries[activeIndex];

  saveCompletedPerformanceResult({
    group,
    entry: {
      ...activeEntry,
      startedAt: activeEntry.startedAt || now,
      completedAt: now,
    },
    court: normalizedCourt,
    matchId,
    matchSnapshot,
    completedAt: now,
  });

  const nextEntries = entries.map((entry, index) => {
    if (index === activeIndex) {
      return normalizePerformanceScheduleEntry({
        ...entry,
        status: 'completed',
        startedAt: entry.startedAt || now,
        completedAt: now,
      }, index);
    }

    return normalizePerformanceScheduleEntry(entry, index);
  });

  nextIndex = nextEntries.findIndex((entry) => entry.status === 'pending');
  if (nextIndex >= 0) {
    nextEntries[nextIndex] = normalizePerformanceScheduleEntry({
      ...nextEntries[nextIndex],
      status: 'in_progress',
      startedAt: now,
      completedAt: null,
    }, nextIndex);
  }

  persistPerformanceScheduleGroup({
    ...group,
    entries: nextEntries,
    updatedAt: now,
  });
  storage.performanceSchedules = readPerformanceSchedulesFromDatabase();
  const savedGroup = getPerformanceScheduleGroup(group.groupId);
  broadcastPerformanceScheduleGroup(group.groupId);
  broadcastPerformanceCourtDisplay(normalizedCourt);

  const resetMatch = resetPerformanceMatch(matchId, normalizedCourt);

  return {
    statusCode: 200,
    payload: {
      saved: true,
      display: publicPerformanceCourtDisplay(normalizedCourt),
      schedule: publicPerformanceScheduleGroup(savedGroup, true),
      match: publicPerformanceMatch(resetMatch),
    },
  };
}

function buildPerformancePlannerEntries(batch, ageGroup, routineId, requestedMemberCount = null) {
  const options = buildPerformancePlannerOptions(batch);
  if (options.indexes.age < 0) return { error: 'Không nhận diện được cột Lứa tuổi trong batch import.' };
  if (options.indexes.routine < 0) return { error: 'Không nhận diện được cột Bài quyền/Nội dung thi trong batch import.' };

  const routineSelection = resolveRoutineSelection(routineId);
  if (!routineSelection) return { error: 'routineId is invalid' };
  const parsedRoutineId = parseRoutineSelectionId(routineId);
  const targetRoutineId = parsedRoutineId.kind === 'import'
    ? parsedRoutineId.routineId
    : routineSelection.routine.id;
  const memberCount = normalizePerformanceMemberCount(
    requestedMemberCount,
    routineSelection.kind === 'system'
      ? (options.routineOptions.find((routine) => routine.id === targetRoutineId)?.memberCount
        || routineSelection.routine.memberCount
        || 1)
      : (routineSelection.routine.memberCount || 1),
  );

  const matchingRows = batch.rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => getRowCell(row, options.indexes.age) === ageGroup)
    .map(({ row, rowIndex }) => {
      const rawRoutineValue = getRowCell(row, options.indexes.routine);
      const matchedRoutines = routineSelection.kind === 'system'
        ? matchedPerformanceRoutinesForValue(rawRoutineValue)
        : matchedRoutinesForValue(rawRoutineValue, routineSelection.batch.routines);
      return {
        row,
        rowIndex,
        matchedRoutines,
      };
    })
    .filter(({ matchedRoutines }) => matchedRoutines.some((item) => item.id === targetRoutineId))
    .map(({ row, rowIndex }) => ({
      row,
      rowIndex,
      name: getRowCell(row, options.indexes.name) || getRowCell(row, 0) || `Mục ${rowIndex + 1}`,
      unit: getRowCell(row, options.indexes.unit),
      rowAgeGroup: getRowCell(row, options.indexes.age),
    }));

  let entries = [];
  if (memberCount === 1) {
    entries = matchingRows.map((item, entryIndex) => normalizePerformanceScheduleEntry({
      entryId: `row_${item.rowIndex + 1}`,
      displayName: item.name,
      unit: item.unit,
      ageGroup: item.rowAgeGroup,
      routineName: routineSelection.routine.name,
      sourceRowIndex: item.rowIndex,
      sourceRowIndexes: [item.rowIndex],
      originalOrder: entryIndex + 1,
      memberNames: [item.name],
      participantCount: 1,
      expectedMemberCount: 1,
      autoGroupKey: `single:${item.rowIndex}`,
    }, entryIndex));
  } else {
    const rowsByUnit = new Map();
    matchingRows.forEach((item) => {
      const unitKey = normalizeText(item.unit) || '__missing_unit__';
      if (!rowsByUnit.has(unitKey)) rowsByUnit.set(unitKey, []);
      rowsByUnit.get(unitKey).push(item);
    });

    rowsByUnit.forEach((unitRows, unitKey) => {
      const groupCountForUnit = Math.ceil(unitRows.length / memberCount);
      for (let offset = 0; offset < unitRows.length; offset += memberCount) {
        const members = unitRows.slice(offset, offset + memberCount);
        const groupNumber = Math.floor(offset / memberCount) + 1;
        const unit = members[0]?.unit || '';
        const missingUnit = !unit;
        const incomplete = members.length !== memberCount;
        const suffix = groupCountForUnit > 1 ? ` ${groupNumber}` : '';
        const displayName = unit
          ? `Đội ${unit}${suffix}`
          : `Đội chưa rõ đơn vị${suffix}`;
        const attentionReasons = [];
        if (missingUnit) attentionReasons.push('Thiếu Đơn vị nên chưa thể xác nhận cách gom đội.');
        if (incomplete) attentionReasons.push(`Đội mới có ${members.length}/${memberCount} VĐV.`);

        entries.push(normalizePerformanceScheduleEntry({
          entryId: `team_${slugifyText(unitKey)}_${groupNumber}_${members[0]?.rowIndex + 1}`,
          displayName,
          unit,
          ageGroup,
          routineName: routineSelection.routine.name,
          sourceRowIndex: members[0]?.rowIndex,
          sourceRowIndexes: members.map((member) => member.rowIndex),
          originalOrder: entries.length + 1,
          memberNames: members.map((member) => member.name),
          participantCount: members.length,
          expectedMemberCount: memberCount,
          groupNumber,
          groupCountForUnit,
          autoGroupKey: `${normalizeText(ageGroup)}:${targetRoutineId}:${unitKey}:${groupNumber}`,
          needsAttention: missingUnit || incomplete,
          attentionReason: attentionReasons.join(' '),
        }, entries.length));
      }
    });
  }

  return {
    routine: routineSelection.routine,
    routineSelection,
    memberCount,
    totalAthletes: matchingRows.length,
    incompleteEntries: entries.filter((entry) => entry.needsAttention).length,
    entries,
    options,
  };
}

function normalizeStoredImportBatch(batch) {
  const rows = Array.isArray(batch.rows) ? batch.rows : [];
  const columns = Array.isArray(batch.columns) ? batch.columns : [];
  const savedAt = batch.savedAt || batch.importedAt || nowIso();

  return {
    batchId: batch.batchId || newId('import'),
    fileName: String(batch.fileName || 'unknown'),
    fileType: String(batch.fileType || 'UNKNOWN'),
    sheetName: String(batch.sheetName || 'Sheet1'),
    columns,
    totalRows: Number(batch.totalRows || rows.length || 0),
    rows,
    importedAt: batch.importedAt || savedAt,
    savedAt,
  };
}

function persistImportBatch(batch) {
  const db = getDatabase();
  const storedBatch = normalizeStoredImportBatch(batch);

  db.prepare(`
    INSERT INTO import_batches (
      batch_id,
      file_name,
      file_type,
      sheet_name,
      columns_json,
      rows_json,
      total_rows,
      imported_at,
      saved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(batch_id) DO UPDATE SET
      file_name = excluded.file_name,
      file_type = excluded.file_type,
      sheet_name = excluded.sheet_name,
      columns_json = excluded.columns_json,
      rows_json = excluded.rows_json,
      total_rows = excluded.total_rows,
      imported_at = excluded.imported_at,
      saved_at = excluded.saved_at
  `).run(
    storedBatch.batchId,
    storedBatch.fileName,
    storedBatch.fileType,
    storedBatch.sheetName,
    JSON.stringify(storedBatch.columns),
    JSON.stringify(storedBatch.rows),
    storedBatch.totalRows,
    storedBatch.importedAt,
    storedBatch.savedAt,
  );

  return storedBatch;
}

function readImportBatchesFromDatabase() {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      batch_id,
      file_name,
      file_type,
      sheet_name,
      columns_json,
      rows_json,
      total_rows,
      imported_at,
      saved_at
    FROM import_batches
    ORDER BY saved_at DESC
  `).all();

  return rows.map((row) => normalizeStoredImportBatch({
    batchId: row.batch_id,
    fileName: row.file_name,
    fileType: row.file_type,
    sheetName: row.sheet_name,
    columns: JSON.parse(row.columns_json || '[]'),
    rows: JSON.parse(row.rows_json || '[]'),
    totalRows: row.total_rows,
    importedAt: row.imported_at,
    savedAt: row.saved_at,
  }));
}

function migrateLegacyStorageIfNeeded() {
  const db = getDatabase();
  const matchCount = db.prepare('SELECT COUNT(*) AS count FROM matches').get().count;
  const importCount = db.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count;

  if (matchCount > 0 || importCount > 0 || !fs.existsSync(LEGACY_STORAGE_FILE)) {
    return;
  }

  const raw = fs.readFileSync(LEGACY_STORAGE_FILE, 'utf8');
  if (!raw.trim()) return;

  const payload = JSON.parse(raw);
  let migratedMatches = 0;
  let migratedImports = 0;

  if (Array.isArray(payload.matches)) {
    payload.matches.forEach((item) => {
      if (!item.matchId) return;
      const match = hydrateMatch(item);
      matches.set(match.matchId, match);
      saveMatch(match);
      migratedMatches += 1;
    });
  }

  if (Array.isArray(payload.importedAthleteBatches)) {
    payload.importedAthleteBatches.forEach((item) => {
      persistImportBatch(item);
      migratedImports += 1;
    });
  }

  if (migratedMatches > 0 || migratedImports > 0) {
    console.log(`Migrated legacy JSON storage to SQLite: ${migratedMatches} matches, ${migratedImports} imports.`);
  }
}

function saveStorage() {
  Array.from(matches.values()).forEach((match) => saveMatch(match));
  Array.from(performanceMatches.values()).forEach((match) => savePerformanceMatch(match));
  Array.from(courtAssignments.values()).forEach((assignment) => saveCourtAssignment(assignment));
  Array.from(mcCourtStates.values()).forEach((state) => persistMcCourtState(state));
  Array.from(performanceCourtDisplays.values()).forEach((display) => persistPerformanceCourtDisplay(display));
  if (storage.tournamentInfo) saveTournamentInfo(storage.tournamentInfo);
  storage.performanceSchedules.forEach((group) => persistPerformanceScheduleGroup(group));
  storage.performanceRoutineBatches.forEach((batch) => persistPerformanceRoutineBatch(batch));
  storage.performanceResults.forEach((result) => persistPerformanceRankingResult(result));
}

function loadStorage() {
  getDatabase();
  migrateLegacyStorageIfNeeded();

  matches.clear();
  performanceMatches.clear();
  courtAssignments.clear();
  mcCourtStates.clear();
  performanceCourtDisplays.clear();
  const rows = getDatabase().prepare('SELECT payload_json FROM matches ORDER BY updated_at ASC').all();

  rows.forEach((row) => {
    const item = JSON.parse(row.payload_json);
    if (!item.matchId) return;
    matches.set(item.matchId, hydrateMatch(item));
  });

  const performanceRows = getDatabase()
    .prepare('SELECT payload_json FROM performance_matches ORDER BY updated_at ASC')
    .all();

  performanceRows.forEach((row) => {
    const item = JSON.parse(row.payload_json);
    if (!item.matchId) return;
    performanceMatches.set(item.matchId, hydratePerformanceMatch(item));
  });

  readCourtAssignmentsFromDatabase().forEach((assignment) => {
    courtAssignments.set(assignment.court, assignment);
  });

  readMcCourtStatesFromDatabase().forEach((state) => {
    mcCourtStates.set(state.court, state);
  });

  readPerformanceCourtDisplaysFromDatabase().forEach((display) => {
    performanceCourtDisplays.set(display.court, display);
  });

  storage.importedAthleteBatches = readImportBatchesFromDatabase();
  storage.tournamentInfo = readTournamentInfoFromDatabase();
  storage.performanceSchedules = readPerformanceSchedulesFromDatabase();
  storage.performanceRoutineBatches = readPerformanceRoutineBatchesFromDatabase();
  storage.performanceResults = readPerformanceRankingResultsFromDatabase();
}

function getMatch(matchId) {
  if (!matches.has(matchId)) {
    const match = {
      matchId,
      status: 'running',
      round: 1,
      scores: {
        blue: 0,
        red: 0,
      },
      winner: null,
      voteGroups: [],
      audit: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    matches.set(matchId, match);
    saveMatch(match);
  }

  return matches.get(matchId);
}

function getPerformanceMatch(matchId, court = '') {
  if (!performanceMatches.has(matchId)) {
    const match = {
      matchId,
      court: String(court || ''),
      judgeScores: createEmptyPerformanceScores(),
      judgeDevices: Object.fromEntries(
        Array.from({ length: performanceConfig.judgeCount }, (_, index) => {
          const judgeId = index + 1;
          return [judgeId, `Máy ${judgeId}`];
        }),
      ),
      audit: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    performanceMatches.set(matchId, match);
    savePerformanceMatch(match);
  }

  const match = performanceMatches.get(matchId);
  if (court && !match.court) {
    match.court = String(court);
    savePerformanceMatch(match);
  }

  return match;
}

function publicMatch(match) {
  return {
    matchId: match.matchId,
    status: match.status,
    round: match.round,
    scores: match.scores,
    winner: match.winner,
    config,
    pendingVoteGroups: match.voteGroups
      .filter((group) => !group.accepted && Date.now() - group.startedAt <= config.scoringWindowMs)
      .map((group) => ({
        id: group.id,
        side: group.side,
        point: group.point,
        judges: Array.from(group.judges),
        startedAt: new Date(group.startedAt).toISOString(),
      })),
    audit: match.audit.slice(-50),
    updatedAt: match.updatedAt,
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function readJson(req, maxBytes = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function readBuffer(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('File too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

function validateVote(payload) {
  const matchId = String(payload.matchId || 'MATCH_001').trim();
  const court = String(payload.court || '').trim();
  const judgeId = Number(payload.judgeId);
  const side = String(payload.side || '').trim();
  const point = Number(payload.point);

  if (!matchId) return { error: 'matchId is required' };
  if (!Number.isInteger(judgeId) || judgeId < 1 || judgeId > config.judgeCount) {
    return { error: `judgeId must be 1-${config.judgeCount}` };
  }
  if (!['blue', 'red'].includes(side)) {
    return { error: 'side must be blue or red' };
  }
  if (!Number.isInteger(point) || point < 1 || point > 3) {
    return { error: 'point must be 1, 2, or 3' };
  }

  return { matchId, court, judgeId, side, point };
}

function validateSidePoint(payload) {
  const side = String(payload.side || '').trim();
  const point = Number(payload.point || 1);

  if (!['blue', 'red'].includes(side)) {
    return { error: 'side must be blue or red' };
  }
  if (!Number.isInteger(point) || point < 1 || point > 99) {
    return { error: 'point must be a positive integer' };
  }

  return { side, point };
}

function validatePerformanceScore(payload) {
  const matchId = String(payload.matchId || 'PERFORMANCE_COURT_1').trim();
  const court = String(payload.court || '').trim();
  const judgeId = Number(payload.judgeId);
  const score = Number(payload.score);
  const deviceLabel = String(payload.deviceLabel || `Máy ${judgeId}`).trim() || `Máy ${judgeId}`;

  if (!matchId) return { error: 'matchId is required' };
  if (!Number.isInteger(judgeId) || judgeId < 1 || judgeId > performanceConfig.judgeCount) {
    return { error: `judgeId must be 1-${performanceConfig.judgeCount}` };
  }
  if (!Number.isFinite(score) || score < performanceConfig.minScore || score > performanceConfig.maxScore) {
    return { error: `score must be ${performanceConfig.minScore}-${performanceConfig.maxScore}` };
  }
  if (!isValidPerformanceScoreStep(score)) {
    return { error: `score must follow step ${performanceConfig.scoreStep}` };
  }

  return {
    matchId,
    court,
    judgeId,
    score: Number(score.toFixed(performanceConfig.scoreDecimals)),
    deviceLabel,
  };
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index = buffer.indexOf(separator, start);

  while (index !== -1) {
    parts.push(buffer.slice(start, index));
    start = index + separator.length;
    index = buffer.indexOf(separator, start);
  }

  parts.push(buffer.slice(start));
  return parts;
}

function parseMultipartFile(contentType, body) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(contentType || '');
  if (!boundaryMatch) {
    throw new Error('Missing multipart boundary');
  }

  const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
  const parts = splitBuffer(body, Buffer.from(`--${boundary}`));

  for (let part of parts) {
    if (part.length === 0) continue;
    if (part.slice(0, 2).toString() === '--') continue;
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;

    const rawHeaders = part.slice(0, headerEnd).toString('utf8');
    const fileBody = part.slice(headerEnd + 4);
    const disposition = /content-disposition:[^\r\n]+/i.exec(rawHeaders);
    if (!disposition) continue;

    const filenameMatch = /filename="([^"]*)"/i.exec(disposition[0]);
    if (!filenameMatch || !filenameMatch[1]) continue;

    return {
      filename: path.basename(filenameMatch[1]),
      buffer: fileBody,
    };
  }

  throw new Error('No file found');
}

function xmlDecode(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function parseXmlAttributes(raw) {
  const attrs = {};
  const attrRegex = /([:\w-]+)="([^"]*)"/g;
  let match = attrRegex.exec(raw || '');

  while (match) {
    attrs[match[1]] = xmlDecode(match[2]);
    match = attrRegex.exec(raw || '');
  }

  return attrs;
}

function columnIndex(cellRef) {
  const letters = String(cellRef || '').match(/[A-Z]+/i);
  if (!letters) return 0;

  let index = 0;
  for (const char of letters[0].toUpperCase()) {
    index = index * 26 + char.charCodeAt(0) - 64;
  }

  return Math.max(0, index - 1);
}

function parseZip(buffer) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;

  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid XLSX zip structure');
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const files = new Map();
  let cursor = centralOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid XLSX central directory');
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Invalid XLSX local file header');
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    const content = method === 0 ? compressed : zlib.inflateRawSync(compressed);

    files.set(name.replace(/\\/g, '/'), content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

function parseSharedStrings(xml) {
  const strings = [];
  const siRegex = /<si\b[\s\S]*?<\/si>/g;
  let match = siRegex.exec(xml || '');

  while (match) {
    const textParts = [];
    const textRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let textMatch = textRegex.exec(match[0]);

    while (textMatch) {
      textParts.push(xmlDecode(textMatch[1]));
      textMatch = textRegex.exec(match[0]);
    }

    strings.push(textParts.join(''));
    match = siRegex.exec(xml || '');
  }

  return strings;
}

function findFirstSheet(files) {
  const workbookXml = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const sheetMatch = /<sheet\b([^>]*)\/?>/i.exec(workbookXml);

  if (!sheetMatch) {
    return {
      name: 'Sheet1',
      path: 'xl/worksheets/sheet1.xml',
    };
  }

  const attrs = parseXmlAttributes(sheetMatch[1]);
  const relId = attrs['r:id'];
  let target = '';

  if (relId) {
    const relRegex = new RegExp(`<Relationship[^>]+Id="${relId}"[^>]+Target="([^"]+)"`, 'i');
    const relMatch = relRegex.exec(relsXml);
    if (relMatch) target = xmlDecode(relMatch[1]);
  }

  if (!target) target = 'worksheets/sheet1.xml';
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;

  return {
    name: attrs.name || 'Sheet1',
    path: sheetPath.replace(/\/\.\//g, '/'),
  };
}

function parseCellValue(attrs, body, sharedStrings) {
  if (attrs.t === 'inlineStr') {
    const values = [];
    const textRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let textMatch = textRegex.exec(body || '');

    while (textMatch) {
      values.push(xmlDecode(textMatch[1]));
      textMatch = textRegex.exec(body || '');
    }

    return values.join('');
  }

  const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(body || '');
  if (!valueMatch) return '';

  const value = xmlDecode(valueMatch[1]);
  if (attrs.t === 's') {
    return sharedStrings[Number(value)] || '';
  }

  if (attrs.t === 'b') {
    return value === '1' ? 'TRUE' : 'FALSE';
  }

  return value;
}

function parseSheetRows(sheetXml, sharedStrings) {
  const rows = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch = rowRegex.exec(sheetXml || '');

  while (rowMatch) {
    const row = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch = cellRegex.exec(rowMatch[1]);

    while (cellMatch) {
      const attrs = parseXmlAttributes(cellMatch[1]);
      row[columnIndex(attrs.r)] = parseCellValue(attrs, cellMatch[2], sharedStrings);
      cellMatch = cellRegex.exec(rowMatch[1]);
    }

    rows.push(row);
    rowMatch = rowRegex.exec(sheetXml || '');
  }

  return rows;
}

function parseCsvRows(text, delimiter) {
  const rows = [[]];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      rows[rows.length - 1].push(value);
      value = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      rows[rows.length - 1].push(value);
      value = '';
      if (char === '\r' && next === '\n') i += 1;
      rows.push([]);
      continue;
    }

    value += char;
  }

  rows[rows.length - 1].push(value);
  return rows;
}

function normalizeImportedRows(rows) {
  const nonEmptyRows = rows.filter((row) => row.some((value) => String(value || '').trim() !== ''));
  const headerRow = nonEmptyRows[0] || [];
  const dataRows = nonEmptyRows.slice(1);
  const maxColumns = Math.max(headerRow.length, ...dataRows.map((row) => row.length), 0);
  const columns = [];

  for (let i = 0; i < maxColumns; i += 1) {
    const header = String(headerRow[i] || '').trim();
    columns.push(header || `Cột ${i + 1}`);
  }

  const normalizedRows = dataRows.map((row) => (
    columns.map((_, index) => String(row[index] || '').trim())
  ));

  return {
    columns,
    totalRows: normalizedRows.length,
    rows: normalizedRows,
    previewRows: normalizedRows.slice(0, 100).map((row) => (
      columns.map((_, index) => String(row[index] || '').trim())
    )),
  };
}

function publicImportBatch(batch, includeRows = false) {
  return {
    batchId: batch.batchId,
    fileName: batch.fileName,
    fileType: batch.fileType,
    sheetName: batch.sheetName,
    columns: batch.columns,
    totalRows: batch.totalRows,
    previewRows: batch.rows.slice(0, 100),
    stored: true,
    savedAt: batch.savedAt,
    importedAt: batch.importedAt,
    ...(includeRows ? { rows: batch.rows } : {}),
  };
}

function saveImportedAthleteBatch(result) {
  const importedAt = nowIso();
  const batch = {
    batchId: newId('import'),
    fileName: result.fileName,
    fileType: result.fileType,
    sheetName: result.sheetName,
    columns: result.columns,
    totalRows: result.totalRows,
    rows: result.rows,
    importedAt,
    savedAt: importedAt,
  };

  const storedBatch = persistImportBatch(batch);
  storage.importedAthleteBatches.unshift(storedBatch);
  return storedBatch;
}

function isImportBatchRoute(pathname) {
  return (
    pathname.startsWith('/api/imports/athletes/')
    || pathname.startsWith('/api/import/athletes/')
  );
}

function getImportBatchIndex(batchId) {
  return storage.importedAthleteBatches.findIndex((item) => item.batchId === batchId);
}

function getImportBatch(batchId) {
  const index = getImportBatchIndex(batchId);
  return index === -1 ? null : storage.importedAthleteBatches[index];
}

function normalizeEditableImportPayload(payload, currentBatch) {
  const rawColumns = Array.isArray(payload.columns) ? payload.columns : currentBatch.columns;
  const rawRows = Array.isArray(payload.rows) ? payload.rows : currentBatch.rows;

  if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
    return { error: 'columns must be a non-empty array' };
  }

  if (!Array.isArray(rawRows)) {
    return { error: 'rows must be an array' };
  }

  const columns = rawColumns.map((column, index) => {
    const value = String(column || '').trim();
    return value || `Cột ${index + 1}`;
  });

  const rows = rawRows.map((row) => (
    columns.map((_, index) => (
      Array.isArray(row) ? String(row[index] || '').trim() : ''
    ))
  ));

  return { columns, rows };
}

function updateImportedAthleteBatch(batchId, payload) {
  const index = getImportBatchIndex(batchId);
  if (index === -1) return { statusCode: 404, payload: { error: 'Import batch not found' } };

  const currentBatch = storage.importedAthleteBatches[index];
  const parsed = normalizeEditableImportPayload(payload, currentBatch);
  if (parsed.error) return { statusCode: 400, payload: { error: parsed.error } };

  const updatedBatch = persistImportBatch({
    ...currentBatch,
    columns: parsed.columns,
    rows: parsed.rows,
    totalRows: parsed.rows.length,
    savedAt: nowIso(),
  });

  storage.importedAthleteBatches[index] = updatedBatch;
  storage.importedAthleteBatches.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  return { statusCode: 200, payload: publicImportBatch(updatedBatch, true) };
}

function deleteImportedAthleteBatch(batchId) {
  const index = getImportBatchIndex(batchId);
  if (index === -1) return { statusCode: 404, payload: { error: 'Import batch not found' } };

  getDatabase().prepare('DELETE FROM import_batches WHERE batch_id = ?').run(batchId);
  const [deletedBatch] = storage.importedAthleteBatches.splice(index, 1);

  return {
    statusCode: 200,
    payload: {
      deleted: true,
      batchId,
      fileName: deletedBatch.fileName,
    },
  };
}

function parseImportedFile(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.csv' || ext === '.tsv') {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const rows = parseCsvRows(text, ext === '.tsv' ? '\t' : ',');
    return {
      fileName: filename,
      fileType: ext.slice(1).toUpperCase(),
      sheetName: ext === '.csv' ? 'CSV' : 'TSV',
      ...normalizeImportedRows(rows),
    };
  }

  if (ext !== '.xlsx') {
    throw new Error('Only .xlsx, .csv, and .tsv files are supported');
  }

  const files = parseZip(buffer);
  const sharedStrings = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8') || '');
  const sheet = findFirstSheet(files);
  const sheetXml = files.get(sheet.path)?.toString('utf8');

  if (!sheetXml) {
    throw new Error('Could not find first worksheet in XLSX');
  }

  const rows = parseSheetRows(sheetXml, sharedStrings);
  return {
    fileName: filename,
    fileType: 'XLSX',
    sheetName: sheet.name,
    ...normalizeImportedRows(rows),
  };
}

function cleanupVoteGroups(match) {
  const cutoff = Date.now() - config.scoringWindowMs - 5000;

  match.voteGroups = match.voteGroups.filter((group) => {
    if (group.startedAt >= cutoff) return true;

    if (!group.accepted && !group.rejectedLogged) {
      group.rejectedLogged = true;
      match.audit.push({
        id: newId('audit'),
        type: 'voteRejected',
        time: nowIso(),
        side: group.side,
        point: group.point,
        judges: Array.from(group.judges),
        reason: `Not enough votes in ${config.scoringWindowMs}ms`,
      });
    }

    return false;
  });
}

function findOrCreateVoteGroup(match, vote) {
  const now = Date.now();
  const group = match.voteGroups.find((item) => (
    item.side === vote.side
    && item.point === vote.point
    && now - item.startedAt <= config.scoringWindowMs
  ));

  if (group) return group;

  const nextGroup = {
    id: newId('group'),
    side: vote.side,
    point: vote.point,
    startedAt: now,
    judges: new Set(),
    accepted: false,
    rejectedLogged: false,
  };

  match.voteGroups.push(nextGroup);
  return nextGroup;
}

function checkTechnicalWin(match) {
  const diff = Math.abs(match.scores.blue - match.scores.red);

  if (diff < config.technicalWinGap) {
    return null;
  }

  const winner = match.scores.blue > match.scores.red ? 'blue' : 'red';
  match.status = 'finished';
  match.winner = {
    side: winner,
    reason: `Technical win by ${config.technicalWinGap}-point gap`,
    decidedAt: nowIso(),
  };

  return match.winner;
}

function applyVote(vote) {
  const court = normalizeCourt(vote.court) || inferCourtFromMatchId(vote.matchId, 'combat');
  const conflict = courtModeConflict(court, 'combat');
  if (conflict) return conflict;

  const match = getMatch(vote.matchId);

  cleanupVoteGroups(match);

  if (match.status === 'finished') {
    return {
      statusCode: 409,
      payload: {
        error: 'Match already finished',
        match: publicMatch(match),
      },
    };
  }

  const group = findOrCreateVoteGroup(match, vote);
  const duplicate = group.judges.has(vote.judgeId);
  group.judges.add(vote.judgeId);

  const voteEvent = {
    id: newId('vote'),
    type: 'vote',
    time: nowIso(),
    matchId: vote.matchId,
    judgeId: vote.judgeId,
    side: vote.side,
    point: vote.point,
    duplicate,
    groupId: group.id,
    groupVotes: Array.from(group.judges),
    requiredVotes: config.requiredVotes,
  };

  match.audit.push(voteEvent);
  broadcast(match.matchId, 'vote', voteEvent);

  let acceptedEvent = null;
  let winner = null;

  if (!group.accepted && group.judges.size >= config.requiredVotes) {
    group.accepted = true;
    match.scores[vote.side] += vote.point;

    acceptedEvent = {
      id: newId('score'),
      type: 'scoreAccepted',
      time: nowIso(),
      matchId: vote.matchId,
      side: vote.side,
      point: vote.point,
      judges: Array.from(group.judges),
      scores: match.scores,
      groupId: group.id,
    };

    match.audit.push(acceptedEvent);
    broadcast(match.matchId, 'scoreAccepted', acceptedEvent);

    winner = checkTechnicalWin(match);
    if (winner) {
      const finishEvent = {
        id: newId('finish'),
        type: 'matchFinished',
        time: nowIso(),
        matchId: match.matchId,
        winner,
        scores: match.scores,
      };

      match.audit.push(finishEvent);
      broadcast(match.matchId, 'matchFinished', finishEvent);
    }
  }

  match.updatedAt = nowIso();
  saveStorage();
  broadcast(match.matchId, 'snapshot', publicMatch(match));

  return {
    statusCode: 200,
    payload: {
      vote: voteEvent,
      accepted: acceptedEvent,
      winner,
      match: publicMatch(match),
    },
  };
}

function applyPenalty(matchId, payload) {
  const match = getMatch(matchId);
  const parsed = validateSidePoint(payload);

  if (parsed.error) {
    return { statusCode: 400, payload: { error: parsed.error } };
  }

  if (match.status === 'finished') {
    return {
      statusCode: 409,
      payload: {
        error: 'Match already finished',
        match: publicMatch(match),
      },
    };
  }

  const before = match.scores[parsed.side];
  match.scores[parsed.side] = Math.max(0, before - parsed.point);
  match.updatedAt = nowIso();

  const event = {
    id: newId('penalty'),
    type: 'penalty',
    time: nowIso(),
    matchId,
    side: parsed.side,
    point: parsed.point,
    before,
    after: match.scores[parsed.side],
    reason: String(payload.reason || '').trim() || null,
    scores: match.scores,
  };

  match.audit.push(event);
  saveStorage();
  broadcast(matchId, 'penalty', event);
  broadcast(matchId, 'snapshot', publicMatch(match));

  return { statusCode: 200, payload: { penalty: event, match: publicMatch(match) } };
}

function resetMatch(matchId) {
  const next = {
    matchId,
    status: 'running',
    round: 1,
    scores: {
      blue: 0,
      red: 0,
    },
    winner: null,
    voteGroups: [],
    audit: [{
      id: newId('audit'),
      type: 'reset',
      time: nowIso(),
      matchId,
    }],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  matches.set(matchId, next);
  saveStorage();
  broadcast(matchId, 'reset', publicMatch(next));
  broadcast(matchId, 'snapshot', publicMatch(next));
  return next;
}

function applyPerformanceScore(payload) {
  const parsed = validatePerformanceScore(payload);
  if (parsed.error) {
    return { statusCode: 400, payload: { error: parsed.error } };
  }

  const court = normalizeCourt(parsed.court) || inferCourtFromMatchId(parsed.matchId, 'performance');
  const conflict = courtModeConflict(court, 'performance');
  if (conflict) return conflict;

  const match = getPerformanceMatch(parsed.matchId, court || parsed.court);
  const before = match.judgeScores[parsed.judgeId];

  if (hasSubmittedPerformanceScore(before)) {
    const snapshot = publicPerformanceMatch(match);
    return {
      statusCode: 409,
      payload: {
        error: `Trọng tài ${parsed.judgeId} đã gửi điểm rồi`,
        submitted: {
          judgeId: parsed.judgeId,
          score: Number(before),
          deviceLabel: match.judgeDevices[parsed.judgeId] || `Máy ${parsed.judgeId}`,
        },
        match: snapshot,
      },
    };
  }

  match.judgeScores[parsed.judgeId] = parsed.score;
  match.judgeDevices[parsed.judgeId] = parsed.deviceLabel;
  match.updatedAt = nowIso();

  const event = {
    id: newId('performance_score'),
    type: 'performanceScoreSubmitted',
    time: nowIso(),
    matchId: match.matchId,
    court: match.court,
    judgeId: parsed.judgeId,
    deviceLabel: parsed.deviceLabel,
    before,
    score: parsed.score,
  };

  match.audit.push(event);
  savePerformanceMatch(match);
  const snapshot = publicPerformanceMatch(match);
  broadcast(match.matchId, 'performanceScoreSubmitted', event);
  broadcast(match.matchId, 'performanceSnapshot', snapshot);
  if (court) {
    broadcastPerformanceCourtDisplay(court);
  }

  return {
    statusCode: 200,
    payload: {
      submitted: event,
      match: snapshot,
    },
  };
}

function resetPerformanceMatch(matchId, court = '') {
  const next = {
    matchId,
    court: String(court || ''),
    judgeScores: createEmptyPerformanceScores(),
    judgeDevices: Object.fromEntries(
      Array.from({ length: performanceConfig.judgeCount }, (_, index) => {
        const judgeId = index + 1;
        return [judgeId, `Máy ${judgeId}`];
      }),
    ),
    audit: [{
      id: newId('performance_audit'),
      type: 'performanceReset',
      time: nowIso(),
      matchId,
    }],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  performanceMatches.set(matchId, next);
  savePerformanceMatch(next);
  const snapshot = publicPerformanceMatch(next);
  broadcast(matchId, 'performanceReset', snapshot);
  broadcast(matchId, 'performanceSnapshot', snapshot);
  if (court) {
    broadcastPerformanceCourtDisplay(court);
  }
  return next;
}

function sendSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(matchId, eventName, payload) {
  const clients = sseClients.get(matchId);
  if (!clients) return;

  for (const res of clients) {
    sendSse(res, eventName, payload);
  }
}

function handleEvents(req, res, url) {
  const eventType = String(url.searchParams.get('type') || 'combat').trim();
  const court = String(url.searchParams.get('court') || '').trim();
  const matchId = String(url.searchParams.get('matchId') || 'MATCH_001').trim();
  let channelKey = matchId;
  let initialEventName = 'snapshot';
  let initialPayload = publicMatch(getMatch(matchId));

  if (eventType === 'performance') {
    channelKey = matchId;
    initialEventName = 'performanceSnapshot';
    initialPayload = publicPerformanceMatch(getPerformanceMatch(matchId, court));
  } else if (eventType === 'performance-ranking') {
    channelKey = performanceRankingChannelKey();
    initialEventName = 'performanceRankingSnapshot';
    initialPayload = { groups: buildPerformanceRankingGroups() };
  } else if (eventType === 'performance-court-display') {
    const normalizedCourt = normalizeCourt(court) || '1';
    ensurePerformanceScheduleForCourt(normalizedCourt);
    channelKey = performanceCourtDisplayChannelKey(normalizedCourt);
    initialEventName = 'performanceCourtDisplaySnapshot';
    initialPayload = publicPerformanceCourtDisplay(normalizedCourt);
  } else if (eventType === 'performance-schedule-live') {
    const groupId = String(url.searchParams.get('groupId') || '').trim();
    const group = getPerformanceScheduleGroup(groupId);
    channelKey = performanceScheduleChannelKey(groupId);
    initialEventName = 'performanceScheduleSnapshot';
    initialPayload = group
      ? publicPerformanceScheduleGroup(group, true)
      : { groupId, deleted: true };
  } else if (eventType === 'mc') {
    const normalizedCourt = normalizeCourt(court) || '1';
    channelKey = mcChannelKey(normalizedCourt);
    initialEventName = 'mcSnapshot';
    initialPayload = publicMcCourt(normalizedCourt, true);
  } else if (eventType === 'mc-overview') {
    channelKey = mcOverviewChannelKey();
    initialEventName = 'mcOverview';
    initialPayload = { courts: publicMcCourts() };
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  sendSse(res, initialEventName, initialPayload);

  if (!sseClients.has(channelKey)) {
    sseClients.set(channelKey, new Set());
  }

  sseClients.get(channelKey).add(res);

  const heartbeat = setInterval(() => {
    sendSse(res, 'heartbeat', { time: nowIso() });
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(channelKey);
    if (!clients) return;
    clients.delete(res);
    if (clients.size === 0) {
      sseClients.delete(channelKey);
    }
  });
}

const GLOBAL_LOADING_SNIPPET = `
<style id="vovinam-global-loading-style">
  #vovinamGlobalLoading {
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: 99999;
    display: none;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 14px;
    border: 1px solid rgba(56, 189, 248, 0.65);
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.94);
    color: #f8fafc;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.28);
    font: 800 14px/1 Arial, sans-serif;
  }

  #vovinamGlobalLoading::before {
    content: "";
    width: 14px;
    height: 14px;
    border: 3px solid rgba(148, 163, 184, 0.45);
    border-top-color: #38bdf8;
    border-radius: 999px;
    animation: vovinamSpin 0.8s linear infinite;
  }

  html.vovinam-loading #vovinamGlobalLoading {
    display: inline-flex;
  }

  html.vovinam-loading,
  html.vovinam-loading button,
  html.vovinam-loading a,
  html.vovinam-loading input,
  html.vovinam-loading select {
    cursor: progress;
  }

  @keyframes vovinamSpin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 640px) {
    #vovinamGlobalLoading {
      top: 10px;
      right: 10px;
      left: 10px;
      justify-content: center;
    }
  }
</style>
<div id="vovinamGlobalLoading" role="status" aria-live="polite">Đang xử lý...</div>
<script id="vovinam-global-loading-script">
  (() => {
    if (window.__vovinamGlobalLoadingInstalled || !window.fetch) return;
    window.__vovinamGlobalLoadingInstalled = true;

    const root = document.documentElement;
    const originalFetch = window.fetch.bind(window);
    let pending = 0;
    let showTimer = null;

    function renderLoading() {
      if (pending > 0) {
        if (!showTimer) {
          showTimer = window.setTimeout(() => {
            root.classList.add('vovinam-loading');
          }, 120);
        }
        return;
      }

      if (showTimer) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
      root.classList.remove('vovinam-loading');
    }

    window.fetch = async (...args) => {
      pending += 1;
      renderLoading();
      try {
        return await originalFetch(...args);
      } finally {
        pending = Math.max(0, pending - 1);
        renderLoading();
      }
    };
  })();
</script>
`;

function injectGlobalLoading(content) {
  const html = content.toString('utf8');
  if (html.includes('id="vovinam-global-loading-script"')) return html;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${GLOBAL_LOADING_SNIPPET}</body>`);
  }
  return `${html}${GLOBAL_LOADING_SNIPPET}`;
}

function serveStatic(res, pathname) {
  const fileMap = {
    '/': 'index.html',
    '/arena.html': 'arena.html',
    '/index.html': 'index.html',
    '/board.html': 'board.html',
    '/chief.html': 'chief.html',
    '/court.html': 'court.html',
    '/import.html': 'import.html',
    '/import-preview.html': 'import-preview.html',
    '/mc-dashboard.html': 'mc-dashboard.html',
    '/mc-reader.html': 'mc-reader.html',
    '/performance-board.html': 'performance-board.html',
    '/performance-court.html': 'performance-court.html',
    '/performance-dispatch.html': 'performance-dispatch.html',
    '/performance-planner.html': 'performance-planner.html',
    '/performance-referee.html': 'performance-referee.html',
    '/public-boards.html': 'public-boards.html',
    '/rankings.html': 'rankings.html',
    '/referee.html': 'referee.html',
    '/scoreboard.html': 'scoreboard.html',
    '/tournament.html': 'tournament.html',
  };

  const fileName = fileMap[pathname];
  if (!fileName) return false;

  const filePath = path.join(__dirname, 'public', fileName);
  const ext = path.extname(filePath);
  const contentType = ext === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      json(res, 404, { error: 'File not found' });
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(ext === '.html' ? injectGlobalLoading(content) : content);
  });

  return true;
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/tournament') {
    json(res, 200, publicTournamentInfo());
    return;
  }

  if (method === 'GET' && pathname === '/api/rankings/performance') {
    json(res, 200, {
      groups: buildPerformanceRankingGroups(),
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/performance/dispatch') {
    json(res, 200, buildPerformanceDispatchData());
    return;
  }

  if (method === 'GET' && pathname === '/api/rankings/combat') {
    json(res, 200, {
      groups: [],
      message: 'Phần xếp hạng đối kháng sẽ nối tiếp vào dữ liệu kết quả đối kháng sau.',
    });
    return;
  }

  if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && pathname === '/api/tournament') {
    try {
      const payload = await readJson(req);
      const saved = saveTournamentInfo(payload);
      json(res, 200, {
        saved: true,
        tournament: saved,
      });
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/mc/courts') {
    json(res, 200, {
      courts: publicMcCourts(),
    });
    return;
  }

  if (method === 'GET' && pathname.startsWith('/api/mc/courts/')) {
    const parts = pathname.split('/').filter(Boolean);
    const court = decodeURIComponent(parts[3] || '');
    const action = parts[4] || '';

    if (!action) {
      const normalizedCourt = normalizeCourt(court);
      if (!normalizedCourt) {
        badRequest(res, `court must be 1-${COURT_COUNT}`);
        return;
      }

      json(res, 200, publicMcCourt(normalizedCourt, true));
      return;
    }
  }

  if (method === 'POST' && pathname.startsWith('/api/mc/courts/')) {
    try {
      const parts = pathname.split('/').filter(Boolean);
      const court = decodeURIComponent(parts[3] || '');
      const action = parts[4] || '';
      const payload = await readJson(req);

      if (action === 'load-performance') {
        const result = loadPerformanceScheduleToMcCourt(court, String(payload.groupId || '').trim());
        json(res, result.statusCode, result.payload);
        return;
      }

      if (action === 'announce-next') {
        const result = announceNextMcItem(court);
        json(res, result.statusCode, result.payload);
        return;
      }

      if (action === 'start') {
        const result = startCurrentMcItem(court);
        json(res, result.statusCode, result.payload);
        return;
      }

      if (action === 'complete') {
        const result = completeCurrentMcItem(court);
        json(res, result.statusCode, result.payload);
        return;
      }

      if (action === 'skip') {
        const result = skipCurrentMcItem(court);
        json(res, result.statusCode, result.payload);
        return;
      }

      if (action === 'reset') {
        const result = resetMcCourtQueue(court);
        json(res, result.statusCode, result.payload);
        return;
      }

      if (action === 'reorder') {
        const result = reorderMcCourtQueue(court, String(payload.itemId || '').trim(), String(payload.direction || '').trim());
        json(res, result.statusCode, result.payload);
        return;
      }
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
      return;
    }
  }

  if (method === 'GET' && pathname === '/api/courts') {
    const mode = normalizeMode(url.searchParams.get('mode') || '');
    json(res, 200, {
      mode: mode || null,
      modeLabel: mode ? modeLabels[mode] : null,
      courts: publicCourts(mode),
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/performance/routine-batches') {
    json(res, 200, {
      batches: storage.performanceRoutineBatches.map((batch) => publicPerformanceRoutineBatch(batch, true)),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/performance/routine-batches') {
    try {
      const body = await readBuffer(req);
      const upload = parseMultipartFile(req.headers['content-type'], body);
      const parsedFile = parseImportedFile(upload.filename, upload.buffer);
      const normalized = normalizeImportedPerformanceRoutines(parsedFile);

      if (!normalized.routines.length) {
        badRequest(res, 'Không tìm thấy bài quyền nào trong file import.');
        return;
      }

      const batch = saveImportedPerformanceRoutineBatch(normalized);
      json(res, 200, {
        saved: true,
        batch: publicPerformanceRoutineBatch(batch, true),
      });
    } catch (error) {
      badRequest(res, error.message || 'Could not import routine file');
    }
    return;
  }

  if (method === 'DELETE' && pathname.startsWith('/api/performance/routine-batches/')) {
    const batchId = decodeURIComponent(pathname.split('/').pop() || '');
    const result = deletePerformanceRoutineBatch(batchId);
    json(res, result.statusCode, result.payload);
    return;
  }

  if (method === 'GET' && pathname === '/api/performance/catalog') {
    json(res, 200, {
      routines: performanceRoutineCatalog.map(publicPerformanceRoutine),
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/performance/planner/options') {
    const batchId = decodeURIComponent(url.searchParams.get('batchId') || '');
    const batch = getImportBatch(batchId);

    if (!batch) {
      json(res, 404, { error: 'Import batch not found' });
      return;
    }

    json(res, 200, publicPerformancePlannerOptions(batch));
    return;
  }

  if (method === 'POST' && pathname === '/api/performance/planner/filter') {
    try {
      const payload = await readJson(req);
      const batchId = String(payload.batchId || '').trim();
      const ageGroup = String(payload.ageGroup || '').trim();
      const routineId = String(payload.routineId || '').trim();
      const memberCount = parsePerformanceMemberCount(payload.memberCount);
      const batch = getImportBatch(batchId);

      if (!batch) {
        json(res, 404, { error: 'Import batch not found' });
        return;
      }
      if (!ageGroup) {
        badRequest(res, 'ageGroup is required');
        return;
      }
      if (!routineId) {
        badRequest(res, 'routineId is required');
        return;
      }
      if (payload.memberCount !== undefined && !memberCount) {
        badRequest(res, `memberCount must be an integer from 1 to ${MAX_PERFORMANCE_MEMBER_COUNT}`);
        return;
      }

      const result = buildPerformancePlannerEntries(batch, ageGroup, routineId, memberCount);
      if (result.error) {
        badRequest(res, result.error);
        return;
      }

      const existing = getPerformanceScheduleGroupByKey(batchId, ageGroup, routineId);
      const existingMemberCount = existing?.entries?.length
        ? normalizePerformanceMemberCount(existing.entries[0]?.expectedMemberCount, 1)
        : null;
      const existingWasAutoGrouped = Boolean(existing?.entries?.length)
        && existing.entries.every((entry) => entry.autoGroupKey);
      const canReuseSavedSchedule = existingWasAutoGrouped
        && existingMemberCount === result.memberCount;
      const entries = canReuseSavedSchedule ? existing.entries : result.entries;

      json(res, 200, {
        batchId,
        ageGroup,
        routine: {
          ...publicPerformanceRoutine(result.routine),
          memberCount: result.memberCount,
        },
        memberCount: result.memberCount,
        totalAthletes: result.totalAthletes,
        incompleteEntries: entries.filter((entry) => entry.needsAttention).length,
        totalEntries: entries.length,
        detectedColumns: publicPerformancePlannerOptions(batch).detectedColumns,
        entries,
        savedSchedule: canReuseSavedSchedule ? publicPerformanceScheduleGroup(existing, true) : null,
        scheduleNeedsRegrouping: Boolean(existing) && !canReuseSavedSchedule,
      });
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/performance/planner/schedules') {
    json(res, 200, {
      schedules: storage.performanceSchedules.map((group) => publicPerformanceScheduleGroup(group)),
    });
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/performance/planner/schedules/') && pathname.endsWith('/status')) {
    try {
      const parts = pathname.split('/').filter(Boolean);
      const groupId = decodeURIComponent(parts[4] || '');
      const payload = await readJson(req);
      const result = updatePerformanceScheduleEntryStatus(
        groupId,
        String(payload.entryId || '').trim(),
        String(payload.status || '').trim(),
      );
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/performance/planner/schedules/') && pathname.endsWith('/reset-status')) {
    const parts = pathname.split('/').filter(Boolean);
    const groupId = decodeURIComponent(parts[4] || '');
    const result = resetPerformanceScheduleStatuses(groupId);
    json(res, result.statusCode, result.payload);
    return;
  }

  if (method === 'GET' && pathname.startsWith('/api/performance/planner/schedules/')) {
    const groupId = decodeURIComponent(pathname.split('/').pop() || '');
    const group = getPerformanceScheduleGroup(groupId);

    if (!group) {
      json(res, 404, { error: 'Performance schedule not found' });
      return;
    }

    json(res, 200, publicPerformanceScheduleGroup(group, true));
    return;
  }

  if (method === 'DELETE' && pathname.startsWith('/api/performance/planner/schedules/')) {
    const groupId = decodeURIComponent(pathname.split('/').pop() || '');
    const result = deletePerformanceScheduleGroup(groupId);
    json(res, result.statusCode, result.payload);
    return;
  }

  if (method === 'PUT' && pathname === '/api/performance/planner/schedules') {
    try {
      const payload = await readJson(req);
      const result = savePerformanceScheduleGroup(payload);
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/courts/') && pathname.endsWith('/assign')) {
    try {
      const parts = pathname.split('/');
      const court = decodeURIComponent(parts[3] || '');
      const payload = await readJson(req);
      const result = assignCourt(court, payload.mode);
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/courts/') && pathname.endsWith('/release')) {
    const parts = pathname.split('/');
    const court = decodeURIComponent(parts[3] || '');
    const result = releaseCourt(court);
    json(res, result.statusCode, result.payload);
    return;
  }

  if (method === 'GET' && pathname.startsWith('/api/performance/courts/') && pathname.endsWith('/display')) {
    const parts = pathname.split('/').filter(Boolean);
    const court = decodeURIComponent(parts[3] || '');
    const normalizedCourt = normalizeCourt(court);

    if (!normalizedCourt) {
      badRequest(res, `court must be 1-${COURT_COUNT}`);
      return;
    }

    const ensured = ensurePerformanceScheduleForCourt(normalizedCourt);
    if (ensured.statusCode >= 400) {
      json(res, ensured.statusCode, ensured.payload);
      return;
    }

    json(res, 200, publicPerformanceCourtDisplay(normalizedCourt));
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/performance/courts/') && pathname.endsWith('/assign-schedule')) {
    try {
      const parts = pathname.split('/').filter(Boolean);
      const court = decodeURIComponent(parts[3] || '');
      const payload = await readJson(req);
      const result = assignPerformanceScheduleToCourt(
        court,
        Array.isArray(payload.groupIds) ? payload.groupIds : String(payload.groupId || '').trim(),
      );
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/performance/courts/') && pathname.endsWith('/clear-schedule')) {
    const parts = pathname.split('/').filter(Boolean);
    const court = decodeURIComponent(parts[3] || '');
    const result = clearPerformanceScheduleFromCourt(court);
    json(res, result.statusCode, result.payload);
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/performance/courts/') && pathname.endsWith('/remove-schedule')) {
    try {
      const parts = pathname.split('/').filter(Boolean);
      const court = decodeURIComponent(parts[3] || '');
      const payload = await readJson(req);
      const result = removePerformanceScheduleFromCourt(court, String(payload.groupId || '').trim());
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/performance/courts/') && pathname.endsWith('/next')) {
    const parts = pathname.split('/').filter(Boolean);
    const court = decodeURIComponent(parts[3] || '');
    const result = advancePerformanceScheduleForCourt(court);
    json(res, result.statusCode, result.payload);
    return;
  }

  if (method === 'GET' && pathname.startsWith('/api/performance/matches/')) {
    const matchId = decodeURIComponent(pathname.split('/').pop() || 'PERFORMANCE_COURT_1');
    const court = url.searchParams.get('court') || '';
    json(res, 200, publicPerformanceMatch(getPerformanceMatch(matchId, court)));
    return;
  }

  if (method === 'POST' && pathname === '/api/performance/scores') {
    try {
      const payload = await readJson(req);
      const result = applyPerformanceScore(payload);
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/performance/matches/') && pathname.endsWith('/reset')) {
    const parts = pathname.split('/');
    const matchId = decodeURIComponent(parts[4] || 'PERFORMANCE_COURT_1');
    const court = url.searchParams.get('court') || '';
    json(res, 200, publicPerformanceMatch(resetPerformanceMatch(matchId, court)));
    return;
  }

  if (method === 'GET' && pathname.startsWith('/api/matches/')) {
    const matchId = decodeURIComponent(pathname.split('/').pop() || 'MATCH_001');
    json(res, 200, publicMatch(getMatch(matchId)));
    return;
  }

  if (method === 'GET' && (pathname === '/api/imports/athletes' || pathname === '/api/import/athletes')) {
    json(res, 200, {
      batches: storage.importedAthleteBatches.map((batch) => publicImportBatch(batch)),
    });
    return;
  }

  if (
    method === 'GET'
    && isImportBatchRoute(pathname)
  ) {
    const batchId = decodeURIComponent(pathname.split('/').pop() || '');
    const batch = getImportBatch(batchId);

    if (!batch) {
      json(res, 404, { error: 'Import batch not found' });
      return;
    }

    json(res, 200, publicImportBatch(batch, true));
    return;
  }

  if ((method === 'PUT' || method === 'PATCH') && isImportBatchRoute(pathname)) {
    try {
      const batchId = decodeURIComponent(pathname.split('/').pop() || '');
      const payload = await readJson(req);
      const result = updateImportedAthleteBatch(batchId, payload);
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'DELETE' && isImportBatchRoute(pathname)) {
    const batchId = decodeURIComponent(pathname.split('/').pop() || '');
    const result = deleteImportedAthleteBatch(batchId);
    json(res, result.statusCode, result.payload);
    return;
  }

  if (method === 'POST' && pathname === '/api/votes') {
    try {
      const payload = await readJson(req);
      const parsed = validateVote(payload);

      if (parsed.error) {
        badRequest(res, parsed.error);
        return;
      }

      const result = applyVote(parsed);
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/import/athletes') {
    try {
      const body = await readBuffer(req);
      const upload = parseMultipartFile(req.headers['content-type'], body);
      const result = parseImportedFile(upload.filename, upload.buffer);
      const batch = saveImportedAthleteBatch(result);
      json(res, 200, {
        note: 'Data saved to SQLite database.',
        ...publicImportBatch(batch),
      });
    } catch (error) {
      badRequest(res, error.message || 'Could not import file');
    }
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/matches/') && pathname.endsWith('/penalty')) {
    try {
      const parts = pathname.split('/');
      const matchId = decodeURIComponent(parts[3] || 'MATCH_001');
      const payload = await readJson(req);
      const result = applyPenalty(matchId, payload);
      json(res, result.statusCode, result.payload);
    } catch (error) {
      badRequest(res, error.message || 'Invalid JSON');
    }
    return;
  }

  if (method === 'POST' && pathname.startsWith('/api/matches/') && pathname.endsWith('/reset')) {
    const parts = pathname.split('/');
    const matchId = decodeURIComponent(parts[3] || 'MATCH_001');
    json(res, 200, publicMatch(resetMatch(matchId)));
    return;
  }

  json(res, 404, { error: 'API route not found' });
}

try {
  loadStorage();
} catch (error) {
  console.error(`Could not load storage: ${error.message}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }

  if (url.pathname === '/api/events') {
    handleEvents(req, res, url);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }

  if (serveStatic(res, url.pathname)) {
    return;
  }

  json(res, 404, {
    error: 'Not found',
    links: {
      home: '/',
      courts: '/arena.html',
      mcDashboard: '/mc-dashboard.html',
      mcReaderCourt1: '/mc-reader.html?court=1',
      publicBoards: '/public-boards.html',
      combatCourt1: '/court.html?court=1&matchId=COURT_1',
      performanceCourt1: '/performance-court.html?court=1&matchId=PERFORMANCE_COURT_1',
      performancePlanner: '/performance-planner.html',
      import: '/import.html',
      tournament: '/tournament.html',
    },
  });
});

server.listen(PORT, HOST, () => {
  const baseUrl = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`Vovinam scoring MVP server running at ${baseUrl}`);
  console.log(`Dashboard: ${baseUrl}/`);
  console.log(`Shared courts: ${baseUrl}/arena.html`);
  console.log(`MC dashboard: ${baseUrl}/mc-dashboard.html`);
  console.log(`Performance planner: ${baseUrl}/performance-planner.html`);
  console.log(`Tournament info: ${baseUrl}/tournament.html`);
  console.log(`Import: ${baseUrl}/import.html`);

  if (HOST === '0.0.0.0') {
    const lanUrls = Object.values(os.networkInterfaces())
      .flat()
      .filter((item) => item && item.family === 'IPv4' && !item.internal)
      .map((item) => `http://${item.address}:${PORT}`);

    if (lanUrls.length > 0) {
      console.log('LAN URLs for phones/tablets:');
      for (const url of lanUrls) {
        console.log(`- ${url}`);
      }
    }
  }
});
