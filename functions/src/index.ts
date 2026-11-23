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
/**
 * تسجيل وصول المريض. لا يسمح إلا للطبيب المعيّن على الحجز بتأكيد الحضور.
 */
export const markEncounterArrived = onCall({enforceAppCheck:true}, async (request) => {
  const uid = requireRole(request, "doctor");
  const bookingId = request.data?.bookingId;
  if (!validId(bookingId)) throw new HttpsError("invalid-argument", "معرّف الحجز غير صالح.");
  const doctorLic = request.auth!.token.doctorLic;
  const ref = db.collection("bookings").doc(bookingId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "الحجز غير موجود.");
    const b = snap.data()!;
    if (!doctorLic || (b.doctorUid !== uid && b.doctorLic !== doctorLic)) {
      throw new HttpsError("permission-denied", "هذا الحجز غير مرتبط بحساب الطبيب.");
    }
    if (b.status !== "مؤكد" || Number(b.type ?? 0) !== 0) {
      throw new HttpsError("failed-precondition", "الحجز ليس موعد كشف طبيب مؤكداً.");
    }
    const visit = b.visit ?? {};
    if (visit.state === 2 || visit.state === 3) {
      throw new HttpsError("failed-precondition", "لا يمكن بدء كشف مكتمل أو ملغي.");
    }
    tx.set(ref, {
      visit: {state: 1, arrived: true, arrivedAt: FieldValue.serverTimestamp()},
      updatedAt: FieldValue.serverTimestamp()
    }, {merge:true});
  });
  return {arrived:true, bookingId};
});

/**
 * إنهاء المقابلة الحضورية وإصدار كود لمرة واحدة في معاملة ذرية.
 * لا يعتمد على status يرسله تطبيق الطبيب؛ الخادم يثبت الإسناد والحضور ثم يحدّث الحجز.
 */
export const issueEncounterCode = onCall({secrets:[pepper], enforceAppCheck:true}, async (request) => {
  const uid = requireRole(request, "doctor");
  const bookingId = request.data?.bookingId;
  if (!validId(bookingId)) throw new HttpsError("invalid-argument", "معرّف الحجز غير صالح.");
  const doctorLic = request.auth!.token.doctorLic;
  if (!doctorLic) throw new HttpsError("permission-denied", "حساب الطبيب غير موثّق على الخادم.");

  const bookingRef = db.collection("bookings").doc(bookingId);
  const encounterRef = db.collection("encounters").doc(bookingId);
  const now = Date.now();
  const code = String(randomInt(100000, 1000000));
  const codeHash = hashCode(code);

  await db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);
    const encounterSnap = await tx.get(encounterRef);
    if (!bookingSnap.exists) throw new HttpsError("not-found", "الحجز غير موجود.");
    const booking = bookingSnap.data()!;
    if (booking.doctorUid !== uid && booking.doctorLic !== doctorLic) {
      throw new HttpsError("permission-denied", "هذا الحجز غير مرتبط بحساب الطبيب.");
    }
    if (booking.status !== "مؤكد" || booking.visit?.state !== 1 || booking.visit?.arrived !== true) {
      throw new HttpsError("failed-precondition", "سجّل حضور المريض وابدأ الكشف قبل إنهائه.");
    }
    if (typeof booking.patientUid !== "string" || !booking.patientUid) {
      throw new HttpsError("failed-precondition", "الحجز غير مرتبط بهوية مستخدم للمريض.");
    }
    const old = encounterSnap.data();
    if (old?.status === "redeemed") {
      throw new HttpsError("already-exists", "تم ربط المتابعة لهذا الحجز مسبقاً.");
    }
    if (old?.status === "issued" && old.expiresAt instanceof Timestamp && old.expiresAt.toMillis() > now) {
      throw new HttpsError("already-exists", "يوجد رمز صالح لهذا الحجز بالفعل؛ لا يمكن إصدار رمز بديل.");
    }
    tx.set(encounterRef, {
      bookingId, patientUid: booking.patientUid, doctorUid: uid,
      doctorLic: String(doctorLic), centerId: String(booking.centerId ?? ""),
      codeHash, status: "issued", inPersonConfirmed: true,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + ttlMs),
      redeemedAt: null, updatedAt: FieldValue.serverTimestamp()
    });
    tx.set(bookingRef, {
      status: "مكتمل",
      visit: {state: 2, arrived: true, completedAt: FieldValue.serverTimestamp()},
      encounterIssued: true,
      updatedAt: FieldValue.serverTimestamp()
    }, {merge:true});
  });

  // الرمز الخام يُعرض للطبيب مرة واحدة فقط ولا يُخزّن في Firestore.
  return {code, expiresAt: now + ttlMs, encounterId: bookingId, bookingId};
});

/** المريض المرتبط بالحجز فقط يستطيع استهلاك الرمز مرة واحدة. */
export const redeemEncounterCode = onCall({secrets:[pepper], enforceAppCheck:true}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
  const uid = request.auth.uid as string;
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
