/**
 * Central navigation model for the Abasyn Scheduler shell — sidebar sections and
 * the top-bar mega menus. Everything points at REAL routes that exist in the app
 * (the backend is unchanged); download/report actions land on /reports with a
 * filter so the generated file can be picked up there.
 */
import {
  LayoutDashboard, BookOpen, Users, DoorOpen, Upload, CalendarRange, CalendarClock,
  Contact, ShieldCheck, FileBarChart2, Info, GraduationCap, Building2, Layers,
  CalendarDays, FileSpreadsheet, ShieldAlert, FileText, Download, BarChart3,
  Clock, UserCheck, ClipboardList, Sparkles, LayoutGrid,
} from 'lucide-react';

/* ── Sidebar (grouped, real routes only) ── */
// Admin (Exam Cell) sidebar — admit cards moved to the Finance portal.
export const SIDEBAR = [
  { section: 'Main' },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true },

  { section: 'Academics' },
  { to: '/courses', label: 'Courses', icon: BookOpen },
  { to: '/teachers', label: 'Faculty', icon: Users },
  { to: '/rooms-labs', label: 'Rooms & Labs', icon: DoorOpen },
  { to: '/import', label: 'Import Data', icon: Upload },

  { section: 'Scheduling' },
  { to: '/class-timetable', label: 'Timetable', icon: CalendarRange },
  { to: '/exam-engine', label: 'Exam Engine (1-click)', icon: Sparkles },
  { to: '/datesheets', label: 'Date Sheets', icon: CalendarClock },
  { to: '/attendance', label: 'Exam Attendance', icon: UserCheck },
  { to: '/constraints', label: 'Constraints', icon: ShieldCheck },

  { section: 'Registrations' },
  { to: '/people', label: 'People & Assignments', icon: UserCheck },
  { to: '/student-courses', label: 'Student Courses', icon: GraduationCap },
  { to: '/registrations', label: 'New Registration Forms', icon: ClipboardList },

  { section: 'Insights' },
  { to: '/views', label: 'Timetable Views', icon: BarChart3 },
  { to: '/reports', label: 'Reports & Analytics', icon: FileBarChart2 },
  { to: '/archive', label: 'Previous Semesters', icon: Layers },
  { to: '/about', label: 'About', icon: Info },
];

// Per-role sidebars. Finance/faculty/student get their own; admin uses the full one.
export const SIDEBAR_BY_ROLE = {
  admin: SIDEBAR,
  finance: [
    { to: '/admit-cards', label: 'Admit Cards', icon: Contact },
    { to: '/about', label: 'About', icon: Info },
  ],
  faculty: [
    { section: 'Faculty' },
    { to: '/faculty', label: 'Registration Forms', icon: FileBarChart2 },
    { to: '/about', label: 'About', icon: Info },
  ],
  student: [
    { section: 'Student' },
    { to: '/student', label: 'My Portal', icon: LayoutDashboard },
    { to: '/about', label: 'About', icon: Info },
  ],
};

// Role → label shown in the top bar.
export const ROLE_LABEL = {
  admin: 'Exam Cell', finance: 'Finance Office', faculty: 'Faculty', student: 'Student',
};

