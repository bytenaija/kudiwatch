// Payout adapters. The interface is IDENTICAL for mocks and future real
// adapters — swapping at gate 2 means implementing this interface, nothing else.
// ALL adapters here are MOCK: they simulate success/failure, move no real money.
import { randomTokenHex } from './crypto.js';
import { maskPhone } from './http.js';
import { getConfigNum, getConfig } from './config.js';
import type { DbAdapter } from './db.js';

export type PayoutMethod = 'mpesa' | 'bank' | 'airtime' | 'usdt';

export interface PayoutDestination {
  label: string;
  [k: string]: unknown;
}

export interface PayoutQuote {
  feeCents: number;
  etaMinutes: number;
  fxRate: number; // mock USD->local estimate, informational only
}

export interface PayoutExecutionResult {
  ok: boolean;
  txRef?: string;
  error?: string;
  retryable?: boolean;
}

export interface PayoutAdapter {
  readonly method: PayoutMethod;
  readonly displayName: string;
  validateDestination(d: unknown): { ok: boolean; error?: string; normalized?: PayoutDestination };
  quote(amountCents: number): Promise<PayoutQuote>;
  execute(job: { payoutId: string; amountCents: number; destination: PayoutDestination }): Promise<PayoutExecutionResult>;
}

function isE164(s: unknown): boolean {
  return typeof s === 'string' && /^\+\d{7,15}$/.test(s);
}

abstract class BaseMockAdapter implements PayoutAdapter {
  abstract readonly method: PayoutMethod;
  abstract readonly displayName: string;
  abstract validateDestination(d: unknown): { ok: boolean; error?: string; normalized?: PayoutDestination };

  constructor(protected db: DbAdapter) {}

  async quote(amountCents: number): Promise<PayoutQuote> {
    const feeCents = await this.feeFor(amountCents);
    return { feeCents, etaMinutes: this.etaMinutes(), fxRate: 1 };
  }

  protected abstract feeFor(amountCents: number): Promise<number>;
  protected abstract etaMinutes(): number;

  async execute(job: { payoutId: string; amountCents: number; destination: PayoutDestination }): Promise<PayoutExecutionResult> {
    // Simulated network latency (short so local E2E stays fast).
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
    const failureRate = await getConfigNum(this.db, 'payout_mock_failure_rate');
    if (Math.random() < failureRate) {
      return { ok: false, error: 'mock_provider_timeout', retryable: true };
    }
    return { ok: true, txRef: `MOCK-${this.method.toUpperCase()}-${randomTokenHex(6).toUpperCase()}` };
  }
}

export class MockMpesaAdapter extends BaseMockAdapter {
  readonly method = 'mpesa' as const;
  readonly displayName = 'M-Pesa';
  validateDestination(d: unknown) {
    const o = (d ?? {}) as Record<string, unknown>;
    if (!isE164(o.msisdn)) return { ok: false, error: 'M-Pesa needs a phone number like +254712345678.' };
    return { ok: true, normalized: { label: String(o.msisdn), msisdn: String(o.msisdn) } };
  }
  protected async feeFor(amountCents: number): Promise<number> {
    const pct = await getConfigNum(this.db, 'mock_fee_mpesa_pct');
    return Math.max(1, Math.round((amountCents * pct) / 100));
  }
  protected etaMinutes(): number { return 5; }
}

export class MockAirtimeAdapter extends BaseMockAdapter {
  readonly method = 'airtime' as const;
  readonly displayName = 'Airtime';
  validateDestination(d: unknown) {
    const o = (d ?? {}) as Record<string, unknown>;
    if (!isE164(o.msisdn)) return { ok: false, error: 'Airtime needs a phone number like +2348012345678.' };
    return { ok: true, normalized: { label: String(o.msisdn), msisdn: String(o.msisdn) } };
  }
  protected async feeFor(): Promise<number> { return 0; }
  protected etaMinutes(): number { return 5; }
}

