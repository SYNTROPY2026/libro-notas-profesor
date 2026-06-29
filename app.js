'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const MIN_GRADE  = 2.0;
const MAX_GRADE  = 7.0;
const PASS_GRADE = 4.0;
const STORE_KEY           = 'libro_calificaciones_v3';
const BACKUP_KEY          = 'libro_notas_last_backup';
const BACKUP_WARNING_DAYS = 7;

// ── Códigos de activación (Supabase) ────────────────────────────────────────────
// Los códigos viven en la tabla `codigos_acceso` de Supabase (ver supabase/schema.sql),
// no en este archivo público. Reemplaza estos dos valores por los de tu proyecto
// (Supabase Dashboard → Project Settings → API). La anon key es pública por diseño;
// la tabla está protegida con RLS y solo se puede validar un código a la vez.
const SUPABASE_URL      = 'https://rcfcgypqjocwmjbztiet.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_8lMX08LnPDXvzIw_DvjOYA_kmGEMbFp';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Google Drive (opcional) ────────────────────────────────────────────────────
// Para activar: crea un proyecto en console.cloud.google.com,
// habilita "Drive API" y copia tu OAuth 2.0 Client ID aquí.
const GDRIVE_CLIENT_ID = '737617281353-h0hnir3gbbu7fjccdsao73btnt0k2p05.apps.googleusercontent.com';
const GDRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.appdata';
const GDRIVE_FILE_NAME = 'libro_notas_backup.json';
const GDRIVE_TOKEN_KEY = 'libro_notas_gdrive_token';

const DEFAULT_COURSES = [
  { id:'c1', name:'1° Básico A' }, { id:'c2', name:'2° Básico A' },
  { id:'c3', name:'3° Básico A' }, { id:'c4', name:'4° Básico A' },
  { id:'c5', name:'5° Básico A' }, { id:'c6', name:'6° Básico A' },
  { id:'c7', name:'7° Básico A' }, { id:'c8', name:'8° Básico A' },
];

const DEFAULT_SUBJECTS = [
  { id:'s1', name:'Historia y Geografía' },
  { id:'s2', name:'Orientación'          },
];

const COURSE_SUBJECTS = {
  c1: ['s1'],
  c2: ['s1'],
  c3: ['s1','s2'],
  c4: ['s1'],
  c5: ['s1'],
  c6: ['s1'],
  c7: ['s1'],
  c8: ['s1'],
};

// Asignaturas con calificación conceptual (no numérica)
const CONCEPTUAL_SUBJECTS = new Set(['s2']);
const CONCEPT_GRADES  = ['I', 'S', 'B', 'MB'];
const CONCEPT_LABELS  = { I:'Insuficiente', S:'Suficiente', B:'Bueno', MB:'Muy Bueno' };
const CONCEPT_TO_NUM  = { I:1, S:2, B:3, MB:4 };
function numToConcept(n) { return n < 1.5 ? 'I' : n < 2.5 ? 'S' : n < 3.5 ? 'B' : 'MB'; }

// Cursos con Taller JEC (bitácora de clases)
const TALLER_COURSES = new Set(['c3']);

const SAMPLE_STUDENTS = [
  'Álvarez Muñoz, Sofía',   'Bravo Contreras, Diego',  'Castro Rojas, Valentina',
  'Díaz Fuentes, Matías',   'Espinoza Silva, Camila',  'Flores Torres, Sebastián',
  'García Vega, Isadora',   'Herrera Castro, Tomás',   'Jiménez Araya, Catalina',
  'López Reyes, Nicolás',   'Morales Bravo, Martina',  'Núñez Pérez, Emilio',
];

const STATE_VERSION = 'v4';

// ── Default state factory ──────────────────────────────────────────────────────
function makeDefaultState() {
  const students       = {};
  const grades         = {};
  const evaluations    = {};
  const courseSubjects = {};

  DEFAULT_COURSES.forEach(c => {
    const subjIds       = COURSE_SUBJECTS[c.id] || ['s1'];
    courseSubjects[c.id] = subjIds;
    students[c.id]      = SAMPLE_STUDENTS.map((name, i) => ({ id:`${c.id}_st${i}`, name }));
    grades[c.id]        = {};
    evaluations[c.id]   = {};

    subjIds.forEach(sId => {
      const isConc    = CONCEPTUAL_SUBJECTS.has(sId);
      const baseEvals = isConc ? ['C1','C2','C3','C4'] : ['N1','N2','N3'];
      evaluations[c.id][sId] = { s1:[...baseEvals], s2:[...baseEvals] };
      grades[c.id][sId] = {};
      students[c.id].forEach(st => {
        grades[c.id][sId][st.id] = { s1:{}, s2:{} };
      });
    });
  });

  return {
    _version:      STATE_VERSION,
    courses:       DEFAULT_COURSES.map(c => ({...c, hasTaller: TALLER_COURSES.has(c.id)})),
    subjects:      DEFAULT_SUBJECTS.map(s => ({...s, isConceptual: CONCEPTUAL_SUBJECTS.has(s.id)})),
    courseSubjects,
    students,
    evaluations,
    grades,
    taller:        {},
    observations:  {},
    activeCourse:  'c1',
    activeSubject: 's1',
    view:          'grades',
    teacherName:   'Profesor/a de Historia',
    year:          new Date().getFullYear(),
    onboardingDone: false,
    activated:      false,
  };
}

