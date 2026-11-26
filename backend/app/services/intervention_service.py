"""Create idempotent mentor follow-ups from recorded academic risk signals."""

from app.firebase.client import db
from app.services.notification_service import NotificationService
from app.utils.helpers import get_timestamp


LOW_ATTENDANCE_PERCENT = 40.0
LOW_CGPA = 6.0
LOW_SUBJECT_AVERAGE = 50.0
ACTIVE_MEETING_STATUSES = {"REQUESTED", "APPROVED", "SCHEDULED", "ONGOING", "IN_PROGRESS"}


def _support_summary(signals: list[str], metrics: dict) -> str:
    reason_parts = []
    if "LOW_ATTENDANCE" in signals:
        reason_parts.append(f"attendance {metrics.get('attendance', 0):.1f}% across {metrics.get('attendanceSessions', 0)} recorded class sessions")
    if "LOW_CGPA" in signals:
        reason_parts.append(f"CGPA {metrics.get('cgpa', 0):.2f}/10")
    if "LOW_SGPA" in signals:
        reason_parts.append(f"latest SGPA {metrics.get('latestSGPA', 0):.2f}/10")
    if "LOW_SUBJECT_AVERAGE" in signals:
        reason_parts.append(f"latest subject average {metrics.get('latestSubjectAverage', 0):.1f}%")
    return "; ".join(reason_parts)


def _ensure_support_notifications(meeting_id: str, meeting: dict) -> None:
    """Deliver each intervention notice once; later scans can retry failures."""
    notifier = NotificationService()
    name = meeting.get("studentName") or "Student"
    reasons = meeting.get("supportSummary") or "recorded academic indicators"
    notifications = [
        (
            meeting.get("mentorId"), "Student support meeting needs scheduling",
            f"Please arrange a check-in with {name}. Recorded indicators: {reasons}. Confirm the record with the student and choose a suitable time.",
        ),
        (
            meeting.get("studentId"), "Your mentor will arrange a support check-in",
            "Your recorded academic information suggests a check-in could be helpful. Your mentor will contact you to choose a suitable time and discuss support.",
        ),
    ]
    for user_id, title, message in notifications:
        if not user_id:
            continue
        fingerprint = str(meeting.get("interventionFingerprint") or "current")
        notification_id = f"academic-support-{meeting_id}-{user_id}-{fingerprint}"
        existing = notifier.notification_repo.collection_ref.document(notification_id).get()
        if existing.exists:
            continue
        try:
            notifier.create_notification(
                user_id=user_id,
                notif_type="MEETING_REQUESTED",
                title=title,
                message=message,
                related_id=meeting_id,
                notification_id=notification_id,
            )
        except Exception:
            # A future mentor scan or data update can retry this delivery.
            continue


def support_signals(student: dict) -> tuple[list[str], dict]:
    """Return explainable triggers using only recorded attendance and marks."""
    signals = []
    metrics = {}
    try:
        attendance = float(student.get("attendance"))
        sessions = int(student.get("attendanceSessions") or 0)
    except (TypeError, ValueError):
        attendance, sessions = 0, 0
    if sessions > 0:
        metrics.update({"attendance": round(attendance, 1), "attendanceSessions": sessions})
        if attendance <= LOW_ATTENDANCE_PERCENT:
            signals.append("LOW_ATTENDANCE")

    for field, signal in (("cgpa", "LOW_CGPA"), ("latestSGPA", "LOW_SGPA")):
        try:
            score = float(student.get(field) or 0)
        except (TypeError, ValueError):
            score = 0
        if score > 0:
            metrics[field] = score
            if score < LOW_CGPA:
                signals.append(signal)

    try:
        average = float(student.get("latestSubjectAverage"))
    except (TypeError, ValueError):
        average = None
    if average is not None:
        metrics["latestSubjectAverage"] = average
        if average < LOW_SUBJECT_AVERAGE:
            signals.append("LOW_SUBJECT_AVERAGE")

    return sorted(set(signals)), metrics