export class MockBankAdapter extends BaseMockAdapter {
  readonly method = 'bank' as const;
  readonly displayName = 'Bank transfer';
  validateDestination(d: unknown) {
    const o = (d ?? {}) as Record<string, unknown>;
    const acct = String(o.account_number ?? '');
    const bank = String(o.bank ?? '').trim();
    if (!/^[A-Za-z0-9]{6,34}$/.test(acct)) return { ok: false, error: 'Enter a valid account number.' };
    if (!bank) return { ok: false, error: 'Enter your bank name.' };
    return { ok: true, normalized: { label: `${bank} ••${acct.slice(-4)}`, bank } };
  }
  protected async feeFor(): Promise<number> {
    return await getConfigNum(this.db, 'mock_fee_bank_flat_cents');
  }
  protected etaMinutes(): number { return 1440; }
}

const USDT_ADDR = /^(0x[a-fA-F0-9]{40}|T[a-zA-Z0-9]{33}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

export class MockUsdtAdapter extends BaseMockAdapter {
  readonly method = 'usdt' as const;
  readonly displayName = 'USDT';
  validateDestination(d: unknown) {
    const o = (d ?? {}) as Record<string, unknown>;
    const address = String(o.address ?? '').trim();
    const network = String(o.network ?? '').trim().toUpperCase();
    if (!USDT_ADDR.test(address)) return { ok: false, error: 'That does not look like a USDT wallet address.' };
    if (!['ERC20', 'TRC20', 'BEP20', 'POLYGON'].includes(network)) {
      return { ok: false, error: 'Choose a network: ERC20, TRC20, BEP20 or Polygon.' };
    }
    return { ok: true, normalized: { label: `${network} ${address.slice(0, 6)}…${address.slice(-4)}`, network } };
  }
  protected async feeFor(): Promise<number> {
    return await getConfigNum(this.db, 'mock_fee_usdt_flat_cents');
  }
  protected etaMinutes(): number { return 10; }
}

export function getPayoutAdapter(db: DbAdapter, method: PayoutMethod): PayoutAdapter {
  switch (method) {
    case 'mpesa': return new MockMpesaAdapter(db);
    case 'bank': return new MockBankAdapter(db);
    case 'airtime': return new MockAirtimeAdapter(db);
    case 'usdt': return new MockUsdtAdapter(db);
  }
}

export function redactDestination(dest: PayoutDestination): PayoutDestination {
  // The label for mpesa/airtime IS the raw E164 number — mask it too, or the
  // "redaction" is defeated (QA 2026-10-09: full number visible in API).
  const rawLabel = typeof dest.label === 'string' ? dest.label : '';
  const out: PayoutDestination = {
    label: /^\+\d{7,15}$/.test(rawLabel) ? maskPhone(rawLabel) : rawLabel,
  };
  for (const [k, v] of Object.entries(dest)) {
    if (k === 'label') continue;
    out[k] = typeof v === 'string' && v.length > 4 ? `••${v.slice(-4)}` : '[redacted]';
  }
  return out;
}

// --- Funding (advertiser top-up). Mock card, instant fake settlement. ---

export interface FundingAdapter {
  readonly name: string;
  topUp(userId: string, amountCents: number): Promise<{ ok: boolean; reference?: string; error?: string }>;
}

export class MockCardAdapter implements FundingAdapter {
  readonly name = 'mock-card';
  async topUp(_userId: string, amountCents: number): Promise<{ ok: boolean; reference?: string; error?: string }> {
    if (amountCents <= 0 || amountCents > 100_000_00) {
      return { ok: false, error: 'Amount must be between $0.01 and $100,000 (demo).' };
    }
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, reference: `MOCK-CARD-${randomTokenHex(6).toUpperCase()}` };
  }
}

export async function mockFxEstimate(db: DbAdapter, currency: string): Promise<number> {
  // Mock FX table for the payout screen's local-currency ESTIMATE line.
  // Clearly labeled as demo estimates in the UI; never used in the ledger.
  const v = await getConfig(db, `mock_fx_usd_${currency.toLowerCase()}`);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
