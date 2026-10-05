import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, FileSpreadsheet, FileDown, Printer, Sparkles } from 'lucide-react';
import { Modal, Spinner } from './ui';
import FancySelect from './FancySelect';
import { useToast } from '../context/ToastContext';
import './reportbuilder.css';

const TYPES = ['Timetable', 'Exam Date Sheet', 'Seating Plan', 'Faculty Workload', 'Room Utilization', 'Clash Report', 'Student Attendance'];
const SEMESTERS = ['Fall', 'Spring', 'Summer'];
const STATUSES = ['All', 'Published', 'Draft', 'Clash-free', 'Has clashes'];

export default function CustomReportBuilder({ open, onClose }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({
    type: 'Timetable', from: '', to: '', department: '', program: '',
    faculty: '', course: '', room: '', section: '', semester: 'Summer', status: 'All',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const run = (fmt) => {
    setBusy(fmt);
    setTimeout(() => {
      setBusy('');
      onClose();
      toast.success(`${form.type} report queued as ${fmt}. Opening Reports…`);
      const q = new URLSearchParams({ builder: '1', type: form.type, fmt }).toString();
      navigate(`/reports?${q}`);
    }, 700);
  };

  return (
    <Modal open={open} onClose={onClose} title="Custom Report Builder" width={720}>
      <div className="rb">
        <div className="rb-intro">
          <span className="rb-intro-ic"><Sparkles size={18} /></span>
          <span>Pick your filters, then export as PDF, Excel, CSV or print.</span>
        </div>

        <div className="rb-grid">
          <label className="field rb-col-2">
            <span>Report type</span>
            <FancySelect value={form.type} onChange={(v) => set('type')({ target: { value: v } })} clearable={false} width="100%" options={TYPES} />
          </label>

          <label className="field"><span>From</span><input type="date" className="input" value={form.from} onChange={set('from')} /></label>
          <label className="field"><span>To</span><input type="date" className="input" value={form.to} onChange={set('to')} /></label>

          <label className="field"><span>Department</span><input className="input" placeholder="All departments" value={form.department} onChange={set('department')} /></label>
          <label className="field"><span>Program</span><input className="input" placeholder="All programs" value={form.program} onChange={set('program')} /></label>

          <label className="field"><span>Faculty</span><input className="input" placeholder="All faculty" value={form.faculty} onChange={set('faculty')} /></label>
          <label className="field"><span>Course</span><input className="input" placeholder="All courses" value={form.course} onChange={set('course')} /></label>

          <label className="field"><span>Room / Lab</span><input className="input" placeholder="All rooms" value={form.room} onChange={set('room')} /></label>
          <label className="field"><span>Section</span><input className="input" placeholder="All sections" value={form.section} onChange={set('section')} /></label>

          <label className="field"><span>Semester</span>
            <FancySelect value={form.semester} onChange={(v) => set('semester')({ target: { value: v } })} clearable={false} width="100%" options={SEMESTERS} />
          </label>
          <label className="field"><span>Status</span>
            <FancySelect value={form.status} onChange={(v) => set('status')({ target: { value: v } })} clearable={false} width="100%" options={STATUSES} />
          </label>
        </div>

        <div className="rb-actions">
          <button className="rb-exp" disabled={!!busy} onClick={() => run('PDF')}>
            {busy === 'PDF' ? <Spinner size={16} /> : <FileText size={16} />} PDF
          </button>
          <button className="rb-exp" disabled={!!busy} onClick={() => run('Excel')}>
            {busy === 'Excel' ? <Spinner size={16} /> : <FileSpreadsheet size={16} />} Excel
          </button>
          <button className="rb-exp" disabled={!!busy} onClick={() => run('CSV')}>
            {busy === 'CSV' ? <Spinner size={16} /> : <FileDown size={16} />} CSV
          </button>
          <button className="rb-exp" disabled={!!busy} onClick={() => run('Print')}>
            {busy === 'Print' ? <Spinner size={16} /> : <Printer size={16} />} Print
          </button>
        </div>
      </div>
    </Modal>
  );
}
