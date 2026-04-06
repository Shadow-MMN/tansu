/**
 * Dual IPFS upload client for the dApp.
 *
 * The browser never uses FILEBASE_TOKEN or PINATA_JWT directly.
 * Those credentials stay on the delegation worker, and this module
 * sends the CAR payload plus expected CID to that worker.
 */

const DUAL_PIN_TIMEOUT_MS = 60_000;

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

export async function dualUpload(
  cid: string,
  carBlob: Blob,
): Promise<DualUploadResult> {
  if (!cid) {
    throw new Error("Missing expected CID for dual upload");
  }

  if (!(carBlob instanceof Blob) || carBlob.size === 0) {
    throw new Error("Invalid CAR blob for dual upload");
  }

  // The worker performs the actual Filebase and Pinata uploads with server-side tokens.
  const response = await fetch(import.meta.env.PUBLIC_DELEGATION_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.ipld.car",
      "x-expected-cid": cid,
    },
    body: carBlob,
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
  cid: string,
  carBlob: Blob,
): Promise<string> {
  const result = await dualUpload(cid, carBlob);
  return result.cid;
}
