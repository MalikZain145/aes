#!/usr/bin/env python3
"""
Single-student / single-slot PDF renderer.

Used when the Exam Cell edits or deletes ONE student's course after admit cards
already exist. The authoritative seating lives in the backend (AdmitVerification);
the backend reads it, assembles the exact card + affected-slot layout, and calls
this script to re-print ONLY that one student's admit card and the seating plan
for the slot(s) they moved in — WITHOUT touching or re-seating anyone else.

It reuses admit_cards.py's render functions so the layout is byte-for-byte the
same as the full batch. Input is a single JSON config:

  {
    "out_admit":   "…/AdmitCard_<reg>.pdf",         # optional
    "out_seating": "…/Seating_<reg>.pdf",           # optional
    "meta": { campus_line, heading, exam_type, program_level, exam_label, term },
    "student": { sid, name, program, batch, _qr_url },
    "rows":    [ { sr, code, title, teacher, date, day, time, room, seat }, … ],
    "sessions_layout": [ { date, day, slot, rooms:[ {name, rows:[…]} ] }, … ]
  }
"""
import sys
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import admit_cards as ac   # noqa: E402  (reuse the exact batch renderers)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: render_one.py <config.json>"}))
        sys.exit(2)
    cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    meta = cfg.get("meta") or {}
    made = {}

    student = cfg.get("student")
    rows = cfg.get("rows") or []
    out_admit = cfg.get("out_admit")
    if student and out_admit:
        ac.render_admit_cards([(student, rows)], meta, out_admit)
        made["admit"] = out_admit

    sessions = cfg.get("sessions_layout") or []
    out_seating = cfg.get("out_seating")
    if sessions and out_seating:
        ac.render_seating_plan(sessions, meta, out_seating)
        made["seating"] = out_seating

    print(json.dumps({"ok": True, "made": made}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:      # surface a clean JSON error to the backend
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
