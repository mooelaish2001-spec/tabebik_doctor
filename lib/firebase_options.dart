import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;

/// إعدادات Firebase لتطبيق طبيبك - الطبيب.
/// إعداد Android مطابق لـ google-services.json داخل android/app.
class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      default:
        throw UnsupportedError(
          'Firebase options are configured for Android only in this project.',
        );
    }
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyA_9bYseIXkNAxuM3TQP9RXGUqCh37XPrk',
    appId: '1:50266299347:android:ea23bb636d984ea4b32d26',
    messagingSenderId: '50266299347',
    projectId: 'tabibek-2f25e',
    storageBucket: 'tabibek-2f25e.firebasestorage.app',
  );
}
