/**
 * Dual IPFS upload client for the dApp.
 *
 * The browser never uses FILEBASE_TOKEN or PINATA_JWT directly.
 * Those credentials stay on the delegation worker, and this module
 * sends the CAR payload plus a signed authorization message to that worker.
 */

import { connectedPublicKey } from "./store";
import { signMessageWithActiveWallet } from "../service/TxService";

const DUAL_PIN_TIMEOUT_MS = 60_000;
const AUTHORIZATION_PREFIX = "Tansu IPFS upload authorization";

interface DualUploadApiResponse {
  cid?: string;
  success?: boolean;
  filebase?: boolean;
  pinata?: boolean;
  error?: string;
  message?: string;
}

export interface DualUploadResult {
  cid: string;
  success: boolean;
  filebase: boolean;
  pinata: boolean;
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
  return `${AUTHORIZATION_PREFIX}\nCID: ${cid}`;
}

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as DualUploadApiResponse;
      return data.error ?? data.message ?? "Dual upload failed";
    }

    const text = await response.text();
    return text || "Dual upload failed";
  } catch {
    return "Dual upload failed";
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
    throw new Error(
      result.error ??
        result.message ??
        "Both IPFS providers failed to pin the content",
    );
  }

  const normalized: DualUploadResult = {
    cid,
    success: true,
    filebase: Boolean(result.filebase),
    pinata: Boolean(result.pinata),
  };

  // Partial success is acceptable because the content is pinned on at least one provider.
  if (!normalized.filebase) {
    console.warn("[IPFS] Filebase pin failed for CID:", cid);
  }
  if (!normalized.pinata) {
    console.warn("[IPFS] Pinata pin failed for CID:", cid);
  }

  return normalized;
}

export async function dualUpload({
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

  const message = buildUploadAuthorizationMessage(cid);
  const { signedMessage, signerAddress: returnedSignerAddress } =
    await signMessageWithActiveWallet(message);

  // The worker performs the actual Filebase and Pinata uploads with server-side tokens.
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

/**
 * Compatibility wrapper for the existing upload flow.
 * Existing callers expect only the CID after a successful dual pin.
 */
export async function uploadWithDelegation(
  params: UploadWithDelegationParams,
): Promise<string> {
  const result = await dualUpload(params);
  return result.cid;
}
