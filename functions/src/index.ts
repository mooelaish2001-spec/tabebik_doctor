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
const patientBookingKeys = new Set([
  "code", "type", "svc", "centerId", "doctorLic", "name", "phone",
  "age", "female", "title", "when", "dateIso", "timeMin", "place", "price"
]);

/** ينشئ حجزاً تشغيلياً من خلال الخادم؛ لا يقبل أي شكوى أو تشخيص أو سجل طبي. */
export const createPatientBooking = onCall({enforceAppCheck:true}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "يجب تسجيل الدخول أولاً.");
  const input = request.data ?? {};
  const unexpected = Object.keys(input).filter((key) => !patientBookingKeys.has(key));
  if (unexpected.length) throw new HttpsError("invalid-argument", "بيانات الحجز تحتوي حقولاً غير مسموح بها.");

  const type = Number(input.type);
  const svc = Number(input.svc ?? 0);
  const centerId = typeof input.centerId === "string" ? input.centerId.trim() : "";
  const doctorLic = typeof input.doctorLic === "string" ? input.doctorLic.trim() : "";
  const dateIso = typeof input.dateIso === "string" ? input.dateIso : "";
  const timeMin = Number(input.timeMin ?? 0);
  const age = Number(input.age ?? 0);
  const price = Number(input.price ?? 0);
  if (![0,1,2].includes(type) || ![0,1,2].includes(svc) ||
      !centerId || centerId.length > 160 ||
      typeof input.name !== "string" || !input.name.trim() || input.name.length > 120 ||
      typeof input.phone !== "string" || input.phone.length > 30 ||
      !Number.isInteger(age) || age < 0 || age > 120 ||
      typeof input.female !== "boolean" ||
      typeof input.title !== "string" || input.title.length > 180 ||
      typeof input.when !== "string" || input.when.length > 100 ||
      !/^\\d{4}-\\d{2}-\\d{2}$/.test(dateIso) ||
      !Number.isInteger(timeMin) || timeMin < 0 || timeMin > 1439 ||
      typeof input.place !== "string" || input.place.length > 220 ||
      !Number.isInteger(price) || price < 0 || price > 100000000) {
    throw new HttpsError("invalid-argument", "بيانات الحجز الأساسية غير مكتملة أو غير صحيحة.");
  }

  const centerRef = db.collection("centers").doc(centerId);
  const doctorRef = doctorLic ? db.collection("doctors").doc(doctorLic) : null;
  const membershipRef = doctorLic ? db.collection("memberships").doc(doctorLic + "_" + centerId) : null;
  if (type === 0 && (!doctorRef || !membershipRef)) {
    throw new HttpsError("failed-precondition", "حجز الطبيب يحتاج طبيباً ومركزاً مسجلين.");
  }
  const bookingRef = db.collection("bookings").doc();
  let doctorUid = "";

  await db.runTransaction(async tx => {
    const centerSnap = await tx.get(centerRef);
    const doctorSnap = doctorRef ? await tx.get(doctorRef) : null;
    const membershipSnap = membershipRef ? await tx.get(membershipRef) : null;
    if (!centerSnap.exists || centerSnap.data()?.status !== 1) {
      throw new HttpsError("failed-precondition", "المركز غير معتمد أو غير متاح للحجز.");
    }
    if (type === 0) {
      const doctor = doctorSnap?.data();
      if (!doctorSnap?.exists || doctor?.verified !== true || typeof doctor?.uid !== "string" || !doctor.uid ||
          membershipSnap?.data()?.status !== "active") {
        throw new HttpsError("failed-precondition", "الطبيب أو عضويته في المركز غير معتمدين للحجز.");
      }
      doctorUid = doctor.uid;
    }
    tx.create(bookingRef, {
      code: typeof input.code === "string" ? input.code.slice(0, 40) : "",
      type, svc, centerId, doctorLic, doctorUid,
      name: input.name.trim(), patientName: input.name.trim(),
      phone: input.phone.trim(), patientPhone: input.phone.trim(),
      age, female: input.female,
      title: input.title.trim(), when: input.when.trim(),
      dateIso, timeMin, place: input.place.trim(), price,
      patientUid: request.auth!.uid,
      status: "جديد",
      visit: {state: 0, arrived: false},
      encounterIssued: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  return {bookingId: bookingRef.id, created:true};
});

/** قائمة تشغيلية للطبيب الموثّق فقط؛ لا تعيد أي حقل طبي. */
export const listDoctorBookings = onCall({enforceAppCheck:true}, async (request) => {
  const uid = requireRole(request, "doctor");
  const doctorLic = request.auth!.token.doctorLic;
  if (typeof doctorLic !== "string" || !doctorLic) {
    throw new HttpsError("permission-denied", "حساب الطبيب غير موثّق على الخادم.");
  }
  const doctorSnap = await db.collection("doctors").doc(doctorLic).get();
  if (!doctorSnap.exists || doctorSnap.data()?.uid !== uid || doctorSnap.data()?.verified !== true) {
    throw new HttpsError("permission-denied", "هوية الطبيب غير معتمدة.");
  }
  const snap = await db.collection("bookings").where("doctorUid", "==", uid).limit(100).get();
  const keys = ["type", "svc", "centerId", "doctorLic", "doctorUid", "name", "phone", "age", "female",
    "title", "when", "dateIso", "timeMin", "place", "price", "status", "visit", "encounterIssued"];
  return {bookings:snap.docs.map(doc => {
    const data = doc.data();
    const row: Record<string, unknown> = {id:doc.id, bookingId:doc.id};
    for (const key of keys) if (data[key] !== undefined) row[key] = data[key];
    return row;
  })};
});

/**
 * تسجيل وصول المريض. لا يسمح إلا للطبيب المعيّن على الحجز بتأكيد الحضور.
 */
export const markEncounterArrived = onCall({enforceAppCheck:true}, async (request) => {
  const uid = requireRole(request, "doctor");
  const bookingId = request.data?.bookingId;
  if (!validId(bookingId)) throw new HttpsError("invalid-argument", "معرّف الحجز غير صالح.");
  const doctorLic = request.auth!.token.doctorLic;
  const ref = db.collection("bookings").doc(bookingId);
  const doctorRef = doctorLic ? db.collection("doctors").doc(String(doctorLic)) : null;
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const doctorSnap = doctorRef ? await tx.get(doctorRef) : null;
    if (!snap.exists) throw new HttpsError("not-found", "الحجز غير موجود.");
    const b = snap.data()!;
    if (!doctorLic || b.doctorLic !== doctorLic || !doctorSnap?.exists || doctorSnap.data()?.uid !== uid || doctorSnap.data()?.verified !== true) {
      throw new HttpsError("permission-denied", "هوية الطبيب أو ارتباطه بالحجز غير موثّق.");
    }
    if (b.status !== "مؤكد" || Number(b.type ?? 0) !== 0) {
      throw new HttpsError("failed-precondition", "الحجز ليس موعد كشف طبيب مؤكداً.");
    }
    const visit = b.visit ?? {};
    if (visit.state === 2 || visit.state === 3) {
      throw new HttpsError("failed-precondition", "لا يمكن بدء كشف مكتمل أو ملغي.");
    }
    tx.set(ref, {
      doctorUid: uid,
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

  const doctorRef = db.collection("doctors").doc(String(doctorLic));
  const bookingRef = db.collection("bookings").doc(bookingId);
  const encounterRef = db.collection("encounters").doc(bookingId);
  const now = Date.now();
  const code = String(randomInt(100000, 1000000));
  const codeHash = hashCode(code);

  await db.runTransaction(async tx => {
    const bookingSnap = await tx.get(bookingRef);
    const encounterSnap = await tx.get(encounterRef);
    const doctorSnap = await tx.get(doctorRef);
    if (!bookingSnap.exists) throw new HttpsError("not-found", "الحجز غير موجود.");
    const booking = bookingSnap.data()!;
    if (booking.doctorUid !== uid || booking.doctorLic !== doctorLic || !doctorSnap.exists || doctorSnap.data()?.uid !== uid || doctorSnap.data()?.verified !== true) {
      throw new HttpsError("permission-denied", "هوية الطبيب أو ارتباطه بالحجز غير موثّق.");
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