/* ── Top-bar mega menus ── */
export const MENUS = {
  Academics: {
    width: 560,
    columns: [
      {
        title: 'Master Data', sub: 'Live',
        items: [
          { icon: BookOpen, label: 'Courses', desc: 'All courses & sections', to: '/courses' },
          { icon: Users, label: 'Faculty', desc: 'Teachers & workload', to: '/teachers' },
          { icon: DoorOpen, label: 'Rooms & Labs', desc: 'Capacities & exam seats', to: '/rooms-labs' },
        ],
      },
      {
        title: 'Setup',
        items: [
          { icon: Upload, label: 'Import Data', desc: 'Registration / offering files', to: '/import' },
          { icon: GraduationCap, label: 'Programs & Batches', desc: 'From imported registrations', to: '/courses' },
          { icon: ShieldCheck, label: 'Constraints', desc: 'Scheduling rules', to: '/constraints' },
        ],
      },
    ],
  },

  Scheduling: {
    width: 560,
    columns: [
      {
        title: 'Timetable',
        items: [
          { icon: CalendarRange, label: 'Generate Timetable', desc: 'Clash-free BS & MS class schedule', to: '/class-timetable' },
          { icon: Building2, label: 'Room Allocation', desc: 'Room-wise schedule', to: '/rooms-labs' },
          { icon: ShieldAlert, label: 'Clash Report', desc: 'Scheduling conflicts', to: '/reports?filter=clash_report' },
        ],
      },
      {
        title: 'Date Sheets',
        items: [
          { icon: CalendarClock, label: 'Mid-Term Date Sheet', desc: 'Fall / Spring / Summer', to: '/datesheets?type=mids' },
          { icon: FileSpreadsheet, label: 'Final-Term Date Sheet', desc: 'Fall / Spring / Summer', to: '/datesheets?type=finals' },
          { icon: CalendarDays, label: 'Academic Calendar', desc: 'All generated sheets', to: '/datesheets' },
        ],
      },
    ],
  },

  // NOTE: admit cards are GENERATED + EMAILED by Finance only. Admin does not
  // generate — the admin dashboard shows a read-only admit-card strip (4 download
  // buttons) once Finance has generated them, so there is no admin "Exams" menu.
};

/* ── Downloads — the flagship four-column mega menu ── */
export const DOWNLOADS = {
  width: 680,
  columns: [
    {
      title: 'Academic',
      items: [
        { icon: BookOpen, label: 'Course List', desc: 'All courses — view & download', to: '/views?view=master' },
        { icon: Layers, label: 'Program List', desc: 'All programs — view & download', to: '/views?view=master' },
        { icon: Building2, label: 'Department List', desc: 'All departments — view & download', to: '/views?view=master' },
        { icon: Users, label: 'Faculty List', desc: 'All faculty — view & download', to: '/views?view=master' },
        { icon: DoorOpen, label: 'Room List', desc: 'All rooms & labs — view & download', to: '/views?view=master' },
      ],
    },
    {
      title: 'Schedule',
      items: [
        { icon: CalendarRange, label: 'Full Timetable', desc: 'Every session — Excel / PDF', to: '/views?view=day' },
        { icon: Building2, label: 'Department Timetable', desc: 'Arranged by program', to: '/views?view=program' },
        { icon: Users, label: 'Faculty Timetable', desc: 'Arranged by teacher', to: '/views?view=faculty' },
        { icon: DoorOpen, label: 'Room Timetable', desc: 'Arranged by room / lab', to: '/views?view=room' },
        { icon: CalendarDays, label: 'Academic Calendar', desc: 'Full academic calendar', to: '/datesheets' },
      ],
    },
    {
      title: 'Reports',
      items: [
        { icon: FileText, label: 'Daily Schedule Report', desc: 'Filter by day — Excel / PDF', to: '/views?view=day' },
        { icon: BarChart3, label: 'Room Utilization', desc: 'Sessions per room per slot', to: '/views?view=utilization' },
        { icon: Clock, label: 'Faculty Workload', desc: 'Sessions per faculty', to: '/views?view=faculty' },
        { icon: ShieldAlert, label: 'Clash Report', desc: 'All scheduling conflicts', to: '/reports?filter=clash_report' },
        { icon: Download, label: 'All Generated Files', desc: 'Every export in one place', to: '/reports' },
      ],
    },
  ],
  footer: {
    icon: Sparkles,
    title: 'Need something custom?',
    desc: 'Generate advanced reports with custom filters.',
    action: {
      label: 'Custom Report Builder',
      onClick: () => window.dispatchEvent(new CustomEvent('abasyn:report-builder')),
    },
  },
};
