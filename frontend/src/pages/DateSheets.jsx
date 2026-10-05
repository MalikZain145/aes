import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CalendarClock, FileText, Download, Loader2, Sparkles, CheckCircle2,
  CalendarDays, Clock, BookMarked, X, Plus, Layers, GitMerge, Trash2,
  Database, Upload, FileSpreadsheet, AlertCircle, Pencil, Search, MinusCircle, Building2,
} from 'lucide-react';
import api, { errMsg } from '../api/client';
import { useToast } from '../context/ToastContext';
import { PageHeader, Modal } from '../components/ui';
import { downloadFile } from '../api/download';
import './generate.css';
import './datesheet.css';

const SEMESTERS = ['Spring', 'Summer', 'Fall'];
const LEVELS = ['Undergraduate', 'Postgraduate'];

// Friendly names for course-code prefixes (departments). Unknown prefixes just
// show the code. Used by the "first slot" department picker.
const DEPT_NAMES = {
  CS: 'Computer Science', SE: 'Software Engineering', AI: 'Artificial Intelligence',
  CE: 'Civil Engineering', CET: 'Civil Eng. Technology', CT: 'Civil Eng. Technology',
  CTL: 'Civil Eng. Tech (Lab)', CETL: 'Civil Eng. Tech (Lab)',
  EE: 'Electrical Engineering', ELT: 'Electrical Eng. Tech', ELC: 'Electrical Eng. Tech',
  ELM: 'Electrical Eng. Tech', ELQ: 'Electrical Eng. Tech', ELTL: 'Electrical Eng. Tech (Lab)',
  ELCL: 'Electrical Eng. Tech (Lab)', PD: 'Pharm-D', MT: 'Mathematics', MS: 'Applied Sciences',
  MG: 'Management / Business', DP: 'Physical Therapy (DPT)', LT: 'Medical Lab Technology',
  RT: 'Radiology Technology', VS: 'Vision Sciences', SU: 'Vision Sciences', OT: 'Operation Theatre',
  HN: 'Human Nutrition & Dietetics', PSY: 'Psychology', ENG: 'English', SS: 'Social Sciences / General',
  NS: 'Natural Sciences', NSC: 'Natural Sciences', HM: 'Humanities', HUM: 'Humanities',
  MD: 'Engineering (Geology)',
};
const codePrefix = (code) => (String(code || '').match(/^[A-Za-z]+/) || [''])[0].toUpperCase();

function inferSemester(dateStr) {
  if (!dateStr) return { semester: '', year: '' };
  const d = new Date(dateStr);
  const m = d.getMonth() + 1;
  let semester = 'Fall';
  if (m >= 1 && m <= 5) semester = 'Spring';
  else if (m >= 6 && m <= 8) semester = 'Summer';
  return { semester, year: d.getFullYear() };
}

