"use client";

import { type ReactNode, useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
} from "lucide-react";
import { KeyAuthorization } from "ox/tempo";
import { formatUnits, parseUnits, type Address } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { Account, Actions } from "viem/tempo";
import { useAccount, useConnect, useDisconnect, useWalletClient } from "wagmi";
import { Hooks } from "wagmi/tempo";
import { downloadJsonFile, type TempoAccessKeyDownload } from "../lib/download";
import {
  APP_NAME,
  PATH_USD_ADDRESS,
  PATH_USD_DECIMALS,
  STORAGE_PREFIX,
  TEMPO_CHAIN,
  TEMPO_EXPLORER_URL,
  TEMPO_RPC_URL,
} from "../lib/tempo";

type StepId = "wallet" | "backup" | "agentKeys";
type WalletAction = "register" | "signin" | null;

const PASSKEY_HINT = 'If you are inside an app, try "Open in external browser".';
const STEPS: StepId[] = ["wallet", "backup", "agentKeys"];

const STEP_LABELS: Record<StepId, string> = {
  wallet: "ACCOUNT",
  backup: "BACKUP KEY",
  agentKeys: "AGENT KEYS",
};

function shorten(value: string | undefined | null) {
  if (!value) return "---";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatPathUsdBalance(value: bigint | undefined) {
  if (value === undefined) return "---";
  const numeric = Number.parseFloat(formatUnits(value, PATH_USD_DECIMALS));
  if (!Number.isFinite(numeric)) return "---";
  if (numeric >= 1000) return numeric.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (numeric >= 1) return numeric.toFixed(2);
  if (numeric > 0) return numeric.toFixed(4);
  return "0.00";
}

function formatUsdLimit(raw: string) {
  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric)) return "$0";
  if (numeric >= 1000) return `$${numeric.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (numeric >= 1) return `$${numeric.toFixed(0)}`;
  return `$${numeric.toFixed(2)}`;
}

function formatExpiryDate(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function buildAgentPrompt(walletAddress: string, bundle: TempoAccessKeyDownload | null) {
  if (!bundle) {
    return [
      "Use ~/Downloads/tempo-agent.json.",
      "Follow the JSON limits exactly.",
      `Spend only from ${walletAddress}.`,
    ].join("\n");
  }

  return [
    "Use ~/Downloads/tempo-agent.json.",
    `Spend at most ${bundle.limits.dailySpend} per day.`,
    bundle.limits.expiresAt
      ? `Stop using the key after ${formatExpiryDate(bundle.limits.expiresAt)}.`
      : "The key does not expire.",
    `Operate only on wallet ${walletAddress}.`,
  ].join("\n");
}

function buildAccessKeyBundle({
  dailySpend,
  expiresAt,
  keyAuthorization,
  privateKey,
  walletAddress,
}: {
  dailySpend: string;
  expiresAt: string | null;
  keyAuthorization: ReturnType<typeof KeyAuthorization.toRpc>;
  privateKey: `0x${string}`;
  walletAddress: Address;
}) {
  const accessAccount = Account.fromSecp256k1(privateKey, {
    access: walletAddress,
  });

  return {
    version: 1 as const,
    wallet: walletAddress,
    accessKey: accessAccount.accessKeyAddress,
    keyAuthorization,
    keyType: accessAccount.keyType,
    network: {
      chainId: TEMPO_CHAIN.id,
      rpcUrl: TEMPO_RPC_URL,
    },
    feeToken: PATH_USD_ADDRESS,
    limits: {
      dailySpend,
      expiresAt,
      totalSpend: dailySpend,
    },
    privateKey,
  } satisfies TempoAccessKeyDownload;
}

function extractPasskeyErrorText(error: unknown) {
  if (typeof error === "string") return error.trim();
  if (!error) return "";

  const parts: string[] = [];
  const visited = new Set<object>();
  let current: unknown = error;

  while (current && typeof current === "object" && !visited.has(current as object)) {
    visited.add(current as object);
    const record = current as {
      cause?: unknown;
      details?: unknown;
      message?: unknown;
      name?: unknown;
      shortMessage?: unknown;
    };

    for (const value of [record.message, record.shortMessage, record.details, record.name]) {
      if (typeof value === "string" && value.trim()) {
        parts.push(value.trim());
      }
    }

    current = record.cause;
  }

  if (!parts.length) return String(error).trim();
  return parts.join(" ");
}

function normalizePasskeyError(error: unknown) {
  const message = extractPasskeyErrorText(error);
  const normalized = message.toLowerCase();

  if (!message) return "Something went wrong.";
  if (
    normalized.includes("notsupportederror")
    || normalized.includes("publickeycredential")
    || normalized.includes("navigator.credentials")
    || normalized.includes("secure context")
    || normalized.includes("operation is not supported")
  ) {
    return `This browser does not support passkeys here. ${PASSKEY_HINT}`;
  }
  if (
    normalized.includes("timed out or was not allowed")
    || normalized.includes("notallowederror")
    || normalized.includes("failed to request credential")
  ) {
    return "Passkey request was cancelled, timed out, or blocked by the browser.";
  }
  if (
    normalized.includes("credential not found")
    || normalized.includes("publickey not found")
    || message.includes("Failed to get public key: Not Found")
  ) {
    return "Passkey not found in this demo. Register it in this browser first.";
  }
  if (normalized.includes("rejected")) {
    return "Wallet prompt was rejected.";
  }
  return message;
}

function assertPasskeySupport(connector: unknown) {
  if (typeof window !== "undefined") {
    if (!window.isSecureContext) {
      throw new Error(`This page must run in a secure context. ${PASSKEY_HINT}`);
    }

    if (typeof window.PublicKeyCredential === "undefined") {
      throw new Error(`This browser does not expose passkeys. ${PASSKEY_HINT}`);
    }

    const credentials = window.navigator?.credentials;
    if (
      !credentials
      || typeof credentials.get !== "function"
      || typeof credentials.create !== "function"
    ) {
      throw new Error(`Passkey sign-in is unavailable in this browser. ${PASSKEY_HINT}`);
    }
  }

  if (!connector) {
    throw new Error("Tempo passkey connector unavailable.");
  }
}

function hasStoredPasskeyHint() {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(
      window.localStorage.getItem(`${STORAGE_PREFIX}.webAuthn.activeCredential`)
      || window.localStorage.getItem(`${STORAGE_PREFIX}.webAuthn.lastActiveCredential`),
    );
  } catch {
    return false;
  }
}

function BarcodeStrip() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute right-0 top-0 bottom-0 w-[6px] opacity-25"
      style={{
        backgroundImage:
          "repeating-linear-gradient(to bottom, var(--color-surface,#ffffff) 0px, var(--color-surface,#ffffff) 2px, transparent 2px, transparent 3px, var(--color-surface,#ffffff) 3px, var(--color-surface,#ffffff) 4px, transparent 4px, transparent 7px)",
      }}
    />
  );
}

function Button({
  children,
  className = "",
  disabled,
  icon,
  loading = false,
  onClick,
  type = "button",
  variant = "primary",
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
  loading?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "danger";
}) {
  const baseStyles = "font-sans font-medium antialiased tracking-[0.02em] flex items-center justify-center gap-[var(--space-1)] transition-all disabled:opacity-50 disabled:cursor-not-allowed";
  const variantStyles = {
    primary: [
      "relative clip-specimen-sm",
      "bg-[var(--color-text,#0a0a0a)] text-[var(--color-surface,#ffffff)] border border-[var(--color-text,#0a0a0a)]",
      "shadow-mech hover:shadow-mech-hover active:shadow-mech-active",
      "hover:bg-[var(--color-accent,#ff5420)] hover:text-[var(--color-accent-foreground,#0a0a0a)] hover:border-[var(--color-accent,#ff5420)]",
      "hover:-translate-y-[1px] hover:-translate-x-[1px] active:translate-y-0 active:translate-x-0",
    ].join(" "),
    secondary: "bg-[var(--color-surface,#ffffff)] border border-[var(--color-border,#d4d4d8)] text-[var(--color-text-muted,#6b7280)] hover:border-[var(--color-text,#0a0a0a)] hover:text-[var(--color-text,#0a0a0a)] hover:bg-[var(--color-background-alt,#f4f4f5)]",
    danger: "bg-[var(--color-surface,#ffffff)] border-2 border-[var(--color-danger,#bf1616)] text-[var(--color-danger,#bf1616)] hover:bg-[var(--color-danger,#bf1616)] hover:text-white",
  } as const;

  return (
    <button
      className={`${baseStyles} ${variantStyles[variant]} h-[var(--control-height-md)] px-[var(--space-3)] text-[13px] leading-none ${className}`}
      disabled={disabled || loading}
      onClick={onClick}
      type={type}
    >
      {loading ? (
        <>
          {variant === "primary" ? (
            <span className="pointer-events-none absolute inset-0 animate-ticker bg-hazard-stripes opacity-40" aria-hidden="true" />
          ) : null}
          <Loader2 className="animate-spin relative z-[1]" size={14} />
        </>
      ) : icon ? (
        icon
      ) : null}
      <span className="relative z-[1]">{children}</span>
      {variant === "primary" && !loading ? <BarcodeStrip /> : null}
    </button>
  );
}

function Checkbox({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description?: ReactNode;
  label: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className="group flex cursor-pointer items-start gap-3 border border-[var(--color-border,#d4d4d8)] p-3 shadow-[2px_2px_0_rgba(0,0,0,0.04)] transition-colors hover:border-[var(--color-text,#0a0a0a)]"
    >
      <span className="relative mt-[1px] flex shrink-0 items-center justify-center">
        <input
          checked={checked}
          className="peer sr-only"
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        <span className="pointer-events-none absolute inset-[3px] bg-hazard-stripes opacity-0 transition-opacity peer-checked:opacity-25" />
        <span className="relative flex h-4 w-4 items-center justify-center border border-[var(--color-border-muted,#a1a1aa)] bg-[var(--color-surface,#ffffff)] text-transparent shadow-[1px_1px_0_rgba(0,0,0,0.1)] transition-all peer-checked:border-[var(--color-accent,#ff5420)] peer-checked:bg-[var(--color-accent,#ff5420)] peer-checked:text-[var(--color-accent-foreground,#0a0a0a)]">
          <Check size={11} strokeWidth={3} />
        </span>
      </span>
      <span className="grid gap-1">
        <span className="font-sans text-[12px] leading-relaxed text-[var(--color-text,#0a0a0a)]">
          {label}
        </span>
        {description ? (
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint,#9ca3af)]">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

function TextInput({
  inputMode,
  label,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  value: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="font-sans text-[8px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-faint,#9ca3af)]">
        {label}
      </span>
      <input
        className="h-[var(--control-height-md)] w-full border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f2)] px-[var(--space-3)] text-[13px] text-[var(--color-text,#0a0a0a)] outline-none transition-colors focus:border-[var(--color-text,#0a0a0a)]"
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}

function CopyInlineValue({
  displayValue,
  title,
  value,
}: {
  displayValue: string;
  title: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      className="inline-flex items-center gap-1 text-[var(--color-text,#0a0a0a)] transition-colors hover:text-[var(--color-accent,#ff5420)]"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={title}
      type="button"
    >
      <span>{displayValue}</span>
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </button>
  );
}

function MetricRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-[8px] font-bold tracking-widest uppercase text-[var(--color-text-faint)]">{label}</span>
      <span className="font-mono text-[11px] tracking-wide uppercase text-[var(--color-text)]">{value}</span>
    </div>
  );
}

function CopyableAddress({ address }: { address: string | undefined }) {
  if (!address) return <span>---</span>;
  return (
    <CopyInlineValue
      displayValue={shorten(address)}
      title="Copy address"
      value={address}
    />
  );
}

function JoinLoadingState() {
  return (
    <div className="relative z-10 flex w-full max-w-[320px] flex-col items-center p-6 text-center">
      <div className="mb-2 h-10 w-10 opacity-60">
        <img alt="Tempo" className="h-full w-full object-contain" src="/tempo-logo.svg" />
      </div>
      <div className="h-6 w-6 animate-spin border-2 border-[var(--color-border,#d4d4d8)] border-t-[var(--color-text,#0a0a0a)]" />
      <div className="label-specimen-sm mt-4 animate-pulse text-[var(--color-text-muted,#6b7280)]">
        PREPARING JOIN FLOW
      </div>
      <div className="skeleton-mech mt-3 h-[2px] w-32" />
      <div className="mt-3 text-[10px] text-[var(--color-text-muted,#6b7280)]">
        Restoring your Tempo wallet session.
      </div>
    </div>
  );
}

function StepWallet({
  address,
  balance,
  hasMounted,
  hasPasskeyHint,
  walletAction,
  walletReady,
  onAgentKeys,
  onBackup,
  onRegister,
  onSignIn,
}: {
  address: string | undefined;
  balance: string;
  hasMounted: boolean;
  hasPasskeyHint: boolean;
  walletAction: WalletAction;
  walletReady: boolean;
  onAgentKeys: () => void;
  onBackup: () => void;
  onRegister: () => void;
  onSignIn: () => void;
}) {
  if (walletReady) {
    return (
      <div className="grid gap-3">
        <div className="grid gap-2">
          <MetricRow label="CHAIN" value={TEMPO_CHAIN.name} />
          <MetricRow label="BALANCE" value={`$ ${balance}`} />
          <MetricRow label="WALLET" value={<CopyableAddress address={address} />} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button className="w-full" onClick={onBackup} variant="secondary">
            BACKUP KEY
          </Button>
          <Button className="w-full" onClick={onAgentKeys} variant="secondary">
            AGENT KEYS
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <MetricRow label="CHAIN" value={TEMPO_CHAIN.name} />
        <MetricRow label="STATUS" value={hasPasskeyHint ? "PASSKEY DETECTED" : "PASSKEY REQUIRED"} />
      </div>
      <div className="font-sans text-[12px] leading-[1.65] text-[var(--color-text-muted)]">
        Register a new Tempo passkey or sign in with one already stored on this device.
      </div>
      <Button
        className="w-full"
        disabled={!hasMounted || walletAction !== null}
        loading={walletAction === "register"}
        onClick={onRegister}
      >
        REGISTER
      </Button>
      <Button
        className="w-full"
        disabled={!hasMounted || walletAction !== null}
        loading={walletAction === "signin"}
        onClick={onSignIn}
        variant="secondary"
      >
        SIGN IN
      </Button>
    </div>
  );
}

function StepBackup({
  backupBundle,
  isCreating,
  onCreate,
}: {
  backupBundle: TempoAccessKeyDownload | null;
  isCreating: boolean;
  onCreate: () => void;
}) {
  const [hasConfirmedRisk, setHasConfirmedRisk] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  if (backupBundle) {
    const recoveryKeyJson = JSON.stringify(backupBundle, null, 2);

    return (
      <div className="grid gap-3">
        <div className="grid gap-2 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] p-3">
          <div className="font-mono text-[8px] font-bold uppercase tracking-[0.22em] text-[var(--color-text-faint,#9ca3af)]">
            Shown Only Once
          </div>
          <p className="m-0 font-sans text-[12px] leading-relaxed text-[var(--color-text,#0a0a0a)]">
            This recovery key JSON is only shown once. Copy it or download it now and store it somewhere safe.
          </p>
        </div>
        <button
          className="w-full border border-[var(--color-border,#d4d4d8)] bg-[var(--color-background,#f4f4f2)] px-3 py-3 text-left transition-colors hover:border-[var(--color-text,#0a0a0a)]"
          onClick={() => {
            void navigator.clipboard.writeText(recoveryKeyJson).then(() => {
              setCopiedJson(true);
              window.setTimeout(() => setCopiedJson(false), 1500);
            });
          }}
          type="button"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="label-specimen-sm text-[var(--color-text-faint,#9ca3af)]">RECOVERY KEY JSON</span>
            <span className="inline-flex items-center gap-1 font-mono text-[8px] tracking-[0.22em] text-[var(--color-text-muted,#6b7280)]">
              {copiedJson ? <Check className="text-[var(--color-success,#00c853)]" size={10} /> : <Copy size={10} />}
              {copiedJson ? "COPIED" : "CLICK TO COPY"}
            </span>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-all text-[9px] leading-relaxed text-[var(--color-text,#0a0a0a)]">
            {recoveryKeyJson}
          </pre>
        </button>
        <Button className="w-full" onClick={() => downloadJsonFile(backupBundle, "tempo-backup.json")} variant="secondary">
          DOWNLOAD tempo-backup.json
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-2 border border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] p-3">
        <div className="font-mono text-[8px] font-bold uppercase tracking-[0.22em] text-[var(--color-text-faint,#9ca3af)]">
          Recovery Access
        </div>
        <p className="m-0 font-sans text-[12px] leading-relaxed text-[var(--color-text,#0a0a0a)]">
          If you lose your passkey, this backup key can still be used to recover control of your assets.
        </p>
        <p className="m-0 font-sans text-[12px] leading-relaxed text-[var(--color-text-muted,#6b7280)]">
          This demo does not keep a copy of this file. Store it somewhere safe before you rely on this wallet.
        </p>
      </div>
      <Checkbox
        checked={hasConfirmedRisk}
        description="Asset recovery acknowledgement"
        label="I understand that if I lose access to this recovery key, the app cannot recover my assets."
        onChange={setHasConfirmedRisk}
      />
      <Button
        className="w-full"
        disabled={!hasConfirmedRisk}
        loading={isCreating}
        onClick={onCreate}
      >
        CREATE BACKUP KEY
      </Button>
    </div>
  );
}

function StepAgentKeys({
  agentBundle,
  dailyLimit,
  expiryDays,
  isGenerating,
  isRevoking,
  onChangeDailyLimit,
  onChangeExpiryDays,
  onCopyPrompt,
  onCreate,
  onDownload,
  onRevoke,
  promptCopied,
  promptText,
}: {
  agentBundle: TempoAccessKeyDownload | null;
  dailyLimit: string;
  expiryDays: string;
  isGenerating: boolean;
  isRevoking: boolean;
  onChangeDailyLimit: (value: string) => void;
  onChangeExpiryDays: (value: string) => void;
  onCopyPrompt: () => void;
  onCreate: () => void;
  onDownload: () => void;
  onRevoke: () => void;
  promptCopied: boolean;
  promptText: string;
}) {
  return (
    <div className="grid gap-3">
      {!agentBundle ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <TextInput
              inputMode="decimal"
              label="Daily limit"
              onChange={onChangeDailyLimit}
              placeholder="10"
              value={dailyLimit}
            />
            <TextInput
              inputMode="numeric"
              label="Expires (days)"
              onChange={onChangeExpiryDays}
              placeholder="30"
              value={expiryDays}
            />
          </div>
          <Button
            className="w-full"
            disabled={Number.parseFloat(dailyLimit) <= 0 || Number.parseInt(expiryDays, 10) <= 0}
            loading={isGenerating}
            onClick={onCreate}
          >
            AUTHORIZE
          </Button>
        </>
      ) : (
        <>
          <Button
            className="w-full"
            icon={<Copy size={12} />}
            onClick={onDownload}
          >
            DOWNLOAD tempo-agent.json
          </Button>

          <div className="grid gap-2 border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-2.5">
            <div className="font-mono text-[8px] font-bold uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
              Tell your agent
            </div>
            <div className="grid gap-2 border border-[var(--color-border)] bg-[var(--color-background)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#ff5f57]" />
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#febc2e]" />
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#28c840]" />
                </div>
                <span className="font-mono text-[8px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
                  shell
                </span>
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--color-text)]">
                <span className="select-none text-[var(--color-accent)]">$ </span>
                {promptText}
              </pre>
            </div>
            <Button
              className="w-full"
              icon={promptCopied ? <Check size={12} /> : <Copy size={12} />}
              onClick={onCopyPrompt}
              variant="secondary"
            >
              {promptCopied ? "PROMPT COPIED" : "COPY PROMPT"}
            </Button>
          </div>

          <div className="grid gap-2 border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-2.5">
            <MetricRow label="ACCESS KEY" value={shorten(agentBundle.accessKey)} />
            <MetricRow label="DAILY LIMIT" value={agentBundle.limits.dailySpend} />
            <MetricRow label="EXPIRES" value={formatExpiryDate(agentBundle.limits.expiresAt)} />
          </div>

          <Button
            className="w-full"
            icon={<KeyRound size={12} />}
            loading={isRevoking}
            onClick={onRevoke}
            variant="danger"
          >
            REVOKE ACCESS
          </Button>
        </>
      )}
    </div>
  );
}

export function SignInWithTempoDemo() {
  const [hasMounted, setHasMounted] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId>("wallet");
  const [walletAction, setWalletAction] = useState<WalletAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [backupBundle, setBackupBundle] = useState<TempoAccessKeyDownload | null>(null);
  const [isCreatingBackupKey, setIsCreatingBackupKey] = useState(false);
  const [agentDailyLimit, setAgentDailyLimit] = useState("10");
  const [agentExpiryDays, setAgentExpiryDays] = useState("30");
  const [agentBundle, setAgentBundle] = useState<TempoAccessKeyDownload | null>(null);
  const [isGeneratingAgentKey, setIsGeneratingAgentKey] = useState(false);
  const [isRevokingAgentKey, setIsRevokingAgentKey] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);

  const { address, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();

  const webAuthnConnector = connectors.find(
    (connector) => connector.type === "webAuthn" || connector.name === "EOA (WebAuthn)",
  );

  const pathUsdBalance = Hooks.token.useGetBalance({
    account: address as Address | undefined,
    token: PATH_USD_ADDRESS,
    query: {
      enabled: Boolean(address),
      refetchInterval: 12000,
    },
  });

  const balanceDisplay = formatPathUsdBalance(pathUsdBalance.data);
  const promptText = buildAgentPrompt(address || "---", agentBundle);
  const currentStepIndex = STEPS.indexOf(currentStep);
  const progressPct = ((currentStepIndex + 1) / STEPS.length) * 100;

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!isConnected) {
      setCurrentStep("wallet");
      setBackupBundle(null);
      setAgentBundle(null);
    }
  }, [isConnected]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!promptCopied) return;
    const timeout = window.setTimeout(() => setPromptCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [promptCopied]);

  async function handleWalletRegister() {
    try {
      setError(null);
      setNotice(null);
      setWalletAction("register");
      assertPasskeySupport(webAuthnConnector);

      const result = await connectAsync({
        capabilities: {
          label: APP_NAME,
          type: "sign-up",
        },
        chainId: TEMPO_CHAIN.id,
        connector: webAuthnConnector!,
      } as never);

      const nextAddress = (result as { accounts?: readonly string[] }).accounts?.[0];
      setNotice(nextAddress ? `Registered ${shorten(nextAddress)}.` : "Registered new Tempo wallet.");
    } catch (nextError) {
      setError(normalizePasskeyError(nextError));
    } finally {
      setWalletAction(null);
    }
  }

  async function handleWalletSignIn() {
    try {
      setError(null);
      setNotice(null);
      setWalletAction("signin");
      assertPasskeySupport(webAuthnConnector);

      const result = await connectAsync({
        capabilities: {
          selectAccount: true,
          type: "sign-in",
        },
        chainId: TEMPO_CHAIN.id,
        connector: webAuthnConnector!,
      } as never);

      const nextAddress = (result as { accounts?: readonly string[] }).accounts?.[0];
      setNotice(nextAddress ? `Signed in as ${shorten(nextAddress)}.` : "Signed in with passkey.");
    } catch (nextError) {
      setError(normalizePasskeyError(nextError));
    } finally {
      setWalletAction(null);
    }
  }

  async function handleCreateBackupKey() {
    if (!address || !walletClient?.account) {
      setError("Sign in with your Tempo passkey first.");
      return;
    }

    try {
      setError(null);
      setIsCreatingBackupKey(true);
      const privateKey = generatePrivateKey();
      const accessAccount = Account.fromSecp256k1(privateKey, {
        access: address as Address,
      });
      const signed = await Actions.accessKey.signAuthorization(walletClient as never, {
        account: walletClient.account as never,
        accessKey: accessAccount as never,
        chainId: TEMPO_CHAIN.id,
      });
      setBackupBundle(buildAccessKeyBundle({
        dailySpend: "unlimited",
        expiresAt: null,
        keyAuthorization: KeyAuthorization.toRpc(signed),
        privateKey,
        walletAddress: address as Address,
      }));
    } catch (nextError) {
      setError(normalizePasskeyError(nextError));
    } finally {
      setIsCreatingBackupKey(false);
    }
  }

  async function handleCreateAgentKey() {
    if (!address || !walletClient?.account) {
      setError("Sign in with your Tempo passkey first.");
      return;
    }

    try {
      setError(null);
      setIsGeneratingAgentKey(true);

      const normalizedLimit = agentDailyLimit.trim();
      const normalizedDays = Number.parseInt(agentExpiryDays, 10);
      if (!normalizedLimit || Number.parseFloat(normalizedLimit) <= 0) {
        throw new Error("Daily limit must be greater than zero.");
      }
      if (!Number.isFinite(normalizedDays) || normalizedDays <= 0) {
        throw new Error("Expiry must be at least one day.");
      }

      const privateKey = generatePrivateKey();
      const accessAccount = Account.fromSecp256k1(privateKey, {
        access: address as Address,
      });
      const expiryTimestamp = Math.floor((Date.now() + normalizedDays * 24 * 60 * 60 * 1000) / 1000);
      const signed = await Actions.accessKey.signAuthorization(walletClient as never, {
        account: walletClient.account as never,
        accessKey: accessAccount as never,
        chainId: TEMPO_CHAIN.id,
        expiry: expiryTimestamp,
        limits: [
          {
            limit: parseUnits(normalizedLimit, PATH_USD_DECIMALS),
            token: PATH_USD_ADDRESS,
          },
        ],
      });

      setAgentBundle(buildAccessKeyBundle({
        dailySpend: formatUsdLimit(normalizedLimit),
        expiresAt: new Date(expiryTimestamp * 1000).toISOString(),
        keyAuthorization: KeyAuthorization.toRpc(signed),
        privateKey,
        walletAddress: address as Address,
      }));
    } catch (nextError) {
      setError(normalizePasskeyError(nextError));
    } finally {
      setIsGeneratingAgentKey(false);
    }
  }

  async function handleRevokeAgentKey() {
    if (!agentBundle?.accessKey || !walletClient?.account) {
      setError("No generated agent key is available to revoke.");
      return;
    }

    try {
      setError(null);
      setIsRevokingAgentKey(true);
      await Actions.accessKey.revokeSync(walletClient as never, {
        account: walletClient.account as never,
        accessKey: agentBundle.accessKey as Address,
        chain: TEMPO_CHAIN,
      });
      setAgentBundle(null);
      setNotice("Agent key revoked on-chain.");
    } catch (nextError) {
      setError(normalizePasskeyError(nextError));
    } finally {
      setIsRevokingAgentKey(false);
    }
  }

  function handleCopyPrompt() {
    void navigator.clipboard.writeText(promptText).then(() => {
      setPromptCopied(true);
    }).catch(() => {
      setError("Clipboard access failed.");
    });
  }

  function handleBack() {
    if (currentStep === "backup" || currentStep === "agentKeys") {
      setCurrentStep("wallet");
    }
  }

  function handleDisconnect() {
    disconnect();
    setError(null);
    setNotice("Disconnected.");
  }

  let stepContent: ReactNode = null;
  switch (currentStep) {
    case "wallet":
      stepContent = (
        <StepWallet
          address={address}
          balance={balanceDisplay}
          hasMounted={hasMounted}
          hasPasskeyHint={hasStoredPasskeyHint()}
          onAgentKeys={() => setCurrentStep("agentKeys")}
          onBackup={() => setCurrentStep("backup")}
          onRegister={() => void handleWalletRegister()}
          onSignIn={() => void handleWalletSignIn()}
          walletAction={walletAction}
          walletReady={isConnected}
        />
      );
      break;
    case "backup":
      stepContent = (
        <StepBackup
          backupBundle={backupBundle}
          isCreating={isCreatingBackupKey}
          onCreate={() => void handleCreateBackupKey()}
        />
      );
      break;
    case "agentKeys":
      stepContent = (
        <StepAgentKeys
          agentBundle={agentBundle}
          dailyLimit={agentDailyLimit}
          expiryDays={agentExpiryDays}
          isGenerating={isGeneratingAgentKey}
          isRevoking={isRevokingAgentKey}
          onChangeDailyLimit={setAgentDailyLimit}
          onChangeExpiryDays={setAgentExpiryDays}
          onCopyPrompt={handleCopyPrompt}
          onCreate={() => void handleCreateAgentKey()}
          onDownload={() => agentBundle && downloadJsonFile(agentBundle, "tempo-agent.json")}
          onRevoke={() => void handleRevokeAgentKey()}
          promptCopied={promptCopied}
          promptText={promptText}
        />
      );
      break;
  }

  const joinCard = (
    <div className="relative z-10 w-full max-w-[380px] animate-join-card-in">
      <div className="absolute -left-8 top-1/2 hidden -translate-y-1/2 select-none text-vertical label-specimen-sm text-[var(--color-text-faint,#9ca3af)] sm:block">
        WALLET&nbsp;REGISTRATION
      </div>

      <div className="bg-[var(--color-surface,#f4f4f2)] clip-specimen border-mech shadow-mech overflow-hidden font-mono corner-marks">
        <div className="flex items-center justify-between border-b border-[var(--color-border,#d4d4d8)] bg-[var(--color-surface-alt,#fafafa)] px-5 py-3">
          <div className="flex items-center gap-2">
            {currentStepIndex > 0 ? (
              <button
                className="text-[var(--color-text-muted,#6b7280)] transition-colors hover:text-[var(--color-text,#0a0a0a)]"
                onClick={handleBack}
                title="Back"
                type="button"
              >
                <ArrowLeft size={14} />
              </button>
            ) : null}
            <span className="font-sans text-sm font-bold uppercase tracking-tight text-[var(--color-text,#0a0a0a)]">
              {STEP_LABELS[currentStep]}
            </span>
          </div>
          <div aria-hidden="true" className="h-1.5 w-16 overflow-hidden bg-[var(--color-border-muted,#e5e5e5)]">
            <div
              className="h-full bg-[var(--color-text,#0a0a0a)] transition-[width] duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        <div className="p-6">
          <div className="mb-6 flex flex-col items-center">
            <div className="mb-4 h-16 w-16">
              <img alt="Tempo" className="h-full w-full object-contain" src="/tempo-logo.svg" />
            </div>
            <div className="mb-4 text-center">
              <div className="font-mono text-[18px] font-bold uppercase tracking-[0.2em] text-[var(--color-text,#0a0a0a)]">
                SIGN IN WITH TEMPO
              </div>
              <div className="mt-1 font-sans text-[10px] tracking-[0.12em] text-[var(--color-text-muted,#6b7280)]">
                Passkey wallet demo
              </div>
            </div>
          </div>

          <div className="animate-join-step-in" key={currentStep}>
            {stepContent}
          </div>
        </div>

        {isConnected && address ? (
          <div className="border-t border-[var(--color-border,#d4d4d8)] px-5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <button
                className="font-mono text-[8px] uppercase tracking-[0.28em] text-[var(--color-text-faint,#9ca3af)] transition-colors hover:text-[var(--color-text,#0a0a0a)]"
                onClick={handleDisconnect}
                type="button"
              >
                DISCONNECT
              </button>
              <span className="text-right text-[11px] tracking-wider text-[var(--color-text,#0a0a0a)]">
                <span className="mr-2 font-sans text-[11px] font-semibold text-[var(--color-text,#0a0a0a)]">
                  {TEMPO_CHAIN.name} / ${balanceDisplay} /
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <CopyableAddress address={address} />
                  <a
                    className="inline-flex items-center text-[var(--color-text-faint,#9ca3af)] transition-colors hover:text-[var(--color-text,#0a0a0a)]"
                    href={`${TEMPO_EXPLORER_URL}/address/${address}`}
                    rel="noopener noreferrer"
                    target="_blank"
                    title="Open in Tempo explorer"
                  >
                    <ExternalLink size={10} />
                  </a>
                </span>
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  if (!hasMounted) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-[var(--color-background,#f4f4f5)] p-4">
        <JoinLoadingState />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[var(--color-background,#f4f4f5)] p-4">
      {error ? (
        <div className="fixed top-4 left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 border border-[var(--color-danger,#bf1616)] bg-white px-4 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-danger,#bf1616)] shadow-mech">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="fixed top-4 left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 border border-[var(--color-border,#d4d4d8)] bg-white px-4 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--color-text,#0a0a0a)] shadow-mech">
          {notice}
        </div>
      ) : null}

      <div className="fixed top-6 left-6 z-50 flex items-center gap-3">
        <div className="h-10 w-10">
          <img alt="Tempo" className="h-full w-full object-contain" src="/tempo-logo.svg" />
        </div>
        <div className="leading-none">
          <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--color-text,#0a0a0a)]">
            SIGN IN WITH TEMPO
          </div>
          <div className="mt-1 font-sans text-[8px] tracking-[0.08em] text-[var(--color-text-muted,#6b7280)]">
            Tempo passkey demo
          </div>
        </div>
      </div>

      <div className="fixed top-7 right-6 z-50 flex items-center gap-3 font-mono text-[10px] tracking-widest">
        <button
          className="text-[var(--color-text-muted,#6b7280)] transition-colors hover:text-[var(--color-text,#0a0a0a)] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!isConnected}
          onClick={() => setCurrentStep("agentKeys")}
          type="button"
        >
          AGENT KEYS
        </button>
        <button
          className="text-[var(--color-text-muted,#6b7280)] transition-colors hover:text-[var(--color-text,#0a0a0a)] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!isConnected}
          onClick={() => setCurrentStep("backup")}
          type="button"
        >
          BACKUP KEY
        </button>
      </div>

      <div className="fixed bottom-6 right-6 z-50 font-mono text-[10px] tracking-widest text-[var(--color-text-muted,#6b7280)]">
        <a
          className="transition-colors hover:text-[var(--color-text,#0a0a0a)]"
          href="https://x.com/nicoletteduclar"
          rel="noopener noreferrer"
          target="_blank"
        >
          by @nicoletteduclar
        </a>
      </div>

      {joinCard}
    </div>
  );
}