// ── App ────────────────────────────────────────────────────────────────────────
class GradeBook {
  constructor() {
    this.state = null;
    this._toastTimer = null;
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        this.state = JSON.parse(raw);
        this._migrateIfNeeded();
        this._ensureIntegrity();
      } else {
        this.state = makeDefaultState();
      }
    } catch {
      this.state = makeDefaultState();
    }
  }

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.state)); } catch {}
  }

  _migrateIfNeeded() {
    const s = this.state;
    if (s._version === STATE_VERSION) return;

    // v3 → v4: añadir campos dinámicos sin modificar datos existentes
    if (!s.courseSubjects) {
      s.courseSubjects = {};
      (s.courses || DEFAULT_COURSES).forEach(c => {
        s.courseSubjects[c.id] = COURSE_SUBJECTS[c.id] || ['s1'];
      });
    }
    if (s.courses) {
      s.courses.forEach(c => {
        if (c.hasTaller === undefined) c.hasTaller = TALLER_COURSES.has(c.id);
      });
    }
    if (s.subjects) {
      s.subjects.forEach(sub => {
        if (sub.isConceptual === undefined)
          sub.isConceptual = CONCEPTUAL_SUBJECTS.has(sub.id);
      });
    } else {
      s.subjects = DEFAULT_SUBJECTS.map(sub => ({...sub, isConceptual: CONCEPTUAL_SUBJECTS.has(sub.id)}));
    }

    s._version = STATE_VERSION;
    this.save();
  }

  // ── Dynamic state helpers ────────────────────────────────────────────────────

  _isConceptual(sId) {
    return !!(this.state.subjects?.find(s => s.id === sId)?.isConceptual);
  }

  _hasTaller(cId) {
    return !!(this.state.courses?.find(c => c.id === cId)?.hasTaller);
  }

  _courseSubjects(cId) {
    return this.state.courseSubjects?.[cId] || COURSE_SUBJECTS[cId] || ['s1'];
  }

  _ensureIntegrity() {
    const s = this.state;

    // v4: subjects son dinámicos — solo inicializar si no existen
    if (!s.subjects || !s.subjects.length)
      s.subjects = DEFAULT_SUBJECTS.map(sub => ({...sub, isConceptual: CONCEPTUAL_SUBJECTS.has(sub.id)}));
    if (!s.courses || !s.courses.length)
      s.courses = DEFAULT_COURSES.map(c => ({...c, hasTaller: TALLER_COURSES.has(c.id)}));
    if (!s.courseSubjects) s.courseSubjects = {};

    if (!s.students)    s.students    = {};
    if (!s.grades)      s.grades      = {};
    if (!s.evaluations) s.evaluations = {};

    s.courses.forEach(c => {
      if (!s.courseSubjects[c.id]) s.courseSubjects[c.id] = ['s1'];
      if (!s.students[c.id])       s.students[c.id]       = [];
      if (!s.grades[c.id])         s.grades[c.id]         = {};
      if (!s.evaluations[c.id])    s.evaluations[c.id]    = {};

      const subjIds = this._courseSubjects(c.id);
      subjIds.forEach(sId => {
        const isConc    = this._isConceptual(sId);
        const baseEvals = isConc ? ['C1','C2','C3','C4'] : ['N1','N2','N3'];
        if (!s.evaluations[c.id][sId])
          s.evaluations[c.id][sId] = { s1:[...baseEvals], s2:[...baseEvals] };
        if (!s.grades[c.id][sId])
          s.grades[c.id][sId] = {};
        s.students[c.id].forEach(st => {
          if (!s.grades[c.id][sId][st.id])
            s.grades[c.id][sId][st.id] = { s1:{}, s2:{} };
        });
      });
    });

    if (!s.taller)       s.taller       = {};
    if (!s.observations) s.observations = {};
    if (!s.attendance)   s.attendance   = {};
    if (!s.attendanceDate) s.attendanceDate = new Date().toISOString().slice(0, 10);
    if (!s.reminders)    s.reminders    = [];
    if (s.schoolName  === undefined) s.schoolName  = null;
    if (s.schoolPlace === undefined) s.schoolPlace = null;
    if (s.schoolLogo  === undefined) s.schoolLogo  = null;
    if (s.onboardingDone === undefined) s.onboardingDone = true;
    if (s.activated      === undefined) s.activated      = true;

    if (!s.activeCourse || !s.courses.find(c => c.id === s.activeCourse))
      s.activeCourse = s.courses[0]?.id || null;

    const validSubjs   = this._courseSubjects(s.activeCourse);
    const specialValid = ['__obs__', '__asistencia__', ...(this._hasTaller(s.activeCourse) ? ['__taller__'] : [])];
    const isValidSubj  = validSubjs.includes(s.activeSubject) || specialValid.includes(s.activeSubject);
    if (!s.activeSubject || !isValidSubj)
      s.activeSubject = validSubjs[0];

    if (!s.teacherName) s.teacherName = 'Profesor/a';
    if (!s.year)        s.year        = new Date().getFullYear();
    if (!s.view)        s.view        = 'grades';
  }

  // ── Grade math ───────────────────────────────────────────────────────────────

  parseGrade(raw) {
    if (!raw || !raw.toString().trim()) return null;
    const str = raw.toString().replace(',', '.').trim();
    let v = parseFloat(str);
    if (isNaN(v)) return undefined;
    if (v > MAX_GRADE && v >= MIN_GRADE * 10 && v <= MAX_GRADE * 10) v = v / 10;
    v = Math.round(v * 10) / 10;
    if (v < MIN_GRADE || v > MAX_GRADE) return undefined;
    return v;
  }

  fmt(g) {
    if (g === null || g === undefined || g === '') return '—';
    if (typeof g === 'string') return g; // concepto: I, S, B, MB
    return g.toFixed(1);
  }

  fmtAvg(g) {
    if (g === null || g === undefined || g === '') return '—';
    if (typeof g === 'string') return g; // promedio conceptual
    const s = g.toFixed(2);
    return s.endsWith('0') ? s.slice(0, -1) : s;
  }

  gradeClass(g) {
    if (g === null || g === undefined || g === '') return 'g-empty';
    if (typeof g === 'string') {
      const map = { I:'g-fail', S:'g-low', B:'g-concept-b', MB:'g-good' };
      return map[g] || 'g-empty';
    }
    if (g < PASS_GRADE) return 'g-fail';
    if (g < 5.0)        return 'g-low';
    if (g < 6.0)        return 'g-mid';
    if (g < 7.0)        return 'g-good';
    return 'g-exc';
  }

  /** Promedio numérico exacto */
  avg(values) {
    const nums = values.filter(v => typeof v === 'number' && !isNaN(v));
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  /** Promedio conceptual: mapea a números, promedia, vuelve a concepto */
  conceptAvg(values) {
    const nums = values
      .filter(v => typeof v === 'string' && CONCEPT_TO_NUM[v] !== undefined)
      .map(v => CONCEPT_TO_NUM[v]);
    if (!nums.length) return null;
    return numToConcept(nums.reduce((a, b) => a + b, 0) / nums.length);
  }

  semAvg(cId, sId, stId, sem) {
    try {
      const evNames = this.state.evaluations[cId][sId][sem];
      const gmap    = this.state.grades[cId][sId][stId][sem] || {};
      const vals    = evNames.map(e => gmap[e] ?? null).filter(v => v !== null && v !== undefined && v !== '');
      if (!vals.length) return null;
      return this._isConceptual(sId)
        ? this.conceptAvg(vals)
        : this.avg(vals.filter(v => typeof v === 'number'));
    } catch { return null; }
  }

  finalAvg(cId, sId, stId) {
    const a1   = this.semAvg(cId, sId, stId, 's1');
    const a2   = this.semAvg(cId, sId, stId, 's2');
    const both = [a1, a2].filter(v => v !== null);
    if (!both.length) return null;
    return this._isConceptual(sId)
      ? this.conceptAvg(both.filter(v => typeof v === 'string'))
      : this.avg(both.filter(v => typeof v === 'number'));
  }

  // ── Render: full ─────────────────────────────────────────────────────────────

  render() {
    document.getElementById('app').innerHTML =
      `<button class="sb-toggle" data-action="toggle-sidebar" aria-label="Menú">
         <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
           <rect y="2"  width="18" height="2" rx="1" fill="currentColor"/>
           <rect y="8"  width="18" height="2" rx="1" fill="currentColor"/>
           <rect y="14" width="18" height="2" rx="1" fill="currentColor"/>
         </svg>
       </button>` +
      `<div class="sb-backdrop" data-action="close-sidebar"></div>` +
      `<aside class="sidebar">${this.renderSidebar()}</aside>` +
      `<main  class="main">${this._renderRenewalBanner()}${this._renderBackupBanner()}${this.renderMain()}</main>`;
  }

  renderSidebar() {
    const { courses, subjects, activeCourse, activeSubject, teacherName, year } = this.state;
    const backupDays = this._getDaysSinceBackup();
    const backupLast = localStorage.getItem(BACKUP_KEY);
    const backupStatusHtml = backupLast === null
      ? `<div class="sb-backup-status sb-backup-never">Sin respaldo — datos en riesgo</div>`
      : backupDays === 0
        ? `<div class="sb-backup-status sb-backup-ok">Respaldo de hoy ✓</div>`
        : `<div class="sb-backup-status${backupDays >= BACKUP_WARNING_DAYS ? ' sb-backup-warn' : ' sb-backup-ok'}">Respaldo hace ${backupDays} día${backupDays !== 1 ? 's' : ''}</div>`;

    const courseItems = courses.map(c => {
      const active   = c.id === activeCourse;
      const subjIds  = this._courseSubjects(c.id);
      const subjList = subjects.filter(s => subjIds.includes(s.id));

      const tallerCount = (this.state.taller?.[c.id] || []).length;
      const obsEntries  = this.state.observations?.[c.id] || {};
      const obsCount    = Object.values(obsEntries).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
      const hasStudents = (this.state.students[c.id] || []).length > 0;

      const subList = active ? `
        <ul class="subject-list">
          ${subjList.map(s => `
            <li class="subject-item${s.id === activeSubject ? ' active' : ''}"
                data-action="set-subject" data-subject="${s.id}">
              <span class="subject-dot"></span>
              <span>${s.name}</span>
              ${s.isConceptual ? '<span class="conc-badge">I·S·B·MB</span>' : ''}
            </li>`).join('')}
          ${this._hasTaller(c.id) ? `
            <li class="subject-item taller-sb-item${activeSubject === '__taller__' ? ' active' : ''}"
                data-action="set-subject" data-subject="__taller__">
              <span class="subject-dot taller-dot"></span>
              <span>Taller JEC</span>
              <span class="taller-sb-badge">${tallerCount > 0 ? tallerCount + (tallerCount === 1 ? ' clase' : ' clases') : 'Bitácora'}</span>
            </li>` : ''}
          ${hasStudents ? `
            <li class="subject-item att-sb-item${activeSubject === '__asistencia__' ? ' active' : ''}"
                data-action="set-subject" data-subject="__asistencia__">
              <span class="subject-dot att-dot"></span>
              <span>Asistencia</span>
            </li>
            <li class="subject-item obs-sb-item${activeSubject === '__obs__' ? ' active' : ''}"
                data-action="set-subject" data-subject="__obs__">
              <span class="subject-dot obs-dot"></span>
              <span>Observaciones</span>
              ${obsCount > 0 ? `<span class="obs-sb-badge">${obsCount}</span>` : ''}
            </li>` : ''}
        </ul>` : '';

      return `
        <li class="course-item${active ? ' active' : ''}">
          <div class="course-row" data-action="set-course" data-course="${c.id}">
            <span class="course-chevron">▶</span>
            <span class="course-name">${c.name}</span>
            <span class="course-badge">${(this.state.students[c.id]||[]).length}</span>
          </div>
          ${subList}
        </li>`;
    }).join('');

    return `
      <div class="sidebar-header">
        <div class="sb-logo">
          <div class="sb-logo-icon">📚</div>
          <div>
            <div class="sb-title">Libro de Notas</div>
            <div class="sb-year">${year}</div>
          </div>
        </div>
        <div class="sb-teacher" data-action="edit-teacher" title="Clic para editar nombre">${this._esc(teacherName)}</div>
      </div>

      <div class="sb-section">Cursos</div>
      <ul class="course-list">${courseItems}</ul>

      <div class="sb-footer">
        <div class="sb-footer-row">
          <button class="sb-btn${!this.state.view || this.state.view === 'overview' ? ' sb-btn-on' : ''}" data-action="show-overview">
            ${this._icon('grid')} Vista general
          </button>
          <button class="sb-btn" data-action="export-csv">
            ${this._icon('download')} Exportar
          </button>
        </div>
        <button class="sb-btn sb-btn-deudores${this.state.view === 'deudores' ? ' sb-btn-on' : ''}" data-action="show-deudores">
          ${this._icon('deudores')} Deudores de notas
        </button>
        <button class="sb-btn sb-btn-recs${this.state.view === 'recordatorios' ? ' sb-btn-on' : ''}${(this.state.reminders||[]).filter(r=>!r.done).length ? ' sb-btn-recs-pending' : ''}" data-action="show-recordatorios">
          ${this._icon('reminder')} Recordatorios${(this.state.reminders||[]).filter(r=>!r.done).length ? ` <span class="sb-recs-badge">${(this.state.reminders||[]).filter(r=>!r.done).length}</span>` : ''}
        </button>
        <button class="sb-btn sb-btn-clases${this.state.view === 'clases' ? ' sb-btn-on' : ''}" data-action="show-clases">
          ${this._icon('clases')} Gestionar clases
        </button>
        <div class="sb-backup-row">
          <button class="sb-btn sb-btn-backup" data-action="export-backup" title="Descargar respaldo completo">
            ${this._icon('backup')} Crear respaldo
          </button>
          <button class="sb-btn sb-btn-restore" data-action="import-backup" title="Restaurar desde archivo">
            ${this._icon('restore')} Restaurar
          </button>
          <button class="sb-btn sb-btn-backup-help" data-action="show-backup-help" title="¿Cómo funciona el respaldo?">?</button>
        </div>
        ${backupStatusHtml}
        ${GDRIVE_CLIENT_ID ? this._renderDriveSection() : ''}
      </div>

      ${this._renderSchoolBrand()}`;
  }

  renderMain() {
    if (this.state.view === 'clases')         return this.renderMisClases();
    if (this.state.view === 'deudores')       return this.renderDeudores();
    if (this.state.view === 'recordatorios')  return this.renderRecordatorios();
    const { activeCourse, activeSubject, courses, subjects } = this.state;
    if (!activeCourse || !activeSubject) return this.renderOverview();

    if (activeSubject === '__taller__')     return this.renderTaller();
    if (activeSubject === '__obs__')        return this.renderObservaciones();
    if (activeSubject === '__asistencia__') return this.renderAsistencia();

    const course  = courses.find(c => c.id === activeCourse);
    const subject = subjects.find(s => s.id === activeSubject);
    if (!course || !subject) return this.renderOverview();

    const isConc   = this._isConceptual(activeSubject);
    const students = this.state.students[activeCourse] || [];
    const evs      = this.state.evaluations[activeCourse][activeSubject];

    return `
      <div class="topbar">
        <div class="breadcrumb">
          <span class="bc-course">${this._esc(course.name)}</span>
          <span class="bc-sep">›</span>
          <span class="bc-subject">${this._esc(subject.name)}</span>
          ${isConc ? '<span class="bc-conc-tag">Conceptual</span>' : ''}
        </div>
        <div class="topbar-actions">
          <button class="btn-add btn-add-secondary" data-action="print-report-course">
            ${this._icon('print')} Imprimir
          </button>
          <button class="btn-add btn-add-secondary" data-action="import-students">
            ${this._icon('import')} Importar
          </button>
          <button class="btn-add" data-action="add-student">
            ${this._icon('add-person')} Agregar alumno
          </button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="grade-table${isConc ? ' conc-table' : ''}" id="grade-table">
          ${this.renderThead(evs, isConc)}
          <tbody id="grade-tbody">
            ${students.length
              ? students.map((st, i) => this.renderRow(st, i)).join('')
              : `<tr class="empty-row"><td colspan="100">
                   Sin alumnos. Haz clic en "Agregar alumno" para comenzar.
                 </td></tr>`}
          </tbody>
          ${students.length ? `<tfoot>${this.renderStatsRow(students, evs)}</tfoot>` : ''}
        </table>
      </div>

      ${students.length ? this.renderStatsPanel(students) : ''}`;
  }

  renderThead(evs, isConc) {
    const s1Cols = evs.s1.length + 2;
    const s2Cols = evs.s2.length + 2;

    const mkHeaders = (sem) => evs[sem].map((e, i) => `
      <th class="th-eval${isConc ? ' th-conc' : ''}" data-sem="${sem}" data-idx="${i}" title="Doble clic para renombrar">
        <div class="eval-inner">
          <span>${this._esc(e)}</span>
          <button class="eval-del" data-action="del-eval" data-sem="${sem}" data-idx="${i}" title="Eliminar">×</button>
        </div>
      </th>`).join('');

    const s2BorderClass = isConc ? ' s2-left-border' : ' s2-left-border';

    return `
      <thead>
        <tr>
          <th class="th-num" rowspan="2">#</th>
          <th class="th-name" rowspan="2">Nombre del Alumno</th>
          <th colspan="${s1Cols}" class="th-sem">1er Semestre</th>
          <th colspan="${s2Cols}" class="th-sem th-sem-s2">2do Semestre</th>
          <th class="th-final" rowspan="2">${isConc ? 'Concepto<br>Final' : 'Promedio<br>Final'}</th>
        </tr>
        <tr>
          ${mkHeaders('s1')}
          <th class="th-avg">${isConc ? 'Conc S1' : 'Prom S1'}</th>
          <th class="th-add" data-action="add-eval" data-sem="s1" title="Agregar evaluación">＋</th>

          ${mkHeaders('s2')}
          <th class="th-avg${s2BorderClass}">${isConc ? 'Conc S2' : 'Prom S2'}</th>
          <th class="th-add" data-action="add-eval" data-sem="s2" title="Agregar evaluación">＋</th>
        </tr>
      </thead>`;
  }

  renderRow(st, idx) {
    const { activeCourse: cId, activeSubject: sId } = this.state;
    const gmap  = this.state.grades[cId][sId][st.id] || { s1:{}, s2:{} };
    const evs   = this.state.evaluations[cId][sId];
    const isConc = this._isConceptual(sId);

    const s1Avg = this.semAvg(cId, sId, st.id, 's1');
    const s2Avg = this.semAvg(cId, sId, st.id, 's2');
    const final = this.finalAvg(cId, sId, st.id);

    const mkCells = (sem) => evs[sem].map((e, i) => {
      const g      = gmap[sem]?.[e] ?? null;
      const border = (sem === 's2' && i === 0) ? ' s2-left-border' : '';
      return `<td class="grade-cell ${this.gradeClass(g)}${border}${isConc ? ' conc-cell' : ''}"
                  data-action="edit-grade"
                  data-student="${st.id}" data-sem="${sem}" data-eval="${e}">
                <span class="grade-val">${this.fmt(g)}</span>
              </td>`;
    }).join('');

    const statusLabel = final !== null
      ? isConc
        ? `<span class="final-status conc-badge-final ${this.gradeClass(final)}">${final}</span>`
        : `<span class="final-status ${final >= PASS_GRADE ? 'pass' : 'fail'}">${final >= PASS_GRADE ? 'APRO' : 'REPR'}</span>`
      : '';

    const isRetired = !!st.retired;
    return `
      <tr class="student-row${isRetired ? ' student-row-retired' : ''}" data-student="${st.id}">
        <td class="td-num">${idx + 1}</td>
        <td class="td-name">
          <div class="student-name-wrap">
            <span class="student-name${isRetired ? ' name-retired' : ''}" title="${this._esc(st.name)}">${this._esc(st.name)}</span>
            ${isRetired ? '<span class="retired-badge">Retirado</span>' : ''}
            <div class="student-btn-group">
              <button class="edit-student-btn" data-action="edit-student-name" data-student="${st.id}" title="Editar nombre">✎</button>
              <button class="retire-student-btn" data-action="toggle-retire-student" data-student="${st.id}" title="${isRetired ? 'Reactivar alumno' : 'Marcar como retirado'}">${isRetired ? '↩' : '⊘'}</button>
              <button class="del-student-btn" data-action="del-student" data-student="${st.id}" title="Eliminar alumno">×</button>
            </div>
          </div>
        </td>
        ${mkCells('s1')}
        <td class="td-avg ${this.gradeClass(s1Avg)}">${this.fmtAvg(s1Avg)}</td>
        <td class="td-spacer"></td>
        ${mkCells('s2')}
        <td class="td-avg ${this.gradeClass(s2Avg)} s2-left-border">${this.fmtAvg(s2Avg)}</td>
        <td class="td-spacer"></td>
        <td class="td-final ${this.gradeClass(final)}">
          <div class="final-inner">
            <strong>${this.fmtAvg(final)}</strong>${statusLabel}
          </div>
        </td>
      </tr>`;
  }

  renderStatsRow(students, evs) {
    const { activeCourse: cId, activeSubject: sId } = this.state;
    const isConc = this._isConceptual(sId);

    const evalAvg = (sem, e) => {
      const vals = students
        .map(st => this.state.grades[cId][sId][st.id]?.[sem]?.[e] ?? null)
        .filter(v => v !== null && v !== '');
      return isConc ? this.conceptAvg(vals) : this.avg(vals);
    };

    const s1Cells = evs.s1.map(e => {
      const a = evalAvg('s1', e);
      return `<td class="td-stat-val ${this.gradeClass(a)}">${this.fmtAvg(a)}</td>`;
    }).join('');

    const s2Cells = evs.s2.map((e, i) => {
      const a      = evalAvg('s2', e);
      const border = i === 0 ? ' s2-left-border' : '';
      return `<td class="td-stat-val ${this.gradeClass(a)}${border}">${this.fmtAvg(a)}</td>`;
    }).join('');

    const s1Avgs = students.map(st => this.semAvg(cId, sId, st.id, 's1')).filter(v => v !== null);
    const s2Avgs = students.map(st => this.semAvg(cId, sId, st.id, 's2')).filter(v => v !== null);
    const finals = students.map(st => this.finalAvg(cId, sId, st.id)).filter(v => v !== null);
    const cs1 = isConc ? this.conceptAvg(s1Avgs) : this.avg(s1Avgs);
    const cs2 = isConc ? this.conceptAvg(s2Avgs) : this.avg(s2Avgs);
    const cf  = isConc ? this.conceptAvg(finals)  : this.avg(finals);

    return `
      <tr>
        <td class="td-stats-num"></td>
        <td class="td-stats-label">${isConc ? 'Concepto promedio' : 'Promedio del curso'}</td>
        ${s1Cells}
        <td class="td-stat-val ${this.gradeClass(cs1)}" style="font-weight:700">${this.fmtAvg(cs1)}</td>
        <td></td>
        ${s2Cells}
        <td class="td-stat-val ${this.gradeClass(cs2)} s2-left-border" style="font-weight:700">${this.fmtAvg(cs2)}</td>
        <td></td>
        <td class="td-stat-val ${this.gradeClass(cf)}" style="font-weight:700;font-size:0.88rem">${this.fmtAvg(cf)}</td>
      </tr>`;
  }

  renderStatsPanel(students) {
    const { activeCourse: cId, activeSubject: sId } = this.state;

    if (this._isConceptual(sId)) {
      // Panel de distribución conceptual
      const finals = students.map(st => this.finalAvg(cId, sId, st.id)).filter(v => v !== null);
      const total  = finals.length || 1;
      const counts = { I:0, S:0, B:0, MB:0 };
      finals.forEach(v => { if (counts[v] !== undefined) counts[v]++; });

      return `
        <div class="stats-panel">
          ${CONCEPT_GRADES.map(c => {
            const pct = Math.round(counts[c] / total * 100);
            return `
              <div class="stat-card">
                <div class="stat-num ${this.gradeClass(c)}" style="font-size:1.8rem;font-family:var(--ff-mono)">${counts[c]}</div>
                <div class="stat-label">${CONCEPT_LABELS[c]}</div>
                <div class="stat-pct-bar"><div class="stat-pct-fill conc-bar-${c.toLowerCase()}" style="width:${pct}%"></div></div>
                <div class="stat-sub">${pct}% · ${counts[c]} alumno${counts[c] !== 1 ? 's' : ''}</div>
              </div>`;
          }).join('')}
        </div>`;
    }

    // Panel numérico
    const finals   = students.map(st => this.finalAvg(cId, sId, st.id)).filter(v => v !== null);
    const passed   = finals.filter(v => v >= PASS_GRADE).length;
    const failed   = finals.filter(v => v <  PASS_GRADE).length;
    const classAvg = this.avg(finals);
    const highest  = finals.length ? Math.max(...finals) : null;
    const lowest   = finals.length ? Math.min(...finals) : null;
    const pPassed  = finals.length ? Math.round(passed / finals.length * 100) : 0;
    const pFailed  = finals.length ? Math.round(failed / finals.length * 100) : 0;

    return `
      <div class="stats-panel">
        <div class="stat-card stat-passed">
          <div class="stat-num">${passed}</div>
          <div class="stat-label">Aprobados</div>
          <div class="stat-pct-bar"><div class="stat-pct-fill" style="width:${pPassed}%"></div></div>
          <div class="stat-sub">${pPassed}% del curso</div>
        </div>
        <div class="stat-card stat-failed">
          <div class="stat-num">${failed}</div>
          <div class="stat-label">Reprobados</div>
          <div class="stat-pct-bar"><div class="stat-pct-fill" style="width:${pFailed}%"></div></div>
          <div class="stat-sub">${pFailed}% del curso</div>
        </div>
        <div class="stat-card stat-avg">
          <div class="stat-num ${this.gradeClass(classAvg)}" style="font-family:var(--ff-display)">${this.fmtAvg(classAvg)}</div>
          <div class="stat-label">Promedio Final</div>
          <div class="stat-sub">Exacto, sin redondeo</div>
        </div>
        <div class="stat-card">
          <div class="stat-num" style="font-size:1.5rem;letter-spacing:-0.02em">
            <span class="${this.gradeClass(highest)}">${this.fmtAvg(highest)}</span>
            <span style="color:var(--ink-4);font-size:1rem;margin:0 4px">/</span>
            <span class="${this.gradeClass(lowest)}">${this.fmtAvg(lowest)}</span>
          </div>
          <div class="stat-label">Máxima / Mínima</div>
          <div class="stat-sub">Notas extremas del curso</div>
        </div>
      </div>`;
  }

  renderOverview() {
    const { courses, subjects, teacherName, year } = this.state;

    // ── KPIs globales ────────────────────────────────────────────────────────
    const totalStudents = courses.reduce((n, c) => n + (this.state.students[c.id] || []).length, 0);
    const deudData      = this._getDeudores();
    const totalDeudores = deudData.reduce((n, c) => n + c.deudores.length, 0);

    let gAttTotal = 0, gAttPresent = 0;
    courses.forEach(c => {
      (this.state.students[c.id] || []).forEach(st => {
        Object.values(this.state.attendance?.[c.id] || {}).forEach(day => {
          const s = day[st.id];
          if (s) { gAttTotal++; if (s !== 'A') gAttPresent++; }
        });
      });
    });
    const gAttPct = gAttTotal > 0 ? Math.round(gAttPresent / gAttTotal * 100) : null;

    const kpiBar = `
      <div class="dash-kpi-bar">
        <div class="dash-kpi">
          <span class="dash-kpi-val">${totalStudents}</span>
          <span class="dash-kpi-label">alumnos</span>
        </div>
        <div class="dash-kpi">
          <span class="dash-kpi-val">${courses.length}</span>
          <span class="dash-kpi-label">cursos</span>
        </div>
        ${gAttPct !== null
          ? `<div class="dash-kpi${gAttPct < 85 ? ' dash-kpi-warn' : ''}">
               <span class="dash-kpi-val">${gAttPct}%</span>
               <span class="dash-kpi-label">asistencia</span>
             </div>`
          : ''}
        <div class="dash-kpi${totalDeudores > 0 ? ' dash-kpi-warn' : ' dash-kpi-ok'}">
          <span class="dash-kpi-val">${totalDeudores > 0 ? totalDeudores : '✓'}</span>
          <span class="dash-kpi-label">${totalDeudores > 0 ? 'con deudas' : 'al día'}</span>
        </div>
      </div>`;

    // ── Tarjetas por curso ───────────────────────────────────────────────────
    const cards = courses.map(c => {
      const students  = this.state.students[c.id] || [];
      const subjIds   = this._courseSubjects(c.id);
      const sId       = subjIds[0] || 's1';
      const isConc    = this._isConceptual(sId);
      const finals    = students.map(st => this.finalAvg(c.id, sId, st.id)).filter(v => v !== null);
      const subjNames = subjIds.map(id => subjects.find(s => s.id === id)?.name || '').join(' · ');

      let avgDisplay, passed, pct;
      if (isConc) {
        const counts = { I:0, S:0, B:0, MB:0 };
        finals.forEach(v => { if (counts[v] !== undefined) counts[v]++; });
        passed = counts.S + counts.B + counts.MB;
        pct    = finals.length ? Math.round(passed / finals.length * 100) : 0;
        const topConcept = this.conceptAvg(finals);
        avgDisplay = `<div class="ov-avg ${this.gradeClass(topConcept)}" style="font-size:1.5rem">${topConcept || '—'}</div>`;
      } else {
        const classAvg = this.avg(finals);
        passed = finals.filter(v => v >= PASS_GRADE).length;
        pct    = finals.length ? Math.round(passed / finals.length * 100) : 0;
        avgDisplay = `<div class="ov-avg ${this.gradeClass(classAvg)}">${this.fmtAvg(classAvg)}</div>`;
      }

      // Asistencia del curso
      let cAttTotal = 0, cAttPresent = 0;
      students.forEach(st => {
        Object.values(this.state.attendance?.[c.id] || {}).forEach(day => {
          const s = day[st.id];
          if (s) { cAttTotal++; if (s !== 'A') cAttPresent++; }
        });
      });
      const cAttPct  = cAttTotal > 0 ? Math.round(cAttPresent / cAttTotal * 100) : null;
      const attBadge = cAttPct !== null
        ? `<span class="ov-att-badge${cAttPct < 85 ? ' ov-att-warn' : ''}">${cAttPct}% asist.</span>`
        : '';

      return `
        <div class="overview-card" data-action="set-course" data-course="${c.id}">
          <div class="ov-course">${this._esc(c.name)}</div>
          <div class="ov-count">${students.length} alumno${students.length !== 1 ? 's' : ''} · ${subjNames}</div>
          ${avgDisplay}
          <div class="ov-bar"><div class="ov-bar-fill" style="width:${pct}%"></div></div>
          <div class="ov-stats">${passed} aprobados · ${pct}% ${attBadge}</div>
        </div>`;
    }).join('');

    return `
      <div class="topbar">
        <div class="breadcrumb"><span class="bc-overview">Vista General — ${this._esc(year)}</span></div>
        <div class="topbar-actions">
          <button class="btn-add btn-add-secondary" data-action="print-report-overview">
            ${this._icon('print')} Imprimir informe
          </button>
        </div>
      </div>
      <div class="print-header" style="display:none">
        <div class="ph-teacher">${this._esc(teacherName)}</div>
        <div class="ph-title">Informe General de Notas — ${this._esc(String(year))}</div>
      </div>
      ${kpiBar}
      <div class="overview-grid">${cards}</div>`;
  }

  // ── Partial DOM refresh ──────────────────────────────────────────────────────

  refreshRow(studentId) {
    const row = document.querySelector(`tr.student-row[data-student="${studentId}"]`);
    if (!row) return;
    const { activeCourse: cId } = this.state;
    const students = this.state.students[cId];
    const idx = students.findIndex(s => s.id === studentId);
    if (idx === -1) return;
    const t = document.createElement('template');
    t.innerHTML = this.renderRow(students[idx], idx);
    row.replaceWith(t.content.firstElementChild);
  }

  refreshStats() {
    const { activeCourse: cId, activeSubject: sId } = this.state;
    const students = this.state.students[cId] || [];
    const evs      = this.state.evaluations[cId][sId];

    const tfoot = document.querySelector('tfoot');
    if (tfoot) {
      const t = document.createElement('template');
      t.innerHTML = `<tfoot>${this.renderStatsRow(students, evs)}</tfoot>`;
      tfoot.replaceWith(t.content.firstElementChild);
    }
    const panel = document.querySelector('.stats-panel');
    if (panel && students.length) {
      const t = document.createElement('template');
      t.innerHTML = this.renderStatsPanel(students);
      panel.replaceWith(t.content.firstElementChild);
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  _bindAll() {
    const app = document.getElementById('app');
    app.addEventListener('click',    e => this._onClick(e));
    app.addEventListener('dblclick', e => this._onDblClick(e));
    app.addEventListener('input',    e => this._onInput(e));
  }

  _onInput(e) {
    const el     = e.target;
    const action = el.dataset?.action;
    if (!action) return;
    const cId = this.state.activeCourse;

    if (action === 'taller-text') {
      const id  = el.dataset.id;
      const arr = this.state.taller[cId];
      if (!arr) return;
      const entry = arr.find(x => x.id === id);
      if (entry) { entry.content = el.value; this.save(); }

    } else if (action === 'taller-date') {
      const id  = el.dataset.id;
      const arr = this.state.taller[cId];
      if (!arr) return;
      const entry = arr.find(x => x.id === id);
      if (entry) {
        entry.date = el.value;
        this.save();
        const lbl = el.closest('.taller-entry-header')?.querySelector('.taller-entry-date-label');
        if (lbl) lbl.textContent = this._fmtDateES(el.value);
      }

    } else if (action === 'obs-text') {
      const stId    = el.dataset.student;
      const entryId = el.dataset.id;
      if (!this.state.observations[cId])         this.state.observations[cId]       = {};
      if (!this.state.observations[cId][stId])   this.state.observations[cId][stId] = [];
      const entry = this.state.observations[cId][stId].find(x => x.id === entryId);
      if (entry) { entry.content = el.value; this.save(); }

    } else if (action === 'obs-date') {
      const stId    = el.dataset.student;
      const entryId = el.dataset.id;
      if (!this.state.observations[cId]?.[stId]) return;
      const entry = this.state.observations[cId][stId].find(x => x.id === entryId);
      if (entry) {
        entry.date = el.value;
        this.save();
        const lbl = el.closest('.obs-entry-header')?.querySelector('.obs-entry-date-label');
        if (lbl) lbl.textContent = this._fmtDateES(el.value);
      }

    } else if (action === 'obs-filter') {
      const q = el.value.toLowerCase().trim();
      document.querySelectorAll('.obs-list-item').forEach(item => {
        const name = item.querySelector('.obs-list-name')?.textContent.toLowerCase() || '';
        item.style.display = (!q || name.includes(q)) ? '' : 'none';
      });
    }
  }

  _onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    e.stopPropagation();
    const a = el.dataset.action;

    if (a === 'activate') {
      this._validateActivation();

    } else if (a === 'toggle-sidebar') {
      document.getElementById('app').classList.toggle('sb-open');

    } else if (a === 'close-sidebar') {
      document.getElementById('app').classList.remove('sb-open');

    } else if (a === 'set-course') {
      const cId = el.dataset.course;
      this.state.activeCourse  = cId;
      const validSubjs = this._courseSubjects(cId);
      this.state.activeSubject = validSubjs[0];
      this.state.view = 'grades';
      document.getElementById('app').classList.remove('sb-open');
      this.save(); this.render();

    } else if (a === 'set-subject') {
      this.state.activeSubject = el.dataset.subject;
      this.state.view = 'grades';
      document.getElementById('app').classList.remove('sb-open');
      this.save(); this.render();

    } else if (a === 'edit-grade') {
      this._startEdit(el);

    } else if (a === 'import-students') {
      this._promptImportStudents();

    } else if (a === 'add-student') {
      this._promptAddStudent();

    } else if (a === 'del-student') {
      this._confirmDeleteStudent(el.dataset.student);

    } else if (a === 'edit-student-name') {
      this._promptEditStudentName(el.dataset.student);

    } else if (a === 'toggle-retire-student') {
      this._toggleRetireStudent(el.dataset.student);

    } else if (a === 'add-eval') {
      this._promptAddEval(el.dataset.sem);

    } else if (a === 'del-eval') {
      this._confirmDeleteEval(el.dataset.sem, parseInt(el.dataset.idx));

    } else if (a === 'edit-teacher') {
      this._promptEditTeacher();

    } else if (a === 'show-overview') {
      this.state.activeCourse  = null;
      this.state.activeSubject = null;
      this.state.view = 'overview';
      this.render();

    } else if (a === 'show-deudores') {
      this.state.view = 'deudores';
      this.save(); this.render();

    } else if (a === 'show-clases') {
      this.state.view = 'clases';
      this.render();

    } else if (a === 'edit-school') {
      this._promptEditSchool();

    } else if (a === 'show-recordatorios') {
      this.state.view = 'recordatorios';
      this.render();
    } else if (a === 'add-reminder') {
      this._promptAddReminder();
    } else if (a === 'toggle-reminder') {
      this._toggleReminder(el.dataset.id);
    } else if (a === 'del-reminder') {
      this._deleteReminder(el.dataset.id);

    } else if (a === 'add-course') {
      this._promptAddCourse();
    } else if (a === 'edit-course') {
      this._promptEditCourse(el.dataset.course);
    } else if (a === 'del-course') {
      this._confirmDeleteCourse(el.dataset.course);

    } else if (a === 'add-subject') {
      this._promptAddSubject();
    } else if (a === 'assign-subject') {
      this._promptAssignSubject(el.dataset.subject);
    } else if (a === 'edit-subject') {
      this._promptEditSubject(el.dataset.subject);
    } else if (a === 'del-subject') {
      this._confirmDeleteSubject(el.dataset.subject);


    } else if (a === 'export-csv') {
      this._exportCSV();

    } else if (a === 'export-deudores') {
      this._exportDeudoresCSV();

    } else if (a === 'add-taller-entry') {
      const cId   = this.state.activeCourse;
      if (!this.state.taller[cId]) this.state.taller[cId] = [];
      const today = new Date().toISOString().slice(0, 10);
      const id    = `t_${Date.now()}`;
      this.state.taller[cId].unshift({ id, date: today, content: '', createdAt: Date.now() });
      this.save(); this.render();
      requestAnimationFrame(() => {
        const ta = document.querySelector(`textarea[data-action="taller-text"][data-id="${id}"]`);
        if (ta) ta.focus();
      });

    } else if (a === 'del-taller-entry') {
      const cId = this.state.activeCourse;
      const id  = el.dataset.id;
      this.showModal({
        title: 'Eliminar entrada',
        body: `<p class="confirm-message">¿Eliminar esta entrada del Taller JEC? Esta acción no se puede deshacer.</p>`,
        confirm: 'Eliminar', confirmDanger: true,
        onConfirm: () => {
          this.state.taller[cId] = (this.state.taller[cId] || []).filter(x => x.id !== id);
          this.save(); this.hideModal(); this.render();
        }
      });

    } else if (a === 'export-taller') {
      this._exportTallerCSV();

    } else if (a === 'select-obs-student') {
      const stId = el.dataset.student;
      this.state.obsSelectedStudent = stId;
      document.querySelectorAll('.obs-list-item').forEach(item => {
        item.classList.toggle('obs-list-item-active', item.dataset.student === stId);
      });
      this._refreshObsDetail(stId);

    } else if (a === 'toggle-obs-student') {
      const block = el.closest('.obs-student-block');
      if (block) block.classList.toggle('obs-open');

    } else if (a === 'add-obs-entry') {
      const cId  = this.state.activeCourse;
      const stId = el.dataset.student;
      if (!this.state.observations[cId])        this.state.observations[cId]       = {};
      if (!this.state.observations[cId][stId])  this.state.observations[cId][stId] = [];
      const today = new Date().toISOString().slice(0, 10);
      const id    = `o_${Date.now()}`;
      this.state.observations[cId][stId].unshift({ id, date: today, content: '', createdAt: Date.now() });
      this.save();
      this._refreshObsDetail(stId);
      requestAnimationFrame(() => {
        const ta = document.querySelector(`textarea[data-action="obs-text"][data-id="${id}"]`);
        if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      });

    } else if (a === 'del-obs-entry') {
      const cId     = this.state.activeCourse;
      const stId    = el.dataset.student;
      const entryId = el.dataset.id;
      this.showModal({
        title: 'Eliminar observación',
        body: `<p class="confirm-message">¿Eliminar esta observación? Esta acción no se puede deshacer.</p>`,
        confirm: 'Eliminar', confirmDanger: true,
        onConfirm: () => {
          if (this.state.observations[cId]?.[stId])
            this.state.observations[cId][stId] = this.state.observations[cId][stId].filter(x => x.id !== entryId);
          this.save(); this.hideModal();
          this._refreshObsDetail(stId);
        }
      });

    } else if (a === 'export-obs') {
      this._exportObsCSV();

    } else if (a === 'export-backup') {
      this._exportBackup();
    } else if (a === 'import-backup') {
      this._importBackup();
    } else if (a === 'show-backup-help') {
      this._showBackupHelp();
    } else if (a === 'dismiss-backup-banner') {
      document.getElementById('backup-banner')?.remove();

    } else if (a === 'dismiss-renewal-banner') {
      document.getElementById('renewal-banner')?.remove();

    } else if (a === 'print-report-overview' || a === 'print-report-course') {
      window.print();

    } else if (a === 'toggle-attendance') {
      this._toggleAttendance(el.dataset.student, el.dataset.date);
    } else if (a === 'mark-all-present') {
      this._markAllPresent(el.dataset.date);
    } else if (a === 'att-nav-day') {
      this.state.attendanceDate = el.dataset.date;
      this.save(); this.render();
    } else if (a === 'export-attendance') {
      this._exportAttendanceCSV();

    } else if (a === 'gdrive-connect') {
      this._gdriveConnect();
    } else if (a === 'gdrive-disconnect') {
      this._gdriveDisconnect();
    } else if (a === 'gdrive-save') {
      this._gdriveSave();
    } else if (a === 'gdrive-load') {
      this._gdriveLoad();
    }
  }

  _onDblClick(e) {
    const th = e.target.closest('th.th-eval');
    if (!th) return;
    this._promptRenameEval(th.dataset.sem, parseInt(th.dataset.idx));
  }

  // ── Inline grade editing ─────────────────────────────────────────────────────

  _startEdit(cell) {
    const existing = document.querySelector('.grade-input, .concept-select');
    if (existing) existing.blur();

    const studentId = cell.dataset.student;
    const sem       = cell.dataset.sem;
    const evalName  = cell.dataset.eval;
    const { activeCourse: cId, activeSubject: sId } = this.state;

    if (this._isConceptual(sId)) {
      this._startConceptEdit(cell, studentId, sem, evalName, cId, sId);
      return;
    }

    const current = this.state.grades[cId][sId][studentId]?.[sem]?.[evalName] ?? null;

    cell.classList.add('editing');
    const span = cell.querySelector('.grade-val');
    span.style.visibility = 'hidden';

    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'grade-input';
    input.value       = current !== null ? current.toString().replace('.', ',') : '';
    input.placeholder = '—';
    input.maxLength   = 4;
    cell.appendChild(input);
    input.focus();
    input.select();

    let committed = false;

    const commit = () => {
      if (committed) return true;
      const raw = input.value.trim();
      let newGrade;

      if (!raw || raw === '-' || raw === '—') {
        newGrade = null;
      } else {
        newGrade = this.parseGrade(raw);
        if (newGrade === undefined) {
          cell.classList.add('invalid');
          setTimeout(() => cell.classList.remove('invalid'), 500);
          input.focus(); input.select();
          return false;
        }
      }

      committed = true;
      if (!this.state.grades[cId][sId][studentId])
        this.state.grades[cId][sId][studentId] = { s1:{}, s2:{} };
      this.state.grades[cId][sId][studentId][sem][evalName] = newGrade;
      this.save();

      cell.classList.remove('editing');
      span.style.visibility = '';
      input.remove();
      this.refreshRow(studentId);
      this.refreshStats();
      return true;
    };

    input.addEventListener('blur', () => commit());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (commit()) this._focusAdjacent(studentId, sem, evalName, 1, 0);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (commit()) this._focusAdjacent(studentId, sem, evalName, e.shiftKey ? -1 : 1, 0);
      } else if (e.key === 'Escape') {
        committed = true;
        cell.classList.remove('editing');
        span.style.visibility = '';
        input.remove();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (commit()) this._focusAdjacent(studentId, sem, evalName, 0, 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (commit()) this._focusAdjacent(studentId, sem, evalName, 0, -1);
      }
    });
  }

  _startConceptEdit(cell, studentId, sem, evalName, cId, sId) {
    // Cerrar cualquier picker abierto
    document.querySelectorAll('.concept-picker').forEach(p => p.remove());

    const current = this.state.grades[cId][sId][studentId]?.[sem]?.[evalName] ?? null;

    const save = (val) => {
      picker.remove();
      document.removeEventListener('mousedown', outsideClick, true);
      if (!this.state.grades[cId][sId][studentId])
        this.state.grades[cId][sId][studentId] = { s1:{}, s2:{} };
      this.state.grades[cId][sId][studentId][sem][evalName] = val;
      this.save();
      this.refreshRow(studentId);
      this.refreshStats();
    };

    const picker = document.createElement('div');
    picker.className = 'concept-picker';
    picker.setAttribute('role', 'listbox');

    // Botón borrar
    const clearBtn = document.createElement('button');
    clearBtn.className   = `cp-btn cp-clear${!current ? ' cp-active' : ''}`;
    clearBtn.textContent = '—';
    clearBtn.title       = 'Borrar calificación';
    clearBtn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); save(null); });
    picker.appendChild(clearBtn);

    CONCEPT_GRADES.forEach(c => {
      const btn = document.createElement('button');
      btn.className   = `cp-btn cp-${c.toLowerCase()}${c === current ? ' cp-active' : ''}`;
      btn.textContent = c;
      btn.title       = CONCEPT_LABELS[c];
      btn.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); save(c); });
      picker.appendChild(btn);
    });

    // Posicionar debajo o arriba de la celda
    const rect       = cell.getBoundingClientRect();
    const pickerH    = 42;
    const pickerW    = 210;
    const top        = (window.innerHeight - rect.bottom > pickerH + 8)
      ? rect.bottom + 3
      : rect.top - pickerH - 3;
    const left       = Math.min(rect.left, window.innerWidth - pickerW - 8);
    picker.style.cssText = `position:fixed;top:${top}px;left:${Math.max(4, left)}px`;

    document.body.appendChild(picker);

    // Cerrar al hacer click fuera
    const outsideClick = (e) => {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('mousedown', outsideClick, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', outsideClick, true), 0);
  }

  _allCells() {
    const { activeCourse: cId, activeSubject: sId } = this.state;
    const students = this.state.students[cId] || [];
    const evs      = this.state.evaluations[cId][sId];
    const cells    = [];
    students.forEach(st => {
      evs.s1.forEach(e => cells.push({ stId:st.id, sem:'s1', eval:e }));
      evs.s2.forEach(e => cells.push({ stId:st.id, sem:'s2', eval:e }));
    });
    return cells;
  }

  _focusAdjacent(studentId, sem, evalName, dCol, dRow) {
    const cells      = this._allCells();
    const evs        = this.state.evaluations[this.state.activeCourse][this.state.activeSubject];
    const colsPerRow = evs.s1.length + evs.s2.length;
    const idx        = cells.findIndex(c => c.stId === studentId && c.sem === sem && c.eval === evalName);
    if (idx === -1) return;
    const next = cells[idx + dCol + dRow * colsPerRow];
    if (!next) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `td.grade-cell[data-student="${next.stId}"][data-sem="${next.sem}"][data-eval="${next.eval}"]`
      );
      if (el) el.click();
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  _promptAddStudent() {
    const { activeCourse: cId } = this.state;
    const count = (this.state.students[cId] || []).length;
    this.showModal({
      title: 'Agregar Alumno',
      body: `
        <label class="modal-label">Nombre completo</label>
        <input type="text" id="m-input" class="modal-input" placeholder="Apellido Apellido, Nombre" autofocus>
        <div class="modal-hint">Formato sugerido: <em>Apellido Apellido, Nombre</em></div>
        <label class="modal-label" style="margin-top:12px">Posición en la lista</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="number" id="m-pos" class="modal-input" value="${count + 1}" min="1" max="${count + 1}" style="width:80px">
          <span class="modal-hint" style="margin:0">de ${count + 1} (al final por defecto)</span>
        </div>`,
      confirm: 'Agregar',
      onConfirm: () => {
        const name = document.getElementById('m-input').value.trim();
        if (!name) return;
        const posInput = document.getElementById('m-pos');
        const pos = posInput ? Math.max(0, parseInt(posInput.value || count + 1) - 1) : count;
        this._addStudent(name, pos);
        this.hideModal();
      }
    });
  }

  _addStudent(name, insertIdx) {
    const { activeCourse: cId } = this.state;
    const id      = `${cId}_st_${Date.now()}`;
    const list    = this.state.students[cId];
    const subjIds = this._courseSubjects(cId);
    if (insertIdx !== undefined && insertIdx >= 0 && insertIdx < list.length) {
      list.splice(insertIdx, 0, { id, name });
    } else {
      list.push({ id, name });
    }
    subjIds.forEach(sId => {
      if (!this.state.grades[cId][sId]) this.state.grades[cId][sId] = {};
      this.state.grades[cId][sId][id] = { s1:{}, s2:{} };
    });
    this.save(); this.render();
    this.toast(`Alumno "${name}" agregado`);
  }

  _parseStudentText(text) {
    return text
      .split(/[\r\n]+/)
      .map(line => line.split('\t')[0].replace(/^["']|["']$/g, '').trim())
      .filter(name => name.length > 1);
  }

  _promptImportStudents() {
    const { activeCourse: cId } = this.state;
    const otherCourses = this.state.courses.filter(c => c.id !== cId);
    const otherOptions = otherCourses.map(c => {
      const count = (this.state.students[c.id] || []).length;
      return `<option value="${this._esc(c.id)}">${this._esc(c.name)} (${count} alumnos)</option>`;
    }).join('');

    this.showModal({
      title: 'Importar alumnos',
      body: `
        <div class="modal-hint" style="margin-bottom:10px">
          Pega una lista de nombres desde Excel (una columna) o escribe uno por línea:
        </div>
        <textarea id="m-import-text" class="modal-import-textarea" rows="9"
          placeholder="Pérez González, Juan&#10;López Muñoz, María&#10;Rodríguez Silva, Pedro"></textarea>
        ${otherOptions ? `
          <div class="modal-section-divider">— o copia nómina de otra clase —</div>
          <select id="m-copy-course" class="modal-select">
            <option value="">Seleccionar clase fuente…</option>
            ${otherOptions}
          </select>
        ` : ''}`,
      confirm: 'Vista previa →',
      onConfirm: () => {
        const selectEl   = document.getElementById('m-copy-course');
        const textareaEl = document.getElementById('m-import-text');
        let rawNames = [];

        if (selectEl?.value) {
          rawNames = (this.state.students[selectEl.value] || []).map(s => s.name);
        } else if (textareaEl?.value.trim()) {
          rawNames = this._parseStudentText(textareaEl.value);
        }

        if (!rawNames.length) {
          this.toast('No se encontraron nombres para importar');
          return;
        }
        this.hideModal();
        this._showImportPreview(rawNames);
      }
    });
  }

  _showImportPreview(rawNames) {
    const { activeCourse: cId } = this.state;
    const existingNames = new Set(
      (this.state.students[cId] || []).map(s => s.name.toLowerCase().trim())
    );

    const toAdd = rawNames.filter(n => !existingNames.has(n.toLowerCase().trim()));
    const dupes = rawNames.filter(n =>  existingNames.has(n.toLowerCase().trim()));

    const addHtml = toAdd.map((n, i) =>
      `<li class="import-preview-item import-preview-add">
         <label class="import-preview-check">
           <input type="checkbox" name="import-st" value="${i}" checked>
           ${this._esc(n)}
         </label>
       </li>`).join('');
    const dupeHtml = dupes.map(n =>
      `<li class="import-preview-item import-preview-dupe">${this._esc(n)}</li>`).join('');

    this.showModal({
      title: 'Vista previa de importación',
      body: `
        ${toAdd.length
          ? `<div class="import-preview-label">
               <span class="import-preview-badge import-preview-badge-add">${toAdd.length}</span>
               alumno${toAdd.length !== 1 ? 's' : ''} nuevo${toAdd.length !== 1 ? 's' : ''} — desmarca los que no quieras agregar:
             </div>
             <ul class="import-preview-list">${addHtml}</ul>`
          : `<p class="modal-hint">No hay alumnos nuevos para agregar.</p>`}
        ${dupes.length
          ? `<div class="import-preview-label" style="margin-top:12px">
               <span class="import-preview-badge import-preview-badge-dupe">${dupes.length}</span>
               ya existen (se omitirán):
             </div>
             <ul class="import-preview-list import-preview-list-dupe">${dupeHtml}</ul>`
          : ''}`,
      confirm: toAdd.length ? `Importar ${toAdd.length} alumno${toAdd.length !== 1 ? 's' : ''}` : 'Cerrar',
      onConfirm: !toAdd.length ? () => this.hideModal() : () => {
        const selected = [...document.querySelectorAll('input[name="import-st"]:checked')]
          .map(el => toAdd[parseInt(el.value)]);
        if (!selected.length) { this.hideModal(); return; }
        const subjIds = this._courseSubjects(cId);
        selected.forEach(name => {
          const id = `${cId}_st_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          (this.state.students[cId] = this.state.students[cId] || []).push({ id, name });
          subjIds.forEach(sId => {
            if (!this.state.grades[cId][sId]) this.state.grades[cId][sId] = {};
            this.state.grades[cId][sId][id] = { s1: {}, s2: {} };
          });
        });
        this.save(); this.hideModal(); this.render();
        this.toast(`${selected.length} alumno${selected.length !== 1 ? 's' : ''} importado${selected.length !== 1 ? 's' : ''}`);
      }
    });
  }

  _confirmDeleteStudent(studentId) {
    const { activeCourse: cId } = this.state;
    const st = this.state.students[cId]?.find(s => s.id === studentId);
    if (!st) return;
    this.showModal({
      title: 'Eliminar alumno',
      body: `<p class="confirm-message">¿Eliminar a <strong>${this._esc(st.name)}</strong>? Se perderán todas sus calificaciones.</p>`,
      confirm: 'Eliminar', confirmDanger: true,
      onConfirm: () => {
        this.state.students[cId] = this.state.students[cId].filter(s => s.id !== studentId);
        this.state.subjects.forEach(s => {
          if (this.state.grades[cId]?.[s.id]?.[studentId] !== undefined)
            delete this.state.grades[cId][s.id][studentId];
        });
        this.save(); this.hideModal(); this.render();
        this.toast('Alumno eliminado');
      }
    });
  }

  _promptEditStudentName(studentId) {
    const { activeCourse: cId } = this.state;
    const st = this.state.students[cId]?.find(s => s.id === studentId);
    if (!st) return;
    this.showModal({
      title: 'Editar nombre del alumno',
      body: `
        <label class="modal-label">Nombre completo</label>
        <input type="text" id="m-input" class="modal-input" value="${this._esc(st.name)}" autofocus>
        <div class="modal-hint">Formato sugerido: <em>Apellido Apellido, Nombre</em></div>`,
      confirm: 'Guardar',
      onConfirm: () => {
        const name = document.getElementById('m-input').value.trim();
        if (!name) { this.hideModal(); return; }
        st.name = name;
        this.save(); this.hideModal(); this.render();
        this.toast('Nombre actualizado');
      }
    });
  }

  _toggleRetireStudent(studentId) {
    const { activeCourse: cId } = this.state;
    const st = this.state.students[cId]?.find(s => s.id === studentId);
    if (!st) return;
    if (st.retired) {
      st.retired = false;
      this.save(); this.render();
      this.toast(`${st.name} reactivado`);
    } else {
      this.showModal({
        title: 'Marcar como retirado',
        body: `<p class="confirm-message">¿Marcar a <strong>${this._esc(st.name)}</strong> como retirado/a?<br>Sus calificaciones se conservarán y quedará marcado en la lista.</p>`,
        confirm: 'Marcar retirado',
        onConfirm: () => {
          st.retired = true;
          this.save(); this.hideModal(); this.render();
          this.toast(`${st.name} marcado como retirado`);
        }
      });
    }
  }

  _promptAddEval(sem) {
    const { activeCourse: cId, activeSubject: sId } = this.state;
    const isConc  = this._isConceptual(sId);
    const current = this.state.evaluations[cId][sId][sem];
    const prefix  = isConc ? 'C' : 'N';
    const suggested = `${prefix}${current.length + 1}`;

    this.showModal({
      title: `Nueva evaluación — ${sem === 's1' ? '1er' : '2do'} Semestre`,
      body: `
        <label class="modal-label">Nombre de la evaluación</label>
        <input type="text" id="m-input" class="modal-input" value="${suggested}" autofocus>
        <div class="modal-hint">${isConc
          ? 'La calificación se ingresará como I / S / B / MB.'
          : 'Ej: N6, Prueba, Trabajo, Disertación'}</div>`,
      confirm: 'Agregar',
      onConfirm: () => {
        const name = document.getElementById('m-input').value.trim();
        if (!name) return;
        this._addEval(sem, name);
        this.hideModal();
      }
    });
  }

  _addEval(sem, name) {
    const { activeCourse: cId, activeSubject: sId } = this.state;
    this.state.evaluations[cId][sId][sem].push(name);
    this.save(); this.render();
  }

  _confirmDeleteEval(sem, idx) {
    const { activeCourse: cId, activeSubject: sId } = this.state;
    const evs = this.state.evaluations[cId][sId][sem];
    if (evs.length <= 1) { this.toast('Debe haber al menos una evaluación por semestre', 'warn'); return; }
    const evalName = evs[idx];
    this.showModal({
      title: 'Eliminar evaluación',
      body: `<p class="confirm-message">¿Eliminar la evaluación <strong>${this._esc(evalName)}</strong>? Se perderán todas las notas de esta columna.</p>`,
      confirm: 'Eliminar', confirmDanger: true,
      onConfirm: () => {
        this.state.evaluations[cId][sId][sem].splice(idx, 1);
        (this.state.students[cId] || []).forEach(st => {
          delete this.state.grades[cId][sId]?.[st.id]?.[sem]?.[evalName];
        });
        this.save(); this.hideModal(); this.render();
      }
    });
  }

  _promptRenameEval(sem, idx) {
    const { activeCourse: cId, activeSubject: sId } = this.state;
    const oldName = this.state.evaluations[cId][sId][sem][idx];
    this.showModal({
      title: 'Renombrar evaluación',
      body: `
        <label class="modal-label">Nuevo nombre</label>
        <input type="text" id="m-input" class="modal-input" value="${this._esc(oldName)}" autofocus>`,
      confirm: 'Guardar',
      onConfirm: () => {
        const newName = document.getElementById('m-input').value.trim();
        if (!newName || newName === oldName) { this.hideModal(); return; }
        this.state.evaluations[cId][sId][sem][idx] = newName;
        (this.state.students[cId] || []).forEach(st => {
          const sg = this.state.grades[cId][sId]?.[st.id]?.[sem];
          if (sg && oldName in sg) { sg[newName] = sg[oldName]; delete sg[oldName]; }
        });
        this.save(); this.hideModal(); this.render();
      }
    });
  }

  _promptEditTeacher() {
    this.showModal({
      title: 'Nombre del docente',
      body: `<input type="text" id="m-input" class="modal-input" value="${this._esc(this.state.teacherName)}" autofocus>`,
      confirm: 'Guardar',
      onConfirm: () => {
        const name = document.getElementById('m-input').value.trim();
        if (!name) { this.hideModal(); return; }
        this.state.teacherName = name;
        this.save(); this.hideModal(); this.render();
      }
    });
  }

  _exportCSV() {
    const { activeCourse: cId, activeSubject: sId, courses, subjects } = this.state;
    if (!cId || !sId) { this.toast('Selecciona un curso y materia', 'warn'); return; }

    const course   = courses.find(c => c.id === cId);
    const subject  = subjects.find(s => s.id === sId);
    const students = this.state.students[cId] || [];
    const evs      = this.state.evaluations[cId][sId];
    const isConc   = this._isConceptual(sId);

    const esc = v => `"${String(v).replace(/"/g,'""')}"`;
    const header = [
      'Alumno',
      ...evs.s1.map(e => `S1: ${e}`), isConc ? 'Conc S1' : 'Prom S1',
      ...evs.s2.map(e => `S2: ${e}`), isConc ? 'Conc S2' : 'Prom S2',
      isConc ? 'Final' : 'Final'
    ].map(esc).join(',');

    const rows = students.map(st => {
      const s1g = evs.s1.map(e => this.state.grades[cId][sId][st.id]?.s1?.[e] ?? '');
      const s2g = evs.s2.map(e => this.state.grades[cId][sId][st.id]?.s2?.[e] ?? '');
      return [
        esc(st.name),
        ...s1g, this.fmtAvg(this.semAvg(cId, sId, st.id, 's1')),
        ...s2g, this.fmtAvg(this.semAvg(cId, sId, st.id, 's2')),
        this.fmtAvg(this.finalAvg(cId, sId, st.id)),
      ].join(',');
    });

    const blob = new Blob([`﻿${header}\n${rows.join('\n')}`], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url,
      download: `Notas_${course.name}_${subject.name}_${this.state.year}.csv`.replace(/[\\/:*?"<>|]/g,'_'),
    });
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Exportado como CSV ✓');
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  showModal({ title, body, confirm, confirmDanger, onConfirm }) {
    const backdrop    = document.getElementById('modal-backdrop');
    const modal       = document.getElementById('modal');
    const safeConfirm = onConfirm || (() => this.hideModal());

    modal.innerHTML = `
      <div class="modal-header">
        <h3 class="modal-title">${title}</h3>
        <button class="modal-close" id="m-close">×</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-footer">
        <button class="btn-modal-cancel" id="m-cancel">Cancelar</button>
        <button class="btn-modal-confirm${confirmDanger ? ' danger' : ''}" id="m-confirm">${confirm}</button>
      </div>`;

    backdrop.classList.remove('hidden');
    modal.classList.remove('hidden');

    setTimeout(() => {
      const inp = modal.querySelector('input');
      if (inp) { inp.focus(); inp.select(); }
    }, 60);

    const close = () => this.hideModal();
    document.getElementById('m-close').onclick   = close;
    document.getElementById('m-cancel').onclick  = close;
    document.getElementById('m-confirm').onclick = safeConfirm;
    backdrop.onclick = close;
    modal.onkeydown  = e => {
      if (e.key === 'Enter')  { e.preventDefault(); safeConfirm(); }
      if (e.key === 'Escape') close();
    };
  }

  hideModal() {
    document.getElementById('modal-backdrop').classList.add('hidden');
    document.getElementById('modal').classList.add('hidden');
  }

  // ── Toast ────────────────────────────────────────────────────────────────────

  toast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = `toast${type === 'warn' ? ' warn' : ''} show`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  _icon(name) {
    const icons = {
      'grid':       `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="0.5" y="0.5" width="5" height="5" rx="1" fill="currentColor" opacity=".7"/><rect x="7.5" y="0.5" width="5" height="5" rx="1" fill="currentColor" opacity=".7"/><rect x="0.5" y="7.5" width="5" height="5" rx="1" fill="currentColor" opacity=".7"/><rect x="7.5" y="7.5" width="5" height="5" rx="1" fill="currentColor"/></svg>`,
      'download':   `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1v7M4 6l2.5 2.5L9 6M1 10v.5A1.5 1.5 0 002.5 12h8A1.5 1.5 0 0012 10.5V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      'add-person': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="4.5" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M1.5 12c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="11" y1="1.5" x2="11" y2="5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="3.5" x2="13" y2="3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
      'deudores':   `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="4" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M1 12c0-3 2.5-5 5.5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="2" stroke="currentColor" stroke-width="1.4"/><line x1="10.5" y1="9.5" x2="10.5" y2="10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="10.5" cy="11.5" r="0.3" fill="currentColor"/></svg>`,
      'backup':     `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1.5v6M4 5.5l2.5 2.5L9 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="1" y="9" width="11" height="3" rx="1" stroke="currentColor" stroke-width="1.4"/></svg>`,
      'restore':    `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2.5 7A4 4 0 106.5 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2.5 3.5v3.5H6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      'clases':     `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="2" width="11" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="1" y="7" width="11" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/><line x1="3" y1="3.5" x2="5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3" y1="8.5" x2="5" y2="8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
      'import':     `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v7M4.5 6L7 8.5 9.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 10h3.5M9.5 10H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="4" y="9" width="6" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>`,
      'drive':      `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M4.5 9.5l-3-5.5h7l3 5.5H4.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M1.5 4L5 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M11.5 4L8 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
      'attendance': `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="2" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M4 1v2M9 1v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M4 7l1.5 1.5L9 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
      'print':      `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="3" y="1" width="7" height="4" rx="0.8" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="5" width="9" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="4" y="8" width="5" height="3" rx="0.5" fill="currentColor" opacity=".4"/><circle cx="10" cy="7" r="0.7" fill="currentColor"/></svg>`,
      'reminder':   `<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M6.5 1.5A3.5 3.5 0 003 5v2.5L2 9h9l-1-1.5V5A3.5 3.5 0 006.5 1.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.5 9.5a1 1 0 002 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
    };
    return icons[name] || '';
  }

  // ── Deudores ─────────────────────────────────────────────────────────────────

  /**
   * Lógica: una evaluación se considera "activa" (requerida) para un alumno
   * sólo si AL MENOS UN OTRO alumno del mismo curso ya tiene nota en esa columna.
   * Así, si nadie tiene N3 todavía, N3 no cuenta como deuda de nadie.
   * Cuando el profesor empieza a ingresar N3 para algunos, los que no la tienen
   * aparecen automáticamente como deudores.
   */
  _getDeudores() {
    const result = [];

    this.state.courses.forEach(c => {
      const students = this.state.students[c.id] || [];
      if (!students.length) return;
      const subjIds = this._courseSubjects(c.id);

      // Determinar qué columnas están "activas" (al menos 1 alumno con nota)
      const active = {}; // active[sId][sem] = Set<evalName>
      subjIds.forEach(sId => {
        active[sId] = { s1: new Set(), s2: new Set() };
        const evs = this.state.evaluations[c.id]?.[sId];
        if (!evs) return;
        ['s1', 's2'].forEach(sem => {
          (evs[sem] || []).forEach(e => {
            const started = students.some(st => {
              const g = this.state.grades[c.id]?.[sId]?.[st.id]?.[sem]?.[e];
              return g !== null && g !== undefined && g !== '';
            });
            if (started) active[sId][sem].add(e);
          });
        });
      });

      const deudores = [];
      students.forEach(st => {
        const pending = [];
        subjIds.forEach(sId => {
          const subject = this.state.subjects.find(s => s.id === sId);
          const evs     = this.state.evaluations[c.id]?.[sId];
          if (!evs) return;
          ['s1', 's2'].forEach(sem => {
            const missing = (evs[sem] || []).filter(e => {
              if (!active[sId][sem].has(e)) return false; // columna no iniciada → no cuenta
              const g = this.state.grades[c.id]?.[sId]?.[st.id]?.[sem]?.[e];
              return g === null || g === undefined || g === '';
            });
            if (missing.length) pending.push({
              subjectName: subject?.name || sId,
              isConc:      this._isConceptual(sId),
              sem,
              evals:       missing,
            });
          });
        });
        // Ordenar por cantidad de pendientes (más primero)
        if (pending.length) deudores.push({ student: st, pending,
          totalMissing: pending.reduce((n, p) => n + p.evals.length, 0) });
      });

      deudores.sort((a, b) => b.totalMissing - a.totalMissing);
      if (deudores.length) result.push({ course: c, deudores });
    });

    return result;
  }

  renderDeudores() {
    const data       = this._getDeudores();
    const totalAlums = data.reduce((n, c) => n + c.deudores.length, 0);
    const totalEvals = data.reduce((n, c) =>
      n + c.deudores.reduce((m, d) => m + d.totalMissing, 0), 0);

    const emptyState = `
      <div class="deudores-empty">
        <div class="deudores-ok-icon">✓</div>
        <div class="deudores-ok-title">¡Todo al día!</div>
        <div class="deudores-ok-sub">No hay evaluaciones iniciadas con registros pendientes.</div>
      </div>`;

    const courseBlocks = data.map(({ course, deudores }) => {
      const totalCourseMissing = deudores.reduce((n, d) => n + d.totalMissing, 0);

      const rows = deudores.map((d, i) => {
        const pendingLines = d.pending.map(p => {
          const semLabel = p.sem === 's1' ? '1er Sem' : '2do Sem';
          const tags = p.evals.map(e =>
            `<span class="deudor-tag${p.isConc ? ' deudor-tag-conc' : ''}">${this._esc(e)}</span>`
          ).join('');
          return `<div class="deudor-pending-row">
            <span class="deudor-subject-lbl">${this._esc(p.subjectName)}</span>
            <span class="deudor-sem-lbl">${semLabel}</span>
            <span class="deudor-tags">${tags}</span>
          </div>`;
        }).join('');

        return `
          <div class="deudor-student-row">
            <div class="deudor-student-name">
              <span class="deudor-idx">${i + 1}</span>
              <span>${this._esc(d.student.name)}</span>
              <span class="deudor-count-badge">${d.totalMissing} pendiente${d.totalMissing !== 1 ? 's' : ''}</span>
            </div>
            <div class="deudor-pending-list">${pendingLines}</div>
          </div>`;
      }).join('');

      return `
        <div class="deudores-course-block">
          <div class="deudores-course-hdr">
            <span class="deudores-course-name">${this._esc(course.name)}</span>
            <div class="deudores-course-meta">
              <span class="deudores-course-badge">${deudores.length} alumno${deudores.length !== 1 ? 's' : ''}</span>
              <span class="deudores-course-evals">${totalCourseMissing} eval.</span>
            </div>
          </div>
          <div class="deudores-students">${rows}</div>
        </div>`;
    }).join('');

    return `
      <div class="topbar">
        <div class="breadcrumb">
          <span class="bc-course">Deudores de Notas</span>
        </div>
        <div class="topbar-actions">
          ${data.length > 0 ? `<button class="btn-add" data-action="export-deudores">${this._icon('download')} Exportar CSV</button>` : ''}
        </div>
      </div>
      ${data.length > 0 ? `
        <div class="deudores-summary">
          <strong>${totalAlums}</strong> alumno${totalAlums !== 1 ? 's' : ''} con evaluaciones pendientes
          &nbsp;·&nbsp;
          <strong>${totalEvals}</strong> evaluacion${totalEvals !== 1 ? 'es' : ''} por completar
          <span class="deudores-summary-hint">· Solo evalúa columnas que ya tienen al menos una nota ingresada</span>
        </div>` : ''}
      <div class="deudores-body">
        ${data.length === 0 ? emptyState : courseBlocks}
      </div>`;
  }

  _exportDeudoresCSV() {
    const data = this._getDeudores();
    if (!data.length) { this.toast('No hay deudores para exportar', 'warn'); return; }

    const esc = v => `"${String(v).replace(/"/g,'""')}"`;
    const rows = [
      [esc('Curso'), esc('Alumno'), esc('Asignatura'), esc('Semestre'), esc('Evaluaciones pendientes')].join(',')
    ];

    data.forEach(({ course, deudores }) => {
      deudores.forEach(d => {
        d.pending.forEach(p => {
          rows.push([
            esc(course.name),
            esc(d.student.name),
            esc(p.subjectName),
            esc(p.sem === 's1' ? '1er Semestre' : '2do Semestre'),
            esc(p.evals.join(', ')),
          ].join(','));
        });
      });
    });

    const blob = new Blob([`﻿${rows.join('\n')}`], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url,
      download: `Deudores_${this.state.year}.csv`,
    });
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Deudores exportados ✓');
  }

  // ── Taller JEC ───────────────────────────────────────────────────────────────

  _fmtDateES(dateStr) {
    if (!dateStr) return 'Sin fecha';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt   = new Date(y, m - 1, d);
    const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const mons = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    return `${days[dt.getDay()]} ${d} de ${mons[m - 1]} de ${y}`;
  }

  renderTaller() {
    const cId    = this.state.activeCourse;
    const course = this.state.courses.find(c => c.id === cId);
    const entries = [...(this.state.taller[cId] || [])]
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);

    const today = new Date().toISOString().slice(0, 10);

    const body = entries.length === 0
      ? `<div class="taller-empty">
           <div class="taller-empty-icon">📓</div>
           <p>Sin entradas aún.<br>Haz clic en <strong>Nueva clase</strong> para comenzar la bitácora.</p>
         </div>`
      : entries.map((entry, i) => `
          <div class="taller-entry" data-entry-id="${entry.id}">
            <div class="taller-entry-header">
              <div class="taller-entry-left">
                <span class="taller-entry-num">Clase ${entries.length - i}</span>
                <span class="taller-entry-date-label">${this._esc(this._fmtDateES(entry.date))}</span>
              </div>
              <div class="taller-entry-right">
                <input type="date" class="taller-date-input"
                       data-action="taller-date" data-id="${entry.id}"
                       value="${entry.date || today}"
                       title="Cambiar fecha">
                <button class="taller-del-btn" data-action="del-taller-entry" data-id="${entry.id}" title="Eliminar entrada">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
            <textarea class="taller-textarea"
                      data-action="taller-text" data-id="${entry.id}"
                      placeholder="Describe lo trabajado en esta clase..."
                      rows="4">${this._esc(entry.content || '')}</textarea>
          </div>`).join('');

    return `
      <div class="topbar">
        <div class="breadcrumb">
          <span class="bc-course">${this._esc(course?.name || '')}</span>
          <span class="bc-sep">›</span>
          <span class="bc-subject">Taller JEC</span>
          <span class="bc-conc-tag" style="background:#e8f5e9;color:#1b5e20;border-color:#a5d6a7">Bitácora</span>
        </div>
        <div class="topbar-actions">
          ${entries.length > 0 ? `<button class="btn-add btn-add-secondary" data-action="export-taller">${this._icon('download')} Exportar</button>` : ''}
          <button class="btn-add" data-action="add-taller-entry">+ Nueva clase</button>
        </div>
      </div>
      <div class="taller-body">${body}</div>`;
  }

  _exportTallerCSV() {
    const cId    = this.state.activeCourse;
    const course = this.state.courses.find(c => c.id === cId);
    const entries = [...(this.state.taller[cId] || [])]
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.createdAt - b.createdAt);
    if (!entries.length) { this.toast('No hay entradas para exportar', 'warn'); return; }
    const esc  = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [
      [esc('Fecha'), esc('Descripción')].join(','),
      ...entries.map(e => [esc(e.date || ''), esc(e.content || '')].join(',')),
    ];
    const blob = new Blob([`﻿${rows.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url,
      download: `TallerJEC_${course?.name || ''}_${this.state.year}.csv`.replace(/[\\/:*?"<>|]/g, '_'),
    });
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Taller JEC exportado ✓');
  }

  // ── Observaciones ─────────────────────────────────────────────────────────────

  renderObservaciones() {
    const cId      = this.state.activeCourse;
    const course   = this.state.courses.find(c => c.id === cId);
    const students = this.state.students[cId] || [];
    const obsMap   = this.state.observations[cId] || {};
    const today    = new Date().toISOString().slice(0, 10);

    if (!students.length) {
      return `
        <div class="topbar">
          <div class="breadcrumb">
            <span class="bc-course">${this._esc(course?.name || '')}</span>
            <span class="bc-sep">›</span>
            <span class="bc-subject">Observaciones</span>
          </div>
        </div>
        <div class="taller-empty">
          <div class="taller-empty-icon">📝</div>
          <p>Sin alumnos registrados en este curso.</p>
        </div>`;
    }

    // Inicializar alumno seleccionado si no hay uno válido
    if (!this.state.obsSelectedStudent || !students.find(s => s.id === this.state.obsSelectedStudent)) {
      this.state.obsSelectedStudent = students[0].id;
    }

    const selectedId   = this.state.obsSelectedStudent;
    const totalEntries = Object.values(obsMap).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);

    const listItems = students.map((st, idx) => {
      const count      = (obsMap[st.id] || []).length;
      const isSelected = st.id === selectedId;
      const isRetired  = !!st.retired;
      return `
        <div class="obs-list-item${isSelected ? ' obs-list-item-active' : ''}${isRetired ? ' obs-list-item-retired' : ''}"
             data-action="select-obs-student" data-student="${st.id}">
          <span class="obs-list-num">${idx + 1}</span>
          <span class="obs-list-name${isRetired ? ' name-retired' : ''}" title="${this._esc(st.name)}">${this._esc(st.name)}</span>
          ${count > 0 ? `<span class="obs-list-badge">${count}</span>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="topbar">
        <div class="breadcrumb">
          <span class="bc-course">${this._esc(course?.name || '')}</span>
          <span class="bc-sep">›</span>
          <span class="bc-subject">Observaciones</span>
          <span class="bc-conc-tag" style="background:#fff8e1;color:#e65100;border-color:#ffcc02">Borrador</span>
        </div>
        <div class="topbar-actions">
          ${totalEntries > 0 ? `<button class="btn-add btn-add-secondary" data-action="export-obs">${this._icon('download')} Exportar</button>` : ''}
        </div>
      </div>
      <div class="obs-layout">
        <div class="obs-left-panel">
          <div class="obs-left-search">
            <input type="text" class="obs-search-input" data-action="obs-filter"
                   placeholder="Buscar alumno..." autocomplete="off">
          </div>
          <div class="obs-student-list" id="obs-student-list">
            ${listItems}
          </div>
        </div>
        <div class="obs-right-panel" id="obs-detail-panel">
          ${this._renderObsDetail(selectedId, obsMap, today)}
        </div>
      </div>`;
  }

  _renderObsDetail(stId, obsMap, today) {
    if (!stId) return `<div class="obs-detail-empty"><p>Selecciona un alumno.</p></div>`;
    const cId = this.state.activeCourse;
    const st  = (this.state.students[cId] || []).find(s => s.id === stId);
    if (!st)  return '';
    if (!today) today = new Date().toISOString().slice(0, 10);

    const entries = [...((obsMap || {})[stId] || [])]
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);

    const entryRows = entries.map(entry => `
      <div class="obs-entry">
        <div class="obs-entry-header">
          <div class="obs-entry-date-wrap">
            <input type="date" class="taller-date-input obs-date-input"
                   data-action="obs-date" data-student="${st.id}" data-id="${entry.id}"
                   value="${entry.date || today}" title="Cambiar fecha">
            <span class="obs-entry-date-label">${this._esc(this._fmtDateES(entry.date))}</span>
          </div>
          <button class="taller-del-btn" data-action="del-obs-entry"
                  data-student="${st.id}" data-id="${entry.id}" title="Eliminar observación">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
        <textarea class="taller-textarea obs-textarea"
                  data-action="obs-text" data-student="${st.id}" data-id="${entry.id}"
                  placeholder="Escribe la observación..."
                  rows="3">${this._esc(entry.content || '')}</textarea>
      </div>`).join('');

    return `
      <div class="obs-detail-header">
        <div class="obs-detail-student-info">
          <span class="obs-detail-student-name">${this._esc(st.name)}</span>
          ${st.retired ? '<span class="retired-badge">Retirado</span>' : ''}
          <span class="obs-detail-count">${entries.length} obs.</span>
        </div>
        <button class="btn-add" data-action="add-obs-entry" data-student="${st.id}">
          + Nueva observación
        </button>
      </div>
      <div class="obs-entries-list">
        ${entries.length === 0
          ? `<div class="obs-detail-empty"><p>Sin observaciones aún.<br>Clic en <strong>+ Nueva observación</strong>.</p></div>`
          : entryRows}
      </div>`;
  }

  _refreshObsDetail(stId) {
    const panel = document.getElementById('obs-detail-panel');
    if (!panel) return;
    const cId    = this.state.activeCourse;
    const today  = new Date().toISOString().slice(0, 10);
    const obsMap = this.state.observations[cId] || {};
    panel.innerHTML = this._renderObsDetail(stId, obsMap, today);
    this._refreshObsLeftBadge(stId, (obsMap[stId] || []).length);
  }

  _refreshObsLeftBadge(stId, count) {
    const item = document.querySelector(`.obs-list-item[data-student="${stId}"]`);
    if (!item) return;
    let badge = item.querySelector('.obs-list-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'obs-list-badge';
        item.appendChild(badge);
      }
      badge.textContent = count;
    } else {
      if (badge) badge.remove();
    }
  }

  _exportObsCSV() {
    const cId      = this.state.activeCourse;
    const course   = this.state.courses.find(c => c.id === cId);
    const students = this.state.students[cId] || [];
    const obsMap   = this.state.observations[cId] || {};
    const esc      = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows     = [[esc('Alumno'), esc('Fecha'), esc('Observación')].join(',')];
    students.forEach(st => {
      const entries = [...(obsMap[st.id] || [])]
        .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.createdAt - b.createdAt);
      entries.forEach(e => rows.push([esc(st.name), esc(e.date || ''), esc(e.content || '')].join(',')));
    });
    if (rows.length <= 1) { this.toast('No hay observaciones para exportar', 'warn'); return; }
    const blob = new Blob([`﻿${rows.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url,
      download: `Observaciones_${course?.name || ''}_${this.state.year}.csv`.replace(/[\\/:*?"<>|]/g, '_'),
    });
    a.click();
    URL.revokeObjectURL(url);
    this.toast('Observaciones exportadas ✓');
  }

  // ── Mis Clases (gestión de cursos y asignaturas) ─────────────────────────────

  renderMisClases() {
    const { courses, subjects } = this.state;

    const courseRows = courses.map((c, idx) => {
      const subjIds   = this._courseSubjects(c.id);
      const subjNames = subjIds.map(sId => {
        const s = subjects.find(s => s.id === sId);
        return s ? `<span class="mc-subj-tag${s.isConceptual ? ' mc-subj-conc' : ''}">${this._esc(s.name)}</span>` : '';
      }).join('');
      const studentCount = (this.state.students[c.id] || []).length;

      return `
        <div class="mc-course-row">
          <div class="mc-course-left mc-course-nav" data-action="set-course" data-course="${c.id}" title="Ir a ${this._esc(c.name)}">
            <span class="mc-course-num">${idx + 1}</span>
            <div class="mc-course-info">
              <span class="mc-course-name">${this._esc(c.name)}</span>
              <div class="mc-subj-list">
                ${subjNames || '<span class="mc-no-subj">Sin asignaturas</span>'}
                ${c.hasTaller ? '<span class="mc-subj-tag mc-subj-taller">Taller JEC</span>' : ''}
              </div>
            </div>
          </div>
          <div class="mc-course-right">
            <span class="mc-student-count">${studentCount} alumno${studentCount !== 1 ? 's' : ''}</span>
            <button class="mc-btn mc-btn-edit" data-action="edit-course" data-course="${c.id}" title="Editar clase">✎</button>
            <button class="mc-btn mc-btn-del" data-action="del-course" data-course="${c.id}" title="Eliminar clase">×</button>
          </div>
        </div>`;
    }).join('');

    return `
      <div class="topbar">
        <div class="breadcrumb"><span class="bc-overview">Mis Clases</span></div>
        <div class="topbar-actions">
          <button class="btn-add" data-action="add-course">+ Nueva clase</button>
        </div>
      </div>
      <div class="mc-body">
        ${courses.length === 0
          ? `<div class="mc-empty"><p>Sin clases aún. Haz clic en <strong>+ Nueva clase</strong> para comenzar.</p></div>`
          : `<div class="mc-course-list">${courseRows}</div>`}
        <div class="mc-subjects-panel">
          <div class="mc-subjects-title">Asignaturas disponibles</div>
          <div class="mc-subjects-list">
            ${subjects.map(s => `
              <div class="mc-subject-row">
                <span class="mc-subj-tag${s.isConceptual ? ' mc-subj-conc' : ''}">${this._esc(s.name)}</span>
                ${s.isConceptual ? '<span class="mc-subj-hint">I·S·B·MB</span>' : '<span class="mc-subj-hint">Numérica</span>'}
                <button class="mc-btn mc-btn-assign" data-action="assign-subject" data-subject="${s.id}" title="Asignar a cursos">+</button>
                <button class="mc-btn mc-btn-edit" data-action="edit-subject" data-subject="${s.id}" title="Editar">✎</button>
                <button class="mc-btn mc-btn-del" data-action="del-subject" data-subject="${s.id}" title="Eliminar">×</button>
              </div>`).join('')}
          </div>
          <button class="mc-add-subj-btn" data-action="add-subject">+ Nueva asignatura</button>
        </div>
      </div>`;
  }

  _promptAddCourse() {
    const { subjects } = this.state;
    const subjCheckboxes = subjects.map(s => `
      <label class="mc-modal-check">
        <input type="checkbox" name="subj" value="${s.id}" checked>
        ${this._esc(s.name)}${s.isConceptual ? ' <em>(I·S·B·MB)</em>' : ''}
      </label>`).join('');

    this.showModal({
      title: 'Nueva clase',
      body: `
        <label class="modal-label">Nombre de la clase</label>
        <input type="text" id="m-input" class="modal-input" placeholder="Ej: 3° Básico Matemática" autofocus>
        <label class="modal-label" style="margin-top:14px">Asignaturas</label>
        <div class="mc-modal-checks">${subjCheckboxes}</div>
        <label class="mc-modal-check" style="margin-top:8px">
          <input type="checkbox" id="m-taller"> Tiene Taller JEC (bitácora)
        </label>`,
      confirm: 'Crear',
      onConfirm: () => {
        const name = document.getElementById('m-input').value.trim();
        if (!name) return;
        const checked  = [...document.querySelectorAll('input[name="subj"]:checked')].map(el => el.value);
        const hasTaller = document.getElementById('m-taller')?.checked || false;
        this._addCourse(name, checked, hasTaller);
        this.hideModal();
      }
    });
  }

  _addCourse(name, subjIds, hasTaller) {
    const id = `c_${Date.now()}`;
    this.state.courses.push({ id, name, hasTaller });
    this.state.courseSubjects[id] = subjIds.length ? subjIds : ['s1'];
    this.state.students[id]    = [];
    this.state.grades[id]      = {};
    this.state.evaluations[id] = {};
    subjIds.forEach(sId => {
      const isConc    = this._isConceptual(sId);
      const baseEvals = isConc ? ['C1','C2','C3','C4'] : ['N1','N2','N3'];
      this.state.evaluations[id][sId] = { s1:[...baseEvals], s2:[...baseEvals] };
      this.state.grades[id][sId] = {};
    });
    this.save(); this.render();
    this.toast(`Clase "${name}" creada`);
  }

  _promptEditCourse(cId) {
    const course = this.state.courses.find(c => c.id === cId);
    if (!course) return;
    const { subjects } = this.state;
    const current = this._courseSubjects(cId);
    const subjCheckboxes = subjects.map(s => `
      <label class="mc-modal-check">
        <input type="checkbox" name="subj" value="${s.id}"${current.includes(s.id) ? ' checked' : ''}>
        ${this._esc(s.name)}${s.isConceptual ? ' <em>(I·S·B·MB)</em>' : ''}
      </label>`).join('');

    this.showModal({
      title: 'Editar clase',
      body: `
        <label class="modal-label">Nombre de la clase</label>
        <input type="text" id="m-input" class="modal-input" value="${this._esc(course.name)}" autofocus>
        <label class="modal-label" style="margin-top:14px">Asignaturas</label>
        <div class="mc-modal-checks">${subjCheckboxes}</div>
        <label class="mc-modal-check" style="margin-top:8px">
          <input type="checkbox" id="m-taller"${course.hasTaller ? ' checked' : ''}> Tiene Taller JEC (bitácora)
        </label>`,
      confirm: 'Guardar',
      onConfirm: () => {
        const name = document.getElementById('m-input').value.trim();
        if (!name) { this.hideModal(); return; }
        const checked   = [...document.querySelectorAll('input[name="subj"]:checked')].map(el => el.value);
        const hasTaller = document.getElementById('m-taller')?.checked || false;
        course.name     = name;
        course.hasTaller = hasTaller;
        // Inicializar asignaturas nuevas que no existían
        const newSubjs = checked.filter(sId => !current.includes(sId));
        newSubjs.forEach(sId => {
          const isConc    = this._isConceptual(sId);
          const baseEvals = isConc ? ['C1','C2','C3','C4'] : ['N1','N2','N3'];
          if (!this.state.evaluations[cId][sId])
            this.state.evaluations[cId][sId] = { s1:[...baseEvals], s2:[...baseEvals] };
          if (!this.state.grades[cId][sId]) this.state.grades[cId][sId] = {};
          (this.state.students[cId] || []).forEach(st => {
            if (!this.state.grades[cId][sId][st.id])
              this.state.grades[cId][sId][st.id] = { s1:{}, s2:{} };
          });
        });
        this.state.courseSubjects[cId] = checked.length ? checked : [current[0] || 's1'];
        this.state.activeCourse  = cId;
        const validSubjs = this._courseSubjects(cId);
        this.state.activeSubject = validSubjs[0] || '__obs__';
        this.state.view = 'grades';
        this.save(); this.hideModal(); this.render();
        this.toast(`Clase "${name}" actualizada`);
      }
    });
  }

  _confirmDeleteCourse(cId) {
    const course = this.state.courses.find(c => c.id === cId);
    if (!course) return;
    const studentCount = (this.state.students[cId] || []).length;
    this.showModal({
      title: 'Eliminar clase',
      body: `<p class="confirm-message">¿Eliminar la clase <strong>${this._esc(course.name)}</strong>?<br><br>
             Se perderán <strong>${studentCount} alumno${studentCount !== 1 ? 's' : ''}</strong> y todas sus calificaciones, observaciones y datos.<br>
             Esta acción no se puede deshacer.</p>`,
      confirm: 'Eliminar', confirmDanger: true,
      onConfirm: () => {
        this.state.courses = this.state.courses.filter(c => c.id !== cId);
        delete this.state.courseSubjects[cId];
        delete this.state.students[cId];
        delete this.state.grades[cId];
        delete this.state.evaluations[cId];
        delete this.state.taller[cId];
        delete this.state.observations[cId];
        if (this.state.activeCourse === cId)
          this.state.activeCourse = this.state.courses[0]?.id || null;
        this.save(); this.hideModal(); this.render();
        this.toast(`Clase "${course.name}" eliminada`);
      }
    });
  }

  _promptAddSubject() {
    const { courses } = this.state;
    const courseChecks = courses.length ? `
      <label class="modal-label" style="margin-top:14px">Asignar a clases</label>
      <div class="mc-modal-checks">
        ${courses.map(c => `
          <label class="mc-modal-check">
            <input type="checkbox" name="asign-course" value="${c.id}" checked>
            ${this._esc(c.name)}
          </label>`).join('')}
      </div>` : '';

    this.showModal({
      title: 'Nueva asignatura',
      body: `
        <label class="modal-label">Nombre de la asignatura</label>
        <input type="text" id="m-input" class="modal-input" placeholder="Ej: Matemática" autofocus>
        <label class="mc-modal-check" style="margin-top:12px">
          <input type="checkbox" id="m-conc"> Calificación conceptual (I / S / B / MB)
        </label>
        <div class="modal-hint" style="margin-top:6px">Si no marcas esta opción, las notas serán numéricas (2.0 – 7.0).</div>
        ${courseChecks}`,
      confirm: 'Crear',
      onConfirm: () => {
        const name = document.getElementById('m-input').value.trim();
        if (!name) return;
        const isConceptual = document.getElementById('m-conc')?.checked || false;
        const id = `s_${Date.now()}`;
        this.state.subjects.push({ id, name, isConceptual });
        const baseEvals = isConceptual ? ['C1','C2','C3','C4'] : ['N1','N2','N3'];
        const assignTo = [...document.querySelectorAll('input[name="asign-course"]:checked')].map(el => el.value);
        assignTo.forEach(cId => {
          if (!this.state.courseSubjects[cId]) this.state.courseSubjects[cId] = [];
          if (!this.state.courseSubjects[cId].includes(id))
            this.state.courseSubjects[cId].push(id);
          if (!this.state.evaluations[cId][id])
            this.state.evaluations[cId][id] = { s1:[...baseEvals], s2:[...baseEvals] };
          if (!this.state.grades[cId][id]) this.state.grades[cId][id] = {};
          (this.state.students[cId] || []).forEach(st => {
            if (!this.state.grades[cId][id][st.id])
              this.state.grades[cId][id][st.id] = { s1:{}, s2:{} };
          });
        });
        this.save(); this.hideModal(); this.render();
        this.toast(`Asignatura "${name}" creada`);
      }
    });
  }

  _promptAssignSubject(sId) {
    const subj = this.state.subjects.find(s => s.id === sId);
    if (!subj) return;
    const { courses } = this.state;
    if (!courses.length) { this.toast('No hay cursos aún'); return; }
    this.showModal({
      title: `Asignar "${subj.name}" a clases`,
      body: `
        <label class="modal-label">Selecciona los cursos</label>
        <div class="mc-modal-checks">
          ${courses.map(c => {
            const already = (this.state.courseSubjects[c.id] || []).includes(sId);
            return `<label class="mc-modal-check">
              <input type="checkbox" name="asign-course" value="${c.id}"${already ? ' checked' : ''}>
              ${this._esc(c.name)}${already ? ' <em style="color:var(--accent-muted)">(ya asignada)</em>' : ''}
            </label>`;
          }).join('')}
        </div>`,
      confirm: 'Asignar',
      onConfirm: () => {
        const baseEvals = subj.isConceptual ? ['C1','C2','C3','C4'] : ['N1','N2','N3'];
        const assignTo = [...document.querySelectorAll('input[name="asign-course"]:checked')].map(el => el.value);
        assignTo.forEach(cId => {
          if (!this.state.courseSubjects[cId]) this.state.courseSubjects[cId] = [];
          if (!this.state.courseSubjects[cId].includes(sId))
            this.state.courseSubjects[cId].push(sId);
          if (!this.state.evaluations[cId][sId])
            this.state.evaluations[cId][sId] = { s1:[...baseEvals], s2:[...baseEvals] };
          if (!this.state.grades[cId][sId]) this.state.grades[cId][sId] = {};
          (this.state.students[cId] || []).forEach(st => {
            if (!this.state.grades[cId][sId][st.id])
              this.state.grades[cId][sId][st.id] = { s1:{}, s2:{} };
          });
        });
        this.save(); this.hideModal(); this.render();
        this.toast(`"${subj.name}" asignada a ${assignTo.length} clase${assignTo.length !== 1 ? 's' : ''}`);
      }
    });
  }

  _promptEditSubject(sId) {
    const subj = this.state.subjects.find(s => s.id === sId);
    if (!subj) return;
    this.showModal({
      title: 'Editar asignatura',
      body: `
        <label class="modal-label">Nombre</label>
        <input type="text" id="m-input" class="modal-input" value="${this._esc(subj.name)}" autofocus>
        <label class="mc-modal-check" style="margin-top:12px">
          <input type="checkbox" id="m-conc"${subj.isConceptual ? ' checked' : ''}> Calificación conceptual (I / S / B / MB)
        </label>`,
      confirm: 'Guardar',
      onConfirm: () => {
        const name = document.getElementById('m-input').value.trim();
        if (!name) { this.hideModal(); return; }
        subj.name = name;
        subj.isConceptual = document.getElementById('m-conc')?.checked || false;
        this.save(); this.hideModal(); this.render();
        this.toast('Asignatura actualizada');
      }
    });
  }

  _confirmDeleteSubject(sId) {
    const subj = this.state.subjects.find(s => s.id === sId);
    if (!subj) return;
    const usedIn = this.state.courses.filter(c => this._courseSubjects(c.id).includes(sId)).map(c => c.name);
    const warnText = usedIn.length
      ? `<br><br>⚠ Está asignada a: <strong>${usedIn.join(', ')}</strong>. Se perderán todas sus calificaciones.`
      : '';
    this.showModal({
      title: 'Eliminar asignatura',
      body: `<p class="confirm-message">¿Eliminar la asignatura <strong>${this._esc(subj.name)}</strong>?${warnText}</p>`,
      confirm: 'Eliminar', confirmDanger: true,
      onConfirm: () => {
        // Quitar de courseSubjects y datos de grades/evaluations
        this.state.courses.forEach(c => {
          this.state.courseSubjects[c.id] = (this.state.courseSubjects[c.id] || []).filter(id => id !== sId);
          delete this.state.grades[c.id]?.[sId];
          delete this.state.evaluations[c.id]?.[sId];
        });
        this.state.subjects = this.state.subjects.filter(s => s.id !== sId);
        // Si el activeSubject era esta asignatura, resetear
        if (this.state.activeSubject === sId)
          this.state.activeSubject = this._courseSubjects(this.state.activeCourse)[0] || null;
        this.save(); this.hideModal(); this.render();
        this.toast(`Asignatura "${subj.name}" eliminada`);
      }
    });
  }

  // ── Backup ───────────────────────────────────────────────────────────────────

  _exportBackup() {
    const data = localStorage.getItem(STORE_KEY);
    if (!data) { this.toast('No hay datos para respaldar', 'warn'); return; }
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: `LibroNotas_respaldo_${date}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
    localStorage.setItem(BACKUP_KEY, date);
    this._refreshBackupBanner();
    this.showModal({
      title: 'Respaldo descargado ✓',
      body: `
        <p class="confirm-message" style="margin-bottom:14px">
          El archivo <strong>LibroNotas_respaldo_${date}.json</strong> fue guardado en tu carpeta de <strong>Descargas</strong>.
        </p>
        <div class="backup-help-steps">
          <div class="backup-help-step">
            <span class="backup-help-num">1</span>
            <span>Busca el archivo en <strong>Descargas</strong> de tu computador.</span>
          </div>
          <div class="backup-help-step">
            <span class="backup-help-num">2</span>
            <span>Muévelo a un lugar seguro: una carpeta en <strong>Google Drive</strong>, <strong>OneDrive</strong>, o un pendrive.</span>
          </div>
          <div class="backup-help-step">
            <span class="backup-help-num">3</span>
            <span>Si alguna vez pierdes los datos, usa el botón <strong>Restaurar</strong> y selecciona ese archivo.</span>
          </div>
        </div>`,
      confirm: 'Entendido',
      onConfirm: () => this.hideModal(),
    });
  }

  _showBackupHelp() {
    this.showModal({
      title: '¿Cómo funciona el respaldo?',
      body: `
        <div class="backup-help-steps">
          <div class="backup-help-step">
            <span class="backup-help-num">📁</span>
            <span><strong>¿Qué se descarga?</strong><br>
            Un archivo llamado <em>LibroNotas_respaldo_FECHA.json</em> que contiene todos tus datos: alumnos, notas, evaluaciones y observaciones.</span>
          </div>
          <div class="backup-help-step">
            <span class="backup-help-num">💾</span>
            <span><strong>¿Dónde queda?</strong><br>
            En la carpeta <strong>Descargas</strong> de tu computador. Se recomienda moverlo después a <strong>Google Drive</strong> o <strong>OneDrive</strong> para mayor seguridad.</span>
          </div>
          <div class="backup-help-step">
            <span class="backup-help-num">🔄</span>
            <span><strong>¿Cómo restauro si pierdo los datos?</strong><br>
            Abre la app, haz clic en <strong>Restaurar</strong>, selecciona el archivo .json y confirma. En segundos tienes todo de vuelta.</span>
          </div>
          <div class="backup-help-step">
            <span class="backup-help-num">💻</span>
            <span><strong>¿Funciona en otro computador o navegador?</strong><br>
            Sí. Copia el archivo al otro equipo (por pendrive o Google Drive), abre la app y usa <strong>Restaurar</strong>.</span>
          </div>
          <div class="backup-help-step">
            <span class="backup-help-num">⚠</span>
            <span><strong>¿Qué pasa si no tengo respaldo y borro el historial?</strong><br>
            Los datos se pierden sin recuperación posible. Por eso es importante crear respaldo cada vez que hagas cambios importantes.</span>
          </div>
        </div>`,
      confirm: 'Entendido',
      onConfirm: () => this.hideModal(),
    });
  }

  _importBackup() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          if (!parsed || typeof parsed !== 'object' || (!parsed.students && !parsed.grades)) {
            this.toast('Archivo inválido: no parece un respaldo del Libro de Notas', 'warn');
            return;
          }
          this.showModal({
            title: 'Restaurar respaldo',
            body: `<p class="confirm-message">¿Restaurar el archivo <strong>${this._esc(file.name)}</strong>?<br><br>
                   <strong>Se reemplazarán todos los datos actuales.</strong><br>
                   Esta acción no se puede deshacer.</p>`,
            confirm: 'Restaurar', confirmDanger: true,
            onConfirm: () => {
              localStorage.setItem(STORE_KEY, ev.target.result);
              this.hideModal();
              this.load();
              this.render();
              this.toast('Respaldo restaurado correctamente ✓');
            }
          });
        } catch {
          this.toast('Error al leer el archivo. Verifica que sea un respaldo válido.', 'warn');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  _getDaysSinceBackup() {
    const last = localStorage.getItem(BACKUP_KEY);
    if (!last) return null;
    const diff = Date.now() - new Date(last).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  _renderRenewalBanner() {
    const match = (this.state.activationCode || '').match(/LIBRO-(\d{4})-/);
    if (!match) return '';
    const year = parseInt(match[1], 10);
    const now = new Date();
    const soonFrom = new Date(year, 11, 1);   // 1 dic — empieza el recordatorio
    const expiredAt = new Date(year, 11, 31); // 31 dic — año escolar terminado
    if (now < soonFrom) return '';

    const waText = encodeURIComponent(`Hola, quiero renovar mi Libro Digital de Notas para el próximo año escolar. Mi código actual es: ${this.state.activationCode}`);
    const waLink = `https://wa.me/56982857408?text=${waText}`;

    if (now > expiredAt) {
      return `<div class="renewal-banner" id="renewal-banner">
        <span class="renewal-banner-msg">📅 Tu acceso del año escolar ${year} ya terminó. Puedes seguir usando la app, pero te recomendamos renovar para el próximo año.</span>
        <a href="${waLink}" target="_blank" class="renewal-banner-btn">Renovar por WhatsApp</a>
        <button class="renewal-banner-close" data-action="dismiss-renewal-banner" title="Cerrar">×</button>
      </div>`;
    }
    return `<div class="renewal-banner" id="renewal-banner">
      <span class="renewal-banner-msg">📅 Tu acceso del año escolar ${year} está por terminar.</span>
      <a href="${waLink}" target="_blank" class="renewal-banner-btn">Renovar por WhatsApp</a>
      <button class="renewal-banner-close" data-action="dismiss-renewal-banner" title="Cerrar">×</button>
    </div>`;
  }

  _renderBackupBanner() {
    const last = localStorage.getItem(BACKUP_KEY);
    const days = this._getDaysSinceBackup();
    if (last === null) {
      return `<div class="backup-banner" id="backup-banner">
        <span class="backup-banner-msg">⚠ Sin respaldo guardado — si borras el historial del navegador perderás todos tus datos.</span>
        <button class="backup-banner-btn" data-action="export-backup">Crear respaldo ahora</button>
        <button class="backup-banner-close" data-action="dismiss-backup-banner" title="Cerrar">×</button>
      </div>`;
    }
    if (days >= BACKUP_WARNING_DAYS) {
      return `<div class="backup-banner" id="backup-banner">
        <span class="backup-banner-msg">⚠ Último respaldo hace <strong>${days} días</strong>. Recuerda guardar una copia actualizada.</span>
        <button class="backup-banner-btn" data-action="export-backup">Actualizar respaldo</button>
        <button class="backup-banner-close" data-action="dismiss-backup-banner" title="Cerrar">×</button>
      </div>`;
    }
    return '';
  }

  _refreshBackupBanner() {
    const existing = document.getElementById('backup-banner');
    const newBanner = this._renderBackupBanner();
    if (existing) {
      if (newBanner) {
        const t = document.createElement('template');
        t.innerHTML = newBanner;
        existing.replaceWith(t.content.firstElementChild);
      } else {
        existing.remove();
      }
    }
    // Actualizar estado en sidebar
    const statusEl = document.querySelector('.sb-backup-status');
    if (statusEl) {
      const days = this._getDaysSinceBackup();
      statusEl.className = 'sb-backup-status sb-backup-ok';
      statusEl.textContent = 'Respaldo de hoy ✓';
      if (days === null) { statusEl.className = 'sb-backup-status sb-backup-never'; statusEl.textContent = 'Sin respaldo — datos en riesgo'; }
      else if (days >= BACKUP_WARNING_DAYS) { statusEl.className = 'sb-backup-status sb-backup-warn'; statusEl.textContent = `Respaldo hace ${days} día${days !== 1 ? 's' : ''}`; }
    }
  }

  // ── Asistencia ───────────────────────────────────────────────────────────────

  _addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return dt.toISOString().slice(0, 10);
  }

  _formatDateLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-CL', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
  }

  _getAttStats(cId, stId) {
    const att = this.state.attendance?.[cId] || {};
    let total = 0, present = 0;
    Object.values(att).forEach(day => {
      const s = day[stId];
      if (s) { total++; if (s !== 'A') present++; }
    });
    return { total, pct: total > 0 ? Math.round((present / total) * 100) : null };
  }

  renderAsistencia() {
    const { activeCourse: cId, attendanceDate } = this.state;
    const course   = this.state.courses.find(c => c.id === cId);
    const students = this.state.students[cId] || [];
    const today    = new Date().toISOString().slice(0, 10);
    const date     = attendanceDate || today;
    const att      = this.state.attendance?.[cId]?.[date] || {};

    const counts = { P: 0, A: 0, AT: 0, J: 0, sin: 0 };
    students.forEach(st => {
      const s = att[st.id];
      if (s === 'P') counts.P++;
      else if (s === 'A') counts.A++;
      else if (s === 'AT') counts.AT++;
      else if (s === 'J') counts.J++;
      else counts.sin++;
    });

    const prev     = this._addDays(date, -1);
    const next     = this._addDays(date, 1);
    const isToday  = date === today;
    const isFuture = date > today;

    const ATT_LABEL = { P: 'Presente', A: 'Ausente', AT: 'Atraso', J: 'Justificado' };
    const recorded  = students.length - counts.sin;

    const rows = students.length ? students.map(st => {
      const s     = att[st.id] || '';
      const stats = this._getAttStats(cId, st.id);
      return `
        <div class="att-row">
          <span class="att-name">${this._esc(st.name)}</span>
          <button class="att-btn att-s-${s || 'none'}"
                  data-action="toggle-attendance"
                  data-student="${st.id}" data-date="${date}"
                  title="${ATT_LABEL[s] || 'Sin registrar — clic para marcar'}">
            ${s || '—'}
          </button>
          <span class="att-pct">${stats.pct !== null ? stats.pct + '%' : ''}</span>
        </div>`;
    }).join('') : `<div class="att-empty">Sin alumnos en este curso.</div>`;

    const summaryBar = recorded === 0
      ? `<div class="att-summary-bar"><span class="att-sum-empty">Sin registros para este día · clic en cada alumno para marcar</span></div>`
      : `<div class="att-summary-bar">
           ${counts.P  ? `<span class="att-sum att-sum-p">${counts.P}&nbsp;P</span>` : ''}
           ${counts.A  ? `<span class="att-sum att-sum-a">${counts.A}&nbsp;A</span>` : ''}
           ${counts.AT ? `<span class="att-sum att-sum-at">${counts.AT}&nbsp;AT</span>` : ''}
           ${counts.J  ? `<span class="att-sum att-sum-j">${counts.J}&nbsp;J</span>` : ''}
           ${counts.sin ? `<span class="att-sum att-sum-sin">${counts.sin} sin registrar</span>` : ''}
         </div>`;

    return `
      <div class="topbar">
        <div class="breadcrumb">
          <span class="bc-course">${this._esc(course.name)}</span>
          <span class="bc-sep">›</span>
          <span class="bc-subject">${this._icon('attendance')} Asistencia</span>
        </div>
        <div class="topbar-actions">
          <button class="btn-add btn-add-secondary" data-action="mark-all-present" data-date="${date}">✓ Todos Presente</button>
          ${recorded > 0 ? `<button class="btn-add btn-add-secondary" data-action="export-attendance">${this._icon('download')} Exportar</button>` : ''}
        </div>
      </div>

      <div class="att-wrap">
        <div class="att-date-nav">
          <button class="att-nav-btn" data-action="att-nav-day" data-date="${prev}">‹</button>
          <div class="att-date-info">
            <span class="att-date-label">${this._formatDateLabel(date)}</span>
            ${isToday ? '<span class="att-today-badge">Hoy</span>' : ''}
          </div>
          <button class="att-nav-btn" data-action="att-nav-day" data-date="${next}"${isFuture ? ' disabled' : ''}>›</button>
        </div>
        ${summaryBar}
        <div class="att-students">${rows}</div>
        <div class="att-legend">
          <span class="att-leg att-s-P">P = Presente</span>
          <span class="att-leg att-s-A">A = Ausente</span>
          <span class="att-leg att-s-AT">AT = Atraso</span>
          <span class="att-leg att-s-J">J = Justificado</span>
          <span class="att-leg-hint">% = asistencia anual (sin A)</span>
        </div>
      </div>`;
  }

  _toggleAttendance(stId, date) {
    const cId   = this.state.activeCourse;
    const cycle = { '': 'P', P: 'A', A: 'AT', AT: 'J', J: '' };
    if (!this.state.attendance[cId])       this.state.attendance[cId]       = {};
    if (!this.state.attendance[cId][date]) this.state.attendance[cId][date] = {};
    const current = this.state.attendance[cId][date][stId] || '';
    const next    = cycle[current];
    if (next === '') {
      delete this.state.attendance[cId][date][stId];
      if (!Object.keys(this.state.attendance[cId][date]).length)
        delete this.state.attendance[cId][date];
    } else {
      this.state.attendance[cId][date][stId] = next;
    }
    this.save();
    // Refresh solo la fila afectada para no re-renderizar todo
    this.render();
  }

  _markAllPresent(date) {
    const cId      = this.state.activeCourse;
    const students = this.state.students[cId] || [];
    if (!students.length) return;
    if (!this.state.attendance[cId])       this.state.attendance[cId]       = {};
    if (!this.state.attendance[cId][date]) this.state.attendance[cId][date] = {};
    students.forEach(st => { this.state.attendance[cId][date][st.id] = 'P'; });
    this.save(); this.render();
    this.toast(`${students.length} alumnos marcados como Presentes`);
  }

  _exportAttendanceCSV() {
    const cId     = this.state.activeCourse;
    const course  = this.state.courses.find(c => c.id === cId);
    const students = this.state.students[cId] || [];
    const att      = this.state.attendance?.[cId] || {};
    const dates    = Object.keys(att).sort();
    if (!dates.length) { this.toast('Sin registros de asistencia para exportar'); return; }
    const esc = v => v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    const header = ['Alumno', ...dates].join(',');
    const rows   = students.map(st => [esc(st.name), ...dates.map(d => att[d]?.[st.id] || '')].join(','));
    const csv    = [header, ...rows].join('\n');
    const blob   = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href = url; a.download = `asistencia_${(course?.name || cId).replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  // ── Google Drive ─────────────────────────────────────────────────────────────

  _gdriveGetStored() {
    try { return JSON.parse(localStorage.getItem(GDRIVE_TOKEN_KEY) || 'null'); } catch { return null; }
  }
  _gdriveSaveStored(data) {
    localStorage.setItem(GDRIVE_TOKEN_KEY, JSON.stringify(data));
  }
  _gdriveClearStored() {
    localStorage.removeItem(GDRIVE_TOKEN_KEY);
  }
  _gdriveTokenValid() {
    const t = this._gdriveGetStored();
    return !!(t?.access_token && Date.now() < t.expiry);
  }

  _formatRelativeDate(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 2)   return 'hace un momento';
    if (m < 60)  return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24)  return `hace ${h}h`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'ayer' : `hace ${d} días`;
  }

  _renderDriveSection() {
    const stored = this._gdriveGetStored();
    const valid  = this._gdriveTokenValid();

    if (!valid) {
      const wasConnected = !!(stored?.wasConnected);
      return `
        <div class="sb-drive-section">
          <button class="sb-btn sb-btn-drive" data-action="gdrive-connect">
            ${this._icon('drive')} ${wasConnected ? 'Reconectar Drive' : 'Conectar Google Drive'}
          </button>
        </div>`;
    }

    const email    = stored.email ? `<span class="sb-drive-email">${this._esc(stored.email)}</span>` : '';
    const syncText = stored.lastSync
      ? `Sync ${this._formatRelativeDate(stored.lastSync)}`
      : 'Sin sincronización aún';

    return `
      <div class="sb-drive-section sb-drive-connected">
        <div class="sb-drive-header">
          ${this._icon('drive')}
          <div class="sb-drive-info">
            <span class="sb-drive-title">Google Drive</span>
            ${email}
          </div>
          <button class="sb-drive-disconnect" data-action="gdrive-disconnect" title="Desconectar">×</button>
        </div>
        <div class="sb-drive-sync-label">${this._esc(syncText)}</div>
        <div class="sb-drive-actions">
          <button class="sb-btn sb-btn-drive-save" data-action="gdrive-save">↑ Guardar</button>
          <button class="sb-btn sb-btn-drive-load" data-action="gdrive-load">↓ Restaurar</button>
        </div>
      </div>`;
  }

  _gdriveConnect() {
    if (!window.google?.accounts?.oauth2) {
      this.toast('La librería de Google no está disponible. Verifica tu conexión.');
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GDRIVE_CLIENT_ID,
      scope:     GDRIVE_SCOPE,
      callback:  async (resp) => {
        if (resp.error) { this.toast('Error al conectar con Google'); return; }
        let email = '';
        try {
          const info = await fetch(
            `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${resp.access_token}`
          ).then(r => r.json());
          email = info.email || '';
        } catch { /* email stays empty */ }
        this._gdriveSaveStored({
          access_token: resp.access_token,
          expiry:       Date.now() + (parseInt(resp.expires_in) - 60) * 1000,
          email,
          wasConnected: true,
        });
        this.render();
        this.toast('Google Drive conectado ✓');
      },
    });
    // Try silent reconnect if was previously connected
    const stored = this._gdriveGetStored();
    client.requestAccessToken({ prompt: stored?.wasConnected ? '' : 'consent' });
  }

  _gdriveDisconnect() {
    this.showModal({
      title: 'Desconectar Google Drive',
      body:  `<p class="confirm-message">¿Desconectar Google Drive? Tus datos no se eliminarán de Drive. Siempre podrás volver a conectar.</p>`,
      confirm: 'Desconectar',
      onConfirm: () => {
        const stored = this._gdriveGetStored();
        if (stored?.access_token && window.google?.accounts?.oauth2) {
          try { google.accounts.oauth2.revoke(stored.access_token); } catch { /* ok */ }
        }
        this._gdriveClearStored();
        this.hideModal();
        this.render();
        this.toast('Google Drive desconectado');
      }
    });
  }

  async _gdriveSave() {
    if (!this._gdriveTokenValid()) { this._gdriveConnect(); return; }
    const token   = this._gdriveGetStored().access_token;
    const payload = JSON.stringify(this.state, null, 2);
    this.toast('Guardando en Google Drive…');
    try {
      // Buscar archivo existente
      const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D'${GDRIVE_FILE_NAME}'&fields=files(id)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { files } = await searchRes.json();
      const fileId = files?.[0]?.id || null;

      // Multipart body
      const boundary = 'lb_gdrive_boundary';
      const meta     = JSON.stringify({ name: GDRIVE_FILE_NAME, ...(fileId ? {} : { parents: ['appDataFolder'] }) });
      const body     = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;

      const url    = fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
      const method = fileId ? 'PATCH' : 'POST';

      const uploadRes = await fetch(url, {
        method,
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      if (!uploadRes.ok) throw new Error(uploadRes.statusText);

      const stored = this._gdriveGetStored();
      stored.lastSync = Date.now();
      this._gdriveSaveStored(stored);
      this.render();
      this.toast('Guardado en Google Drive ✓');
    } catch (err) {
      this.toast('Error al guardar en Drive. Intenta reconectar.');
      console.error('[Drive save]', err);
    }
  }

  async _gdriveLoad() {
    if (!this._gdriveTokenValid()) { this._gdriveConnect(); return; }
    const token = this._gdriveGetStored().access_token;
    try {
      const searchRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name%3D'${GDRIVE_FILE_NAME}'&fields=files(id,modifiedTime)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { files } = await searchRes.json();
      const file = files?.[0];
      if (!file) { this.toast('No hay respaldo en Google Drive todavía'); return; }

      const modLabel = new Date(file.modifiedTime).toLocaleDateString('es-CL', {
        day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });

      this.showModal({
        title: 'Restaurar desde Google Drive',
        body:  `<p class="confirm-message">Se restaurará el respaldo del <strong>${modLabel}</strong>.<br><br>Esto reemplazará <em>todos</em> los datos actuales. ¿Continuar?</p>`,
        confirm: 'Restaurar', confirmDanger: true,
        onConfirm: async () => {
          try {
            const fileRes = await fetch(
              `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            const restored = await fileRes.json();
            this.state = restored;
            this.save();
            this.hideModal();
            this.render();
            this.toast('Datos restaurados desde Google Drive ✓');
          } catch {
            this.toast('Error al restaurar desde Drive');
          }
        }
      });
    } catch {
      this.toast('Error al conectar con Google Drive. Intenta reconectar.');
    }
  }

  // ── Colegio editable ─────────────────────────────────────────────────────────

  _renderSchoolBrand() {
    const { schoolName, schoolPlace, schoolLogo } = this.state;
    const isNew = !schoolName && !schoolLogo;

    if (isNew) {
      return `
        <div class="sb-school-brand sb-school-editable" data-action="edit-school" title="Agregar logo y nombre del colegio">
          <span class="sb-school-add-hint">＋ Agregar mi colegio</span>
        </div>`;
    }

    const logoHtml = schoolLogo
      ? `<img src="${schoolLogo}" alt="Logo colegio" class="sb-school-logo">`
      : `<div class="sb-school-fallback" style="display:flex">
           <svg width="22" height="22" viewBox="0 0 22 22" fill="none" style="opacity:.7">
             <path d="M11 2L3 7v1h16V7L11 2z" stroke="white" stroke-width="1.4" stroke-linejoin="round"/>
             <rect x="5" y="8" width="12" height="12" rx="1" stroke="white" stroke-width="1.4"/>
             <rect x="8" y="13" width="3" height="7" fill="white" opacity=".5"/>
             <rect x="11" y="13" width="3" height="7" fill="white" opacity=".5"/>
           </svg>
         </div>`;

    return `
      <div class="sb-school-brand sb-school-editable" data-action="edit-school" title="Editar información del colegio">
        <div class="sb-school-logo-wrap">
          ${logoHtml}
          <div class="sb-school-edit-overlay">✎</div>
        </div>
        <div class="sb-school-info">
          <span class="sb-school-name">${this._esc(schoolName)}</span>
          ${schoolPlace ? `<span class="sb-school-place">${this._esc(schoolPlace)}</span>` : ''}
        </div>
      </div>`;
  }

  _promptEditSchool() {
    const { schoolName, schoolPlace, schoolLogo } = this.state;
    this.showModal({
      title: 'Información del colegio',
      body: `
        <label class="modal-label">Nombre del colegio</label>
        <input type="text" id="m-school-name" class="modal-input" value="${this._esc(schoolName || '')}" placeholder="Ej: Escuela José Martínez" autofocus>
        <label class="modal-label" style="margin-top:12px">Localidad o ciudad</label>
        <input type="text" id="m-school-place" class="modal-input" value="${this._esc(schoolPlace || '')}" placeholder="Ej: Santiago">
        <label class="modal-label" style="margin-top:12px">Logo del colegio</label>
        ${schoolLogo
          ? `<div style="margin-bottom:8px"><img src="${schoolLogo}" style="height:52px;border-radius:8px;border:1px solid var(--border)"></div>
             <label class="mc-modal-check" style="margin-bottom:8px"><input type="checkbox" id="m-logo-clear"> Eliminar logo actual</label>`
          : `<div class="modal-hint" style="margin-bottom:6px">JPG o PNG, máximo 1 MB.</div>`}
        <input type="file" id="m-school-logo" accept="image/*" class="modal-file">`,
      confirm: 'Guardar',
      onConfirm: () => {
        const name   = document.getElementById('m-school-name')?.value.trim()  || null;
        const place  = document.getElementById('m-school-place')?.value.trim() || null;
        const clear  = document.getElementById('m-logo-clear')?.checked || false;
        const file   = document.getElementById('m-school-logo')?.files?.[0];
        this.state.schoolName  = name;
        this.state.schoolPlace = place;
        if (clear) this.state.schoolLogo = null;
        if (file) {
          if (file.size > 1024 * 1024) {
            this.toast('Imagen demasiado grande — máximo 1 MB'); return;
          }
          const reader = new FileReader();
          reader.onload = ev => {
            this.state.schoolLogo = ev.target.result;
            this.save(); this.hideModal(); this.render();
            this.toast('Información del colegio guardada');
          };
          reader.readAsDataURL(file);
        } else {
          this.save(); this.hideModal(); this.render();
          this.toast('Información del colegio guardada');
        }
      }
    });
  }

  // ── Recordatorios ────────────────────────────────────────────────────────────

  renderRecordatorios() {
    const reminders = this.state.reminders || [];
    const pending   = reminders.filter(r => !r.done);
    const done      = reminders.filter(r =>  r.done);

    const renderItem = r => {
      const displayCourse = r.courseName || (r.courseId ? this.state.courses.find(c => c.id === r.courseId)?.name : null);
      return `
        <div class="rec-item${r.done ? ' rec-done' : ''}">
          <button class="rec-check${r.done ? ' rec-check-done' : ''}" data-action="toggle-reminder" data-id="${r.id}" title="${r.done ? 'Marcar pendiente' : 'Marcar como hecho'}">
            ${r.done ? '✓' : ''}
          </button>
          <div class="rec-content">
            <span class="rec-text">${this._esc(r.text)}</span>
            ${displayCourse ? `<span class="rec-course-tag" style="font-size:0.75rem;background:#1e3a5f;color:#fff;border-radius:99px;padding:2px 9px;margin-left:4px;opacity:0.85">${this._esc(displayCourse)}</span>` : ''}
          </div>
          <button class="rec-del" data-action="del-reminder" data-id="${r.id}" title="Eliminar">×</button>
        </div>`;
    };

    return `
      <div class="topbar">
        <div class="breadcrumb"><span class="bc-overview">Recordatorios</span></div>
        <div class="topbar-actions">
          <button class="btn-add" data-action="add-reminder">+ Nuevo recordatorio</button>
        </div>
      </div>
      <div class="rec-wrap">
        ${!reminders.length
          ? `<div class="rec-empty">Sin recordatorios. Haz clic en <strong>+ Nuevo recordatorio</strong> para agregar uno.</div>`
          : ''}
        ${pending.length ? `
          <div class="rec-section-label">Pendientes · ${pending.length}</div>
          ${pending.map(renderItem).join('')}` : ''}
        ${done.length ? `
          <div class="rec-section-label rec-section-done">Completados · ${done.length}</div>
          ${done.map(renderItem).join('')}` : ''}
      </div>`;
  }

  _promptAddReminder() {
    const { courses } = this.state;
    const courseOptions = courses.map(c =>
      `<option value="${c.id}">${this._esc(c.name)}</option>`).join('');

    this.showModal({
      title: 'Nuevo recordatorio',
      body: `
        <label class="modal-label">Recordatorio</label>
        <input type="text" id="m-input" class="modal-input" placeholder="Ej: Llevar prueba impresa a 3° Básico" autofocus>
        ${courseOptions ? `
          <label class="modal-label" style="margin-top:12px">Clase relacionada (opcional)</label>
          <select id="m-rec-course" class="modal-select">
            <option value="">Sin clase específica</option>
            ${courseOptions}
          </select>` : ''}`,
      confirm: 'Agregar',
      onConfirm: () => {
        const text = document.getElementById('m-input').value.trim();
        if (!text) { this.hideModal(); return; }
        const courseId   = document.getElementById('m-rec-course')?.value || null;
        const courseName = courseId ? (this.state.courses.find(c => c.id === courseId)?.name || null) : null;
        if (!this.state.reminders) this.state.reminders = [];
        this.state.reminders.unshift({
          id: `r_${Date.now()}`,
          text,
          courseId:   courseId   || null,
          courseName: courseName || null,
          done: false,
          createdAt: Date.now()
        });
        this.save(); this.hideModal(); this.render();
        this.toast('Recordatorio agregado');
      }
    });
  }

  _toggleReminder(id) {
    const r = (this.state.reminders || []).find(r => r.id === id);
    if (r) { r.done = !r.done; this.save(); this.render(); }
  }

  _deleteReminder(id) {
    this.state.reminders = (this.state.reminders || []).filter(r => r.id !== id);
    this.save(); this.render();
  }

  _showRemindersPopup() {
    if (sessionStorage.getItem('recs_shown')) return;
    const pending = (this.state.reminders || []).filter(r => !r.done);
    if (!pending.length) return;
    sessionStorage.setItem('recs_shown', '1');
    const items = pending.map(r => {
      const course = r.courseId ? this.state.courses.find(c => c.id === r.courseId) : null;
      return `<li class="rec-popup-item">
        <span class="rec-popup-dot"></span>
        <span class="rec-popup-text">${this._esc(r.text)}</span>
        ${course ? `<span class="rec-popup-course">${this._esc(course.name)}</span>` : ''}
      </li>`;
    }).join('');
    this.showModal({
      title: `Tienes ${pending.length} recordatorio${pending.length !== 1 ? 's' : ''} pendiente${pending.length !== 1 ? 's' : ''}`,
      body: `<ul class="rec-popup-list">${items}</ul>
             <p class="modal-hint" style="margin-top:12px">Puedes gestionarlos desde <strong>Recordatorios</strong> en el menú lateral.</p>`,
      confirm: 'Entendido',
      onConfirm: () => this.hideModal()
    });
  }

  // ── Tour / Onboarding ────────────────────────────────────────────────────────

  _startTour() {
    if (this.state.onboardingDone) return;
    this._tourMode = 'fresh';
    this._tourStep = 0;
    this._tourSteps = [
      {
        target: null, position: 'center', isWelcome: true,
        title: '¡Bienvenido/a!',
        desc: '¿Cómo te llamas? Lo usaremos para personalizar tu libro.',
      },
      {
        target: null, position: 'center', isModePicker: true,
        title: '¿Cómo quieres empezar?',
        desc: 'Puedes comenzar desde cero o explorar la app con datos de ejemplo.',
      },
      {
        target: '.course-list', position: 'right',
        title: '📚 Tus cursos',
        desc: 'Haz clic en un curso para expandirlo y ver sus asignaturas.',
      },
      {
        target: '.subject-list', position: 'right',
        title: '📖 Asignaturas del curso',
        desc: 'Cada curso puede tener varias asignaturas. Haz clic en una para abrir el libro de notas.',
        action: () => {
          if (this.state.courses.length) {
            this.state.activeCourse = this.state.courses[0].id;
            this.render();
          }
        },
      },
      {
        target: '.table-wrap', position: 'right',
        title: '📝 Libro de notas',
        desc: 'Haz clic en cualquier celda para ingresar o editar una nota. Los promedios se calculan automáticamente.',
        action: () => {
          const c = this.state.courses[0];
          if (c) {
            const s = this._courseSubjects(c.id)[0];
            this.state.activeCourse  = c.id;
            this.state.activeSubject = s || '__obs__';
            this.state.view = 'grades';
            this.render();
          }
        },
      },
      {
        target: '.topbar-actions', position: 'bottom',
        title: '👥 Importar alumnos',
        desc: 'Importa tu lista desde Excel (copia y pega), agrega alumnos uno por uno, o copia la nómina de otro curso.',
      },
      {
        target: '.sb-btn-clases', position: 'right',
        title: '⚙️ Gestionar clases',
        desc: 'Crea y configura tus propios cursos y asignaturas. Aquí comienza todo.',
      },
      {
        target: null, position: 'center', isLast: true,
        title: '¡Todo listo para empezar!',
        desc: 'Comienza configurando tus cursos y luego importa tus alumnos. ¡Suerte!',
      },
    ];
    this._renderTourStep();
  }

  _renderTourStep() {
    document.getElementById('tour-overlay')?.remove();
    document.getElementById('tour-spotlight')?.remove();
    document.getElementById('tour-tooltip')?.remove();

    const step  = this._tourSteps[this._tourStep];
    const total = this._tourSteps.length;
    const isLast  = this._tourStep === total - 1;
    const isFirst = this._tourStep === 0;

    // Overlay (background only for steps without a spotlight)
    const overlay = document.createElement('div');
    overlay.id = 'tour-overlay';
    if (!step.target) overlay.style.background = 'rgba(0,0,0,0.65)';
    document.body.appendChild(overlay);

    // Spotlight + bounding rect
    let targetRect = null;
    if (step.target) {
      const el = document.querySelector(step.target);
      if (el) {
        targetRect = el.getBoundingClientRect();
        const spot = document.createElement('div');
        spot.id = 'tour-spotlight';
        spot.style.cssText = `top:${targetRect.top - 8}px;left:${targetRect.left - 8}px;` +
          `width:${targetRect.width + 16}px;height:${targetRect.height + 16}px`;
        document.body.appendChild(spot);
      }
    }

    // Progress dots
    const dots = Array.from({length: total}, (_, i) =>
      `<span class="tour-dot${i === this._tourStep ? ' tour-dot-on' : ''}"></span>`
    ).join('');

    // Body HTML
    let bodyHtml;
    if (step.isWelcome) {
      const savedName = (this.state.teacherName === 'Profesor/a de Historia') ? '' : (this.state.teacherName || '');
      bodyHtml = `
        <p class="tour-desc">${step.desc}</p>
        <label class="tour-label">Tu nombre</label>
        <input type="text" id="tour-name" class="tour-input" placeholder="Ej: María González" value="${this._esc(savedName)}">`;
    } else if (step.isModePicker) {
      bodyHtml = `
        <p class="tour-desc">${step.desc}</p>
        <div class="tour-modes">
          <label class="tour-mode">
            <input type="radio" name="tour-mode" value="fresh" checked>
            <div class="tour-mode-body">
              <strong>🗂️ Empezar desde cero</strong>
              <span>Sin datos de muestra. Tú defines todo.</span>
            </div>
          </label>
          <label class="tour-mode">
            <input type="radio" name="tour-mode" value="sample">
            <div class="tour-mode-body">
              <strong>👀 Explorar con ejemplos</strong>
              <span>Ver la app con alumnos y notas cargadas.</span>
            </div>
          </label>
        </div>`;
    } else {
      bodyHtml = `<p class="tour-desc">${step.desc}</p>`;
    }

    // Tooltip element
    const tip = document.createElement('div');
    tip.id = 'tour-tooltip';
    if (step.position === 'center') tip.classList.add('tour-centered');
    tip.innerHTML = `
      <div class="tour-body">
        <div class="tour-head">
          <div class="tour-dots">${dots}</div>
          <button id="tour-skip" class="tour-skip">✕ Saltar</button>
        </div>
        <h3 class="tour-title">${step.title}</h3>
        ${bodyHtml}
      </div>
      <div class="tour-nav">
        ${!isFirst ? '<button id="tour-prev" class="tour-btn-sec">← Atrás</button>' : '<span></span>'}
        <button id="tour-next" class="tour-btn-pri">${isLast ? '¡Comenzar! →' : 'Siguiente →'}</button>
      </div>`;
    document.body.appendChild(tip);

    // Position tooltip for non-center steps
    if (step.position !== 'center' && targetRect) {
      const pad = 18;
      const tw  = tip.offsetWidth  || 310;
      const th  = tip.offsetHeight || 180;
      const vw  = window.innerWidth;
      const vh  = window.innerHeight;
      let top, left;

      if (step.position === 'right') {
        left = targetRect.right + pad;
        top  = targetRect.top + targetRect.height / 2 - th / 2;
      } else if (step.position === 'bottom') {
        left = targetRect.left + targetRect.width / 2 - tw / 2;
        top  = targetRect.bottom + pad;
      } else if (step.position === 'left') {
        left = targetRect.left - tw - pad;
        top  = targetRect.top + targetRect.height / 2 - th / 2;
      }

      top  = Math.max(12, Math.min(top,  vh - th - 12));
      left = Math.max(12, Math.min(left, vw - tw - 12));
      tip.style.cssText += `top:${top}px;left:${left}px;`;
    }

    // Focus name input on welcome step
    if (step.isWelcome) setTimeout(() => document.getElementById('tour-name')?.focus(), 60);

    // Events
    document.getElementById('tour-next')?.addEventListener('click', () => {
      if (step.isWelcome) {
        const name = document.getElementById('tour-name')?.value.trim();
        if (name) { this.state.teacherName = name; this.save(); }
      }
      if (step.isModePicker) {
        this._tourMode = document.querySelector('input[name="tour-mode"]:checked')?.value || 'fresh';
      }
      if (isLast) { this._endTour(); return; }
      this._tourStep++;
      const next = this._tourSteps[this._tourStep];
      if (next.action) next.action();
      this._renderTourStep();
    });

    document.getElementById('tour-prev')?.addEventListener('click', () => {
      this._tourStep--;
      this._renderTourStep();
    });

    document.getElementById('tour-skip')?.addEventListener('click', () => this._endTour());
  }

  _endTour() {
    document.getElementById('tour-overlay')?.remove();
    document.getElementById('tour-spotlight')?.remove();
    document.getElementById('tour-tooltip')?.remove();

    if (this._tourMode === 'fresh') {
      this.state.courses.forEach(c => {
        this.state.students[c.id] = [];
        this._courseSubjects(c.id).forEach(sId => { this.state.grades[c.id][sId] = {}; });
      });
    }

    this.state.onboardingDone = true;
    this.state.view = 'clases';
    this.save();
    this.render();
    setTimeout(() => this.toast('¡Bienvenido/a! Configura tus cursos y luego importa tus alumnos.'), 300);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  _showActivation() {
    document.getElementById('app').innerHTML = `
      <div class="act-screen">
        <div class="act-card">
          <div class="act-logo">📒</div>
          <h1 class="act-title">Libro Digital de Notas</h1>
          <p class="act-sub">Ingresa tu código de acceso para continuar</p>
          <div class="act-form">
            <input id="act-input" class="act-input" type="text"
              placeholder="LIBRO-2026-XXXXX"
              autocomplete="off" autocapitalize="characters" spellcheck="false"
              maxlength="16">
            <button class="act-btn" data-action="activate">Activar →</button>
          </div>
          <div id="act-error" class="act-error"></div>
          <p class="act-contact">
            ¿No tienes código?
            <a href="https://wa.me/56982857408?text=Hola%2C%20quiero%20obtener%20el%20Libro%20Digital%20de%20Notas"
               target="_blank" class="act-wa">Escríbenos por WhatsApp →</a>
          </p>
        </div>
      </div>`;

    const input = document.getElementById('act-input');
    input.focus();
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.querySelector('[data-action="activate"]').click();
    });
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase();
      document.getElementById('act-error').textContent = '';
    });
  }

  async _validateActivation() {
    const input = document.getElementById('act-input');
    const btn   = document.querySelector('[data-action="activate"]');
    const err   = document.getElementById('act-error');
    const code  = (input?.value || '').trim().toUpperCase();

    if (!code) {
      if (err) err.textContent = 'Ingresa tu código de acceso.';
      input?.focus();
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Activando...'; }
    if (err) err.textContent = '';

    let result;
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
      const { data, error } = await Promise.race([sb.rpc('activar_codigo', { p_codigo: code }), timeout]);
      if (error) throw error;
      result = data;
    } catch {
      if (err) err.textContent = 'No pudimos conectar para validar tu código. Revisa tu internet e intenta de nuevo.';
      if (btn) { btn.disabled = false; btn.textContent = 'Activar →'; }
      return;
    }

    if (!result?.ok) {
      if (err) {
        err.textContent = result?.error === 'revocado'
          ? 'Este código fue revocado. Escríbenos por WhatsApp si crees que es un error.'
          : 'Código inválido. Verifica que esté escrito correctamente.';
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Activar →'; }
      input?.focus();
      return;
    }

    this.state.activated     = true;
    this.state.activationCode = code;
    this.save();
    this.render();
    this._startTour();
  }

  init() {
    this.load();
    this._bindAll();
    if (!this.state.activated) {
      this._showActivation();
      return;
    }
    this.render();
    this._startTour();
    if (this.state.onboardingDone) this._showRemindersPopup();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.gb = new GradeBook();
  window.gb.init();
});
