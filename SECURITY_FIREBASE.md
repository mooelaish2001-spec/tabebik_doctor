# Firebase security baseline — Tabebik

This repository uses the same fail-closed Firebase rules as the user and center apps. Medical and booking documents remain client-inaccessible until the mixed booking/profile schema is separated, trusted custom claims and explicit patient consent are implemented, and Firebase Emulator role tests pass.

Trusted custom claims must be set only by an Admin SDK backend: patient role; doctor role plus verified doctorLic; center_manager or center_reception role plus approved centerId; platformAdmin true for platform administrators. Never trust client-written roles, phone-number document IDs, or client-supplied membership status.

Current booking documents mix operational fields with complaint and health fields. Firestore rules cannot redact fields, so allowing a center to read a booking would expose medical data. The users documents also mix profile and health information. The rules therefore deny client access to users, bookings, private booking documents, encounters, medicalRecords and followUps until migration.

Target model: non-medical users/{uid}; patients/{uid}/medical/{recordId}; operational-only bookings/{bookingId}; bookings/{bookingId}/private/{recordId}; patientDoctorGrants/{grantId} with patientUid, doctorUid, bookingId, active and revocation timestamps; centerMembers keyed by Firebase UID and server-managed; public verified doctors; server-linked encounters and followUps; encrypted medical files under medical/{patientUid}/{recordId}/{fileId}.

Before real medical data is stored, implement client-side authenticated encryption (AES-256-GCM or vetted AEAD), fresh nonce per encryption, random per-record/file data keys, managed key wrapping, secure key recovery and rotation, doctor key sharing and revocation. Keep keys out of Flutter source, Firestore and remote config. Never log plaintext, keys, tokens or medical payloads.

Deployment gates: schema migration; trusted claims provisioning; explicit patient consent and doctor assignment; rules for separated schema; Emulator tests for unauthenticated, patient owner, assigned/unrelated doctor, center manager, reception and admin; security review. Do not deploy until all gates pass.

## 2026-11 backend integration stage
- The patient app now creates operational bookings through the `createPatientBooking` callable rather than direct Firestore writes. The server sets `patientUid`, resolves the verified doctor's Firebase UID, and validates the approved center/membership.
- The doctor app now requests its booking inbox through `listDoctorBookings`; attendance and visit completion use `markEncounterArrived` and `issueEncounterCode`.
- Patient booking status refresh and linked-visit list use `listPatientBookings` and `listPatientFollowUps`. The encounter code is one-time, expires after 24 hours, is stored only as a peppered hash, and redemption is rate-limited.
- The patient app's Firebase Auth identity is currently anonymous. It gives a Firebase UID for booking ownership but does not verify the entered phone number and may be lost if app data is cleared or the app is reinstalled.
- The center Flutter UI still uses local/demo state and is not yet connected to its callable booking APIs or a trusted Firebase Auth session.
- The doctor app's clinical follow-up actions (exam/treatment/referral and file exchange) remain local UI state. The patient follow-up screen currently lists linked visits only.
- Medical profile fields remain local and are not written to the booking document. No encrypted medical record sharing, consent grant lifecycle, key management or medical-file upload has been deployed.
- Firestore and Storage rules remain intentionally fail-closed. Do not loosen them. Functions source has not been deployed, the doctor repository's Firebase project binding is unconfirmed, and `ENCOUNTER_CODE_PEPPER` plus trusted doctor claims must be provisioned before any live test.
- These are staged source changes, not a production-ready deployment. Complete schema migration, custom-claim provisioning, consent lifecycle, encryption/key management, Firebase Emulator authorization tests and security review before storing real medical data.
