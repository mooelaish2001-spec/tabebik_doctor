# Firebase security baseline — Tabebik

This repository uses the same fail-closed Firebase rules as the user and center apps. Medical and booking documents remain client-inaccessible until the mixed booking/profile schema is separated, trusted custom claims and explicit patient consent are implemented, and Firebase Emulator role tests pass.

Trusted custom claims must be set only by an Admin SDK backend: patient role; doctor role plus verified doctorLic; center_manager or center_reception role plus approved centerId; platformAdmin true for platform administrators. Never trust client-written roles, phone-number document IDs, or client-supplied membership status.

Current booking documents mix operational fields with complaint and health fields. Firestore rules cannot redact fields, so allowing a center to read a booking would expose medical data. The users documents also mix profile and health information. The rules therefore deny client access to users, bookings, private booking documents, encounters, medicalRecords and followUps until migration.

Target model: non-medical users/{uid}; patients/{uid}/medical/{recordId}; operational-only bookings/{bookingId}; bookings/{bookingId}/private/{recordId}; patientDoctorGrants/{grantId} with patientUid, doctorUid, bookingId, active and revocation timestamps; centerMembers keyed by Firebase UID and server-managed; public verified doctors; server-linked encounters and followUps; encrypted medical files under medical/{patientUid}/{recordId}/{fileId}.

Before real medical data is stored, implement client-side authenticated encryption (AES-256-GCM or vetted AEAD), fresh nonce per encryption, random per-record/file data keys, managed key wrapping, secure key recovery and rotation, doctor key sharing and revocation. Keep keys out of Flutter source, Firestore and remote config. Never log plaintext, keys, tokens or medical payloads.

Deployment gates: schema migration; trusted claims provisioning; explicit patient consent and doctor assignment; rules for separated schema; Emulator tests for unauthenticated, patient owner, assigned/unrelated doctor, center manager, reception and admin; security review. Do not deploy until all gates pass.