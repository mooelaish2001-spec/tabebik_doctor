# Encounter verification backend

This Firebase Functions v2 module provides the trusted server boundary for the six-digit in-person encounter code.

## Required identity provisioning

- A trusted onboarding/admin process must set Firebase custom claims for patients: `role: "patient"`.
- It must set doctor claims: `role: "doctor"` and `doctorLic: "<verified council registration>"`.
- Do not let either mobile client set its own claims. The current apps' local/demo sign-in is not sufficient to authorize these callables.
- The booking document must contain `patientUid`, `doctorLic` (or `doctorUid`), `centerId`, `status: "مكتمل"`, and `visit: { state: 2, arrived: true }`. A client-side status update alone is not strong proof; production must restrict completion writes to the authenticated assigned doctor and preferably record a server-audited completion event.

## Deploy

1. Configure the Firebase project and Functions runtime in the deployment workspace.
2. Set a long random secret: `firebase functions:secrets:set ENCOUNTER_CODE_PEPPER`.
3. Install dependencies and run `npm run build` from this directory.
4. Deploy Functions only after reviewing Firestore rules and claims provisioning.

## Flow

1. Assigned doctor completes the in-person visit and calls `issueEncounterCode({bookingId})`.
2. Function checks the doctor identity, completed booking, attendance, and patient binding. It returns a six-digit code once; only a salted hash is stored.
3. Patient calls `redeemEncounterCode({code})`. The function verifies patient ownership, expiry (24 hours), and single use in a transaction.
4. Only then should the patient app expose the follow-up record. The code proves a completed in-person encounter; it does not authorize remote diagnosis or replace an in-person consultation.

The callables deliberately fail closed until trusted custom claims and authenticated booking ownership are implemented. No Firestore/Storage rules are loosened here.
