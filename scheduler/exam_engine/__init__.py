"""
exam_engine — end-to-end examination pipeline for Abasyn University Islamabad Campus.

    ingest   : read ANY uploaded registration / class-wise / timetable / rooms file
    rules    : exam eligibility, cohort classification, fixed slot policies
    pipeline : datesheets (BS · B.Tech · MS) → unified seating → admit cards →
               identification sheets → invigilation roster (→ optional timetable)
    audit    : independent verifier — re-checks every output against the source data

The pipeline NEVER edits source data. Normalisation (upper-casing codes, trimming
spaces) is applied to lookup keys only; every original value is kept and reported.
"""
__version__ = "1.0.0"
