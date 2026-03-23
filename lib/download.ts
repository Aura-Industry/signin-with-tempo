export interface TempoAccessKeyDownload {
  version: 1;
  wallet: string;
  accessKey: string;
  keyAuthorization: unknown;
  keyType: string;
  skillUrl?: string;
  network: {
    chainId: number;
    rpcUrl: string;
  };
  feeToken: string;
  limits: {
    dailySpend: string;
    expiresAt: string | null;
    totalSpend: string;
  };
  privateKey: string;
}

export function downloadJsonFile(value: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}
