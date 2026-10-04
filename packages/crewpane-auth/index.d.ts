// @crewpane/auth — TS tipleri (ADP-383/G3 lisans + ADP-382/G2 PKCE giriş akışı)

export interface LicenseProduct {
  product: string; // 'agentshot.pro' | 'agentvoice.pro' | 'crewpane.seat' | …
  plan: string;    // 'free' | 'trial' | 'monthly' | 'yearly' | 'ltd' (ADP-416: trial eklendi)
  status: 'active' | 'canceled' | 'past_due' | 'revoked';
  period_end: string | null; // ISO timestamptz; null = süresiz (LTD); trial'da ZORUNLU
  /** LIC-REFUND-01 — iade damgası (`entitlements.revoked_at`). Doluysa 'canceled'
   *  satır dönem sonuna kadar AÇIK SAYILMAZ: parası geri verilmiştir. Opsiyonel:
   *  damgadan önce imzalanmış jetonlarda alan HİÇ yoktur. */
  revoked_at?: string | null;
  /** PAY-1 — gecikme damgası (`entitlements.past_due_since`): satırın İLK kez
   *  `past_due`'ya geçtiği an. Doluysa 'past_due' satır yalnız
   *  PAST_DUE_GRACE_SECONDS boyunca AÇIK sayılır. Opsiyonel: damgadan önce
   *  imzalanmış jetonlarda alan HİÇ yoktur (davranış eskisi gibi: süresiz açık). */
  past_due_since?: string | null;
}

export interface LicensePayload {
  sub: string;
  iss?: string;
  iat: number;
  exp: number;
  products: LicenseProduct[];
}

export interface VerifyOk {
  valid: true;
  status: 'fresh' | 'grace';
  payload: LicensePayload;
  kid: string;
  graceRemainingSeconds: number;
  effectiveNowSeconds: number;
}

export interface VerifyFail {
  valid: false;
  reason:
    | 'no_public_keys' | 'malformed' | 'bad_alg' | 'unknown_kid'
    | 'bad_signature' | 'missing_claims' | 'not_yet_valid'
    | 'expired_beyond_grace';
  effectiveNowSeconds?: number;
}

export type VerifyResult = VerifyOk | VerifyFail;

export interface VerifyOptions {
  publicKeys: Record<string, string>;
  nowSeconds?: number;
  lastServerTime?: number | null;
}

export declare const GRACE_SECONDS: number;
/** PAY-1 — `past_due` süre sınırı (saniye); sunucu `PAST_DUE_GRACE_DAYS` aynası. */
export declare const PAST_DUE_GRACE_SECONDS: number;
export declare const LICENSE_PUBLIC_KEYS: Record<string, string>;

export declare function effectiveNow(
  nowSeconds: number,
  lastServerTime: number | null | undefined,
): number;

export declare function noteServerTime(
  state: { lastServerTime?: number | null },
  serverTimeSeconds: number,
): { lastServerTime: number };

export declare function verifyLicenseToken(
  token: string,
  opts: VerifyOptions,
): VerifyResult;

export declare function isProductEntitled(
  verifyResult: VerifyResult,
  product: string,
): boolean;

// ADP-416 — jetondaki ürün girdisi + kalan süre (UI "deneme: N gün kaldı")
export interface ProductEntryInfo {
  product: string;
  plan: string;
  status: string;
  period_end: string | null;
  /** PAY-3 — gecikme damgası (`entitlements.past_due_since`); yoksa null. */
  past_due_since: string | null;
  remainingSeconds: number | null; // period_end'siz planlarda null
}

export declare function getProductEntry(
  verifyResult: VerifyResult,
  product: string,
): ProductEntryInfo | null;

export declare function verifyWithEmbeddedKeys(
  token: string,
  opts?: { nowSeconds?: number; lastServerTime?: number | null },
): VerifyResult;

// ── ADP-382/G2 — PKCE masaüstü giriş akışı ──────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface AuthUser {
  id: string;
  email?: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number; // epoch saniye
  user: AuthUser | null;
}

export interface PendingSignIn {
  state: string;
  verifier: string;
  createdAt: number;
}

export interface TokenStoreDoc {
  pending?: PendingSignIn | null;
  session?: AuthSession | null;
}

export interface TokenStore {
  load(): Promise<TokenStoreDoc | null>;
  save(doc: TokenStoreDoc): Promise<void>;
  clear(): Promise<void>;
}

export interface DesktopAuthConfig {
  supabaseUrl: string;
  apiKey: string;
  /** custom scheme (agentshot://auth/callback) ya da http loopback; query içeremez */
  redirectUri: string;
  tokenStore: TokenStore;
  /** sistem tarayıcısını açar (Electron: shell.openExternal). signIn için zorunlu. */
  openExternal?: (url: string) => unknown | Promise<unknown>;
  /** hosted login sayfası (accounts.crewpane.dev). Verilirse signIn() bunu açar. */
  loginUrl?: string;
  /** hosted sayfadaki 'app' etiketi (ör. 'AgentShot') */
  appId?: string;
  fetch?: typeof globalThis.fetch;
  nowSeconds?: () => number;
}

export type CallbackFailReason =
  | 'malformed' | 'wrong_redirect' | 'provider_error' | 'missing_state'
  | 'no_pending' | 'pending_expired' | 'state_mismatch' | 'missing_code'
  | 'network_error' | 'exchange_failed';

export type CallbackResult =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: CallbackFailReason; status?: number; detail?: string };

export type EmailSignInResult =
  | { ok: true; state: string }
  | { ok: false; reason: 'bad_email' | 'network_error' | 'otp_failed'; status?: number; detail?: string };