export default function DateSheets() {
  const toast = useToast();
  const [params] = useSearchParams();
  const initialType = params.get('type') === 'finals' ? 'finals' : 'mids';

  // ── form state ──
  const [examType, setExamType] = useState(initialType);
  const [startDate, setStartDate] = useState('');
  // Datesheet is always built on a fixed number of DAYS (papers are packed
  // evenly across them, clash-free). The old "by papers per slot" mode was
  // removed — days is the single control.
  const [windowMode] = useState('by_days');
  const [papersPerSlot] = useState(25);   // kept for API shape; not user-editable
  const [numDays, setNumDays] = useState(6);
  const [programLevel, setProgramLevel] = useState('Undergraduate');
  const [semester, setSemester] = useState('');
  const [year, setYear] = useState('');
  const [semesterTouched, setSemesterTouched] = useState(false);

  // ── course data source ──
  const [dataSource, setDataSource] = useState('existing'); // 'existing' | 'upload'
  const [uploadFile, setUploadFile] = useState(null);
  const [courseCount, setCourseCount] = useState(null);

  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);

  // ── department-scoped datesheets ──
  const [deptOptions, setDeptOptions] = useState([]);     // [{key,label,courses}]
  const [selectedDepts, setSelectedDepts] = useState([]); // dept keys chosen
  const [separateDepts, setSeparateDepts] = useState(true); // separate PDF per dept vs one combined
  const [twoPerDay, setTwoPerDay] = useState(false);        // allow 2 papers/student/day (default 1)

  // ── holiday review state ──
  const [holidayReview, setHolidayReview] = useState(false); // review dates step
  const [candidateDates, setCandidateDates] = useState([]);  // [{iso, label, weekday}]
  const [excludedDates, setExcludedDates] = useState([]);    // ISO strings user removed

  // ── remove-courses step (before merging) ──
  const [removeStep, setRemoveStep] = useState(false);   // "remove any course?" modal
  const [courseList, setCourseList] = useState([]);      // [{code, name}] deduped
  const [courseLoading, setCourseLoading] = useState(false);
  const [courseSearch, setCourseSearch] = useState('');
  const [removedCodes, setRemovedCodes] = useState([]);  // course codes to drop
  // code -> { reason, source: 'rule' | 'db' | 'file' } for courses pre-selected automatically
  const [autoNoExam, setAutoNoExam] = useState({});
  const [noExamFileBusy, setNoExamFileBusy] = useState(false);

  // ── first-slot department step (after merging, before generating) ──
  const [firstSlotStep, setFirstSlotStep] = useState(false);
  const [deptSearch, setDeptSearch] = useState('');
  const [firstSlotDepts, setFirstSlotDepts] = useState([]);  // code prefixes, e.g. ['CS','CE']
  const [pendingGen, setPendingGen] = useState({ groups: [], forceMerges: false });

  // ── merge modal state ──
  const [askMerge, setAskMerge] = useState(false);       // "do you want to merge?"
  const [mergeBuilder, setMergeBuilder] = useState(false); // the builder UI
  const [mergeGroups, setMergeGroups] = useState([]);     // [[code, code], ...]
  const [lastGroups, setLastGroups] = useState([]);       // groups used in the last generate (for "merge anyway")
  const [curGroup, setCurGroup] = useState({ base: '', withCodes: [''] });

  // Auto-fill semester/year from start date unless user overrode
  useEffect(() => {
    if (!startDate || semesterTouched) return;
    const { semester: s, year: y } = inferSemester(startDate);
    setSemester(s);
    setYear(String(y));
  }, [startDate, semesterTouched]);

  // ── "Start fresh" cleanup: preview counts in a modal, then delete ──
  const [cleaning, setCleaning] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [cleanMode, setCleanMode] = useState('all');        // 'all' | 'latest'
  const [cleanPreview, setCleanPreview] = useState(null);
  const openCleanup = async () => {
    setCleanOpen(true);
    setCleanPreview(null);
    try {
      const [all, latest] = await Promise.all([
        api.post('/generate/files/keep-latest', { dryRun: true, all: true }),
        api.post('/generate/files/keep-latest', { dryRun: true, keepMs: true }),
      ]);
      setCleanPreview({ all: all.data, latest: latest.data });
    } catch (err) {
      toast.error(errMsg(err, 'Could not read the generated files.'));
      setCleanOpen(false);
    }
  };
  const runCleanup = async () => {
    try {
      setCleaning(true);
      const r = await api.post('/generate/files/keep-latest', cleanMode === 'all' ? { all: true } : { keepMs: true });
      toast.success(cleanMode === 'all'
        ? `Fresh start — removed ${r.data.removedDatesheets} datesheet(s) and ${r.data.removedAdmitBatches} admit-card batch(es).`
        : `Removed ${r.data.removedDatesheets} older datesheet(s) and ${r.data.removedAdmitBatches} admit-card batch(es).`);
      setCleanOpen(false);
      loadHistory();
    } catch (err) {
      toast.error(errMsg(err, 'Cleanup failed.'));
    } finally { setCleaning(false); }
  };

  const loadHistory = async () => {
    try {
      const res = await api.get('/generate/files', { params: { kind: 'datesheet' } });
      setHistory(res.data.items || []);
    } catch { /* ignore */ }
  };
  const loadCourseCount = async () => {
    try {
      const res = await api.get('/dashboard/summary');
      setCourseCount(res.data?.counts?.courses ?? null);
    } catch { /* ignore */ }
  };
  const loadDepartments = async (lvl) => {
    try {
      // Only the SELECTED program level's departments (UG vs PG/MS) — so Postgraduate
      // shows only MS departments in the per-department + first-slot pickers.
      const level = (lvl || programLevel) === 'Postgraduate' ? 'PG' : 'UG';
      const res = await api.get('/courses/departments', { params: { level } });
      setDeptOptions(res.data.items || []);
    } catch { /* ignore */ }
  };
  useEffect(() => { loadHistory(); loadCourseCount(); }, []);
  // Reload the department list whenever the program level changes, and clear any
  // department selections that belong to the other level.
  useEffect(() => { loadDepartments(programLevel); setSelectedDepts([]); setFirstSlotDepts([]); }, [programLevel]); // eslint-disable-line

  // ── live heading + filename preview ──
  const { heading, filename } = useMemo(() => {
    const lvl = programLevel;
    const examLabel = examType === 'mids' ? 'Mid Term Examination' : 'Final Term Examination';
    const fileExam = examType === 'mids' ? 'Mid term' : 'Final term';
    const sem = semester || '—';
    const yr = year || '—';
    return {
      heading: `${lvl} Program Date Sheet, ${examLabel}, ${sem} ${yr}`,
      filename: `${lvl} Program Date Sheet ${fileExam} ${sem} ${yr}.pdf`,
    };
  }, [programLevel, examType, semester, year]);

  // ── validation before generate ──
  const validate = () => {
    if (courseCount === 0) {
      toast.error('No courses in the database. Import the registration data under Import Data first.'); return false;
    }
    if (!startDate) { toast.error('Pick an exam start date.'); return false; }
    if (windowMode === 'by_papers' && !(Number(papersPerSlot) > 0)) {
      toast.error('Enter papers per slot.'); return false;
    }
    if (windowMode === 'by_days' && !(Number(numDays) > 0)) {
      toast.error('Enter number of days.'); return false;
    }
    if (!semester || !year) { toast.error('Set semester and year.'); return false; }
    return true;
  };

  // ── date helpers ──
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Format a Date as a LOCAL 'YYYY-MM-DD' (never UTC — avoids off-by-one in +tz zones)
  const toLocalIso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Build `count` working dates from startDate, skipping Sundays and any ISO in `skip`.
  const buildDates = (startIso, count, skip = []) => {
    const out = [];
    const skipSet = new Set(skip);
    const [y, m, dd] = startIso.split('-').map(Number);
    const d = new Date(y, m - 1, dd); // local midnight, no tz shift
    while (out.length < count) {
      const iso = toLocalIso(d);
      const isSunday = d.getDay() === 0;
      if (!isSunday && !skipSet.has(iso)) {
        out.push({ iso, weekday: WEEKDAYS[d.getDay()], label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) });
      }
      d.setDate(d.getDate() + 1);
    }
    return out;
  };

  // Estimate how many exam days the datesheet will span (mirrors backend formula).
  // In by_days mode this is exact. In by_papers mode we need a course count; for
  // an uploaded file we don't know it yet, so we assume a typical ~200 courses
  // for the holiday-review dates (the backend computes the real day count).
  const estimateDays = () => {
    const nSlots = examType === 'mids' ? 3 : 2;
    if (windowMode === 'by_days') return Math.max(1, Number(numDays));
    const total = dataSource === 'upload' ? (courseCount || 200) : (courseCount || 1);
    return Math.max(1, Math.ceil(total / (Number(papersPerSlot) * nSlots)));
  };

  // Clicking "Generate": review dates (holidays) → merge → generate.
  // In "upload" mode the file is sent straight to the generator later — we do
  // NOT import it into the database.
  const onGenerateClick = async () => {
    if (!validate()) return;
    // build candidate dates for the review step
    const days = estimateDays();
    const dates = buildDates(startDate, days, []);
    setCandidateDates(dates);
    setExcludedDates([]);
    setHolidayReview(true);
  };

  // Toggle a date as holiday (excluded). Excluding one adds a working day at the end.
  const toggleHoliday = (iso) => {
    setExcludedDates((prev) => {
      const next = prev.includes(iso) ? prev.filter((x) => x !== iso) : [...prev, iso];
      // rebuild the candidate list with the new exclusions (adds days at end)
      const days = estimateDays();
      setCandidateDates(buildDates(startDate, days, next));
      return next;
    });
  };

  // Load the course list (deduped by code) for the remove-courses step.
  const loadCourseList = async () => {
    setCourseLoading(true);
    try {
      // Only the selected level's courses — so the eliminate list shows MS courses
      // for Postgraduate, UG courses for Undergraduate.
      const level = programLevel === 'Postgraduate' ? 'PG' : 'UG';
      const res = await api.get('/courses', { params: { limit: 10000, level } });
      const seen = new Map();
      for (const c of (res.data.items || [])) {
        const code = String(c.code || '').trim();
        if (code && !seen.has(code)) seen.set(code, { code, name: c.name || '' });
      }
      setCourseList([...seen.values()].sort((a, b) => a.code.localeCompare(b.code)));
      // Courses that get NO paper automatically (FYP / thesis / internship / project /
      // labs incl. "L" codes / clinical / DB yellow flags) → pre-selected in red.
      try {
        const auto = await api.get('/generate/no-exam/auto');
        const map = {};
        for (const it of (auto.data.items || [])) if (seen.has(it.code)) map[it.code] = { reason: it.reason, source: it.source };
        setAutoNoExam(map);
        setRemovedCodes((prev) => [...new Set([...prev, ...Object.keys(map)])]);
      } catch { /* the generator still applies the same rules */ }
    } catch {
      setCourseList([]);   // upload mode / empty DB — user can still skip
    } finally {
      setCourseLoading(false);
    }
  };

  // After reviewing dates: ask whether to REMOVE any course, then merge.
  const confirmDates = () => {
    setHolidayReview(false);
    setRemovedCodes([]);
    setAutoNoExam({});
    setCourseSearch('');
    setRemoveStep(true);
    loadCourseList();
  };

  // Upload a report: every YELLOW-highlighted course row is removed (added to the
  // red selection). The user can still tick/untick more before continuing.
  const removeFromFile = async (file) => {
    if (!file) return;
    if (!/\.(xlsx|xls)$/i.test(file.name)) { toast.error('Upload the .xls or .xlsx report with the yellow-highlighted courses.'); return; }
    setNoExamFileBusy(true);
    try {
      const form = new FormData();
      form.append('dataset', file);
      const r = await api.post('/generate/no-exam/from-file', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      const items = r.data.items || [];
      const known = new Set(courseList.map((c) => c.code));
      const codes = items.map((it) => it.code);
      setAutoNoExam((prev) => {
        const next = { ...prev };
        for (const it of items) if (!next[it.code]) next[it.code] = { reason: `highlighted in ${file.name}`, source: 'file' };
        return next;
      });
      setRemovedCodes((prev) => [...new Set([...prev, ...codes])]);
      const inList = codes.filter((c) => known.has(c)).length;
      toast.success(`${codes.length} highlighted course(s) read from the file — ${inList} of them are in this datesheet and are now marked for removal.`);
    } catch (err) {
      toast.error(errMsg(err, 'Could not read highlighted courses from the file.'));
    } finally { setNoExamFileBusy(false); }
  };

  const toggleRemoved = (code) =>
    setRemovedCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  // Leave the remove step (with or without a selection) and go to the merge question.
  const proceedFromRemove = () => {
    setRemoveStep(false);
    setAskMerge(true);
  };

  // After the merge decision, ask which department (if any) to pin to the first
  // slot, THEN generate. All merge-flow buttons route through here.
  const runGenerate = (groups, forceMerges = false) => {
    setAskMerge(false);
    setMergeBuilder(false);
    setPendingGen({ groups: groups || [], forceMerges: !!forceMerges });
    setFirstSlotStep(true);
  };

  // Actually call the API. forceMerges=true merges even where students overlap.
  const doGenerate = async (groups, forceMerges = false) => {
    setFirstSlotStep(false);
    setGenerating(true);
    setResult(null);
    setLastGroups(groups || []);
    try {
      let res;
      if (dataSource === 'upload') {
        // Generate straight from the uploaded file — nothing is stored in the DB.
        const form = new FormData();
        form.append('dataset', uploadFile);
        form.append('examType', examType);
        form.append('startDate', startDate);
        form.append('windowMode', windowMode);
        if (windowMode === 'by_papers') form.append('papersPerSlot', String(Number(papersPerSlot)));
        if (windowMode === 'by_days') form.append('numDays', String(Number(numDays)));
        form.append('programLevel', programLevel);
        form.append('semester', semester);
        form.append('year', String(Number(year)));
        form.append('mergeGroups', JSON.stringify(groups || []));
        form.append('excludeDates', JSON.stringify(excludedDates));
        form.append('excludeCourses', JSON.stringify(removedCodes || []));
        form.append('includeCourses', JSON.stringify(Object.keys(autoNoExam).filter((c) => !(removedCodes || []).includes(c))));
        form.append('firstSlotDepartments', JSON.stringify(firstSlotDepts || []));
        form.append('maxPapersPerDay', twoPerDay ? '2' : '1');
        if (forceMerges) form.append('forceMerges', 'true');
        res = await api.post('/generate/datesheet-from-file', form, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      } else {
        // Use the courses already in the database.
        const payload = {
          examType,
          startDate,
          windowMode,
          papersPerSlot: windowMode === 'by_papers' ? Number(papersPerSlot) : undefined,
          numDays: windowMode === 'by_days' ? Number(numDays) : undefined,
          programLevel,
          semester,
          year: Number(year),
          mergeGroups: groups || [],
          excludeDates: excludedDates,
          excludeCourses: removedCodes || [],
          // auto no-paper courses the admin un-ticked = they DO get a paper
          includeCourses: Object.keys(autoNoExam).filter((c) => !(removedCodes || []).includes(c)),
          firstSlotDepartments: firstSlotDepts || [],
          forceMerges: forceMerges || undefined,
          departments: selectedDepts.length ? selectedDepts : undefined,
          separate: selectedDepts.length ? separateDepts : undefined,
          maxPapersPerDay: twoPerDay ? 2 : 1,
        };
        res = await api.post('/generate/datesheet', payload, { timeout: 30 * 60 * 1000 });
      }
      if (res.data.multi) {
        setResult(null);
        const moved = res.data.btechClashMoves || 0;
        toast.success(`${(res.data.records || []).length} datesheet(s) generated.`
          + (moved ? ` ${moved} B.Tech paper(s) auto-shifted to avoid gen-ed clashes.` : ''));
        // A cohort that FAILED must never vanish silently (e.g. "BTech made, BS missing").
        if ((res.data.errors || []).length) {
          toast.error(`Not generated — ${res.data.errors.join(' | ')}`.slice(0, 600), 15000);
        }
      } else {
        setResult(res.data.result);
        toast.success('Datesheet generated.');
      }
      loadHistory();
    } catch (err) {
      toast.error(errMsg(err, 'Datesheet generation failed.'));
    } finally {
      setGenerating(false);
    }
  };

  // ── merge builder helpers ──
  const openMergeBuilder = () => {
    // keep any already-loaded merges (e.g. from editing a previous datesheet)
    setCurGroup({ base: '', withCodes: [''] });
    setAskMerge(false);
    setMergeBuilder(true);
  };
  const addMoreCode = () => setCurGroup((g) => ({ ...g, withCodes: [...g.withCodes, ''] }));
  const setWithCode = (i, v) =>
    setCurGroup((g) => ({ ...g, withCodes: g.withCodes.map((c, idx) => (idx === i ? v : c)) }));
  const removeWithCode = (i) =>
    setCurGroup((g) => ({ ...g, withCodes: g.withCodes.filter((_, idx) => idx !== i) }));

  const saveCurrentGroup = () => {
    const base = curGroup.base.trim();
    const withs = curGroup.withCodes.map((c) => c.trim()).filter(Boolean);
    if (!base || withs.length === 0) {
      toast.error('Enter a course code and at least one code to merge with.');
      return null;
    }
    const group = [base, ...withs];
    setMergeGroups((prev) => [...prev, group]);
    setCurGroup({ base: '', withCodes: [''] });
    return group;
  };

  const addNewMerge = () => { saveCurrentGroup(); };

  // ── bulk paste parsing ──
  const [mergeMode, setMergeMode] = useState('manual'); // 'manual' | 'paste'
  const [bulkText, setBulkText] = useState('');

  // Parse pasted text into merge groups. Each line is one group.
  // Separators between the base and its partners: '=', '=>', '->', '/', ':'.
  // Partners may be separated by ',', '=', '/', or whitespace.
  // e.g.  "CS100 = CS1013, CS117"  →  [CS100, CS1013, CS117]
  //       "DP103 => OT101 / VS101"  →  [DP103, OT101, VS101]
  //       "HN108 = HN109 = HN110"   →  [HN108, HN109, HN110]
  const parseBulkMerges = (text) => {
    const groups = [];
    const lines = (text || '').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // EVERY course code on the line joins the group — whatever separates them
      // (=, =>, ->, /, :, commas, "and", "with" or just spaces). The old split did
      // not split on spaces, so "VS401 SS401" silently became a 1-code group and
      // was dropped (the merge never happened).
      const codes = (line.match(/[A-Za-z]{2,6}\s?\d{3,4}(?:\[\d+\])?(?:-I{1,3}\b|-[AB]\b)?/g) || [])
        .map((c) => c.replace(/\s+/g, '').toUpperCase());
      // de-duplicate while preserving order
      const seen = new Set();
      const uniq = codes.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
      if (uniq.length >= 2) groups.push(uniq);
    }
    return groups;
  };

  const applyBulkPaste = () => {
    const parsed = parseBulkMerges(bulkText);
    if (parsed.length === 0) {
      toast.error('No valid merge lines found. Use one merge per line, e.g. "CS100 = CS117, CS118".');
      return;
    }
    // merge with any existing groups (avoid exact duplicates)
    setMergeGroups((prev) => {
      const key = (g) => g.join('|');
      const have = new Set(prev.map(key));
      const added = parsed.filter((g) => !have.has(key(g)));
      return [...prev, ...added];
    });
    setBulkText('');
    setMergeMode('manual');
    toast.success(`Added ${parsed.length} merge group(s) from pasted text.`);
  };

  const finishMerges = () => {
    // include the current in-progress group if it has content
    let groups = mergeGroups;
    const base = curGroup.base.trim();
    const withs = curGroup.withCodes.map((c) => c.trim()).filter(Boolean);
    if (base && withs.length) groups = [...mergeGroups, [base, ...withs]];
    // also fold in anything still sitting unparsed in the paste box
    if (mergeMode === 'paste' && bulkText.trim()) {
      const parsed = parseBulkMerges(bulkText);
      const key = (g) => g.join('|');
      const have = new Set(groups.map(key));
      groups = [...groups, ...parsed.filter((g) => !have.has(key(g)))];
    }
    // normalise every group to clean, unique course codes ("VS401 /SS401" typed into one
    // box → [VS401, SS401]); a group with < 2 codes is not a merge.
    groups = groups
      .map((g) => [...new Set((g.join(' ').match(/[A-Za-z]{2,6}\s?\d{3,4}(?:\[\d+\])?(?:-I{1,3}\b|-[AB]\b)?/g) || [])
        .map((c) => c.replace(/\s+/g, '').toUpperCase()))])
      .filter((g) => g.length >= 2);
    runGenerate(groups);
  };

  const download = async (record, file) => {
    setBusy(true);
    try {
      await downloadFile(`/generate/files/${record._id}/download/${encodeURIComponent(file.filename)}`, file.filename);
    } catch (err) {
      toast.error(errMsg(err, 'Download failed.'));
    } finally {
      setBusy(false);
    }
  };

  // Load a previous datesheet's settings back into the form so the user can
  // tweak them (add merges, change days, etc.) and regenerate.
  const editDatesheet = (record) => {
    const cfg = record?.meta?.config;
    if (!cfg) {
      toast.error("This datesheet's settings aren't available to edit.");
      return;
    }
    setExamType(cfg.examType === 'finals' ? 'finals' : 'mids');
    setStartDate(cfg.startDate || '');
    // Always days-based now. If an old datesheet was papers-based, fall back to
    // its computed day count so the reloaded form still reflects that window.
    if (cfg.numDays) setNumDays(cfg.numDays);
    else if (cfg.totalDays) setNumDays(cfg.totalDays);
    setProgramLevel(cfg.programLevel || 'Undergraduate');
    if (cfg.semester) { setSemester(cfg.semester); setSemesterTouched(true); }
    if (cfg.year) setYear(String(cfg.year));
    setMergeGroups(Array.isArray(cfg.mergeGroups) ? cfg.mergeGroups : []);
    setExcludedDates(Array.isArray(cfg.excludeDates) ? cfg.excludeDates : []);
    setDataSource('existing');
    setResult(null);
    toast.success('Loaded settings — adjust and regenerate. Existing merges are kept.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const slotInfo = examType === 'mids'
    ? '3 slots/day · 09:00–10:30, 11:00–12:30, 01:00–02:30'
    : '2 slots/day · 09:00–12:00, 01:00–03:00';

  // Courses matching the remove-step search (by code or name).
  const filteredCourses = useMemo(() => {
    const term = courseSearch.trim().toLowerCase();
    if (!term) return courseList;
    return courseList.filter((c) =>
      c.code.toLowerCase().includes(term) || (c.name || '').toLowerCase().includes(term));
  }, [courseList, courseSearch]);

  // Departments (code prefixes) derived from the course list, for the first-slot picker.
  const deptList = useMemo(() => {
    const m = new Map();
    for (const c of courseList) {
      const pre = codePrefix(c.code);
      if (!pre) continue;
      if (!m.has(pre)) m.set(pre, { prefix: pre, name: DEPT_NAMES[pre] || pre, count: 0 });
      m.get(pre).count += 1;
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
  }, [courseList]);
  const filteredDepts = useMemo(() => {
    const t = deptSearch.trim().toLowerCase();
    if (!t) return deptList;
    return deptList.filter((d) => d.prefix.toLowerCase().includes(t) || d.name.toLowerCase().includes(t));
  }, [deptList, deptSearch]);
  const toggleDept = (pre) =>
    setFirstSlotDepts((prev) => (prev.includes(pre) ? prev.filter((p) => p !== pre) : [...prev, pre]));

  return (
    <div>
      <PageHeader
        eyebrow="Generate"
        title="Date Sheets"
        subtitle="Produce a clash-free exam datesheet in the official Abasyn format. Configure the exam, then choose whether to merge shared-paper courses."
      />

      <div className="ds-grid">
        {/* ── Configuration card ── */}
        <motion.div className="ds-config card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          {/* Exam type */}
          <label className="ds-label">Examination type</label>
          <div className="ds-type-row">
            <button className={`ds-type ${examType === 'mids' ? 'active' : ''}`} onClick={() => setExamType('mids')}>
              <BookMarked size={18} />
              <span>Mid Term</span>
              <small>3 columns</small>
            </button>
            <button className={`ds-type ${examType === 'finals' ? 'active' : ''}`} onClick={() => setExamType('finals')}>
              <CalendarClock size={18} />
              <span>Final Term</span>
              <small>2 columns</small>
            </button>
          </div>
          <p className="ds-slotinfo"><Clock size={13} /> {slotInfo}</p>

          {/* Course data — always the database (imported under Import Data).
              Projects, FYP, thesis and internships are skipped automatically —
              they have no written paper. */}
          <label className="ds-label">Course data</label>
          <p className="ds-source-note">
            <Database size={13} />
            {courseCount != null
              ? `Using ${courseCount} course${courseCount === 1 ? '' : 's'} from the database (projects / FYP / thesis are skipped automatically).`
              : 'Using courses from the database (Import Data). Projects / FYP / thesis are skipped automatically.'}
          </p>

          {/* Start date */}
          <label className="ds-label">Exam start date</label>
          <input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />

          {/* Number of exam days — the datesheet is built on days */}
          <label className="ds-label"><CalendarDays size={15} /> Number of exam days</label>
          <div className="ds-field-inline">
            <input className="input ds-num" type="number" min="1" value={numDays}
              onChange={(e) => setNumDays(e.target.value)} />
            <small>All papers are packed clash-free within these days (Sundays skipped).</small>
          </div>

          {/* Program level */}
          <label className="ds-label">Program level</label>
          <div className="ds-seg">
            {LEVELS.map((l) => (
              <button key={l} className={`ds-seg-btn ${programLevel === l ? 'active' : ''}`} onClick={() => setProgramLevel(l)}>{l}</button>
            ))}
          </div>

          {/* Semester + year */}
          <div className="ds-two-col">
            <div>
              <label className="ds-label">Semester</label>
              <div className="ds-seg">
                {SEMESTERS.map((s) => (
                  <button key={s} className={`ds-seg-btn sm ${semester === s ? 'active' : ''}`}
                    onClick={() => { setSemester(s); setSemesterTouched(true); }}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="ds-label">Year</label>
              <input className="input" type="number" value={year}
                onChange={(e) => { setYear(e.target.value); setSemesterTouched(true); }} placeholder="2026" />
            </div>
          </div>

          {/* ── Department-scoped datesheets ── */}
          {dataSource === 'existing' && deptOptions.length > 0 && (
            <div className="ds-dept-box" style={{ marginTop: 18, padding: 14, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface-2,#f4f7f5)' }}>
              <label className="ds-label" style={{ marginBottom: 8 }}>
                <Building2 size={15} /> Separate datesheet by department?
              </label>
              <p style={{ fontSize: 12.5, color: 'var(--text-faint)', margin: '0 0 10px' }}>
                Pick one or more departments to make a datesheet just for them. Leave all unchecked for one datesheet of everything.
                <b>B.Tech</b> (Civil + Electrical Engineering Technology) always gets ONE combined datesheet on its own slots — weekdays 3:00–4:30, Sat/Sun 9:00–10:30 &amp; 1:00–2:30.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                {deptOptions.map((d) => {
                  const on = selectedDepts.includes(d.key);
                  return (
                    <button key={d.key} type="button"
                      className={`ds-seg-btn sm ${on ? 'active' : ''}`}
                      onClick={() => setSelectedDepts((s) => on ? s.filter((k) => k !== d.key) : [...s, d.key])}>
                      {d.label} <span style={{ opacity: .6 }}>({d.courses})</span>
                    </button>
                  );
                })}
              </div>
              {selectedDepts.length > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>{selectedDepts.length} selected —</span>
                  <button type="button" className={`ds-seg-btn sm ${separateDepts ? 'active' : ''}`} onClick={() => setSeparateDepts(true)}>Separate datesheets</button>
                  <button type="button" className={`ds-seg-btn sm ${!separateDepts ? 'active' : ''}`} onClick={() => setSeparateDepts(false)}>One combined</button>
                  <button type="button" className="ds-seg-btn sm" onClick={() => setSelectedDepts([])}>Clear</button>
                </div>
              )}
            </div>
          )}

          {/* ── Papers per student per day ── */}
          <div style={{ marginTop: 16, padding: 14, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface-2,#f4f7f5)' }}>
            <label className="ds-label" style={{ marginBottom: 8 }}><Layers size={15} /> Papers per student per day</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className={`ds-seg-btn sm ${!twoPerDay ? 'active' : ''}`} onClick={() => setTwoPerDay(false)}>1 paper / day (default)</button>
              <button type="button" className={`ds-seg-btn sm ${twoPerDay ? 'active' : ''}`} onClick={() => setTwoPerDay(true)}>Allow 2 papers / day</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '8px 0 0' }}>
              {twoPerDay
                ? 'A student may sit up to 2 papers a day — one morning + one afternoon, with the middle slot left free as a gap.'
                : 'Each student sits at most one paper per day (needs enough exam days).'}
            </p>
          </div>

          <button className={`btn btn-brass ds-generate ${generating ? 'is-generating' : ''}`} onClick={onGenerateClick} disabled={generating}>
            {generating
              ? <span className="gen-btn-label"><Loader2 size={17} className="spin" /> Generating…</span>
              : <><Sparkles size={17} /> {selectedDepts.length > 0 ? (separateDepts ? `Generate ${selectedDepts.length} datesheet(s)` : 'Generate combined datesheet') : 'Generate datesheet'}</>}
          </button>
        </motion.div>

        {/* ── Live preview + result ── */}
        <div className="ds-side">
          <motion.div className="ds-preview card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }}>
            <div className="ds-preview-head"><FileText size={16} /> Live preview</div>
            <div className="ds-preview-row">
              <span className="ds-preview-k">Heading</span>
              <span className="ds-preview-v">{heading}</span>
            </div>
            <div className="ds-preview-row">
              <span className="ds-preview-k">File name</span>
              <span className="ds-preview-v mono">{filename}</span>
            </div>
            <p className="ds-preview-note">Semester and year follow the start date — change either to set them yourself.</p>
          </motion.div>

          <AnimatePresence>
            {result && (
              <motion.div className="ds-result card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <div className="ds-result-head"><CheckCircle2 size={20} /> Generated</div>
                <div className="ds-result-grid">
                  <div><b>{result.total_days}</b><span>days</span></div>
                  <div><b>{result.slots_per_day}</b><span>slots/day</span></div>
                  <div><b>{result.max_papers_per_slot ?? result.papers_per_slot ?? '—'}</b><span>max papers/slot</span></div>
                  <div><b>{result.total_courses}</b><span>courses</span></div>
                </div>
                <div className="ds-result-range">{result.start_date} → {result.end_date}</div>
                {result.room_note && (
                  <div className={`ds-room-note ${result.venue_ok === false ? 'warn' : ''}`}>
                    <BookMarked size={14} /> {result.room_note}
                  </div>
                )}
                {result.student_clashes > 0 && (
                  <div className="ds-clash-warn">
                    <AlertCircle size={15} />
                    <span>
                      <b>{result.student_clashes} student clash(es)</b> — the window is too tight to
                      be fully clash-free.{' '}
                      {result.min_days_clashfree
                        ? <>Use <b>{result.min_days_clashfree} days</b> (or fewer papers per slot) for a clash-free datesheet.</>
                        : <>Increase the days or papers per slot to remove them.</>}
                    </span>
                  </div>
                )}
                {result.student_clashes === 0 && (
                  <div className="ds-clashfree">
                    <CheckCircle2 size={14} /> Fully clash-free — no student has two papers in one slot.
                  </div>
                )}
                {result.merge_warnings && result.merge_warnings.length > 0 && (
                  <div className="ds-merge-info">
                    <CheckCircle2 size={15} />
                    <span>
                      <b>{result.merge_warnings.length} merge(s) auto-resolved.</b> A few of the courses you asked to
                      merge are taken together by some students, so those were placed in separate slots to keep the
                      datesheet fully clash-free:{' '}
                      {result.merge_warnings.map((w, i) => (
                        <span key={i}>
                          <b>{(w.kept_separate || []).join(', ')}</b>
                          {i < result.merge_warnings.length - 1 ? '; ' : ''}
                        </span>
                      ))}
                    </span>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── History ── */}
      {history.length > 0 && (
        <div className="ds-history">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <h3 className="font-display ds-history-title">Recent datesheets</h3>
            <button type="button" className="ds-clean-btn" onClick={openCleanup} disabled={cleaning}>
              <span className="ds-clean-btn-icon">{cleaning ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}</span>
              <span className="ds-clean-btn-text">
                <b>Start fresh</b>
                <small>Clear old datesheets &amp; admit cards</small>
              </span>
            </button>
          </div>
          {history.map((h, idx) => (
            <div key={h._id} className="ds-history-item card">
              <div className={`ds-history-icon ${h.examType}`}>
                {h.examType === 'mids' ? <BookMarked size={18} /> : <CalendarClock size={18} />}
              </div>
              <div className="ds-history-info">
                <div className="ds-history-name">
                  {h.title}
                  {idx === 0 && <span className="ds-hist-badge ok" style={{ marginLeft: 8 }}>Newest</span>}
                </div>
                <div className="ds-history-meta">
                  {h.createdAt && (
                    <span className="ds-hist-stamp" style={{ fontWeight: 700 }}>
                      <Clock size={11} /> Generated {new Date(h.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })}
                    </span>
                  )}
                  {' · '}{h.summary?.days} days · {h.summary?.courses} courses
                  {typeof h.summary?.studentClashes === 'number' && (
                    h.summary.studentClashes === 0
                      ? <span className="ds-hist-badge ok"><CheckCircle2 size={11} /> clash-free</span>
                      : <span className="ds-hist-badge warn"><AlertCircle size={11} /> {h.summary.studentClashes} clashes</span>
                  )}
                  {h.meta?.config?.mergeGroups?.length > 0 && (
                    <span className="ds-hist-merge"><GitMerge size={11} /> {h.meta.config.mergeGroups.length} merge(s)</span>
                  )}
                  {h.meta?.restoredNoExam?.length > 0 && (
                    <span className="ds-hist-merge" title={`Theory papers restored (DB had them as no-exam only because the title contains "Project"): ${h.meta.restoredNoExam.join(', ')}`}>
                      <CheckCircle2 size={11} /> {h.meta.restoredNoExam.length} restored
                    </span>
                  )}
                  {h.meta?.reviewNoExam?.length > 0 && (
                    <span className="ds-hist-merge" style={{ color: '#b45309' }}
                      title={`Marked no-exam (yellow) but looks like a theory paper — confirm: ${h.meta.reviewNoExam.map((x) => `${x.code} ${x.title}`).join('; ')}`}>
                      <AlertCircle size={11} /> {h.meta.reviewNoExam.length} no-exam to confirm
                    </span>
                  )}
                </div>
              </div>
              <button className="btn btn-ghost ds-edit-btn" onClick={() => editDatesheet(h)} disabled={generating || busy}>
                <Pencil size={14} /> Edit
              </button>
              {(h.files || []).map((f) => (
                <button key={f.filename} className="btn btn-ghost" onClick={() => download(h, f)} disabled={busy}>
                  <Download size={15} /> {f.label === 'Analysis Report' ? 'Report' : 'PDF'}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ═══ Holiday / date review modal ═══ */}
      <AnimatePresence>
        {holidayReview && (
          <motion.div className="ds-modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="ds-modal ds-modal-wide" initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}>
              <button className="ds-modal-close" onClick={() => setHolidayReview(false)}><X size={18} /></button>
              <h3 className="font-display">Review exam dates</h3>
              <p className="ds-merge-hint">
                Your exam runs for <b>{candidateDates.length} working day{candidateDates.length === 1 ? '' : 's'}</b> from {startDate}
                {' '}(Sundays already skipped). If any day is a public holiday, mark it — a new working day is added at the end automatically.
              </p>

              <div className="ds-dates no-scrollbar">
                {candidateDates.map((d) => {
                  const excluded = excludedDates.includes(d.iso);
                  return (
                    <button key={d.iso} className={`ds-date-chip ${excluded ? 'excluded' : ''}`} onClick={() => toggleHoliday(d.iso)}>
                      <span className="ds-date-wd">{d.weekday.slice(0, 3)}</span>
                      <span className="ds-date-lbl">{d.label}</span>
                      {excluded ? <X size={13} /> : <CalendarDays size={13} />}
                    </button>
                  );
                })}
              </div>
              {excludedDates.length > 0 && (
                <p className="ds-source-note"><CheckCircle2 size={13} /> {excludedDates.length} holiday(s) excluded — {excludedDates.length} extra day(s) added at the end.</p>
              )}

              <div className="ds-modal-actions">
                <button className="btn btn-ghost" onClick={() => setHolidayReview(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={confirmDates}>Continue</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ Remove-courses step (before merging) ═══ */}
      <AnimatePresence>
        {removeStep && (
          <motion.div className="ds-modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="ds-modal ds-modal-wide" initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
              <button className="ds-modal-close" onClick={() => setRemoveStep(false)}><X size={18} /></button>
              <div className="ds-modal-icon"><MinusCircle size={26} /></div>
              <h3 className="font-display">Do you want to remove any course?</h3>
              <p>Courses with <b>no written paper</b> (FYP, thesis, internship, projects, labs, clinical) are <b className="ds-red-txt">already selected in red</b>.
                Upload a report to remove its <b>yellow-highlighted</b> courses too, or search and tick more yourself. Untick anything that should have a paper.</p>

              <div className="ds-remove-tools">
                <label className={`ds-remove-upload ${noExamFileBusy ? 'busy' : ''}`}>
                  {noExamFileBusy ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
                  <span><b>Upload file</b> <small>remove yellow-highlighted courses (.xls / .xlsx)</small></span>
                  <input type="file" accept=".xls,.xlsx" hidden disabled={noExamFileBusy}
                    onChange={(e) => { removeFromFile(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                <span className="ds-remove-count">{removedCodes.length} selected
                  {Object.keys(autoNoExam).length > 0 && <> · {Object.keys(autoNoExam).filter((c) => removedCodes.includes(c)).length} automatic</>}</span>
              </div>

              <div className="ds-remove-search">
                <Search size={15} />
                <input placeholder="Search course code or name…" value={courseSearch}
                  onChange={(e) => setCourseSearch(e.target.value)} autoFocus />
                {courseSearch && <button className="ds-remove-x" onClick={() => setCourseSearch('')}><X size={13} /></button>}
              </div>

              {removedCodes.length > 0 && (
                <div className="ds-remove-chips no-scrollbar">
                  {removedCodes.map((code) => (
                    <button key={code} className="ds-remove-chip" onClick={() => toggleRemoved(code)}>{code} <X size={12} /></button>
                  ))}
                </div>
              )}

              <div className="ds-remove-list no-scrollbar">
                {courseLoading ? (
                  <div className="ds-remove-empty"><Loader2 size={18} className="spin" /> Loading courses…</div>
                ) : filteredCourses.length === 0 ? (
                  <div className="ds-remove-empty">{courseList.length ? 'No courses match your search.' : 'No course list available — you can skip this step.'}</div>
                ) : (
                  <>
                    {filteredCourses.slice(0, 200).map((c) => {
                      const on = removedCodes.includes(c.code);
                      return (
                        <button key={c.code} className={`ds-remove-item ${on ? 'on' : ''}`} onClick={() => toggleRemoved(c.code)}>
                          <span className={`ds-remove-check ${on ? 'on' : ''}`}>{on && <CheckCircle2 size={13} />}</span>
                          <span className="ds-remove-code">{c.code}</span>
                          <span className="ds-remove-name">{c.name}</span>
                          {autoNoExam[c.code] && (
                            <span className={`ds-remove-tag ${autoNoExam[c.code].source}`} title={autoNoExam[c.code].reason}>
                              {autoNoExam[c.code].source === 'file' ? 'file' : 'auto'}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {filteredCourses.length > 200 && <div className="ds-remove-more">Showing first 200 — refine your search.</div>}
                  </>
                )}
              </div>

              <div className="ds-modal-actions">
                <button className="btn btn-ghost" onClick={() => setRemoveStep(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={proceedFromRemove}>
                  {removedCodes.length ? `Remove ${removedCodes.length} & continue` : 'Continue'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ Merge question modal ═══ */}
      <AnimatePresence>
        {askMerge && (
          <motion.div className="ds-modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="ds-modal" initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
              <button className="ds-modal-close" onClick={() => setAskMerge(false)}><X size={18} /></button>
              <div className="ds-modal-icon"><GitMerge size={26} /></div>
              <h3 className="font-display">Do you want to merge courses?</h3>
              {mergeGroups.length > 0 ? (
                <p>This datesheet already has <b>{mergeGroups.length} merge group(s)</b> loaded. Choose <b>Yes</b> to review or add more, or generate simple to drop them.</p>
              ) : (
                <p>Some courses have different codes but the <b>same paper</b> — merging places them in the same exam slot (shown separately). If not, we'll generate a simple clash-free datesheet.</p>
              )}
              <div className="ds-modal-actions">
                <button className="btn btn-ghost" onClick={() => runGenerate([])}>No, generate simple</button>
                <button className="btn btn-primary" onClick={openMergeBuilder}><GitMerge size={16} /> {mergeGroups.length > 0 ? 'Yes, review merges' : 'Yes, merge courses'}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ First-slot department step (after merging, before generating) ═══ */}
      <AnimatePresence>
        {firstSlotStep && (
          <motion.div className="ds-modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="ds-modal ds-modal-wide" initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }} onClick={(e) => e.stopPropagation()}>
              <button className="ds-modal-close" onClick={() => setFirstSlotStep(false)}><X size={18} /></button>
              <div className="ds-modal-icon"><Clock size={26} /></div>
              <h3 className="font-display">Pin a department to the first slot?</h3>
              <p>Search a department by <b>name or code</b> to force its papers into the <b>first slot</b> (09:00) of each day. Leave empty for a fully balanced datesheet with no department pinned.</p>

              <div className="ds-remove-search">
                <Search size={15} />
                <input placeholder="Search department — e.g. Computer Science or CS…" value={deptSearch}
                  onChange={(e) => setDeptSearch(e.target.value)} autoFocus />
                {deptSearch && <button className="ds-remove-x" onClick={() => setDeptSearch('')}><X size={13} /></button>}
              </div>

              {firstSlotDepts.length > 0 && (
                <div className="ds-remove-chips no-scrollbar">
                  {firstSlotDepts.map((p) => (
                    <button key={p} className="ds-dept-chip" onClick={() => toggleDept(p)}>{p} <X size={12} /></button>
                  ))}
                </div>
              )}

              <div className="ds-remove-list no-scrollbar">
                {deptList.length === 0 ? (
                  <div className="ds-remove-empty">No department list available — you can generate without pinning.</div>
                ) : filteredDepts.length === 0 ? (
                  <div className="ds-remove-empty">No department matches your search.</div>
                ) : filteredDepts.map((d) => {
                  const on = firstSlotDepts.includes(d.prefix);
                  return (
                    <button key={d.prefix} className={`ds-remove-item ${on ? 'on-pin' : ''}`} onClick={() => toggleDept(d.prefix)}>
                      <span className={`ds-remove-check ${on ? 'on-pin' : ''}`}>{on && <CheckCircle2 size={13} />}</span>
                      <span className="ds-remove-code">{d.prefix}</span>
                      <span className="ds-remove-name">{d.name}</span>
                      <span className="ds-dept-count">{d.count}</span>
                    </button>
                  );
                })}
              </div>

              <div className="ds-modal-actions">
                <button className="btn btn-ghost" onClick={() => { setFirstSlotDepts([]); doGenerate(pendingGen.groups, pendingGen.forceMerges); }}>None — fully balanced</button>
                <button className="btn btn-primary" onClick={() => doGenerate(pendingGen.groups, pendingGen.forceMerges)}>
                  {firstSlotDepts.length ? `Pin ${firstSlotDepts.length} & generate` : 'Generate'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══ Merge builder modal ═══ */}
      <AnimatePresence>
        {mergeBuilder && (
          <motion.div className="ds-modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="ds-modal ds-modal-wide" initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}>
              <button className="ds-modal-close" onClick={() => setMergeBuilder(false)}><X size={18} /></button>
              <h3 className="font-display">Merge courses</h3>

              {/* mode toggle: manual entry vs bulk paste */}
              <div className="ds-merge-modes">
                <button className={`ds-merge-mode ${mergeMode === 'manual' ? 'active' : ''}`} onClick={() => setMergeMode('manual')}>
                  <Plus size={14} /> Enter manually
                </button>
                <button className={`ds-merge-mode ${mergeMode === 'paste' ? 'active' : ''}`} onClick={() => setMergeMode('paste')}>
                  <FileText size={14} /> Paste list
                </button>
              </div>

              {/* saved groups — readable "BASE with A, B, C" format, scrollable */}
              {mergeGroups.length > 0 && (
                <div className="ds-merge-saved no-scrollbar">
                  {mergeGroups.map((g, i) => (
                    <div key={i} className="ds-merge-line">
                      <GitMerge size={13} />
                      <span className="ds-merge-text">
                        <b>{g[0]}</b> with {g.slice(1).map((c, j) => (
                          <b key={j}>{c}{j < g.length - 2 ? ', ' : ''}</b>
                        ))}
                      </span>
                      <button className="ds-merge-del" onClick={() => setMergeGroups((prev) => prev.filter((_, idx) => idx !== i))}><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              )}

              {mergeMode === 'paste' ? (
                /* ── bulk paste ── */
                <div className="ds-merge-paste">
                  <p className="ds-merge-hint">Paste one merge per line. Use <b>=</b>, <b>=&gt;</b>, or <b>/</b> between codes — the system understands all of them.</p>
                  <textarea
                    className="input ds-merge-textarea"
                    rows={8}
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    placeholder={"CS100 = CS1013, CS117\nCS106 = CS114\nDP103 => OT101 / VS101\nHN108 = HN109 = HN110"}
                  />
                  <button className="ds-merge-newbtn" onClick={applyBulkPaste}><Plus size={14} /> Add pasted merges</button>
                </div>
              ) : (
                /* ── manual entry ── */
                <>
                  <p className="ds-merge-hint">Enter a course code, then the code(s) it shares a paper with. They'll all sit in one slot.</p>
                  <div className="ds-merge-builder">
                    <div className="ds-merge-row">
                      <div className="ds-merge-field">
                        <label>Merge</label>
                        <input className="input" placeholder="e.g. CS101" value={curGroup.base}
                          onChange={(e) => setCurGroup((g) => ({ ...g, base: e.target.value }))} />
                      </div>
                      <span className="ds-merge-with">with</span>
                      <div className="ds-merge-withs">
                        {curGroup.withCodes.map((code, i) => (
                          <div className="ds-merge-with-item" key={i}>
                            <input className="input" placeholder="e.g. IT101" value={code}
                              onChange={(e) => setWithCode(i, e.target.value)} />
                            {curGroup.withCodes.length > 1 && (
                              <button onClick={() => removeWithCode(i)}><X size={14} /></button>
                            )}
                          </div>
                        ))}
                        <button className="ds-merge-addcode" onClick={addMoreCode}><Plus size={13} /> Add more codes</button>
                      </div>
                    </div>
                    <button className="ds-merge-newbtn" onClick={addNewMerge}><Plus size={14} /> Add new merge</button>
                  </div>
                </>
              )}

              <div className="ds-modal-actions">
                <button className="btn btn-ghost" onClick={() => runGenerate([])}>Skip merging</button>
                <button className="btn btn-primary" onClick={finishMerges}><Sparkles size={16} /> Generate datesheet</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* ── Start-fresh cleanup modal ── */}
      <Modal open={cleanOpen} onClose={() => !cleaning && setCleanOpen(false)} title="Start fresh" width={520}>
        <div className="ds-clean">
          <p className="ds-clean-lead">Choose what to clear. Courses, students, teachers and rooms are <b>never</b> touched — only generated files.</p>
          <div className="ds-clean-options">
            <button type="button" className={`ds-clean-opt danger ${cleanMode === 'all' ? 'active' : ''}`} onClick={() => setCleanMode('all')}>
              <div className="ds-clean-opt-head"><Trash2 size={16} /> Delete everything</div>
              <div className="ds-clean-opt-body">
                {cleanPreview
                  ? <><b>{cleanPreview.all.removedDatesheets}</b> datesheet(s) and <b>{cleanPreview.all.removedAdmitBatches}</b> admit-card batch(es), incl. the latest ones</>
                  : <span className="ds-clean-loading"><Loader2 size={13} className="spin" /> counting…</span>}
              </div>
              <div className="ds-clean-opt-note">Then generate new BS · B.Tech · MS datesheets and admit cards.</div>
            </button>
            <button type="button" className={`ds-clean-opt ${cleanMode === 'latest' ? 'active' : ''}`} onClick={() => setCleanMode('latest')}>
              <div className="ds-clean-opt-head"><CheckCircle2 size={16} /> Keep the latest only</div>
              <div className="ds-clean-opt-body">
                {cleanPreview
                  ? <>Keep BS {cleanPreview.latest.kept.bs || 0} · B.Tech {cleanPreview.latest.kept.btech || 0} · MS {cleanPreview.latest.kept.pg || 0}; delete <b>{cleanPreview.latest.removedDatesheets}</b> older datesheet(s) and <b>{cleanPreview.latest.removedAdmitBatches}</b> admit-card batch(es)</>
                  : <span className="ds-clean-loading"><Loader2 size={13} className="spin" /> counting…</span>}
              </div>
            </button>
          </div>
          <div className="ds-clean-warn"><AlertCircle size={14} /> Admit cards, their QR codes and PDFs are deleted in both options. This cannot be undone.</div>
          <div className="ds-clean-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setCleanOpen(false)} disabled={cleaning}>Cancel</button>
            <button type="button" className="btn btn-danger" onClick={runCleanup} disabled={cleaning || !cleanPreview}>
              {cleaning ? <><Loader2 size={15} className="spin" /> Deleting…</> : (cleanMode === 'all' ? 'Delete everything' : 'Delete old files')}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
