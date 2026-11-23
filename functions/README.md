# Tabebik booking and encounter Cloud Functions

This Firebase Functions v2 module is the trusted server boundary for patient booking creation, doctor booking inbox, in-person attendance/completion, and one-time encounter-code redemption.

## Exported callables

- `createPatientBooking`: accepts only an operational allowlist, validates an approved center and (for doctor appointments) a verified doctor plus active membership, then writes `patientUid` and `doctorUid` from trusted server-side identity data. Complaint, diagnosis, health history and medical payloads are rejected.
- `listPatientBookings`: returns only the signed-in patient's operational booking rows.
- `listDoctorBookings`: requires `role=doctor`, a `doctorLic` claim, and a verified `doctors/{doctorLic}.uid` matching the caller; returns operational fields only.
- `markEncounterArrived`: records attendance only for the doctor UID bound to the booking.
- `issueEncounterCode`: requires a previously recorded arrival, atomically marks the visit completed and issues a six-digit code. Only a peppered hash is stored; the raw code is returned once.
- `redeemEncounterCode`: any authenticated patient session may submit the code, but the server binds redemption to the exact `patientUid` on the booking. It checks 24-hour expiry, single use and a limit of five attempts per UID per 15 minutes. Successful redemption creates a non-medical `followUps/{bookingId}` link.
- `listPatientFollowUps`: returns the patient's linked visit metadata only; it does not return diagnosis, treatment or uploaded medical files.

All callables enforce Firebase App Check.

## Trusted identity requirements

- Doctor custom claims must be provisioned by a trusted Admin SDK process: `role: "doctor"` and `doctorLic: "<verified council registration>"`.
- The doctor profile `doctors/{doctorLic}` must be verified and its `uid` must match the caller.
- Do not let either mobile client set its own custom claims.
- Patient booking ownership uses the authenticated Firebase UID; no client-supplied `patientUid` or patient role claim is trusted.
- The patient app currently uses anonymous Firebase Auth. Its UID is stable for that installation/session but is not phone-verified; clearing app data or reinstalling can lose access to that UID's bookings.

## Required deployment setup

1. Confirm that the doctor app and patient app target the same Firebase project. The patient app's checked-in Android options identify `tabibek-2f25e`; the doctor repository does not currently contain a checked-in `.firebaserc`, `google-services.json`, or `firebase_options.dart`, so project equality is not established by this repository.
2. Configure the Firebase project explicitly in the deployment environment.
3. Register the Android apps with Firebase App Check and confirm Play Integrity attestation works on target devices.
4. Set the secret: `firebase functions:secrets:set ENCOUNTER_CODE_PEPPER`.
5. Run `npm install` and `npm run build` from `functions/`.
6. Deploy only after reviewing the rules, custom claims and booking schema.

## Important limits

- Functions have been added to source control; they have **not** been deployed.
- Firestore and Storage rules remain fail-closed. Do not loosen them to make direct client reads work.
- The center Flutter UI is still using local/demo login and booking state; its callable integration and trusted Firebase session are not complete.
- The doctor app's follow-up exam/treatment/referral actions are still local UI state. The patient screen currently lists linked visits only; medical follow-up content and uploads are not yet synchronized.
- No medical record is stored or shared by these functions. The encounter code proves a completed in-person visit; it does not enable remote diagnosis or treatment.
