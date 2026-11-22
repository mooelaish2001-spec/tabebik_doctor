import {initializeApp} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import {defineSecret} from "firebase-functions/params";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {randomInt, createHash} from "node:crypto";

initializeApp();
const db = getFirestore();
const pepper = defineSecret("ENCOUNTER_CODE_PEPPER");
const ttlMs = 24 * 60 * 60 * 1000;

function requireRole(request: any, role: "doctor" | "patient"): string {
  if (!request.auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
  if (request.auth.token.role !== role) throw new HttpsError("permission-denied", "ليس لديك صلاحية لهذه العملية.");
  return request.auth.uid as string;
}
function hashCode(code: string): string {
  return createHash("sha256").update(pepper.value() + ":" + code).digest("hex");
}
function validId(v: unknown): v is string {
  return typeof v === "string" && v.length > 5 && v.length < 160;
}

/**
 * الطبيب يصدر الرمز فقط بعد أن يثبت booking.visit.state=2 وstatus=مكتمل.
 * يجب أن تمنح جهة موثوقة custom claim role=doctor وdoctorLic للطبيب.
 */
export const issueEncounterCode = onCall({secrets:[pepper], enforceAppCheck:true}, async (request) => {
  const uid = requireRole(request, "doctor");
  const bookingId = request.data?.bookingId;
  if (!validId(bookingId)) throw new HttpsError("invalid-argument", "معرّف الحجز غير صالح.");
  const bookingRef = db.collection("bookings").doc(bookingId);
  const encounterRef = db.collection("encounters").doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists) throw new HttpsError("not-found", "الحجز غير موجود.");
  const booking = bookingSnap.data()!;
  const doctorLic = request.auth!.token.doctorLic;
  if (!doctorLic || (booking.doctorUid !== uid && booking.doctorLic !== doctorLic)) {
    throw new HttpsError("permission-denied", "هذا الحجز غير مرتبط بحساب الطبيب.");
  }
  if (booking.status !== "مكتمل" || booking.visit?.state !== 2 || booking.visit?.arrived !== true) {
    throw new HttpsError("failed-precondition", "لا يمكن إصدار الرمز قبل إكمال المقابلة الحضورية وتسجيل الحضور.");
  }
  if (typeof booking.patientUid !== "string" || !booking.patientUid) {
    throw new HttpsError("failed-precondition", "الحجز غير مرتبط بحساب مريض موثّق.");
  }

  const now = Date.now();
  const existing = await encounterRef.get();
  if (existing.exists && existing.data()?.status === "issued" && existing.data()?.expiresAt?.toMillis?.() > now) {
    throw new HttpsError("already-exists", "يوجد رمز صالح لهذا الحجز بالفعل.");
  }
  const code = String(randomInt(100000, 1000000));
  const codeHash = hashCode(code);
  await db.runTransaction(async tx => {
    const current = await tx.get(encounterRef);
    const currentData = current.data();
    if (currentData?.status === "redeemed") {
      throw new HttpsError("already-exists", "تم ربط المتابعة لهذا الحجز مسبقاً.");
    }
    if (currentData?.status === "issued" &&
        currentData.expiresAt instanceof Timestamp &&
        currentData.expiresAt.toMillis() > now) {
      throw new HttpsError("already-exists", "يوجد رمز صالح لهذا الحجز بالفعل.");
    }
    tx.set(encounterRef, {
      bookingId, patientUid: booking.patientUid, doctorUid: uid,
      doctorLic: String(doctorLic), centerId: String(booking.centerId ?? ""),
      codeHash, status: "issued", inPersonConfirmed: true,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + ttlMs),
      redeemedAt: null, updatedAt: FieldValue.serverTimestamp()
    });
  });
  // الرمز الخام يُعرض للطبيب مرة واحدة فقط ولا يُخزّن في Firestore.
  return {code, expiresAt: now + ttlMs, encounterId: bookingId};
});

/** المريض المرتبط بالحجز فقط يستطيع استهلاك الرمز مرة واحدة. */
export const redeemEncounterCode = onCall({secrets:[pepper], enforceAppCheck:true}, async (request) => {
  const uid = requireRole(request, "patient");
  const code = request.data?.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new HttpsError("invalid-argument", "أدخل رمزاً مكوناً من ستة أرقام.");
  }
  const codeHash = hashCode(code);
  const q = await db.collection("encounters").where("codeHash", "==", codeHash).limit(1).get();
  if (q.empty) throw new HttpsError("not-found", "الرمز غير صحيح أو منتهي الصلاحية.");
  const ref = q.docs[0].ref;
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "الرمز غير متاح.");
    const e = snap.data()!;
    if (e.patientUid !== uid) throw new HttpsError("permission-denied", "هذا الرمز لا يخص حسابك.");
    if (e.status !== "issued") throw new HttpsError("failed-precondition", "تم استخدام الرمز أو إبطاله مسبقاً.");
    if (!(e.expiresAt instanceof Timestamp) || e.expiresAt.toMillis() <= Date.now()) {
      tx.update(ref, {status:"expired", updatedAt:FieldValue.serverTimestamp()});
      throw new HttpsError("deadline-exceeded", "انتهت صلاحية الرمز.");
    }
    const bookingRef = db.collection("bookings").doc(e.bookingId);
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists || bookingSnap.data()?.patientUid !== uid ||
        bookingSnap.data()?.status !== "مكتمل" || bookingSnap.data()?.visit?.state !== 2) {
      throw new HttpsError("failed-precondition", "تعذر إثبات المقابلة لهذا الحجز.");
    }
    tx.update(ref, {status:"redeemed", redeemedAt:FieldValue.serverTimestamp(), updatedAt:FieldValue.serverTimestamp()});
    return {encounterId:e.bookingId, bookingId:e.bookingId, doctorLic:e.doctorLic, centerId:e.centerId, linked:true};
  });
});
