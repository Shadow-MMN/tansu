/**
 * IPFS upload client for the dApp.
 *
 * The browser never uses FILEBASE_TOKEN or PINATA_JWT directly.
 * Those credentials stay on the delegation worker, and this module
 * sends the CAR payload plus a signed authorization message to that worker.
 */

import { connectedPublicKey } from "./store";
import { signMessageWithActiveWallet } from "../service/TxService";

const DUAL_PIN_TIMEOUT_MS = 120_000;
const WORKER_RETRY_DELAY_MS = 1_000;

interface DualUploadApiResponse {
  cid?: string;
  success?: boolean;
  error?: string;
}

export interface DualUploadResult {
  cid: string;
  success: boolean;
  error?: string;
}

interface UploadWithDelegationParams {
  cid: string;
  carBlob: Blob;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return arrayBufferToBase64(await blob.arrayBuffer());
}

export function buildUploadAuthorizationMessage(cid: string): string {
  return `CID: ${cid}`;
}

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as DualUploadApiResponse;
      return data.error ?? "IPFS upload failed";
    }

    const text = await response.text();
    return text || "IPFS upload failed";
  } catch {
    return "IPFS upload failed";
  }
}

function normalizeResult(
  expectedCid: string,
  result: DualUploadApiResponse,
): DualUploadResult {
  const cid = result.cid;

  if (!cid) {
    throw new Error("Dual upload response missing CID");
  }

  if (cid !== expectedCid) {
    throw new Error(
      `Critical CID mismatch: expected ${expectedCid}, got ${cid}`,
    );
  }

  if (!result.success) {
    throw new Error(result.error ?? "IPFS upload failed");
  }

  const normalized: DualUploadResult = {
    cid,
    success: true,
    error: result.error,
  };

  if (normalized.error) {
    console.warn("[IPFS] Upload partially succeeded:", normalized.error);
  }

  return normalized;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadOnce(
  cid: string,
  carBlob: Blob,
  signerAddress: string,
): Promise<DualUploadResult> {
  const message = buildUploadAuthorizationMessage(cid);
  const { signedMessage, signerAddress: returnedSignerAddress } =
    await signMessageWithActiveWallet(message);

  const response = await fetch(import.meta.env.PUBLIC_DELEGATION_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cid,
      message,
      signature: signedMessage,
      signerAddress: returnedSignerAddress ?? signerAddress,
      car: await blobToBase64(carBlob),
    }),
    signal: AbortSignal.timeout(DUAL_PIN_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);
    throw new Error(`${errorMessage} (${response.status})`);
  }

  const result = (await response.json()) as DualUploadApiResponse;
  return normalizeResult(cid, result);
}

export async function uploadViaWorker({
  cid,
  carBlob,
}: UploadWithDelegationParams): Promise<DualUploadResult> {
  if (!cid) {
    throw new Error("Missing expected CID for dual upload");
  }

  if (!(carBlob instanceof Blob) || carBlob.size === 0) {
    throw new Error("Invalid CAR blob for dual upload");
  }

  const signerAddress = connectedPublicKey.get();
  if (!signerAddress) {
    throw new Error("Please connect your wallet first");
  }

  try {
    return await uploadOnce(cid, carBlob, signerAddress);
  } catch (firstError) {
    await wait(WORKER_RETRY_DELAY_MS);

    try {
      return await uploadOnce(cid, carBlob, signerAddress);
    } catch {
      throw firstError;
    }
  }
}

/**
 * Compatibility wrapper for the existing upload flow.
 * Existing callers expect only the CID after a successful dual pin.
 */
export async function uploadWithDelegation(
  params: UploadWithDelegationParams,
): Promise<string> {
  const result = await uploadViaWorker(params);
  return result.cid;
}
