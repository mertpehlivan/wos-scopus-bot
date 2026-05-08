package com.academic.broker.domain;

/**
 * Lifecycle of a sync request inside the broker (operator panel staging area).
 *
 * <pre>
 *   PENDING_SCRAPE    Worker tetiklendi, scrape sürüyor
 *        │
 *        ▼ (worker tüm task'ları bitirdi)
 *   READY_FOR_REVIEW  ⏱ 24h sayaç başlar; operatör formu görür/edit eder
 *        │
 *        ├── APPROVED  → ana backend'e gönderildi (kalıcı yazıldı)
 *        ├── REJECTED  → operatör reddetti
 *        └── EXPIRED   → 24 saat doldu, otomatik
 *
 *   FAILED  Worker hiç ürün veremedi; operatör manuel doldurabilir
 *           (READY_FOR_REVIEW'a yükseltilir)
 *   DRAFT   Operatör manuel kayıt başlatıyor (autosave aşaması)
 * </pre>
 */
public enum SyncRequestStatus {
    DRAFT,
    PENDING_SCRAPE,
    READY_FOR_REVIEW,
    APPROVED,
    REJECTED,
    EXPIRED,
    FAILED
}
