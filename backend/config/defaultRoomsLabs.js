/**
 * Default Rooms & Labs — Abasyn University Islamabad Campus
 * ---------------------------------------------------------
 * This data was previously hard-coded inside the Python scheduler.
 * It now lives in MongoDB and is editable from the admin UI.
 * This file is ONLY used to seed an empty database on first run.
 *
 * After seeding, the single source of truth is the database.
 * The scheduler reads rooms/labs from a DB export, never from here.
 */

// Theory classrooms: name + seating capacity
const THEORY_ROOMS = [
  { name: 'I101', capacity: 23 }, { name: 'I103', capacity: 25 },
  { name: 'I104', capacity: 27 }, { name: 'I105', capacity: 8 },
  { name: 'I106', capacity: 20 }, { name: 'I108', capacity: 40 },
  { name: 'I109', capacity: 38 }, { name: 'I110', capacity: 44 },
  { name: 'I111', capacity: 30 }, { name: 'I112', capacity: 44 },
  { name: 'I113', capacity: 33 }, { name: 'I114', capacity: 30 },
  { name: 'I115', capacity: 35 }, { name: 'I116', capacity: 40 },
  { name: 'I201', capacity: 35 }, { name: 'I202', capacity: 25 },
  { name: 'I203', capacity: 22 }, { name: 'I204', capacity: 30 },
  { name: 'I205', capacity: 27 }, { name: 'I206', capacity: 25 },
  { name: 'I208', capacity: 33 }, { name: 'I209', capacity: 35 },
  { name: 'I210', capacity: 34 }, { name: 'I211', capacity: 33 },
  { name: 'I212', capacity: 45 }, { name: 'I213', capacity: 26 },
  { name: 'I214', capacity: 33 }, { name: 'I215', capacity: 42 },
  { name: 'I216', capacity: 42 },
  { name: 'J209', capacity: 60 }, { name: 'J210', capacity: 62 },
  { name: 'J211', capacity: 40 }, { name: 'J214', capacity: 75 },
  { name: 'J215', capacity: 62 }, { name: 'J301', capacity: 65 },
  { name: 'J308', capacity: 67 }, { name: 'J310', capacity: 60 },
  { name: 'J311', capacity: 45 }, { name: 'J312', capacity: 70 },
  { name: 'J313', capacity: 60 }, { name: 'J315', capacity: 56 },
  { name: 'Auditorium', capacity: 300 },
];

// Laboratories: name + capacity + which departments use it (priority order matters)
// department keys: cs, ai, civil, ee, pharmd, dpt, mlt, vs, ot, rt, hnd, common
const LABS = [
  // ── Computing / AI / SE ──
  { name: 'GP Lab I', capacity: 42, departments: ['cs', 'ai', 'common'] },
  { name: 'GP Lab II', capacity: 45, departments: ['cs', 'ai', 'common'] },
  { name: 'GP Lab III', capacity: 30, departments: ['cs', 'ai'] },
  { name: 'CS Lab-1', capacity: 42, departments: ['cs', 'common'] },
  { name: 'CS Lab-2', capacity: 42, departments: ['cs'] },
  { name: 'CS Lab-3', capacity: 30, departments: ['cs', 'ai'] },
  { name: 'DLD Lab', capacity: 30, departments: ['cs'] },
  { name: 'Simulation Lab', capacity: 18, departments: ['cs'] },
  { name: 'High Performance Lab', capacity: 25, departments: ['cs'] },
  { name: 'AI Lab', capacity: 30, departments: ['ai'] },
  { name: 'Machine Learning Lab', capacity: 25, departments: ['ai'] },
  // ── Electrical Engineering ──
  { name: 'Electronics Lab', capacity: 30, departments: ['ee'] },
  { name: 'Circuits Lab', capacity: 30, departments: ['ee'] },
  { name: 'Power Systems Lab', capacity: 25, departments: ['ee'] },
  { name: 'Instrumentation Lab', capacity: 25, departments: ['ee'] },
  { name: 'High Voltage Lab', capacity: 20, departments: ['ee'] },
  // ── Civil Engineering ──
  { name: 'Engineering Drawing Lab', capacity: 35, departments: ['civil'] },
  { name: 'Surveying Lab', capacity: 30, departments: ['civil'] },
  { name: 'Fluid Mechanics Lab', capacity: 25, departments: ['civil'] },
  { name: 'Mechanics of Solids Lab', capacity: 25, departments: ['civil'] },
  { name: 'Transportation Engineering Lab', capacity: 25, departments: ['civil'] },
  { name: 'Concrete & Materials Lab', capacity: 25, departments: ['civil'] },
  // ── Pharmacy ──
  { name: 'Pharmaceutics Lab', capacity: 40, departments: ['pharmd'] },
  { name: 'Pharmacology Lab', capacity: 40, departments: ['pharmd'] },
  { name: 'Biochemistry Lab', capacity: 40, departments: ['pharmd'] },
  { name: 'Microbiology Lab', capacity: 40, departments: ['pharmd'] },
  { name: 'Chemistry Lab', capacity: 40, departments: ['pharmd'] },
  // ── Physical Therapy (DPT) ──
  { name: 'Physiology Lab', capacity: 30, departments: ['dpt'] },
  { name: 'Anatomy Lab', capacity: 20, departments: ['dpt'] },
  { name: 'Electrotherapy Lab', capacity: 2, departments: ['dpt'] },
  { name: 'Kinesiology Lab', capacity: 25, departments: ['dpt'] },
  { name: 'Rehabilitation Lab', capacity: 25, departments: ['dpt'] },
  // ── Medical Lab Technology ──
  { name: 'MLT Lab 1', capacity: 30, departments: ['mlt'] },
  { name: 'MLT Lab 2', capacity: 5, departments: ['mlt'] },
  { name: 'Pathology Lab', capacity: 30, departments: ['mlt'] },
  { name: 'Hematology Lab', capacity: 30, departments: ['mlt'] },
  { name: 'Clinical Chemistry Lab', capacity: 30, departments: ['mlt'] },
  { name: 'Histopathology Lab', capacity: 30, departments: ['mlt'] },
  // ── Vision Sciences ──
  { name: 'Optometry Lab', capacity: 12, departments: ['vs'] },
  { name: 'Vision Sciences Lab', capacity: 12, departments: ['vs'] },
  // ── Operation Theatre ──
  { name: 'Operation Theater Lab', capacity: 20, departments: ['ot'] },
  { name: 'Surgical Skills Lab', capacity: 20, departments: ['ot'] },
  // ── Radiology ──
  { name: 'Radiology Lab', capacity: 30, departments: ['rt'] },
  { name: 'RT Lab', capacity: 30, departments: ['rt'] },
  { name: 'Imaging Lab', capacity: 25, departments: ['rt'] },
  // ── Human Nutrition & Dietetics ──
  { name: 'HND Lab', capacity: 12, departments: ['hnd'] },
  { name: 'Nutrition Lab', capacity: 12, departments: ['hnd'] },
  { name: 'Food Analysis Lab', capacity: 12, departments: ['hnd'] },
];

// Time structure (also editable later, but stable enough to seed)
const TIME_CONFIG = {
  days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  theorySlots: ['08:30-10:00', '10:00-11:30', '11:30-01:00', '02:00-03:30', '03:30-05:00'],
  labSlots: ['08:30-11:30', '09:00-12:00', '10:00-01:00', '02:00-05:00'],
  lunchBreak: '01:00-02:00',
};

module.exports = { THEORY_ROOMS, LABS, TIME_CONFIG };