def ensure_student_support_meeting(student_id: str, requested_by: dict | None = None) -> dict | None:
    """Create one mentor-owned request for a student with current support signals.

    Repeated attendance/result recalculations share a fingerprint, so they do not
    create duplicate requests. The fingerprint clears after the student recovers.
    """
    if not db or not student_id:
        return None

    student_ref = db.collection("students").document(student_id)
    student_snapshot = student_ref.get()
    if not student_snapshot.exists:
        return None
    student = student_snapshot.to_dict() or {}
    signals, metrics = support_signals(student)
    fingerprint = "|".join(signals)
    reasons = _support_summary(signals, metrics)
    attendance_low = "LOW_ATTENDANCE" in signals
    score_signals = [signal for signal in signals if signal != "LOW_ATTENDANCE"]

    if not fingerprint:
        if student.get("supportInterventionFingerprint"):
            student_ref.update({"supportInterventionFingerprint": None})
        return None

    status = str(student.get("status") or "").lower()
    if status not in {"", "approved", "active"} or student.get("isApproved", True) is False:
        return None

    mentor_id = student.get("mentorId")
    if not mentor_id:
        return None
    mentor_snapshot = db.collection("faculty").document(mentor_id).get()
    mentor = mentor_snapshot.to_dict() or {} if mentor_snapshot.exists else {}
    if str(mentor.get("status") or "approved").lower() not in {"approved", "active"} or mentor.get("isApproved", True) is False:
        return None

    meetings = db.collection("meetings").where("studentId", "==", student_id).stream()
    for meeting_doc in meetings:
        meeting = meeting_doc.to_dict() or {}
        if meeting.get("supportIntervention") is True:
            if meeting.get("status") in ACTIVE_MEETING_STATUSES:
                updated = {
                    "supportSignals": signals,
                    "supportMetrics": metrics,
                    "supportSummary": reasons,
                    "attendanceIntervention": attendance_low,
                    "academicIntervention": bool(score_signals),
                    "attendanceFlag": "FR" if attendance_low else None,
                    "interventionFingerprint": fingerprint,
                    "description": f"An academic support check-in is recommended based on recorded indicators: {reasons}. Confirm the records with the student, ask what support would help, and agree on a practical follow-up.",
                    "updatedAt": get_timestamp(),
                }
                meeting_doc.reference.update(updated)
                meeting.update(updated)
                _ensure_support_notifications(meeting_doc.id, meeting)
                student_ref.update({
                    "supportInterventionFingerprint": fingerprint,
                    "supportInterventionMeetingId": meeting_doc.id,
                })
                return {"meetingId": meeting_doc.id, "created": False, "status": meeting.get("status"), "signals": signals}
            if meeting.get("interventionFingerprint") == fingerprint:
                return {"meetingId": meeting_doc.id, "created": False, "status": meeting.get("status")}

    now = get_timestamp()
    meeting_ref = db.collection("meetings").document()
    name = student.get("name") or "Student"
    meeting_ref.set({
        "id": meeting_ref.id,
        "studentId": student_id,
        "studentName": name,
        "mentorId": mentor_id,
        "mentorName": mentor.get("name") or "Mentor",
        "department": student.get("department") or "",
        "departmentId": student.get("departmentId"),
        "schoolId": student.get("schoolId"),
        "schoolName": student.get("schoolName") or "",
        "type": "ACADEMIC",
        "title": "Student Academic Support Meeting",
        "description": f"An academic support check-in is recommended based on recorded indicators: {reasons}. Confirm the records with the student, ask what support would help, and agree on a practical follow-up.",
        "supportSummary": reasons,
        "status": "REQUESTED",
        "supportIntervention": True,
        "attendanceIntervention": attendance_low,
        "academicIntervention": bool(score_signals),
        "attendanceFlag": "FR" if attendance_low else None,
        "supportSignals": signals,
        "supportMetrics": metrics,
        "interventionFingerprint": fingerprint,
        "createdBy": (requested_by or {}).get("uid") or "ACADEMIC_MONITORING",
        "createdByRole": str((requested_by or {}).get("role") or "SYSTEM").upper(),
        "createdAt": now,
        "updatedAt": now,
    })
    student_ref.update({
        "supportInterventionFingerprint": fingerprint,
        "supportInterventionMeetingId": meeting_ref.id,
        "supportInterventionRequestedAt": now,
    })

    _ensure_support_notifications(meeting_ref.id, meeting_ref.get().to_dict() or {})
    return {"meetingId": meeting_ref.id, "created": True, "status": "REQUESTED", "signals": signals}