export interface DesktopAuth {
  /** Sistem tarayıcısında girişi başlat (provider → GoTrue authorize; yoksa loginUrl). */
  signIn(opts?: { provider?: 'google' | 'github' | 'apple' | string }): Promise<{ url: string; state: string }>;
  /** PKCE'li e-posta magic-link gönder; link callback'e ?code=&state= döner. */
  signInWithEmail(email: string): Promise<EmailSignInResult>;
  /** Custom-scheme callback URL'ini işle: state doğrula + code'u oturuma çevir. */
  handleCallback(url: string): Promise<CallbackResult>;
  /** Depodaki oturum; ömrü azsa tazeler. Ağ hatasında throw (offline ≠ çıkış). */
  getSession(opts?: { minValiditySeconds?: number }): Promise<AuthSession | null>;
  /** refresh_token ile tazele; sunucu reddederse oturumu siler, null döner. */
  refresh(): Promise<AuthSession | null>;
  /** Sunucuda revoke (best-effort) + yerel oturumu her durumda sil. */
  signOut(): Promise<{ ok: true; revoked: boolean }>;
}

export declare const PENDING_TTL_SECONDS: number;
export declare function createPkcePair(): PkcePair;
export declare function createState(): string;
export declare function timingSafeEqualStr(a: string, b: string): boolean;
export declare function createInMemoryTokenStore(): TokenStore;
export declare function createDesktopAuth(config: DesktopAuthConfig): DesktopAuth;

export interface ElectronSafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Electron safeStorage destekli depo — token düz dosyaya ASLA yazılmaz;
 * şifreleme yoksa save() throw eder (düz metin fallback YOK).
 */
export declare function createSafeStorageTokenStore(opts: {
  safeStorage: ElectronSafeStorageLike;
  filePath: string;
  /** ADP-943: load()/save() ARIZA SEBEBİNİ buraya yazar (sır ASLA loglanmaz). */
  log?: (line: string) => void;
  /** ADP-943: log'da hangi blob olduğunu söyler ('session' | 'license' | …). */
  label?: string;
  /** ADP-943: test dikişi — `node:fs` uyumlu. Verilmezse gerçek fs. */
  fs?: unknown;
  /** ADP-943: test dikişi — win32 yazım yolu macOS'ta böyle ölçülür. */
  platform?: NodeJS.Platform | string;
}): SafeStorageTokenStore;

/** `load()`in SON sonucu — "oturum yok" ile "blob çözülemedi" ayrımı (ADP-943). */
export interface TokenLoadOutcome {
  state: 'never_read' | 'absent' | 'ok' | 'undecryptable' | 'corrupt' | 'unreadable';
  file?: string;
  bytes?: number;
  code?: string;
}

export interface SafeStorageTokenStore extends TokenStore {
  lastLoadOutcome(): TokenLoadOutcome;
}

// ── ADP-387 / G6 — "Pro'ya geç" + billing portal + jeton tazeleme çengeli ──

export interface BillingClientConfig {
  /** crewpane-id Supabase URL'i (ör. https://<ref>.supabase.co) */
  supabaseUrl: string;
  /** anon/publishable key (public; secret DEĞİL) */
  apiKey: string;
  /** oturumun access token'ını verir (tipik: auth.getSession()?.access_token) */
  getAccessToken: () => Promise<string | null | undefined>;
  /** sistem tarayıcısını açar (Electron: shell.openExternal). openUpgrade için zorunlu. */
  openExternal?: (url: string) => unknown | Promise<unknown>;
  /** default ürün (ör. 'agentshot.pro') */
  product?: string;
  /** app custom scheme'i (ör. 'agentshot') — success sayfası dönüş linki + dönüş tanıma */
  appScheme?: string;
  fetch?: typeof globalThis.fetch;
}

export type BillingFailReason =
  | 'not_signed_in' | 'network_error' | 'no_billing_customer' | 'billing_failed';

export type BillingUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: BillingFailReason; status?: number; detail?: string };

export type LicenseTokenResult =
  | { ok: true; token: string; serverTime?: number }
  | { ok: false; reason: 'not_signed_in' | 'network_error' | 'license_fetch_failed' | 'no_attempt' | 'not_billing_url'; status?: number; detail?: string };

export interface BillingClient {
  /** Checkout session yarat + Stripe Checkout'u SİSTEM TARAYICISINDA aç. */
  openUpgrade(opts?: { plan?: 'monthly' | 'yearly' | 'ltd'; product?: string }): Promise<BillingUrlResult>;
  /** "Aboneliği yönet": Stripe Billing Portal'ı sistem tarayıcısında aç. */
  openBillingPortal(): Promise<BillingUrlResult>;
  /** URL success sayfasının app'e dönüş deep-link'i mi? (<scheme>://billing/…) */
  isBillingReturnUrl(url: string): boolean;
  /** Ödeme dönüşü çengeli: taze lisans jetonu çek (webhook gecikmesine karşı retry'lı). */
  handleBillingReturn(url: string, opts?: { attempts?: number; delayMs?: number }): Promise<LicenseTokenResult>;
}

export declare function createBillingClient(config: BillingClientConfig): BillingClient;
export declare function fetchLicenseToken(opts: {
  supabaseUrl: string;
  apiKey: string;
  getAccessToken: () => Promise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
}): Promise<LicenseTokenResult>;

// ADP-416 — kartsız süreli deneme talebi (POST /trial-claim; tekrar çağrısı güvenli)
export type ClaimTrialResult =
  | { ok: true; granted: boolean; reason?: string; periodEnd: string | null }
  | { ok: false; reason: 'not_signed_in' | 'network_error' | 'trial_claim_failed'; status?: number; detail?: string };

export declare function claimTrial(opts: {
  supabaseUrl: string;
  apiKey: string;
  product: string;
  getAccessToken: () => Promise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
}): Promise<ClaimTrialResult>;
